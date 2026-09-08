import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryBillingStore } from "../libs/InMemoryBillingStore";
import {
  BillingAccountTenantConflictProblem,
  WebhookAlreadyProcessedProblem,
  WebhookEventIntentsPendingProblem,
} from "../libs/problems/BillingProblems";
import type { BillingAccount, BillingLifecycleCommand, Order, Subscription } from "../types";

const PLAN_VERSION_REF = "plan-pro@v1" as Subscription["planVersionRef"];

describe("InMemoryBillingStore", () => {
  let store!: InMemoryBillingStore;

  beforeEach(() => {
    store = new InMemoryBillingStore();
  });

  describe("findAccountByTenantId", () => {
    it("should return null when account does not exist", async () => {
      const result = await store.findAccountByTenantId("non-existent");
      expect(result).toBeNull();
    });

    it("should return account when it exists", async () => {
      const account: BillingAccount = {
        id: "tenant-1",
        tenantId: "tenant-1",
        externalCustomerId: "ext-cust-1",
        email: "test@example.com",
        createdAt: new Date(),
      };
      await store.saveAccount(account);

      const result = await store.findAccountByTenantId("tenant-1");
      expect(result).toEqual(account);
    });

    it("should move the tenant lookup when an account is re-saved under a new tenant", async () => {
      const originalAccount: BillingAccount = {
        id: "account-1",
        tenantId: "tenant-1",
        externalCustomerId: "ext-cust-1",
        email: "original@example.com",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      const movedAccount: BillingAccount = {
        ...originalAccount,
        tenantId: "tenant-2",
        email: "moved@example.com",
      };

      await store.saveAccount(originalAccount);
      await store.saveAccount(movedAccount);

      expect(await store.findAccountByTenantId("tenant-1")).toBeNull();
      expect(await store.findAccountByTenantId("tenant-2")).toEqual(movedAccount);
      expect(await store.findAccountByExternalId("ext-cust-1")).toEqual(movedAccount);

      await store.deleteAccount(movedAccount.id);

      expect(await store.findAccountByTenantId("tenant-2")).toBeNull();
      expect(await store.findAccountByExternalId("ext-cust-1")).toBeNull();
    });

    it("should move lookup indices when the saved account object is mutated before re-saving", async () => {
      const account: BillingAccount = {
        id: "account-1",
        tenantId: "tenant-1",
        externalCustomerId: "ext-cust-1",
        email: "original@example.com",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      };

      await store.saveAccount(account);
      Object.assign(account, {
        tenantId: "tenant-2",
        externalCustomerId: "ext-cust-2",
        email: "moved@example.com",
      });
      await store.saveAccount(account);

      expect(await store.findAccountByTenantId("tenant-1")).toBeNull();
      expect(await store.findAccountByExternalId("ext-cust-1")).toBeNull();
      expect(await store.findAccountByTenantId("tenant-2")).toEqual(account);
      expect(await store.findAccountByExternalId("ext-cust-2")).toEqual(account);
    });

    it("should reject a tenant collision before changing either account", async () => {
      const existingAccount: BillingAccount = {
        id: "account-1",
        tenantId: "tenant-1",
        externalCustomerId: "ext-cust-1",
        email: "existing@example.com",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      const movingAccount: BillingAccount = {
        id: "account-2",
        tenantId: "tenant-2",
        externalCustomerId: "ext-cust-2",
        email: "moving@example.com",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      };

      await store.saveAccount(existingAccount);
      await store.saveAccount(movingAccount);

      const collision = store.saveAccount({
        ...movingAccount,
        tenantId: existingAccount.tenantId,
        externalCustomerId: "ext-cust-3",
      });

      await expect(collision).rejects.toBeInstanceOf(BillingAccountTenantConflictProblem);
      await expect(collision).rejects.toMatchObject({
        category: "Conflict",
        code: "billing/account-tenant-conflict",
        extensions: {
          existingAccountId: existingAccount.id,
          requestedAccountId: movingAccount.id,
          tenantId: existingAccount.tenantId,
        },
      });

      expect(await store.findAccountByTenantId(existingAccount.tenantId)).toEqual(existingAccount);
      expect(await store.findAccountByTenantId(movingAccount.tenantId)).toEqual(movingAccount);
      expect(await store.findAccountByExternalId(existingAccount.externalCustomerId)).toEqual(
        existingAccount,
      );
      expect(await store.findAccountByExternalId(movingAccount.externalCustomerId)).toEqual(
        movingAccount,
      );
      expect(await store.findAccountByExternalId("ext-cust-3")).toBeNull();
    });
  });

  describe("saveAccount and findAccountByExternalId", () => {
    it("should save account and find by external ID", async () => {
      const account: BillingAccount = {
        id: "tenant-1",
        tenantId: "tenant-1",
        externalCustomerId: "ext-cust-1",
        email: "test@example.com",
        createdAt: new Date(),
      };
      await store.saveAccount(account);

      const result = await store.findAccountByExternalId("ext-cust-1");
      expect(result).toEqual(account);
    });

    it("should return null when finding by non-existent external ID", async () => {
      const result = await store.findAccountByExternalId("non-existent");
      expect(result).toBeNull();
    });

    it("should remove stale external ID mappings when an account is re-saved with a new external ID", async () => {
      const originalAccount: BillingAccount = {
        id: "tenant-1",
        tenantId: "tenant-1",
        externalCustomerId: "ext-cust-1",
        email: "test@example.com",
        createdAt: new Date(),
      };

      await store.saveAccount(originalAccount);

      const updatedAccount: BillingAccount = {
        ...originalAccount,
        externalCustomerId: "ext-cust-2",
      };

      await store.saveAccount(updatedAccount);

      expect(await store.findAccountByExternalId("ext-cust-1")).toBeNull();
      expect(await store.findAccountByExternalId("ext-cust-2")).toEqual(updatedAccount);
      expect(await store.findAccountByTenantId(originalAccount.tenantId)).toEqual(updatedAccount);
    });

    it("should delete account and clear lookup indices", async () => {
      const account: BillingAccount = {
        id: "tenant-1",
        tenantId: "tenant-1",
        externalCustomerId: "ext-cust-1",
        email: "test@example.com",
        createdAt: new Date(),
      };

      await store.saveAccount(account);
      await store.deleteAccount(account.id);

      expect(await store.findAccountByTenantId(account.tenantId)).toBeNull();
      expect(await store.findAccountByExternalId(account.externalCustomerId)).toBeNull();
    });
  });

  describe("findSubscription", () => {
    it("should return null when subscription does not exist", async () => {
      const result = await store.findSubscription("non-existent");
      expect(result).toBeNull();
    });

    it("should return subscription when it exists", async () => {
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

      const result = await store.findSubscription("tenant-1");
      expect(result).toEqual(subscription);
    });
  });

  describe("saveSubscription and findSubscriptionByExternalId", () => {
    it("should save subscription and find by external ID", async () => {
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

      const result = await store.findSubscriptionByExternalId("ext-sub-1");
      expect(result).toEqual(subscription);
    });

    it("keeps the stored plan version pin isolated from caller mutation", async () => {
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

      Object.assign(subscription, { planVersionRef: "plan-pro@mutated" });
      const firstRead = await store.findSubscription(subscription.billingAccountId);
      Object.assign(firstRead ?? {}, { planVersionRef: "plan-pro@read-mutated" });

      await expect(store.findSubscription(subscription.billingAccountId)).resolves.toMatchObject({
        planVersionRef: PLAN_VERSION_REF,
      });
    });

    it("should return null when finding by non-existent external subscription ID", async () => {
      const result = await store.findSubscriptionByExternalId("non-existent");
      expect(result).toBeNull();
    });

    it("should delete subscription and clear external subscription lookup", async () => {
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
      await store.deleteSubscription(subscription.billingAccountId);

      expect(await store.findSubscription(subscription.billingAccountId)).toBeNull();
      expect(
        await store.findSubscriptionByExternalId(subscription.externalSubscriptionId),
      ).toBeNull();
    });
  });

  describe("saveOrder and findOrdersByAccount", () => {
    it("should save order and find by account ID", async () => {
      const order1: Order = {
        id: "order-1",
        billingAccountId: "tenant-1",
        externalOrderId: "ext-order-1",
        amount: 1000,
        currency: "USD",
        reason: "subscription_cycle",
        paidAt: new Date(),
      };
      const order2: Order = {
        id: "order-2",
        billingAccountId: "tenant-1",
        externalOrderId: "ext-order-2",
        amount: 2000,
        currency: "USD",
        reason: "one_time",
        paidAt: new Date(),
      };

      await store.saveOrder(order1);
      await store.saveOrder(order2);

      const result = await store.findOrdersByAccount("tenant-1");
      expect(result).toHaveLength(2);
      expect(result).toEqual([order1, order2]);
    });

    it("should upsert repeated order IDs within an account without duplicating other orders", async () => {
      const order: Order = {
        id: "order-1",
        billingAccountId: "tenant-1",
        externalOrderId: "ext-order-1",
        amount: 1000,
        currency: "USD",
        reason: "subscription_cycle",
        paidAt: new Date(),
      };
      const otherOrder = { ...order, id: "order-2", externalOrderId: "ext-order-2" };
      await store.saveOrder(order);
      await store.saveOrder(otherOrder);
      await store.saveOrder({ ...order });

      expect(await store.findOrdersByAccount("tenant-1")).toEqual([order, otherOrder]);

      const updatedOrder = { ...order, amount: 2000 };
      await store.saveOrder(updatedOrder);

      expect(await store.findOrdersByAccount("tenant-1")).toEqual([updatedOrder, otherOrder]);
    });

    it("should preserve matching order IDs in different accounts during retries", async () => {
      const order: Order = {
        id: "order-1",
        billingAccountId: "tenant-1",
        externalOrderId: "ext-order-1",
        amount: 1000,
        currency: "USD",
        reason: "one_time",
        paidAt: new Date(),
      };
      const otherAccountOrder = { ...order, billingAccountId: "tenant-2", amount: 2000 };
      await store.saveOrder(order);
      await store.saveOrder(otherAccountOrder);
      await store.saveOrder({ ...order });

      expect(await store.findOrdersByAccount("tenant-1")).toEqual([order]);
      expect(await store.findOrdersByAccount("tenant-2")).toEqual([otherAccountOrder]);
    });

    it("should return empty array when no orders exist", async () => {
      const result = await store.findOrdersByAccount("non-existent");
      expect(result).toEqual([]);
    });

    it("should only return orders for specific account", async () => {
      const order1: Order = {
        id: "order-1",
        billingAccountId: "tenant-1",
        externalOrderId: "ext-order-1",
        amount: 1000,
        currency: "USD",
        reason: "subscription_cycle",
        paidAt: new Date(),
      };
      const order2: Order = {
        id: "order-2",
        billingAccountId: "tenant-2",
        externalOrderId: "ext-order-2",
        amount: 2000,
        currency: "USD",
        reason: "one_time",
        paidAt: new Date(),
      };

      await store.saveOrder(order1);
      await store.saveOrder(order2);

      const result1 = await store.findOrdersByAccount("tenant-1");
      const result2 = await store.findOrdersByAccount("tenant-2");

      expect(result1).toEqual([order1]);
      expect(result2).toEqual([order2]);
    });
  });

  describe("subscription lifecycle commands", () => {
    function createLifecycleCommand(
      overrides: Partial<BillingLifecycleCommand> = {},
    ): BillingLifecycleCommand {
      const now = new Date("2026-01-01T00:00:00.000Z");
      return {
        idempotencyKey: "cancel-1",
        tenantId: "tenant-1",
        kind: "cancel_at_period_end",
        state: "pending_provider",
        revision: 0,
        subscription: {
          id: "sub-1",
          billingAccountId: "account-1",
          externalSubscriptionId: "ext-sub-1",
          planId: "plan-pro",
          planVersionRef: PLAN_VERSION_REF,
          status: "active",
          currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
          cancelAtPeriodEnd: false,
          lastSyncedAt: now,
        },
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
    }

    it("should remove only the matching subscription and preserve account indices on repeated reconciliation", async () => {
      const command = createLifecycleCommand({
        kind: "cancel_immediately",
        state: "pending_local",
      });
      const account: BillingAccount = {
        id: command.subscription.billingAccountId,
        tenantId: command.tenantId,
        externalCustomerId: "ext-cust-1",
        email: "test@example.com",
        createdAt: command.createdAt,
      };
      await store.saveAccount(account);
      await store.saveSubscription(command.subscription);
      expect(await store.findOrdersByAccount(account.id)).toEqual([]);

      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(store.reconcileLifecycleSubscription(command, null)).resolves.toBe("applied");
        expect(await store.findSubscription(account.id)).toBeNull();
        expect(
          await store.findSubscriptionByExternalId(command.subscription.externalSubscriptionId),
        ).toBeNull();
        expect(await store.findAccountByTenantId(account.tenantId)).toEqual(account);
        expect(await store.findAccountByExternalId(account.externalCustomerId)).toEqual(account);
      }

      await store.deleteAccount(account.id);
      expect(await store.findAccountByTenantId(account.tenantId)).toBeNull();
      expect(await store.findAccountByExternalId(account.externalCustomerId)).toBeNull();
    });

    it("should deduplicate the same semantic command and reject conflicting key reuse", async () => {
      const command = createLifecycleCommand();

      const first = await store.createLifecycleCommand(command);
      const duplicate = await store.createLifecycleCommand({
        ...command,
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      });

      expect(duplicate).toEqual(first);
      await expect(
        store.createLifecycleCommand({
          ...command,
          kind: "resume",
        }),
      ).rejects.toThrow("already bound to another command");
    });

    it("should keep one incomplete command per tenant and release it on completion", async () => {
      const first = await store.createLifecycleCommand(createLifecycleCommand());

      await expect(
        store.createLifecycleCommand(
          createLifecycleCommand({
            idempotencyKey: "resume-1",
            kind: "resume",
          }),
        ),
      ).rejects.toThrow("already has incomplete billing lifecycle command");

      const pendingLocal = await store.saveLifecycleCommand({
        ...first,
        state: "pending_local",
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      });
      await store.saveLifecycleCommand({
        ...pendingLocal,
        state: "completed",
        updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      });
      await store.createLifecycleCommand(
        createLifecycleCommand({
          idempotencyKey: "resume-1",
          kind: "resume",
        }),
      );

      await expect(store.listPendingLifecycleCommands(10)).resolves.toMatchObject([
        { idempotencyKey: "resume-1", state: "pending_provider" },
      ]);
    });

    it("should reject skipped, backward, and reopened lifecycle transitions", async () => {
      const pendingProvider = await store.createLifecycleCommand(createLifecycleCommand());

      await expect(
        store.saveLifecycleCommand({
          ...pendingProvider,
          state: "completed",
        }),
      ).rejects.toThrow("already bound to another command");

      const pendingLocal = await store.saveLifecycleCommand({
        ...pendingProvider,
        state: "pending_local",
      });

      await expect(
        store.saveLifecycleCommand({
          ...pendingLocal,
          state: "pending_provider",
        }),
      ).rejects.toThrow("already bound to another command");

      const completed = await store.saveLifecycleCommand({
        ...pendingLocal,
        state: "completed",
      });

      await expect(
        store.saveLifecycleCommand({
          ...completed,
          state: "pending_local",
        }),
      ).rejects.toThrow("already bound to another command");
    });

    it("should reject a stale completion without clearing a newer pending command", async () => {
      const pendingProvider = await store.createLifecycleCommand(createLifecycleCommand());
      const pendingLocal = await store.saveLifecycleCommand({
        ...pendingProvider,
        state: "pending_local",
      });
      await store.saveLifecycleCommand({
        ...pendingLocal,
        state: "completed",
      });
      await store.createLifecycleCommand(
        createLifecycleCommand({
          idempotencyKey: "resume-new",
          kind: "resume",
        }),
      );

      await expect(
        store.saveLifecycleCommand({
          ...pendingLocal,
          state: "completed",
        }),
      ).rejects.toThrow("already bound to another command");
      await expect(store.findPendingLifecycleCommandByTenantId("tenant-1")).resolves.toMatchObject({
        idempotencyKey: "resume-new",
        state: "pending_provider",
      });
    });

    it("should reclaim event delivery only after the datastore lease expires", async () => {
      let now = new Date("2026-01-01T00:00:00.000Z");
      store = new InMemoryBillingStore(() => now);
      const pendingProvider = await store.createLifecycleCommand(createLifecycleCommand());
      const pendingLocal = await store.saveLifecycleCommand({
        ...pendingProvider,
        state: "pending_local",
      });
      const pendingEvent = await store.saveLifecycleCommand({
        ...pendingLocal,
        state: "pending_event",
      });

      const firstClaim = await store.claimLifecycleEventDelivery(pendingEvent, 30_000);
      expect(firstClaim).toMatchObject({
        revision: pendingEvent.revision + 1,
        eventDeliveryLeaseUntil: new Date("2026-01-01T00:00:30.000Z"),
      });
      await expect(
        store.claimLifecycleEventDelivery(firstClaim ?? pendingEvent, 30_000),
      ).resolves.toBeNull();

      now = new Date("2026-01-01T00:00:31.000Z");
      await expect(
        store.claimLifecycleEventDelivery(firstClaim ?? pendingEvent, 30_000),
      ).resolves.toMatchObject({
        revision: pendingEvent.revision + 2,
        eventDeliveryLeaseUntil: new Date("2026-01-01T00:01:01.000Z"),
      });
    });
  });

  describe("webhook reservation lifecycle", () => {
    it("should reject a completed webhook when reserving the same event again", async () => {
      await store.reserveWebhook("event-1", "subscription.created");
      await store.completeWebhook("event-1");

      await expect(store.reserveWebhook("event-1", "subscription.created")).rejects.toBeInstanceOf(
        WebhookAlreadyProcessedProblem,
      );
    });

    it("should allow reserving the same event after a failed reservation", async () => {
      await store.reserveWebhook("event-1", "subscription.created");
      await store.failWebhook("event-1");

      await expect(
        store.reserveWebhook("event-1", "subscription.created"),
      ).resolves.toBeUndefined();
    });

    it("should idempotently remove completed and missing webhook reservations", async () => {
      await store.reserveWebhook("event-1", "subscription.created");
      await store.completeWebhook("event-1");

      await expect(store.failWebhook("event-1")).resolves.toBeUndefined();
      await expect(store.failWebhook("event-1")).resolves.toBeUndefined();
      await expect(
        store.reserveWebhook("event-1", "subscription.created"),
      ).resolves.toBeUndefined();
    });

    it("should reject completion when the webhook was not reserved", async () => {
      await expect(store.completeWebhook("event-1")).rejects.toBeInstanceOf(
        WebhookAlreadyProcessedProblem,
      );
    });

    it("should reject duplicate webhook reservations", async () => {
      await store.reserveWebhook("event-1", "subscription.created");

      await expect(store.reserveWebhook("event-1", "subscription.created")).rejects.toBeInstanceOf(
        WebhookAlreadyProcessedProblem,
      );
    });

    it("should allow exactly one concurrent reservation for the same event", async () => {
      const results = await Promise.allSettled([
        store.reserveWebhook("event-concurrent", "subscription.created"),
        store.reserveWebhook("event-concurrent", "subscription.created"),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        reason: expect.any(WebhookAlreadyProcessedProblem),
      });
    });
  });

  describe("reset", () => {
    it("should clear all data", async () => {
      const account: BillingAccount = {
        id: "tenant-1",
        tenantId: "tenant-1",
        externalCustomerId: "ext-cust-1",
        email: "test@example.com",
        createdAt: new Date(),
      };
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
      const order: Order = {
        id: "order-1",
        billingAccountId: "tenant-1",
        externalOrderId: "ext-order-1",
        amount: 1000,
        currency: "USD",
        reason: "subscription_cycle",
        paidAt: new Date(),
      };
      await store.saveAccount(account);
      await store.saveSubscription(subscription);
      await store.saveOrder(order);
      await store.reserveWebhook("event-1", "subscription.created");
      await store.completeWebhook("event-1");

      store.reset();

      expect(await store.findAccountByTenantId("tenant-1")).toBeNull();
      expect(await store.findAccountByExternalId("ext-cust-1")).toBeNull();
      expect(await store.findSubscription("tenant-1")).toBeNull();
      expect(await store.findSubscriptionByExternalId("ext-sub-1")).toBeNull();
      expect(await store.findOrdersByAccount("tenant-1")).toEqual([]);
      await expect(
        store.reserveWebhook("event-1", "subscription.created"),
      ).resolves.toBeUndefined();
    });
  });

  describe("subscription webhook transitions", () => {
    it("retains previous-state evidence and resumes only unpublished event intents", async () => {
      const previousSubscription: Subscription = {
        id: "sub-transition",
        billingAccountId: "tenant-transition",
        externalSubscriptionId: "sub-transition",
        planId: "plan-basic",
        planVersionRef: "plan-basic@v1" as Subscription["planVersionRef"],
        status: "active",
        currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      const nextSubscription: Subscription = {
        ...previousSubscription,
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "past_due",
        lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
      };
      let derivations = 0;
      const createEventIntents = (previous: Subscription | null) => {
        derivations += 1;
        expect(previous).toEqual(previousSubscription);
        return ["billing.plan_changed", "billing.subscription_past_due"].map(
          (eventType, index) => ({
            eventType,
            eventId: `intent-${index}`,
            occurredAt: "2026-01-02T00:00:00.000Z",
            payload: { previousPlanId: previous?.planId },
          }),
        );
      };

      await store.saveSubscription(previousSubscription);
      const committed = await store.commitSubscriptionWebhook({
        eventId: "webhook-transition",
        eventType: "subscription.updated",
        subscription: nextSubscription,
        createEventIntents,
      });
      await store.markWebhookEventIntentPublished("webhook-transition", "intent-0");
      const resumed = await store.commitSubscriptionWebhook({
        eventId: "webhook-transition",
        eventType: "subscription.updated",
        subscription: nextSubscription,
        createEventIntents,
      });

      expect(derivations).toBe(1);
      expect(committed.previousSubscription).toEqual(previousSubscription);
      expect(resumed.intents.map((intent) => intent.publishedAt !== null)).toEqual([true, false]);
      await expect(store.completeWebhook("webhook-transition")).rejects.toBeInstanceOf(
        WebhookEventIntentsPendingProblem,
      );

      await store.markWebhookEventIntentPublished("webhook-transition", "intent-1");
      await store.completeWebhook("webhook-transition");
      const completed = await store.commitSubscriptionWebhook({
        eventId: "webhook-transition",
        eventType: "subscription.updated",
        subscription: nextSubscription,
        createEventIntents,
      });
      expect(completed.state).toBe("completed");
    });

    it("commits one transition for concurrent deliveries of the same webhook", async () => {
      const subscription: Subscription = {
        id: "sub-concurrent-transition",
        billingAccountId: "tenant-concurrent-transition",
        externalSubscriptionId: "sub-concurrent-transition",
        planId: "plan-pro",
        planVersionRef: PLAN_VERSION_REF,
        status: "active",
        currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      let derivations = 0;
      const input = {
        eventId: "webhook-concurrent-transition",
        eventType: "subscription.created",
        subscription,
        createEventIntents: () => {
          derivations += 1;
          return [
            {
              eventType: "billing.subscription_activated",
              eventId: "intent-concurrent-transition",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: {},
            },
          ];
        },
      };

      const [first, second] = await Promise.all([
        store.commitSubscriptionWebhook(input),
        store.commitSubscriptionWebhook(input),
      ]);

      expect(derivations).toBe(1);
      expect(first).toEqual(second);
    });

    it("allows only the lease owner to deliver until completion or lease expiry", async () => {
      let now = new Date("2026-01-01T00:00:00.000Z");
      store = new InMemoryBillingStore(() => now);

      const firstClaim = await store.claimWebhookDelivery("delivery-1", "billing.event", 30_000);
      expect(firstClaim).toMatchObject({ status: "claimed" });
      expect(await store.claimWebhookDelivery("delivery-1", "billing.event", 30_000)).toEqual({
        status: "in_progress",
      });

      now = new Date("2026-01-01T00:00:31.000Z");
      const secondClaim = await store.claimWebhookDelivery("delivery-1", "billing.event", 30_000);
      expect(secondClaim).toMatchObject({ status: "claimed" });
      if (firstClaim.status !== "claimed" || secondClaim.status !== "claimed") {
        throw new Error("Expected both lease attempts to be claimed");
      }
      expect(await store.completeWebhookDelivery("delivery-1", secondClaim.token)).toBe(true);
      expect(await store.releaseWebhookDelivery("delivery-1", firstClaim.token)).toBe(false);
      expect(await store.claimWebhookDelivery("delivery-1", "billing.event", 30_000)).toEqual({
        status: "completed",
      });
    });

    it("rejects terminal writes from an expired owner before another worker reclaims", async () => {
      let now = new Date("2026-01-01T00:00:00.000Z");
      store = new InMemoryBillingStore(() => now);
      const claim = await store.claimWebhookDelivery("delivery-expired", "billing.event", 30_000);
      if (claim.status !== "claimed") throw new Error("Expected delivery claim");

      now = new Date("2026-01-01T00:00:30.000Z");

      expect(await store.completeWebhookDelivery("delivery-expired", claim.token)).toBe(false);
      expect(await store.releaseWebhookDelivery("delivery-expired", claim.token)).toBe(false);
      expect(
        await store.claimWebhookDelivery("delivery-expired", "billing.event", 30_000),
      ).toMatchObject({ status: "claimed" });
    });
  });
});
