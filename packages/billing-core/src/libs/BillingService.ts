import { createHash } from "node:crypto";
import {
  deriveIdempotencyKey,
  type DerivedIdempotencyKey,
  type IdempotencyStore,
} from "@croco/idempotency-core";
import { Problem } from "@croco/problems-core";
import { Trace } from "@croco/telemetry-api";
import type {
  BillingAccount,
  BillingLifecycleCommand,
  BillingLifecycleCommandKind,
  BillingLifecycleLocalResult,
  Subscription,
  SubscriptionStatus,
} from "../types";
import type { BillingGateway, CheckoutResult, CreateCheckoutParams } from "./BillingGateway";
import type { BillingStore } from "./BillingStore";
import { SubscriptionCanceledEvent } from "./events/SubscriptionCanceledEvent";
import {
  BillingAccountNotFoundProblem,
  BillingCheckoutCreationProblem,
  BillingCheckoutInProgressProblem,
  BillingLifecycleCommandConflictProblem,
  BillingLifecycleCommandNotFoundProblem,
  InvalidBillingLifecycleIdempotencyKeyProblem,
  SubscriptionNotFoundProblem,
} from "./problems/BillingProblems";

/**
 * Publishes billing lifecycle events with durable event-ID deduplication.
 *
 * Implementations must treat repeated calls with the same `event.eventId` as one logical delivery,
 * including retries after an ambiguous result where the first call may already have produced the
 * side effect.
 */
export interface BillingLifecycleEventPublisher {
  publishIdempotently(event: SubscriptionCanceledEvent): Promise<void>;
}

type BillingCheckoutResponse = {
  checkoutUrl: string;
};

type InFlightCheckout = {
  readonly fingerprint: string;
  readonly promise: Promise<BillingCheckoutResponse>;
};

export type BillingServiceDependencies = {
  store: BillingStore;
  gateway: BillingGateway;
  checkoutIdempotencyStore: IdempotencyStore<CheckoutResult>;
  /**
   * Maximum time one request owns an unfinished checkout reservation.
   * Expiration lets a later request retry provider reconciliation or creation after an abandoned owner.
   */
  checkoutReservationTtlMs?: number;
  eventPublisher?: BillingLifecycleEventPublisher;
  clock?: () => Date;
};

export type CreateBillingCheckoutParams = Omit<CreateCheckoutParams, "billingAccountId"> & {
  tenantId: string;
};

export type CancelSubscriptionParams = {
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly immediate?: boolean;
};

export type ResumeSubscriptionParams = {
  readonly tenantId: string;
  readonly idempotencyKey: string;
};

export type ReconcileBillingLifecycleCommandsResult = {
  readonly commands: readonly BillingLifecycleCommand[];
  readonly completed: number;
  readonly pendingProvider: number;
  readonly pendingLocal: number;
  readonly pendingEvent: number;
};

const DEFAULT_RECONCILIATION_LIMIT = 100;
const DEFAULT_CHECKOUT_RESERVATION_TTL_MS = 5 * 60 * 1_000;
const EVENT_DELIVERY_LEASE_MS = 30_000;
const PROVIDER_FAILURE_DETAIL = "Provider lifecycle command failed";
const LOCAL_FAILURE_DETAIL = "Local lifecycle reconciliation failed";
const EVENT_FAILURE_DETAIL = "Lifecycle event delivery failed";

/**
 * Billing service for subscription management.
 * Orchestrates store and gateway operations.
 */
export class BillingService {
  private readonly store: BillingStore;
  private readonly gateway: BillingGateway;
  private readonly checkoutIdempotencyStore: IdempotencyStore<CheckoutResult>;
  private readonly checkoutReservationTtlMs: number;
  private readonly eventPublisher?: BillingLifecycleEventPublisher;
  private readonly clock: () => Date;
  private readonly inFlightCheckouts = new Map<string, InFlightCheckout>();

