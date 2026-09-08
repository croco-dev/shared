import type {
  BillingAccount,
  BillingLifecycleCommand,
  BillingLifecycleLocalResult,
  BillingLifecycleSubscriptionResolution,
  Order,
  Subscription,
} from "../types";
import { BillingStore } from "./BillingStore";
import type {
  BillingSubscriptionWebhookTransition,
  BillingWebhookDeliveryClaim,
  BillingWebhookEventIntent,
  CommitBillingSubscriptionWebhookInput,
} from "./BillingStore";
import {
  BillingAccountTenantConflictProblem,
  BillingLifecycleCommandConflictProblem,
  BillingLifecycleCommandInProgressProblem,
  WebhookEventIntentsPendingProblem,
  WebhookAlreadyProcessedProblem,
} from "./problems/BillingProblems";

type WebhookState =
  | { readonly state: "RESERVED"; readonly leaseUntil?: Date; readonly claimToken?: string }
  | { readonly state: "COMPLETED" };

/**
 * In-memory billing store for testing and development.
 * NOT suitable for production multi-instance deployments.
 */
export class InMemoryBillingStore extends BillingStore {
  private readonly accounts = new Map<string, BillingAccount>();
  private readonly accountsByTenantId = new Map<string, BillingAccount>();
  private readonly accountsByExternalId = new Map<string, BillingAccount>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly subscriptionsByExternalId = new Map<string, Subscription>();
  private readonly lifecycleCommands = new Map<string, BillingLifecycleCommand>();
  private readonly pendingLifecycleCommandKeysByTenantId = new Map<string, string>();
  private readonly orders = new Map<string, Order[]>();
  private readonly processedWebhooks = new Map<string, WebhookState>();
  private readonly subscriptionWebhookTransitions = new Map<
    string,
    BillingSubscriptionWebhookTransition
  >();
  private webhookDeliveryClaimSequence = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {
    super();
  }

  async findAccountByTenantId(tenantId: string): Promise<BillingAccount | null> {
    const account = this.accountsByTenantId.get(tenantId);
    return account ? cloneAccount(account) : null;
  }

  async findAccountByExternalId(externalCustomerId: string): Promise<BillingAccount | null> {
    const account = this.accountsByExternalId.get(externalCustomerId);
    return account ? cloneAccount(account) : null;
  }

  async saveAccount(account: BillingAccount): Promise<void> {
    const existingAccount = this.accounts.get(account.id);
    const tenantAccount = this.accountsByTenantId.get(account.tenantId);

    if (tenantAccount && tenantAccount.id !== account.id) {
      throw new BillingAccountTenantConflictProblem(account.tenantId, tenantAccount.id, account.id);
    }

    if (existingAccount && existingAccount.tenantId !== account.tenantId) {
      this.accountsByTenantId.delete(existingAccount.tenantId);
    }

    if (existingAccount && existingAccount.externalCustomerId !== account.externalCustomerId) {
      this.accountsByExternalId.delete(existingAccount.externalCustomerId);
    }

    const storedAccount = Object.freeze(cloneAccount(account));
    this.accounts.set(account.id, storedAccount);
    this.accountsByTenantId.set(account.tenantId, storedAccount);
    this.accountsByExternalId.set(account.externalCustomerId, storedAccount);
  }

  async deleteAccount(billingAccountId: string): Promise<void> {
    const account = this.accounts.get(billingAccountId);

    if (!account) {
      return;
    }

    this.accounts.delete(billingAccountId);
    this.accountsByTenantId.delete(account.tenantId);
    this.accountsByExternalId.delete(account.externalCustomerId);
  }

  async findSubscription(billingAccountId: string): Promise<Subscription | null> {
    const subscription = this.subscriptions.get(billingAccountId);
    return subscription ? cloneSubscription(subscription) : null;
  }

  async findSubscriptionByExternalId(externalSubscriptionId: string): Promise<Subscription | null> {
    const subscription = this.subscriptionsByExternalId.get(externalSubscriptionId);
    return subscription ? cloneSubscription(subscription) : null;
  }

