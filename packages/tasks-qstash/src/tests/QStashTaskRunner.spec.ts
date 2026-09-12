import { createQStashTaskConformanceSuite } from "@croco/testing";
import { Task, taskRef } from "@croco/tasks-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as QStashSdk from "@upstash/qstash";

let mockPublishJSON = vi.fn();

vi.mock("@upstash/qstash", () => ({
  Client: class {
    publishJSON = mockPublishJSON;
  },
}));

import { QStashTaskRunner } from "../libs/QStashTaskRunner";

type PublishJsonRecord = {
  readonly body?: unknown;
  readonly deduplicationId?: string;
  readonly delay?: number;
  readonly headers?: Record<string, string>;
  readonly url?: string;
};

const QSTASH_LIVE_ENV = [
  "CROCO_LIVE_QSTASH",
  "UPSTASH_QSTASH_TOKEN",
  "UPSTASH_QSTASH_DESTINATION_URL",
] as const;
const SECRET_SAMPLE = "super-secret-token";
const SECRET_RICH_ERROR_MESSAGE = `Authorization: Bearer ${SECRET_SAMPLE}; "token":"${SECRET_SAMPLE}"; https://qstash.upstash.io?token=${SECRET_SAMPLE}; Cookie: session=${SECRET_SAMPLE}`;

