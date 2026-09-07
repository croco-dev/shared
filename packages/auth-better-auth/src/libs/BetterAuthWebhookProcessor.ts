import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { WebhookGateway } from "@croco/webhooks-core";
import type { WebhookEvent } from "@croco/webhooks-core";
import {
  InvalidWebhookPayloadProblem,
  InvalidWebhookSignatureProblem,
} from "./problems/WebhookProblems";
import type {
  BetterAuthSession,
  BetterAuthSessionProvider,
  BetterAuthWebhookHandler,
  BetterAuthWebhookOptions,
} from "./types";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const SUPPORTED_EVENT_TYPES = new Set<keyof BetterAuthWebhookHandler>([
  "user.created",
  "user.updated",
  "user.deleted",
  "session.created",
  "session.revoked",
]);

/**
 * Better Auth 웹훅 서명 검증과 이벤트 분기를 담당하는 처리기입니다.
 */
export class BetterAuthWebhookProcessor {
  private static readonly SIGNATURE_HEADER = "x-better-auth-signature";
  private static readonly MAX_EVENT_AGE_MS = 300_000;
  private readonly gateway: WebhookGateway;
  private readonly activeDeliveries = new Map<string, Promise<void>>();

  constructor(
    private readonly options: BetterAuthWebhookOptions,
    private readonly handlers: BetterAuthWebhookHandler,
    _sessionProvider: BetterAuthSessionProvider,
  ) {
    this.gateway = new WebhookGateway({
      adapter: {
        provider: "better-auth",
        verify: ({ rawBody, headers, receivedAt }) =>
          this.verifyEvent(
            typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"),
            headers[BetterAuthWebhookProcessor.SIGNATURE_HEADER] ?? "",
            receivedAt,
          ),
      },
      router: {
        has: (eventType) => isSupportedEventType(eventType),
        dispatch: async (event) => {
          if (!isSupportedEventType(event.type)) {
            return;
          }

          const data = isObjectRecord(event.payload) ? event.payload : {};
          await this.handlers[event.type]?.(data);
        },
      },
      idempotencyStore: options.idempotencyStore,
      unknownEventPolicy: "ignore",
    });
  }

  private verifySignature(rawBody: string, signature: string): boolean {
    if (!signature) {
      return false;
    }

    const expectedSignature = `sha256=${createHmac("sha256", this.options.signingSecret).update(rawBody).digest("hex")}`;
    const actualSignatureBuffer = Buffer.from(signature);
    const expectedSignatureBuffer = Buffer.from(expectedSignature);

    if (actualSignatureBuffer.length !== expectedSignatureBuffer.length) {
      return false;
    }

    return timingSafeEqual(actualSignatureBuffer, expectedSignatureBuffer);
  }

  private verifyEvent(rawBody: string, signature: string, receivedAt: Date): WebhookEvent {
    if (!this.verifySignature(rawBody, signature)) {
      throw new InvalidWebhookSignatureProblem();
    }

    let body: unknown;

    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new InvalidWebhookPayloadProblem();
    }

    if (!isObjectRecord(body) || typeof body.type !== "string") {
      throw new InvalidWebhookPayloadProblem();
    }

    const occurredAt = parseEventTimestamp(body.timestamp);
    if (occurredAt === null) {
      throw new InvalidWebhookPayloadProblem();
    }

    if (
      Math.abs(receivedAt.getTime() - occurredAt.getTime()) >
      BetterAuthWebhookProcessor.MAX_EVENT_AGE_MS
    ) {
      throw new InvalidWebhookSignatureProblem();
    }

    const fingerprint = createHash("sha256").update(rawBody).digest("hex");
    const eventId =
      typeof body.id === "string" && body.id.trim().length > 0 ? body.id : `sha256:${fingerprint}`;

    return {
      id: eventId,
      type: body.type,
      provider: "better-auth",
      payload: isObjectRecord(body.data) ? body.data : {},
      occurredAt,
      fingerprint,
    };
  }

  async processWebhook(request: { headers: Headers; text: () => Promise<string> }): Promise<void> {
    const signature = request.headers.get(BetterAuthWebhookProcessor.SIGNATURE_HEADER) ?? "";
    const rawBody = await request.text();
    const deliveryFingerprint = createHash("sha256")
      .update(signature)
      .update("\0")
      .update(rawBody)
      .digest("hex");
    const activeDelivery = this.activeDeliveries.get(deliveryFingerprint);
    if (activeDelivery !== undefined) {
      return activeDelivery;
    }

    const execution = this.processVerifiedDelivery(rawBody, signature);
    this.activeDeliveries.set(deliveryFingerprint, execution);

    try {
      await execution;
    } finally {
      this.activeDeliveries.delete(deliveryFingerprint);
    }
  }

  private async processVerifiedDelivery(rawBody: string, signature: string): Promise<void> {
    const result = await this.gateway.handle({
      rawBody,
      headers: { [BetterAuthWebhookProcessor.SIGNATURE_HEADER]: signature },
    });

    if (result.outcome === "in-flight" || result.outcome === "failed") {
      throw result.problem;
    }
  }
}

function parseEventTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }

  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (match === null) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !isValidOffset(offset)
  ) {
    return null;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidOffset(offset: string | undefined): boolean {
  if (offset === "Z") {
    return true;
  }

  if (offset === undefined) {
    return false;
  }

  const [hours, minutes] = offset.slice(1).split(":").map(Number);
  return hours <= 23 && minutes <= 59;
}

function isSupportedEventType(eventType: string): eventType is keyof BetterAuthWebhookHandler {
  return SUPPORTED_EVENT_TYPES.has(eventType as keyof BetterAuthWebhookHandler);
}

/**
 * Better Auth 웹훅 처리에 사용하는 공개 타입들입니다.
 */
export type {
  BetterAuthSession,
  BetterAuthSessionProvider,
  BetterAuthWebhookHandler,
  BetterAuthWebhookOptions,
};