  async saveSubscription(subscription: Subscription): Promise<void> {
    const existingSubscription = this.subscriptions.get(subscription.billingAccountId);

    if (
      existingSubscription &&
      existingSubscription.externalSubscriptionId !== subscription.externalSubscriptionId
    ) {
      this.subscriptionsByExternalId.delete(existingSubscription.externalSubscriptionId);
    }

    const storedSubscription = Object.freeze(cloneSubscription(subscription));
    this.subscriptions.set(subscription.billingAccountId, storedSubscription);
    this.subscriptionsByExternalId.set(subscription.externalSubscriptionId, storedSubscription);
  }

  async deleteSubscription(billingAccountId: string): Promise<void> {
    const subscription = this.subscriptions.get(billingAccountId);

    if (!subscription) {
      return;
    }

    this.subscriptions.delete(billingAccountId);
    this.subscriptionsByExternalId.delete(subscription.externalSubscriptionId);
  }

  async reconcileLifecycleSubscription(
    command: BillingLifecycleCommand,
    target: Subscription | null,
  ): Promise<BillingLifecycleLocalResult> {
    const current = this.subscriptions.get(command.subscription.billingAccountId);
    if (current && current.externalSubscriptionId !== command.subscription.externalSubscriptionId) {
      return "superseded";
    }

    if (target) {
      if (!current) {
        return "superseded";
      }

      await this.saveSubscription(rebaseLifecycleTarget(current, target, command.kind));
      return "applied";
    }

    if (!current) {
      return "applied";
    }

    this.subscriptions.delete(current.billingAccountId);
    this.subscriptionsByExternalId.delete(current.externalSubscriptionId);

    return "applied";
  }

  async resolveLifecycleSubscription(
    command: BillingLifecycleCommand,
  ): Promise<BillingLifecycleSubscriptionResolution> {
    const storedCommand = this.lifecycleCommands.get(command.idempotencyKey);
    const current = this.subscriptions.get(command.subscription.billingAccountId);
    if (
      !storedCommand ||
      storedCommand.revision !== command.revision ||
      (storedCommand.state !== "pending_local" && storedCommand.state !== "pending_event") ||
      !current ||
      current.externalSubscriptionId !== command.subscription.externalSubscriptionId
    ) {
      return {
        kind: "current",
        subscription: current ? cloneSubscription(current) : null,
      };
    }

    return {
      kind: "projection_base",
      subscription: cloneSubscription(current),
    };
  }

  async createLifecycleCommand(command: BillingLifecycleCommand): Promise<BillingLifecycleCommand> {
    if (command.state !== "pending_provider" || command.revision !== 0) {
      throw new BillingLifecycleCommandConflictProblem(command.idempotencyKey);
    }

    const existing = this.lifecycleCommands.get(command.idempotencyKey);
    if (existing) {
      if (!sameLifecycleIntent(existing, command)) {
        throw new BillingLifecycleCommandConflictProblem(command.idempotencyKey);
      }

      return cloneLifecycleCommand(existing);
    }

    const pendingKey = this.pendingLifecycleCommandKeysByTenantId.get(command.tenantId);
    if (pendingKey) {
      throw new BillingLifecycleCommandInProgressProblem(command.tenantId, pendingKey);
    }

    const storedCommand = Object.freeze(cloneLifecycleCommand(command));
    this.lifecycleCommands.set(command.idempotencyKey, storedCommand);
    this.pendingLifecycleCommandKeysByTenantId.set(command.tenantId, command.idempotencyKey);
    return cloneLifecycleCommand(storedCommand);
  }

  async findLifecycleCommand(idempotencyKey: string): Promise<BillingLifecycleCommand | null> {
    const command = this.lifecycleCommands.get(idempotencyKey);
    return command ? cloneLifecycleCommand(command) : null;
  }