function createUpstreamError(message: string, status: number): Error & { readonly status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function getPublishJsonRecords(): PublishJsonRecord[] {
  return mockPublishJSON.mock.calls.map((call) => call[0] as PublishJsonRecord);
}

function isTruthyEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for QStash live smoke.`);
  }

  return value;
}

async function runQStashLiveSmoke(): Promise<void> {
  const { Client } = await vi.importActual<typeof QStashSdk>("@upstash/qstash");
  const client = new Client({ token: readRequiredEnv("UPSTASH_QSTASH_TOKEN") });
  const deduplicationId = `croco-tasks-qstash:${Date.now()}`;
  const response = await client.publishJSON({
    body: {
      payload: { source: "tasks-qstash-live-smoke" },
      taskId: "croco.tasks-qstash.live-smoke",
    },
    deduplicationId,
    url: readRequiredEnv("UPSTASH_QSTASH_DESTINATION_URL"),
  });

  expect(typeof response.messageId).toBe("string");
  expect(response.messageId.length).toBeGreaterThan(0);
}

describe("QStashTaskRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishJSON = vi.fn().mockResolvedValue({
      messageId: "msg-test-123",
    });
  });

  describe("QStash task conformance", () => {
    it.each(
      createQStashTaskConformanceSuite({
        createMissingConfig: () =>
          new QStashTaskRunner({
            token: "",
            destinationUrl: "https://example.com/api/tasks/webhook",
          }),
        createPublisher: (scenario) => {
          if (scenario === "success") {
            mockPublishJSON.mockResolvedValue({ messageId: "msg-conformance" });
          }

          if (scenario === "retryable-upstream") {
            mockPublishJSON.mockRejectedValue(createUpstreamError(SECRET_RICH_ERROR_MESSAGE, 503));
          }

          if (scenario === "terminal-upstream") {
            mockPublishJSON.mockRejectedValue(createUpstreamError(SECRET_RICH_ERROR_MESSAGE, 400));
          }

          return {
            publisher: new QStashTaskRunner({
              token: "test-token",
              destinationUrl: "https://example.com/api/tasks/webhook",
            }),
            getPublishedMessages: getPublishJsonRecords,
          };
        },
        liveSmoke: {
          isEnabled: () =>
            isTruthyEnv("CROCO_LIVE_QSTASH") &&
            QSTASH_LIVE_ENV.every((name) => Boolean(process.env[name])),
          requiredEnv: QSTASH_LIVE_ENV,
          run: runQStashLiveSmoke,
        },
        providerName: "tasks-qstash",
        secretSamples: [SECRET_SAMPLE],
      }).cases,
    )("$name", async ({ run }) => {
      await run();
    });
  });

  it("should publish task to QStash with correct body", async () => {
    const runner = new QStashTaskRunner({
      token: "test-token",
      destinationUrl: "https://example.com/api/tasks/webhook",
    });

    const result = await runner.execute("send-email", { userId: "user-123" });

    expect(mockPublishJSON).toHaveBeenCalledWith({
      url: "https://example.com/api/tasks/webhook",
      body: {
        taskId: "send-email",
        payload: { userId: "user-123" },
      },
      delay: undefined,
      headers: {},
    });
    expect(result.messageId).toBe("msg-test-123");
  });

  it("should publish task references by name", async () => {
    class SendEmailTask {
      @Task({ name: "send-email" })
      run(payload: { userId: string }): void {
        void payload;
      }
    }

    const runner = new QStashTaskRunner({
      token: "test-token",
      destinationUrl: "https://example.com/api/tasks/webhook",
    });

    const result = await runner.execute(taskRef(SendEmailTask, "run"), { userId: "user-123" });

    expect(mockPublishJSON).toHaveBeenCalledWith({
      url: "https://example.com/api/tasks/webhook",
      body: {
        taskId: "send-email",
        payload: { userId: "user-123" },
      },
      delay: undefined,
      headers: {},
    });
    expect(result.messageId).toBe("msg-test-123");
  });

  it("accepts HTTPS destination URLs", () => {
    expect(
      () =>
        new QStashTaskRunner({
          token: "test-token",
          destinationUrl: "https://example.com/api/tasks/webhook",
        }),
    ).not.toThrow();
  });

  it("rejects HTTP destination URLs", () => {
    expect(
      () =>
        new QStashTaskRunner({
          token: "test-token",
          destinationUrl: "http://example.com/api/tasks/webhook",
        }),
    ).toThrow("QStash destinationUrl must use https.");
  });

  it("should use default delay when provided", async () => {
    const runner = new QStashTaskRunner({
      token: "test-token",
      destinationUrl: "https://example.com/api/tasks/webhook",
      defaultDelay: 30,
    });

    await runner.execute("process-payment", { amount: 100 });

    expect(mockPublishJSON).toHaveBeenCalledWith({
      url: "https://example.com/api/tasks/webhook",
      body: {
        taskId: "process-payment",
        payload: { amount: 100 },
      },
      delay: 30,
      headers: {},
    });
  });

  it("should override default delay with option", async () => {
    const runner = new QStashTaskRunner({
      token: "test-token",
      destinationUrl: "https://example.com/api/tasks/webhook",
      defaultDelay: 30,
    });

    await runner.execute("send-notification", { message: "hello" }, { delay: 60 });

    expect(mockPublishJSON).toHaveBeenCalledWith({
      url: "https://example.com/api/tasks/webhook",
      body: {
        taskId: "send-notification",
        payload: { message: "hello" },
      },
      delay: 60,
      headers: {},
    });
  });

  it("should merge default headers with option headers", async () => {
    const runner = new QStashTaskRunner({
      token: "test-token",
      destinationUrl: "https://example.com/api/tasks/webhook",
      defaultHeaders: { "X-Default": "value1" },
    });

    await runner.execute("sync-data", { data: "test" }, { headers: { "X-Custom": "value2" } });

    expect(mockPublishJSON).toHaveBeenCalledWith({
      url: "https://example.com/api/tasks/webhook",
      body: {
        taskId: "sync-data",
        payload: { data: "test" },
      },
      delay: undefined,
      headers: {
        "X-Default": "value1",
        "X-Custom": "value2",
      },
    });
  });

  it("should allow option headers to override default headers", async () => {
    const runner = new QStashTaskRunner({
      token: "test-token",
      destinationUrl: "https://example.com/api/tasks/webhook",
      defaultHeaders: { "X-Api-Key": "default-key" },
    });

    await runner.execute(
      "export-report",
      { format: "pdf" },
      { headers: { "X-Api-Key": "override-key" } },
    );

    expect(mockPublishJSON).toHaveBeenCalledWith({
      url: "https://example.com/api/tasks/webhook",
      body: {
        taskId: "export-report",
        payload: { format: "pdf" },
      },
      delay: undefined,
      headers: {
        "X-Api-Key": "override-key",
      },
    });
  });

  it("should pass idempotency keys as QStash deduplication ids", async () => {
    const runner = new QStashTaskRunner({
      token: "test-token",
      destinationUrl: "https://example.com/api/tasks/webhook",
    });

    await runner.execute(
      "sync-customer",
      { customerId: "customer-123" },
      { idempotencyKey: "customer-sync-123" },
    );

    expect(mockPublishJSON).toHaveBeenCalledWith({
      deduplicationId: "customer-sync-123",
      url: "https://example.com/api/tasks/webhook",
      body: {
        taskId: "sync-customer",
        payload: { customerId: "customer-123" },
      },
      delay: undefined,
      headers: {},
    });
  });
});
