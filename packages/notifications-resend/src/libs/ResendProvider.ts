import { randomUUID } from "node:crypto";

import { Component } from "@croco/framework-context";
import {
  NotificationChannel,
  type NotificationPayload,
  type NotificationProvider,
  type NotificationProviderCapabilities,
  type NotificationResult,
  type NotificationSendOptions,
} from "@croco/notifications-core";
import type { Problem } from "@croco/problems-core";
import { type RetryPolicy, RetryTemplate } from "@croco/retry-core";
import { recordError, recordEvent } from "@croco/telemetry-api";
import { type CreateEmailOptions, type CreateEmailResponse, Resend } from "resend";
import { isResendEmailAddress, validateResendConfig, type ResendConfig } from "./ResendConfig";
import { RESEND_PROVIDER_CAPABILITIES } from "./ResendCapabilities";
import {
  createResendErrorContext,
  isRetryableResendError,
  normalizeResendError,
  normalizeResendProblem,
} from "./ResendProblemMapping";
import { ResendValidationProblem } from "./problems/ResendNotificationProblem";

const RESEND_BATCH_CONCURRENCY_LIMIT = 5;

const RESEND_RETRY_POLICY: RetryPolicy = {
  shouldRetry(error: unknown, attempt: number, maxAttempts: number): boolean {
    if (attempt >= maxAttempts) {
      return false;
    }

    return isRetryableResendError(error);
  },
};

type ResendIdempotencyKeySource = "generated" | "not_created" | "provided";

@Component()
export class ResendProvider implements NotificationProvider {
  private readonly client: Resend;
  private readonly config: ResendConfig;
  private readonly retryTemplate = new RetryTemplate({
    maxAttempts: 3,
    backoff: {
      delay: 10,
      multiplier: 2,
      maxDelay: 50,
      jitter: false,
    },
    retryPolicy: RESEND_RETRY_POLICY,
  });

  constructor(config: ResendConfig) {
    this.config = validateResendConfig(config);
    this.client = new Resend(this.config.apiKey);
  }

  getName(): string {
    return "resend";
  }

  getChannel(): NotificationChannel {
    return NotificationChannel.EMAIL;
  }

  getCapabilities(): NotificationProviderCapabilities {
    return RESEND_PROVIDER_CAPABILITIES;
  }

  async send(
    payload: NotificationPayload,
    options?: NotificationSendOptions,
  ): Promise<NotificationResult> {
    const providedIdempotencyKey =
      options?.idempotencyKey ??
      (typeof payload.metadata?.idempotencyKey === "string"
        ? payload.metadata.idempotencyKey
        : undefined);
    const validationProblem = validateResendPayload(payload);

    if (validationProblem !== undefined) {
      recordResendFailure(
        payload,
        providedIdempotencyKey === undefined ? "not_created" : "provided",
        validationProblem,
      );

      return {
        success: false,
        problem: validationProblem,
      };
    }

    const { to, subject, content } = payload;
    const idempotencyKey = providedIdempotencyKey ?? `resend-${randomUUID()}`;
    const idempotencyKeySource: ResendIdempotencyKeySource =
      providedIdempotencyKey === undefined ? "generated" : "provided";
    const redactionValues = getResendProblemRedactionValues(payload, idempotencyKey);

    try {
      const emailOptions: CreateEmailOptions = {
        from: this.config.from,
        to,
        subject: subject || "No Subject",
        html: content,
        ...(payload.text === undefined ? {} : { text: payload.text }),
        ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
        ...(payload.headers === undefined ? {} : { headers: { ...payload.headers } }),
      };

      const data = await this.retryTemplate.execute(async () => {
        let response: CreateEmailResponse;

        try {
          response = await this.client.emails.send(emailOptions, { idempotencyKey });
        } catch (error) {
          const resendError = normalizeResendError(error, "Unknown Resend error");

          if (isRetryableResendError(resendError)) {
            recordResendRetryableFailure(payload, idempotencyKeySource, resendError);
          }

          throw resendError;
        }

        if (response.error) {
          const resendError = normalizeResendError(
            response.error,
            response.error.message,
            response,
          );

          if (isRetryableResendError(resendError)) {
            recordResendRetryableFailure(payload, idempotencyKeySource, resendError);
            throw resendError;
          }
        }

        return response;
      });

      if (data.error) {
        const problem = normalizeResendProblem(data.error, "send", data, { redactionValues });
        recordResendFailure(payload, idempotencyKeySource, problem);

        return {
          success: false,
          problem,
          providerResponse: data,
        };
      }

      recordResendAccepted(payload, idempotencyKeySource);

      return {
        success: true,
        messageId: data.data?.id,
        providerResponse: data,
      };
    } catch (error: unknown) {
      const cause = normalizeResendError(error, "Unknown Resend error");
      const problem = normalizeResendProblem(cause, "send", cause.providerResponse, {
        redactionValues,
      });

      recordResendFailure(payload, idempotencyKeySource, problem);

      return {
        success: false,
        problem,
        providerResponse: cause.providerResponse,
      };
    }
  }