  async findPendingLifecycleCommandByTenantId(
    tenantId: string,
  ): Promise<BillingLifecycleCommand | null> {
    const idempotencyKey = this.pendingLifecycleCommandKeysByTenantId.get(tenantId);
    if (!idempotencyKey) {
      return null;
    }

    const command = this.lifecycleCommands.get(idempotencyKey);
    return command ? cloneLifecycleCommand(command) : null;
  }

  async saveLifecycleCommand(command: BillingLifecycleCommand): Promise<BillingLifecycleCommand> {
    const existing = this.lifecycleCommands.get(command.idempotencyKey);
    if (
      !existing ||
      !sameLifecycleIntent(existing, command) ||
      existing.revision !== command.revision ||
      !isLifecycleTransitionAllowed(existing.state, command.state)
    ) {
      throw new BillingLifecycleCommandConflictProblem(command.idempotencyKey);
    }

    const storedCommand = Object.freeze(
      cloneLifecycleCommand({
        ...command,
        revision: command.revision + 1,
      }),
    );
    this.lifecycleCommands.set(command.idempotencyKey, storedCommand);
    if (command.state === "completed") {
      if (
        this.pendingLifecycleCommandKeysByTenantId.get(command.tenantId) === command.idempotencyKey
      ) {
        this.pendingLifecycleCommandKeysByTenantId.delete(command.tenantId);
      }
    } else {
      this.pendingLifecycleCommandKeysByTenantId.set(command.tenantId, command.idempotencyKey);
    }
    return cloneLifecycleCommand(storedCommand);
  }

  async claimLifecycleEventDelivery(
    command: BillingLifecycleCommand,
    leaseDurationMs: number,
  ): Promise<BillingLifecycleCommand | null> {
    const now = this.clock();
    const existing = this.lifecycleCommands.get(command.idempotencyKey);
    if (
      !existing ||
      existing.state !== "pending_event" ||
      existing.revision !== command.revision ||
      (existing.eventDeliveryLeaseUntil &&
        existing.eventDeliveryLeaseUntil.getTime() > now.getTime())
    ) {
      return null;
    }

    const claimed = Object.freeze(
      cloneLifecycleCommand({
        ...existing,
        revision: existing.revision + 1,
        eventDeliveryLeaseUntil: new Date(now.getTime() + leaseDurationMs),
        updatedAt: now,
      }),
    );
    this.lifecycleCommands.set(command.idempotencyKey, claimed);
    return cloneLifecycleCommand(claimed);
  }

  async listPendingLifecycleCommands(limit: number): Promise<BillingLifecycleCommand[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      return [];
    }

