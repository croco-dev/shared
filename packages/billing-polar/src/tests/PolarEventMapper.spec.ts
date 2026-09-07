import {
  OrderPaidEvent,
  planVersionRef,
  PlanChangedEvent,
  SubscriptionActivatedEvent,
  SubscriptionCanceledEvent,
  SubscriptionPastDueEvent,
  SubscriptionRevokedEvent,
} from "@croco/billing-core";
import { beforeEach, describe, expect, it } from "vitest";
import { PolarEventMapper } from "../libs/PolarEventMapper";

describe("PolarEventMapper", () => {
  let mapper!: PolarEventMapper;

  beforeEach(() => {
    mapper = new PolarEventMapper();
  });

  describe("mapSubscriptionEvent", () => {
    it("subscription.created → SubscriptionActivatedEvent", () => {
      const events = mapper.mapSubscriptionEvent("subscription.created", "tenant-123", {
        id: "sub-123",
        productId: "plan-pro",
        planVersionRef: planVersionRef("plan-pro@v1"),
        status: "active",
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(SubscriptionActivatedEvent);
      const event = events[0] as SubscriptionActivatedEvent;
      expect(event.tenantId).toBe("tenant-123");
      expect(event.planId).toBe("plan-pro");
      expect(event.externalSubscriptionId).toBe("sub-123");
    });

    it("subscription.active → SubscriptionActivatedEvent", () => {
      const events = mapper.mapSubscriptionEvent("subscription.active", "tenant-123", {
        id: "sub-123",
        productId: "plan-pro",
        planVersionRef: planVersionRef("plan-pro@v1"),
        status: "active",
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(SubscriptionActivatedEvent);
      const event = events[0] as SubscriptionActivatedEvent;
      expect(event.tenantId).toBe("tenant-123");
      expect(event.planId).toBe("plan-pro");
      expect(event.externalSubscriptionId).toBe("sub-123");
    });

    it("subscription.updated (플랜 변경) → PlanChangedEvent", () => {
      const events = mapper.mapSubscriptionEvent(
        "subscription.updated",
        "tenant-123",
        {
          id: "sub-123",
          productId: "plan-enterprise",
          planVersionRef: planVersionRef("plan-enterprise@v1"),
          status: "active",
        },
        "plan-pro",
        planVersionRef("plan-pro@v1"),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(PlanChangedEvent);
      const event = events[0] as PlanChangedEvent;
      expect(event.tenantId).toBe("tenant-123");
      expect(event.previousPlanId).toBe("plan-pro");
      expect(event.newPlanId).toBe("plan-enterprise");
      expect(event.externalSubscriptionId).toBe("sub-123");
    });

    it("subscription.updated emits version migration evidence within the same plan family", () => {
      const events = mapper.mapSubscriptionEvent(
        "subscription.updated",
        "tenant-123",
        {
          id: "sub-123",
          productId: "plan-pro",
          planVersionRef: planVersionRef("plan-pro@v2"),
          status: "active",
        },
        "plan-pro",
        planVersionRef("plan-pro@v1"),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        previousPlanId: "plan-pro",
        newPlanId: "plan-pro",
        previousPlanVersionRef: "plan-pro@v1",
        newPlanVersionRef: "plan-pro@v2",
      });
    });

    it("subscription.updated (상태만 변경 - past_due) → SubscriptionPastDueEvent", () => {
      const events = mapper.mapSubscriptionEvent(
        "subscription.updated",
        "tenant-123",
        {
          id: "sub-123",
          productId: "plan-pro",
          planVersionRef: planVersionRef("plan-pro@v1"),
          status: "past_due",
        },
        "plan-pro",
        planVersionRef("plan-pro@v1"),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(SubscriptionPastDueEvent);
      const event = events[0] as SubscriptionPastDueEvent;
      expect(event.tenantId).toBe("tenant-123");
      expect(event.externalSubscriptionId).toBe("sub-123");
    });

    it("subscription.updated (플랜 변경 + past_due) → PlanChangedEvent + SubscriptionPastDueEvent", () => {
      const events = mapper.mapSubscriptionEvent(
        "subscription.updated",
        "tenant-123",
        {
          id: "sub-123",
          productId: "plan-enterprise",
          planVersionRef: planVersionRef("plan-enterprise@v1"),
          status: "past_due",
        },
        "plan-pro",
        planVersionRef("plan-pro@v1"),
      );

      expect(events).toHaveLength(2);
      expect(events[0]).toBeInstanceOf(PlanChangedEvent);
      expect(events[1]).toBeInstanceOf(SubscriptionPastDueEvent);
    });

    it("subscription.updated (플랜 변경 없음, 상태도 아님) → 빈 배열", () => {
      const events = mapper.mapSubscriptionEvent(
        "subscription.updated",
        "tenant-123",
        {
          id: "sub-123",
          productId: "plan-pro",
          planVersionRef: planVersionRef("plan-pro@v1"),
          status: "active",
        },
        "plan-pro",
        planVersionRef("plan-pro@v1"),
      );

      expect(events).toHaveLength(0);
    });

    it("subscription.past_due → SubscriptionPastDueEvent", () => {
      const events = mapper.mapSubscriptionEvent(
        "subscription.past_due",
        "tenant-123",
        {
          id: "sub-123",
          productId: "plan-pro",
          planVersionRef: planVersionRef("plan-pro@v1"),
          status: "past_due",
        },
        "plan-pro",
        planVersionRef("plan-pro@v1"),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(SubscriptionPastDueEvent);
      expect(events[0]).toMatchObject({
        tenantId: "tenant-123",
        externalSubscriptionId: "sub-123",
      });
    });

    it.each([false, true])(
      "subscription.canceled preserves the plan (cancelAtPeriodEnd=%s)",
      (cancelAtPeriodEnd) => {
        const events = mapper.mapSubscriptionEvent("subscription.canceled", "tenant-123", {
          id: "sub-123",
          productId: "plan-pro",
          planVersionRef: planVersionRef("plan-pro@v1"),
          status: "canceled",
          cancelAtPeriodEnd,
        });

        expect(events).toHaveLength(1);
        expect(events[0]).toBeInstanceOf(SubscriptionCanceledEvent);
        const event = events[0] as SubscriptionCanceledEvent;
        expect(event.tenantId).toBe("tenant-123");
        expect(event.externalSubscriptionId).toBe("sub-123");
        expect(event.cancelAtPeriodEnd).toBe(cancelAtPeriodEnd);
        expect(event.planVersionRef).toBe(planVersionRef("plan-pro@v1"));
      },
    );

    it("subscription.revoked → SubscriptionRevokedEvent", () => {
      const events = mapper.mapSubscriptionEvent("subscription.revoked", "tenant-123", {
        id: "sub-123",
        productId: "plan-pro",
        planVersionRef: planVersionRef("plan-pro@v1"),
        status: "revoked",
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(SubscriptionRevokedEvent);
      const event = events[0] as SubscriptionRevokedEvent;
      expect(event.tenantId).toBe("tenant-123");
      expect(event.externalSubscriptionId).toBe("sub-123");
    });

    it("subscription.canceled (cancelAtPeriodEnd 미지정) → SubscriptionCanceledEvent (기본값 true)", () => {
      const events = mapper.mapSubscriptionEvent("subscription.canceled", "tenant-123", {
        id: "sub-123",
        productId: "plan-pro",
        planVersionRef: planVersionRef("plan-pro@v1"),
        status: "canceled",
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(SubscriptionCanceledEvent);
      const event = events[0] as SubscriptionCanceledEvent;
      expect(event.cancelAtPeriodEnd).toBe(true);
    });
  });

  describe("mapOrderEvent", () => {
    it("order.paid → OrderPaidEvent", () => {
      const events = mapper.mapOrderEvent("order.paid", "tenant-123", {
        id: "order-123",
        amount: 9900,
        currency: "USD",
        reason: "subscription_create",
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(OrderPaidEvent);
      const event = events[0] as OrderPaidEvent;
      expect(event.tenantId).toBe("tenant-123");
      expect(event.externalOrderId).toBe("order-123");
      expect(event.amount).toBe(9900);
      expect(event.currency).toBe("USD");
      expect(event.reason).toBe("subscription_create");
    });

    it("알 수 없는 order 이벤트 → 빈 배열", () => {
      const events = mapper.mapOrderEvent("order.created", "tenant-123", {
        id: "order-123",
        amount: 9900,
        currency: "USD",
        reason: "subscription_cycle",
      });

      expect(events).toHaveLength(0);
    });
  });
});