  async sendBatch(payloads: NotificationPayload[]): Promise<NotificationResult[]> {
    const batchPayloads = [...payloads];

    if (batchPayloads.length === 0) {
      return [];
    }

    const results: NotificationResult[] = [];
    results.length = batchPayloads.length;
    const workerCount = Math.min(RESEND_BATCH_CONCURRENCY_LIMIT, batchPayloads.length);
    let nextPayloadIndex = 0;

    const sendNextPayload = async (): Promise<void> => {
      while (nextPayloadIndex < batchPayloads.length) {
        const payloadIndex = nextPayloadIndex;
        nextPayloadIndex += 1;
        const payload = batchPayloads[payloadIndex];

        results[payloadIndex] = await this.send(payload);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => sendNextPayload()));

    return results;
  }
}

function getResendProblemRedactionValues(
  payload: NotificationPayload,
  idempotencyKey: string,
): readonly string[] {
  return [
    payload.to,
    payload.subject,
    payload.content,
    toTextContent(payload.content),
    payload.text,
    payload.replyTo,
    ...Object.values(payload.headers ?? {}),
    idempotencyKey,
  ].filter(isNonEmptyString);
}

function toTextContent(content: string): string {
  return content
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validateResendPayload(payload: NotificationPayload): Problem | undefined {
  if (!isResendEmailAddress(payload.to)) {
    return new ResendValidationProblem(
      {
        provider: "resend",
        operation: "send",
        upstreamCode: "invalid-recipient",
      },
      "Resend recipient must be an email address or name-address value",
    );
  }

  return undefined;
}

function recordResendAccepted(
  payload: NotificationPayload,
  idempotencyKeySource: ResendIdempotencyKeySource,
): void {
  recordEvent("notifications.resend.send.accepted", {
    ...toResendTelemetryAttributes(payload, idempotencyKeySource),
  });
}

function recordResendRetryableFailure(
  payload: NotificationPayload,
  idempotencyKeySource: ResendIdempotencyKeySource,
  error: Error,
): void {
  const context = createResendErrorContext(error, "send");

  recordEvent("notifications.resend.send.retryable_failure", {
    ...toResendTelemetryAttributes(payload, idempotencyKeySource),
    ...(context.status === undefined ? {} : { "resend.upstream.status": context.status }),
    ...(context.upstreamCode === undefined ? {} : { "resend.upstream.code": context.upstreamCode }),
  });
}

function recordResendFailure(
  payload: NotificationPayload,
  idempotencyKeySource: ResendIdempotencyKeySource,
  problem: Problem,
): void {
  recordEvent("notifications.resend.send.failed", {
    ...toResendTelemetryAttributes(payload, idempotencyKeySource),
    "problem.code": problem.code,
    "problem.category": problem.category,
  });
  recordError(toResendTelemetryError(problem));
}

function toResendTelemetryAttributes(
  payload: NotificationPayload,
  idempotencyKeySource: ResendIdempotencyKeySource,
): Record<string, string | number | boolean> {
  return {
    "notification.provider": "resend",
    "notification.channel": NotificationChannel.EMAIL,
    "notification.idempotency_key.present": idempotencyKeySource !== "not_created",
    "notification.idempotency_key.source": idempotencyKeySource,
    "notification.template.present": payload.templateId !== undefined,
  };
}

function toResendTelemetryError(problem: Problem): Error {
  const telemetryError = new Error(`Resend notification failure: ${problem.code}`);
  telemetryError.name = "ResendNotificationTelemetryError";

  return telemetryError;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
