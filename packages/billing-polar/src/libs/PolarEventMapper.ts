import {
  OrderPaidEvent,
  PlanChangedEvent,
  SubscriptionActivatedEvent,
  SubscriptionCanceledEvent,
  SubscriptionPastDueEvent,
  SubscriptionRevokedEvent,
} from "@croco/billing-core";
import type { OrderPaymentReason, PlanVersionRef } from "@croco/billing-core";
import type { DomainEvent } from "@croco/events-core";

/**
 * Maps Polar webhook events to internal domain events.
 */
export class PolarEventMapper {
  /**
   * Map a Polar subscription event to internal domain events.
   * Returns array because one webhook can produce multiple internal events.
   */
  mapSubscriptionEvent(
    eventType: string,
    tenantId: string,
    subscription: {
      id: string;
      productId: string;
      status: string;
      cancelAtPeriodEnd?: boolean;
      planVersionRef: PlanVersionRef;
    },
    previousPlanId?: string,
    previousPlanVersionRef?: PlanVersionRef,
  ): DomainEvent[] {
    const events: DomainEvent[] = [];

    switch (eventType) {
      case "subscription.created":
      case "subscription.active":
        events.push(
          new SubscriptionActivatedEvent(tenantId, subscription.productId, subscription.id),
        );
        break;

      case "subscription.updated":
        if (
          previousPlanId &&
          previousPlanVersionRef &&
          (previousPlanId !== subscription.productId ||
            previousPlanVersionRef !== subscription.planVersionRef)
        ) {
          events.push(
            new PlanChangedEvent(
              tenantId,
              previousPlanId,
              subscription.productId,
              subscription.id,
              previousPlanVersionRef,
              subscription.planVersionRef,
            ),
          );
        }

        if (subscription.status === "past_due") {
          events.push(new SubscriptionPastDueEvent(tenantId, subscription.id));
        }
        break;

      case "subscription.past_due":
        events.push(new SubscriptionPastDueEvent(tenantId, subscription.id));
        break;

      case "subscription.canceled":
        events.push(
          new SubscriptionCanceledEvent(
            tenantId,
            subscription.id,
            subscription.cancelAtPeriodEnd ?? true,
            undefined,
            subscription.planVersionRef,
          ),
        );
        break;

      case "subscription.revoked":
        events.push(new SubscriptionRevokedEvent(tenantId, subscription.id));
        break;
    }

    return events;
  }

  /**
   * Map a Polar order event to internal domain events.
   */
  mapOrderEvent(
    eventType: string,
    tenantId: string,
    order: {
      id: string;
      amount: number;
      currency: string;
      reason: OrderPaymentReason;
    },
  ): DomainEvent[] {
    if (eventType === "order.paid") {
      return [new OrderPaidEvent(tenantId, order.id, order.amount, order.currency, order.reason)];
    }
    return [];
  }
}
