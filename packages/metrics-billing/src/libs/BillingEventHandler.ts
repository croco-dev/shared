// Constructor dependencies must remain runtime values for emitted design:paramtypes metadata.
/* oxlint-disable typescript/consistent-type-imports */
import {
  BillingStore,
  OrderPaidEvent,
  PlanChangedEvent,
  type PlanRegistry,
  type PlanVersionRef,
  type OrderPaymentReason,
  SubscriptionCanceledEvent,
} from "@croco/billing-core";
import { type DomainEvent, type EventHandler, RegisterEventHandler } from "@croco/events-core";
import { MetricsRepository, type Money, type PlanProvider } from "@croco/metrics-core";
import type { MRRMovement } from "@croco/metrics-core";
import { MrrCalculator } from "@croco/metrics-core";
import {
  BillingMetricDroppedProblem,
  BillingMetricRecordingProblem,
  InvalidOrderPaymentReasonProblem,
} from "./problems/BillingMetricsProblems";
import type { BillingMetricDropReason } from "./problems/BillingMetricsProblems";

type BillingMetricEvent = OrderPaidEvent | PlanChangedEvent | SubscriptionCanceledEvent;

@RegisterEventHandler(OrderPaidEvent)
@RegisterEventHandler(PlanChangedEvent)
@RegisterEventHandler(SubscriptionCanceledEvent)
export class BillingEventHandler
  implements
    EventHandler<OrderPaidEvent | PlanChangedEvent | SubscriptionCanceledEvent>,
    PlanProvider
{
  private readonly calculator = new MrrCalculator();

  constructor(
    private readonly planRegistry: PlanRegistry,
    private readonly billingStore: BillingStore,
    private readonly metricsRepository: MetricsRepository,
  ) {}

  async getPlan(planId: string) {
    const plan = await this.planRegistry.getPlan(planId);
    if (plan === null) {
      return null;
    }

    return {
      id: plan.planId,
      amount: plan.amount,
      currency: plan.currency,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
    };
  }

  private async getPinnedPlan(planVersionRef: PlanVersionRef) {
    const plan = await this.planRegistry.getPlanVersion(planVersionRef);
    if (plan === null) {
      return null;
    }

    return {
      id: plan.planId,
      amount: plan.amount,
      currency: plan.currency,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
    };
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event instanceof OrderPaidEvent) {
      await this.handleOrderPaid(event);
      return;
    }

    if (event instanceof PlanChangedEvent) {
      await this.handlePlanChanged(event);
      return;
    }

    if (event instanceof SubscriptionCanceledEvent) {
      await this.handleSubscriptionCanceled(event);
    }
  }

  private async handleOrderPaid(event: OrderPaidEvent): Promise<void> {
    const movementType = this.getOrderPaidMovementType(event.reason);
    if (movementType === null) {
      return;
    }

    const account = await this.billingStore.findAccountByTenantId(event.tenantId);
    if (account === null) {
      throw this.createDroppedProblem(event, "account_not_found", event.tenantId);
    }

    const subscription = await this.billingStore.findSubscription(account.id);
    if (subscription === null) {
      throw this.createDroppedProblem(event, "subscription_not_found", account.id);
    }

    const plan = await this.getPinnedPlan(subscription.planVersionRef);
    if (plan === null) {
      throw this.createDroppedProblem(event, "plan_not_found", subscription.planId);
    }

    const mrrAmount = this.calculator.normalizeMRR(plan.amount, plan.interval, plan.intervalCount);
    const mrr: Money = { amount: mrrAmount, currency: plan.currency };
    const movement = this.createMRRMovement(mrr, movementType);

    await this.recordMRRMovement(event, movement);
  }

  private getOrderPaidMovementType(reason: OrderPaymentReason): "new" | "reactivation" | null {
    switch (reason) {
      case "subscription_create":
        return "new";
      case "subscription_reactivation":
        return "reactivation";
      case "subscription_cycle":
      case "subscription_update":
      case "one_time":
        return null;
      default:
        throw new InvalidOrderPaymentReasonProblem(reason);
    }
  }

  private async handlePlanChanged(event: PlanChangedEvent): Promise<void> {
    const account = await this.billingStore.findAccountByTenantId(event.tenantId);
    if (account === null) {
      throw this.createDroppedProblem(event, "account_not_found", event.tenantId);
    }

    const subscription = await this.billingStore.findSubscriptionByExternalId(
      event.externalSubscriptionId,
    );
    if (subscription === null) {
      throw this.createDroppedProblem(
        event,
        "subscription_not_found",
        event.externalSubscriptionId,
      );
    }

    const previousPlan = await this.getPinnedPlan(event.previousPlanVersionRef);
    const newPlan = await this.getPinnedPlan(event.newPlanVersionRef);
    if (previousPlan === null || newPlan === null) {
      throw this.createDroppedProblem(
        event,
        "plan_not_found",
        previousPlan === null ? event.previousPlanId : event.newPlanId,
      );
    }

    const previousMrrAmount = this.calculator.normalizeMRR(
      previousPlan.amount,
      previousPlan.interval,
      previousPlan.intervalCount,
    );
    const newMrrAmount = this.calculator.normalizeMRR(
      newPlan.amount,
      newPlan.interval,
      newPlan.intervalCount,
    );
    const movementType = this.calculator.classifyMRRMovement(
      true,
      false,
      previousMrrAmount,
      newMrrAmount,
    );

    const mrrDiff = Math.abs(newMrrAmount - previousMrrAmount);
    const mrr: Money = { amount: mrrDiff, currency: newPlan.currency };
    const movement = this.createMRRMovement(mrr, movementType);

    await this.recordMRRMovement(event, movement);
  }

  private async handleSubscriptionCanceled(event: SubscriptionCanceledEvent): Promise<void> {
    if (event.cancelAtPeriodEnd) {
      return;
    }

    let planVersionRef = event.planVersionRef;
    let planResourceId: string = planVersionRef ?? event.externalSubscriptionId;
    if (planVersionRef === undefined) {
      const subscription = await this.billingStore.findSubscriptionByExternalId(
        event.externalSubscriptionId,
      );
      if (subscription === null) {
        throw this.createDroppedProblem(
          event,
          "subscription_not_found",
          event.externalSubscriptionId,
        );
      }
      planVersionRef = subscription.planVersionRef;
      planResourceId = subscription.planId;
    }

    const plan = await this.getPinnedPlan(planVersionRef);
    if (plan === null) {
      throw this.createDroppedProblem(event, "plan_not_found", planResourceId);
    }

    const mrrAmount = this.calculator.normalizeMRR(plan.amount, plan.interval, plan.intervalCount);
    const mrr: Money = { amount: mrrAmount, currency: plan.currency };
    const movement = this.createMRRMovement(mrr, "churned");

    await this.recordMRRMovement(event, movement);
  }

  private createMRRMovement(
    mrr: Money,
    type: "new" | "expansion" | "contraction" | "churned" | "reactivation" | "unchanged",
  ) {
    const empty: Money = { amount: 0, currency: mrr.currency };

    switch (type) {
      case "new":
        return {
          new: mrr,
          expansion: empty,
          contraction: empty,
          churned: empty,
          reactivation: empty,
          net: mrr,
        };
      case "expansion":
        return {
          new: empty,
          expansion: mrr,
          contraction: empty,
          churned: empty,
          reactivation: empty,
          net: mrr,
        };
      case "contraction":
        return {
          new: empty,
          expansion: empty,
          contraction: mrr,
          churned: empty,
          reactivation: empty,
          net: { amount: -mrr.amount, currency: mrr.currency },
        };
      case "churned":
        return {
          new: empty,
          expansion: empty,
          contraction: empty,
          churned: mrr,
          reactivation: empty,
          net: { amount: -mrr.amount, currency: mrr.currency },
        };
      case "reactivation":
        return {
          new: empty,
          expansion: empty,
          contraction: empty,
          churned: empty,
          reactivation: mrr,
          net: mrr,
        };
      case "unchanged":
        return {
          new: empty,
          expansion: empty,
          contraction: empty,
          churned: empty,
          reactivation: empty,
          net: empty,
        };
    }
  }

  private getEventKey(event: DomainEvent): string {
    return `${event.eventName}_${event.eventId}`;
  }

  private getLegacyTimestampEventKey(event: DomainEvent): string {
    return `${event.eventName}_${event.timestamp.getTime()}`;
  }

  private async recordMRRMovement(event: BillingMetricEvent, movement: MRRMovement): Promise<void> {
    const eventKey = this.getEventKey(event);
    const legacyEventKeys = [this.getLegacyTimestampEventKey(event)];

    try {
      await this.metricsRepository.recordMRRMovement(
        event.tenantId,
        movement,
        event.timestamp,
        eventKey,
        legacyEventKeys,
      );
    } catch (error) {
      throw new BillingMetricRecordingProblem({
        eventName: event.eventName,
        tenantId: event.tenantId,
        eventKey,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  private createDroppedProblem(
    event: BillingMetricEvent,
    reason: BillingMetricDropReason,
    resourceId: string,
  ): BillingMetricDroppedProblem {
    return new BillingMetricDroppedProblem({
      eventName: event.eventName,
      tenantId: event.tenantId,
      eventKey: this.getEventKey(event),
      reason,
      resourceId,
    });
  }
}