    return [...this.lifecycleCommands.values()]
      .filter((command) => command.state !== "completed")
      .sort((left, right) => {
        const createdAtOrder = left.createdAt.getTime() - right.createdAt.getTime();
        return createdAtOrder || left.idempotencyKey.localeCompare(right.idempotencyKey);
      })
      .slice(0, limit)
      .map(cloneLifecycleCommand);
  }

  async saveOrder(order: Order): Promise<void> {
    const existing = this.orders.get(order.billingAccountId) ?? [];
    const index = existing.findIndex((savedOrder) => savedOrder.id === order.id);
    if (index === -1) {
      existing.push(order);
    } else {
      existing[index] = order;
    }
    this.orders.set(order.billingAccountId, existing);
  }

  async findOrdersByAccount(billingAccountId: string): Promise<Order[]> {
    return this.orders.get(billingAccountId) ?? [];
  }

  async commitSubscriptionWebhook(
    input: CommitBillingSubscriptionWebhookInput,
  ): Promise<BillingSubscriptionWebhookTransition> {
    const existingTransition = this.subscriptionWebhookTransitions.get(input.eventId);
    if (existingTransition) {
      return cloneSubscriptionWebhookTransition(existingTransition);
    }
    if (this.processedWebhooks.has(input.eventId)) {
      throw new WebhookAlreadyProcessedProblem(input.eventId);
    }

    const previousSubscription = this.subscriptions.get(input.subscription.billingAccountId);
    const previousEvidence = previousSubscription ? cloneSubscription(previousSubscription) : null;
    const intents = input.createEventIntents(previousEvidence).map((event) => ({
      event: structuredClone(event),
      publishedAt: null,
    }));
    const transition: BillingSubscriptionWebhookTransition = {
      eventId: input.eventId,
      eventType: input.eventType,
      previousSubscription: previousEvidence,
      subscription: cloneSubscription(input.subscription),
      intents,
      state: "pending",
    };

    const clearedReservationState = input.clearWebhookReservationId
      ? this.processedWebhooks.get(input.clearWebhookReservationId)
      : undefined;
    if (input.clearWebhookReservationId) {
      this.processedWebhooks.delete(input.clearWebhookReservationId);
    }
    this.processedWebhooks.set(input.eventId, { state: "RESERVED" });
    this.subscriptionWebhookTransitions.set(input.eventId, transition);
    try {
      await this.saveSubscription(input.subscription);
    } catch (error) {
      this.processedWebhooks.delete(input.eventId);
      this.subscriptionWebhookTransitions.delete(input.eventId);
      if (input.clearWebhookReservationId && clearedReservationState) {
        this.processedWebhooks.set(input.clearWebhookReservationId, clearedReservationState);
      }
      throw error;
    }
    return cloneSubscriptionWebhookTransition(transition);
  }

  async markWebhookEventIntentPublished(eventId: string, intentEventId: string): Promise<void> {
    const transition = this.subscriptionWebhookTransitions.get(eventId);
    if (!transition) {
      throw new WebhookAlreadyProcessedProblem(eventId);
    }

    const intents: BillingWebhookEventIntent[] = transition.intents.map((intent) =>
      intent.event.eventId === intentEventId
        ? { event: structuredClone(intent.event), publishedAt: intent.publishedAt ?? this.clock() }
        : cloneWebhookEventIntent(intent),
    );
    this.subscriptionWebhookTransitions.set(eventId, {
      ...transition,
      intents,
    });
  }

  async claimWebhookDelivery(
    eventId: string,
    _eventType: string,
    leaseDurationMs: number,
  ): Promise<BillingWebhookDeliveryClaim> {
    const existing = this.processedWebhooks.get(eventId);
    if (existing?.state === "COMPLETED") return { status: "completed" };

    const now = this.clock();
    if (existing?.leaseUntil && existing.leaseUntil.getTime() > now.getTime()) {
      return { status: "in_progress" };
    }

    const token = `${eventId}:${++this.webhookDeliveryClaimSequence}`;
    this.processedWebhooks.set(eventId, {
      state: "RESERVED",
      leaseUntil: new Date(now.getTime() + leaseDurationMs),
      claimToken: token,
    });
    return { status: "claimed", token };
  }

  async completeWebhookDelivery(eventId: string, claimToken: string): Promise<boolean> {
    const existing = this.processedWebhooks.get(eventId);
    if (
      existing?.state !== "RESERVED" ||
      existing.claimToken !== claimToken ||
      !existing.leaseUntil ||
      existing.leaseUntil.getTime() <= this.clock().getTime()
    ) {
      return false;
    }
    this.processedWebhooks.set(eventId, { state: "COMPLETED" });
    return true;
  }

  async releaseWebhookDelivery(eventId: string, claimToken: string): Promise<boolean> {
    const existing = this.processedWebhooks.get(eventId);
    if (
      existing?.state !== "RESERVED" ||
      existing.claimToken !== claimToken ||
      !existing.leaseUntil ||
      existing.leaseUntil.getTime() <= this.clock().getTime()
    ) {
      return false;
    }
    this.processedWebhooks.delete(eventId);
    return true;
  }

  async reserveWebhook(eventId: string, _eventType: string): Promise<void> {
    if (this.processedWebhooks.has(eventId)) {
      throw new WebhookAlreadyProcessedProblem(eventId);
    }

    this.processedWebhooks.set(eventId, { state: "RESERVED" });
  }

  async completeWebhook(eventId: string): Promise<void> {
    if (this.processedWebhooks.get(eventId)?.state !== "RESERVED") {
      throw new WebhookAlreadyProcessedProblem(eventId);
    }

    const transition = this.subscriptionWebhookTransitions.get(eventId);
    if (transition?.intents.some((intent) => intent.publishedAt === null)) {
      throw new WebhookEventIntentsPendingProblem(eventId);
    }

    this.processedWebhooks.set(eventId, { state: "COMPLETED" });
    if (transition) {
      this.subscriptionWebhookTransitions.set(eventId, { ...transition, state: "completed" });
    }
  }

  async failWebhook(eventId: string): Promise<void> {
    this.processedWebhooks.delete(eventId);
  }

  /**
   * Clear all data (for testing)
   */
  reset(): void {
    this.accounts.clear();
    this.accountsByTenantId.clear();
    this.accountsByExternalId.clear();
    this.subscriptions.clear();
    this.subscriptionsByExternalId.clear();
    this.lifecycleCommands.clear();
    this.pendingLifecycleCommandKeysByTenantId.clear();
    this.orders.clear();
    this.processedWebhooks.clear();
    this.subscriptionWebhookTransitions.clear();
    this.webhookDeliveryClaimSequence = 0;
  }
}

