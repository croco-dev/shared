import { Problem } from "@croco/problems-core";
import { withSpan } from "@croco/telemetry-api";
import {
  SagaDefinitionProblem,
  SagaExecutionFailedProblem,
  SagaExecutionInFlightProblem,
  SagaExecutionNotFoundProblem,
  SagaFinalizationProblem,
  SagaReplayProblem,
} from "../problems/WorkflowProblems";
import { InMemorySagaStore } from "./InMemorySagaStore";
import { assertValidListSagaExecutionsOptions } from "./assertValidListSagaExecutionsOptions";
import type {
  ListSagaExecutionsOptions,
  ReplaySagaParams,
  SagaDefinition,
  SagaExecution,
  SagaExecutionStatus,
  SagaFailure,
  SagaOutboxRecord,
  SagaRunResult,
  SagaStepContext,
  SagaStepDefinition,
  SagaStepExecutionRecord,
  SagaStepIdempotencyContext,
  SagaStepResult,
  SagaStore,
} from "./types";

type TelemetryAttributeValue = string | number | boolean;

type SagaTelemetrySpan = {
  setAttribute(name: string, value: TelemetryAttributeValue): void;
  addEvent(name: string, attributes?: Record<string, TelemetryAttributeValue>): void;
};

type ExecuteOptions = {
  readonly replayOf?: string;
  readonly metadata?: Record<string, unknown>;
};

type StepExecutionResult = {
  readonly result: SagaStepResult;
};

type SagaOutboxPhase = SagaOutboxRecord["phase"];

function toSagaFailure(error: unknown): SagaFailure {
  const candidate = error as { readonly code?: unknown; readonly retryable?: unknown };
  return {
    message: error instanceof Error ? error.message : String(error),
    retryable: isRetryableError(error),
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  };
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown error";
  }
}

function reportSagaFailureRecordError(
  span: SagaTelemetrySpan,
  sagaName: string,
  executionId: string,
  failure: SagaFailure,
  problem: SagaExecutionFailedProblem,
  failureRecordError: unknown,
): void {
  let attachmentFailed = false;
  try {
    Object.defineProperty(problem, "sagaFailureRecordError", {
      configurable: true,
      enumerable: false,
      value: failureRecordError,
    });
  } catch {
    attachmentFailed = true;
  }

  try {
    span.addEvent("saga.execution.failure_record.failed", {
      "saga.name": sagaName,
      "saga.execution.id": executionId,
      "saga.error.message": failure.message,
      "saga.failure_record.error.message": describeError(failureRecordError),
      ...(attachmentFailed ? { "saga.failure_record.attachment_failed": true } : {}),
    });
  } catch {
    return;
  }
}

function isRetryableError(error: unknown): boolean {
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    "retryable" in error
  ) {
    return Boolean(error.retryable);
  }

  return error instanceof Problem && error.extensions?.retryable === true;
}

function getMaxAttempts(step: SagaStepDefinition): number {
  return step.retry?.maxAttempts ?? 1;
}

function isReplayableSagaStatus(status: SagaExecution["status"]): boolean {
  return status === "failed" || status === "compensated";
}

function isOutboxDispatchableStatus(status: SagaExecution["status"]): boolean {
  return status === "completed" || status === "failed" || status === "compensated";
}