  constructor(deps: BillingServiceDependencies) {
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.checkoutIdempotencyStore = deps.checkoutIdempotencyStore;
    this.checkoutReservationTtlMs =
      deps.checkoutReservationTtlMs ?? DEFAULT_CHECKOUT_RESERVATION_TTL_MS;
    this.eventPublisher = deps.eventPublisher;
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Check if a tenant has an active subscription.
   */
  async hasActiveSubscription(tenantId: string): Promise<boolean> {
    const subscription = await this.findEffectiveSubscriptionByTenantId(tenantId);
    if (!subscription) return false;
    return subscription.status === "active" || subscription.status === "trialing";
  }

  /**
   * Get subscription status for a tenant.
   */
  async getSubscriptionStatus(tenantId: string): Promise<SubscriptionStatus | null> {
    const subscription = await this.findEffectiveSubscriptionByTenantId(tenantId);
    return subscription?.status ?? null;
  }

  /**
   * Get full subscription details.
   */
  async getSubscription(tenantId: string): Promise<Subscription | null> {
    return this.findEffectiveSubscriptionByTenantId(tenantId);
  }

  /**
   * Create a checkout session for a tenant.
   */
  @Trace({ name: "billing.checkout.create" })
  async createCheckout(params: CreateBillingCheckoutParams): Promise<{ checkoutUrl: string }> {
    const account = await this.store.findAccountByTenantId(params.tenantId);
    const key = this.createCheckoutIdempotencyKey(params);
    const inFlight = this.inFlightCheckouts.get(key.storageKey);

    if (inFlight?.fingerprint === key.fingerprint) {
      return inFlight.promise;
    }

    const promise = this.createIdempotentCheckout(params, key, account);
    this.inFlightCheckouts.set(key.storageKey, {
      fingerprint: key.fingerprint,
      promise,
    });

    try {
      return await promise;
    } finally {
      if (this.inFlightCheckouts.get(key.storageKey)?.promise === promise) {
        this.inFlightCheckouts.delete(key.storageKey);
      }
    }
  }

  private async createIdempotentCheckout(
    params: CreateBillingCheckoutParams,
    key: DerivedIdempotencyKey,
    account: BillingAccount | null,
  ): Promise<BillingCheckoutResponse> {
    const reservation = await this.checkoutIdempotencyStore.reserve(key, {
      ttlMs: this.checkoutReservationTtlMs,
      metadata: {
        productId: params.productId,
      },
    });

    if (reservation.outcome === "replay") {
      return { checkoutUrl: reservation.response.checkoutUrl };
    }

    if (reservation.outcome === "in-flight") {
      return this.reconcileInFlightCheckout(params, key, account);
    }

    if (reservation.outcome === "failed") {
      throw new BillingCheckoutCreationProblem(
        params.tenantId,
        `A previous checkout attempt for tenant ${params.tenantId} cannot be retried`,
      );
    }

    let checkout: CheckoutResult;
    try {
      checkout = await this.createProviderCheckout(params, key.storageKey, account);
    } catch (error) {
      if (error instanceof BillingCheckoutInProgressProblem) {
        throw error;
      }

      try {
        await this.checkoutIdempotencyStore.fail({
          key,
          reservationId: reservation.reservation.reservationId,
          retryable: true,
          metadata: {
            productId: params.productId,
          },
        });
      } catch (storageError) {
        throw new BillingCheckoutInProgressProblem(
          params.tenantId,
          storageError instanceof Error ? storageError : undefined,
        );
      }

      throw this.createCheckoutError(params.tenantId, error);
    }

    return this.commitCheckout(
      params.tenantId,
      key,
      reservation.reservation.reservationId,
      checkout,
    );
  }

  private async reconcileInFlightCheckout(
    params: CreateBillingCheckoutParams,
    key: DerivedIdempotencyKey,
    account: BillingAccount | null,
  ): Promise<BillingCheckoutResponse> {
    const checkout = await this.gateway.reconcileCheckout(
      this.toGatewayCheckoutParams(params, account?.id ?? params.tenantId, key.storageKey),
    );

    if (checkout === null) {
      throw new BillingCheckoutInProgressProblem(params.tenantId);
    }

    return { checkoutUrl: checkout.checkoutUrl };
  }

  private async commitCheckout(
    tenantId: string,
    key: DerivedIdempotencyKey,
    reservationId: string,
    checkout: CheckoutResult,
  ): Promise<BillingCheckoutResponse> {
    try {
      await this.checkoutIdempotencyStore.commit({
        key,
        reservationId,
        response: checkout,
        metadata: {
          checkoutId: checkout.checkoutId,
        },
      });
    } catch (storageError) {
      throw new BillingCheckoutInProgressProblem(
        tenantId,
        storageError instanceof Error ? storageError : undefined,
      );
    }

    return { checkoutUrl: checkout.checkoutUrl };
  }

  private async createProviderCheckout(
    params: CreateBillingCheckoutParams,
    providerOperationKey: string,
    account: BillingAccount | null,
  ): Promise<CheckoutResult> {
    if (account) {
      return this.gateway.createCheckout(
        this.toGatewayCheckoutParams(params, account.id, providerOperationKey),
      );
    }

    return this.createCheckoutWithAccountTransaction(params, providerOperationKey);
  }

  private async createCheckoutWithAccountTransaction(
    params: CreateBillingCheckoutParams,
    providerOperationKey: string,
  ): Promise<CheckoutResult> {
    const billingAccountId = params.tenantId;
    const externalCustomerId = await this.gateway.ensureCustomer(billingAccountId, params.email);
    const accountDraft = {
      id: billingAccountId,
      tenantId: params.tenantId,
      externalCustomerId,
      email: params.email,
      createdAt: new Date(),
    };

    await this.store.saveAccount(accountDraft);
    return this.gateway.createCheckout(
      this.toGatewayCheckoutParams(params, billingAccountId, providerOperationKey),
    );
  }

  private toGatewayCheckoutParams(
    params: CreateBillingCheckoutParams,
    billingAccountId: string,
    providerOperationKey: string,
  ): CreateCheckoutParams {
    return {
      billingAccountId,
      email: params.email,
      productId: params.productId,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      idempotencyKey: providerOperationKey,
    };
  }

  private createCheckoutIdempotencyKey(params: CreateBillingCheckoutParams): DerivedIdempotencyKey {
    return deriveIdempotencyKey({
      namespace: "billing-checkout",
      tenantId: params.tenantId,
      source: {
        kind: "explicit",
        key: params.idempotencyKey,
        fingerprint: hashCheckoutValue(
          stableStringify({
            cancelUrl: params.cancelUrl ?? null,
            email: params.email,
            productId: params.productId,
            successUrl: params.successUrl,
          }),
        ),
      },
    });
  }

  private createCheckoutError(
    billingAccountId: string,
    error: unknown,
  ): BillingCheckoutCreationProblem {
    if (error instanceof Error) {
      return new BillingCheckoutCreationProblem(
        billingAccountId,
        `Failed to create checkout for tenant ${billingAccountId}: ${error.message}`,
      );
    }

    return new BillingCheckoutCreationProblem(billingAccountId);
  }

  /**
   * Persist and execute a provider-idempotent cancellation command.
   *
   * The returned command may remain `pending_provider` or `pending_local` when reconciliation is
   * required. Callers must not interpret promise fulfillment as an atomic cross-system commit.
   */
  @Trace({ name: "billing.subscription.cancel" })
  async cancelSubscription(params: CancelSubscriptionParams): Promise<BillingLifecycleCommand> {
    const kind = params.immediate ? "cancel_immediately" : "cancel_at_period_end";
    const command = await this.getOrCreateLifecycleCommand(
      params.tenantId,
      params.idempotencyKey,
      kind,
    );
    return this.executeLifecycleCommand(command);
  }

  /**
   * Persist and execute a provider-idempotent resume command.
   */
  @Trace({ name: "billing.subscription.resume" })
  async resumeSubscription(params: ResumeSubscriptionParams): Promise<BillingLifecycleCommand> {
    const command = await this.getOrCreateLifecycleCommand(
      params.tenantId,
      params.idempotencyKey,
      "resume",
    );
    return this.executeLifecycleCommand(command);
  }

  /**
   * Retry one durable lifecycle command from its persisted reconciliation state.
   */
  async reconcileLifecycleCommand(idempotencyKey: string): Promise<BillingLifecycleCommand> {
    this.assertIdempotencyKey(idempotencyKey);
    const command = await this.store.findLifecycleCommand(idempotencyKey);
    if (!command) {
      throw new BillingLifecycleCommandNotFoundProblem(idempotencyKey);
    }

    return this.executeLifecycleCommand(command);
  }

  /**
   * Retry a bounded, deterministic batch of incomplete lifecycle commands.
   */
  async reconcilePendingLifecycleCommands(
    limit = DEFAULT_RECONCILIATION_LIMIT,
  ): Promise<ReconcileBillingLifecycleCommandsResult> {
    const commands = await this.store.listPendingLifecycleCommands(limit);
    const reconciled: BillingLifecycleCommand[] = [];

    for (const command of commands) {
      reconciled.push(await this.executeLifecycleCommand(command));
    }

    return {
      commands: reconciled,
      completed: reconciled.filter((command) => command.state === "completed").length,
      pendingProvider: reconciled.filter((command) => command.state === "pending_provider").length,
      pendingLocal: reconciled.filter((command) => command.state === "pending_local").length,
      pendingEvent: reconciled.filter((command) => command.state === "pending_event").length,
    };
  }

  /**
   * Get customer portal URL.
   */
  @Trace({ name: "billing.portal.get" })
  async getCustomerPortalUrl(tenantId: string): Promise<string> {
    const account = await this.store.findAccountByTenantId(tenantId);
    if (!account) {
      throw new BillingAccountNotFoundProblem(tenantId);
    }

    return this.gateway.getCustomerPortalUrl(account.externalCustomerId);
  }

  private async findSubscriptionByTenantId(tenantId: string): Promise<Subscription | null> {
    const account = await this.store.findAccountByTenantId(tenantId);
    if (!account) {
      return null;
    }

    return this.store.findSubscription(account.id);
  }

  private async findEffectiveSubscriptionByTenantId(
    tenantId: string,
  ): Promise<Subscription | null> {
    const pendingCommand = await this.store.findPendingLifecycleCommandByTenantId(tenantId);
    if (pendingCommand?.state === "pending_local" || pendingCommand?.state === "pending_event") {
      const resolution = await this.store.resolveLifecycleSubscription(pendingCommand);
      if (resolution.kind === "projection_base") {
        return this.projectSubscription(pendingCommand, resolution.subscription);
      }
      return resolution.subscription;
    }

    return this.findSubscriptionByTenantId(tenantId);
  }

  private projectSubscription(command: BillingLifecycleCommand, base: Subscription): Subscription {
    if (command.kind === "cancel_immediately") {
      return {
        ...base,
        status: "canceled",
        cancelAtPeriodEnd: false,
        lastSyncedAt: new Date(command.updatedAt),
      };
    }

    return {
      ...base,
      cancelAtPeriodEnd: command.kind === "cancel_at_period_end",
      lastSyncedAt: new Date(command.updatedAt),
    };
  }

  private async getOrCreateLifecycleCommand(
    tenantId: string,
    idempotencyKey: string,
    kind: BillingLifecycleCommandKind,
  ): Promise<BillingLifecycleCommand> {
    this.assertIdempotencyKey(idempotencyKey);
    const existing = await this.store.findLifecycleCommand(idempotencyKey);
    if (existing) {
      if (existing.tenantId !== tenantId || existing.kind !== kind) {
        throw new BillingLifecycleCommandConflictProblem(idempotencyKey);
      }
      return existing;
    }

    const subscription = await this.findSubscriptionByTenantId(tenantId);
    if (!subscription) {
      throw new SubscriptionNotFoundProblem(tenantId);
    }

    const now = this.clock();
    return this.store.createLifecycleCommand({
      idempotencyKey,
      tenantId,
      kind,
      subscription,
      state: "pending_provider",
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async executeLifecycleCommand(
    initialCommand: BillingLifecycleCommand,
  ): Promise<BillingLifecycleCommand> {
    if (initialCommand.state === "completed") {
      return initialCommand;
    }

    let command = initialCommand;
    if (command.state === "pending_provider") {
      try {
        await this.applyProviderLifecycleCommand(command);
      } catch (error) {
        return this.persistLifecycleFailure(command, "provider", error);
      }

      command = await this.persistLifecycleState(command, "pending_local");
    }

    if (command.state === "pending_local") {
      try {
        const localResult = await this.applyLocalLifecycleCommand(command);
        command = {
          ...command,
          localResult,
        };
      } catch (error) {
        return this.persistLifecycleFailure(command, "local", error);
      }

      if (this.requiresCancellationEvent(command)) {
        command = await this.persistLifecycleState(command, "pending_event");
      } else {
        return this.persistLifecycleState(command, "completed");
      }
    }

    const claimed = await this.store.claimLifecycleEventDelivery(command, EVENT_DELIVERY_LEASE_MS);
    if (!claimed) {
      return (await this.store.findLifecycleCommand(command.idempotencyKey)) ?? command;
    }
    command = claimed;

    try {
      await this.publishCancellation(command);
    } catch (error) {
      return this.persistLifecycleFailure(command, "event", error);
    }

    return this.persistLifecycleState(command, "completed");
  }

  private async applyProviderLifecycleCommand(command: BillingLifecycleCommand): Promise<void> {
    const options = { idempotencyKey: command.idempotencyKey };
    if (command.kind === "resume") {
      await this.gateway.resumeSubscription(command.subscription.externalSubscriptionId, options);
      return;
    }

    await this.gateway.cancelSubscription(
      command.subscription.externalSubscriptionId,
      command.kind === "cancel_immediately",
      options,
    );
  }

  private async applyLocalLifecycleCommand(
    command: BillingLifecycleCommand,
  ): Promise<BillingLifecycleLocalResult> {
    const target = await this.createLocalLifecycleTarget(command);
    return this.store.reconcileLifecycleSubscription(command, target);
  }

  private async persistLifecycleState(
    command: BillingLifecycleCommand,
    state: BillingLifecycleCommand["state"],
  ): Promise<BillingLifecycleCommand> {
    const updated: BillingLifecycleCommand = {
      ...command,
      state,
      updatedAt: this.clock(),
      lastFailure: undefined,
      eventDeliveryLeaseUntil: undefined,
    };
    return this.store.saveLifecycleCommand(updated);
  }

  private async persistLifecycleFailure(
    command: BillingLifecycleCommand,
    stage: "provider" | "local" | "event",
    error: unknown,
  ): Promise<BillingLifecycleCommand> {
    const now = this.clock();
    const updated: BillingLifecycleCommand = {
      ...command,
      updatedAt: now,
      eventDeliveryLeaseUntil: undefined,
      lastFailure: {
        stage,
        code: this.failureCode(stage, error),
        detail: this.failureDetail(stage),
        attempt: (command.lastFailure?.attempt ?? 0) + 1,
        occurredAt: now,
      },
    };
    return this.store.saveLifecycleCommand(updated);
  }

  private failureCode(stage: "provider" | "local" | "event", error: unknown): string {
    if (error instanceof Problem) {
      return error.code;
    }

    return `billing/lifecycle-${stage}-failed`;
  }

  private failureDetail(stage: "provider" | "local" | "event"): string {
    if (stage === "provider") return PROVIDER_FAILURE_DETAIL;
    if (stage === "local") return LOCAL_FAILURE_DETAIL;
    return EVENT_FAILURE_DETAIL;
  }

  private assertIdempotencyKey(idempotencyKey: string): void {
    if (
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 200 ||
      !/^[\x20-\x7E]+$/.test(idempotencyKey)
    ) {
      throw new InvalidBillingLifecycleIdempotencyKeyProblem();
    }
  }

  private async publishCancellation(command: BillingLifecycleCommand): Promise<void> {
    if (!this.eventPublisher) return;
    await this.eventPublisher.publishIdempotently(
      new SubscriptionCanceledEvent(
        command.tenantId,
        command.subscription.externalSubscriptionId,
        command.kind === "cancel_at_period_end",
        `billing-lifecycle:${command.idempotencyKey}`,
        command.subscription.planVersionRef,
      ),
    );
  }

  private requiresCancellationEvent(command: BillingLifecycleCommand): boolean {
    return command.kind !== "resume" && this.eventPublisher !== undefined;
  }

  private async createLocalLifecycleTarget(
    command: BillingLifecycleCommand,
  ): Promise<Subscription | null> {
    if (command.kind !== "cancel_immediately") {
      return {
        ...command.subscription,
        cancelAtPeriodEnd: command.kind === "cancel_at_period_end",
        lastSyncedAt: this.clock(),
      };
    }

    const orders = await this.store.findOrdersByAccount(command.subscription.billingAccountId);

    if (orders.length > 0) {
      return {
        ...command.subscription,
        cancelAtPeriodEnd: false,
        status: "canceled",
        lastSyncedAt: this.clock(),
      };
    }

    return null;
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function hashCheckoutValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
