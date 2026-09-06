import { Container } from "@croco/framework-context";
import type { NotificationPayload, NotificationResult } from "@croco/notifications-core";
import { NotificationChannel } from "@croco/notifications-core";
import { Problem, ProblemCategory } from "@croco/problems-core";
import { recordError, recordEvent } from "@croco/telemetry-api";
import type { CreateEmailResponse, Resend } from "resend";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResendIdempotencyConflictProblem,
  ResendMissingConfigProblem,
  ResendTerminalUpstreamProblem,
  ResendValidationProblem,
} from "../libs/problems/ResendNotificationProblem";
import { ResendDiagnosticsProvider } from "../libs/ResendDiagnosticsProvider";
import { ResendProvider } from "../libs/ResendProvider";

type MockResendClient = InstanceType<typeof Resend>;

class TestNotificationAssertionProblem extends Problem {
  constructor() {
    super(
      "TEST_NOTIFICATION_ASSERTION_FAILED",
      ProblemCategory.InternalServerError,
      "Expected notification delivery to fail",
    );
  }
}

class TestResendDiagnosticProblem extends Problem {
  constructor() {
    super(
      "notifications-resend/terminal-upstream",
      ProblemCategory.InternalServerError,
      "failed with apiKey=re_leaked-key",
      {
        extensions: {
          apiKey: "re_leaked-key",
          nested: {
            token: "secret-token",
            safe: "kept",
          },
          operation: "readiness",
          provider: "resend",
          retryable: false,
        },
      },
    );
  }
}

// Mock resend package
vi.mock("resend", () => {
  const emailsSendMock = vi.fn();
  const MockResend = vi.fn(function MockResend(this: { emails: { send: typeof emailsSendMock } }) {
    this.emails = {
      send: emailsSendMock,
    };
  });
  return { Resend: MockResend };
});

vi.mock("@croco/telemetry-api", () => ({
  recordError: vi.fn(),
  recordEvent: vi.fn(),
}));