function createSagaInvocationId(sagaName: string): string {
  return `${sagaName}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function getStepRecordAttributes(
  definition: SagaDefinition,
  executionId: string,
  step: SagaStepDefinition,
): Record<string, TelemetryAttributeValue> {
  return {
    "saga.name": definition.name,
    "saga.execution.id": executionId,
    "saga.step.id": step.id,
  };
}

export class SagaRunner {
  constructor(private readonly store: SagaStore = new InMemorySagaStore()) {}

  async execute(definition: SagaDefinition, payload: unknown): Promise<SagaRunResult> {
    this.assertValidDefinition(definition);

    return withSpan((span) => this.executeWithTelemetry(definition, payload, span), {
      name: `saga:${definition.name}`,
      attributes: {
        "saga.name": definition.name,
      },
    });
  }

  async replay(
    definition: SagaDefinition,
    executionId: string,
    params: ReplaySagaParams = {},
  ): Promise<SagaRunResult> {
    this.assertValidDefinition(definition);

    const execution = await this.getExecution(executionId);
    if (execution.sagaName !== definition.name) {
      throw new SagaReplayProblem(
        executionId,
        `execution belongs to saga '${execution.sagaName}', not '${definition.name}'`,
      );
    }
    if (!isReplayableSagaStatus(execution.status)) {
      throw new SagaReplayProblem(
        executionId,
        `execution in '${execution.status}' status is not replayable`,
      );
    }

    const replayedAt = new Date().toISOString();
    const metadata = {
      ...execution.metadata,
      ...params.metadata,
      replayOf: execution.id,
      replayedAt,
      ...(params.reason !== undefined ? { replayReason: params.reason } : {}),
    };
    const payload = params.payload !== undefined ? params.payload : execution.payload;

    return withSpan(
      (span) =>
        this.executeWithTelemetry(definition, payload, span, {
          replayOf: execution.id,
          metadata,
        }),
      {
        name: `saga:${definition.name}:replay`,
        attributes: {
          "saga.name": definition.name,
          "saga.replay_of": execution.id,
        },
      },
    );
  }

  async getExecution(executionId: string): Promise<SagaExecution> {
    const execution = await this.store.findById(executionId);
    if (!execution) {
      throw new SagaExecutionNotFoundProblem(executionId);
    }

    return execution;
  }

  async listExecutions(options?: ListSagaExecutionsOptions): Promise<SagaExecution[]> {
    assertValidListSagaExecutionsOptions(options);
    return this.store.list(options);
  }

  private async executeWithTelemetry(
    definition: SagaDefinition,
    payload: unknown,
    span: SagaTelemetrySpan,
    options: ExecuteOptions = {},
  ): Promise<SagaRunResult> {
    const idempotencyKey =
      options.replayOf === undefined
        ? this.resolveSagaIdempotencyKey(definition, payload)
        : undefined;
    const invocationId =
      idempotencyKey !== undefined ? createSagaInvocationId(definition.name) : undefined;

    if (idempotencyKey !== undefined) {
      const existing = await this.store.findByIdempotencyKey(definition.name, idempotencyKey);
      if (existing) {
        return this.reuseExistingExecution(definition, existing, span);
      }
    }

    const created = await this.store.create({
      sagaName: definition.name,
      payload,
      idempotencyKey,
      replayOf: options.replayOf,
      metadata: {
        ...definition.metadata,
        ...options.metadata,
        ...(invocationId !== undefined ? { sagaInvocationId: invocationId } : {}),
      },
    });
    if (idempotencyKey !== undefined && created.metadata?.sagaInvocationId !== invocationId) {
      return this.reuseExistingExecution(definition, created, span);
    }

    span.setAttribute("saga.execution.id", created.id);
    span.setAttribute("saga.idempotent", idempotencyKey !== undefined);
    span.setAttribute("saga.reused", false);
    span.addEvent("saga.execution.created", {
      "saga.name": definition.name,
      "saga.execution.id": created.id,
      "saga.execution.status": created.status,
    });

    const running = await this.store.update(created.id, {
      status: "running",
      startedAt: new Date(),
    });

    return this.runSteps(definition, running, span);
  }

  private async reuseExistingExecution(
    definition: SagaDefinition,
    execution: SagaExecution,
    span: SagaTelemetrySpan,
  ): Promise<SagaRunResult> {
    const recovered =
      execution.status === "completing"
        ? await this.finalizeExecution(definition, execution, span)
        : isOutboxDispatchableStatus(execution.status)
          ? await this.dispatchOutbox(definition, execution.id)
          : execution;

    if (recovered.status === "failed" || recovered.status === "compensated") {
      this.throwStoredExecutionFailure(definition.name, recovered);
    }

    if (recovered.status === "pending" || recovered.status === "running") {
      throw new SagaExecutionInFlightProblem(definition.name, recovered.id, recovered.status);
    }

    span.setAttribute("saga.reused", true);
    span.addEvent("saga.execution.reused", {
      "saga.name": definition.name,
      "saga.execution.id": recovered.id,
      "saga.execution.status": recovered.status,
    });

    return {
      executionId: recovered.id,
      definition,
      execution: recovered,
      steps: this.toStepResults(recovered),
      result: recovered.result,
      reused: true,
    };
  }

  private async runSteps(
    definition: SagaDefinition,
    execution: SagaExecution,
    span: SagaTelemetrySpan,
  ): Promise<SagaRunResult> {
    let current = execution;
    const previousResults: SagaStepResult[] = [];
    const outboxIdentityRoot = await this.resolveOutboxIdentityRoot(execution);

    try {
      for (const step of definition.steps) {
        const executed = await this.runStep(
          definition,
          current,
          step,
          previousResults,
          outboxIdentityRoot,
        );
        current = await this.getExecution(current.id);
        previousResults.push(executed.result);
      }
    } catch (error) {
      return this.failExecution(definition, current.id, error, span);
    }

    const dispatched = await this.finalizeExecution(definition, current, span);

    return {
      executionId: dispatched.id,
      definition,
      execution: dispatched,
      steps: previousResults,
      result: {
        sagaName: definition.name,
        steps: previousResults,
      },
      reused: false,
    };
  }

  /**
   * Persists the final completed status once every step has succeeded. A store
   * failure here is not a business failure: completed work must not be
   * compensated, and the durable `completing` status plus step records remain
   * the source of truth for reconciliation.
   */
  private async finalizeExecution(
    definition: SagaDefinition,
    execution: SagaExecution,
    span: SagaTelemetrySpan,
  ): Promise<SagaExecution> {
    const result = {
      sagaName: definition.name,
      steps: this.toStepResults(execution),
    };
    let durableStatus: SagaExecutionStatus = execution.status;

    try {
      if (execution.status === "running") {
        await this.store.update(execution.id, { status: "completing" });
        durableStatus = "completing";
      }
      const completed = await this.store.update(execution.id, {
        status: "completed",
        result,
        completedAt: new Date(),
      });
      span.addEvent("saga.execution.completed", {
        "saga.name": definition.name,
        "saga.execution.id": completed.id,
        "saga.execution.status": completed.status,
      });
    } catch (error) {
      const failure = toSagaFailure(error);
      span.addEvent("saga.execution.finalization_failed", {
        "saga.name": definition.name,
        "saga.execution.id": execution.id,
        "saga.execution.status": durableStatus,
        "saga.error.message": failure.message,
      });
      throw new SagaFinalizationProblem(definition.name, execution.id, failure, {
        status: durableStatus,
      });
    }

    return this.dispatchOutbox(definition, execution.id);
  }

  private async failExecution(
    definition: SagaDefinition,
    executionId: string,
    error: unknown,
    span: SagaTelemetrySpan,
  ): Promise<never> {
    const failure = toSagaFailure(error);
    const compensationFailures: SagaFailure[] = [];
    let finalStatus: SagaExecutionStatus = "failed";
    let failed: SagaExecution;
    try {
      const compensatedStepCount = await this.compensateCompletedSteps(
        definition,
        executionId,
        failure,
        compensationFailures,
      );
      finalStatus =
        compensatedStepCount > 0 && compensationFailures.length === 0 ? "compensated" : "failed";
      failed = await this.store.update(executionId, {
        status: finalStatus,
        error: failure,
        compensationFailures,
        completedAt: new Date(),
      });
    } catch (failureRecordError) {
      const problem = new SagaExecutionFailedProblem(definition.name, executionId, failure, {
        status: finalStatus,
        compensationFailures,
      });
      reportSagaFailureRecordError(
        span,
        definition.name,
        executionId,
        failure,
        problem,
        failureRecordError,
      );
      throw problem;
    }
    span.addEvent("saga.execution.failed", {
      "saga.name": definition.name,
      "saga.execution.id": failed.id,
      "saga.execution.status": failed.status,
      "saga.error.message": failure.message,
      "saga.compensation.failure_count": compensationFailures.length,
    });

    await this.dispatchOutbox(definition, failed.id);

    throw new SagaExecutionFailedProblem(definition.name, failed.id, failure, {
      status: failed.status,
      compensationFailures,
    });
  }

  private async runStep(
    definition: SagaDefinition,
    execution: SagaExecution,
    step: SagaStepDefinition,
    previousResults: readonly SagaStepResult[],
    outboxIdentityRoot: string,
  ): Promise<StepExecutionResult> {
    const maxAttempts = getMaxAttempts(step);
    let stepInput: unknown;
    let idempotencyKey: string | undefined;
    let record: SagaStepExecutionRecord = {
      id: step.id,
      status: "pending",
      attempts: 0,
      maxAttempts,
      input: undefined,
      outboxMessages: [],
    };
    await this.appendStepRecord(execution.id, record);

    try {
      stepInput = this.resolveStepInput(definition, execution, step, previousResults);
      record = await this.replaceStepRecord(execution.id, {
        ...record,
        input: stepInput,
      });
      idempotencyKey = this.resolveStepIdempotencyKey(
        definition,
        execution.id,
        execution.payload,
        step,
        stepInput,
        previousResults,
      );

      if (idempotencyKey !== undefined) {
        record = await this.replaceStepRecord(execution.id, {
          ...record,
          idempotencyKey,
        });
      }
    } catch (error) {
      await this.replaceStepRecord(execution.id, {
        ...record,
        status: "failed",
        error: toSagaFailure(error),
        completedAt: new Date(),
      });
      throw error;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      record = await this.replaceStepRecord(execution.id, {
        ...record,
        status: "running",
        attempts: attempt,
        startedAt: record.startedAt ?? new Date(),
      });

      const outboxMessages: SagaOutboxRecord[] = [];
      const context: SagaStepContext = {
        saga: definition,
        executionId: execution.id,
        payload: execution.payload,
        step,
        previousResults,
        stepInput,
        attempt,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        enqueueOutbox: (message) =>
          outboxMessages.push(
            this.createOutboxRecord(
              message,
              outboxIdentityRoot,
              step.id,
              "step",
              outboxMessages.length,
            ),
          ),
      };

      try {
        const result = await withSpan(() => step.run(stepInput, context), {
          name: `saga:${definition.name}:step:${step.id}`,
          attributes: getStepRecordAttributes(definition, execution.id, step),
        });
        const completedRecord: SagaStepExecutionRecord = {
          ...record,
          status: "completed",
          result,
          outboxMessages,
          completedAt: new Date(),
        };
        await this.replaceStepRecord(execution.id, completedRecord);
        return {
          result: {
            stepId: step.id,
            result,
          },
        };
      } catch (error) {
        const failure = toSagaFailure(error);
        record = await this.replaceStepRecord(execution.id, {
          ...record,
          status: "running",
          error: failure,
        });

        if (
          attempt < maxAttempts &&
          (await this.shouldRetryStep(definition, execution.id, step, attempt, error))
        ) {
          continue;
        }

        await this.replaceStepRecord(execution.id, {
          ...record,
          status: "failed",
          attempts: attempt,
          error: failure,
          completedAt: new Date(),
        });
        throw error;
      }
    }

    throw new SagaDefinitionProblem(
      definition.name,
      `step '${step.id}' retry policy is unreachable`,
    );
  }

  private async compensateCompletedSteps(
    definition: SagaDefinition,
    executionId: string,
    failure: SagaFailure,
    compensationFailures: SagaFailure[],
  ): Promise<number> {
    const execution = await this.getExecution(executionId);
    const outboxIdentityRoot = await this.resolveOutboxIdentityRoot(execution);
    let compensatedStepCount = 0;

    for (const record of [...execution.steps].reverse()) {
      if (record.status !== "completed") {
        continue;
      }

      const step = definition.steps.find((candidate) => candidate.id === record.id);
      if (!step?.compensate) {
        continue;
      }

      compensatedStepCount += 1;
      await this.replaceStepRecord(executionId, {
        ...record,
        status: "compensating",
        compensationStartedAt: new Date(),
      });

      try {
        const outboxMessages: SagaOutboxRecord[] = [];
        const result = await withSpan(
          () =>
            step.compensate?.(record.input, {
              saga: definition,
              executionId,
              payload: execution.payload,
              step,
              previousResults: this.toStepResults(execution),
              stepInput: record.input,
              attempt: record.attempts,
              failure,
              stepResult: record,
              ...(record.idempotencyKey !== undefined
                ? { idempotencyKey: record.idempotencyKey }
                : {}),
              enqueueOutbox: (message) =>
                outboxMessages.push(
                  this.createOutboxRecord(
                    message,
                    outboxIdentityRoot,
                    step.id,
                    "compensation",
                    outboxMessages.length,
                  ),
                ),
            }),
          {
            name: `saga:${definition.name}:compensate:${step.id}`,
            attributes: getStepRecordAttributes(definition, executionId, step),
          },
        );
        await this.replaceStepRecord(executionId, {
          ...record,
          status: "compensated",
          compensationResult: result,
          outboxMessages: [...record.outboxMessages, ...outboxMessages],
          compensationStartedAt: record.compensationStartedAt ?? new Date(),
          compensationCompletedAt: new Date(),
        });
      } catch (error) {
        const compensationFailure = toSagaFailure(error);
        compensationFailures.push(compensationFailure);
        await this.replaceStepRecord(executionId, {
          ...record,
          status: "compensation_failed",
          compensationError: compensationFailure,
          compensationStartedAt: record.compensationStartedAt ?? new Date(),
          compensationCompletedAt: new Date(),
        });
      }
    }

    return compensatedStepCount;
  }

  private resolveSagaIdempotencyKey(
    definition: SagaDefinition,
    payload: unknown,
  ): string | undefined {
    const resolver = definition.idempotencyKey;
    if (typeof resolver === "function") {
      return resolver({ saga: definition, payload });
    }

    return resolver;
  }

  private resolveStepInput(
    definition: SagaDefinition,
    execution: SagaExecution,
    step: SagaStepDefinition,
    previousResults: readonly SagaStepResult[],
  ): unknown {
    if (!step.input) {
      return execution.payload;
    }

    return step.input({
      saga: definition,
      executionId: execution.id,
      payload: execution.payload,
      step,
      previousResults,
    });
  }

  private resolveStepIdempotencyKey(
    definition: SagaDefinition,
    executionId: string,
    payload: unknown,
    step: SagaStepDefinition,
    stepInput: unknown,
    previousResults: readonly SagaStepResult[],
  ): string | undefined {
    const resolver = step.idempotencyKey;
    if (typeof resolver === "function") {
      const context: SagaStepIdempotencyContext = {
        saga: definition,
        executionId,
        payload,
        step,
        previousResults,
        stepInput,
      };
      return resolver(context);
    }

    return resolver;
  }

  private async shouldRetryStep(
    definition: SagaDefinition,
    executionId: string,
    step: SagaStepDefinition,
    attempt: number,
    error: unknown,
  ): Promise<boolean> {
    if (!step.retry?.shouldRetry) {
      return isRetryableError(error);
    }

    return step.retry.shouldRetry({
      saga: definition,
      executionId,
      step,
      attempt,
      error,
    });
  }

  async dispatchOutbox(definition: SagaDefinition, executionId: string): Promise<SagaExecution> {
    this.assertValidDefinition(definition);
    let execution = await this.getExecution(executionId);
    if (execution.sagaName !== definition.name) {
      throw new SagaDefinitionProblem(
        definition.name,
        `execution '${executionId}' belongs to saga '${execution.sagaName}'`,
      );
    }
    if (!isOutboxDispatchableStatus(execution.status)) {
      throw new SagaDefinitionProblem(
        definition.name,
        `execution '${executionId}' cannot dispatch outbox messages while '${execution.status}'`,
      );
    }
    if (!definition.outbox) {
      return execution;
    }

    const outboxRecords = [
      ...execution.steps.map((record) => ({ record, phase: "step" as const })),
      ...[...execution.steps]
        .reverse()
        .map((record) => ({ record, phase: "compensation" as const })),
    ];

    for (const { record, phase } of outboxRecords) {
      if (phase === "step" && execution.status !== "completed") {
        continue;
      }

      const step = definition.steps.find((candidate) => candidate.id === record.id);
      if (!step) {
        throw new SagaDefinitionProblem(
          definition.name,
          `execution '${executionId}' contains unknown step '${record.id}'`,
        );
      }

      for (const message of record.outboxMessages) {
        if (message.phase !== phase || message.status === "published") {
          continue;
        }

        await definition.outbox.publish(message, {
          saga: definition,
          executionId,
          step,
          message,
        });
        execution = await this.markOutboxPublished(executionId, record.id, message.deliveryId);
      }
    }

    return execution;
  }

  private createOutboxRecord(
    message: Parameters<SagaStepContext["enqueueOutbox"]>[0],
    outboxIdentityRoot: string,
    stepId: string,
    phase: SagaOutboxPhase,
    index: number,
  ): SagaOutboxRecord {
    return {
      ...message,
      deliveryId: `${outboxIdentityRoot}:${stepId}:${phase}:${index}:${message.id}`,
      stepId,
      phase,
      status: "pending",
      enqueuedAt: new Date().toISOString(),
    };
  }

  private async markOutboxPublished(
    executionId: string,
    stepId: string,
    deliveryId: string,
  ): Promise<SagaExecution> {
    const execution = await this.getExecution(executionId);
    const record = execution.steps.find((candidate) => candidate.id === stepId);
    if (!record) {
      throw new SagaDefinitionProblem(
        execution.sagaName,
        `execution '${executionId}' does not contain step '${stepId}'`,
      );
    }
    const outboxMessages = record.outboxMessages.map((message) =>
      message.deliveryId === deliveryId
        ? { ...message, status: "published" as const, publishedAt: new Date().toISOString() }
        : message,
    );
    await this.replaceStepRecord(executionId, { ...record, outboxMessages });
    return this.getExecution(executionId);
  }

  private async resolveOutboxIdentityRoot(execution: SagaExecution): Promise<string> {
    let current = execution;
    const visited = new Set<string>();
    while (current.replayOf !== undefined) {
      if (visited.has(current.id)) {
        throw new SagaDefinitionProblem(
          execution.sagaName,
          `execution '${execution.id}' has a cyclic replay chain`,
        );
      }
      visited.add(current.id);
      current = await this.getExecution(current.replayOf);
    }

    return current.id;
  }

  private throwStoredExecutionFailure(sagaName: string, execution: SagaExecution): never {
    const failure = execution.error ?? {
      message: `Saga execution '${execution.id}' is in '${execution.status}' status`,
      retryable: false,
    };

    throw new SagaExecutionFailedProblem(sagaName, execution.id, failure, {
      status: execution.status,
      compensationFailures: execution.compensationFailures,
    });
  }

  private async appendStepRecord(
    executionId: string,
    record: SagaStepExecutionRecord,
  ): Promise<SagaExecution> {
    const execution = await this.getExecution(executionId);
    return this.store.update(executionId, {
      steps: [...execution.steps, record],
    });
  }

  private async replaceStepRecord(
    executionId: string,
    record: SagaStepExecutionRecord,
  ): Promise<SagaStepExecutionRecord> {
    const execution = await this.getExecution(executionId);
    const steps = execution.steps.map((current) => (current.id === record.id ? record : current));
    await this.store.update(executionId, { steps });

    return record;
  }

  private toStepResults(execution: SagaExecution): SagaStepResult[] {
    return execution.steps
      .filter((step) => step.status === "completed" || step.status === "compensated")
      .map((step) => ({
        stepId: step.id,
        result: step.result,
      }));
  }

  private assertValidDefinition(definition: SagaDefinition): void {
    if (definition.name.length === 0) {
      throw new SagaDefinitionProblem(definition.name, "saga name must not be empty");
    }

    if (definition.steps.length === 0) {
      throw new SagaDefinitionProblem(definition.name, "saga must declare at least one step");
    }

    const stepIds = new Set<string>();
    for (const step of definition.steps) {
      if (step.id.length === 0) {
        throw new SagaDefinitionProblem(definition.name, "saga step id must not be empty");
      }

      if (stepIds.has(step.id)) {
        throw new SagaDefinitionProblem(definition.name, `duplicate saga step id '${step.id}'`);
      }

      stepIds.add(step.id);

      const maxAttempts = getMaxAttempts(step);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new SagaDefinitionProblem(
          definition.name,
          `step '${step.id}' retry maxAttempts must be a positive integer`,
        );
      }
    }
  }
}
