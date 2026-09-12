import { Problem, ProblemCategory } from "@croco/problems-core";
import { trace } from "@opentelemetry/api";
import type { Span, Tracer } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SagaDefinitionProblem,
  SagaExecutionFailedProblem,
  SagaFinalizationProblem,
  InMemorySagaStore,
  SagaListPaginationProblem,
  SagaRunner,
  type SagaDefinition,
  type SagaStore,
} from "../index";

class ProviderProblem extends Problem {
  constructor(detail: string) {
    super("workflow-core/test-provider-problem", ProblemCategory.InternalServerError, detail);
  }
}

class RetryableProviderProblem extends Problem {
  readonly retryable = true;

  constructor(detail: string) {
    super(
      "workflow-core/test-retryable-provider-problem",
      ProblemCategory.InternalServerError,
      detail,
    );
  }
}

class ExtensionRetryableProviderProblem extends Problem {
  constructor(detail: string, retryable?: boolean) {
    super(
      "workflow-core/test-extension-retryable-provider-problem",
      ProblemCategory.InternalServerError,
      detail,
      retryable === undefined ? undefined : { extensions: { retryable } },
    );
  }
}

class DualShapeRetryableProviderProblem extends Problem {
  constructor(
    detail: string,
    readonly retryable: boolean,
    extensionRetryable: boolean,
  ) {
    super(
      "workflow-core/test-dual-shape-retryable-provider-problem",
      ProblemCategory.InternalServerError,
      detail,
      { extensions: { retryable: extensionRetryable } },
    );
  }
}

class CompensationProblem extends Problem {
  constructor(detail: string) {
    super("workflow-core/test-compensation-problem", ProblemCategory.InternalServerError, detail);
  }
}

function getOrderId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("orderId" in payload)) {
    throw new ProviderProblem("orderId is required");
  }

  return String(payload.orderId);
}

function createGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {
    throw new ProviderProblem("gate was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function createMockSpan(): Span {
  return {
    spanContext: () => ({
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      traceFlags: 1,
      isRemote: false,
    }),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
    setStatus: vi.fn(),
    updateName: vi.fn(),
    end: vi.fn(),
    isRecording: vi.fn(() => true),
    recordException: vi.fn(),
  } as unknown as Span;
}

function createMockTracer(spanNames: string[], span: Span): Tracer {
  return {
    startActiveSpan: async <T>(name: string, fn: (span: Span) => T | Promise<T>) => {
      spanNames.push(name);
      return fn(span);
    },
    startSpan: () => span,
  } as Tracer;
}

describe("Saga Problems", () => {
  it("omits absent primary and compensation failure codes", () => {
    const problem = new SagaExecutionFailedProblem(
      "billing",
      "execution-1",
      { message: "charge failed", retryable: false },
      {
        status: "failed",
        compensationFailures: [{ message: "refund failed", retryable: true }],
      },
    );

    expect(problem.extensions).not.toHaveProperty("originalFailureCode");
    expect(problem.extensions?.compensationFailures).toEqual([
      { message: "refund failed", retryable: true },
    ]);
    expect(() => JSON.stringify(problem)).not.toThrow();
  });

  it("omits an absent finalization failure code", () => {
    const problem = new SagaFinalizationProblem(
      "billing",
      "execution-1",
      { message: "store unavailable", retryable: true },
      { status: "completing" },
    );

    expect(problem.extensions).not.toHaveProperty("originalFailureCode");
    expect(() => JSON.stringify(problem)).not.toThrow();
  });
});

describe("SagaRunner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid pagination before querying a configured store", async () => {
    const delegate = new InMemorySagaStore();
    const list = vi.fn((options) => delegate.list(options));
    const store: SagaStore = {
      create: (params) => delegate.create(params),
      findById: (id) => delegate.findById(id),
      findByIdempotencyKey: (sagaName, key) => delegate.findByIdempotencyKey(sagaName, key),
      update: (id, data) => delegate.update(id, data),
      list,
    };
    const runner = new SagaRunner(store);

    await expect(runner.listExecutions({ limit: 0 })).rejects.toThrow(SagaListPaginationProblem);
    expect(list).not.toHaveBeenCalled();
  });

  it("compensates completed steps in reverse order and keeps saga state queryable", async () => {
    const events: string[] = [];
    const publishedMessages: string[] = [];
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "subscription-seat-change",
      idempotencyKey: ({ payload }) => `seat-change:${getOrderId(payload)}`,
      outbox: {
        publish: (message) => {
          publishedMessages.push(`${message.stepId}:${message.topic}:${message.idempotencyKey}`);
        },
      },
      steps: [
        {
          id: "reserve-payment",
          idempotencyKey: ({ stepInput }) => `payment:${getOrderId(stepInput)}`,
          run: (input, { enqueueOutbox }) => {
            events.push("reserve-payment");
            enqueueOutbox({
              id: "payment-reserved",
              topic: "billing.reserved",
              payload: { orderId: getOrderId(input) },
              idempotencyKey: `outbox:${getOrderId(input)}`,
            });
            return { paymentId: "pay_123", orderId: getOrderId(input) };
          },
          compensate: (input, { enqueueOutbox }) => {
            events.push(`refund-payment:${getOrderId(input)}`);
            enqueueOutbox({
              id: "payment-refunded",
              topic: "billing.refunded",
              payload: { orderId: getOrderId(input) },
              idempotencyKey: `refund:${getOrderId(input)}`,
            });
            return { refunded: getOrderId(input) };
          },
        },
        {
          id: "provision-seat",
          input: ({ previousResults }) => previousResults[0]?.result,
          run: (input) => {
            events.push("provision-seat");
            return { seatId: "seat_123", orderId: getOrderId(input) };
          },
          compensate: (input, { enqueueOutbox }) => {
            events.push(`remove-seat:${getOrderId(input)}`);
            enqueueOutbox({
              id: "seat-removed",
              topic: "seats.removed",
              payload: { orderId: getOrderId(input) },
              idempotencyKey: `remove-seat:${getOrderId(input)}`,
            });
            return { removed: getOrderId(input) };
          },
        },
        {
          id: "notify-customer",
          run: () => {
            throw new ProviderProblem("notification provider unavailable");
          },
        },
      ],
    };

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaExecutionFailedProblem,
    );

    const [failedExecution] = await runner.listExecutions({ sagaName: definition.name });

    expect(publishedMessages).toEqual([
      "provision-seat:seats.removed:remove-seat:ord_123",
      "reserve-payment:billing.refunded:refund:ord_123",
    ]);
    expect(
      failedExecution.steps.flatMap((step) => step.outboxMessages).map((message) => message.status),
    ).toEqual(["pending", "published", "published"]);

    await runner.dispatchOutbox(definition, failedExecution.id);
    const execution = await runner.getExecution(failedExecution.id);
    const queried = await runner.getExecution(execution.id);

    expect(queried).toBe(execution);
    expect(execution.status).toBe("compensated");
    expect(execution.error).toEqual(
      expect.objectContaining({
        code: "workflow-core/test-provider-problem",
        message: "notification provider unavailable",
      }),
    );
    expect(execution.compensationFailures).toEqual([]);
    expect(events).toEqual([
      "reserve-payment",
      "provision-seat",
      "remove-seat:ord_123",
      "refund-payment:ord_123",
    ]);
    expect(publishedMessages).toEqual([
      "provision-seat:seats.removed:remove-seat:ord_123",
      "reserve-payment:billing.refunded:refund:ord_123",
    ]);
    expect(execution.steps).toEqual([
      expect.objectContaining({
        id: "reserve-payment",
        status: "compensated",
        attempts: 1,
        maxAttempts: 1,
        idempotencyKey: "payment:ord_123",
        outboxMessages: expect.arrayContaining([
          expect.objectContaining({
            topic: "billing.reserved",
            stepId: "reserve-payment",
            idempotencyKey: "outbox:ord_123",
            phase: "step",
            status: "pending",
          }),
          expect.objectContaining({
            topic: "billing.refunded",
            stepId: "reserve-payment",
            idempotencyKey: "refund:ord_123",
            phase: "compensation",
            status: "published",
          }),
        ]),
      }),
      expect.objectContaining({
        id: "provision-seat",
        status: "compensated",
        attempts: 1,
        result: { seatId: "seat_123", orderId: "ord_123" },
      }),
      expect.objectContaining({
        id: "notify-customer",
        status: "failed",
        attempts: 1,
        error: expect.objectContaining({
          message: "notification provider unavailable",
        }),
      }),
    ]);

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaExecutionFailedProblem,
    );
    expect(events).toEqual([
      "reserve-payment",
      "provision-seat",
      "remove-seat:ord_123",
      "refund-payment:ord_123",
    ]);
    await expect(runner.listExecutions({ sagaName: definition.name })).resolves.toHaveLength(1);
  });

  it("persists completed outbox intent before dispatch and recovers an ambiguous publish", async () => {
    const store = new InMemorySagaStore();
    const deliveredEffects = new Set<string>();
    const publishAttempts: string[] = [];
    let failAfterDelivery = true;
    const definition: SagaDefinition = {
      name: "durable-outbox-boundary",
      idempotencyKey: () => "durable-outbox-boundary:ord_123",
      outbox: {
        publish: async (message, context) => {
          const persisted = await store.findById(context.executionId);
          const persistedMessage = persisted?.steps
            .find((step) => step.id === context.step.id)
            ?.outboxMessages.find((candidate) => candidate.deliveryId === message.deliveryId);

          expect(persisted?.steps.find((step) => step.id === context.step.id)?.status).toBe(
            "completed",
          );
          expect(persistedMessage).toEqual(
            expect.objectContaining({
              deliveryId: message.deliveryId,
              status: "pending",
            }),
          );

          publishAttempts.push(message.deliveryId);
          deliveredEffects.add(message.deliveryId);
          if (failAfterDelivery) {
            failAfterDelivery = false;
            throw new ProviderProblem("publisher acknowledgement was lost");
          }
        },
      },
      steps: [
        {
          id: "reserve-payment",
          run: (_input, { enqueueOutbox }) => {
            enqueueOutbox({
              id: "payment-reserved",
              topic: "billing.reserved",
              payload: { orderId: "ord_123" },
            });
            return { paymentId: "pay_123" };
          },
        },
      ],
    };
    const runner = new SagaRunner(store);

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      "publisher acknowledgement was lost",
    );
    const [persisted] = await runner.listExecutions({ sagaName: definition.name });

    expect(persisted).toEqual(
      expect.objectContaining({
        status: "completed",
        steps: [
          expect.objectContaining({
            status: "completed",
            outboxMessages: [
              expect.objectContaining({
                status: "pending",
              }),
            ],
          }),
        ],
      }),
    );
    expect(persisted.steps[0]?.outboxMessages[0]).not.toHaveProperty("publishedAt");

    const recovered = await runner.execute(definition, { orderId: "ord_123" });
    const deliveryIds = publishAttempts;

    expect(recovered.reused).toBe(true);
    expect(deliveryIds).toHaveLength(2);
    expect(new Set(deliveryIds)).toEqual(new Set([deliveryIds[0]]));
    expect(deliveredEffects.size).toBe(1);
    expect(recovered.execution.steps[0]?.outboxMessages[0]).toEqual(
      expect.objectContaining({
        deliveryId: deliveryIds[0],
        status: "published",
        publishedAt: expect.any(String),
      }),
    );
  });

  it("does not publish or complete a step when completed intent persistence fails", async () => {
    const delegate = new InMemorySagaStore();
    let rejectCompletion = true;
    const store: SagaStore = {
      create: (params) => delegate.create(params),
      findById: (id) => delegate.findById(id),
      findByIdempotencyKey: (sagaName, key) => delegate.findByIdempotencyKey(sagaName, key),
      list: (options) => delegate.list(options),
      update: (id, data) => {
        if (rejectCompletion && data.steps?.some((step) => step.status === "completed")) {
          rejectCompletion = false;
          throw new ProviderProblem("completed intent persistence failed");
        }
        return delegate.update(id, data);
      },
    };
    const publish = vi.fn();
    const definition: SagaDefinition = {
      name: "failed-outbox-persistence",
      outbox: { publish },
      steps: [
        {
          id: "reserve-payment",
          run: (_input, { enqueueOutbox }) => {
            enqueueOutbox({
              id: "payment-reserved",
              topic: "billing.reserved",
              payload: { orderId: "ord_123" },
            });
            return { paymentId: "pay_123" };
          },
        },
      ],
    };
    const runner = new SagaRunner(store);

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaExecutionFailedProblem,
    );
    const [execution] = await runner.listExecutions({ sagaName: definition.name });

    expect(publish).not.toHaveBeenCalled();
    expect(execution.status).toBe("failed");
    expect(execution.steps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        outboxMessages: [],
      }),
    );
  });

  it("does not compensate successful steps when the final completed-status write fails", async () => {
    const delegate = new InMemorySagaStore();
    let rejectFinalWrite = true;
    const store: SagaStore = {
      create: (params) => delegate.create(params),
      findById: (id) => delegate.findById(id),
      findByIdempotencyKey: (sagaName, key) => delegate.findByIdempotencyKey(sagaName, key),
      list: (options) => delegate.list(options),
      update: (id, data) => {
        if (rejectFinalWrite && data.status === "completed") {
          rejectFinalWrite = false;
          throw new ProviderProblem("completion store unavailable");
        }
        return delegate.update(id, data);
      },
    };
    const effects: string[] = [];
    const definition: SagaDefinition = {
      name: "finalization-store-failure",
      steps: [
        {
          id: "charge",
          run: () => {
            effects.push("charge");
            return { charged: true };
          },
          compensate: () => {
            effects.push("refund");
            return { refunded: true };
          },
        },
      ],
    };
    const runner = new SagaRunner(store);

    const problem = await runner.execute(definition, {}).catch((error: unknown) => error);

    expect(problem).toBeInstanceOf(SagaFinalizationProblem);
    expect(problem).toHaveProperty("code", "workflow-core/saga-finalization-failed");
    expect(effects).toEqual(["charge"]);
    const [execution] = await runner.listExecutions({ sagaName: definition.name });
    expect(execution.status).toBe("completing");
    expect(execution.steps[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        result: { charged: true },
      }),
    );
  });

  it("finalizes a completion-failed saga on idempotent retry without rerunning steps", async () => {
    const delegate = new InMemorySagaStore();
    let rejectFinalWrite = true;
    const store: SagaStore = {
      create: (params) => delegate.create(params),
      findById: (id) => delegate.findById(id),
      findByIdempotencyKey: (sagaName, key) => delegate.findByIdempotencyKey(sagaName, key),
      list: (options) => delegate.list(options),
      update: (id, data) => {
        if (rejectFinalWrite && data.status === "completed") {
          rejectFinalWrite = false;
          throw new ProviderProblem("completion store unavailable");
        }
        return delegate.update(id, data);
      },
    };
    const effects: string[] = [];
    const definition: SagaDefinition = {
      name: "finalization-idempotent-retry",
      idempotencyKey: ({ payload }) => `finalization-retry:${getOrderId(payload)}`,
      steps: [
        {
          id: "charge",
          run: () => {
            effects.push("charge");
            return { charged: true };
          },
          compensate: () => {
            effects.push("refund");
            return { refunded: true };
          },
        },
      ],
    };
    const runner = new SagaRunner(store);

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaFinalizationProblem,
    );

    const retried = await runner.execute(definition, { orderId: "ord_123" });

    expect(effects).toEqual(["charge"]);
    expect(retried.reused).toBe(true);
    expect(retried.execution.status).toBe("completed");
    expect(retried.result).toEqual({
      sagaName: "finalization-idempotent-retry",
      steps: [{ stepId: "charge", result: { charged: true } }],
    });
    const [execution] = await runner.listExecutions({ sagaName: definition.name });
    expect(execution.status).toBe("completed");
  });

  it("keeps successful steps durable when the completing marker itself fails", async () => {
    const delegate = new InMemorySagaStore();
    const store: SagaStore = {
      create: (params) => delegate.create(params),
      findById: (id) => delegate.findById(id),
      findByIdempotencyKey: (sagaName, key) => delegate.findByIdempotencyKey(sagaName, key),
      list: (options) => delegate.list(options),
      update: (id, data) => {
        if (data.status === "completing" || data.status === "completed") {
          throw new ProviderProblem("completion store unavailable");
        }
        return delegate.update(id, data);
      },
    };
    const effects: string[] = [];
    const definition: SagaDefinition = {
      name: "completing-marker-failure",
      steps: [
        {
          id: "charge",
          run: () => {
            effects.push("charge");
            return { charged: true };
          },
          compensate: () => {
            effects.push("refund");
            return { refunded: true };
          },
        },
      ],
    };
    const runner = new SagaRunner(store);

    await expect(runner.execute(definition, {})).rejects.toThrow(SagaFinalizationProblem);

    expect(effects).toEqual(["charge"]);
    const [execution] = await runner.listExecutions({ sagaName: definition.name });
    expect(execution.status).toBe("running");
    expect(execution.steps[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        result: { charged: true },
      }),
    );
  });

  it("retains deterministic outbox delivery identity across replay", async () => {
    const deliveryIds: string[] = [];
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "deterministic-replay-outbox",
      outbox: {
        publish: (message) => {
          deliveryIds.push(message.deliveryId);
        },
      },
      steps: [
        {
          id: "reserve-payment",
          run: (_input, { enqueueOutbox }) => {
            enqueueOutbox({
              id: "payment-reserved",
              topic: "billing.reserved",
              payload: { orderId: "ord_123" },
            });
            return { paymentId: "pay_123" };
          },
          compensate: (_input, { enqueueOutbox }) => {
            enqueueOutbox({
              id: "payment-refunded",
              topic: "billing.refunded",
              payload: { orderId: "ord_123" },
            });
            return { refunded: true };
          },
        },
        {
          id: "provision-seat",
          run: () => {
            throw new ProviderProblem("seat provider unavailable");
          },
        },
      ],
    };

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaExecutionFailedProblem,
    );
    const [failed] = await runner.listExecutions({ sagaName: definition.name });
    await runner.dispatchOutbox(definition, failed.id);

    await expect(runner.replay(definition, failed.id)).rejects.toThrow(SagaExecutionFailedProblem);
    const [replayed] = await runner.listExecutions({ replayOf: failed.id });
    await runner.dispatchOutbox(definition, replayed.id);

    expect(replayed.status).toBe("compensated");
    expect(deliveryIds).toHaveLength(2);
    expect(new Set(deliveryIds).size).toBe(1);
    expect(replayed.steps[0]?.outboxMessages.map((message) => message.deliveryId)).toEqual(
      failed.steps[0]?.outboxMessages.map((message) => message.deliveryId),
    );
  });

  it("records compensation failures separately from the original step failure", async () => {
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "compensation-failure",
      steps: [
        {
          id: "create-payment",
          run: () => ({ paymentId: "pay_123" }),
          compensate: () => {
            throw new CompensationProblem("refund provider unavailable");
          },
        },
        {
          id: "provision-seat",
          run: () => {
            throw new ProviderProblem("seat provider unavailable");
          },
        },
      ],
    };

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaExecutionFailedProblem,
    );

    const [execution] = await runner.listExecutions({ sagaName: definition.name });

    expect(execution.status).toBe("failed");
    expect(execution.error).toEqual(
      expect.objectContaining({
        code: "workflow-core/test-provider-problem",
        message: "seat provider unavailable",
      }),
    );
    expect(execution.compensationFailures).toEqual([
      expect.objectContaining({
        code: "workflow-core/test-compensation-problem",
        message: "refund provider unavailable",
      }),
    ]);
    expect(execution.steps).toEqual([
      expect.objectContaining({
        id: "create-payment",
        status: "compensation_failed",
        compensationError: expect.objectContaining({
          message: "refund provider unavailable",
        }),
      }),
      expect.objectContaining({
        id: "provision-seat",
        status: "failed",
        error: expect.objectContaining({
          message: "seat provider unavailable",
        }),
      }),
    ]);
  });

  it.each([
    ["compensation bookkeeping", "compensating", "failed", undefined],
    [
      "compensation failure recording",
      "compensation_failed",
      "failed",
      "refund provider unavailable",
    ],
    ["terminal failure-state recording", "terminal", "compensated", undefined],
  ] as const)(
    "preserves the original saga failure when %s rejects",
    async (_failureKind, failurePoint, expectedStatus, compensationFailureMessage) => {
      const delegate = new InMemorySagaStore();
      const sagaFailure = new ProviderProblem("seat provider unavailable");
      const failureRecordError = new ProviderProblem("saga failure store unavailable");
      const compensationFailure =
        compensationFailureMessage === undefined
          ? undefined
          : new CompensationProblem(compensationFailureMessage);
      const store: SagaStore = {
        create: (params) => delegate.create(params),
        findById: (id) => delegate.findById(id),
        findByIdempotencyKey: (sagaName, key) => delegate.findByIdempotencyKey(sagaName, key),
        list: (options) => delegate.list(options),
        update: (id, data) => {
          const shouldReject =
            failurePoint === "terminal"
              ? data.status === "compensated"
              : data.steps?.some((step) => step.status === failurePoint);
          if (shouldReject) {
            throw failureRecordError;
          }

          return delegate.update(id, data);
        },
      };
      const mockSpan = createMockSpan();
      vi.spyOn(trace, "getTracer").mockReturnValue(createMockTracer([], mockSpan));
      const definition: SagaDefinition = {
        name: `failure-record-${failurePoint}`,
        steps: [
          {
            id: "reserve-payment",
            run: () => ({ paymentId: "pay_123" }),
            compensate: () => {
              if (compensationFailure !== undefined) {
                throw compensationFailure;
              }

              return { refunded: true };
            },
          },
          {
            id: "provision-seat",
            run: () => {
              throw sagaFailure;
            },
          },
        ],
      };
      const runner = new SagaRunner(store);

      const problem = await runner.execute(definition, {}).catch((error: unknown) => error);

      expect(problem).toBeInstanceOf(SagaExecutionFailedProblem);
      expect(problem).toMatchObject({
        code: "workflow-core/saga-execution-failed",
        extensions: {
          originalFailureCode: sagaFailure.code,
          originalFailureMessage: sagaFailure.message,
          sagaStatus: expectedStatus,
          compensationFailures:
            compensationFailure === undefined
              ? []
              : [
                  {
                    code: compensationFailure.code,
                    message: compensationFailure.message,
                    retryable: false,
                  },
                ],
        },
      });
      expect(Object.getOwnPropertyDescriptor(problem, "sagaFailureRecordError")).toEqual({
        configurable: true,
        enumerable: false,
        value: failureRecordError,
        writable: false,
      });
      expect(mockSpan.addEvent).toHaveBeenCalledWith("saga.execution.failure_record.failed", {
        "saga.name": definition.name,
        "saga.execution.id": "saga-1",
        "saga.error.message": sagaFailure.message,
        "saga.failure_record.error.message": failureRecordError.message,
      });
    },
  );

  it("records exhausted retry attempts and step idempotency keys", async () => {
    let attempts = 0;
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "retry-exhaustion",
      idempotencyKey: ({ payload }) => `retry-exhaustion:${getOrderId(payload)}`,
      steps: [
        {
          id: "charge-provider",
          retry: { maxAttempts: 2 },
          idempotencyKey: ({ executionId, stepInput }) =>
            `charge:${executionId}:${getOrderId(stepInput)}`,
          run: () => {
            attempts += 1;
            throw new RetryableProviderProblem("payment provider retryable outage");
          },
        },
      ],
    };

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaExecutionFailedProblem,
    );

    const [execution] = await runner.listExecutions({ sagaName: definition.name });

    expect(attempts).toBe(2);
    expect(execution.status).toBe("failed");
    expect(execution.steps).toEqual([
      expect.objectContaining({
        id: "charge-provider",
        status: "failed",
        attempts: 2,
        maxAttempts: 2,
        idempotencyKey: `charge:${execution.id}:ord_123`,
        error: expect.objectContaining({
          retryable: true,
          message: "payment provider retryable outage",
        }),
      }),
    ]);

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaExecutionFailedProblem,
    );
    expect(attempts).toBe(2);
    await expect(runner.listExecutions({ sagaName: definition.name })).resolves.toHaveLength(1);
  });

  it("retries Problems marked retryable through extensions", async () => {
    let attempts = 0;
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "problem-extension-retry",
      steps: [
        {
          id: "charge-provider",
          retry: { maxAttempts: 2 },
          run: () => {
            attempts += 1;
            if (attempts === 1) {
              throw new ExtensionRetryableProviderProblem(
                "payment provider retryable outage",
                true,
              );
            }
            return "charged";
          },
        },
      ],
    };

    const result = await runner.execute(definition, {});

    expect(attempts).toBe(2);
    expect(result.execution.status).toBe("completed");
    expect(result.steps).toEqual([{ stepId: "charge-provider", result: "charged" }]);
  });

  it("records extension retryability when Problem retries are exhausted", async () => {
    let attempts = 0;
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "problem-extension-retry-exhaustion",
      steps: [
        {
          id: "charge-provider",
          retry: { maxAttempts: 2 },
          run: () => {
            attempts += 1;
            throw new ExtensionRetryableProviderProblem("payment provider retryable outage", true);
          },
        },
      ],
    };

    await expect(runner.execute(definition, {})).rejects.toMatchObject({
      extensions: expect.objectContaining({ retryable: true }),
    });

    const [execution] = await runner.listExecutions({ sagaName: definition.name });
    expect(attempts).toBe(2);
    expect(execution.error).toEqual(expect.objectContaining({ retryable: true }));
    expect(execution.steps[0]?.error).toEqual(expect.objectContaining({ retryable: true }));
  });

  it.each([
    { extensionRetryable: true, retryable: false, expectedAttempts: 1 },
    { extensionRetryable: false, retryable: true, expectedAttempts: 2 },
  ])(
    "prefers top-level retryable=$retryable over extension retryable=$extensionRetryable",
    async ({ extensionRetryable, retryable, expectedAttempts }) => {
      let attempts = 0;
      const runner = new SagaRunner();
      const definition: SagaDefinition = {
        name: `problem-retry-precedence-${String(retryable)}`,
        steps: [
          {
            id: "charge-provider",
            retry: { maxAttempts: 2 },
            run: () => {
              attempts += 1;
              if (attempts < 2 || !retryable) {
                throw new DualShapeRetryableProviderProblem(
                  "payment provider outage",
                  retryable,
                  extensionRetryable,
                );
              }
              return "charged";
            },
          },
        ],
      };

      if (retryable) {
        await expect(runner.execute(definition, {})).resolves.toMatchObject({
          execution: { status: "completed" },
        });
      } else {
        await expect(runner.execute(definition, {})).rejects.toThrow(SagaExecutionFailedProblem);
      }
      expect(attempts).toBe(expectedAttempts);
    },
  );

  it.each([false, undefined])(
    "does not retry Problems without an affirmative retryable extension (%s)",
    async (retryable) => {
      let attempts = 0;
      const runner = new SagaRunner();
      const definition: SagaDefinition = {
        name: `problem-extension-non-retry-${String(retryable)}`,
        steps: [
          {
            id: "charge-provider",
            retry: { maxAttempts: 2 },
            run: () => {
              attempts += 1;
              throw new ExtensionRetryableProviderProblem(
                "payment provider non-retryable outage",
                retryable,
              );
            },
          },
        ],
      };

      await expect(runner.execute(definition, {})).rejects.toThrow(SagaExecutionFailedProblem);
      expect(attempts).toBe(1);
    },
  );

  it("scopes saga idempotency keys by saga name", async () => {
    const events: string[] = [];
    const runner = new SagaRunner();
    const firstDefinition: SagaDefinition = {
      name: "first-saga",
      idempotencyKey: () => "shared-idempotency-key",
      steps: [
        {
          id: "first-step",
          run: () => {
            events.push("first");
            return { saga: "first" };
          },
        },
      ],
    };
    const secondDefinition: SagaDefinition = {
      name: "second-saga",
      idempotencyKey: () => "shared-idempotency-key",
      steps: [
        {
          id: "second-step",
          run: () => {
            events.push("second");
            return { saga: "second" };
          },
        },
      ],
    };

    const first = await runner.execute(firstDefinition, {});
    const second = await runner.execute(secondDefinition, {});

    expect(first.executionId).not.toBe(second.executionId);
    expect(events).toEqual(["first", "second"]);
    await expect(runner.listExecutions()).resolves.toHaveLength(2);
  });

  it.each(["concurrent-key", ""])(
    "rejects the losing create race for idempotency key %j without duplicate side effects",
    async (idempotencyKey) => {
      const gate = createGate();
      const store = new InMemorySagaStore();
      const create = vi.spyOn(store, "create");
      const run = vi.fn(async () => {
        await gate.promise;
        return { handled: true };
      });
      const runner = new SagaRunner(store);
      const definition: SagaDefinition = {
        name: "concurrent-idempotency",
        idempotencyKey,
        steps: [{ id: "slow-provider-call", run }],
      };

      const first = runner.execute(definition, {});
      const second = expect(runner.execute(definition, {})).rejects.toMatchObject({
        code: "workflow-core/saga-execution-in-flight",
        category: ProblemCategory.Conflict,
        extensions: {
          sagaName: definition.name,
          executionId: expect.any(String),
          sagaStatus: "pending",
          retryable: true,
        },
      });
      try {
        await second;
      } finally {
        gate.release();
        await first;
      }

      const result = await first;
      const executions = await runner.listExecutions({ sagaName: definition.name });
      expect(result.execution.status).toBe("completed");
      expect(result.reused).toBe(false);
      expect(create).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenCalledTimes(1);
      expect(executions).toHaveLength(1);
      expect(executions[0]?.idempotencyKey).toBe(idempotencyKey);
    },
  );

  it("rejects running reuse without dispatching outbox messages", async () => {
    const gate = createGate();
    const started = createGate();
    const publish = vi.fn();
    const run = vi.fn(async (_input, { enqueueOutbox }) => {
      enqueueOutbox({ id: "payment-reserved", topic: "billing.reserved", payload: {} });
      started.release();
      await gate.promise;
      return { paymentId: "pay_123" };
    });
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "concurrent-outbox-reuse",
      idempotencyKey: "concurrent-outbox-reuse:ord_123",
      outbox: { publish },
      steps: [{ id: "reserve-payment", run }],
    };

    const primary = runner.execute(definition, {});
    try {
      await started.promise;
      const [running] = await runner.listExecutions({ sagaName: definition.name });
      await expect(runner.execute(definition, {})).rejects.toMatchObject({
        code: "workflow-core/saga-execution-in-flight",
        category: ProblemCategory.Conflict,
        extensions: {
          sagaName: definition.name,
          executionId: running.id,
          sagaStatus: "running",
          retryable: true,
        },
      });
      expect(publish).not.toHaveBeenCalled();
      await expect(runner.dispatchOutbox(definition, running.id)).rejects.toThrow(
        "cannot dispatch outbox messages while 'running'",
      );
    } finally {
      gate.release();
      await primary;
    }
    expect((await primary).execution.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "running"] as const)(
    "rejects a stored %s execution without mutation or success reuse telemetry",
    async (status) => {
      const store = new InMemorySagaStore();
      const execution = await store.create({
        sagaName: "stored-in-flight",
        payload: {},
        idempotencyKey: "key",
      });
      await store.update(execution.id, { status });
      const before = structuredClone(await store.findById(execution.id));
      const update = vi.spyOn(store, "update");
      const create = vi.spyOn(store, "create");
      const span = createMockSpan();
      vi.spyOn(trace, "getTracer").mockReturnValue(createMockTracer([], span));
      const run = vi.fn();
      const publish = vi.fn();
      const runner = new SagaRunner(store);
      const definition: SagaDefinition = {
        name: execution.sagaName,
        idempotencyKey: "key",
        outbox: { publish },
        steps: [{ id: "step", run }],
      };

      await expect(runner.execute(definition, {})).rejects.toMatchObject({
        code: "workflow-core/saga-execution-in-flight",
        category: ProblemCategory.Conflict,
        extensions: {
          sagaName: execution.sagaName,
          executionId: execution.id,
          sagaStatus: status,
          retryable: true,
        },
      });
      expect(await store.findById(execution.id)).toEqual(before);
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(span.setAttribute).not.toHaveBeenCalledWith("saga.reused", true);
      expect(span.addEvent).not.toHaveBeenCalledWith("saga.execution.reused", expect.anything());
    },
  );

  it("rejects reuse while real compensation is paused without repeating effects", async () => {
    const gate = createGate();
    const started = createGate();
    const reserve = vi.fn(() => "reserved");
    const compensate = vi.fn(async () => {
      started.release();
      await gate.promise;
    });
    const fail = vi.fn(() => {
      throw new ProviderProblem("provider failed");
    });
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "compensating-reuse",
      idempotencyKey: "key",
      steps: [
        { id: "reserve", run: reserve, compensate },
        { id: "fail", run: fail },
      ],
    };
    const primary = expect(runner.execute(definition, {})).rejects.toThrow(
      SagaExecutionFailedProblem,
    );
    try {
      await started.promise;
      const [execution] = await runner.listExecutions({ sagaName: definition.name });
      expect(execution.status).toBe("running");
      expect(execution.steps[0]?.status).toBe("compensating");
      await expect(runner.execute(definition, {})).rejects.toMatchObject({
        code: "workflow-core/saga-execution-in-flight",
        category: ProblemCategory.Conflict,
        extensions: {
          sagaName: definition.name,
          executionId: execution.id,
          sagaStatus: "running",
          retryable: true,
        },
      });
    } finally {
      gate.release();
      await primary;
    }
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(compensate).toHaveBeenCalledTimes(1);
    const [execution] = await runner.listExecutions({ sagaName: definition.name });
    expect(execution.status).toBe("compensated");
  });

  it("reuses completed execution results without rerunning steps", async () => {
    const run = vi.fn(() => ({ paymentId: "pay_123" }));
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "completed-reuse",
      idempotencyKey: "key",
      steps: [{ id: "charge", run }],
    };
    const first = await runner.execute(definition, {});
    await expect(runner.execute(definition, {})).resolves.toMatchObject({
      executionId: first.executionId,
      execution: { status: "completed" },
      steps: first.steps,
      result: first.result,
      reused: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "compensated"] as const)(
    "preserves stored %s execution failure on reuse",
    async (status) => {
      const store = new InMemorySagaStore();
      const execution = await store.create({
        sagaName: "stored-failure",
        payload: {},
        idempotencyKey: "key",
      });
      await store.update(execution.id, {
        status,
        error: { message: "provider failed", code: "provider/failure", retryable: false },
      });
      const run = vi.fn();
      const runner = new SagaRunner(store);
      const definition: SagaDefinition = {
        name: execution.sagaName,
        idempotencyKey: "key",
        steps: [{ id: "charge", run }],
      };
      await expect(runner.execute(definition, {})).rejects.toMatchObject({
        code: "workflow-core/saga-execution-failed",
        extensions: expect.objectContaining({
          sagaStatus: status,
          originalFailureCode: "provider/failure",
          retryable: false,
        }),
      });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("replays a failed saga execution without durable adapter dependencies", async () => {
    let providerRecovered = false;
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "replayable-seat-change",
      steps: [
        {
          id: "provision-seat",
          run: (input) => {
            if (!providerRecovered) {
              throw new ProviderProblem("seat provider unavailable");
            }

            return { provisioned: getOrderId(input) };
          },
        },
      ],
    };

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaExecutionFailedProblem,
    );
    const [failedExecution] = await runner.listExecutions({ sagaName: definition.name });
    providerRecovered = true;

    const replayed = await runner.replay(definition, failedExecution.id, {
      reason: "provider recovered",
    });
    const executions = await runner.listExecutions({ sagaName: definition.name });
    const originalExecutions = await runner.listExecutions({ replayOf: null });
    const replayExecutions = await runner.listExecutions({ replayOf: failedExecution.id });

    expect(replayed.execution).toEqual(
      expect.objectContaining({
        status: "completed",
        replayOf: failedExecution.id,
        metadata: expect.objectContaining({
          replayOf: failedExecution.id,
          replayReason: "provider recovered",
        }),
      }),
    );
    expect(replayed.steps).toEqual([
      {
        stepId: "provision-seat",
        result: { provisioned: "ord_123" },
      },
    ]);
    expect(executions).toHaveLength(2);
    expect(originalExecutions).toEqual([failedExecution]);
    expect(replayExecutions).toEqual([replayed.execution]);
  });

  it("rejects replay for completed saga executions", async () => {
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "completed-replay-rejection",
      steps: [
        {
          id: "complete-step",
          run: () => ({ completed: true }),
        },
      ],
    };

    const completed = await runner.execute(definition, {});

    await expect(runner.replay(definition, completed.executionId)).rejects.toThrow(
      "execution in 'completed' status is not replayable",
    );
    await expect(runner.listExecutions({ sagaName: definition.name })).resolves.toHaveLength(1);
  });

  it("records input resolver failures as failed step state before compensation", async () => {
    const events: string[] = [];
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "resolver-failure",
      steps: [
        {
          id: "reserve-payment",
          run: () => {
            events.push("reserve-payment");
            return { paymentId: "pay_123" };
          },
          compensate: () => {
            events.push("refund-payment");
            return { refunded: true };
          },
        },
        {
          id: "derive-seat-input",
          input: () => {
            throw new ProviderProblem("seat input could not be derived");
          },
          run: () => ({ unreachable: true }),
        },
      ],
    };

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaExecutionFailedProblem,
    );

    const [execution] = await runner.listExecutions({ sagaName: definition.name });

    expect(events).toEqual(["reserve-payment", "refund-payment"]);
    expect(execution.status).toBe("compensated");
    expect(execution.steps).toEqual([
      expect.objectContaining({
        id: "reserve-payment",
        status: "compensated",
      }),
      expect.objectContaining({
        id: "derive-seat-input",
        status: "failed",
        attempts: 0,
        input: undefined,
        error: expect.objectContaining({
          message: "seat input could not be derived",
        }),
      }),
    ]);
  });

  it("emits telemetry spans for saga steps and compensation steps", async () => {
    const spanNames: string[] = [];
    vi.spyOn(trace, "getTracer").mockReturnValue(createMockTracer(spanNames, createMockSpan()));

    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "telemetry-saga",
      steps: [
        {
          id: "reserve-payment",
          run: () => ({ paymentId: "pay_123" }),
          compensate: () => ({ refunded: true }),
        },
        {
          id: "fail-after-payment",
          run: () => {
            throw new ProviderProblem("provider unavailable");
          },
        },
      ],
    };

    await expect(runner.execute(definition, { orderId: "ord_123" })).rejects.toThrow(
      SagaExecutionFailedProblem,
    );

    expect(spanNames).toEqual(
      expect.arrayContaining([
        "saga:telemetry-saga",
        "saga:telemetry-saga:step:reserve-payment",
        "saga:telemetry-saga:step:fail-after-payment",
        "saga:telemetry-saga:compensate:reserve-payment",
      ]),
    );
  });

  it("rejects invalid saga definitions before creating execution state", async () => {
    const runner = new SagaRunner();
    const definition: SagaDefinition = {
      name: "invalid-saga",
      steps: [
        {
          id: "duplicate",
          run: () => undefined,
        },
        {
          id: "duplicate",
          run: () => undefined,
        },
      ],
    };

    await expect(runner.execute(definition, {})).rejects.toThrow(SagaDefinitionProblem);
    await expect(runner.listExecutions()).resolves.toEqual([]);
  });
});
