import type { ItemWriter, Step } from "@croco/batch-core";
import { ExecutionManagerImpl } from "@croco/execution-core";
import {
  createQStashBatchConformanceSuite,
  type QStashBatchConformanceScenario,
} from "@croco/testing";
import type { Client } from "@upstash/qstash";
import { describe, expect, it, vi } from "vitest";
import {
  QStashChunkExecutor,
  type QStashIdempotentWriteContext,
  type QStashStep,
} from "../libs/QStashChunkExecutor";
import { InMemoryContinuationStore } from "./InMemoryContinuationStore";

type Harness = ReturnType<typeof createHarness>;

const QSTASH_BATCH_LIVE_ENV = [
  "CROCO_LIVE_QSTASH",
  "QSTASH_TOKEN",
  "QSTASH_BATCH_WEBHOOK_URL",
] as const;
const SECRET_SAMPLE = "super-secret-token";
const SECRET_RICH_ERROR_MESSAGE = `Authorization: Bearer ${SECRET_SAMPLE}; "token":"${SECRET_SAMPLE}"; https://qstash.upstash.io?token=${SECRET_SAMPLE}; Cookie: session=${SECRET_SAMPLE}`;

function createHarness(
  options: {
    maxAttempts?: number;
    leaseDurationMs?: number;
    heartbeatIntervalMs?: number;
    publishJSON?: ReturnType<typeof vi.fn>;
    webhookUrl?: string;
    tokenGenerator?: () => string;
  } = {},
) {
  const store = new InMemoryContinuationStore();
  const managerTokens = Array.from({ length: 30 }, (_, index) => `manager-token-${index + 1}`);
  const continuationTokens = Array.from({ length: 10 }, (_, index) => `next-token-${index + 1}`);
  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new ExecutionManagerImpl(store, {
    clock: () => now,
    tokenGenerator: () => managerTokens.shift() ?? "manager-fallback",
    continuationLeaseDurationMs: options.leaseDurationMs ?? 120_000,
  });
  const publishJSON = options.publishJSON ?? vi.fn().mockResolvedValue({ messageId: "message-1" });
  const executor = new QStashChunkExecutor(manager, {
    qstashClient: { publishJSON } as unknown as Client,
    webhookUrl: options.webhookUrl ?? "https://example.com/batch",
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
    tokenGenerator: options.tokenGenerator ?? (() => continuationTokens.shift() ?? "next-fallback"),
    workerIdGenerator: () => "worker-default",
  });

  return {
    store,
    manager,
    executor,
    publishJSON,
    createExecution: () => manager.create({ type: "batch", maxAttempts: options.maxAttempts ?? 3 }),
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

function createUpstreamError(message: string, status: number): Error & { readonly status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

async function createBatchConformanceHarness(scenario: QStashBatchConformanceScenario) {
  const publishJSON = vi.fn().mockResolvedValue({ messageId: "msg-conformance" });
  if (scenario === "retryable-upstream") {
    publishJSON.mockRejectedValue(createUpstreamError(SECRET_RICH_ERROR_MESSAGE, 503));
  }
  if (scenario === "terminal-upstream") {
    publishJSON.mockRejectedValue(createUpstreamError(SECRET_RICH_ERROR_MESSAGE, 400));
  }

  const harness = createHarness({
    publishJSON,
    webhookUrl: "https://example.com/batch/conformance",
  });
  const execution = await harness.createExecution();
  const failures: unknown[] = [];
  const failContinuation = harness.manager.failContinuation.bind(harness.manager);
  vi.spyOn(harness.manager, "failContinuation").mockImplementation(
    async (executionId, claim, failure) => {
      failures.push(failure);
      return failContinuation(executionId, claim, failure);
    },
  );

  return {
    executionId: execution.id,
    executor: harness.executor as never,
    getExecutionFailures: () => failures,
    getPublishedMessages: () => publishJSON.mock.calls.map((call) => call[0]),
  };
}

function isTruthyEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for QStash batch live smoke.`);
  return value;
}

async function runQStashBatchLiveSmoke(): Promise<void> {
  const harness = createHarness({
    publishJSON: vi.fn().mockImplementation(async (request) => {
      const client = new Client({ token: readRequiredEnv("QSTASH_TOKEN") });
      return client.publishJSON(request);
    }),
    webhookUrl: readRequiredEnv("QSTASH_BATCH_WEBHOOK_URL"),
  });
  const execution = await harness.createExecution();
  const result = await harness.executor.executeChunk(
    execution.id,
    createStep(createCheckpointReader([1, 2]), createWriter(), 1),
  );
  expect(result.hasMore).toBe(true);
}

function createCheckpointReader(items: number[]) {
  let cursor = 0;
  return {
    read: vi.fn(async () => items[cursor++] ?? null),
    getCheckpoint: vi.fn(() => ({ cursor })),
    restoreCheckpoint: vi.fn((checkpoint: unknown) => {
      cursor = (checkpoint as { cursor: number }).cursor;
    }),
  };
}

function createWriter(
  writeIdempotent: (
    items: number[],
    context: QStashIdempotentWriteContext,
  ) => Promise<void> = async () => undefined,
) {
  return {
    write: vi.fn(async () => undefined),
    writeIdempotent: vi.fn(writeIdempotent),
  };
}

function createStep(
  reader: ReturnType<typeof createCheckpointReader>,
  writer = createWriter(),
  chunkSize = 3,
): QStashStep<number, number> {
  return {
    name: "numbers",
    reader,
    writer,
    chunkSize,
  };
}

function publishedToken(harness: Harness, callIndex: number): string {
  const body = harness.publishJSON.mock.calls[callIndex]?.[0]?.body as
    | { continuationToken?: string }
    | undefined;
  if (!body?.continuationToken) throw new Error(`Missing publication ${callIndex}`);
  return body.continuationToken;
}

describe("QStashChunkExecutor continuation execution", () => {
  describe("QStash batch conformance", () => {
    it.each(
      createQStashBatchConformanceSuite({
        createExecutor: createBatchConformanceHarness,
        liveSmoke: {
          isEnabled: () =>
            isTruthyEnv("CROCO_LIVE_QSTASH") &&
            QSTASH_BATCH_LIVE_ENV.every((name) => Boolean(process.env[name])),
          requiredEnv: QSTASH_BATCH_LIVE_ENV,
          run: runQStashBatchLiveSmoke,
        },
        providerName: "batch-qstash",
        secretSamples: [SECRET_SAMPLE],
      }).cases,
    )("$name", async ({ run }) => {
      await run();
    });
  });

  it("processes three chunks with the real manager and completes attempt one cumulatively", async () => {
    const harness = createHarness();
    const execution = await harness.createExecution();
    const reader = createCheckpointReader([1, 2, 3, 4, 5, 6, 7]);
    const writer = createWriter();
    const step = createStep(reader, writer);

    const first = await harness.executor.executeChunk(execution.id, step);
    const startedAt = (await harness.manager.get(execution.id)).startedAt;
    harness.advance(100);
    const second = await harness.executor.executeChunk(execution.id, step, {
      continuationToken: publishedToken(harness, 0),
      workerId: "worker-2",
    });
    harness.advance(100);
    const third = await harness.executor.executeChunk(execution.id, step, {
      continuationToken: publishedToken(harness, 1),
      workerId: "worker-3",
    });

    expect([first, second, third]).toEqual([
      { hasMore: true, processedCount: 3 },
      { hasMore: true, processedCount: 3 },
      { hasMore: false, processedCount: 1 },
    ]);
    expect(writer.writeIdempotent.mock.calls.map(([items]) => items)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ]);
    const completed = await harness.manager.get(execution.id);
    expect(completed).toMatchObject({
      status: "completed",
      attempts: 1,
      startedAt,
      result: { processedCount: 7 },
    });
    expect(harness.publishJSON.mock.calls[0]?.[0]).toMatchObject({
      deduplicationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      body: {
        executionId: execution.id,
        stepName: "numbers",
        continuationToken: "next-token-1",
      },
      headers: {
        "Idempotency-Key": `chunk:${execution.id}:numbers:1:next-token-1`,
      },
    });
    expect(harness.publishJSON.mock.calls[1]?.[0].deduplicationId).not.toBe(
      harness.publishJSON.mock.calls[0]?.[0].deduplicationId,
    );
    expect(harness.publishJSON.mock.calls[1]?.[0]).toMatchObject({
      deduplicationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      headers: {
        "Idempotency-Key": `chunk:${execution.id}:numbers:1:next-token-2`,
      },
    });
  });

  it("encodes long continuation identities without provider-reserved characters", async () => {
    const nextToken = "6fe9a0b4-c934-49e1-a75c-8c72c7f34b98";
    const harness = createHarness({ tokenGenerator: () => nextToken });
    const execution = await harness.createExecution();
    const step = {
      ...createStep(createCheckpointReader([1, 2]), createWriter(), 1),
      name: "long-step-".repeat(10),
    };

    await harness.executor.executeChunk(execution.id, step);

    const request = harness.publishJSON.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      deduplicationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      body: { executionId: execution.id, stepName: step.name, continuationToken: nextToken },
      headers: { "Idempotency-Key": `chunk:${execution.id}:${step.name}:1:${nextToken}` },
    });
  });

  it("keeps unique step cursor and processed-count checkpoints independent", async () => {
    const harness = createHarness();
    const execution = await harness.createExecution();
    await harness.store.update(execution.id, {
      checkpoints: {
        "extract.cursor": { cursor: 4 },
        "extract.processedCount": 4,
      },
    });

    const result = await harness.executor.executeChunk(execution.id, {
      ...createStep(createCheckpointReader([5, 6]), createWriter(), 1),
      name: "load",
    });

    expect(result).toEqual({ hasMore: true, processedCount: 1 });
    expect((await harness.manager.get(execution.id)).checkpoints).toEqual({
      "extract.cursor": { cursor: 4 },
      "extract.processedCount": 4,
      "load.cursor": { cursor: 1 },
      "load.processedCount": 1,
    });
  });

  it("uses a distinct idempotency token for each execution's first chunk", async () => {
    const harness = createHarness();
    const firstExecution = await harness.createExecution();
    const secondExecution = await harness.createExecution();
    const contexts: QStashIdempotentWriteContext[] = [];
    const writer = createWriter(async (_items, context) => {
      contexts.push(context);
    });

    await harness.executor.executeChunk(
      firstExecution.id,
      createStep(createCheckpointReader([1]), writer),
    );
    await harness.executor.executeChunk(
      secondExecution.id,
      createStep(createCheckpointReader([2]), writer),
    );

    expect(contexts.map(({ processingToken }) => processingToken)).toEqual([
      "manager-token-1",
      "manager-token-3",
    ]);
    expect(new Set(contexts.map(({ processingToken }) => processingToken)).size).toBe(2);
  });

  it("acknowledges a duplicate old token without reading or writing again", async () => {
    const harness = createHarness();
    const execution = await harness.createExecution();
    const reader = createCheckpointReader([1, 2, 3, 4]);
    const writer = createWriter();
    const step = createStep(reader, writer);

    await harness.executor.executeChunk(execution.id, step);
    const duplicate = await harness.executor.executeChunk(execution.id, step, {
      continuationToken: "initial",
      workerId: "duplicate",
    });

    expect(duplicate).toMatchObject({
      kind: "stale",
      processedCount: 0,
      hasMore: false,
    });
    expect(writer.writeIdempotent).toHaveBeenCalledTimes(1);
  });

  it("reports active same-token contention and lets only one writer run", async () => {
    const harness = createHarness();
    const execution = await harness.createExecution();
    let releaseWriter!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = createWriter(async () => blocked);
    const first = harness.executor.executeChunk(
      execution.id,
      createStep(createCheckpointReader([1]), writer),
      { workerId: "winner" },
    );
    await vi.waitFor(() => expect(writer.writeIdempotent).toHaveBeenCalledTimes(1));

    await expect(
      harness.executor.executeChunk(execution.id, createStep(createCheckpointReader([1]), writer), {
        workerId: "contender",
      }),
    ).rejects.toMatchObject({ code: "execution/continuation-conflict" });
    releaseWriter();
    await first;
    expect(writer.writeIdempotent).toHaveBeenCalledTimes(1);
  });

  it("preserves the processing token when retrying and increments the attempt once", async () => {
    const harness = createHarness({ maxAttempts: 2 });
    const execution = await harness.createExecution();
    const committed = new Set<string>();
    let writeCalls = 0;
    const writer = createWriter(async (_items, context) => {
      writeCalls += 1;
      committed.add(context.processingToken);
      if (writeCalls === 1) throw new Error("transient write after commit");
    });

    await expect(
      harness.executor.executeChunk(execution.id, createStep(createCheckpointReader([1]), writer), {
        workerId: "attempt-1",
      }),
    ).rejects.toThrow("transient write after commit");
    await harness.executor.executeChunk(
      execution.id,
      createStep(createCheckpointReader([1]), writer),
      { continuationToken: "initial", workerId: "attempt-2" },
    );

    const completed = await harness.manager.get(execution.id);
    expect(completed).toMatchObject({ status: "completed", attempts: 2 });
    expect(writer.writeIdempotent.mock.calls.map((call) => call[1].processingToken)).toEqual([
      "manager-token-1",
      "manager-token-1",
    ]);
    expect(committed).toEqual(new Set(["manager-token-1"]));
  });

  it("recovers a staged publish failure by publishing only the stored token", async () => {
    const harness = createHarness({ maxAttempts: 2 });
    const execution = await harness.createExecution();
    const reader = createCheckpointReader([1, 2, 3, 4]);
    const writer = createWriter();
    const step = createStep(reader, writer, 2);
    harness.publishJSON.mockRejectedValueOnce(new Error("upstream timeout"));

    await expect(harness.executor.executeChunk(execution.id, step)).rejects.toMatchObject({
      code: "batch-qstash/publish-failed",
    });
    expect(writer.writeIdempotent).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledTimes(3);

    const recovered = await harness.executor.executeChunk(execution.id, step, {
      continuationToken: "initial",
      workerId: "publication-recovery",
    });
    expect(recovered).toEqual({ hasMore: true, processedCount: 0 });
    expect(writer.writeIdempotent).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledTimes(3);
    expect(publishedToken(harness, 1)).toBe("next-token-1");
    expect(harness.publishJSON).toHaveBeenCalledTimes(2);
    for (const [index, [request]] of harness.publishJSON.mock.calls.entries()) {
      expect(request).toMatchObject({
        deduplicationId: expect.stringMatching(/^[a-f0-9]{64}$/),
        body: {
          executionId: execution.id,
          stepName: "numbers",
          continuationToken: "next-token-1",
        },
        headers: {
          "Idempotency-Key": `chunk:${execution.id}:numbers:${index + 1}:next-token-1`,
        },
      });
    }
    expect(harness.publishJSON.mock.calls[1]?.[0].deduplicationId).toBe(
      harness.publishJSON.mock.calls[0]?.[0].deduplicationId,
    );
    const delayedOldAttempt = await harness.executor.executeChunk(execution.id, step, {
      continuationToken: "initial",
      workerId: "delayed-old-attempt",
    });
    expect(delayedOldAttempt).toMatchObject({ kind: "stale" });

    await harness.executor.executeChunk(execution.id, step, {
      continuationToken: "next-token-1",
      workerId: "next-chunk",
    });
    expect(writer.writeIdempotent).toHaveBeenCalledTimes(2);
    expect(await harness.manager.get(execution.id)).toMatchObject({
      attempts: 2,
    });
  });

  it.each(["publish response", "publication confirmation"])(
    "processes an already delivered next token after losing the %s",
    async (failurePoint) => {
      const harness = createHarness({ maxAttempts: 2 });
      const execution = await harness.createExecution();
      const writer = createWriter();
      const step = createStep(createCheckpointReader([1, 2, 3, 4]), writer, 2);
      if (failurePoint === "publish response") {
        harness.publishJSON.mockRejectedValueOnce(new Error("response lost after acceptance"));
      } else {
        vi.spyOn(harness.manager, "confirmContinuationPublication").mockRejectedValueOnce(
          new Error("confirmation unavailable"),
        );
      }

      await expect(harness.executor.executeChunk(execution.id, step)).rejects.toThrow();
      harness.advance(120_001);
      const continuationToken = publishedToken(harness, 0);
      const result = await harness.executor.executeChunk(execution.id, step, {
        continuationToken,
        workerId: "accepted-publication-delivery",
      });

      expect(result).toEqual({ hasMore: false, processedCount: 2 });
      expect(writer.writeIdempotent.mock.calls.map(([items]) => items)).toEqual([
        [1, 2],
        [3, 4],
      ]);
      expect(harness.publishJSON).toHaveBeenCalledTimes(1);
      expect(await harness.manager.get(execution.id)).toMatchObject({
        status: "completed",
        result: { processedCount: 4 },
      });
      await expect(
        harness.executor.executeChunk(execution.id, step, { continuationToken }),
      ).resolves.toMatchObject({ kind: "stale" });
      expect(writer.writeIdempotent).toHaveBeenCalledTimes(2);
    },
  );

  it("records processing failure under the fresh claim after confirming a delivered token", async () => {
    const harness = createHarness();
    const execution = await harness.createExecution();
    const failContinuation = vi.spyOn(harness.manager, "failContinuation");
    const writer = createWriter();
    const step = createStep(createCheckpointReader([1, 2, 3, 4]), writer, 2);
    harness.publishJSON.mockRejectedValueOnce(new Error("response lost after acceptance"));
    await expect(harness.executor.executeChunk(execution.id, step)).rejects.toThrow();
    const continuationToken = publishedToken(harness, 0);
    writer.writeIdempotent.mockRejectedValueOnce(new Error("writer unavailable"));

    await expect(
      harness.executor.executeChunk(execution.id, step, { continuationToken }),
    ).rejects.toThrow("writer unavailable");
    expect(failContinuation).toHaveBeenCalledTimes(2);
    expect(await harness.manager.get(execution.id)).toMatchObject({
      status: "retrying",
      attempts: 2,
    });

    await expect(
      harness.executor.executeChunk(execution.id, step, { continuationToken }),
    ).resolves.toEqual({ hasMore: false, processedCount: 2 });
    expect(writer.writeIdempotent.mock.calls[2]?.[1].processingToken).toBe(
      writer.writeIdempotent.mock.calls[1]?.[1].processingToken,
    );
    expect(harness.publishJSON).toHaveBeenCalledTimes(1);
    expect(await harness.manager.get(execution.id)).toMatchObject({
      status: "completed",
      attempts: 3,
      result: { processedCount: 4 },
    });
  });

  it("reuses the processing token after lease takeover and fences the stale owner", async () => {
    const harness = createHarness({ leaseDurationMs: 60_001 });
    const execution = await harness.createExecution();
    const committed = new Set<string>();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const writer = createWriter(async (_items, context) => {
      calls += 1;
      if (calls === 1) await firstBlocked;
      committed.add(context.processingToken);
    });
    const first = harness.executor.executeChunk(
      execution.id,
      createStep(createCheckpointReader([1]), writer),
      { workerId: "expired-owner" },
    );
    await vi.waitFor(() => expect(writer.writeIdempotent).toHaveBeenCalledTimes(1));
    const startedAt = (await harness.manager.get(execution.id)).startedAt;
    harness.advance(60_002);

    await harness.executor.executeChunk(
      execution.id,
      createStep(createCheckpointReader([1]), writer),
      { workerId: "takeover" },
    );
    releaseFirst();
    await expect(first).rejects.toMatchObject({
      code: "execution/continuation-conflict",
    });
    expect(writer.writeIdempotent.mock.calls.map((call) => call[1].processingToken)).toEqual([
      "manager-token-1",
      "manager-token-1",
    ]);
    expect(committed).toEqual(new Set(["manager-token-1"]));
    expect(await harness.manager.get(execution.id)).toMatchObject({ startedAt });
  });

  it("renews the claim while an idempotent writer is in flight", async () => {
    const harness = createHarness({ heartbeatIntervalMs: 5 });
    const execution = await harness.createExecution();
    const renew = vi.spyOn(harness.manager, "renewContinuationClaim");
    const writer = createWriter(async () => new Promise((resolve) => setTimeout(resolve, 25)));

    await harness.executor.executeChunk(
      execution.id,
      createStep(createCheckpointReader([1]), writer),
    );

    expect(renew.mock.calls.length).toBeGreaterThan(2);
  });

  it("serializes a heartbeat renewal before staging the checkpoint", async () => {
    const harness = createHarness({ heartbeatIntervalMs: 5 });
    const execution = await harness.createExecution();
    const originalRenew = harness.manager.renewContinuationClaim.bind(harness.manager);
    let renewCalls = 0;
    let releaseRenewal!: () => void;
    const blockedRenewal = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    vi.spyOn(harness.manager, "renewContinuationClaim").mockImplementation(async (...args) => {
      renewCalls += 1;
      if (renewCalls === 2) await blockedRenewal;
      return originalRenew(...args);
    });
    const stage = vi.spyOn(harness.manager, "stageContinuation");
    let releaseWriter!: () => void;
    const blockedWriter = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = createWriter(async () => blockedWriter);

    const executionPromise = harness.executor.executeChunk(
      execution.id,
      createStep(createCheckpointReader([1, 2]), writer, 1),
    );
    await vi.waitFor(() => expect(renewCalls).toBeGreaterThanOrEqual(2));
    releaseWriter();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(stage).not.toHaveBeenCalled();

    releaseRenewal();
    await executionPromise;
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-conflict persistence failure while recording a chunk error", async () => {
    const harness = createHarness();
    const execution = await harness.createExecution();
    vi.spyOn(harness.manager, "failContinuation").mockRejectedValue(
      new Error("continuation store unavailable"),
    );
    const writer = createWriter(async () => {
      throw new Error("writer failed");
    });

    await expect(
      harness.executor.executeChunk(execution.id, createStep(createCheckpointReader([1]), writer)),
    ).rejects.toThrow("continuation store unavailable");
  });

  it("rejects a plain writer before acquiring an execution claim", async () => {
    const harness = createHarness();
    const execution = await harness.createExecution();
    const claim = vi.spyOn(harness.manager, "claimContinuation");
    const plainStep: Step<number, number> = {
      name: "plain",
      reader: { read: async () => null },
      writer: { write: async () => undefined },
      chunkSize: 1,
    } as Step<number, number>;

    // @ts-expect-error A plain Step intentionally lacks the QStash idempotency contract and Checkpointable reader.
    await expect(harness.executor.executeChunk(execution.id, plainStep)).rejects.toMatchObject({
      code: "batch-qstash/missing-config",
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "rejects invalid chunk size %s before acquiring a claim or performing batch work",
    async (chunkSize) => {
      const harness = createHarness();
      const execution = await harness.createExecution();
      const claim = vi.spyOn(harness.manager, "claimContinuation");
      const stage = vi.spyOn(harness.manager, "stageContinuation");
      const complete = vi.spyOn(harness.manager, "completeContinuation");
      const reader = createCheckpointReader([1]);
      const writer = createWriter();

      await expect(
        harness.executor.executeChunk(execution.id, createStep(reader, writer, chunkSize)),
      ).rejects.toMatchObject({
        code: "batch-core/invalid-chunk-size",
        detail: `Batch step.chunkSize must be a positive safe integer; received ${String(chunkSize)}.`,
        receivedChunkSize: String(chunkSize),
      });

      expect(claim).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(reader.read).not.toHaveBeenCalled();
      expect(reader.getCheckpoint).not.toHaveBeenCalled();
      expect(reader.restoreCheckpoint).not.toHaveBeenCalled();
      expect(writer.write).not.toHaveBeenCalled();
      expect(writer.writeIdempotent).not.toHaveBeenCalled();
      expect(harness.publishJSON).not.toHaveBeenCalled();
    },
  );

  it.each(["", "   ", "\t\n"])(
    "rejects a blank step name %j before claiming execution state",
    async (name) => {
      const harness = createHarness();
      const execution = await harness.createExecution();
      const claim = vi.spyOn(harness.manager, "claimContinuation");
      const reader = createCheckpointReader([1]);
      const writer = createWriter();

      await expect(
        harness.executor.executeChunk(execution.id, {
          ...createStep(reader, writer),
          name,
        }),
      ).rejects.toMatchObject({ code: "batch-core/invalid-step-name" });

      expect(claim).not.toHaveBeenCalled();
      expect(reader.read).not.toHaveBeenCalled();
      expect(reader.getCheckpoint).not.toHaveBeenCalled();
      expect(reader.restoreCheckpoint).not.toHaveBeenCalled();
      expect(writer.write).not.toHaveBeenCalled();
      expect(writer.writeIdempotent).not.toHaveBeenCalled();
      expect(harness.publishJSON).not.toHaveBeenCalled();
    },
  );

  it("accepts the documented dual ItemWriter and QStash writer shape", () => {
    const writer: ItemWriter<number> & {
      writeIdempotent(items: number[], context: QStashIdempotentWriteContext): Promise<void>;
    } = createWriter();
    const step: QStashStep<number, number> = {
      name: "typed",
      reader: createCheckpointReader([]),
      writer,
      chunkSize: 1,
    };
    expect(step.writer.writeIdempotent).toBeTypeOf("function");
  });

  it("rejects a heartbeat interval that can occur at or after lease expiry", () => {
    expect(() => createHarness({ leaseDurationMs: 100, heartbeatIntervalMs: 100 })).toThrow(
      "heartbeatIntervalMs must be less than the execution continuation lease duration.",
    );
  });

  it("restores persisted cursor across reconstructed checkpoint readers for two deliveries", async () => {
    const harness = createHarness();
    const execution = await harness.createExecution();
    const writer = createWriter();

    const firstReader = createCheckpointReader([1, 2, 3]);
    const first = await harness.executor.executeChunk(
      execution.id,
      createStep(firstReader, writer, 2),
    );
    expect(first).toEqual({ hasMore: true, processedCount: 2 });

    const secondReader = createCheckpointReader([1, 2, 3]);
    const second = await harness.executor.executeChunk(
      execution.id,
      createStep(secondReader, writer, 2),
      { continuationToken: publishedToken(harness, 0) },
    );
    expect(second).toEqual({ hasMore: false, processedCount: 1 });
    expect(secondReader.restoreCheckpoint).toHaveBeenCalled();

    const completed = await harness.manager.get(execution.id);
    expect(completed).toMatchObject({ status: "completed", result: { processedCount: 3 } });
    expect(writer.writeIdempotent.mock.calls.map(([items]) => items)).toEqual([[1, 2], [3]]);
    expect(harness.publishJSON).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-checkpointable reader with the configuration Problem before any work", async () => {
    const harness = createHarness();
    const execution = await harness.createExecution();
    const claim = vi.spyOn(harness.manager, "claimContinuation");
    const plainReader = { read: vi.fn(async () => null) };
    const writer = createWriter();

    await expect(
      harness.executor.executeChunk(execution.id, {
        name: "numbers",
        reader: plainReader,
        writer,
        chunkSize: 1,
      } as unknown as QStashStep<number, number>),
    ).rejects.toMatchObject({
      code: "batch-qstash/missing-config",
      detail: expect.stringContaining("step.reader.checkpoint"),
    });
    expect(claim).not.toHaveBeenCalled();
    expect(plainReader.read).not.toHaveBeenCalled();
    expect(writer.writeIdempotent).not.toHaveBeenCalled();
    expect(harness.publishJSON).not.toHaveBeenCalled();
  });

  it("accepts a heartbeat interval below the configured continuation lease", () => {
    expect(() => createHarness({ leaseDurationMs: 100, heartbeatIntervalMs: 99 })).not.toThrow();
  });
});
