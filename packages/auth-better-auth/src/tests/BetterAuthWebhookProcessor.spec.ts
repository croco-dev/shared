import { createHmac } from "node:crypto";
import { IdempotencyConflictProblem, InMemoryIdempotencyStore } from "@croco/idempotency-core";
import { WebhookGateway } from "@croco/webhooks-core";
import type { WebhookGatewayStoredResult } from "@croco/webhooks-core";
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BetterAuthWebhookProcessor } from "../libs/BetterAuthWebhookProcessor";
import {
  InvalidWebhookPayloadProblem,
  InvalidWebhookSignatureProblem,
} from "../libs/problems/WebhookProblems";
import type { BetterAuthSessionProvider, BetterAuthWebhookHandler } from "../libs/types";

const TEST_SIGNING_SECRET = "test-secret";
const TEST_EVENT_TIMESTAMP = new Date().toISOString();

function normalizeWebhookBody(body: string): string {
  try {
    const value = JSON.parse(body);
    if (typeof value === "object" && value !== null && !("timestamp" in value)) {
      return JSON.stringify({ ...value, timestamp: TEST_EVENT_TIMESTAMP });
    }
  } catch {
    return body;
  }

  return body;
}

function createMockSessionProvider(): BetterAuthSessionProvider {
  return {
    getSession: vi.fn().mockResolvedValue(null),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    revokeUserSessions: vi.fn().mockResolvedValue(undefined),
  };
}

function createRawSignature(body: string, secret = TEST_SIGNING_SECRET): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

function createSignature(body: string, secret = TEST_SIGNING_SECRET): string {
  return createRawSignature(normalizeWebhookBody(body), secret);
}

function createMockWebhookRequest(
  body: string,
  signature?: string,
): { headers: Headers; text: () => Promise<string> } {
  return {
    headers: new Headers(signature ? { "x-better-auth-signature": signature } : {}),
    text: () => Promise.resolve(normalizeWebhookBody(body)),
  };
}

