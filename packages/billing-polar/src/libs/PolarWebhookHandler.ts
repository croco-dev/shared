import { createHash } from "node:crypto";
import type {
  BillingSubscriptionWebhookTransition,
  BillingStore,
  OrderPaymentReason,
  PlanRegistry,
  Subscription,
} from "@croco/billing-core";
import {
  PlanChangedEvent,
  SubscriptionActivatedEvent,
  SubscriptionCanceledEvent,
  SubscriptionPastDueEvent,
  SubscriptionRevokedEvent,
  WebhookAlreadyProcessedProblem,
} from "@croco/billing-core";
import type { DomainEvent } from "@croco/events-core";
import {
  DefaultEventSerializer,
  EventRegistry,
  restoreSerializedEventIdentity,
} from "@croco/events-core";
import { Problem } from "@croco/problems-core";
import { Trace } from "@croco/telemetry-api";
import { ZodError } from "zod";
import type { PolarConfig, WebhookHandlerResult } from "../types";
import { PolarEventMapper } from "./PolarEventMapper";
import { BillingStatusMappingProblem } from "./problems/BillingStatusMappingProblem";
import { validatePolarConfig } from "./problems/PolarBillingProblems";
import { WebhookProcessingProblem } from "./problems/WebhookProcessingProblem";
import { WebhookValidationProblem } from "./problems/WebhookValidationProblem";
import type { PolarEvent, PolarSubscriptionData } from "./schemas/polarWebhookSchema";
import {
  PolarEventSchema,
  PolarOrderDataSchema,
  PolarSubscriptionDataSchema,
} from "./schemas/polarWebhookSchema";
import { verifyPolarWebhook } from "./verifyPolarWebhook";

/**
 * Event publication contract required by Polar webhook handling.
 *
 * Existing `EventPublisher` instances must be wrapped by an adapter that durably deduplicates a
 * stable event identity before implementing `publishIdempotently`; forwarding that method directly
 * to `publishNow` does not satisfy this contract.
 */
export type PolarWebhookEventPublisher = {
  publishNow(event: DomainEvent): Promise<void>;
  /** Publishes one logical event exactly once across retries and concurrent workers. */
  publishIdempotently(event: DomainEvent): Promise<void>;
};

/** Dependencies for Polar webhook handling, including an idempotent publication adapter. */
export type WebhookDependencies = {
  store: BillingStore;
  /**
   * Use an adapter when migrating from `EventPublisher`; the adapter must provide durable,
   * stable-identity deduplication for `publishIdempotently`.
   */
  eventPublisher: PolarWebhookEventPublisher;
  planRegistry: PlanRegistry;
};

type PolarSubscriptionEventType =
  | "subscription.created"
  | "subscription.updated"
  | "subscription.active"
  | "subscription.canceled"
  | "subscription.revoked"
  | "subscription.past_due";

type PolarOrderEventType = "order.paid";

type ParsedSubscriptionPayload = {
  id: string;
  tenantId: string;
  productId: string;
  priceIds: readonly string[];
  rawStatus: PolarSubscriptionData["status"];
  status: Subscription["status"];
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
};

type ParsedOrderPayload = {
  id: string;
  tenantId: string;
  amount: number;
  currency: string;
  reason: OrderPaymentReason;
  paidAt: Date;
};

type ParsedWebhookEvent =
  | {
      kind: "subscription";
      eventType: PolarSubscriptionEventType;
      payload: ParsedSubscriptionPayload;
    }
  | {
      kind: "order";
      eventType: PolarOrderEventType;
      payload: ParsedOrderPayload;
    }
  | {
      kind: "ignored";
    };

export class PolarWebhookHandler {
  private static readonly DELIVERY_LEASE_MS = 30_000;
  private readonly store: BillingStore;
  private readonly eventPublisher: WebhookDependencies["eventPublisher"];
  private readonly planRegistry: PlanRegistry;
  private readonly eventMapper: PolarEventMapper;
  private readonly eventSerializer: DefaultEventSerializer;
  private readonly webhookSecret: string;
  private static readonly inFlightEvents = new Map<string, Promise<WebhookHandlerResult>>();

