import { IdempotencyConflictProblem, InMemoryIdempotencyStore } from "@croco/idempotency-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingGateway, CheckoutResult } from "../libs/BillingGateway";
import { BillingService, type BillingLifecycleEventPublisher } from "../libs/BillingService";
import { InMemoryBillingStore } from "../libs/InMemoryBillingStore";
import {
  BillingCheckoutCreationProblem,
  BillingCheckoutInProgressProblem,
} from "../libs/problems/BillingProblems";
import type { BillingAccount, Subscription } from "../types";

const PLAN_VERSION_REF = "plan-pro@v1" as Subscription["planVersionRef"];

describe("BillingService", () => {
  let store!: InMemoryBillingStore;
  let mockGateway!: BillingGateway;
  let service!: BillingService;

  beforeEach(() => {
    store = new InMemoryBillingStore();
    mockGateway = {
      ensureCustomer: vi.fn(),
      createCheckout: vi.fn(),
      reconcileCheckout: vi.fn(),
      cancelSubscription: vi.fn(),
      resumeSubscription: vi.fn(),
      getCustomerPortalUrl: vi.fn(),
    };
    service = new BillingService({
      store,
      gateway: mockGateway,
      checkoutIdempotencyStore: new InMemoryIdempotencyStore(),
    });
  });

  async function saveBillingAccount(
    tenantId: string,
    billingAccountId = tenantId,
    email = "test@example.com",
  ) {
    const account: BillingAccount = {
      id: billingAccountId,
      tenantId,
      externalCustomerId: `ext-${billingAccountId}`,
      email,
      createdAt: new Date(),
    };

    await store.saveAccount(account);
    return account;
  }

  describe("hasActiveSubscription", () => {
    it("should return false when no subscription exists", async () => {
      const result = await service.hasActiveSubscription("tenant-1");
      expect(result).toBe(false);
    });

    it("should return true when subscription status is active", async () => {
      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);

      const result = await service.hasActiveSubscription("tenant-1");
      expect(result).toBe(true);
    });

    it("should return true when subscription status is trialing", async () => {
      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "trialing",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);

      const result = await service.hasActiveSubscription("tenant-1");
      expect(result).toBe(true);
    });

    it("should return false when subscription status is canceled", async () => {
      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "canceled",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);

      const result = await service.hasActiveSubscription("tenant-1");
      expect(result).toBe(false);
    });

    it("should return false when subscription status is past_due", async () => {
      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "past_due",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);

      const result = await service.hasActiveSubscription("tenant-1");
      expect(result).toBe(false);
    });

    it("should return false when subscription status is revoked", async () => {
      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "revoked",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);

      const result = await service.hasActiveSubscription("tenant-1");
      expect(result).toBe(false);
    });
  });

  describe("getSubscriptionStatus", () => {
    it("should return null when no subscription exists", async () => {
      const result = await service.getSubscriptionStatus("tenant-1");
      expect(result).toBeNull();
    });

    it("should return subscription status when subscription exists", async () => {
      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);

      const result = await service.getSubscriptionStatus("tenant-1");
      expect(result).toBe("active");
    });
  });

  describe("getSubscription", () => {
    it("should return null when no subscription exists", async () => {
      const result = await service.getSubscription("tenant-1");
      expect(result).toBeNull();
    });

    it("should return subscription when it exists", async () => {
      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);

      const result = await service.getSubscription("tenant-1");
      expect(result).toEqual(subscription);
    });
  });

  describe("createCheckout", () => {
    it("should create one provider checkout for concurrent equivalent requests", async () => {
      const params = {
        tenantId: "tenant-concurrent",
        email: "concurrent@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-concurrent",
      };
      const originalFindAccount = store.findAccountByTenantId.bind(store);
      let waitingReaders = 0;
      let releaseReaders!: () => void;
      const readersReady = new Promise<void>((resolve) => {
        releaseReaders = resolve;
      });

      vi.spyOn(store, "findAccountByTenantId").mockImplementation(async (tenantId) => {
        const account = await originalFindAccount(tenantId);
        if (account === null) {
          waitingReaders += 1;
          if (waitingReaders === 2) {
            releaseReaders();
          }
          await readersReady;
        }
        return account;
      });
      vi.mocked(mockGateway.ensureCustomer).mockResolvedValue("ext-cust-concurrent");
      vi.mocked(mockGateway.createCheckout).mockResolvedValue({
        checkoutUrl: "https://checkout.example.com/concurrent",
        checkoutId: "checkout-concurrent",
      });

      const results = await Promise.all([
        service.createCheckout(params),
        service.createCheckout(params),
      ]);

      expect(results).toEqual([
        { checkoutUrl: "https://checkout.example.com/concurrent" },
        { checkoutUrl: "https://checkout.example.com/concurrent" },
      ]);
      expect(mockGateway.ensureCustomer).toHaveBeenCalledTimes(1);
      expect(mockGateway.createCheckout).toHaveBeenCalledTimes(1);
    });

    it("should allow only one provider checkout across service instances sharing a store", async () => {
      const params = {
        tenantId: "tenant-distributed",
        email: "distributed@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-distributed",
      };
      const idempotencyStore = new InMemoryIdempotencyStore<CheckoutResult>();
      const firstService = new BillingService({
        store,
        gateway: mockGateway,
        checkoutIdempotencyStore: idempotencyStore,
      });
      const secondService = new BillingService({
        store,
        gateway: mockGateway,
        checkoutIdempotencyStore: idempotencyStore,
      });
      let releaseProvider!: (checkout: CheckoutResult) => void;
      const providerResponse = new Promise<CheckoutResult>((resolve) => {
        releaseProvider = resolve;
      });

      vi.mocked(mockGateway.ensureCustomer).mockResolvedValue("ext-cust-distributed");
      vi.mocked(mockGateway.createCheckout).mockReturnValue(providerResponse);
      vi.mocked(mockGateway.reconcileCheckout).mockResolvedValue(null);

      const first = firstService.createCheckout(params);
      await vi.waitFor(() => {
        expect(mockGateway.createCheckout).toHaveBeenCalledTimes(1);
      });
      const second = secondService.createCheckout(params);

      await expect(second).rejects.toThrow(BillingCheckoutInProgressProblem);
      releaseProvider({
        checkoutUrl: "https://checkout.example.com/distributed",
        checkoutId: "checkout-distributed",
      });
      await expect(first).resolves.toEqual({
        checkoutUrl: "https://checkout.example.com/distributed",
      });
      expect(mockGateway.createCheckout).toHaveBeenCalledTimes(1);
      expect(mockGateway.reconcileCheckout).toHaveBeenCalledTimes(1);
    });

    it("should not commit a checkout reservation owned by another service instance", async () => {
      const params = {
        tenantId: "tenant-foreign-reservation",
        email: "foreign-reservation@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-foreign-reservation",
      };
      const idempotencyStore = new InMemoryIdempotencyStore<CheckoutResult>();
      const firstService = new BillingService({
        store,
        gateway: mockGateway,
        checkoutIdempotencyStore: idempotencyStore,
      });
      const secondService = new BillingService({
        store,
        gateway: mockGateway,
        checkoutIdempotencyStore: idempotencyStore,
      });
      const checkout = {
        checkoutUrl: "https://checkout.example.com/foreign-reservation",
        checkoutId: "checkout-foreign-reservation",
      };
      let releaseProvider!: (checkout: CheckoutResult) => void;
      const providerResponse = new Promise<CheckoutResult>((resolve) => {
        releaseProvider = resolve;
      });
      const commit = vi.spyOn(idempotencyStore, "commit");

      vi.mocked(mockGateway.ensureCustomer).mockResolvedValue("ext-cust-foreign-reservation");
      vi.mocked(mockGateway.createCheckout).mockReturnValue(providerResponse);
      vi.mocked(mockGateway.reconcileCheckout).mockResolvedValue(checkout);

      const ownerRequest = firstService.createCheckout(params);
      await vi.waitFor(() => {
        expect(mockGateway.createCheckout).toHaveBeenCalledTimes(1);
      });

      await expect(secondService.createCheckout(params)).resolves.toEqual({
        checkoutUrl: checkout.checkoutUrl,
      });
      expect(commit).not.toHaveBeenCalled();

      releaseProvider(checkout);
      await expect(ownerRequest).resolves.toEqual({ checkoutUrl: checkout.checkoutUrl });
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it("should retry an abandoned checkout after its reservation expires", async () => {
      const params = {
        tenantId: "tenant-expired-reservation",
        email: "expired-reservation@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-expired-reservation",
      };
      let now = new Date("2026-01-01T00:00:00.000Z");
      const idempotencyStore = new InMemoryIdempotencyStore<CheckoutResult>({ now: () => now });
      const serviceWithExpiringReservation = new BillingService({
        store,
        gateway: mockGateway,
        checkoutIdempotencyStore: idempotencyStore,
        checkoutReservationTtlMs: 100,
      });
      const checkout = {
        checkoutUrl: "https://checkout.example.com/expired-reservation",
        checkoutId: "checkout-expired-reservation",
      };

      vi.mocked(mockGateway.ensureCustomer).mockResolvedValue("ext-cust-expired-reservation");
      vi.mocked(mockGateway.createCheckout)
        .mockRejectedValueOnce(new BillingCheckoutInProgressProblem(params.tenantId))
        .mockResolvedValueOnce(checkout);

      await expect(serviceWithExpiringReservation.createCheckout(params)).rejects.toThrow(
        BillingCheckoutInProgressProblem,
      );
      now = new Date(now.getTime() + 101);
      await expect(serviceWithExpiringReservation.createCheckout(params)).resolves.toEqual({
        checkoutUrl: checkout.checkoutUrl,
      });
      expect(mockGateway.createCheckout).toHaveBeenCalledTimes(2);
    });

    it("should replay a completed checkout without another provider call", async () => {
      const params = {
        tenantId: "tenant-replay",
        email: "replay@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-replay",
      };
      vi.mocked(mockGateway.ensureCustomer).mockResolvedValue("ext-cust-replay");
      vi.mocked(mockGateway.createCheckout).mockResolvedValue({
        checkoutUrl: "https://checkout.example.com/replay",
        checkoutId: "checkout-replay",
      });

      const first = await service.createCheckout(params);
      const replay = await service.createCheckout(params);

      expect(replay).toEqual(first);
      expect(mockGateway.createCheckout).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["productId", { productId: "product-2" }],
      ["successUrl", { successUrl: "https://example.com/other-success" }],
      ["cancelUrl", { cancelUrl: "https://example.com/other-cancel" }],
    ])("should reject idempotency key reuse with a different %s", async (_field, changed) => {
      const params = {
        tenantId: "tenant-conflict",
        email: "conflict@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-conflict",
      };
      vi.mocked(mockGateway.ensureCustomer).mockResolvedValue("ext-cust-conflict");
      vi.mocked(mockGateway.createCheckout).mockResolvedValue({
        checkoutUrl: "https://checkout.example.com/conflict",
        checkoutId: "checkout-conflict",
      });

      await service.createCheckout(params);

      await expect(service.createCheckout({ ...params, ...changed })).rejects.toThrow(
        IdempotencyConflictProblem,
      );
      expect(mockGateway.createCheckout).toHaveBeenCalledTimes(1);
    });

    it("should reconcile an ambiguous provider response without creating again", async () => {
      const params = {
        tenantId: "tenant-ambiguous",
        email: "ambiguous@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-ambiguous",
      };
      vi.mocked(mockGateway.ensureCustomer).mockResolvedValue("ext-cust-ambiguous");
      vi.mocked(mockGateway.createCheckout).mockRejectedValueOnce(
        new BillingCheckoutInProgressProblem(params.tenantId),
      );
      vi.mocked(mockGateway.reconcileCheckout).mockResolvedValue({
        checkoutUrl: "https://checkout.example.com/ambiguous",
        checkoutId: "checkout-ambiguous",
      });

      await expect(service.createCheckout(params)).rejects.toThrow(
        BillingCheckoutInProgressProblem,
      );
      await expect(service.createCheckout(params)).resolves.toEqual({
        checkoutUrl: "https://checkout.example.com/ambiguous",
      });

      expect(mockGateway.createCheckout).toHaveBeenCalledTimes(1);
      expect(mockGateway.reconcileCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: vi.mocked(mockGateway.createCheckout).mock.calls[0]?.[0].idempotencyKey,
        }),
      );
    });

    it("should reconcile after the provider succeeds but committing the response fails", async () => {
      const params = {
        tenantId: "tenant-commit-recovery",
        email: "commit-recovery@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-commit-recovery",
      };
      const idempotencyStore = new InMemoryIdempotencyStore<CheckoutResult>();
      const serviceWithCommitFailure = new BillingService({
        store,
        gateway: mockGateway,
        checkoutIdempotencyStore: idempotencyStore,
      });
      const checkout = {
        checkoutUrl: "https://checkout.example.com/commit-recovery",
        checkoutId: "checkout-commit-recovery",
      };

      const storageError = new Error("store unavailable");
      vi.spyOn(idempotencyStore, "commit").mockRejectedValueOnce(storageError);
      vi.mocked(mockGateway.ensureCustomer).mockResolvedValue("ext-cust-commit-recovery");
      vi.mocked(mockGateway.createCheckout).mockResolvedValue(checkout);
      vi.mocked(mockGateway.reconcileCheckout).mockResolvedValue(checkout);

      const failedCheckout = serviceWithCommitFailure.createCheckout(params);
      await expect(failedCheckout).rejects.toThrow(BillingCheckoutInProgressProblem);
      await expect(failedCheckout).rejects.toMatchObject({ cause: storageError });
      await expect(serviceWithCommitFailure.createCheckout(params)).resolves.toEqual({
        checkoutUrl: checkout.checkoutUrl,
      });

      expect(mockGateway.createCheckout).toHaveBeenCalledTimes(1);
      expect(mockGateway.reconcileCheckout).toHaveBeenCalledTimes(1);
    });

    it("should create new customer and return checkout URL", async () => {
      const params = {
        tenantId: "tenant-1",
        email: "test@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-new-customer",
      };

      const mockCheckoutResult: CheckoutResult = {
        checkoutUrl: "https://checkout.example.com/abc123",
        checkoutId: "checkout-1",
      };

      vi.mocked(mockGateway.ensureCustomer).mockResolvedValue("ext-cust-1");
      vi.mocked(mockGateway.createCheckout).mockResolvedValue(mockCheckoutResult);

      const result = await service.createCheckout(params);

      expect(mockGateway.ensureCustomer).toHaveBeenCalledWith("tenant-1", "test@example.com");
      expect(mockGateway.createCheckout).toHaveBeenCalledWith({
        billingAccountId: "tenant-1",
        email: "test@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: expect.stringContaining("billing-checkout"),
      });
      expect(result).toEqual({ checkoutUrl: "https://checkout.example.com/abc123" });

      const account = await store.findAccountByTenantId("tenant-1");
      expect(account).toEqual({
        id: "tenant-1",
        tenantId: "tenant-1",
        externalCustomerId: "ext-cust-1",
        email: "test@example.com",
        createdAt: expect.any(Date),
      });
    });

    it("should use existing customer and return checkout URL", async () => {
      await store.saveAccount({
        id: "account-1",
        tenantId: "tenant-1",
        externalCustomerId: "ext-cust-1",
        email: "test@example.com",
        createdAt: new Date(),
      });

      const params = {
        tenantId: "tenant-1",
        email: "test@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-existing-customer",
      };

      const mockCheckoutResult: CheckoutResult = {
        checkoutUrl: "https://checkout.example.com/abc123",
        checkoutId: "checkout-1",
      };

      vi.mocked(mockGateway.createCheckout).mockResolvedValue(mockCheckoutResult);

      const result = await service.createCheckout(params);

      expect(mockGateway.ensureCustomer).not.toHaveBeenCalled();
      expect(mockGateway.createCheckout).toHaveBeenCalledWith({
        billingAccountId: "account-1",
        email: "test@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: expect.stringContaining("billing-checkout"),
      });
      expect(result).toEqual({ checkoutUrl: "https://checkout.example.com/abc123" });
    });

    it("should keep the created account when checkout creation fails after customer creation", async () => {
      const params = {
        tenantId: "tenant-bug-09",
        email: "bug09@example.com",
        productId: "product-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        idempotencyKey: "checkout-failure",
      };

      vi.mocked(mockGateway.ensureCustomer).mockResolvedValue("ext-cust-bug-09");
      vi.mocked(mockGateway.createCheckout).mockRejectedValue(new Error("payment failed"));

      const checkoutPromise = service.createCheckout(params);

      await expect(checkoutPromise).rejects.toThrow(BillingCheckoutCreationProblem);
      await expect(checkoutPromise).rejects.toThrow(
        "Failed to create checkout for tenant tenant-bug-09: payment failed",
      );

      const account = await store.findAccountByTenantId("tenant-bug-09");
      expect(account).toEqual({
        id: "tenant-bug-09",
        tenantId: "tenant-bug-09",
        externalCustomerId: "ext-cust-bug-09",
        email: "bug09@example.com",
        createdAt: expect.any(Date),
      });
    });

    it("should resolve subscription state through the billing account id linked to a tenant", async () => {
      await store.saveAccount({
        id: "account-2",
        tenantId: "tenant-2",
        externalCustomerId: "ext-cust-2",
        email: "tenant2@example.com",
        createdAt: new Date(),
      });

      await store.saveSubscription({
        id: "sub-2",
        billingAccountId: "account-2",
        externalSubscriptionId: "ext-sub-2",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      });

      expect(await service.hasActiveSubscription("tenant-2")).toBe(true);
      expect(await service.getSubscriptionStatus("tenant-2")).toBe("active");
      expect(await service.getSubscription("tenant-2")).toMatchObject({
        billingAccountId: "account-2",
      });
    });
  });

  describe("cancelSubscription", () => {
    it("should cancel subscription at period end and update status", async () => {
      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);

      const command = await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "cancel-period-end-1",
      });

      expect(mockGateway.cancelSubscription).toHaveBeenCalledWith("ext-sub-1", false, {
        idempotencyKey: "cancel-period-end-1",
      });
      expect(command.state).toBe("completed");

      const updatedSubscription = await store.findSubscription("tenant-1");
      expect(updatedSubscription?.cancelAtPeriodEnd).toBe(true);
      expect(updatedSubscription?.status).toBe("active");
      expect(updatedSubscription?.lastSyncedAt).toBeInstanceOf(Date);
    });

    it.each(["active", "trialing"] as const)(
      "should preserve a no-order account when its %s subscription is canceled immediately",
      async (status) => {
        const account = await saveBillingAccount("tenant-1", "account-1");

        const subscription: Subscription = {
          id: "sub-1",
          billingAccountId: account.id,
          externalSubscriptionId: "ext-sub-1",
          planId: "plan-pro",
          planVersionRef: PLAN_VERSION_REF,
          status,
          currentPeriodEnd: new Date(),
          cancelAtPeriodEnd: false,
          lastSyncedAt: new Date(),
        };
        await store.saveSubscription(subscription);

        const command = await service.cancelSubscription({
          tenantId: "tenant-1",
          idempotencyKey: "cancel-immediate-1",
          immediate: true,
        });

        expect(mockGateway.cancelSubscription).toHaveBeenCalledWith("ext-sub-1", true, {
          idempotencyKey: "cancel-immediate-1",
        });
        expect(command.state).toBe("completed");
        expect(await store.findOrdersByAccount(account.id)).toEqual([]);
        expect(await store.findSubscription(account.id)).toBeNull();
        expect(
          await store.findSubscriptionByExternalId(subscription.externalSubscriptionId),
        ).toBeNull();
        expect(await store.findAccountByTenantId(account.tenantId)).toEqual(account);
        expect(await store.findAccountByExternalId(account.externalCustomerId)).toEqual(account);
        vi.mocked(mockGateway.getCustomerPortalUrl).mockResolvedValue(
          "https://billing.example.com/portal",
        );
        await expect(service.getCustomerPortalUrl(account.tenantId)).resolves.toBe(
          "https://billing.example.com/portal",
        );
        expect(mockGateway.getCustomerPortalUrl).toHaveBeenCalledWith(account.externalCustomerId);

        await service.cancelSubscription({
          tenantId: account.tenantId,
          idempotencyKey: "cancel-immediate-1",
          immediate: true,
        });
        expect(mockGateway.cancelSubscription).toHaveBeenCalledTimes(1);
        expect(await store.findAccountByTenantId(account.tenantId)).toEqual(account);
      },
    );

    it("should keep billing history when immediate cancellation has existing orders", async () => {
      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);
      await store.saveOrder({
        id: "order-1",
        billingAccountId: "tenant-1",
        externalOrderId: "ext-order-1",
        amount: 2900,
        currency: "USD",
        reason: "subscription_cycle",
        paidAt: new Date(),
      });

      await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "cancel-immediate-history-1",
        immediate: true,
      });

      const updatedSubscription = await store.findSubscription("tenant-1");
      expect(updatedSubscription?.cancelAtPeriodEnd).toBe(false);
      expect(updatedSubscription?.status).toBe("canceled");
      expect(updatedSubscription?.lastSyncedAt).toBeInstanceOf(Date);
      expect(await store.findAccountByTenantId("tenant-1")).not.toBeNull();
    });

    it("should throw error when no subscription exists", async () => {
      await expect(
        service.cancelSubscription({
          tenantId: "tenant-1",
          idempotencyKey: "cancel-missing-1",
        }),
      ).rejects.toThrow("No subscription found for tenant 'tenant-1'");
    });

    it("should publish SubscriptionCanceledEvent when eventPublisher is provided", async () => {
      const mockEventPublisher = {
        publishIdempotently: vi.fn(),
      };

      const serviceWithPublisher = new BillingService({
        store,
        gateway: mockGateway,
        checkoutIdempotencyStore: new InMemoryIdempotencyStore(),
        eventPublisher: mockEventPublisher as BillingLifecycleEventPublisher,
      });

      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);

      await serviceWithPublisher.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "cancel-event-1",
      });

      expect(mockEventPublisher.publishIdempotently).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-1",
          externalSubscriptionId: "ext-sub-1",
          cancelAtPeriodEnd: true,
        }),
      );
    });

    it("should retry ambiguous event delivery through an idempotent publisher", async () => {
      const deliveredEventIds = new Set<string>();
      let deliveredSideEffects = 0;
      let rejectAfterFirstDelivery = true;
      const mockEventPublisher = {
        publishIdempotently: vi.fn(async (event: { eventId: string }) => {
          if (!deliveredEventIds.has(event.eventId)) {
            deliveredEventIds.add(event.eventId);
            deliveredSideEffects += 1;
          }
          if (rejectAfterFirstDelivery) {
            rejectAfterFirstDelivery = false;
            throw new Error("ambiguous event bus result");
          }
        }),
      };
      const serviceWithPublisher = new BillingService({
        store,
        gateway: mockGateway,
        checkoutIdempotencyStore: new InMemoryIdempotencyStore(),
        eventPublisher: mockEventPublisher as BillingLifecycleEventPublisher,
      });
      await saveBillingAccount("tenant-1");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      });

      const pending = await serviceWithPublisher.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "cancel-event-retry-1",
      });
      const completed =
        await serviceWithPublisher.reconcileLifecycleCommand("cancel-event-retry-1");

      expect(pending).toMatchObject({
        state: "pending_event",
        lastFailure: {
          stage: "event",
          code: "billing/lifecycle-event-failed",
          attempt: 1,
        },
      });
      expect(completed.state).toBe("completed");
      expect(mockGateway.cancelSubscription).toHaveBeenCalledTimes(1);
      expect(mockEventPublisher.publishIdempotently).toHaveBeenCalledTimes(2);
      expect(mockEventPublisher.publishIdempotently.mock.calls[0]?.[0].eventId).toBe(
        "billing-lifecycle:cancel-event-retry-1",
      );
      expect(mockEventPublisher.publishIdempotently.mock.calls[1]?.[0].eventId).toBe(
        "billing-lifecycle:cancel-event-retry-1",
      );
      expect(deliveredSideEffects).toBe(1);
    });

    it("should lease event delivery so concurrent reconcilers publish only once", async () => {
      let releaseDelivery!: () => void;
      let signalDeliveryStarted!: () => void;
      const deliveryStarted = new Promise<void>((resolve) => {
        signalDeliveryStarted = resolve;
      });
      const deliveryBlocked = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const mockEventPublisher = {
        publishIdempotently: vi
          .fn()
          .mockRejectedValueOnce(new Error("event bus unavailable"))
          .mockImplementationOnce(async () => {
            signalDeliveryStarted();
            await deliveryBlocked;
          }),
      };
      const serviceWithPublisher = new BillingService({
        store,
        gateway: mockGateway,
        checkoutIdempotencyStore: new InMemoryIdempotencyStore(),
        eventPublisher: mockEventPublisher as BillingLifecycleEventPublisher,
      });
      await saveBillingAccount("tenant-1");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(),
      });
      await serviceWithPublisher.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "cancel-event-lease-1",
      });

      const firstReconciliation =
        serviceWithPublisher.reconcileLifecycleCommand("cancel-event-lease-1");
      await deliveryStarted;
      const competingResult =
        await serviceWithPublisher.reconcileLifecycleCommand("cancel-event-lease-1");

      expect(competingResult.state).toBe("pending_event");
      expect(mockEventPublisher.publishIdempotently).toHaveBeenCalledTimes(2);

      releaseDelivery();
      await expect(firstReconciliation).resolves.toMatchObject({ state: "completed" });
      expect(mockEventPublisher.publishIdempotently).toHaveBeenCalledTimes(2);
    });

    it.each([
      { immediate: false, idempotencyKey: "superseded-period-end-1" },
      { immediate: true, idempotencyKey: "superseded-immediate-1" },
    ])(
      "should not mutate a replacement subscription during stale reconciliation",
      async ({ immediate, idempotencyKey }) => {
        await saveBillingAccount("tenant-1");
        await store.saveSubscription({
          id: "sub-old",
          billingAccountId: "tenant-1",
          externalSubscriptionId: "ext-sub-old",
          planId: "plan-old",
          planVersionRef: PLAN_VERSION_REF,
          status: "active",
          currentPeriodEnd: new Date(),
          cancelAtPeriodEnd: false,
          lastSyncedAt: new Date(),
        });
        vi.mocked(mockGateway.cancelSubscription).mockImplementationOnce(async () => {
          await store.saveSubscription({
            id: "sub-new",
            billingAccountId: "tenant-1",
            externalSubscriptionId: "ext-sub-new",
            planId: "plan-new",
            planVersionRef: PLAN_VERSION_REF,
            status: "active",
            currentPeriodEnd: new Date("2031-01-01T00:00:00.000Z"),
            cancelAtPeriodEnd: false,
            lastSyncedAt: new Date(),
          });
        });

        const command = await service.cancelSubscription({
          tenantId: "tenant-1",
          idempotencyKey,
          immediate,
        });

        expect(command).toMatchObject({ state: "completed", localResult: "superseded" });
        expect(await store.findSubscription("tenant-1")).toMatchObject({
          id: "sub-new",
          externalSubscriptionId: "ext-sub-new",
          planId: "plan-new",
          status: "active",
          cancelAtPeriodEnd: false,
        });
        expect(await store.findAccountByTenantId("tenant-1")).not.toBeNull();
      },
    );

    it("should not overwrite a newer version of the same external subscription", async () => {
      await saveBillingAccount("tenant-1");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-old",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      vi.mocked(mockGateway.cancelSubscription).mockImplementationOnce(async () => {
        await store.saveSubscription({
          id: "sub-1",
          billingAccountId: "tenant-1",
          externalSubscriptionId: "ext-sub-1",
          planId: "plan-new",
          planVersionRef: PLAN_VERSION_REF,
          status: "active",
          currentPeriodEnd: new Date("2031-01-01T00:00:00.000Z"),
          cancelAtPeriodEnd: false,
          lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
        });
      });

      const command = await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "superseded-version-1",
      });

      expect(command).toMatchObject({ state: "completed", localResult: "applied" });
      expect(await store.findSubscription("tenant-1")).toMatchObject({
        planId: "plan-new",
        currentPeriodEnd: new Date("2031-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: true,
      });
    });

    it("should rebase immediate cancellation onto newer retained subscription history", async () => {
      await saveBillingAccount("tenant-1");
      const lastSyncedAt = new Date("2026-01-01T00:00:00.000Z");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-old",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt,
      });
      await store.saveOrder({
        id: "order-1",
        billingAccountId: "tenant-1",
        externalOrderId: "ext-order-1",
        amount: 1000,
        currency: "USD",
        reason: "subscription_cycle",
        paidAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      vi.mocked(mockGateway.cancelSubscription).mockImplementationOnce(async () => {
        await store.saveSubscription({
          id: "sub-1",
          billingAccountId: "tenant-1",
          externalSubscriptionId: "ext-sub-1",
          planId: "plan-new",
          planVersionRef: PLAN_VERSION_REF,
          status: "active",
          currentPeriodEnd: new Date("2031-01-01T00:00:00.000Z"),
          cancelAtPeriodEnd: false,
          lastSyncedAt,
        });
      });

      const command = await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "rebase-immediate-1",
        immediate: true,
      });

      expect(command).toMatchObject({ state: "completed", localResult: "applied" });
      expect(await store.findSubscription("tenant-1")).toMatchObject({
        planId: "plan-new",
        currentPeriodEnd: new Date("2031-01-01T00:00:00.000Z"),
        status: "canceled",
        cancelAtPeriodEnd: false,
      });
      await expect(service.hasActiveSubscription("tenant-1")).resolves.toBe(false);
    });

    it("should rebase a pending immediate cancellation onto a newer snapshot of the same subscription", async () => {
      await saveBillingAccount("tenant-1");
      const lastSyncedAt = new Date("2026-01-01T00:00:00.000Z");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-old",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt,
      });
      vi.spyOn(store, "reconcileLifecycleSubscription").mockRejectedValueOnce(
        new Error("local save failed"),
      );
      await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "stale-projection-1",
        immediate: true,
      });
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-new",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2031-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt,
      });

      await expect(service.getSubscription("tenant-1")).resolves.toMatchObject({
        planId: "plan-new",
        currentPeriodEnd: new Date("2031-01-01T00:00:00.000Z"),
        status: "canceled",
      });
      await expect(service.hasActiveSubscription("tenant-1")).resolves.toBe(false);
    });

    it("should not project a pending command over a replacement subscription", async () => {
      await saveBillingAccount("tenant-1");
      const lastSyncedAt = new Date("2026-01-01T00:00:00.000Z");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-old",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt,
      });
      vi.spyOn(store, "reconcileLifecycleSubscription").mockRejectedValueOnce(
        new Error("local save failed"),
      );
      await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "replacement-projection-1",
        immediate: true,
      });
      await store.saveSubscription({
        id: "sub-2",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-2",
        planId: "plan-new",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2031-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt,
      });

      await expect(service.getSubscription("tenant-1")).resolves.toMatchObject({
        externalSubscriptionId: "ext-sub-2",
        planId: "plan-new",
        status: "active",
      });
      await expect(service.hasActiveSubscription("tenant-1")).resolves.toBe(true);
    });

    it("should not re-read an active subscription restored after an absent projection resolution", async () => {
      await saveBillingAccount("tenant-1");
      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      await store.saveSubscription(subscription);
      vi.spyOn(store, "reconcileLifecycleSubscription").mockRejectedValueOnce(
        new Error("local save failed"),
      );
      await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "projection-race-1",
        immediate: true,
      });
      await store.deleteSubscription("tenant-1");

      const resolveLifecycleSubscription = store.resolveLifecycleSubscription.bind(store);
      vi.spyOn(store, "resolveLifecycleSubscription").mockImplementationOnce(async (command) => {
        const resolution = await resolveLifecycleSubscription(command);
        await store.saveSubscription(subscription);
        return resolution;
      });

      await expect(service.getSubscription("tenant-1")).resolves.toBeNull();
      await expect(store.findSubscription("tenant-1")).resolves.toMatchObject({
        externalSubscriptionId: "ext-sub-1",
        status: "active",
      });
    });

    it("should persist and reconcile period-end cancellation after local save failure", async () => {
      await saveBillingAccount("tenant-1");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      vi.spyOn(store, "reconcileLifecycleSubscription").mockRejectedValueOnce(
        new Error("local save failed"),
      );

      const pending = await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "cancel-period-end-retry-1",
      });

      expect(pending).toMatchObject({
        state: "pending_local",
        lastFailure: { stage: "local", detail: "Local lifecycle reconciliation failed" },
      });
      expect(await service.getSubscription("tenant-1")).toMatchObject({
        status: "active",
        cancelAtPeriodEnd: true,
      });
      expect(await service.hasActiveSubscription("tenant-1")).toBe(true);

      const completed = await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "cancel-period-end-retry-1",
      });

      expect(completed.state).toBe("completed");
      expect(mockGateway.cancelSubscription).toHaveBeenNthCalledWith(1, "ext-sub-1", false, {
        idempotencyKey: "cancel-period-end-retry-1",
      });
      expect(mockGateway.cancelSubscription).toHaveBeenCalledTimes(1);
      expect(await store.findSubscription("tenant-1")).toMatchObject({
        cancelAtPeriodEnd: true,
      });
    });

    it("should persist immediate cancellation when atomic local cleanup fails", async () => {
      await saveBillingAccount("tenant-1");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      vi.spyOn(store, "reconcileLifecycleSubscription").mockRejectedValueOnce(
        new Error("local reconciliation failed"),
      );

      const pending = await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "cancel-immediate-retry-1",
        immediate: true,
      });

      expect(pending).toMatchObject({
        state: "pending_local",
        lastFailure: { stage: "local", detail: "Local lifecycle reconciliation failed" },
      });
      expect(await store.findSubscription("tenant-1")).toMatchObject({ status: "active" });
      expect(await service.getSubscriptionStatus("tenant-1")).toBe("canceled");
      expect(await service.hasActiveSubscription("tenant-1")).toBe(false);

      const completed = await service.reconcileLifecycleCommand("cancel-immediate-retry-1");

      expect(completed.state).toBe("completed");
      expect(mockGateway.cancelSubscription).toHaveBeenCalledTimes(1);
      expect(await store.findAccountByTenantId("tenant-1")).toMatchObject({
        id: "tenant-1",
        externalCustomerId: "ext-tenant-1",
      });
      expect(await service.getSubscriptionStatus("tenant-1")).toBeNull();
    });

    it("should retry immediate cancellation when subscription deletion fails", async () => {
      await saveBillingAccount("tenant-1");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      vi.spyOn(store, "reconcileLifecycleSubscription").mockRejectedValueOnce(
        new Error("subscription delete failed"),
      );

      const pending = await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "cancel-delete-subscription-1",
        immediate: true,
      });
      const completed = await service.reconcileLifecycleCommand("cancel-delete-subscription-1");

      expect(pending).toMatchObject({
        state: "pending_local",
        lastFailure: { stage: "local", detail: "Local lifecycle reconciliation failed" },
      });
      expect(completed.state).toBe("completed");
      expect(mockGateway.cancelSubscription).toHaveBeenCalledTimes(1);
      expect(await store.findAccountByTenantId("tenant-1")).toMatchObject({
        id: "tenant-1",
        externalCustomerId: "ext-tenant-1",
      });
    });

    it("should keep provider retries idempotent when provider application fails", async () => {
      await saveBillingAccount("tenant-1");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      vi.mocked(mockGateway.cancelSubscription).mockRejectedValueOnce(
        new Error("provider unavailable"),
      );

      const pending = await service.cancelSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "cancel-provider-retry-1",
      });

      expect(pending).toMatchObject({
        state: "pending_provider",
        lastFailure: { stage: "provider", detail: "Provider lifecycle command failed" },
      });
      expect(await service.getSubscription("tenant-1")).toMatchObject({
        cancelAtPeriodEnd: false,
      });

      const completed = await service.reconcileLifecycleCommand("cancel-provider-retry-1");

      expect(completed.state).toBe("completed");
      expect(mockGateway.cancelSubscription).toHaveBeenNthCalledWith(1, "ext-sub-1", false, {
        idempotencyKey: "cancel-provider-retry-1",
      });
      expect(mockGateway.cancelSubscription).toHaveBeenNthCalledWith(2, "ext-sub-1", false, {
        idempotencyKey: "cancel-provider-retry-1",
      });
    });

    it("should reuse the provider key when provider-state persistence fails", async () => {
      await saveBillingAccount("tenant-1");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      vi.spyOn(store, "saveLifecycleCommand").mockRejectedValueOnce(
        new Error("command transition failed"),
      );

      await expect(
        service.cancelSubscription({
          tenantId: "tenant-1",
          idempotencyKey: "cancel-transition-retry-1",
        }),
      ).rejects.toThrow("command transition failed");

      await expect(
        service.reconcileLifecycleCommand("cancel-transition-retry-1"),
      ).resolves.toMatchObject({ state: "completed" });
      expect(mockGateway.cancelSubscription).toHaveBeenNthCalledWith(1, "ext-sub-1", false, {
        idempotencyKey: "cancel-transition-retry-1",
      });
      expect(mockGateway.cancelSubscription).toHaveBeenNthCalledWith(2, "ext-sub-1", false, {
        idempotencyKey: "cancel-transition-retry-1",
      });
    });
  });

  describe("resumeSubscription", () => {
    it("should resume subscription and set cancelAtPeriodEnd to false", async () => {
      await saveBillingAccount("tenant-1");

      const subscription: Subscription = {
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: true,
        lastSyncedAt: new Date(),
      };
      await store.saveSubscription(subscription);

      const command = await service.resumeSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "resume-1",
      });

      expect(mockGateway.resumeSubscription).toHaveBeenCalledWith("ext-sub-1", {
        idempotencyKey: "resume-1",
      });
      expect(command.state).toBe("completed");

      const updatedSubscription = await store.findSubscription("tenant-1");
      expect(updatedSubscription?.cancelAtPeriodEnd).toBe(false);
      expect(updatedSubscription?.lastSyncedAt).toBeInstanceOf(Date);
    });

    it("should throw error when no subscription exists", async () => {
      await expect(
        service.resumeSubscription({
          tenantId: "tenant-1",
          idempotencyKey: "resume-missing-1",
        }),
      ).rejects.toThrow("No subscription found for tenant 'tenant-1'");
    });

    it("should persist and reconcile resume after local save failure", async () => {
      await saveBillingAccount("tenant-1");
      await store.saveSubscription({
        id: "sub-1",
        billingAccountId: "tenant-1",
        externalSubscriptionId: "ext-sub-1",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: true,
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      vi.spyOn(store, "reconcileLifecycleSubscription").mockRejectedValueOnce(
        new Error("resume save failed"),
      );

      const pending = await service.resumeSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "resume-retry-1",
      });

      expect(pending).toMatchObject({
        state: "pending_local",
        lastFailure: { stage: "local", detail: "Local lifecycle reconciliation failed" },
      });
      expect(await service.getSubscription("tenant-1")).toMatchObject({
        cancelAtPeriodEnd: false,
      });

      const completed = await service.resumeSubscription({
        tenantId: "tenant-1",
        idempotencyKey: "resume-retry-1",
      });

      expect(completed.state).toBe("completed");
      expect(mockGateway.resumeSubscription).toHaveBeenCalledTimes(1);
      expect(mockGateway.resumeSubscription).toHaveBeenCalledWith("ext-sub-1", {
        idempotencyKey: "resume-retry-1",
      });
      expect(await store.findSubscription("tenant-1")).toMatchObject({
        cancelAtPeriodEnd: false,
      });
    });
  });

  describe("getCustomerPortalUrl", () => {
    it("should return customer portal URL", async () => {
      await saveBillingAccount("tenant-1");

      vi.mocked(mockGateway.getCustomerPortalUrl).mockResolvedValue(
        "https://portal.example.com/customer",
      );

      const result = await service.getCustomerPortalUrl("tenant-1");

      expect(mockGateway.getCustomerPortalUrl).toHaveBeenCalledWith("ext-tenant-1");
      expect(result).toBe("https://portal.example.com/customer");
    });

    it("should throw error when no billing account exists", async () => {
      await expect(service.getCustomerPortalUrl("tenant-1")).rejects.toThrow(
        "No billing account found for tenant 'tenant-1'",
      );
    });
  });
});
