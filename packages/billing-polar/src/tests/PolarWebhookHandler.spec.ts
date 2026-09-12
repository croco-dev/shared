import type {
  BillingStore,
  CommitBillingSubscriptionWebhookInput,
  PlanRegistry,
  PlanVersionDefinition,
  Subscription,
} from "@croco/billing-core";
import {
  InMemoryBillingStore,
  PlanChangedEvent,
  planVersionRef,
  SubscriptionPastDueEvent,
  UnknownProviderPlanMappingProblem,
  WebhookAlreadyProcessedProblem,
} from "@croco/billing-core";
import type { EventPublisher } from "@croco/events-core";
import { createBillingProviderConformanceSuite } from "@croco/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolarWebhookHandler } from "../libs/PolarWebhookHandler";
import type { WebhookDependencies } from "../libs/PolarWebhookHandler";
import { WebhookProcessingProblem } from "../libs/problems/WebhookProcessingProblem";
import { WebhookValidationProblem } from "../libs/problems/WebhookValidationProblem";
import { PolarOrderDataSchema } from "../libs/schemas/polarWebhookSchema";
import type { PolarConfig } from "../types";

function createMockStore(): BillingStore {
  const transitions = new Map<
    string,
    Awaited<ReturnType<BillingStore["commitSubscriptionWebhook"]>>
  >();
  const store: BillingStore = {
    findAccountByTenantId: vi.fn(),
    findAccountByExternalId: vi.fn(),
    saveAccount: vi.fn(),
    deleteAccount: vi.fn(),
    findSubscription: vi.fn(),
    findSubscriptionByExternalId: vi.fn(),
    saveSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    reconcileLifecycleSubscription: vi.fn(),
    createLifecycleCommand: vi.fn(),
    findLifecycleCommand: vi.fn(),
    findPendingLifecycleCommandByTenantId: vi.fn(),
    resolveLifecycleSubscription: vi.fn(),
    claimLifecycleEventDelivery: vi.fn(),
    saveLifecycleCommand: vi.fn(),
    listPendingLifecycleCommands: vi.fn(),
    saveOrder: vi.fn(),
    findOrdersByAccount: vi.fn(),
    commitSubscriptionWebhook: vi.fn(async (input: CommitBillingSubscriptionWebhookInput) => {
      const existing = transitions.get(input.eventId);
      if (existing) return existing;
      await store.reserveWebhook(input.eventId, input.eventType);
      const previousSubscription = await store.findSubscription(
        input.subscription.billingAccountId,
      );
      try {
        const transition = {
          eventId: input.eventId,
          eventType: input.eventType,
          previousSubscription,
          subscription: input.subscription,
          intents: input.createEventIntents(previousSubscription).map((event) => ({
            event,
            publishedAt: null,
          })),
          state: "pending" as const,
        };
        await store.saveSubscription(input.subscription);
        if (input.clearWebhookReservationId) {
          await store.failWebhook(input.clearWebhookReservationId);
        }
        transitions.set(input.eventId, transition);
        return transition;
      } catch (error) {
        if (previousSubscription) {
          await store.saveSubscription(previousSubscription);
        }
        await store.failWebhook(input.eventId);
        throw error;
      }
    }),
    markWebhookEventIntentPublished: vi.fn(async (eventId, intentEventId) => {
      const transition = transitions.get(eventId);
      if (!transition) return;
      transitions.set(eventId, {
        ...transition,
        intents: transition.intents.map((intent) =>
          intent.event.eventId === intentEventId ? { ...intent, publishedAt: new Date() } : intent,
        ),
      });
    }),
    claimWebhookDelivery: vi.fn(async (eventId, eventType) => {
      try {
        await store.reserveWebhook(eventId, eventType);
        return { status: "claimed" as const, token: eventId };
      } catch (error) {
        if (error instanceof WebhookAlreadyProcessedProblem) {
          return { status: "completed" as const };
        }
        throw error;
      }
    }),
    completeWebhookDelivery: vi.fn(async (eventId) => {
      await store.completeWebhook(eventId);
      return true;
    }),
    releaseWebhookDelivery: vi.fn(async (eventId) => {
      await store.failWebhook(eventId);
      return true;
    }),
    reserveWebhook: vi.fn(),
    completeWebhook: vi.fn(async (eventId) => {
      const transition = transitions.get(eventId);
      if (transition) {
        transitions.set(eventId, { ...transition, state: "completed" });
      }
    }),
    failWebhook: vi.fn(),
  };
  return store;
}

function createMockEventPublisher() {
  const publish = vi.fn();
  const mockPublisher = {
    publish: vi.fn(),
    publishNow: publish,
    publishMany: vi.fn(),
    publishIdempotently: publish,
  } as unknown as WebhookDependencies["eventPublisher"] & EventPublisher;
  return mockPublisher;
}

const POLAR_PLAN_VERSION = {
  ref: planVersionRef("plan-pro@v1"),
  planId: "plan-pro",
  versionId: "v1",
  effectiveAt: "2026-01-01T00:00:00.000Z",
  name: "Pro",
  amount: 9900,
  currency: "USD",
  interval: "month",
  intervalCount: 1,
  rating: { mode: "provider", provider: "polar" },
  quantityPolicy: {
    minimumQuantity: 1,
    includedSeats: 0,
    seatQuota: 100,
    billableMembershipRoles: ["owner", "admin", "member"],
  },
  providerBindings: [
    {
      provider: "polar",
      productId: "plan-pro",
      priceIds: [],
    },
  ],
} satisfies PlanVersionDefinition;

function createMockPlanRegistry(): PlanRegistry {
  return {
    publishPlanVersion: vi.fn(),
    getPlan: vi.fn(),
    getAllPlans: vi.fn(),
    getPlanVersion: vi.fn(),
    getAllPlanVersions: vi.fn(),
    getPlanAtDate: vi.fn(),
    resolveProviderPlanVersion: vi.fn().mockResolvedValue(POLAR_PLAN_VERSION),
  };
}

const mockVerifyPolarWebhook = vi.fn();

vi.mock("../libs/verifyPolarWebhook", () => ({
  get verifyPolarWebhook() {
    return mockVerifyPolarWebhook;
  },
}));

const signedSubscriptionEvent = {
  id: "evt-signed-replay",
  type: "subscription.created",
  data: {
    id: "sub-signed-replay",
    customer: { externalId: "tenant-signed-replay", metadata: {} },
    product: { id: "plan-pro" },
    status: "active",
    currentPeriodEnd: "2026-02-01T00:00:00Z",
    cancelAtPeriodEnd: false,
  },
};

function expectWebhookValidationProblem(
  problem: unknown,
  detail?: string | RegExp,
): asserts problem is WebhookValidationProblem {
  expect(problem).toBeInstanceOf(WebhookValidationProblem);
  expect(problem).toMatchObject({
    code: "WEBHOOK_VALIDATION_FAILED",
    status: 400,
  });

  if (detail) {
    expect(problem).toMatchObject({
      detail: typeof detail === "string" ? detail : expect.stringMatching(detail),
    });
  }
}

async function captureWebhookValidationProblem(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    expectWebhookValidationProblem(error);
    return error;
  }

  throw new Error("Expected webhook validation to fail");
}