  constructor(config: PolarConfig, deps: WebhookDependencies) {
    this.webhookSecret = validatePolarConfig(config).webhookSecret;
    this.store = deps.store;
    this.eventPublisher = deps.eventPublisher;
    this.planRegistry = deps.planRegistry;
    this.eventMapper = new PolarEventMapper();
    this.eventSerializer = new DefaultEventSerializer(
      new EventRegistry()
        .register(PlanChangedEvent)
        .register(SubscriptionActivatedEvent)
        .register(SubscriptionCanceledEvent)
        .register(SubscriptionPastDueEvent)
        .register(SubscriptionRevokedEvent),
    );
  }

  @Trace({ name: "polar.webhook.handle" })
  async handle(
    body: Buffer | string,
    headers: Record<string, string>,
  ): Promise<WebhookHandlerResult> {
    let event: unknown;
    try {
      event = verifyPolarWebhook(body, headers, this.webhookSecret);
    } catch (error) {
      const reason = sanitizeWebhookValidationReason(
        error instanceof Error ? error.message : "Unknown error",
        [this.webhookSecret],
      );
      throw new WebhookValidationProblem(reason);
    }

    let parsedEvent: PolarEvent;
    try {
      parsedEvent = PolarEventSchema.parse(normalizeVerifiedEvent(event));
    } catch (error) {
      if (error instanceof ZodError) {
        throw new WebhookValidationProblem(`Invalid webhook payload: ${formatZodError(error)}`);
      }
      throw new WebhookValidationProblem("Invalid webhook payload");
    }

    const eventId = parsedEvent.id ?? headers["webhook-id"];
    const eventType = parsedEvent.type;

    if (!eventId || !eventType) {
      throw new WebhookValidationProblem("Missing event ID or type");
    }

    const parsedWebhookEvent = this.parseSignedEventPayload(eventType, parsedEvent.data);

    const inFlightEvent = PolarWebhookHandler.inFlightEvents.get(eventId);
    if (inFlightEvent) {
      return inFlightEvent;
    }

    const processingEvent = this.processEventAtomically(eventId, eventType, parsedWebhookEvent);
    PolarWebhookHandler.inFlightEvents.set(eventId, processingEvent);

    try {
      return await processingEvent;
    } finally {
      PolarWebhookHandler.inFlightEvents.delete(eventId);
    }
  }

  private async processEventAtomically(
    eventId: string,
    eventType: string,
    parsedEvent: ParsedWebhookEvent,
  ): Promise<WebhookHandlerResult> {
    if (parsedEvent.kind === "subscription") {
      return this.processSubscriptionEventAtomically(eventId, parsedEvent);
    }

    const shouldProcess = await this.reserveWebhook(eventId, eventType);
    if (!shouldProcess) {
      return { success: true, eventId };
    }

    try {
      await this.processParsedEvent(eventId, parsedEvent);
      await this.store.completeWebhook(eventId);

      return { success: true, eventId };
    } catch (error) {
      const rollbackErrorMessage = await this.tryRollbackWebhook(eventId);
      const baseErrorMessage = `Event processing failed: ${this.getErrorMessage(error)}`;
      throw new WebhookProcessingProblem(
        rollbackErrorMessage
          ? `${baseErrorMessage}; rollback failed: ${rollbackErrorMessage}`
          : baseErrorMessage,
        this.getProcessingCause(error),
      );
    }
  }

  private async processSubscriptionEventAtomically(
    eventId: string,
    event: Extract<ParsedWebhookEvent, { kind: "subscription" }>,
  ): Promise<WebhookHandlerResult> {
    let transition: BillingSubscriptionWebhookTransition;
    try {
      transition = await this.prepareSubscriptionTransition(eventId, event);
    } catch (error) {
      if (error instanceof WebhookAlreadyProcessedProblem) return { success: true, eventId };
      throw new WebhookProcessingProblem(
        `Event processing failed: ${this.getErrorMessage(error)}`,
        this.getProcessingCause(error),
      );
    }

    if (transition.state === "completed") {
      return { success: true, eventId };
    }

    try {
      for (const intent of transition.intents) {
        if (intent.publishedAt) continue;
        const domainEvent = this.eventSerializer.deserialize(intent.event);
        await this.publishDomainEvent(
          domainEvent,
          this.pastDueTransitionReservationId(event.payload.id),
        );
        await this.store.markWebhookEventIntentPublished(eventId, intent.event.eventId);
      }

      await this.store.completeWebhook(eventId);
      return { success: true, eventId };
    } catch (error) {
      throw new WebhookProcessingProblem(
        `Event processing failed: ${this.getErrorMessage(error)}`,
        this.getProcessingCause(error),
      );
    }
  }

