import type { SerializedEvent } from "@croco/events-core";
import type {
  BillingAccount,
  BillingLifecycleCommand,
  BillingLifecycleLocalResult,
  BillingLifecycleSubscriptionResolution,
  Order,
  Subscription,
} from "../types";

export type BillingWebhookEventIntent = {
  readonly event: SerializedEvent;
  readonly publishedAt: Date | null;
};

export type BillingSubscriptionWebhookTransition = {
  readonly eventId: string;
  readonly eventType: string;
  readonly previousSubscription: Subscription | null;
  readonly subscription: Subscription;
  readonly intents: readonly BillingWebhookEventIntent[];
  readonly state: "pending" | "completed";
};

export type CommitBillingSubscriptionWebhookInput = {
  readonly eventId: string;
  readonly eventType: string;
  readonly subscription: Subscription;
  readonly clearWebhookReservationId?: string;
  readonly createEventIntents: (
    previousSubscription: Subscription | null,
  ) => readonly SerializedEvent[];
};

export type BillingWebhookDeliveryClaim =
  | { readonly status: "claimed"; readonly token: string }
  | { readonly status: "in_progress" }
  | { readonly status: "completed" };

/**
 * Abstract storage for billing data.
 * The framework provides `InMemoryBillingStore`; applications may supply persistent adapters.
 */
export abstract class BillingStore {
  // BillingAccount
  abstract findAccountByTenantId(tenantId: string): Promise<BillingAccount | null>;
  abstract findAccountByExternalId(externalCustomerId: string): Promise<BillingAccount | null>;
  abstract saveAccount(account: BillingAccount): Promise<void>;
  abstract deleteAccount(billingAccountId: string): Promise<void>;

  // Subscription
  abstract findSubscription(billingAccountId: string): Promise<Subscription | null>;
  abstract findSubscriptionByExternalId(
    externalSubscriptionId: string,
  ): Promise<Subscription | null>;
  abstract saveSubscription(subscription: Subscription): Promise<void>;
  abstract deleteSubscription(billingAccountId: string): Promise<void>;
  /**
   * Applies a lifecycle target while the stored external subscription identity still matches the
   * command. Implementations must atomically rebase the lifecycle delta onto a newer snapshot of
   * that same external subscription. A `null` target atomically removes only the matching
   * subscription. The billing account and its lookup indices must be preserved.
   *
   * Implementations must return `superseded` without mutation only when a different external
   * subscription occupies the billing account.
   */
  abstract reconcileLifecycleSubscription(
    command: BillingLifecycleCommand,
    target: Subscription | null,
  ): Promise<BillingLifecycleLocalResult>;
  /**
   * Atomically resolves the subscription state for a pending lifecycle projection.
   *
   * Implementations must verify the command revision and pending state in the same operation that
   * reads and classifies the subscription. The result must carry either the latest same-identity
   * projection base or the authoritative replacement/absent state so callers never perform a
   * second, racy subscription read.
   */
  abstract resolveLifecycleSubscription(
    command: BillingLifecycleCommand,
  ): Promise<BillingLifecycleSubscriptionResolution>;

  // Subscription lifecycle commands
  /**
   * Persists a command before provider I/O.
   *
   * Implementations must return the existing command when the idempotency key and semantic
   * command fields match, reject semantic key reuse, and reject a second incomplete command for
   * the same tenant.
   */
  abstract createLifecycleCommand(
    command: BillingLifecycleCommand,
  ): Promise<BillingLifecycleCommand>;
  abstract findLifecycleCommand(idempotencyKey: string): Promise<BillingLifecycleCommand | null>;
  abstract findPendingLifecycleCommandByTenantId(
    tenantId: string,
  ): Promise<BillingLifecycleCommand | null>;
  /**
   * Saves failure evidence or advances a command monotonically through
   * `pending_provider` -> `pending_local` -> optional `pending_event` -> `completed`.
   *
   * `command.revision` is the expected current revision. Implementations must compare and increment
   * it atomically, reject stale writes, semantic mutations, invalid transitions, and attempts to
   * reopen or rewrite a completed command. Once local reconciliation runs, the command's
   * `localResult` must be persisted as durable convergence evidence.
   */
  abstract saveLifecycleCommand(command: BillingLifecycleCommand): Promise<BillingLifecycleCommand>;
  /**
   * Atomically claims event delivery for the expected command revision.
   *
   * Implementations must return `null` when the command is no longer `pending_event`, the revision
   * is stale, or another unexpired delivery lease exists. A successful claim increments the
   * revision and persists a lease computed from datastore-authoritative time.
   */
  abstract claimLifecycleEventDelivery(
    command: BillingLifecycleCommand,
    leaseDurationMs: number,
  ): Promise<BillingLifecycleCommand | null>;
  abstract listPendingLifecycleCommands(limit: number): Promise<BillingLifecycleCommand[]>;

  // Order
  abstract saveOrder(order: Order): Promise<void>;
  abstract findOrdersByAccount(billingAccountId: string): Promise<Order[]>;

  /**
   * Atomically reserves a subscription webhook, reads its previous subscription, saves the new
   * subscription, and persists every derived event intent. Repeated calls for the same webhook
   * must return the original transition without recomputing intents from current subscription
   * state.
   */
  abstract commitSubscriptionWebhook(
    input: CommitBillingSubscriptionWebhookInput,
  ): Promise<BillingSubscriptionWebhookTransition>;
  /**
   * Marks one stable event intent as durably published. Repeated calls with the same
   * `intentEventId` must be idempotent.
   */
  abstract markWebhookEventIntentPublished(eventId: string, intentEventId: string): Promise<void>;
  /**
   * Atomically claims a webhook-addressed delivery with a datastore-time lease.
   *
   * An active lease returns `in_progress`, an expired lease is reclaimed with a new token and
   * returns `claimed`, and a completed delivery returns `completed`.
   */
  abstract claimWebhookDelivery(
    eventId: string,
    eventType: string,
    leaseDurationMs: number,
  ): Promise<BillingWebhookDeliveryClaim>;
  /**
   * Completes the delivery only for the current, unexpired lease token. Returns `false` for a stale
   * or expired token.
   */
  abstract completeWebhookDelivery(eventId: string, claimToken: string): Promise<boolean>;
  /**
   * Releases the delivery only for the current, unexpired lease token. Returns `false` for a stale
   * or expired token.
   */
  abstract releaseWebhookDelivery(eventId: string, claimToken: string): Promise<boolean>;

  // Idempotency
  /**
   * Reserves a provider webhook event for processing.
   *
   * Store adapters must throw `WebhookAlreadyProcessedProblem` only when the exact event ID
   * reservation already exists. Other storage failures must retain their original failure semantics.
   */
  abstract reserveWebhook(eventId: string, eventType: string): Promise<void>;
  abstract completeWebhook(eventId: string): Promise<void>;
  /**
   * Idempotently removes a webhook reservation in either reserved or completed state.
   *
   * This operation must also succeed when no reservation exists so recovery work can be retried
   * independently of domain-state persistence.
   */
  abstract failWebhook(eventId: string): Promise<void>;
}
