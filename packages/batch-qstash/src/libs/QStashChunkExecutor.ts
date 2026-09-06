import {
  assertValidBatchStepName,
  assertValidChunkSize,
  createStepExecutionError,
} from "@croco/batch-core";
import type { Checkpointable, ItemReader, ItemWriter, Step } from "@croco/batch-core";
import type {
  Execution,
  ExecutionContinuationClaim,
  ExecutionContinuationManager,
  ExecutionContinuationPublication,
  ExecutionManager,
} from "@croco/execution-core";
import { ExecutionProblems, INITIAL_EXECUTION_CONTINUATION_TOKEN } from "@croco/execution-core";
import { Problem } from "@croco/problems-core";
import type { Client } from "@upstash/qstash";
import {
  QStashBatchConfigProblem,
  QStashBatchPublishProblem,
  QStashBatchValidationProblem,
} from "./problems/QStashBatchProblems";

function isCheckpointable(obj: unknown): obj is Checkpointable {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "getCheckpoint" in obj &&
    typeof (obj as Checkpointable).getCheckpoint === "function" &&
    "restoreCheckpoint" in obj &&
    typeof (obj as Checkpointable).restoreCheckpoint === "function"
  );
}

function isPeekable<I>(obj: unknown): obj is { peek(): Promise<I | null> } {
  return typeof obj === "object" && obj !== null && "peek" in obj && typeof obj.peek === "function";
}

export interface QStashIdempotentWriteContext {
  executionId: string;
  stepName: string;
  attempt: number;
  processingToken: string;
}

/**
 * Writer capability required at the external side-effect boundary.
 *
 * Implementations must treat processingToken as an idempotency key. The token is
 * stable when an expired continuation lease is reclaimed by another worker.
 */
export interface QStashIdempotentWriter<O> {
  writeIdempotent(items: O[], context: QStashIdempotentWriteContext): Promise<void>;
}

export type QStashStep<I, O> = Omit<Step<I, O>, "reader" | "writer"> & {
  reader: ItemReader<I> & Checkpointable;
  writer: ItemWriter<O> & QStashIdempotentWriter<O>;
};

export interface QStashChunkDelivery {
  continuationToken?: string;
  workerId?: string;
}

export type QStashChunkResult =
  | { hasMore: boolean; processedCount: number }
  | {
      kind: "stale";
      hasMore: false;
      processedCount: 0;
      deliveryToken: string;
    };

/** Options required by the QStash chunk executor. */
export interface QStashExecutorOptions {
  qstashClient: Client;
  webhookUrl: string;
  heartbeatIntervalMs?: number;
  tokenGenerator?: () => string;
  workerIdGenerator?: () => string;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

/** Executes one fenced batch chunk and schedules its token-bound continuation. */
export class QStashChunkExecutor {
  private readonly continuationManager: ExecutionContinuationManager;
  private readonly heartbeatIntervalMs: number;
  private readonly tokenGenerator: () => string;
  private readonly workerIdGenerator: () => string;