function cloneWebhookEventIntent(intent: BillingWebhookEventIntent): BillingWebhookEventIntent {
  return {
    event: structuredClone(intent.event),
    publishedAt: intent.publishedAt ? new Date(intent.publishedAt) : null,
  };
}

function cloneAccount(account: BillingAccount): BillingAccount {
  return {
    ...account,
    createdAt: new Date(account.createdAt),
  };
}

function cloneSubscriptionWebhookTransition(
  transition: BillingSubscriptionWebhookTransition,
): BillingSubscriptionWebhookTransition {
  return {
    ...transition,
    previousSubscription: transition.previousSubscription
      ? cloneSubscription(transition.previousSubscription)
      : null,
    subscription: cloneSubscription(transition.subscription),
    intents: transition.intents.map(cloneWebhookEventIntent),
  };
}

function cloneSubscription(subscription: Subscription): Subscription {
  return {
    ...subscription,
    currentPeriodEnd: new Date(subscription.currentPeriodEnd),
    lastSyncedAt: new Date(subscription.lastSyncedAt),
  };
}

function cloneLifecycleCommand(command: BillingLifecycleCommand): BillingLifecycleCommand {
  return {
    ...command,
    subscription: cloneSubscription(command.subscription),
    createdAt: new Date(command.createdAt),
    updatedAt: new Date(command.updatedAt),
    ...(command.eventDeliveryLeaseUntil
      ? { eventDeliveryLeaseUntil: new Date(command.eventDeliveryLeaseUntil) }
      : {}),
    ...(command.lastFailure
      ? {
          lastFailure: {
            ...command.lastFailure,
            occurredAt: new Date(command.lastFailure.occurredAt),
          },
        }
      : {}),
  };
}

function rebaseLifecycleTarget(
  current: Subscription,
  target: Subscription,
  kind: BillingLifecycleCommand["kind"],
): Subscription {
  return {
    ...current,
    status: kind === "cancel_immediately" ? "canceled" : current.status,
    cancelAtPeriodEnd: target.cancelAtPeriodEnd,
    lastSyncedAt: new Date(Math.max(current.lastSyncedAt.getTime(), target.lastSyncedAt.getTime())),
  };
}

function sameLifecycleIntent(
  left: BillingLifecycleCommand,
  right: BillingLifecycleCommand,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.kind === right.kind &&
    left.subscription.billingAccountId === right.subscription.billingAccountId &&
    left.subscription.externalSubscriptionId === right.subscription.externalSubscriptionId
  );
}

function isLifecycleTransitionAllowed(
  from: BillingLifecycleCommand["state"],
  to: BillingLifecycleCommand["state"],
): boolean {
  if (from === "pending_provider") {
    return to === "pending_provider" || to === "pending_local";
  }

  if (from === "pending_local") {
    return to === "pending_local" || to === "pending_event" || to === "completed";
  }

  if (from === "pending_event") {
    return to === "pending_event" || to === "completed";
  }

  return false;
}