  private async reserveWebhook(eventId: string, eventType: string): Promise<boolean> {
    try {
      await this.store.reserveWebhook(eventId, eventType);
      return true;
    } catch (error) {
      if (error instanceof WebhookAlreadyProcessedProblem) {
        return false;
      }
      if (error instanceof Error) {
        throw new WebhookProcessingProblem("Webhook reservation failed", error);
      }
      const cause = new Error("Billing store rejected webhook reservation with a non-Error value");
      Object.defineProperty(cause, "cause", { value: error });
      throw new WebhookProcessingProblem("Webhook reservation failed", cause);
    }
  }

  private async processParsedEvent(eventId: string, event: ParsedWebhookEvent): Promise<void> {
    if (event.kind === "order") {
      await this.handleOrderEvent(eventId, event.eventType, event.payload);
    }
  }

  private parseEvent(eventType: string, data: unknown): ParsedWebhookEvent {
    if (eventType.startsWith("subscription.")) {
      return {
        kind: "subscription",
        eventType: eventType as PolarSubscriptionEventType,
        payload: this.parseSubscriptionPayload(data),
      };
    }

    if (eventType === "order.paid") {
      return {
        kind: "order",
        eventType,
        payload: this.parseOrderPayload(data),
      };
    }

    return { kind: "ignored" };
  }

