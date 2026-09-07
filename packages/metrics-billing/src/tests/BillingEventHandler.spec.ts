import type { BillingStore, Plan, PlanRegistry, PlanVersionDefinition } from "@croco/billing-core";
import {
  OrderPaidEvent,
  planVersionRef,
  PlanChangedEvent,
  SubscriptionCanceledEvent,
} from "@croco/billing-core";
import type { MetricsRepository, MRRMovement } from "@croco/metrics-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingEventHandler } from "../libs/BillingEventHandler";
import {
  BillingMetricDroppedProblem,
  BillingMetricRecordingProblem,
  InvalidOrderPaymentReasonProblem,
} from "../libs/problems/BillingMetricsProblems";

describe("BillingEventHandler", () => {
  let handler!: BillingEventHandler;
  let planRegistry!: PlanRegistry;
  let billingStore!: BillingStore;
  let metricsRepository!: MetricsRepository;

  const asPlanVersion = (plan: Plan): PlanVersionDefinition => ({
    ref: planVersionRef(`${plan.id}@v1`),
    planId: plan.id,
    versionId: "v1",
    effectiveAt: "2026-01-01T00:00:00.000Z",
    name: plan.name,
    amount: plan.amount,
    currency: plan.currency,
    interval: plan.interval,
    intervalCount: plan.intervalCount,
    rating: { mode: "provider", provider: "test" },
    quantityPolicy: {
      minimumQuantity: 1,
      includedSeats: 0,
      seatQuota: 100,
      billableMembershipRoles: ["owner", "admin", "member"],
    },
    providerBindings: [
      {
        provider: "test",
        productId: plan.id,
        priceIds: [],
      },
    ],
  });

  const mockPlan: Plan = {
    id: "plan-pro",
    name: "Pro Plan",
    amount: 2900,
    currency: "USD",
    interval: "month",
    intervalCount: 1,
  };

  const mockPlanYearly: Plan = {
    id: "plan-pro-yearly",
    name: "Pro Plan Yearly",
    amount: 29000,
    currency: "USD",
    interval: "year",
    intervalCount: 1,
  };

  const mockAccount = {
    id: "account-1",
    tenantId: "tenant-1",
    externalCustomerId: "cus-stripe",
    email: "test@example.com",
    createdAt: new Date(),
  };

  const mockSubscription = {
    id: "sub-1",
    billingAccountId: "account-1",
    externalSubscriptionId: "sub-stripe",
    planId: "plan-pro",
    planVersionRef: planVersionRef("plan-pro@v1"),
    status: "active" as const,
    currentPeriodEnd: new Date(),
    cancelAtPeriodEnd: false,
    lastSyncedAt: new Date(),
  };

  const createPlanChangedEvent = (previousPlanId: string, newPlanId: string) =>
    new PlanChangedEvent(
      "tenant-1",
      previousPlanId,
      newPlanId,
      "sub-stripe",
      planVersionRef(`${previousPlanId}@v1`),
      planVersionRef(`${newPlanId}@v1`),
    );

  const primaryEventKey = (event: { readonly eventName: string; readonly eventId: string }) =>
    `${event.eventName}_${event.eventId}`;

  const legacyTimestampEventKey = (event: {
    readonly eventName: string;
    readonly timestamp: Date;
  }) => `${event.eventName}_${event.timestamp.getTime()}`;

  const createMetricsRepository = (): MetricsRepository => {
    const processedEventKeys = new Set<string>();

    return {
      recordMRRMovement: vi.fn(
        async (
          _tenantId: string,
          _movement: MRRMovement,
          _timestamp: Date,
          eventKey?: string,
          dedupeEventKeys: readonly string[] = [],
        ) => {
          const eventKeys = eventKey ? [eventKey, ...dedupeEventKeys] : [];
          if (eventKeys.some((key) => processedEventKeys.has(key))) {
            return;
          }

          for (const key of eventKeys) {
            processedEventKeys.add(key);
          }
        },
      ),
      recordSnapshot: vi.fn(),
      getSnapshot: vi.fn(),
      getMRRHistory: vi.fn(),
      getRetentionMetrics: vi.fn(),
    } as unknown as MetricsRepository;
  };

  beforeEach(() => {
    planRegistry = {
      getPlan: vi.fn(),
      getPlanVersion: vi.fn(),
      getAllPlans: vi.fn(),
      getPlanAtDate: vi.fn(),
    } as unknown as PlanRegistry;

    billingStore = {
      findAccountByTenantId: vi.fn(),
      findAccountByExternalId: vi.fn(),
      saveAccount: vi.fn(),
      findSubscription: vi.fn(),
      findSubscriptionByExternalId: vi.fn(),
      saveSubscription: vi.fn(),
      saveOrder: vi.fn(),
      findOrdersByAccount: vi.fn(),
    } as unknown as BillingStore;

    metricsRepository = createMetricsRepository();

    handler = new BillingEventHandler(planRegistry, billingStore, metricsRepository);
  });

  describe("OrderPaidEvent", () => {
    it("should record new MRR when order is paid", async () => {
      const event = new OrderPaidEvent("tenant-1", "order-1", 2900, "USD", "subscription_create");

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscription).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlan));

      await handler.handle(event);

      const expectedMovement: MRRMovement = {
        new: { amount: 2900, currency: "USD" },
        expansion: { amount: 0, currency: "USD" },
        contraction: { amount: 0, currency: "USD" },
        churned: { amount: 0, currency: "USD" },
        reactivation: { amount: 0, currency: "USD" },
        net: { amount: 2900, currency: "USD" },
      };

      expect(metricsRepository.recordMRRMovement).toHaveBeenCalledWith(
        "tenant-1",
        expectedMovement,
        event.timestamp,
        primaryEventKey(event),
        [legacyTimestampEventKey(event)],
      );
    });

    it("should normalize yearly plan to monthly MRR", async () => {
      const event = new OrderPaidEvent("tenant-1", "order-1", 29000, "USD", "subscription_create");

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscription).mockResolvedValue({
        ...mockSubscription,
        planId: "plan-pro-yearly",
      });
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlanYearly));

      await handler.handle(event);

      const callArgs = vi.mocked(metricsRepository.recordMRRMovement).mock.calls[0];
      const movement = callArgs[1];

      expect(movement.new.amount).toBeCloseTo(2416.67, 2);
    });

    it.each(["subscription_cycle", "subscription_update", "one_time"] as const)(
      "should not record MRR for %s payments",
      async (reason) => {
        const event = new OrderPaidEvent("tenant-1", `order-${reason}`, 2900, "USD", reason);

        await handler.handle(event);

        expect(billingStore.findAccountByTenantId).not.toHaveBeenCalled();
        expect(metricsRepository.recordMRRMovement).not.toHaveBeenCalled();
      },
    );

    it("should record reactivation MRR for authoritative reactivation payments", async () => {
      const event = new OrderPaidEvent(
        "tenant-1",
        "order-reactivation",
        2900,
        "USD",
        "subscription_reactivation",
      );

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscription).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlan));

      await handler.handle(event);

      expect(metricsRepository.recordMRRMovement).toHaveBeenCalledWith(
        "tenant-1",
        {
          new: { amount: 0, currency: "USD" },
          expansion: { amount: 0, currency: "USD" },
          contraction: { amount: 0, currency: "USD" },
          churned: { amount: 0, currency: "USD" },
          reactivation: { amount: 2900, currency: "USD" },
          net: { amount: 2900, currency: "USD" },
        },
        event.timestamp,
        primaryEventKey(event),
        [legacyTimestampEventKey(event)],
      );
    });

    it("should delegate duplicate prevention to repository across handler instances", async () => {
      const event = new OrderPaidEvent("tenant-1", "order-1", 2900, "USD", "subscription_create");

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscription).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlan));

      const firstHandler = new BillingEventHandler(planRegistry, billingStore, metricsRepository);
      const secondHandler = new BillingEventHandler(planRegistry, billingStore, metricsRepository);

      await firstHandler.handle(event);
      await secondHandler.handle(event);

      expect(metricsRepository.recordMRRMovement).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(metricsRepository.recordMRRMovement).mock.calls;
      expect(calls[0]?.[3]).toBe(primaryEventKey(event));
      expect(calls[0]?.[4]).toEqual([legacyTimestampEventKey(event)]);
      expect(calls[1]?.[3]).toBe(primaryEventKey(event));
      expect(calls[1]?.[4]).toEqual([legacyTimestampEventKey(event)]);
    });

    it.each([undefined, "legacy_unknown"])(
      "should reject invalid order payment reason %s before metric lookup",
      async (reason) => {
        const event = new OrderPaidEvent("tenant-1", "order-1", 2900, "USD", reason as never);

        const result = handler.handle(event);

        await expect(result).rejects.toBeInstanceOf(InvalidOrderPaymentReasonProblem);
        await expect(result).rejects.toMatchObject({
          code: "metrics-billing/invalid-order-payment-reason",
          extensions: { reason: typeof reason === "string" ? reason : null },
        });
        expect(billingStore.findAccountByTenantId).not.toHaveBeenCalled();
        expect(metricsRepository.recordMRRMovement).not.toHaveBeenCalled();
      },
    );

    it("should preserve distinct metrics for events with the same millisecond timestamp", async () => {
      const timestamp = new Date("2026-01-01T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(timestamp);

      try {
        const firstEvent = new OrderPaidEvent(
          "tenant-1",
          "order-1",
          2900,
          "USD",
          "subscription_create",
        );
        const secondEvent = new OrderPaidEvent(
          "tenant-1",
          "order-2",
          2900,
          "USD",
          "subscription_create",
        );

        vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
        vi.mocked(billingStore.findSubscription).mockResolvedValue(mockSubscription);
        vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlan));

        await handler.handle(firstEvent);
        await handler.handle(secondEvent);

        const calls = vi.mocked(metricsRepository.recordMRRMovement).mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0]?.[2]).toEqual(timestamp);
        expect(calls[1]?.[2]).toEqual(timestamp);
        expect(calls[0]?.[3]).toBe(primaryEventKey(firstEvent));
        expect(calls[1]?.[3]).toBe(primaryEventKey(secondEvent));
        expect(calls[0]?.[4]).toEqual([legacyTimestampEventKey(firstEvent)]);
        expect(calls[1]?.[4]).toEqual([legacyTimestampEventKey(secondEvent)]);
        expect(calls[0]?.[4]).toEqual(calls[1]?.[4]);
        expect(calls[0]?.[3]).not.toBe(calls[1]?.[3]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should surface dropped metric evidence if account is not found", async () => {
      const event = new OrderPaidEvent("tenant-1", "order-1", 2900, "USD", "subscription_create");

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(null);

      await expect(handler.handle(event)).rejects.toMatchObject({
        code: "metrics-billing/metric-dropped",
        extensions: expect.objectContaining({
          reason: "account_not_found",
          resourceId: "tenant-1",
        }),
      });

      expect(metricsRepository.recordMRRMovement).not.toHaveBeenCalled();
    });

    it("should surface dropped metric evidence if subscription is not found", async () => {
      const event = new OrderPaidEvent("tenant-1", "order-1", 2900, "USD", "subscription_create");

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscription).mockResolvedValue(null);

      const result = handler.handle(event);

      await expect(result).rejects.toBeInstanceOf(BillingMetricDroppedProblem);
      await expect(result).rejects.toMatchObject({
        extensions: expect.objectContaining({
          reason: "subscription_not_found",
          resourceId: "account-1",
        }),
      });

      expect(metricsRepository.recordMRRMovement).not.toHaveBeenCalled();
    });

    it("should surface repository failures as stable recording Problems", async () => {
      const event = new OrderPaidEvent("tenant-1", "order-1", 2900, "USD", "subscription_create");

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscription).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlan));
      vi.mocked(metricsRepository.recordMRRMovement).mockRejectedValueOnce(
        new BillingMetricRecordingProblem({
          eventName: "metrics.repository",
          tenantId: "tenant-1",
          eventKey: "repository-write",
        }),
      );

      const result = handler.handle(event);

      await expect(result).rejects.toBeInstanceOf(BillingMetricRecordingProblem);
      await expect(result).rejects.toMatchObject({
        code: "metrics-billing/recording-failed",
        extensions: expect.objectContaining({
          eventName: "billing.order_paid",
          tenantId: "tenant-1",
          eventKey: primaryEventKey(event),
        }),
      });
    });
  });

  describe("PlanChangedEvent", () => {
    it("uses the exact version references carried by a version-aware event", async () => {
      const basicVersion = asPlanVersion({
        id: "plan-basic",
        name: "Basic Plan",
        amount: 900,
        currency: "USD",
        interval: "month",
        intervalCount: 1,
      });
      const event = new PlanChangedEvent(
        "tenant-1",
        "plan-basic",
        "plan-pro",
        "sub-stripe",
        basicVersion.ref,
        mockSubscription.planVersionRef,
      );

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockImplementation((ref) => {
        if (ref === basicVersion.ref) return Promise.resolve(basicVersion);
        if (ref === mockSubscription.planVersionRef) {
          return Promise.resolve(asPlanVersion(mockPlan));
        }
        return Promise.resolve(null);
      });

      await handler.handle(event);

      expect(planRegistry.getPlan).not.toHaveBeenCalled();
      expect(metricsRepository.recordMRRMovement).toHaveBeenCalledWith(
        "tenant-1",
        expect.objectContaining({
          expansion: { amount: 2000, currency: "USD" },
        }),
        event.timestamp,
        primaryEventKey(event),
        [legacyTimestampEventKey(event)],
      );
    });

    it("should record expansion MRR when upgrading plan", async () => {
      const event = createPlanChangedEvent("plan-basic", "plan-pro");

      const basicPlan: Plan = {
        id: "plan-basic",
        name: "Basic Plan",
        amount: 900,
        currency: "USD",
        interval: "month",
        intervalCount: 1,
      };

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockImplementation((ref) => {
        if (ref === planVersionRef("plan-basic@v1")) {
          return Promise.resolve(asPlanVersion(basicPlan));
        }
        if (ref === planVersionRef("plan-pro@v1")) {
          return Promise.resolve(asPlanVersion(mockPlan));
        }
        return Promise.resolve(null);
      });

      await handler.handle(event);

      const callArgs = vi.mocked(metricsRepository.recordMRRMovement).mock.calls[0];
      const movement = callArgs[1];

      expect(movement.expansion.amount).toBe(2000);
      expect(movement.net.amount).toBe(2000);
    });

    it("should record contraction MRR when downgrading plan", async () => {
      const event = createPlanChangedEvent("plan-pro", "plan-basic");

      const basicPlan: Plan = {
        id: "plan-basic",
        name: "Basic Plan",
        amount: 900,
        currency: "USD",
        interval: "month",
        intervalCount: 1,
      };

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockImplementation((ref) => {
        if (ref === planVersionRef("plan-basic@v1")) {
          return Promise.resolve(asPlanVersion(basicPlan));
        }
        if (ref === planVersionRef("plan-pro@v1")) {
          return Promise.resolve(asPlanVersion(mockPlan));
        }
        return Promise.resolve(null);
      });

      await handler.handle(event);

      const callArgs = vi.mocked(metricsRepository.recordMRRMovement).mock.calls[0];
      const movement = callArgs[1];

      expect(movement.contraction.amount).toBe(2000);
      expect(movement.net.amount).toBe(-2000);
    });

    it("should pass event key to repository for plan changes", async () => {
      const event = createPlanChangedEvent("plan-basic", "plan-pro");

      const basicPlan: Plan = {
        id: "plan-basic",
        name: "Basic Plan",
        amount: 900,
        currency: "USD",
        interval: "month",
        intervalCount: 1,
      };

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockImplementation((ref) => {
        if (ref === planVersionRef("plan-basic@v1")) {
          return Promise.resolve(asPlanVersion(basicPlan));
        }
        if (ref === planVersionRef("plan-pro@v1")) {
          return Promise.resolve(asPlanVersion(mockPlan));
        }
        return Promise.resolve(null);
      });

      await handler.handle(event);

      expect(metricsRepository.recordMRRMovement).toHaveBeenCalledWith(
        "tenant-1",
        expect.any(Object),
        event.timestamp,
        primaryEventKey(event),
        [legacyTimestampEventKey(event)],
      );
    });

    it("should record unchanged movement when the normalized MRR delta is zero", async () => {
      const event = createPlanChangedEvent("plan-pro", "plan-pro-yearly");

      const equivalentMonthlyPlan: Plan = {
        id: "plan-pro-yearly",
        name: "Pro Plan Yearly Equivalent",
        amount: 34800,
        currency: "USD",
        interval: "year",
        intervalCount: 1,
      };

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockImplementation((ref) => {
        if (ref === planVersionRef("plan-pro@v1")) {
          return Promise.resolve(asPlanVersion(mockPlan));
        }
        if (ref === planVersionRef("plan-pro-yearly@v1")) {
          return Promise.resolve(asPlanVersion(equivalentMonthlyPlan));
        }
        return Promise.resolve(null);
      });

      await handler.handle(event);

      const callArgs = vi.mocked(metricsRepository.recordMRRMovement).mock.calls[0];
      const movement = callArgs?.[1];

      expect(movement).toEqual({
        new: { amount: 0, currency: "USD" },
        expansion: { amount: 0, currency: "USD" },
        contraction: { amount: 0, currency: "USD" },
        churned: { amount: 0, currency: "USD" },
        reactivation: { amount: 0, currency: "USD" },
        net: { amount: 0, currency: "USD" },
      });
    });

    it("should surface missing plan evidence without recording a metric", async () => {
      const event = createPlanChangedEvent("plan-basic", "plan-pro");

      vi.mocked(billingStore.findAccountByTenantId).mockResolvedValue(mockAccount);
      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockImplementation((ref) => {
        if (ref === planVersionRef("plan-basic@v1")) return Promise.resolve(null);
        if (ref === planVersionRef("plan-pro@v1")) {
          return Promise.resolve(asPlanVersion(mockPlan));
        }
        return Promise.resolve(null);
      });

      await expect(handler.handle(event)).rejects.toMatchObject({
        code: "metrics-billing/metric-dropped",
        extensions: expect.objectContaining({
          reason: "plan_not_found",
          resourceId: "plan-basic",
          tenantId: "tenant-1",
          eventKey: primaryEventKey(event),
        }),
      });
      expect(metricsRepository.recordMRRMovement).not.toHaveBeenCalled();
    });
  });

  describe("SubscriptionCanceledEvent", () => {
    it("should not record churned MRR when cancellation is scheduled for period end", async () => {
      const event = new SubscriptionCanceledEvent("tenant-1", "sub-stripe", true);

      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlan));

      await handler.handle(event);

      expect(metricsRepository.recordMRRMovement).not.toHaveBeenCalled();
      expect(billingStore.findSubscriptionByExternalId).not.toHaveBeenCalled();
      expect(planRegistry.getPlanVersion).not.toHaveBeenCalled();
    });

    it("should record churned MRR when cancellation takes effect immediately", async () => {
      const event = new SubscriptionCanceledEvent("tenant-1", "sub-stripe", false);

      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlan));

      await handler.handle(event);

      const expectedMovement: MRRMovement = {
        new: { amount: 0, currency: "USD" },
        expansion: { amount: 0, currency: "USD" },
        contraction: { amount: 0, currency: "USD" },
        churned: { amount: 2900, currency: "USD" },
        reactivation: { amount: 0, currency: "USD" },
        net: { amount: -2900, currency: "USD" },
      };

      expect(metricsRepository.recordMRRMovement).toHaveBeenCalledWith(
        "tenant-1",
        expectedMovement,
        event.timestamp,
        primaryEventKey(event),
        [legacyTimestampEventKey(event)],
      );
    });

    it.each([
      [mockPlan, 2900],
      [mockPlanYearly, 29000 / 12],
      [{ ...mockPlan, amount: 5800, intervalCount: 2 }, 2900],
    ])(
      "should record churn from the event plan after subscription deletion: %j",
      async (plan, amount) => {
        const ref = planVersionRef(`${plan.id}@v1`);
        const event = new SubscriptionCanceledEvent(
          "tenant-1",
          "sub-stripe",
          false,
          "cancel-1",
          ref,
        );
        vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(null);
        vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(plan));

        await handler.handle(event);

        expect(billingStore.findSubscriptionByExternalId).not.toHaveBeenCalled();
        expect(planRegistry.getPlanVersion).toHaveBeenCalledWith(ref);
        expect(metricsRepository.recordMRRMovement).toHaveBeenCalledWith(
          "tenant-1",
          expect.objectContaining({
            churned: { amount, currency: plan.currency },
            net: { amount: -amount, currency: plan.currency },
          }),
          event.timestamp,
          primaryEventKey(event),
          [legacyTimestampEventKey(event)],
        );
      },
    );

    it("should prefer the cancellation plan over a subsequently changed subscription", async () => {
      const ref = planVersionRef("plan-pro@v1");
      const event = new SubscriptionCanceledEvent("tenant-1", "sub-stripe", false, undefined, ref);
      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue({
        ...mockSubscription,
        planVersionRef: planVersionRef("plan-pro@v2"),
      });
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlan));

      await handler.handle(event);

      expect(planRegistry.getPlanVersion).toHaveBeenCalledWith(ref);
      expect(billingStore.findSubscriptionByExternalId).not.toHaveBeenCalled();
    });

    it("should report a missing event plan without substituting the current subscription plan", async () => {
      const ref = planVersionRef("plan-pro@v0");
      const event = new SubscriptionCanceledEvent("tenant-1", "sub-stripe", false, undefined, ref);
      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(null);

      await expect(handler.handle(event)).rejects.toMatchObject({
        code: "metrics-billing/metric-dropped",
        extensions: expect.objectContaining({ reason: "plan_not_found", resourceId: ref }),
      });
      expect(billingStore.findSubscriptionByExternalId).not.toHaveBeenCalled();
      expect(metricsRepository.recordMRRMovement).not.toHaveBeenCalled();
    });

    it("should surface repository failures when recording cancellation from its event plan", async () => {
      const event = new SubscriptionCanceledEvent(
        "tenant-1",
        "sub-stripe",
        false,
        undefined,
        mockSubscription.planVersionRef,
      );
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlan));
      vi.mocked(metricsRepository.recordMRRMovement).mockRejectedValue(
        new Error("repository unavailable"),
      );

      await expect(handler.handle(event)).rejects.toBeInstanceOf(BillingMetricRecordingProblem);
      expect(billingStore.findSubscriptionByExternalId).not.toHaveBeenCalled();
    });

    it("should pass event key to repository for cancellation events", async () => {
      const event = new SubscriptionCanceledEvent("tenant-1", "sub-stripe", false);

      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(mockSubscription);
      vi.mocked(planRegistry.getPlanVersion).mockResolvedValue(asPlanVersion(mockPlan));

      await handler.handle(event);

      expect(metricsRepository.recordMRRMovement).toHaveBeenCalledWith(
        "tenant-1",
        expect.any(Object),
        event.timestamp,
        primaryEventKey(event),
        [legacyTimestampEventKey(event)],
      );
    });

    it("should surface dropped metric evidence if subscription is not found", async () => {
      const event = new SubscriptionCanceledEvent("tenant-1", "sub-stripe", false);

      vi.mocked(billingStore.findSubscriptionByExternalId).mockResolvedValue(null);

      await expect(handler.handle(event)).rejects.toMatchObject({
        code: "metrics-billing/metric-dropped",
        extensions: expect.objectContaining({
          reason: "subscription_not_found",
          resourceId: "sub-stripe",
        }),
      });

      expect(metricsRepository.recordMRRMovement).not.toHaveBeenCalled();
    });
  });
});