describe("BetterAuthWebhookProcessor", () => {
  let processor!: BetterAuthWebhookProcessor;
  let mockSessionProvider!: BetterAuthSessionProvider;
  let mockHandlers!: BetterAuthWebhookHandler;
  let idempotencyStore!: InMemoryIdempotencyStore<WebhookGatewayStoredResult>;

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyStore = new InMemoryIdempotencyStore();
    mockSessionProvider = createMockSessionProvider();
    mockHandlers = {
      "user.created": vi.fn().mockResolvedValue(undefined),
      "user.updated": vi.fn().mockResolvedValue(undefined),
      "user.deleted": vi.fn().mockResolvedValue(undefined),
      "session.created": vi.fn().mockResolvedValue(undefined),
      "session.revoked": vi.fn().mockResolvedValue(undefined),
    };
    processor = new BetterAuthWebhookProcessor(
      {
        signingSecret: TEST_SIGNING_SECRET,
        idempotencyStore,
      },
      mockHandlers,
      mockSessionProvider,
    );
  });

  describe("processWebhook", () => {
    it("should process user.created event with a valid HMAC signature", async () => {
      const eventData = { id: "user-123", email: "test@example.com" };
      const rawBody = JSON.stringify({ type: "user.created", data: eventData });
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await processor.processWebhook(request);

      expect(mockHandlers["user.created"]).toHaveBeenCalledWith(eventData);
    });

    it("should throw InvalidWebhookSignatureProblem when signature is invalid", async () => {
      const rawBody = JSON.stringify({ type: "user.created" });
      const request = createMockWebhookRequest(rawBody, "invalid-signature");

      await expect(processor.processWebhook(request)).rejects.toBeInstanceOf(
        InvalidWebhookSignatureProblem,
      );
      expect(idempotencyStore.size).toBe(0);
    });

    it("should throw InvalidWebhookSignatureProblem when signature header is missing", async () => {
      const rawBody = JSON.stringify({ type: "user.created" });
      const request = createMockWebhookRequest(rawBody);

      await expect(processor.processWebhook(request)).rejects.toBeInstanceOf(
        InvalidWebhookSignatureProblem,
      );
    });

    it("should accept an empty body when its HMAC is valid and then fail payload parsing", async () => {
      const rawBody = "";
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await expect(processor.processWebhook(request)).rejects.toBeInstanceOf(
        InvalidWebhookPayloadProblem,
      );
    });

    it("should reject a signed event without a timestamp before reserving idempotency state", async () => {
      const rawBody = JSON.stringify({ type: "user.created", data: { id: "user-123" } });
      const request = {
        headers: new Headers({ "x-better-auth-signature": createRawSignature(rawBody) }),
        text: () => Promise.resolve(rawBody),
      };

      await expect(processor.processWebhook(request)).rejects.toBeInstanceOf(
        InvalidWebhookPayloadProblem,
      );
      expect(idempotencyStore.size).toBe(0);
    });

    it("should throw InvalidWebhookSignatureProblem when the body is tampered with", async () => {
      const signedBody = JSON.stringify({ type: "user.created", data: { id: "user-123" } });
      const tamperedBody = JSON.stringify({ type: "user.created", data: { id: "user-456" } });
      const request = createMockWebhookRequest(tamperedBody, createSignature(signedBody));

      await expect(processor.processWebhook(request)).rejects.toBeInstanceOf(
        InvalidWebhookSignatureProblem,
      );
    });

    it("should invoke a handler once for identical verified deliveries", async () => {
      const rawBody = JSON.stringify({
        type: "user.created",
        data: { id: "user-123" },
      });
      const request = () => createMockWebhookRequest(rawBody, createSignature(rawBody));

      await processor.processWebhook(request());
      await processor.processWebhook(request());

      expect(mockHandlers["user.created"]).toHaveBeenCalledTimes(1);
    });

    it("should share one handler execution across concurrent duplicates", async () => {
      let releaseHandler!: () => void;
      let markHandlerStarted!: () => void;
      const handlerStarted = new Promise<void>((resolve) => {
        markHandlerStarted = resolve;
      });
      const handlerReleased = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      mockHandlers["user.created"] = vi.fn(async () => {
        markHandlerStarted();
        await handlerReleased;
      });
      const rawBody = JSON.stringify({
        id: "delivery-123",
        type: "user.created",
        data: { id: "user-123" },
      });
      const request = () => createMockWebhookRequest(rawBody, createSignature(rawBody));

      const first = processor.processWebhook(request());
      await handlerStarted;
      const duplicate = processor.processWebhook(request());
      releaseHandler();
      await Promise.all([first, duplicate]);

      expect(mockHandlers["user.created"]).toHaveBeenCalledTimes(1);
    });

    it("should not let an invalid signature join an active verified delivery", async () => {
      let releaseHandler!: () => void;
      let markHandlerStarted!: () => void;
      const handlerStarted = new Promise<void>((resolve) => {
        markHandlerStarted = resolve;
      });
      const handlerReleased = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      mockHandlers["user.created"] = vi.fn(async () => {
        markHandlerStarted();
        await handlerReleased;
      });
      const rawBody = JSON.stringify({
        id: "delivery-123",
        type: "user.created",
        data: { id: "user-123" },
      });
      const verified = processor.processWebhook(
        createMockWebhookRequest(rawBody, createSignature(rawBody)),
      );
      await handlerStarted;

      await expect(
        processor.processWebhook(createMockWebhookRequest(rawBody, "invalid-signature")),
      ).rejects.toBeInstanceOf(InvalidWebhookSignatureProblem);

      releaseHandler();
      await verified;
      expect(mockHandlers["user.created"]).toHaveBeenCalledTimes(1);
    });

    it("should reject a changed payload that reuses a delivery id", async () => {
      const originalBody = JSON.stringify({
        id: "delivery-123",
        type: "user.created",
        data: { id: "user-123" },
      });
      const changedBody = JSON.stringify({
        id: "delivery-123",
        type: "user.created",
        data: { id: "user-456" },
      });

      await processor.processWebhook(
        createMockWebhookRequest(originalBody, createSignature(originalBody)),
      );

      await expect(
        processor.processWebhook(
          createMockWebhookRequest(changedBody, createSignature(changedBody)),
        ),
      ).rejects.toBeInstanceOf(IdempotencyConflictProblem);
      expect(mockHandlers["user.created"]).toHaveBeenCalledTimes(1);
    });

    it("should reject stale signed events before reserving idempotency state", async () => {
      const store = new InMemoryIdempotencyStore<WebhookGatewayStoredResult>();
      const reserve = vi.spyOn(store, "reserve");
      const staleProcessor = new BetterAuthWebhookProcessor(
        { signingSecret: TEST_SIGNING_SECRET, idempotencyStore: store },
        mockHandlers,
        mockSessionProvider,
      );
      const rawBody = JSON.stringify({
        type: "user.created",
        data: { id: "user-123" },
        timestamp: new Date(Date.now() - 600_000).toISOString(),
      });

      await expect(
        staleProcessor.processWebhook(createMockWebhookRequest(rawBody, createSignature(rawBody))),
      ).rejects.toBeInstanceOf(InvalidWebhookSignatureProblem);
      expect(reserve).not.toHaveBeenCalled();
    });

    it("should reject signed events too far in the future before reserving idempotency state", async () => {
      const rawBody = JSON.stringify({
        type: "user.created",
        data: { id: "user-123" },
        timestamp: new Date(Date.now() + 600_000).toISOString(),
      });

      await expect(
        processor.processWebhook(createMockWebhookRequest(rawBody, createSignature(rawBody))),
      ).rejects.toBeInstanceOf(InvalidWebhookSignatureProblem);
      expect(idempotencyStore.size).toBe(0);
    });

    describe("fractional-second timestamps", () => {
      beforeEach(() => {
        const handle = WebhookGateway.prototype.handle;
        vi.spyOn(WebhookGateway.prototype, "handle").mockImplementation(
          function (this: WebhookGateway, request) {
            return handle.call(this, {
              ...request,
              receivedAt: new Date("2026-09-05T12:34:56.123Z"),
            });
          },
        );
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it.each([
        "2026-09-05T12:34:56Z",
        "2026-09-05T12:34:56.1Z",
        "2026-09-05T12:34:56.12Z",
        "2026-09-05T12:34:56.123Z",
        "2026-09-05T12:34:56.1234Z",
        "2026-09-05T12:34:56.123456Z",
        "2026-09-05T12:34:56.123456789Z",
        "2026-09-05T18:04:56.123456+05:30",
        "2026-09-05T09:04:56.123456789-03:30",
      ])("should process a signed event with timestamp %s", async (timestamp) => {
        const eventData = { id: "user-123" };
        const rawBody = JSON.stringify({ type: "user.created", data: eventData, timestamp });

        await processor.processWebhook(createMockWebhookRequest(rawBody, createSignature(rawBody)));

        expect(mockHandlers["user.created"]).toHaveBeenCalledExactlyOnceWith(eventData);
      });

      it.each(["2026-09-05T12:29:56.123456Z", "2026-09-05T12:39:56.123999999Z"])(
        "should accept timestamp %s at the millisecond age boundary",
        async (timestamp) => {
          const rawBody = JSON.stringify({ type: "user.created", timestamp });

          await processor.processWebhook(
            createMockWebhookRequest(rawBody, createSignature(rawBody)),
          );

          expect(mockHandlers["user.created"]).toHaveBeenCalledTimes(1);
        },
      );

      it.each(["2026-09-05T12:29:56.122999999Z", "2026-09-05T12:39:56.124001Z"])(
        "should reject timestamp %s outside the millisecond age boundary",
        async (timestamp) => {
          const rawBody = JSON.stringify({ type: "user.created", timestamp });

          await expect(
            processor.processWebhook(createMockWebhookRequest(rawBody, createSignature(rawBody))),
          ).rejects.toBeInstanceOf(InvalidWebhookSignatureProblem);
          expect(mockHandlers["user.created"]).not.toHaveBeenCalled();
          expect(idempotencyStore.size).toBe(0);
        },
      );
    });

    it.each([
      "2026-08-13T12:00:00",
      "Thu, 13 Aug 2026 12:00:00 GMT",
      "2026-02-31T12:00:00Z",
      "2026-08-13T25:00:00Z",
      "2026-08-13T12:00:00+24:00",
      "2026-13-05T12:34:56.123456Z",
      "2026-02-29T12:34:56.123456789Z",
      "2026-09-31T12:34:56.123456Z",
      "2026-09-05T24:34:56.123456789Z",
      "2026-09-05T12:60:56.123456Z",
      "2026-09-05T12:34:60.123456789Z",
      "2026-09-05T12:34:56.123456+24:00",
      "2026-09-05T12:34:56.123456789-03:60",
      "2026-09-05T12:34:56.123456",
      "2026-09-05T12:34:56.Z",
      "2026-09-05T12:34:56.123abcZ",
      "2026-09-05T12:34:56.1234567890Z",
    ])(
      "should reject non-canonical timestamp %s before reserving idempotency",
      async (timestamp) => {
        const rawBody = JSON.stringify({
          type: "user.created",
          data: { id: "user-123" },
          timestamp,
        });

        await expect(
          processor.processWebhook(createMockWebhookRequest(rawBody, createSignature(rawBody))),
        ).rejects.toBeInstanceOf(InvalidWebhookPayloadProblem);
        expect(idempotencyStore.size).toBe(0);
      },
    );

    it("should throw InvalidWebhookPayloadProblem when body is not an object", async () => {
      const rawBody = JSON.stringify("not-an-object");
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await expect(processor.processWebhook(request)).rejects.toBeInstanceOf(
        InvalidWebhookPayloadProblem,
      );
    });

    it("should throw InvalidWebhookPayloadProblem when type is missing", async () => {
      const rawBody = JSON.stringify({ data: {} });
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await expect(processor.processWebhook(request)).rejects.toBeInstanceOf(
        InvalidWebhookPayloadProblem,
      );
    });

    it("should process user.updated event", async () => {
      const eventData = { id: "user-123", name: "Updated Name" };
      const rawBody = JSON.stringify({ type: "user.updated", data: eventData });
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await processor.processWebhook(request);

      expect(mockHandlers["user.updated"]).toHaveBeenCalledWith(eventData);
    });

    it("should process user.deleted event", async () => {
      const eventData = { id: "user-123" };
      const rawBody = JSON.stringify({ type: "user.deleted", data: eventData });
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await processor.processWebhook(request);

      expect(mockHandlers["user.deleted"]).toHaveBeenCalledWith(eventData);
    });

    it("should process session.created event", async () => {
      const eventData = { id: "session-123", userId: "user-456" };
      const rawBody = JSON.stringify({ type: "session.created", data: eventData });
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await processor.processWebhook(request);

      expect(mockHandlers["session.created"]).toHaveBeenCalledWith(eventData);
    });

    it("should process session.revoked event", async () => {
      const eventData = { id: "session-123", userId: "user-456" };
      const rawBody = JSON.stringify({ type: "session.revoked", data: eventData });
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await processor.processWebhook(request);

      expect(mockHandlers["session.revoked"]).toHaveBeenCalledWith(eventData);
    });

    it("should handle unknown event types gracefully", async () => {
      const rawBody = JSON.stringify({ type: "unknown.event", data: {} });
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await expect(processor.processWebhook(request)).resolves.not.toThrow();
    });

    it("should use empty object when data is not provided", async () => {
      const rawBody = JSON.stringify({ type: "user.created" });
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await processor.processWebhook(request);

      expect(mockHandlers["user.created"]).toHaveBeenCalledWith({});
    });

    it("should use empty object when data is not an object", async () => {
      const rawBody = JSON.stringify({ type: "user.created", data: "not-an-object" });
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await processor.processWebhook(request);

      expect(mockHandlers["user.created"]).toHaveBeenCalledWith({});
    });

    it("should not throw when handler is not defined", async () => {
      const processorWithoutHandlers = new BetterAuthWebhookProcessor(
        {
          signingSecret: TEST_SIGNING_SECRET,
          idempotencyStore: new InMemoryIdempotencyStore(),
        },
        {},
        mockSessionProvider,
      );
      const rawBody = JSON.stringify({ type: "user.created", data: { id: "user-123" } });
      const request = createMockWebhookRequest(rawBody, createSignature(rawBody));

      await expect(processorWithoutHandlers.processWebhook(request)).resolves.not.toThrow();
    });
  });
});
