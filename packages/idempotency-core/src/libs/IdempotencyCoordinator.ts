import type {
  IdempotencyAuditEvent,
  IdempotencyAuditSink,
  IdempotencyCompletedRecord,
  IdempotencyExecutionRequest,
  IdempotencyExecutionResult,
  IdempotencyFailedRecord,
  IdempotencyHandler,
  IdempotencyStore,
} from "./types";
import {
  IdempotencyConflictProblem,
  IdempotencyExecutionIndeterminateProblem,
} from "./problems/IdempotencyProblems";

export type IdempotencyCoordinatorOptions<TResult = unknown> = {
  readonly store: IdempotencyStore<TResult>;
  readonly auditSink?: IdempotencyAuditSink;
};

type IdempotencyExecutionFailurePhase = "reserved-audit" | "handler" | "commit";

export class IdempotencyCoordinator<TResult = unknown> {
  private readonly store: IdempotencyStore<TResult>;
  private readonly auditSink: IdempotencyAuditSink | undefined;

  constructor(options: IdempotencyCoordinatorOptions<TResult>) {
    this.store = options.store;
    this.auditSink = options.auditSink;
  }

  async execute(
    request: IdempotencyExecutionRequest,
    handler: IdempotencyHandler<TResult>,
  ): Promise<IdempotencyExecutionResult<TResult>> {
    const reservation = await this.reserve(request);

    if (reservation.outcome === "replay") {
      await this.record("idempotency.replayed", request, reservation.record.metadata);
      return {
        outcome: "replayed",
        response: reservation.response,
        record: reservation.record,
      };
    }

    if (reservation.outcome === "in-flight") {
      await this.record("idempotency.in_flight", request, reservation.record.metadata);
      return {
        outcome: "in-flight",
        record: reservation.record,
      };
    }

    if (reservation.outcome === "failed") {
      await this.record("idempotency.failed", request, reservation.record.metadata);
      if (isIndeterminateFailure(reservation.record)) {
        throw new IdempotencyExecutionIndeterminateProblem({
          key: request.key.key,
          namespace: request.key.namespace,
          failedAt: reservation.record.failedAt,
        });
      }
      return {
        outcome: "failed",
        record: reservation.record,
      };
    }

    const failureMetadata = reservation.record.metadata;

    let response: TResult;
    let failurePhase: IdempotencyExecutionFailurePhase = "reserved-audit";
    try {
      await this.record("idempotency.reserved", request, reservation.record.metadata);
      failurePhase = "handler";
      response = await handler();
    } catch (error) {
      await this.recordExecutionFailure(
        request,
        reservation.reservation.reservationId,
        failurePhase,
        error,
        failureMetadata,
      );
      throw error;
    }

    let record: IdempotencyCompletedRecord<TResult>;
    try {
      record = await this.store.commit({
        key: request.key,
        reservationId: reservation.reservation.reservationId,
        response,
        ttlMs: request.ttlMs,
        metadata: request.metadata,
      });
    } catch (error) {
      await this.recordExecutionFailure(
        request,
        reservation.reservation.reservationId,
        "commit",
        error,
        failureMetadata,
      );
      throw error;
    }

    return {
      outcome: "executed",
      response,
      record,
    };
  }

  private async reserve(request: IdempotencyExecutionRequest) {
    try {
      return await this.store.reserve(request.key, {
        metadata: request.metadata,
        ttlMs: request.ttlMs,
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictProblem) {
        await this.record("idempotency.conflict", request, request.metadata ?? {});
      }
      throw error;
    }
  }

  private async recordExecutionFailure(
    request: IdempotencyExecutionRequest,
    reservationId: string,
    phase: IdempotencyExecutionFailurePhase,
    error: unknown,
    failureMetadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.store.fail({
        key: request.key,
        reservationId,
        problem: toProblemSummary(error),
        retryable:
          phase === "handler"
            ? (request.isRetryable ?? isRetryableHandlerFailure)(error)
            : phase === "reserved-audit",
        ttlMs: request.ttlMs,
        metadata: createFailureMetadata(failureMetadata, phase),
      });
    } catch (failureRecordError) {
      attachFailureRecordError(error, failureRecordError);
    }
  }

  private async record(
    type: IdempotencyAuditEvent["type"],
    request: IdempotencyExecutionRequest,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditSink?.recordIdempotency({
      type,
      key: request.key.key,
      storageKey: request.key.storageKey,
      namespace: request.key.namespace,
      tenantId: request.key.tenantId,
      source: request.key.source,
      fingerprint: request.key.fingerprint,
      metadata: isolateAuditMetadata(metadata),
    });
  }
}

function isIndeterminateFailure(record: IdempotencyFailedRecord): boolean {
  if (record.retryable) {
    return false;
  }

  try {
    return record.metadata["idempotencyFailurePhase"] === "commit";
  } catch {
    return false;
  }
}

function attachFailureRecordError(error: unknown, failureRecordError: unknown): void {
  if (typeof error !== "object" || error === null) {
    return;
  }

  try {
    Object.defineProperty(error, "idempotencyFailureRecordError", {
      configurable: true,
      enumerable: false,
      value: failureRecordError,
    });
  } catch {
    return;
  }
}

function isolateAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(metadata);
  } catch {
    return {};
  }
}

export function createIdempotencyCoordinator<TResult>(
  options: IdempotencyCoordinatorOptions<TResult>,
): IdempotencyCoordinator<TResult> {
  return new IdempotencyCoordinator(options);
}

export function createIdempotentHandler<TContext, TResult>(
  coordinator: IdempotencyCoordinator<TResult>,
  resolveRequest: (context: TContext) => IdempotencyExecutionRequest,
  handler: (context: TContext) => Promise<TResult> | TResult,
): (context: TContext) => Promise<IdempotencyExecutionResult<TResult>> {
  return async (context) => coordinator.execute(resolveRequest(context), () => handler(context));
}

function toProblemSummary(error: unknown): {
  readonly code: string;
  readonly status?: number;
  readonly detail?: string;
} {
  if (typeof error !== "object" || error === null) {
    return {
      code: "unknown",
      detail: String(error),
    };
  }

  const code = readDiagnosticProperty(error, "code");
  const status = readDiagnosticProperty(error, "status");
  const detail = readDiagnosticProperty(error, "detail");
  const message = readDiagnosticProperty(error, "message");

  return {
    code: typeof code === "string" ? code : "unknown",
    ...(typeof status === "number" ? { status } : {}),
    detail: typeof detail === "string" ? detail : typeof message === "string" ? message : undefined,
  };
}

function isRetryableHandlerFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return true;
  }

  const retryable = readDiagnosticProperty(error, "retryable");
  if (typeof retryable === "boolean") {
    return retryable;
  }

  const status = readDiagnosticProperty(error, "status");
  return !(
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

function readDiagnosticProperty(
  error: object,
  property: "code" | "status" | "detail" | "message" | "retryable",
): unknown {
  try {
    return (error as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function createFailureMetadata(
  failureMetadata: Record<string, unknown>,
  phase: IdempotencyExecutionFailurePhase,
): Record<string, unknown> {
  try {
    return {
      ...failureMetadata,
      idempotencyFailurePhase: phase,
    };
  } catch {
    return { idempotencyFailurePhase: phase };
  }
}