const webhookValidationFailureCases: readonly {
  readonly name: string;
  readonly message: string;
  readonly headers: Record<string, string>;
  readonly detail: string | RegExp;
}[] = [
  {
    name: "invalid signature",
    message: "Invalid signature",
    headers: {
      "webhook-id": "evt-invalid-signature",
      "webhook-signature": "invalid-signature",
    },
    detail: "Webhook validation failed: Invalid signature",
  },
  {
    name: "stale timestamp outside clock skew tolerance",
    message: "Webhook timestamp outside tolerance: signature=stale-signature",
    headers: {
      "webhook-id": "evt-stale-timestamp",
      "webhook-timestamp": "2026-01-01T00:00:00Z",
      "webhook-signature": "stale-signature",
    },
    detail:
      /Webhook validation failed: Webhook timestamp outside tolerance: signature=\[redacted\]/,
  },
];

describe("PolarOrderDataSchema", () => {
  it("accepts zero amounts and rejects negative amounts", () => {
    expect(() =>
      PolarOrderDataSchema.parse({
        id: "ord-123",
        amount: 0,
        currency: "USD",
        billingReason: "purchase",
      }),
    ).not.toThrow();

    expect(() =>
      PolarOrderDataSchema.parse({
        id: "ord-negative",
        amount: -1,
        currency: "USD",
        billingReason: "purchase",
      }),
    ).toThrow();
  });
});