  constructor(
    executionManager: ExecutionManager & ExecutionContinuationManager,
    private readonly options: QStashExecutorOptions,
  ) {
    this.continuationManager = validateExecutionManager(executionManager);
    validateQStashClient(options.qstashClient);
    validateWebhookUrl(options.webhookUrl);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isFinite(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
      throw new QStashBatchValidationProblem("heartbeatIntervalMs must be a positive number.");
    }
    const continuationLeaseDurationMs = this.continuationManager.getContinuationLeaseDurationMs();
    if (!Number.isFinite(continuationLeaseDurationMs) || continuationLeaseDurationMs <= 0) {
      throw new QStashBatchValidationProblem(
        "The execution continuation lease duration must be a positive number.",
      );
    }
    if (this.heartbeatIntervalMs >= continuationLeaseDurationMs) {
      throw new QStashBatchValidationProblem(
        "heartbeatIntervalMs must be less than the execution continuation lease duration.",
      );
    }
    this.tokenGenerator = options.tokenGenerator ?? (() => globalThis.crypto.randomUUID());
    this.workerIdGenerator = options.workerIdGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  async executeChunk<I, O>(
    executionId: string,
    step: QStashStep<I, O>,
    delivery: QStashChunkDelivery = {},
  ): Promise<QStashChunkResult> {
    validateQStashStep(step);

    const deliveryToken = delivery.continuationToken ?? INITIAL_EXECUTION_CONTINUATION_TOKEN;
    const workerId = delivery.workerId ?? this.workerIdGenerator();
    const acquired = await this.continuationManager.claimContinuation(executionId, {
      deliveryToken,
      workerId,
    });

    if (acquired.kind === "stale") {
      return {
        kind: "stale",
        hasMore: false,
        processedCount: 0,
        deliveryToken: acquired.deliveryToken,
      };
    }

    if (acquired.kind === "contended") {
      throw ExecutionProblems.continuationConflict(
        `Continuation delivery is already owned for execution '${executionId}'`,
        {
          currentWorkerId: acquired.claim.workerId,
          currentLeaseExpiresAt: acquired.claim.expiresAt.toISOString(),
        },
      );
    }

    const heartbeat = this.createHeartbeat(executionId, acquired.claim, workerId);
    try {
      if (acquired.kind === "publish_pending") {
        await heartbeat.renew();
        await this.publishContinuation(executionId, step.name, acquired.publication);
        await heartbeat.assertOwned();
        await heartbeat.runOwned(() =>
          this.continuationManager.confirmContinuationPublication(executionId, acquired.claim),
        );
        return { hasMore: true, processedCount: 0 };
      }

      return await this.processClaimedChunk(
        executionId,
        step,
        acquired.execution,
        acquired.claim,
        heartbeat,
      );
    } catch (error) {
      await this.failWhileOwned(executionId, step, acquired.claim, error, heartbeat);
      throw error;
    } finally {
      heartbeat.stop();
    }
  }

  private async processClaimedChunk<I, O>(
    executionId: string,
    step: QStashStep<I, O>,
    execution: Execution,
    claim: ExecutionContinuationClaim,
    heartbeat: ContinuationHeartbeat,
  ): Promise<{ hasMore: boolean; processedCount: number }> {
    const checkpointKey = `${step.name}.cursor`;
    const processedCountKey = `${step.name}.processedCount`;
    const checkpoint = execution.checkpoints?.[checkpointKey];
    if (checkpoint !== undefined) {
      step.reader.restoreCheckpoint(checkpoint);
    }

    const previousProcessedCount = getProcessedCount(execution.checkpoints?.[processedCountKey]);
    const items: O[] = [];
    let readCount = 0;

    for (let i = 0; i < step.chunkSize; i++) {
      await heartbeat.assertOwned();
      const item = await step.reader.read();
      if (item === null) break;
      readCount += 1;
      const processedItem = step.processor
        ? await step.processor.process(item)
        : (item as unknown as O);
      if (processedItem !== null) items.push(processedItem);
    }

    await heartbeat.renew();
    if (items.length > 0) {
      await step.writer.writeIdempotent(items, {
        executionId,
        stepName: step.name,
        attempt: claim.attempt,
        processingToken: claim.processingToken,
      });
    }
    await heartbeat.assertOwned();

    const checkpointAfterChunk = step.reader.getCheckpoint();
    const hasMore = await this.hasMoreItems(step, readCount, checkpointAfterChunk);
    const cumulativeProcessedCount = previousProcessedCount + items.length;

    if (!hasMore) {
      await heartbeat.renew();
      await heartbeat.runOwned(() =>
        this.continuationManager.completeContinuation(executionId, claim, {
          processedCount: cumulativeProcessedCount,
        }),
      );
      return { hasMore: false, processedCount: items.length };
    }

    const nextToken = this.tokenGenerator();
    const checkpoints = {
      ...execution.checkpoints,
      ...(checkpointAfterChunk !== undefined ? { [checkpointKey]: checkpointAfterChunk } : {}),
      [processedCountKey]: cumulativeProcessedCount,
    };
    await heartbeat.runOwned(() =>
      this.continuationManager.stageContinuation(executionId, claim, {
        checkpoints,
        nextToken,
      }),
    );
    await heartbeat.renew();
    await this.publishContinuation(executionId, step.name, {
      attempt: claim.attempt,
      sourceToken: claim.processingToken,
      nextToken,
    });
    await heartbeat.assertOwned();
    await heartbeat.runOwned(() =>
      this.continuationManager.confirmContinuationPublication(executionId, claim),
    );
    return { hasMore: true, processedCount: items.length };
  }

  private async hasMoreItems<I, O>(
    step: QStashStep<I, O>,
    readCount: number,
    checkpointAfterChunk: unknown,
  ): Promise<boolean> {
    if (readCount < step.chunkSize) return false;
    if (isPeekable<I>(step.reader)) return (await step.reader.peek()) !== null;
    const nextItem = await step.reader.read();
    step.reader.restoreCheckpoint(checkpointAfterChunk);
    return nextItem !== null;
  }

  private async publishContinuation(
    executionId: string,
    stepName: string,
    publication: ExecutionContinuationPublication,
  ): Promise<void> {
    await runQStashBatchOperation("publishJSON", () =>
      this.options.qstashClient.publishJSON({
        url: this.options.webhookUrl,
        deduplicationId: `chunk:${executionId}:${stepName}:${publication.nextToken}`,
        body: {
          executionId,
          stepName,
          continuationToken: publication.nextToken,
        },
        headers: {
          "Idempotency-Key": `chunk:${executionId}:${stepName}:${publication.attempt}:${publication.nextToken}`,
        },
      }),
    );
  }

  private createHeartbeat(
    executionId: string,
    claim: ExecutionContinuationClaim,
    workerId: string,
  ): ContinuationHeartbeat {
    let failure: unknown;
    let mutation = Promise.resolve();
    const runOwned = async <T>(action: () => Promise<T>): Promise<T> => {
      if (failure !== undefined) throw failure;
      const result = mutation.then(action);
      mutation = result.then(
        () => undefined,
        (error: unknown) => {
          failure = error;
        },
      );
      try {
        return await result;
      } catch (error) {
        failure = error;
        throw error;
      }
    };
    const renew = (): Promise<void> =>
      runOwned(() =>
        this.continuationManager.renewContinuationClaim(executionId, claim, { workerId }),
      ).then(() => undefined);
    const timer = setInterval(() => {
      void renew().catch(() => undefined);
    }, this.heartbeatIntervalMs);

    return {
      renew,
      runOwned,
      assertOwned: async () => {
        if (failure !== undefined) throw failure;
        await mutation;
        if (failure !== undefined) throw failure;
      },
      stop: () => clearInterval(timer),
    };
  }

  private async failWhileOwned<I, O>(
    executionId: string,
    step: QStashStep<I, O>,
    claim: ExecutionContinuationClaim,
    error: unknown,
    heartbeat: ContinuationHeartbeat,
  ): Promise<void> {
    try {
      await heartbeat.runOwned(() =>
        this.continuationManager.failContinuation(
          executionId,
          claim,
          createStepExecutionError(error, step.classifyFailure, {
            executionId,
            stepName: step.name,
          }),
        ),
      );
    } catch (failureError) {
      if (isContinuationConflict(failureError)) {
        // A lost fence must never be followed by an unconditional failure mutation.
        return;
      }
      throw failureError;
    }
  }
}

interface ContinuationHeartbeat {
  renew(): Promise<void>;
  runOwned<T>(action: () => Promise<T>): Promise<T>;
  assertOwned(): Promise<void>;
  stop(): void;
}

function getProcessedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isContinuationConflict(error: unknown): boolean {
  return error instanceof Problem && error.code === "execution/continuation-conflict";
}

function validateExecutionManager(
  value: ExecutionManager & ExecutionContinuationManager,
): ExecutionContinuationManager {
  if (!value) throw new QStashBatchConfigProblem("executionManager");
  const candidate = value as ExecutionManager & Partial<ExecutionContinuationManager>;
  const methods: readonly (keyof ExecutionContinuationManager)[] = [
    "getContinuationLeaseDurationMs",
    "claimContinuation",
    "renewContinuationClaim",
    "stageContinuation",
    "confirmContinuationPublication",
    "completeContinuation",
    "failContinuation",
  ];
  if (methods.some((method) => typeof candidate[method] !== "function")) {
    throw new QStashBatchConfigProblem("executionManager.continuation");
  }
  return candidate as ExecutionManager & ExecutionContinuationManager;
}

function validateQStashStep<I, O>(step: QStashStep<I, O>): void {
  assertValidBatchStepName(step?.name);
  assertValidChunkSize(step?.chunkSize);

  if (!isCheckpointable(step?.reader)) {
    throw new QStashBatchConfigProblem("step.reader.checkpoint");
  }

  const writer = step?.writer as Partial<QStashIdempotentWriter<O>> | undefined;
  if (!writer || typeof writer.writeIdempotent !== "function") {
    throw new QStashBatchConfigProblem("step.writer.writeIdempotent");
  }
}

function validateQStashClient(value: Client): void {
  const candidate = value as { readonly publishJSON?: unknown } | undefined;
  if (!candidate || typeof candidate.publishJSON !== "function") {
    throw new QStashBatchConfigProblem("qstashClient");
  }
}

function validateWebhookUrl(value: string): void {
  if (!value || value.trim().length === 0) throw new QStashBatchConfigProblem("webhookUrl");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new QStashBatchValidationProblem("QStash batch webhookUrl must use http or https.");
    }
  } catch (error) {
    if (error instanceof QStashBatchValidationProblem) throw error;
    throw new QStashBatchValidationProblem("QStash batch webhookUrl must be a valid URL.");
  }
}

async function runQStashBatchOperation<T>(
  operation: string,
  action: () => Promise<T> | T,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new QStashBatchPublishProblem(operation, error);
  }
}
