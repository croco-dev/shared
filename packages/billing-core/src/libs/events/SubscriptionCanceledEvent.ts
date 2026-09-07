import { DomainEvent } from "@croco/events-core";
import type { PlanVersionRef } from "../../types";

export class SubscriptionCanceledEvent extends DomainEvent {
  static readonly eventName = "billing.subscription_canceled";
  static fromPayload(payload: Record<string, unknown>): SubscriptionCanceledEvent {
    return new SubscriptionCanceledEvent(
      payload.tenantId as string,
      payload.externalSubscriptionId as string,
      payload.cancelAtPeriodEnd as boolean,
      undefined,
      payload.planVersionRef as PlanVersionRef | undefined,
    );
  }

  constructor(
    public readonly tenantId: string,
    public readonly externalSubscriptionId: string,
    public readonly cancelAtPeriodEnd: boolean,
    eventId?: string,
    public readonly planVersionRef?: PlanVersionRef,
  ) {
    super();
    if (eventId) {
      const mutableEvent = this as unknown as { eventId: string };
      mutableEvent.eventId = eventId;
    }
  }
}