describe("PolarWebhookHandler", () => {
  let handler!: PolarWebhookHandler;
  let mockStore!: BillingStore;
  let mockEventPublisher!: WebhookDependencies["eventPublisher"];
  let mockPlanRegistry!: PlanRegistry;
  let config!: PolarConfig;

  beforeEach(() => {
    mockStore = createMockStore();
    mockEventPublisher = createMockEventPublisher();
    mockPlanRegistry = createMockPlanRegistry();
    config = {
      accessToken: "test-token",
      environment: "sandbox",
      webhookSecret: "test-secret",
    };

    handler = new PolarWebhookHandler(config, {
      store: mockStore,
      eventPublisher: mockEventPublisher,
      planRegistry: mockPlanRegistry,
    });

    vi.clearAllMocks();
  });

  describe("billing provider conformance", () => {
    const subscriptionEvent = {
      id: "evt-conformance-subscription",
      type: "subscription.created",
      data: {
        id: "sub-conformance",
        customer: { externalId: "tenant-conformance", metadata: {} },
        product: { id: "plan-pro" },
        status: "active",
        currentPeriodEnd: "2026-02-01T00:00:00Z",
        cancelAtPeriodEnd: false,
      },
    };

    const orderEvent = {
      id: "evt-conformance-order",
      type: "order.paid",
      data: {
        id: "order-conformance",
        amount: 9900,
        currency: "USD",
        billingReason: "subscription_create",
        customer: { externalId: "tenant-conformance", metadata: {} },
        createdAt: "2026-01-31T00:00:00Z",
      },
    };

    function configureConformanceHandler(): PolarWebhookHandler {
      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);
      vi.mocked(mockStore.failWebhook).mockResolvedValue(undefined);
      vi.mocked(mockStore.reserveWebhook)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new WebhookAlreadyProcessedProblem(subscriptionEvent.id));
      vi.mocked(mockVerifyPolarWebhook).mockImplementation(
        (body: Buffer | string, headers: Record<string, string>) => {
          if (headers["webhook-signature"] !== "valid") {
            throw new Error("Invalid signature");
          }

          return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : body) as never;
        },
      );

      return handler;
    }

    it.each(
      createBillingProviderConformanceSuite({
        providerName: "billing-polar",
        webhook: {
          createHandler: configureConformanceHandler,
          fixtures: {
            subscription: {
              body: JSON.stringify(subscriptionEvent),
              headers: {
                "webhook-id": subscriptionEvent.id,
                "webhook-signature": "valid",
              },
              eventId: subscriptionEvent.id,
            },
            order: {
              body: JSON.stringify(orderEvent),
              headers: {
                "webhook-id": orderEvent.id,
                "webhook-signature": "valid",
              },
              eventId: orderEvent.id,
            },
            invalidSignature: {
              body: JSON.stringify(subscriptionEvent),
              headers: {
                "webhook-id": subscriptionEvent.id,
                "webhook-signature": "invalid",
              },
              eventId: subscriptionEvent.id,
            },
            invalidPayload: {
              body: JSON.stringify({
                id: "evt-invalid-payload",
                type: "subscription.created",
                data: {
                  id: "sub-invalid-payload",
                  customer: { externalId: "tenant-conformance", metadata: {} },
                  product: { id: "plan-pro" },
                  status: "future_status",
                  currentPeriodEnd: "2026-02-01T00:00:00Z",
                  cancelAtPeriodEnd: false,
                },
              }),
              headers: {
                "webhook-id": "evt-invalid-payload",
                "webhook-signature": "valid",
              },
              eventId: "evt-invalid-payload",
            },
          },
          assertions: {
            subscription: () => {
              expect(mockStore.saveSubscription).toHaveBeenCalledTimes(1);
            },
            order: () => {
              expect(mockStore.saveOrder).toHaveBeenCalledTimes(1);
            },
            idempotency: () => {
              expect(mockStore.saveSubscription).toHaveBeenCalledTimes(1);
              expect(mockStore.reserveWebhook).toHaveBeenCalledTimes(1);
            },
            invalidSignature: (problem) => {
              expect(problem).toBeInstanceOf(WebhookValidationProblem);
            },
            invalidPayload: (problem) => {
              expect(problem).toBeInstanceOf(WebhookValidationProblem);
            },
          },
        },
      }).cases,
    )("$name", async ({ run }) => {
      await run();
    });
  });

  describe("이미 처리된 이벤트는 스킵 (멱등성)", () => {
    it("should treat replayed signed deliveries as idempotent successes", async () => {
      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);
      vi.mocked(mockStore.reserveWebhook)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new WebhookAlreadyProcessedProblem(signedSubscriptionEvent.id));
      vi.mocked(mockVerifyPolarWebhook).mockImplementation(
        (body: Buffer | string, headers: Record<string, string>) => {
          expect(headers).toMatchObject({
            "webhook-id": signedSubscriptionEvent.id,
            "webhook-timestamp": "2026-01-31T00:00:00Z",
            "webhook-signature": "v1,replayed-signature",
          });

          return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : body) as never;
        },
      );

      const body = JSON.stringify(signedSubscriptionEvent);
      const headers = {
        "webhook-id": signedSubscriptionEvent.id,
        "webhook-timestamp": "2026-01-31T00:00:00Z",
        "webhook-signature": "v1,replayed-signature",
      };

      const firstResult = await handler.handle(body, headers);
      const replayResult = await handler.handle(body, headers);

      expect(firstResult).toEqual({ success: true, eventId: signedSubscriptionEvent.id });
      expect(replayResult).toEqual({ success: true, eventId: signedSubscriptionEvent.id });
      expect(mockVerifyPolarWebhook).toHaveBeenCalledTimes(2);
      expect(mockStore.reserveWebhook).toHaveBeenCalledTimes(1);
      expect(mockStore.saveSubscription).toHaveBeenCalledTimes(1);
      expect(mockEventPublisher.publishNow).toHaveBeenCalledTimes(1);
      expect(mockStore.completeWebhook).toHaveBeenCalledTimes(1);
      expect(mockStore.failWebhook).toHaveBeenCalledWith(
        "croco:billing:polar:subscription:sub-signed-replay:past_due",
      );
    });

    it("should process webhook only once for concurrent requests", async () => {
      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);
      vi.mocked(mockStore.reserveWebhook).mockResolvedValue(undefined);
      vi.mocked(mockStore.completeWebhook).mockResolvedValue(undefined);
      vi.mocked(mockStore.saveSubscription).mockImplementation(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      });

      const eventData = {
        id: "evt-race-1",
        type: "subscription.created",
        data: {
          id: "sub-race-1",
          customer: { externalId: "tenant-race-1", metadata: {} },
          product: { id: "plan-pro" },
          status: "active",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      };

      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      const body = JSON.stringify(eventData);
      const headers = { "webhook-id": "evt-race-1" };
      const secondHandler = new PolarWebhookHandler(config, {
        store: mockStore,
        eventPublisher: mockEventPublisher,
        planRegistry: mockPlanRegistry,
      });

      const [firstResult, secondResult] = await Promise.all([
        handler.handle(body, headers),
        secondHandler.handle(body, headers),
      ]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(firstResult.eventId).toBe("evt-race-1");
      expect(secondResult.eventId).toBe("evt-race-1");
      expect(mockStore.saveSubscription).toHaveBeenCalledTimes(1);
      expect(mockEventPublisher.publishNow).toHaveBeenCalledTimes(1);
      expect(mockStore.reserveWebhook).toHaveBeenCalledTimes(1);
      expect(mockStore.completeWebhook).toHaveBeenCalledTimes(1);
    });

    it("should skip only a typed already-processed reservation", async () => {
      vi.mocked(mockStore.reserveWebhook).mockRejectedValue(
        new WebhookAlreadyProcessedProblem("evt-dup-conflict"),
      );
      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);

      const eventData = {
        id: "evt-dup-conflict",
        type: "subscription.created",
        data: {
          id: "sub-dup-conflict",
          customer: { externalId: "tenant-dup-conflict", metadata: {} },
          product: { id: "plan-pro" },
          status: "active",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      };

      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      const result = await handler.handle(JSON.stringify(eventData), {
        "webhook-id": "evt-dup-conflict",
      });

      expect(result.success).toBe(true);
      expect(result.eventId).toBe("evt-dup-conflict");
      expect(mockStore.saveSubscription).not.toHaveBeenCalled();
      expect(mockEventPublisher.publishNow).not.toHaveBeenCalled();
      expect(mockStore.reserveWebhook).toHaveBeenCalledTimes(1);
      expect(mockStore.completeWebhook).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "an unrelated PostgreSQL uniqueness failure",
        error: Object.assign(
          new Error('duplicate key value violates unique constraint "billing_accounts_email_key"'),
          { code: "23505" },
        ),
      },
      {
        name: "generic duplicate wording",
        error: new Error("duplicate webhook event"),
      },
      {
        name: "generic already-exists wording",
        error: new Error("reservation already exists"),
      },
      {
        name: "generic unique-constraint wording",
        error: new Error("unique constraint rejected the reservation"),
      },
      {
        name: "a spoofed typed Problem code",
        error: Object.assign(new Error("spoofed duplicate"), {
          code: "billing/webhook-already-processed",
        }),
      },
    ])("should preserve $name as a retriable reservation failure", async ({ error }) => {
      vi.mocked(mockStore.reserveWebhook).mockRejectedValue(error);
      vi.mocked(mockVerifyPolarWebhook).mockReturnValue({
        id: "evt-reservation-failure",
        type: "subscription.created",
        data: {
          id: "sub-reservation-failure",
          customer: { externalId: "tenant-reservation-failure", metadata: {} },
          product: { id: "plan-pro" },
          status: "active",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      } as never);

      await expect(
        handler.handle("{}", {
          "webhook-id": "evt-reservation-failure",
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
        cause: { cause: error },
        detail: expect.stringContaining("Webhook transition commit failed"),
      });

      expect(mockStore.saveSubscription).not.toHaveBeenCalled();
      expect(mockEventPublisher.publishNow).not.toHaveBeenCalled();
      expect(mockStore.completeWebhook).not.toHaveBeenCalled();
      expect(mockStore.failWebhook).not.toHaveBeenCalled();
    });

    it("should preserve a non-Error reservation rejection without exposing it", async () => {
      const rejection = { constraint: "billing_accounts_email_key" };
      vi.mocked(mockStore.reserveWebhook).mockRejectedValue(rejection);
      vi.mocked(mockVerifyPolarWebhook).mockReturnValue({
        id: "evt-non-error-reservation-failure",
        type: "subscription.created",
        data: {
          id: "sub-non-error-reservation-failure",
          customer: { externalId: "tenant-non-error-reservation-failure", metadata: {} },
          product: { id: "plan-pro" },
          status: "active",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      } as never);

      await expect(
        handler.handle("{}", {
          "webhook-id": "evt-non-error-reservation-failure",
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
        cause: { cause: { cause: rejection } },
        detail: expect.stringContaining("Webhook transition commit failed"),
      });

      expect(mockStore.saveSubscription).not.toHaveBeenCalled();
      expect(mockEventPublisher.publishNow).not.toHaveBeenCalled();
      expect(mockStore.completeWebhook).not.toHaveBeenCalled();
      expect(mockStore.failWebhook).not.toHaveBeenCalled();
    });
  });

  describe("subscription 이벤트 처리", () => {
    beforeEach(() => {
      vi.mocked(mockStore.reserveWebhook).mockResolvedValue(undefined);
      vi.mocked(mockStore.completeWebhook).mockResolvedValue(undefined);
      vi.mocked(mockStore.failWebhook).mockResolvedValue(undefined);
    });

    it("subscription.created 이벤트 처리 → store 업데이트 + 이벤트 발행", async () => {
      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);

      const eventData = {
        id: "evt-123",
        type: "subscription.created",
        data: {
          id: "sub-123",
          customer: { externalId: "tenant-123", metadata: {} },
          product: { id: "plan-pro" },
          status: "active",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      };

      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      const body = JSON.stringify(eventData);
      const headers = { "webhook-id": "evt-123" };

      const result = await handler.handle(body, headers);

      expect(result.success).toBe(true);
      expect(mockStore.saveSubscription).toHaveBeenCalled();
      expect(mockEventPublisher.publishNow).toHaveBeenCalled();
      expect(mockStore.reserveWebhook).toHaveBeenCalledWith("evt-123", "subscription.created");
      expect(mockStore.completeWebhook).toHaveBeenCalledWith("evt-123");
    });

    it("resumes durable plan-change intents after a failure before first publication", async () => {
      const durableStore = new InMemoryBillingStore();
      await durableStore.saveSubscription({
        id: "sub-durable-first",
        billingAccountId: "tenant-durable-first",
        externalSubscriptionId: "sub-durable-first",
        planId: "plan-basic",
        planVersionRef: planVersionRef("plan-basic@v1"),
        status: "active",
        currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00Z"),
      });
      const publisher = createMockEventPublisher();
      vi.mocked(publisher.publishNow).mockRejectedValueOnce(new Error("subscriber unavailable"));
      const eventData = {
        id: "evt-durable-first",
        type: "subscription.updated",
        data: {
          id: "sub-durable-first",
          customer: { externalId: "tenant-durable-first", metadata: {} },
          product: { id: "plan-pro" },
          status: "active",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      };
      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      const firstHandler = new PolarWebhookHandler(config, {
        store: durableStore,
        eventPublisher: publisher,
        planRegistry: mockPlanRegistry,
      });
      const retryHandler = new PolarWebhookHandler(config, {
        store: durableStore,
        eventPublisher: publisher,
        planRegistry: mockPlanRegistry,
      });
      await expect(
        firstHandler.handle(JSON.stringify(eventData), {
          "webhook-id": eventData.id,
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
        detail: expect.stringContaining("unavailable"),
      });
      const retry = await retryHandler.handle(JSON.stringify(eventData), {
        "webhook-id": eventData.id,
      });

      expect(retry).toEqual({ success: true, eventId: eventData.id });
      expect(vi.mocked(publisher.publishNow).mock.calls).toHaveLength(2);
      expect(vi.mocked(publisher.publishNow).mock.calls[1]?.[0]).toBeInstanceOf(PlanChangedEvent);
      expect(vi.mocked(publisher.publishNow).mock.calls[0]?.[0].eventId).toBe(
        vi.mocked(publisher.publishNow).mock.calls[1]?.[0].eventId,
      );
    });

    it("does not republish a completed intent when a later intent fails", async () => {
      const durableStore = new InMemoryBillingStore();
      await durableStore.saveSubscription({
        id: "sub-durable-many",
        billingAccountId: "tenant-durable-many",
        externalSubscriptionId: "sub-durable-many",
        planId: "plan-basic",
        planVersionRef: planVersionRef("plan-basic@v1"),
        status: "active",
        currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00Z"),
      });
      const publisher = createMockEventPublisher();
      vi.mocked(publisher.publishNow)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("past-due subscriber unavailable"));
      const eventData = {
        id: "evt-durable-many",
        type: "subscription.updated",
        data: {
          id: "sub-durable-many",
          customer: { externalId: "tenant-durable-many", metadata: {} },
          product: { id: "plan-pro" },
          status: "past_due",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      };
      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);
      const firstHandler = new PolarWebhookHandler(config, {
        store: durableStore,
        eventPublisher: publisher,
        planRegistry: mockPlanRegistry,
      });
      const retryHandler = new PolarWebhookHandler(config, {
        store: durableStore,
        eventPublisher: publisher,
        planRegistry: mockPlanRegistry,
      });

      await expect(
        firstHandler.handle(JSON.stringify(eventData), {
          "webhook-id": eventData.id,
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
      });
      const retry = await retryHandler.handle(JSON.stringify(eventData), {
        "webhook-id": eventData.id,
      });
      const publishedEvents = vi.mocked(publisher.publishNow).mock.calls.map(([event]) => event);

      expect(retry).toEqual({ success: true, eventId: eventData.id });
      expect(publishedEvents.filter((event) => event instanceof PlanChangedEvent)).toHaveLength(1);
      expect(
        publishedEvents.filter((event) => event instanceof SubscriptionPastDueEvent),
      ).toHaveLength(2);
      expect(publishedEvents[1]?.eventId).toBe(publishedEvents[2]?.eventId);
    });

    it("uses stable event identity when acknowledgement fails after publication", async () => {
      const durableStore = new InMemoryBillingStore();
      await durableStore.saveSubscription({
        id: "sub-ack-failure",
        billingAccountId: "tenant-ack-failure",
        externalSubscriptionId: "sub-ack-failure",
        planId: "plan-basic",
        planVersionRef: planVersionRef("plan-basic@v1"),
        status: "active",
        currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00Z"),
      });
      const originalMark = durableStore.markWebhookEventIntentPublished.bind(durableStore);
      let failAcknowledgement = true;
      vi.spyOn(durableStore, "markWebhookEventIntentPublished").mockImplementation(
        async (eventId, intentEventId) => {
          if (failAcknowledgement) {
            failAcknowledgement = false;
            throw new Error("acknowledgement unavailable");
          }
          await originalMark(eventId, intentEventId);
        },
      );
      const publisher = createMockEventPublisher();
      const deliveredEventIds = new Set<string>();
      vi.mocked(publisher.publishIdempotently).mockImplementation(async (event) => {
        deliveredEventIds.add(event.eventId);
      });
      const eventData = {
        id: "evt-ack-failure",
        type: "subscription.updated",
        data: {
          id: "sub-ack-failure",
          customer: { externalId: "tenant-ack-failure", metadata: {} },
          product: { id: "plan-pro" },
          status: "active",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      };
      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);
      const firstHandler = new PolarWebhookHandler(config, {
        store: durableStore,
        eventPublisher: publisher,
        planRegistry: mockPlanRegistry,
      });
      const retryHandler = new PolarWebhookHandler(config, {
        store: durableStore,
        eventPublisher: publisher,
        planRegistry: mockPlanRegistry,
      });

      await expect(
        firstHandler.handle(JSON.stringify(eventData), {
          "webhook-id": eventData.id,
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
      });
      const retry = await retryHandler.handle(JSON.stringify(eventData), {
        "webhook-id": eventData.id,
      });

      expect(retry).toEqual({ success: true, eventId: eventData.id });
      expect(publisher.publishIdempotently).toHaveBeenCalledTimes(2);
      expect(deliveredEventIds.size).toBe(1);
    });

    it("publishes one past-due transition for concurrent updated and past_due events", async () => {
      const reservations = new Set<string>();
      let storedSubscription: Subscription = {
        id: "sub-past-due",
        billingAccountId: "tenant-123",
        externalSubscriptionId: "sub-past-due",
        planId: "plan-pro",
        planVersionRef: planVersionRef("plan-pro@v1"),
        status: "active",
        currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00Z"),
      };
      let readCount = 0;
      let releaseReads: (() => void) | undefined;
      const bothHandlersRead = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });

      vi.mocked(mockStore.findSubscription).mockImplementation(async () => {
        const snapshot = { ...storedSubscription };
        readCount += 1;
        if (readCount === 2) {
          releaseReads?.();
        }
        await bothHandlersRead;
        return snapshot;
      });
      vi.mocked(mockStore.saveSubscription).mockImplementation(async (subscription) => {
        storedSubscription = subscription;
      });
      vi.mocked(mockStore.reserveWebhook).mockImplementation(async (eventId) => {
        if (reservations.has(eventId)) {
          throw new WebhookAlreadyProcessedProblem(eventId);
        }
        reservations.add(eventId);
      });
      vi.mocked(mockStore.failWebhook).mockImplementation(async (eventId) => {
        reservations.delete(eventId);
      });
      vi.mocked(mockVerifyPolarWebhook).mockImplementation((body: Buffer | string) =>
        JSON.parse(body.toString()),
      );
      const otherHandler = new PolarWebhookHandler(config, {
        store: mockStore,
        eventPublisher: mockEventPublisher,
        planRegistry: mockPlanRegistry,
      });

      const createEvent = (id: string, type: string) => ({
        id,
        type,
        data: {
          id: "sub-past-due",
          customer: { externalId: "tenant-123", metadata: {} },
          product: { id: "plan-pro" },
          status: "past_due",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      });
      const updatedEvent = createEvent("evt-past-due-updated", "subscription.updated");
      const directEvent = createEvent("evt-past-due-direct", "subscription.past_due");

      const results = await Promise.all([
        handler.handle(JSON.stringify(updatedEvent), { "webhook-id": updatedEvent.id }),
        otherHandler.handle(JSON.stringify(directEvent), { "webhook-id": directEvent.id }),
      ]);

      expect(results).toEqual([
        { success: true, eventId: updatedEvent.id },
        { success: true, eventId: directEvent.id },
      ]);
      expect(mockEventPublisher.publishNow).toHaveBeenCalledTimes(1);
      expect(mockStore.reserveWebhook).toHaveBeenCalledWith(
        "croco:billing:polar:subscription:sub-past-due:past_due",
        "billing.subscription_past_due",
      );
      expect(mockStore.saveSubscription).toHaveBeenCalledTimes(2);
    });

    it("does not acknowledge a past-due intent while another worker owns its delivery lease", async () => {
      const durableStore = new InMemoryBillingStore();
      const publisher = createMockEventPublisher();
      let releasePublication: (() => void) | undefined;
      const publicationBlocked = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      let publicationStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        publicationStarted = resolve;
      });
      vi.mocked(publisher.publishIdempotently).mockImplementationOnce(async () => {
        publicationStarted?.();
        await publicationBlocked;
      });
      vi.mocked(mockVerifyPolarWebhook).mockImplementation((body: Buffer | string) =>
        JSON.parse(body.toString()),
      );
      const createEvent = (id: string) => ({
        id,
        type: "subscription.past_due",
        data: {
          id: "sub-past-due-lease",
          customer: { externalId: "tenant-past-due-lease", metadata: {} },
          product: { id: "plan-pro" },
          status: "past_due",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      });
      const firstEvent = createEvent("evt-past-due-owner");
      const secondEvent = createEvent("evt-past-due-contender");
      const firstHandler = new PolarWebhookHandler(config, {
        store: durableStore,
        eventPublisher: publisher,
        planRegistry: mockPlanRegistry,
      });
      const secondHandler = new PolarWebhookHandler(config, {
        store: durableStore,
        eventPublisher: publisher,
        planRegistry: mockPlanRegistry,
      });

      const owner = firstHandler.handle(JSON.stringify(firstEvent), {
        "webhook-id": firstEvent.id,
      });
      await started;
      await expect(
        secondHandler.handle(JSON.stringify(secondEvent), {
          "webhook-id": secondEvent.id,
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
        detail: expect.stringContaining("already in progress"),
      });
      releasePublication?.();
      const ownerResult = await owner;
      const retryResult = await secondHandler.handle(JSON.stringify(secondEvent), {
        "webhook-id": secondEvent.id,
      });

      expect(ownerResult).toEqual({ success: true, eventId: firstEvent.id });
      expect(retryResult).toEqual({ success: true, eventId: secondEvent.id });
      expect(publisher.publishIdempotently).toHaveBeenCalledTimes(1);
    });

    it("retries a past-due publication after persistence without losing the transition", async () => {
      const reservations = new Set<string>();
      let storedSubscription: Subscription = {
        id: "sub-past-due-retry",
        billingAccountId: "tenant-retry",
        externalSubscriptionId: "sub-past-due-retry",
        planId: "plan-pro",
        planVersionRef: planVersionRef("plan-pro@v1"),
        status: "active",
        currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00Z"),
      };

      vi.mocked(mockStore.findSubscription).mockImplementation(async () => storedSubscription);
      vi.mocked(mockStore.saveSubscription).mockImplementation(async (subscription) => {
        storedSubscription = subscription;
      });
      vi.mocked(mockStore.reserveWebhook).mockImplementation(async (eventId) => {
        if (reservations.has(eventId)) {
          throw new WebhookAlreadyProcessedProblem(eventId);
        }
        reservations.add(eventId);
      });
      vi.mocked(mockStore.failWebhook).mockImplementation(async (eventId) => {
        reservations.delete(eventId);
      });
      vi.mocked(mockEventPublisher.publishNow).mockRejectedValueOnce(
        new Error("subscriber unavailable"),
      );

      const eventData = {
        id: "evt-past-due-retry",
        type: "subscription.past_due",
        data: {
          id: "sub-past-due-retry",
          customer: { externalId: "tenant-retry", metadata: {} },
          product: { id: "plan-pro" },
          status: "past_due",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      };
      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      await expect(
        handler.handle(JSON.stringify(eventData), {
          "webhook-id": eventData.id,
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
        detail: expect.stringContaining("subscriber unavailable"),
      });
      const retryResult = await handler.handle(JSON.stringify(eventData), {
        "webhook-id": eventData.id,
      });

      expect(retryResult).toEqual({ success: true, eventId: eventData.id });
      expect(mockEventPublisher.publishNow).toHaveBeenCalledTimes(2);
      expect(vi.mocked(mockEventPublisher.publishNow).mock.calls[1]?.[0]).toBeInstanceOf(
        SubscriptionPastDueEvent,
      );
    });

    it("keeps one past-due episode across unrelated updates and opens a new one after recovery", async () => {
      const reservations = new Set<string>();
      let storedSubscription: Subscription = {
        id: "sub-past-due-episodes",
        billingAccountId: "tenant-episodes",
        externalSubscriptionId: "sub-past-due-episodes",
        planId: "plan-pro",
        planVersionRef: planVersionRef("plan-pro@v1"),
        status: "active",
        currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00Z"),
      };

      vi.mocked(mockStore.findSubscription).mockImplementation(async () => storedSubscription);
      vi.mocked(mockStore.saveSubscription).mockImplementation(async (subscription) => {
        storedSubscription = subscription;
      });
      vi.mocked(mockStore.reserveWebhook).mockImplementation(async (eventId) => {
        if (reservations.has(eventId)) {
          throw new WebhookAlreadyProcessedProblem(eventId);
        }
        reservations.add(eventId);
      });
      vi.mocked(mockStore.failWebhook).mockImplementation(async (eventId) => {
        reservations.delete(eventId);
      });
      vi.mocked(mockVerifyPolarWebhook).mockImplementation((body: Buffer | string) =>
        JSON.parse(body.toString()),
      );

      const createEvent = (id: string, status: "active" | "past_due") => ({
        id,
        type: status === "past_due" ? "subscription.past_due" : "subscription.updated",
        data: {
          id: "sub-past-due-episodes",
          customer: { externalId: "tenant-episodes", metadata: {} },
          product: { id: "plan-pro" },
          status,
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      });
      const events = [
        createEvent("evt-past-due-t1", "past_due"),
        { ...createEvent("evt-unrelated-t2", "past_due"), type: "subscription.updated" },
        createEvent("evt-recovered-t3", "active"),
        createEvent("evt-past-due-t4", "past_due"),
      ];

      for (const event of events) {
        await handler.handle(JSON.stringify(event), { "webhook-id": event.id });
      }

      const pastDuePublications = vi
        .mocked(mockEventPublisher.publishNow)
        .mock.calls.filter(([event]) => event instanceof SubscriptionPastDueEvent);
      expect(pastDuePublications).toHaveLength(2);
      expect(mockStore.reserveWebhook).toHaveBeenCalledWith(
        "croco:billing:polar:subscription:sub-past-due-episodes:past_due",
        "billing.subscription_past_due",
      );
    });

    it("retries a failed recovery reset before publishing the next past-due episode", async () => {
      const transitionReservationId = "croco:billing:polar:subscription:sub-reset-retry:past_due";
      const reservations = new Set<string>();
      let storedSubscription: Subscription = {
        id: "sub-reset-retry",
        billingAccountId: "tenant-reset-retry",
        externalSubscriptionId: "sub-reset-retry",
        planId: "plan-pro",
        planVersionRef: planVersionRef("plan-pro@v1"),
        status: "active",
        currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00Z"),
      };
      let failedRecoveryReset = false;

      vi.mocked(mockStore.findSubscription).mockImplementation(async () => storedSubscription);
      vi.mocked(mockStore.saveSubscription).mockImplementation(async (subscription) => {
        storedSubscription = subscription;
      });
      vi.mocked(mockStore.reserveWebhook).mockImplementation(async (eventId) => {
        if (reservations.has(eventId)) {
          throw new WebhookAlreadyProcessedProblem(eventId);
        }
        reservations.add(eventId);
      });
      vi.mocked(mockStore.failWebhook).mockImplementation(async (eventId) => {
        if (
          eventId === transitionReservationId &&
          storedSubscription.status === "active" &&
          !failedRecoveryReset
        ) {
          failedRecoveryReset = true;
          throw new Error("reset unavailable");
        }
        reservations.delete(eventId);
      });
      vi.mocked(mockVerifyPolarWebhook).mockImplementation((body: Buffer | string) =>
        JSON.parse(body.toString()),
      );

      const createEvent = (id: string, status: "active" | "past_due") => ({
        id,
        type: status === "past_due" ? "subscription.past_due" : "subscription.updated",
        data: {
          id: "sub-reset-retry",
          customer: { externalId: "tenant-reset-retry", metadata: {} },
          product: { id: "plan-pro" },
          status,
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      });
      const firstPastDue = createEvent("evt-reset-past-due-t1", "past_due");
      const recovery = createEvent("evt-reset-active-t2", "active");
      const nextPastDue = createEvent("evt-reset-past-due-t3", "past_due");

      await handler.handle(JSON.stringify(firstPastDue), { "webhook-id": firstPastDue.id });
      await expect(
        handler.handle(JSON.stringify(recovery), {
          "webhook-id": recovery.id,
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
        detail: expect.stringContaining("Webhook transition commit failed"),
      });
      const retriedRecovery = await handler.handle(JSON.stringify(recovery), {
        "webhook-id": recovery.id,
      });
      const nextPastDueResult = await handler.handle(JSON.stringify(nextPastDue), {
        "webhook-id": nextPastDue.id,
      });

      expect(retriedRecovery).toEqual({ success: true, eventId: recovery.id });
      expect(nextPastDueResult).toEqual({ success: true, eventId: nextPastDue.id });
      expect(
        vi
          .mocked(mockEventPublisher.publishNow)
          .mock.calls.filter(([event]) => event instanceof SubscriptionPastDueEvent),
      ).toHaveLength(2);
    });

    it("does not reopen a published transition when reservation completion fails", async () => {
      const transitionReservationId =
        "croco:billing:polar:subscription:sub-completion-failure:past_due";
      const reservations = new Set<string>();
      let failedTransitionCompletion = false;

      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);
      vi.mocked(mockStore.reserveWebhook).mockImplementation(async (eventId) => {
        if (reservations.has(eventId)) {
          throw new WebhookAlreadyProcessedProblem(eventId);
        }
        reservations.add(eventId);
      });
      vi.mocked(mockStore.completeWebhook).mockImplementation(async (eventId) => {
        if (eventId === transitionReservationId && !failedTransitionCompletion) {
          failedTransitionCompletion = true;
          throw new Error("completion unavailable");
        }
      });
      vi.mocked(mockStore.failWebhook).mockImplementation(async (eventId) => {
        reservations.delete(eventId);
      });

      const eventData = {
        id: "evt-completion-failure",
        type: "subscription.past_due",
        data: {
          id: "sub-completion-failure",
          customer: { externalId: "tenant-completion-failure", metadata: {} },
          product: { id: "plan-pro" },
          status: "past_due",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      };
      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      await expect(
        handler.handle(JSON.stringify(eventData), {
          "webhook-id": eventData.id,
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
        detail: expect.stringContaining("completion unavailable"),
      });
      const retryResult = await handler.handle(JSON.stringify(eventData), {
        "webhook-id": eventData.id,
      });

      expect(retryResult).toEqual({ success: true, eventId: eventData.id });
      expect(mockEventPublisher.publishNow).toHaveBeenCalledTimes(1);
      expect(mockStore.failWebhook).not.toHaveBeenCalledWith(eventData.id);
      expect(mockStore.failWebhook).not.toHaveBeenCalledWith(transitionReservationId);
    });

    it("subscription.canceled에서 currentPeriodEnd가 null이면 실패 처리", async () => {
      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);

      const eventData = {
        id: "evt-null-period",
        type: "subscription.canceled",
        data: {
          id: "sub-null-period",
          customer: { externalId: "tenant-123", metadata: {} },
          product: { id: "plan-pro" },
          status: "canceled",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: true,
        },
      };

      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      await expect(
        handler.handle(JSON.stringify(eventData), {
          "webhook-id": "evt-null-period",
        }),
      ).rejects.toBeInstanceOf(WebhookProcessingProblem);
      await expect(
        handler.handle(JSON.stringify(eventData), {
          "webhook-id": "evt-null-period",
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        detail: "Webhook processing failed: currentPeriodEnd is required",
      });
      expect(mockStore.saveSubscription).not.toHaveBeenCalled();
      expect(mockStore.reserveWebhook).not.toHaveBeenCalled();
      expect(mockStore.failWebhook).not.toHaveBeenCalled();
    });

    it("should reject a signed webhook with an unknown subscription status", async () => {
      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);

      const eventData = {
        id: "evt-unknown-status",
        type: "subscription.created",
        data: {
          id: "sub-unknown-status",
          customer: { externalId: "tenant-123", metadata: {} },
          product: { id: "plan-pro" },
          status: "future_status",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      };

      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      await expect(
        handler.handle(JSON.stringify(eventData), {
          "webhook-id": "evt-unknown-status",
        }),
      ).rejects.toBeInstanceOf(WebhookValidationProblem);
      await expect(
        handler.handle(JSON.stringify(eventData), {
          "webhook-id": "evt-unknown-status",
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_VALIDATION_FAILED",
        detail: expect.stringContaining("Invalid webhook payload"),
      });
      expect(mockStore.saveSubscription).not.toHaveBeenCalled();
      expect(mockStore.reserveWebhook).not.toHaveBeenCalled();
      expect(mockStore.failWebhook).not.toHaveBeenCalled();
    });

    it("handler 실패 시 reserveWebhook 상태가 fail로 해제되어 재시도 가능", async () => {
      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);
      vi.mocked(mockStore.saveSubscription).mockRejectedValueOnce(
        new Error("temporary store failure"),
      );

      const eventData = {
        id: "evt-retryable-failure",
        type: "subscription.created",
        data: {
          id: "sub-retryable-failure",
          customer: { externalId: "tenant-retryable-failure", metadata: {} },
          product: { id: "plan-pro" },
          status: "active",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      };

      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      await expect(
        handler.handle(JSON.stringify(eventData), {
          "webhook-id": "evt-retryable-failure",
        }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
        detail: expect.stringContaining("Webhook transition commit failed"),
      });
      expect(mockStore.reserveWebhook).toHaveBeenCalledWith(
        "evt-retryable-failure",
        "subscription.created",
      );
      expect(mockStore.failWebhook).toHaveBeenCalledWith("evt-retryable-failure");
      expect(mockStore.completeWebhook).not.toHaveBeenCalled();
    });
  });

  describe("order 이벤트 처리", () => {
    beforeEach(() => {
      vi.mocked(mockStore.reserveWebhook).mockResolvedValue(undefined);
      vi.mocked(mockStore.completeWebhook).mockResolvedValue(undefined);
    });

    it.each(["saveOrder", "publishNow", "completeWebhook"] as const)(
      "rejects %s failures with their cause and allows the same event to retry",
      async (operation) => {
        const failure = new Error(`${operation} unavailable`);
        const target =
          operation === "publishNow" ? mockEventPublisher.publishNow : mockStore[operation];
        vi.mocked(target).mockRejectedValueOnce(failure);
        const event = {
          id: "evt-order-retry",
          type: "order.paid",
          data: {
            id: "order-retry",
            amount: 9900,
            currency: "USD",
            billing_reason: "purchase",
            customer: { externalId: "tenant-123", metadata: {} },
            createdAt: "2026-01-31T00:00:00Z",
          },
        };
        vi.mocked(mockVerifyPolarWebhook).mockReturnValue(event);
        const first = handler.handle("{}", { "webhook-id": event.id });
        const concurrent = handler.handle("{}", { "webhook-id": event.id });
        await Promise.all(
          [first, concurrent].map(async (attempt) => {
            await expect(attempt).rejects.toBeInstanceOf(WebhookProcessingProblem);
            await expect(attempt).rejects.toMatchObject({ status: 500, cause: failure });
          }),
        );
        expect(mockStore.reserveWebhook).toHaveBeenCalledTimes(1);
        expect(mockStore.failWebhook).toHaveBeenCalledExactlyOnceWith(event.id);
        await expect(handler.handle("{}", { "webhook-id": event.id })).resolves.toEqual({
          success: true,
          eventId: event.id,
        });
        expect(mockStore.reserveWebhook).toHaveBeenCalledTimes(2);
      },
    );

    it.each(["publication", "completion"] as const)(
      "retries %s failure without duplicating the order or its logical event",
      async (operation) => {
        const store = new InMemoryBillingStore();
        const publisher = createMockEventPublisher();
        publisher.publishNow = vi.fn();
        const delivered = new Set<string>();
        const failure = new Error(`${operation} unavailable`);
        vi.mocked(publisher.publishIdempotently).mockImplementation(async (event) => {
          delivered.add(event.eventId);
          if (
            operation === "publication" &&
            vi.mocked(publisher.publishIdempotently).mock.calls.length === 1
          )
            throw failure;
        });
        if (operation === "completion") {
          vi.spyOn(store, "completeWebhook").mockRejectedValueOnce(failure);
        }
        const event = {
          id: "evt-order-durable-retry",
          type: "order.paid",
          data: {
            id: "order-retry",
            amount: 9900,
            currency: "USD",
            billing_reason: "purchase",
            customer: { externalId: "tenant-123", metadata: {} },
            createdAt: "2026-01-31T00:00:00Z",
          },
        };
        vi.mocked(mockVerifyPolarWebhook).mockReturnValue(event);
        const deps = { store, eventPublisher: publisher, planRegistry: mockPlanRegistry };
        await expect(new PolarWebhookHandler(config, deps).handle("{}", {})).rejects.toMatchObject({
          status: 500,
          cause: failure,
        });
        await expect(new PolarWebhookHandler(config, deps).handle("{}", {})).resolves.toMatchObject(
          {
            success: true,
          },
        );
        expect(await store.findOrdersByAccount("tenant-123")).toHaveLength(1);
        expect(publisher.publishNow).not.toHaveBeenCalled();
        expect(publisher.publishIdempotently).toHaveBeenCalledTimes(2);
        expect(delivered.size).toBe(1);
        expect(vi.mocked(publisher.publishIdempotently).mock.calls[1]?.[0]).toMatchObject({
          tenantId: "tenant-123",
          externalOrderId: "order-retry",
          amount: 9900,
          currency: "USD",
          timestamp: new Date("2026-01-31T00:00:00Z"),
        });
      },
    );

    it.each([new Error("storage unavailable"), { reason: "storage unavailable" }])(
      "preserves the processing cause and rollback failure diagnostics",
      async (failure) => {
        vi.mocked(mockStore.saveOrder).mockRejectedValueOnce(failure);
        vi.mocked(mockStore.failWebhook).mockRejectedValueOnce(new Error("rollback unavailable"));
        vi.mocked(mockVerifyPolarWebhook).mockReturnValue({
          id: "evt-order-rollback",
          type: "order.paid",
          data: {
            id: "order-rollback",
            amount: 9900,
            currency: "USD",
            billing_reason: "purchase",
            customer: { externalId: "tenant-123", metadata: {} },
            createdAt: "2026-01-31T00:00:00Z",
          },
        });
        await expect(
          handler.handle("{}", { "webhook-id": "evt-order-rollback" }),
        ).rejects.toMatchObject({
          code: "WEBHOOK_PROCESSING_FAILED",
          status: 500,
          cause: failure instanceof Error ? failure : { cause: failure },
          detail: expect.stringContaining("rollback failed: rollback unavailable"),
        });
        expect(mockStore.completeWebhook).not.toHaveBeenCalled();
      },
    );

    it("0원 order.paid 이벤트 처리 → store 저장 + 이벤트 발행", async () => {
      const eventData = {
        id: "evt-456",
        type: "order.paid",
        data: {
          id: "order-123",
          amount: 0,
          currency: "USD",
          billing_reason: "subscription_create",
          customer: { externalId: "tenant-123", metadata: {} },
          createdAt: "2026-01-31T00:00:00Z",
        },
      };

      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      const body = JSON.stringify(eventData);
      const headers = { "webhook-id": "evt-456" };

      const result = await handler.handle(body, headers);

      expect(result.success).toBe(true);
      expect(mockStore.saveOrder).toHaveBeenCalledWith({
        id: "order-123",
        billingAccountId: "tenant-123",
        externalOrderId: "order-123",
        amount: 0,
        currency: "USD",
        reason: "subscription_create",
        paidAt: expect.any(Date),
      });
      expect(mockEventPublisher.publishNow).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "subscription_create" }),
      );
      expect(mockStore.reserveWebhook).toHaveBeenCalledWith("evt-456", "order.paid");
      expect(mockStore.completeWebhook).toHaveBeenCalledWith("evt-456");
    });

    it.each([
      ["purchase", "one_time"],
      ["subscription_create", "subscription_create"],
      ["subscription_cycle", "subscription_cycle"],
      ["subscription_update", "subscription_update"],
    ] as const)("maps Polar billing reason %s to %s", async (billingReason, reason) => {
      const eventData = {
        id: `evt-${billingReason}`,
        type: "order.paid",
        data: {
          id: `order-${billingReason}`,
          amount: 9900,
          currency: "USD",
          billing_reason: billingReason,
          customer: { externalId: "tenant-123", metadata: {} },
          createdAt: "2026-01-31T00:00:00Z",
        },
      };

      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      await handler.handle(JSON.stringify(eventData), {
        "webhook-id": eventData.id,
      });

      expect(mockStore.saveOrder).toHaveBeenCalledWith(expect.objectContaining({ reason }));
      expect(mockEventPublisher.publishNow).toHaveBeenCalledWith(
        expect.objectContaining({ reason }),
      );
    });

    it.each([undefined, "subscription_reactivation"])(
      "rejects unsupported Polar billing reason %s before reservation",
      async (billingReason) => {
        const eventData = {
          id: "evt-invalid-billing-reason",
          type: "order.paid",
          data: {
            id: "order-invalid-billing-reason",
            amount: 9900,
            currency: "USD",
            ...(billingReason && { billing_reason: billingReason }),
            customer: { externalId: "tenant-123", metadata: {} },
            createdAt: "2026-01-31T00:00:00Z",
          },
        };

        vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

        await expect(
          handler.handle(JSON.stringify(eventData), {
            "webhook-id": eventData.id,
          }),
        ).rejects.toBeInstanceOf(WebhookValidationProblem);
        expect(mockStore.reserveWebhook).not.toHaveBeenCalled();
        expect(mockStore.saveOrder).not.toHaveBeenCalled();
      },
    );

    it("lifecycle ordering and duplicate delivery cannot persist an unpaid order", async () => {
      const orderData = {
        id: "order-lifecycle",
        amount: 9900,
        currency: "USD",
        billingReason: "subscription_cycle",
        customer: { externalId: "tenant-lifecycle", metadata: {} },
        createdAt: "2026-01-31T00:00:00Z",
      };
      const deliveries = [
        { id: "evt-order-created", type: "order.created", data: orderData },
        { id: "evt-order-updated", type: "order.updated", data: orderData },
        { id: "evt-order-paid", type: "order.paid", data: orderData },
        { id: "evt-order-paid", type: "order.paid", data: orderData },
      ];

      vi.mocked(mockVerifyPolarWebhook).mockImplementation((body: Buffer | string) => {
        return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : body) as never;
      });
      vi.mocked(mockStore.reserveWebhook)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new WebhookAlreadyProcessedProblem("evt-order-paid"));

      const results = [];
      for (const delivery of deliveries) {
        results.push(
          await handler.handle(JSON.stringify(delivery), {
            "webhook-id": delivery.id,
          }),
        );
      }

      expect(results).toEqual(
        deliveries.map(({ id }) => ({
          success: true,
          eventId: id,
        })),
      );
      expect(mockStore.reserveWebhook).toHaveBeenNthCalledWith(
        1,
        "evt-order-created",
        "order.created",
      );
      expect(mockStore.reserveWebhook).toHaveBeenNthCalledWith(
        2,
        "evt-order-updated",
        "order.updated",
      );
      expect(mockStore.reserveWebhook).toHaveBeenNthCalledWith(3, "evt-order-paid", "order.paid");
      expect(mockStore.reserveWebhook).toHaveBeenNthCalledWith(4, "evt-order-paid", "order.paid");
      expect(mockStore.completeWebhook).toHaveBeenCalledTimes(3);
      expect(mockStore.completeWebhook).toHaveBeenCalledWith("evt-order-created");
      expect(mockStore.completeWebhook).toHaveBeenCalledWith("evt-order-updated");
      expect(mockStore.completeWebhook).toHaveBeenCalledWith("evt-order-paid");
      expect(mockStore.saveOrder).toHaveBeenCalledTimes(1);
      expect(mockStore.saveOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "order-lifecycle",
          externalOrderId: "order-lifecycle",
          reason: "subscription_cycle",
        }),
      );
      expect(mockEventPublisher.publishNow).toHaveBeenCalledTimes(1);
      expect(mockEventPublisher.publishNow).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "subscription_cycle" }),
      );
      expect(mockStore.failWebhook).not.toHaveBeenCalled();
    });
  });

  describe("webhook 검증 실패", () => {
    it.each(webhookValidationFailureCases)(
      "should surface stable Problem code and status for $name",
      async ({ message, headers, detail }) => {
        const body = JSON.stringify({ id: headers["webhook-id"], type: "subscription.created" });

        vi.mocked(mockVerifyPolarWebhook).mockImplementation(() => {
          throw new Error(message);
        });

        const problem = await captureWebhookValidationProblem(() => handler.handle(body, headers));

        expectWebhookValidationProblem(problem, detail);
        expect(mockStore.reserveWebhook).not.toHaveBeenCalled();
        expect(mockStore.saveSubscription).not.toHaveBeenCalled();
        expect(mockStore.completeWebhook).not.toHaveBeenCalled();
        expect(mockStore.failWebhook).not.toHaveBeenCalled();
        expect(mockEventPublisher.publishNow).not.toHaveBeenCalled();
      },
    );

    it("should redact webhook secrets and signature diagnostics from validation Problems", async () => {
      const rawSignature = "v1,leaked-signature";
      const body = JSON.stringify({ id: "evt-redacted", type: "subscription.created" });
      const headers = {
        "webhook-id": "evt-redacted",
        "webhook-signature": rawSignature,
      };

      vi.mocked(mockVerifyPolarWebhook).mockImplementation(() => {
        throw new Error(
          "Invalid signature: webhookSecret=test-secret webhook-signature=v1,leaked-signature signature=leaked-signature",
        );
      });

      const problem = await captureWebhookValidationProblem(() => handler.handle(body, headers));
      const serializedProblem = JSON.stringify(problem);

      expect(problem.detail).toContain("[redacted]");
      expect(serializedProblem).not.toContain("test-secret");
      expect(serializedProblem).not.toContain("leaked-signature");
      expect(serializedProblem).not.toContain(rawSignature);
      expect(mockStore.reserveWebhook).not.toHaveBeenCalled();
      expect(mockStore.saveSubscription).not.toHaveBeenCalled();
      expect(mockEventPublisher.publishNow).not.toHaveBeenCalled();
    });

    it("이벤트 ID 또는 타입 누락 시 실패", async () => {
      const body = JSON.stringify({});
      const headers = { "webhook-id": "evt-999" };

      vi.mocked(mockVerifyPolarWebhook).mockReturnValue({
        id: null,
        type: null,
      } as never);

      await expect(handler.handle(body, headers)).rejects.toBeInstanceOf(WebhookValidationProblem);
      await expect(handler.handle(body, headers)).rejects.toMatchObject({
        code: "WEBHOOK_VALIDATION_FAILED",
        detail: expect.stringContaining("Invalid webhook payload"),
      });
    });
  });

  describe("처리 완료 후 completeWebhook 호출", () => {
    it("성공적인 이벤트 처리 후 webhook 처리 기록 저장", async () => {
      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);
      vi.mocked(mockStore.reserveWebhook).mockResolvedValue(undefined);
      vi.mocked(mockStore.completeWebhook).mockResolvedValue(undefined);

      const eventData = {
        id: "evt-999",
        type: "subscription.canceled",
        data: {
          id: "sub-999",
          customer: { externalId: "tenant-999", metadata: {} },
          product: { id: "plan-basic" },
          status: "canceled",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: true,
        },
      };

      vi.mocked(mockVerifyPolarWebhook).mockReturnValue(eventData);

      const body = JSON.stringify(eventData);
      const headers = { "webhook-id": "evt-999" };

      const result = await handler.handle(body, headers);

      expect(result.success).toBe(true);
      expect(result.eventId).toBe("evt-999");
      expect(mockStore.reserveWebhook).toHaveBeenCalledTimes(1);
      expect(mockStore.reserveWebhook).toHaveBeenCalledWith("evt-999", "subscription.canceled");
      expect(mockStore.completeWebhook).toHaveBeenCalledTimes(1);
      expect(mockStore.completeWebhook).toHaveBeenCalledWith("evt-999");
    });
  });

  describe("plan version mapping", () => {
    it("fails explicitly before persistence when provider mapping is unknown", async () => {
      vi.mocked(mockStore.findSubscription).mockResolvedValue(null);
      vi.mocked(mockStore.reserveWebhook).mockResolvedValue(undefined);
      vi.mocked(mockStore.failWebhook).mockResolvedValue(undefined);
      vi.mocked(mockPlanRegistry.resolveProviderPlanVersion).mockRejectedValue(
        new UnknownProviderPlanMappingProblem("polar", "unknown-product", ["unknown-price"]),
      );
      vi.mocked(mockVerifyPolarWebhook).mockReturnValue({
        id: "evt-unknown-plan",
        type: "subscription.created",
        data: {
          id: "sub-unknown-plan",
          customer: { externalId: "tenant-unknown-plan", metadata: {} },
          product: { id: "unknown-product" },
          prices: [{ id: "unknown-price" }],
          status: "active",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      } as never);

      await expect(
        handler.handle("{}", { "webhook-id": "evt-unknown-plan" }),
      ).rejects.toMatchObject({
        code: "WEBHOOK_PROCESSING_FAILED",
        status: 500,
        detail: expect.stringContaining("billing/unknown-provider-plan-mapping"),
      });

      expect(mockStore.saveSubscription).not.toHaveBeenCalled();
      expect(mockEventPublisher.publishNow).not.toHaveBeenCalled();
      expect(mockStore.failWebhook).not.toHaveBeenCalledWith("evt-unknown-plan");
    });
  });
});