describe("ResendProvider", () => {
  let provider!: ResendProvider;
  let mockResendClient!: MockResendClient;

  const mockConfig = {
    apiKey: "re_test-key",
    from: "noreply@example.com",
  };

  beforeEach(async () => {
    Container.reset();
    vi.clearAllMocks();

    provider = new ResendProvider(mockConfig);

    // Get mock instance
    const { Resend } = await import("resend");
    mockResendClient = new Resend();
  });

  describe("constructor", () => {
    it("should throw stable missing config Problems before creating a client", async () => {
      const { Resend } = await import("resend");
      vi.mocked(Resend).mockClear();

      expect(() => new ResendProvider({ apiKey: "", from: "" })).toThrow(
        ResendMissingConfigProblem,
      );
      expect(() => new ResendProvider({ apiKey: "", from: "" })).toThrow(
        "Resend notification configuration is missing required value 'apiKey, from'",
      );
      expect(Resend).not.toHaveBeenCalled();
    });

    it("should reject invalid default sender addresses", () => {
      expect(() => new ResendProvider({ apiKey: "re_test-key", from: "not-an-email" })).toThrow(
        ResendValidationProblem,
      );
    });
  });

  describe("diagnostics", () => {
    it("should report missing required configuration without leaking secrets", async () => {
      const diagnostics = new ResendDiagnosticsProvider({
        apiKey: "re_test-key",
        from: "",
      });

      const health = await diagnostics.getHealth();

      expect(health).toMatchObject({
        status: "unhealthy",
        component: "notifications-resend",
        details: expect.objectContaining({
          provider: "resend",
          capabilities: provider.getCapabilities(),
          hasApiKey: true,
          hasDefaultFrom: false,
          missingConfig: ["default from address"],
          liveCheck: "not_started",
          problemCode: "notifications-resend/missing-config",
        }),
      });
      expect(JSON.stringify(health)).not.toContain("re_test-key");
    });

    it("should report healthy readiness when config exists and live check is not configured", async () => {
      const diagnostics = new ResendDiagnosticsProvider(mockConfig);

      const health = await diagnostics.getHealth();

      expect(health).toMatchObject({
        status: "healthy",
        component: "notifications-resend",
        details: expect.objectContaining({
          provider: "resend",
          hasApiKey: true,
          hasDefaultFrom: true,
          defaultFromDomain: "example.com",
          missingConfig: [],
          liveCheck: "not_configured",
        }),
      });
      expect(JSON.stringify(health)).not.toContain(mockConfig.apiKey);
      expect(JSON.stringify(health)).not.toContain(mockConfig.from);
    });

    it("should sanitize live readiness details before returning diagnostics", async () => {
      const controller = new AbortController();
      const diagnostics = new ResendDiagnosticsProvider(mockConfig, {
        readinessCheck: async ({ config, signal }) => {
          expect(config.from).toBe(mockConfig.from);
          expect(signal).toBe(controller.signal);

          return {
            details: {
              apiKey: "re_leaked-key",
              nested: {
                token: "secret-token",
                senderDomain: "example.com",
              },
            },
          };
        },
      });

      const health = await diagnostics.getHealth(controller.signal);

      expect(health.status).toBe("healthy");
      expect(health.details).toMatchObject({
        liveCheck: "passed",
        readiness: {
          apiKey: "[redacted]",
          nested: {
            token: "[redacted]",
            senderDomain: "example.com",
          },
        },
      });
      expect(JSON.stringify(health)).not.toContain("re_leaked-key");
      expect(JSON.stringify(health)).not.toContain("secret-token");
    });

    it("should sanitize live readiness success messages before returning diagnostics", async () => {
      const diagnostics = new ResendDiagnosticsProvider(mockConfig, {
        readinessCheck: async () => ({
          message: "checked apiKey=re_leaked-key token=secret-token recipient@example.com",
        }),
      });

      const health = await diagnostics.getHealth();

      expect(health.status).toBe("healthy");
      expect(health.message).toBe("checked apiKey=[redacted] token=[redacted] [redacted-email]");
      expect(JSON.stringify(health)).not.toContain("re_leaked-key");
      expect(JSON.stringify(health)).not.toContain("secret-token");
      expect(JSON.stringify(health)).not.toContain("recipient@example.com");
    });

    it("should report live readiness failures as degraded with upstream taxonomy", async () => {
      const diagnostics = new ResendDiagnosticsProvider(mockConfig, {
        readinessCheck: async () => {
          throw { message: "rate limit for re_test-key", name: "rate_limit_exceeded" };
        },
      });

      const health = await diagnostics.getHealth();

      expect(health).toMatchObject({
        status: "degraded",
        component: "notifications-resend",
        details: expect.objectContaining({
          liveCheck: "failed",
          problemCode: "notifications-resend/retryable-upstream",
          upstreamCode: "rate_limit_exceeded",
          upstreamStatus: 429,
          retryable: true,
        }),
      });
      expect(JSON.stringify(health)).not.toContain("re_test-key");
    });

    it("should sanitize thrown Problem messages and extensions in live readiness failures", async () => {
      const diagnostics = new ResendDiagnosticsProvider(mockConfig, {
        readinessCheck: async () => {
          throw new TestResendDiagnosticProblem();
        },
      });

      const health = await diagnostics.getHealth();

      expect(health.message).toBe("failed with apiKey=[redacted]");
      expect(health.details).toMatchObject({
        apiKey: "[redacted]",
        nested: {
          token: "[redacted]",
          safe: "kept",
        },
        provider: "resend",
      });
      expect(JSON.stringify(health)).not.toContain("re_leaked-key");
      expect(JSON.stringify(health)).not.toContain("secret-token");
    });
  });

  describe("getName()", () => {
    it("should return resend as provider name", () => {
      expect(provider.getName()).toBe("resend");
    });
  });

  describe("getChannel()", () => {
    it("should return EMAIL channel", () => {
      expect(provider.getChannel()).toBe(NotificationChannel.EMAIL);
    });
  });

  describe("getCapabilities()", () => {
    it("should declare rendered-template email dispatch capabilities", () => {
      expect(provider.getCapabilities()).toEqual({
        providerName: "resend",
        channels: [NotificationChannel.EMAIL],
        supportsIdempotencyKey: true,
        supportsProviderTemplates: false,
        supportsRenderedTemplates: true,
        outboxIntegration: "consumer-managed",
      });
    });
  });

  describe("send()", () => {
    const mockSuccessResponse: CreateEmailResponse = {
      data: { id: "msg-123" },
      error: null,
    };

    const mockErrorResponse: CreateEmailResponse = {
      data: null,
      error: { message: "Invalid API key", name: "invalid_api_Key" },
    };

    it("should send email successfully with subject", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Test Subject",
        content: "<h1>Test Content</h1>",
      };

      const result = await provider.send(payload);

      expectSuccessfulNotificationResult(result);
      expect(result.messageId).toBe("msg-123");
      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        {
          from: "noreply@example.com",
          to: "recipient@example.com",
          subject: "Test Subject",
          html: "<h1>Test Content</h1>",
        },
        {
          idempotencyKey: expect.stringMatching(/^resend-/),
        },
      );
    });

    it("should use provided idempotency key", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Test Subject",
        content: "<h1>Test Content</h1>",
      };

      await provider.send(payload, { idempotencyKey: "fixed-key" });

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        {
          from: "noreply@example.com",
          to: "recipient@example.com",
          subject: "Test Subject",
          html: "<h1>Test Content</h1>",
        },
        { idempotencyKey: "fixed-key" },
      );
      expect(recordEvent).toHaveBeenCalledWith(
        "notifications.resend.send.accepted",
        expect.objectContaining({
          "notification.idempotency_key.present": true,
          "notification.idempotency_key.source": "provided",
          "notification.provider": "resend",
        }),
      );
      expect(JSON.stringify(vi.mocked(recordEvent).mock.calls)).not.toContain("fixed-key");
    });

    it("should use metadata idempotency keys and let send options take precedence", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);
      const payload: NotificationPayload = {
        to: "recipient@example.com",
        content: "Hello",
        metadata: { idempotencyKey: "metadata-key" },
      };

      await provider.send(payload);
      await provider.send(payload, { idempotencyKey: "options-key" });

      expect(
        vi.mocked(mockResendClient.emails.send).mock.calls.map(([, options]) => options),
      ).toEqual([{ idempotencyKey: "metadata-key" }, { idempotencyKey: "options-key" }]);
      expect(recordEvent).toHaveBeenCalledWith(
        "notifications.resend.send.accepted",
        expect.objectContaining({ "notification.idempotency_key.source": "provided" }),
      );
      expect(JSON.stringify(vi.mocked(recordEvent).mock.calls)).not.toContain("metadata-key");
    });

    it.each([undefined, null, 123, false, {}, []])(
      "should generate distinct keys when metadata idempotency key is not a string: %j",
      async (idempotencyKey) => {
        vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);
        const payload: NotificationPayload = {
          to: "recipient@example.com",
          content: "Hello",
          metadata: { idempotencyKey },
        };

        await provider.sendBatch([payload, payload]);

        const keys = vi
          .mocked(mockResendClient.emails.send)
          .mock.calls.map(([, options]) => options?.idempotencyKey);
        expect(keys).toEqual([
          expect.stringMatching(/^resend-[0-9a-f-]{36}$/),
          expect.stringMatching(/^resend-[0-9a-f-]{36}$/),
        ]);
        expect(new Set(keys).size).toBe(2);
      },
    );

    it("should report metadata idempotency keys as provided on validation failure", async () => {
      const result = await provider.send({
        to: "invalid-recipient",
        content: "Hello",
        metadata: { idempotencyKey: "metadata-key" },
      });

      expect(result.success).toBe(false);
      expect(mockResendClient.emails.send).not.toHaveBeenCalled();
      expect(recordEvent).toHaveBeenCalledWith(
        "notifications.resend.send.failed",
        expect.objectContaining({
          "notification.idempotency_key.present": true,
          "notification.idempotency_key.source": "provided",
        }),
      );
    });

    it("should send custom email headers", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Test Subject",
        content: "<h1>Test Content</h1>",
        headers: { "X-Message-Id": "message-123" },
      };

      await provider.send(payload);

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        {
          from: "noreply@example.com",
          to: "recipient@example.com",
          subject: "Test Subject",
          html: "<h1>Test Content</h1>",
          headers: { "X-Message-Id": "message-123" },
        },
        { idempotencyKey: expect.stringMatching(/^resend-/) },
      );
    });

    it("should send plain-text content and reply routing", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Test Subject",
        content: "<h1>Test Content</h1>",
        text: "Test Content",
        replyTo: "reply@example.com",
      };

      await provider.send(payload);

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        {
          from: "noreply@example.com",
          to: "recipient@example.com",
          subject: "Test Subject",
          html: "<h1>Test Content</h1>",
          text: "Test Content",
          replyTo: "reply@example.com",
        },
        { idempotencyKey: expect.stringMatching(/^resend-/) },
      );
    });

    it("should use generated resend idempotency key without options", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        content: "<h1>Test Content</h1>",
      };

      await provider.send(payload);

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(expect.any(Object), {
        idempotencyKey: expect.stringMatching(/^resend-[0-9a-f-]{36}$/),
      });
    });

    it("should send email without subject using default", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        content: "<h1>Test Content</h1>",
      };

      await provider.send(payload);

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        {
          from: "noreply@example.com",
          to: "recipient@example.com",
          subject: "No Subject",
          html: "<h1>Test Content</h1>",
        },
        {
          idempotencyKey: expect.stringMatching(/^resend-/),
        },
      );
    });

    it("should send email with templateId", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Welcome",
        content: "<h1>Welcome</h1>",
        templateId: "welcome-template",
      };

      await provider.send(payload);

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        {
          from: "noreply@example.com",
          to: "recipient@example.com",
          subject: "Welcome",
          html: "<h1>Welcome</h1>",
        },
        {
          idempotencyKey: expect.stringMatching(/^resend-/),
        },
      );
    });

    it("should return error result when API returns error", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockErrorResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Test Subject",
        content: "<h1>Test Content</h1>",
      };

      const result = await provider.send(payload);

      expectFailedNotificationResult(result);
      expect(result.problem).toBeInstanceOf(ResendTerminalUpstreamProblem);
      expect(result.problem.message).toBe("Invalid API key");
      expect(result.providerResponse).toEqual(mockErrorResponse);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(1);
      expect(recordEvent).toHaveBeenCalledWith(
        "notifications.resend.send.failed",
        expect.objectContaining({
          "notification.provider": "resend",
          "problem.code": "notifications-resend/terminal-upstream",
        }),
      );
      expect(recordEvent).not.toHaveBeenCalledWith(
        "notifications.resend.send.accepted",
        expect.any(Object),
      );
      expect(recordError).toHaveBeenCalledWith(expect.any(Error));
      expect(getRecordedErrorMessages()).toContain(
        "ResendNotificationTelemetryError:Resend notification failure: notifications-resend/terminal-upstream",
      );
    });

    it("should retry transient API error responses with the same idempotency key", async () => {
      const transientErrorResponse: CreateEmailResponse = {
        data: null,
        error: { message: "Rate limit exceeded", name: "rate_limit_exceeded" },
      };

      vi.mocked(mockResendClient.emails.send)
        .mockResolvedValueOnce(transientErrorResponse)
        .mockResolvedValueOnce(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Retry Subject",
        content: "<h1>Retry Content</h1>",
      };

      const result = await provider.send(payload);

      expectSuccessfulNotificationResult(result);
      expect(result.messageId).toBe("msg-123");
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(2);

      const firstCallOptions = vi.mocked(mockResendClient.emails.send).mock.calls[0]?.[1];
      const secondCallOptions = vi.mocked(mockResendClient.emails.send).mock.calls[1]?.[1];

      expect(firstCallOptions?.idempotencyKey).toMatch(/^resend-/);
      expect(secondCallOptions?.idempotencyKey).toBe(firstCallOptions?.idempotencyKey);

      const eventNames = vi.mocked(recordEvent).mock.calls.map(([name]) => name);
      expect(eventNames).toContain("notifications.resend.send.retryable_failure");
      expect(eventNames).toContain("notifications.resend.send.accepted");
    });

    it("should retry concurrent idempotency conflicts before succeeding", async () => {
      const concurrentIdempotencyResponse: CreateEmailResponse = {
        data: null,
        error: {
          message: "Concurrent idempotent request",
          name: "concurrent_idempotent_requests",
        },
      };

      vi.mocked(mockResendClient.emails.send)
        .mockResolvedValueOnce(concurrentIdempotencyResponse)
        .mockResolvedValueOnce(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Retry Subject",
        content: "<h1>Retry Content</h1>",
      };

      const result = await provider.send(payload, { idempotencyKey: "fixed-key" });

      expectSuccessfulNotificationResult(result);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(2);
      expect(vi.mocked(mockResendClient.emails.send).mock.calls[0]?.[1]).toEqual({
        idempotencyKey: "fixed-key",
      });
      expect(vi.mocked(mockResendClient.emails.send).mock.calls[1]?.[1]).toEqual({
        idempotencyKey: "fixed-key",
      });

      const eventNames = vi.mocked(recordEvent).mock.calls.map(([name]) => name);
      expect(eventNames).toContain("notifications.resend.send.retryable_failure");
      expect(eventNames).toContain("notifications.resend.send.accepted");
    });

    it("should retry transient thrown errors before succeeding", async () => {
      const networkError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

      vi.mocked(mockResendClient.emails.send)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Retry Subject",
        content: "<h1>Retry Content</h1>",
      };

      const result = await provider.send(payload);

      expectSuccessfulNotificationResult(result);
      expect(result.messageId).toBe("msg-123");
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(2);
    });

    it("should not retry invalid idempotent request errors", async () => {
      const invalidIdempotentRequestResponse: CreateEmailResponse = {
        data: null,
        error: { message: "Invalid idempotency key reuse", name: "invalid_idempotent_request" },
      };

      vi.mocked(mockResendClient.emails.send).mockResolvedValueOnce(
        invalidIdempotentRequestResponse,
      );

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Retry Subject",
        content: "<h1>Retry Content</h1>",
      };

      const result = await provider.send(payload);

      expectFailedNotificationResult(result);
      expect(result.problem).toBeInstanceOf(ResendIdempotencyConflictProblem);
      expect(result.problem.message).toBe("Invalid idempotency key reuse");
      expect(result.providerResponse).toEqual(invalidIdempotentRequestResponse);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(1);
      expect(recordEvent).toHaveBeenCalledWith(
        "notifications.resend.send.failed",
        expect.objectContaining({
          "problem.code": "notifications-resend/idempotency-conflict",
        }),
      );
    });

    it("should handle network error", async () => {
      const networkError = new Error("Network connection failed");
      vi.mocked(mockResendClient.emails.send).mockRejectedValue(networkError);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Test Subject",
        content: "<h1>Test Content</h1>",
      };

      const result = await provider.send(payload);

      expectFailedNotificationResult(result);
      expect(result.problem).toBeInstanceOf(ResendTerminalUpstreamProblem);
      expect(result.problem.message).toBe("Network connection failed");
      expect(recordEvent).toHaveBeenCalledWith(
        "notifications.resend.send.failed",
        expect.objectContaining({
          "notification.idempotency_key.present": true,
          "notification.idempotency_key.source": "generated",
          "problem.code": "notifications-resend/terminal-upstream",
        }),
      );
      expect(recordError).toHaveBeenCalledWith(expect.any(Error));
    });

    it("should reject invalid recipients before calling Resend", async () => {
      const payload: NotificationPayload = {
        to: "not-an-email",
        subject: "Test Subject",
        content: "<h1>Test Content</h1>",
      };

      const result = await provider.send(payload, { idempotencyKey: "fixed-key" });

      expectFailedNotificationResult(result);
      expect(result.problem).toBeInstanceOf(ResendValidationProblem);
      expect(result.problem.message).toBe(
        "Resend recipient must be an email address or name-address value",
      );
      expect(mockResendClient.emails.send).not.toHaveBeenCalled();
      expect(recordEvent).toHaveBeenCalledWith(
        "notifications.resend.send.failed",
        expect.objectContaining({
          "notification.idempotency_key.source": "provided",
          "problem.code": "notifications-resend/validation-failed",
        }),
      );
      expect(JSON.stringify(vi.mocked(recordEvent).mock.calls)).not.toContain("not-an-email");
    });

    it("should redact payload and idempotency values from upstream Problems and telemetry errors", async () => {
      const sensitiveErrorResponse: CreateEmailResponse = {
        data: null,
        error: {
          message:
            "Rejected recipient@example.com with subject Secret Subject, body Secret Body, text Secret Text, reply secret-reply@example.com, and header secret-header using idempotency-key=fixed-key and apiKey=re_leaked-key",
          name: "invalid_parameter",
        },
      };

      vi.mocked(mockResendClient.emails.send).mockResolvedValue(sensitiveErrorResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Secret Subject",
        content: "<h1>Secret Body</h1>",
        text: "Secret Text",
        replyTo: "secret-reply@example.com",
        headers: { "X-Private-Context": "secret-header" },
      };

      const result = await provider.send(payload, { idempotencyKey: "fixed-key" });
      const serializedTelemetry = JSON.stringify(vi.mocked(recordEvent).mock.calls);
      const recordedErrors = getRecordedErrorMessages();

      expectFailedNotificationResult(result);
      expect(result.problem).toBeInstanceOf(ResendValidationProblem);
      expect(result.problem.message).toBe(
        "Rejected [redacted] with subject [redacted], body [redacted], text [redacted], reply [redacted], and header [redacted] using idempotency-key=[redacted] and apiKey=[redacted]",
      );
      expect(serializedTelemetry).not.toContain("recipient@example.com");
      expect(serializedTelemetry).not.toContain("Secret Subject");
      expect(serializedTelemetry).not.toContain("Secret Body");
      expect(serializedTelemetry).not.toContain("Secret Text");
      expect(serializedTelemetry).not.toContain("secret-reply@example.com");
      expect(serializedTelemetry).not.toContain("secret-header");
      expect(serializedTelemetry).not.toContain("fixed-key");
      expect(serializedTelemetry).not.toContain("re_leaked-key");
      expect(recordedErrors).not.toContain("recipient@example.com");
      expect(recordedErrors).not.toContain("Secret Subject");
      expect(recordedErrors).not.toContain("Secret Body");
      expect(recordedErrors).not.toContain("Secret Text");
      expect(recordedErrors).not.toContain("secret-reply@example.com");
      expect(recordedErrors).not.toContain("secret-header");
      expect(recordedErrors).not.toContain("fixed-key");
      expect(recordedErrors).not.toContain("re_leaked-key");
    });

    it("should not report an idempotency key for validation failures before key creation", async () => {
      const payload: NotificationPayload = {
        to: "not-an-email",
        subject: "Test Subject",
        content: "<h1>Test Content</h1>",
      };

      const result = await provider.send(payload);

      expect(result.success).toBe(false);
      expect(mockResendClient.emails.send).not.toHaveBeenCalled();
      expect(recordEvent).toHaveBeenCalledWith(
        "notifications.resend.send.failed",
        expect.objectContaining({
          "notification.idempotency_key.present": false,
          "notification.idempotency_key.source": "not_created",
          "problem.code": "notifications-resend/validation-failed",
        }),
      );
    });

    it("should pass duplicate accepted sends through Resend with the same idempotency key", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue({
        data: { id: "msg-duplicate" },
        error: null,
      });

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Replay Subject",
        content: "<h1>Replay Content</h1>",
      };

      const firstResult = await provider.send(payload, { idempotencyKey: "fixed-key" });
      const secondResult = await provider.send(payload, { idempotencyKey: "fixed-key" });

      expectSuccessfulNotificationResult(firstResult);
      expectSuccessfulNotificationResult(secondResult);
      expect(firstResult.messageId).toBe("msg-duplicate");
      expect(secondResult.messageId).toBe("msg-duplicate");
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(2);
      expect(vi.mocked(mockResendClient.emails.send).mock.calls[0]?.[1]).toEqual({
        idempotencyKey: "fixed-key",
      });
      expect(vi.mocked(mockResendClient.emails.send).mock.calls[1]?.[1]).toEqual({
        idempotencyKey: "fixed-key",
      });
      expect(vi.mocked(recordEvent).mock.calls).toEqual(
        expect.arrayContaining([
          [
            "notifications.resend.send.accepted",
            expect.objectContaining({
              "notification.idempotency_key.present": true,
              "notification.idempotency_key.source": "provided",
            }),
          ],
        ]),
      );
      expect(JSON.stringify(vi.mocked(recordEvent).mock.calls)).not.toContain("fixed-key");
    });

    it("should include providerResponse in success result", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Test Subject",
        content: "<h1>Test Content</h1>",
      };

      const result = await provider.send(payload);

      expectSuccessfulNotificationResult(result);
      expect(result.providerResponse).toEqual(mockSuccessResponse);
    });

    it("should handle metadata and variables in payload", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Test Subject",
        content: "<h1>Test Content</h1>",
        metadata: { userId: "123" },
        variables: { name: "John" },
      };

      await provider.send(payload);

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        {
          from: "noreply@example.com",
          to: "recipient@example.com",
          subject: "Test Subject",
          html: "<h1>Test Content</h1>",
        },
        {
          idempotencyKey: expect.stringMatching(/^resend-/),
        },
      );
    });

    it("should send email with template", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Welcome",
        content: "<h1>Welcome</h1>",
        templateId: "welcome-template",
        variables: { name: "John", email: "john@example.com" },
      };

      const result = await provider.send(payload);

      expectSuccessfulNotificationResult(result);
      expect(result.messageId).toBe("msg-123");
      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        {
          from: "noreply@example.com",
          to: "recipient@example.com",
          subject: "Welcome",
          html: "<h1>Welcome</h1>",
        },
        {
          idempotencyKey: expect.stringMatching(/^resend-/),
        },
      );
    });

    it("should send email with template without subject", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValue(mockSuccessResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        content: "<h1>Welcome</h1>",
        templateId: "welcome-template",
        variables: { name: "John" },
      };

      await provider.send(payload);

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        {
          from: "noreply@example.com",
          to: "recipient@example.com",
          subject: "No Subject",
          html: "<h1>Welcome</h1>",
        },
        {
          idempotencyKey: expect.stringMatching(/^resend-/),
        },
      );
    });

    it("should handle error when sending template with invalid variables", async () => {
      const templateErrorResponse: CreateEmailResponse = {
        data: null,
        error: { message: "Missing variable: name", name: "invalid_parameter" },
      };

      vi.mocked(mockResendClient.emails.send).mockResolvedValue(templateErrorResponse);

      const payload: NotificationPayload = {
        to: "recipient@example.com",
        subject: "Welcome",
        content: "<h1>Welcome</h1>",
        templateId: "welcome-template",
        variables: { email: "john@example.com" },
      };

      const result = await provider.send(payload);

      expectFailedNotificationResult(result);
      expect(result.problem).toBeInstanceOf(ResendValidationProblem);
      expect(result.problem.message).toBe("Missing variable: name");
      expect(result.providerResponse).toEqual(templateErrorResponse);
    });

    it("should send multiple emails in batch", async () => {
      vi.mocked(mockResendClient.emails.send)
        .mockResolvedValueOnce({ ...mockSuccessResponse, data: { id: "msg-1" } })
        .mockResolvedValueOnce({ ...mockSuccessResponse, data: { id: "msg-2" } })
        .mockResolvedValueOnce({ ...mockSuccessResponse, data: { id: "msg-3" } });

      const payloads: NotificationPayload[] = [
        {
          to: "user1@example.com",
          subject: "Batch Email 1",
          content: "<h1>Email 1</h1>",
        },
        {
          to: "user2@example.com",
          subject: "Batch Email 2",
          content: "<h1>Email 2</h1>",
        },
        {
          to: "user3@example.com",
          subject: "Batch Email 3",
          content: "<h1>Email 3</h1>",
        },
      ];

      const results = await provider.sendBatch(payloads);

      expect(results).toHaveLength(3);
      expect(getSuccessfulMessageIds(results)).toEqual(["msg-1", "msg-2", "msg-3"]);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(3);
    });

    it("should preserve per-payload metadata keys when retrying a partially failed batch", async () => {
      const payloads: NotificationPayload[] = Array.from({ length: 6 }, (_, index) => ({
        to: `user${index}@example.com`,
        content: "Hello",
        metadata: { idempotencyKey: `batch-message-${index}` },
      }));
      let upstreamUnavailable = true;
      vi.mocked(mockResendClient.emails.send).mockImplementation(async (emailOptions) => {
        if (upstreamUnavailable && emailOptions.to === "user5@example.com") {
          return {
            data: null,
            error: { name: "rate_limit_exceeded", message: "Rate limit exceeded" },
          };
        }
        return { data: { id: `msg-${emailOptions.to}` }, error: null };
      });

      const firstResults = await provider.sendBatch(payloads);
      expect(firstResults.map((result) => result.success)).toEqual([
        true,
        true,
        true,
        true,
        true,
        false,
      ]);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(8);
      upstreamUnavailable = false;

      const retryProvider = new ResendProvider(mockConfig);
      const retryPayloads = structuredClone(payloads).reverse();
      const retryResults = await retryProvider.sendBatch(retryPayloads);

      expect(retryResults.every((result) => result.success)).toBe(true);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(14);
      for (const [emailOptions, options] of vi.mocked(mockResendClient.emails.send).mock.calls) {
        const payload = payloads.find((item) => item.to === emailOptions.to);
        expect(options?.idempotencyKey).toBe(payload?.metadata?.idempotencyKey);
      }
      expect(payloads.map((payload) => payload.metadata?.idempotencyKey)).toEqual(
        Array.from({ length: 6 }, (_, index) => `batch-message-${index}`),
      );
    });

    it("should handle mixed success and failure in batch", async () => {
      vi.mocked(mockResendClient.emails.send)
        .mockResolvedValueOnce({ ...mockSuccessResponse, data: { id: "msg-1" } })
        .mockResolvedValueOnce(mockErrorResponse)
        .mockResolvedValueOnce({ ...mockSuccessResponse, data: { id: "msg-3" } });

      const payloads: NotificationPayload[] = [
        {
          to: "user1@example.com",
          subject: "Batch Email 1",
          content: "<h1>Email 1</h1>",
        },
        {
          to: "user2@example.com",
          subject: "Batch Email 2",
          content: "<h1>Email 2</h1>",
        },
        {
          to: "user3@example.com",
          subject: "Batch Email 3",
          content: "<h1>Email 3</h1>",
        },
      ];

      const results = await provider.sendBatch(payloads);

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[2].success).toBe(true);
    });

    it("should send batch emails with templates", async () => {
      vi.mocked(mockResendClient.emails.send)
        .mockResolvedValueOnce({ ...mockSuccessResponse, data: { id: "msg-1" } })
        .mockResolvedValueOnce({ ...mockSuccessResponse, data: { id: "msg-2" } });

      const payloads: NotificationPayload[] = [
        {
          to: "user1@example.com",
          subject: "Welcome",
          content: "<h1>Welcome</h1>",
          templateId: "welcome-template",
          variables: { name: "John" },
        },
        {
          to: "user2@example.com",
          subject: "Welcome",
          content: "<h1>Welcome</h1>",
          templateId: "welcome-template",
          variables: { name: "Jane" },
        },
      ];

      const results = await provider.sendBatch(payloads);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(2);
      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          html: "<h1>Welcome</h1>",
        }),
        expect.any(Object),
      );
      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          html: "<h1>Welcome</h1>",
        }),
        expect.any(Object),
      );
    });

    it("should cap large batch request concurrency and preserve result order", async () => {
      const payloads: NotificationPayload[] = Array.from({ length: 12 }, (_, index) => ({
        to: `user${index + 1}@example.com`,
        subject: `Batch Email ${index + 1}`,
        content: `<h1>Email ${index + 1}</h1>`,
      }));
      let activeSends = 0;
      let maxActiveSends = 0;

      vi.mocked(mockResendClient.emails.send).mockImplementation(async (emailOptions) => {
        activeSends += 1;
        maxActiveSends = Math.max(maxActiveSends, activeSends);

        await new Promise((resolve) => setTimeout(resolve, 1));

        activeSends -= 1;

        const messageIndex = payloads.findIndex((payload) => payload.to === emailOptions.to);

        return {
          data: { id: `msg-${messageIndex + 1}` },
          error: null,
        };
      });

      const results = await provider.sendBatch(payloads);

      expect(maxActiveSends).toBeLessThanOrEqual(5);
      expect(getSuccessfulMessageIds(results)).toEqual(
        payloads.map((_, index) => `msg-${index + 1}`),
      );
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(payloads.length);
    });

    it("should snapshot batch payloads before processing", async () => {
      vi.mocked(mockResendClient.emails.send).mockImplementation(async (emailOptions) => {
        await new Promise((resolve) => setTimeout(resolve, 1));

        return {
          data: { id: `msg-${emailOptions.to}` },
          error: null,
        };
      });

      const payloads: NotificationPayload[] = Array.from({ length: 6 }, (_, index) => ({
        to: `user${index + 1}@example.com`,
        subject: `Batch Email ${index + 1}`,
        content: `<h1>Email ${index + 1}</h1>`,
      }));
      const batchResult = provider.sendBatch(payloads);

      payloads.push({
        to: "late-user@example.com",
        subject: "Late Email",
        content: "<h1>Late</h1>",
      });

      const results = await batchResult;

      expect(results).toHaveLength(6);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(6);
      expect(getSuccessfulMessageIds(results)).toEqual(
        Array.from({ length: 6 }, (_, index) => `msg-user${index + 1}@example.com`),
      );
    });

    it("should keep retryable large batch attempts within the batch concurrency cap", async () => {
      const payloads: NotificationPayload[] = Array.from({ length: 12 }, (_, index) => ({
        to: `user${index + 1}@example.com`,
        subject: `Retry Batch Email ${index + 1}`,
        content: `<h1>Email ${index + 1}</h1>`,
      }));
      const attemptsByRecipient = new Map<string, number>();
      let activeSends = 0;
      let maxActiveSends = 0;

      vi.mocked(mockResendClient.emails.send).mockImplementation(async (emailOptions) => {
        const recipient = String(emailOptions.to);
        const attempt = (attemptsByRecipient.get(recipient) ?? 0) + 1;
        attemptsByRecipient.set(recipient, attempt);
        activeSends += 1;
        maxActiveSends = Math.max(maxActiveSends, activeSends);

        await new Promise((resolve) => setTimeout(resolve, 1));

        activeSends -= 1;

        if (attempt === 1) {
          return {
            data: null,
            error: { message: "Rate limit exceeded", name: "rate_limit_exceeded" },
          };
        }

        const messageIndex = payloads.findIndex((payload) => payload.to === emailOptions.to);

        return {
          data: { id: `msg-${messageIndex + 1}` },
          error: null,
        };
      });

      const results = await provider.sendBatch(payloads);

      expect(maxActiveSends).toBeLessThanOrEqual(5);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(payloads.length * 2);
      expect(getSuccessfulMessageIds(results)).toEqual(
        payloads.map((_, index) => `msg-${index + 1}`),
      );
    });

    it("should handle empty batch", async () => {
      const results = await provider.sendBatch([]);

      expect(results).toHaveLength(0);
      expect(mockResendClient.emails.send).not.toHaveBeenCalled();
    });

    it("should handle batch with single email", async () => {
      vi.mocked(mockResendClient.emails.send).mockResolvedValueOnce(mockSuccessResponse);

      const payloads: NotificationPayload[] = [
        {
          to: "user1@example.com",
          subject: "Single Email",
          content: "<h1>Single</h1>",
        },
      ];

      const results = await provider.sendBatch(payloads);

      expect(results).toHaveLength(1);
      expect(getSuccessfulMessageIds(results)).toEqual(["msg-123"]);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(1);
    });
  });
});

function getRecordedErrorMessages(): string {
  return vi
    .mocked(recordError)
    .mock.calls.map(([error]) =>
      error instanceof Error ? `${error.name}:${error.message}` : String(error),
    )
    .join("\n");
}

function expectFailedNotificationResult(
  result: NotificationResult,
): asserts result is Extract<NotificationResult, { success: false }> {
  expect(result.success).toBe(false);

  if (result.success) {
    throw new TestNotificationAssertionProblem();
  }
}

function expectSuccessfulNotificationResult(
  result: NotificationResult,
): asserts result is Extract<NotificationResult, { success: true }> {
  expect(result.success).toBe(true);

  if (!result.success) {
    throw result.problem;
  }
}

function getSuccessfulMessageIds(results: NotificationResult[]): Array<string | undefined> {
  return results.map((result) => {
    expectSuccessfulNotificationResult(result);
    return result.messageId;
  });
}