  private parseSignedEventPayload(eventType: string, data: unknown): ParsedWebhookEvent {
    try {
      return this.parseEvent(eventType, data);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new WebhookValidationProblem(`Invalid webhook payload: ${formatZodError(error)}`);
      }
      throw error;
    }
  }

  private parseSubscriptionPayload(data: unknown): ParsedSubscriptionPayload {
    const subscriptionData = PolarSubscriptionDataSchema.parse(data);

    const status = this.mapStatus(subscriptionData.status);
    return {
      id: subscriptionData.id,
      tenantId: this.extractTenantId(subscriptionData.customer),
      productId: subscriptionData.product?.id ?? "",
      priceIds: subscriptionData.prices?.map(({ id }) => id) ?? [],
      rawStatus: subscriptionData.status,
      status,
      currentPeriodEnd: this.resolveCurrentPeriodEnd(subscriptionData.currentPeriodEnd),
      cancelAtPeriodEnd: Boolean(subscriptionData.cancelAtPeriodEnd),
    };
  }
  private parseOrderPayload(data: unknown): ParsedOrderPayload {
    const orderData = PolarOrderDataSchema.parse(data);

    if (typeof orderData.amount !== "number" || Number.isNaN(orderData.amount)) {
      throw new WebhookProcessingProblem("Order amount is invalid");
    }

    if (!this.isNonEmptyString(orderData.currency)) {
      throw new WebhookProcessingProblem("Order currency is required");
    }

    return {
      id: orderData.id,
      tenantId: this.extractTenantId(orderData.customer),
      amount: orderData.amount,
      currency: orderData.currency,
      reason: this.mapOrderPaymentReason(orderData.billingReason),
      paidAt: this.resolvePaidAt(orderData.createdAt),
    };
  }
  private extractTenantId(customer?: {
    externalId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): string {
    if (!customer) {
      throw new WebhookProcessingProblem("Customer payload is required");
    }

    if (this.isNonEmptyString(customer.externalId)) {
      return customer.externalId;
    }

    const metadataTenantId = customer.metadata?.tenantId;
    if (this.isNonEmptyString(metadataTenantId)) {
      return metadataTenantId;
    }

    throw new WebhookProcessingProblem(
      "Customer externalId (tenantId) not found in webhook payload",
    );
  }
  private resolvePaidAt(createdAt: unknown): Date {
    if (createdAt === null || createdAt === undefined) {
      return new Date();
    }

    if (createdAt instanceof Date || this.isNonEmptyString(createdAt)) {
      const paidAt = new Date(createdAt);
      if (Number.isNaN(paidAt.getTime())) {
        throw new WebhookProcessingProblem("Order createdAt is invalid");
      }
      return paidAt;
    }

    throw new WebhookProcessingProblem("Order createdAt is invalid");
  }
  private resolveCurrentPeriodEnd(currentPeriodEnd: Date | string | null | undefined): Date {
    if (currentPeriodEnd === null || currentPeriodEnd === undefined) {
      throw new WebhookProcessingProblem("currentPeriodEnd is required");
    }

    const parsedCurrentPeriodEnd = new Date(currentPeriodEnd);
    if (Number.isNaN(parsedCurrentPeriodEnd.getTime())) {
      throw new WebhookProcessingProblem("currentPeriodEnd is invalid");
    }

    return parsedCurrentPeriodEnd;
  }
  private async prepareSubscriptionTransition(
    eventId: string,
    event: Extract<ParsedWebhookEvent, { kind: "subscription" }>,
  ): Promise<BillingSubscriptionWebhookTransition> {
    const { eventType, payload } = event;
    const planVersion = await this.planRegistry.resolveProviderPlanVersion({
      provider: "polar",
      productId: payload.productId,
      priceIds: payload.priceIds,
    });

    const subscription: Subscription = {
      id: payload.id,
      billingAccountId: payload.tenantId,
      externalSubscriptionId: payload.id,
      planId: planVersion.planId,
      planVersionRef: planVersion.ref,
      status: payload.status,
      currentPeriodEnd: payload.currentPeriodEnd,
      cancelAtPeriodEnd: payload.cancelAtPeriodEnd,
      lastSyncedAt: new Date(),
    };
    try {
      return await this.store.commitSubscriptionWebhook({
        eventId,
        eventType,
        subscription,
        ...(payload.status === "past_due"
          ? {}
          : { clearWebhookReservationId: this.pastDueTransitionReservationId(payload.id) }),
        createEventIntents: (previousSubscription) =>
          this.eventMapper
            .mapSubscriptionEvent(
              eventType,
              payload.tenantId,
              {
                id: payload.id,
                productId: planVersion.planId,
                planVersionRef: planVersion.ref,
                status: payload.rawStatus,
                cancelAtPeriodEnd: payload.cancelAtPeriodEnd,
              },
              previousSubscription?.planId,
              previousSubscription?.planVersionRef,
            )
            .map((domainEvent, index) => ({
              ...this.eventSerializer.serialize(domainEvent),
              eventId: this.webhookIntentEventId(eventId, domainEvent.eventName, index),
            })),
      });
    } catch (error) {
      if (error instanceof WebhookAlreadyProcessedProblem) throw error;
      if (error instanceof Error) {
        throw new WebhookProcessingProblem("Webhook transition commit failed", error);
      }
      const cause = new Error("Billing store rejected webhook transition with a non-Error value");
      Object.defineProperty(cause, "cause", { value: error });
      throw new WebhookProcessingProblem("Webhook transition commit failed", cause);
    }
  }

  private async handleOrderEvent(
    eventId: string,
    eventType: string,
    payload: ParsedOrderPayload,
  ): Promise<void> {
    await this.store.saveOrder({
      id: payload.id,
      billingAccountId: payload.tenantId,
      externalOrderId: payload.id,
      amount: payload.amount,
      currency: payload.currency,
      reason: payload.reason,
      paidAt: payload.paidAt,
    });

    const domainEvents = this.eventMapper.mapOrderEvent(eventType, payload.tenantId, {
      id: payload.id,
      amount: payload.amount,
      currency: payload.currency,
      reason: payload.reason,
    });

    for (const [index, event] of domainEvents.entries()) {
      restoreSerializedEventIdentity(
        event,
        this.webhookIntentEventId(eventId, event.eventName, index),
        payload.paidAt.toISOString(),
      );
      await this.eventPublisher.publishIdempotently(event);
    }
  }

  private async publishDomainEvent(
    event: DomainEvent,
    pastDueTransitionReservationId: string,
  ): Promise<void> {
    if (!(event instanceof SubscriptionPastDueEvent)) {
      await this.eventPublisher.publishIdempotently(event);
      return;
    }

    const claim = await this.store.claimWebhookDelivery(
      pastDueTransitionReservationId,
      event.eventName,
      PolarWebhookHandler.DELIVERY_LEASE_MS,
    );
    if (claim.status === "completed") {
      return;
    }
    if (claim.status === "in_progress") {
      throw new WebhookProcessingProblem("Past-due transition delivery is already in progress");
    }

    try {
      await this.eventPublisher.publishIdempotently(event);
    } catch (error) {
      const released = await this.store.releaseWebhookDelivery(
        pastDueTransitionReservationId,
        claim.token,
      );
      if (!released) {
        throw new WebhookProcessingProblem(
          "Past-due transition publication failed after its delivery claim expired",
          error instanceof Error ? error : undefined,
        );
      }
      throw error;
    }

    const completed = await this.store.completeWebhookDelivery(
      pastDueTransitionReservationId,
      claim.token,
    );
    if (!completed) {
      throw new WebhookProcessingProblem("Past-due transition delivery claim expired");
    }
  }

  private pastDueTransitionReservationId(externalSubscriptionId: string): string {
    return `croco:billing:polar:subscription:${externalSubscriptionId}:past_due`;
  }

  private webhookIntentEventId(webhookEventId: string, eventName: string, index: number): string {
    return createHash("sha256")
      .update(`billing-polar:${webhookEventId}:${index}:${eventName}`)
      .digest("hex");
  }

  private mapStatus(
    polarStatus: string,
  ): "active" | "past_due" | "canceled" | "revoked" | "trialing" {
    switch (polarStatus) {
      case "active":
        return "active";
      case "past_due":
        return "past_due";
      case "canceled":
        return "canceled";
      case "revoked":
        return "revoked";
      case "trialing":
        return "trialing";
      default:
        throw new BillingStatusMappingProblem(polarStatus);
    }
  }

  private mapOrderPaymentReason(
    billingReason:
      | "purchase"
      | "subscription_create"
      | "subscription_cycle"
      | "subscription_update",
  ): OrderPaymentReason {
    return billingReason === "purchase" ? "one_time" : billingReason;
  }

  private async tryRollbackWebhook(eventId: string): Promise<string | null> {
    try {
      await this.store.failWebhook(eventId);
      return null;
    } catch (error) {
      return this.getErrorMessage(error);
    }
  }

  private getProcessingCause(error: unknown): Error {
    if (error instanceof Error) return error;
    const cause = new Error("Webhook processing rejected with a non-Error value");
    Object.defineProperty(cause, "cause", { value: error });
    return cause;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Problem) {
      return `${error.code}: ${error.message}`;
    }

    return error instanceof Error ? error.message : "Unknown error";
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
  }
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function normalizeVerifiedEvent(event: unknown): unknown {
  if (!isRecord(event) || !isRecord(event.data)) {
    return event;
  }

  const data = event.data;
  const customer = isRecord(data.customer)
    ? {
        ...data.customer,
        externalId: data.customer.externalId ?? data.customer.external_id,
      }
    : data.customer;

  return {
    ...event,
    data: {
      ...data,
      customer,
      currentPeriodEnd: data.currentPeriodEnd ?? data.current_period_end,
      cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? data.cancel_at_period_end,
      billingReason: data.billingReason ?? data.billing_reason,
      createdAt: data.createdAt ?? data.created_at,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SENSITIVE_WEBHOOK_KEY_VALUE_PATTERN =
  /(["']?\b(?:webhook[-_]?secret|webhook[-_]?signature|webhookSecret|webhookSignature|signature)\b["']?\s*[:=]\s*)(["']?)([^"';\s{}]+)(["']?)/gi;

function sanitizeWebhookValidationReason(
  reason: string,
  sensitiveValues: readonly string[],
): string {
  let sanitized = reason;

  for (const value of sensitiveValues) {
    if (value.length > 0) {
      sanitized = sanitized.split(value).join("[redacted]");
    }
  }

  return sanitized.replace(
    SENSITIVE_WEBHOOK_KEY_VALUE_PATTERN,
    (_match, prefix: string, openQuote: string, _value: string, closeQuote: string) =>
      `${prefix}${openQuote}[redacted]${closeQuote}`,
  );
}
