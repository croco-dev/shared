import "reflect-metadata";
import type { AnalyticsManager } from "@croco/analytics-core";
import { Container, Context, type ILogger, LOGGER_TOKEN } from "@croco/framework-context";
import { PostHogClient } from "@croco/integrations-posthog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostHogAnalyticsDiagnosticsProvider } from "../libs/PostHogAnalyticsDiagnosticsProvider";
import {
  POSTHOG_ANALYTICS_MANAGER_OPTIONS,
  PostHogAnalyticsManager,
} from "../libs/PostHogAnalyticsManager";
import { PostHogAnalyticsFlushProblem } from "../libs/problems/PostHogAnalyticsProblems";

vi.mock("posthog-node", () => {
  const PostHogMock = vi.fn();
  PostHogMock.prototype.isFeatureEnabled = vi.fn().mockResolvedValue(true);
  PostHogMock.prototype.getFeatureFlag = vi.fn().mockResolvedValue("variant-a");
  PostHogMock.prototype.capture = vi.fn();
  PostHogMock.prototype.identify = vi.fn();
  PostHogMock.prototype.groupIdentify = vi.fn();
  PostHogMock.prototype.flush = vi.fn().mockResolvedValue(undefined);
  PostHogMock.prototype.shutdown = vi.fn().mockResolvedValue(undefined);

  return {
    PostHog: PostHogMock,
  };
});

describe("PostHog Integration", () => {
  type LoggerMock = ILogger & {
    child: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  let analyticsManager!: AnalyticsManager;
  let postHogClient!: PostHogClient;
  let logger!: LoggerMock;

  beforeEach(() => {
    vi.clearAllMocks();
    postHogClient = new PostHogClient({ apiKey: "test-api-key", host: "https://eu.posthog.com" });
    logger = {
      child: vi.fn<ILogger["child"]>(),
      debug: vi.fn<ILogger["debug"]>(),
      error: vi.fn<ILogger["error"]>(),
      fatal: vi.fn<ILogger["fatal"]>(),
      info: vi.fn<ILogger["info"]>(),
      warn: vi.fn<ILogger["warn"]>(),
    };
    logger.child.mockReturnValue(logger);
    Container.set(LOGGER_TOKEN, logger);
    analyticsManager = new PostHogAnalyticsManager(postHogClient);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Container.remove(PostHogAnalyticsManager);
    Container.remove(PostHogClient);
    Container.remove(LOGGER_TOKEN);
    Container.remove(POSTHOG_ANALYTICS_MANAGER_OPTIONS);
  });

  describe("without a registered logger", () => {
    beforeEach(() => {
      Container.remove(LOGGER_TOKEN);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each(["capture", "identify", "group"] as const)(
      "should contain synchronous %s failures and warn through the console",
      (operation) => {
        const clientMethod = operation === "group" ? "groupIdentify" : operation;
        vi.spyOn(postHogClient.getClient(), clientMethod).mockImplementationOnce(() => {
          throw new Error("provider-secret");
        });

        expect(() => {
          if (operation === "group") analyticsManager.group("tenant", "tenant-1");
          else analyticsManager[operation]("test-event");
        }).not.toThrow();

        expect(console.warn).toHaveBeenCalledExactlyOnceWith(`PostHog ${operation} failed`, {
          ...(operation === "capture" ? { event: "test-event" } : { operation }),
          errorName: "Error",
          problemCode: `analytics-posthog/${operation}-failed`,
        });
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("provider-secret");
      },
    );

    it.each(["capture", "identify", "group"] as const)(
      "should observe asynchronous %s failures and warn through the console",
      async (operation) => {
        const clientMethod = operation === "group" ? "groupIdentify" : operation;
        vi.spyOn(postHogClient.getClient(), clientMethod).mockRejectedValueOnce(
          new Error("provider-secret"),
        );

        if (operation === "group") analyticsManager.group("tenant", "tenant-1");
        else analyticsManager[operation]("test-event");
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(console.warn).toHaveBeenCalledExactlyOnceWith(`PostHog ${operation} failed`, {
          ...(operation === "capture" ? { event: "test-event" } : { operation }),
          errorName: "Error",
          problemCode: `analytics-posthog/${operation}-failed`,
        });
      },
    );

    it("should preserve the flush Problem and warn through the console", async () => {
      vi.spyOn(postHogClient.getClient(), "flush").mockRejectedValueOnce(new Error("flush-secret"));

      await expect(analyticsManager.flush()).rejects.toBeInstanceOf(PostHogAnalyticsFlushProblem);
      expect(console.warn).toHaveBeenCalledExactlyOnceWith("PostHog analytics flush failed", {
        errorName: "Error",
        problemCode: "analytics-posthog/flush-failed",
      });
    });

    it("should report all disabled operations through the console without calling the provider", async () => {
      Container.set(POSTHOG_ANALYTICS_MANAGER_OPTIONS, { enabled: false });
      const disabledManager = new PostHogAnalyticsManager(postHogClient);
      const provider = vi.spyOn(postHogClient, "getClient");
      const flush = vi.spyOn(postHogClient, "flush");

      disabledManager.capture("disabled-event");
      disabledManager.identify("user-1");
      disabledManager.group("tenant", "tenant-1");
      await disabledManager.flush();

      expect(provider).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledTimes(4);
      for (const operation of ["capture", "identify", "group", "flush"]) {
        expect(console.info).toHaveBeenCalledWith(
          "PostHog analytics operation skipped because analytics is disabled",
          expect.objectContaining({ provider: "posthog", operation }),
        );
      }
    });
  });

  it("should resolve analytics manager", () => {
    expect(analyticsManager).toBeInstanceOf(PostHogAnalyticsManager);
  });

  it("should resolve analytics manager through the Croco container", () => {
    Container.set(PostHogClient, postHogClient);
    Container.set(LOGGER_TOKEN, logger);
    Container.register(PostHogAnalyticsManager, "singleton");
    const captureSpy = vi.spyOn(postHogClient.getClient(), "capture");

    const resolved = Container.get(PostHogAnalyticsManager);

    expect(resolved).toBeInstanceOf(PostHogAnalyticsManager);
    resolved.capture("di-event", { userId: "user-di" });
    expect(captureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "user-di",
        event: "di-event",
      }),
    );
  });

  it("should auto-inject context into analytics", async () => {
    const spy = vi.spyOn(postHogClient.getClient(), "capture");

    await Context.run(
      { requestId: "req-2", user: { id: "user-456" }, tenantId: "tenant-xyz" },
      async () => {
        analyticsManager.capture("test-event");
        expect(spy).toHaveBeenCalledWith(
          expect.objectContaining({
            distinctId: "user-456",
            groups: { tenant: "tenant-xyz" },
            event: "test-event",
          }),
        );
      },
    );
  });

  it("should log capture failures without throwing to callers", async () => {
    const spy = vi
      .spyOn(postHogClient.getClient(), "capture")
      .mockRejectedValueOnce(new Error("network failed"));

    expect(() => analyticsManager.capture("failed-event")).not.toThrow();

    await Promise.resolve();

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "failed-event",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith("PostHog capture failed", {
      event: "failed-event",
      errorName: "Error",
      problemCode: "analytics-posthog/capture-failed",
    });
  });

  it("should preserve synchronous capture failure containment", () => {
    vi.spyOn(postHogClient.getClient(), "capture").mockImplementationOnce(() => {
      throw new Error("capture failed synchronously");
    });

    expect(() => analyticsManager.capture("sync-failed-event")).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith("PostHog capture failed", {
      event: "sync-failed-event",
      errorName: "Error",
      problemCode: "analytics-posthog/capture-failed",
    });
  });

  it("should not leak PostHog secrets when logging capture failures", async () => {
    const secretError = Object.assign(
      new Error("Authorization: Bearer secret ph_secret should not be logged"),
      {
        code: "ECONNRESET",
        status: 503,
      },
    );
    vi.spyOn(postHogClient.getClient(), "capture").mockRejectedValueOnce(secretError);

    analyticsManager.capture("redacted-capture-event");

    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith("PostHog capture failed", {
      event: "redacted-capture-event",
      errorName: "Error",
      upstreamCode: "ECONNRESET",
      upstreamStatus: 503,
      problemCode: "analytics-posthog/capture-failed",
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("ph_secret");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("Bearer secret");
  });

  it("should use request-scoped anonymous distinctId when user context is missing", async () => {
    const spy = vi.spyOn(postHogClient.getClient(), "capture");

    await Context.run({ requestId: "req-anon", tenantId: "tenant-xyz" }, async () => {
      analyticsManager.capture("anonymous-event");
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "anonymous:req-anon",
        groups: { tenant: "tenant-xyz" },
        event: "anonymous-event",
      }),
    );
  });

  it("should generate a non-static anonymous distinctId outside Context", () => {
    const spy = vi.spyOn(postHogClient.getClient(), "capture");

    analyticsManager.capture("anonymous-event");

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: expect.stringMatching(/^anonymous:/),
        event: "anonymous-event",
      }),
    );

    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    const distinctId = lastCall?.[0]?.distinctId;

    expect(distinctId).not.toBe("anonymous");
  });

  it("should identify users and associate groups through the PostHog client", () => {
    const client = postHogClient.getClient();
    const identifySpy = vi.spyOn(client, "identify");
    const groupSpy = vi.spyOn(client, "groupIdentify");

    analyticsManager.identify("user-123", { plan: "pro" });
    analyticsManager.group("tenant", "tenant-123", { seats: 10 });

    expect(identifySpy).toHaveBeenCalledWith({
      distinctId: "user-123",
      properties: { plan: "pro" },
    });
    expect(groupSpy).toHaveBeenCalledWith({
      groupType: "tenant",
      groupKey: "tenant-123",
      properties: { seats: 10 },
    });
  });

  it("should contain synchronous identify and group failures", () => {
    const client = postHogClient.getClient();
    vi.spyOn(client, "identify").mockImplementationOnce(() => {
      throw Object.assign(new Error("identify provider secret"), {
        code: "IDENTIFY_FAILED",
        status: 503,
      });
    });
    vi.spyOn(client, "groupIdentify").mockImplementationOnce(() => {
      throw Object.assign(new Error("group provider secret"), {
        code: "GROUP_FAILED",
        statusCode: 504,
      });
    });

    expect(() =>
      analyticsManager.identify("user-secret", { authorization: "identify-property-secret" }),
    ).not.toThrow();
    expect(() =>
      analyticsManager.group("tenant", "group-secret", { apiKey: "group-property-secret" }),
    ).not.toThrow();

    expect(logger.warn).toHaveBeenNthCalledWith(1, "PostHog identify failed", {
      operation: "identify",
      errorName: "Error",
      upstreamCode: "IDENTIFY_FAILED",
      upstreamStatus: 503,
      problemCode: "analytics-posthog/identify-failed",
    });
    expect(logger.warn).toHaveBeenNthCalledWith(2, "PostHog group failed", {
      operation: "group",
      errorName: "Error",
      upstreamCode: "GROUP_FAILED",
      upstreamStatus: 504,
      problemCode: "analytics-posthog/group-failed",
    });
    const loggedFailures = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(loggedFailures).not.toContain("provider secret");
    expect(loggedFailures).not.toContain("user-secret");
    expect(loggedFailures).not.toContain("group-secret");
    expect(loggedFailures).not.toContain("property-secret");
  });

  it("should contain synchronous failures with uninspectable rejection metadata", () => {
    const rejection = createUninspectableRejection();
    Object.defineProperty(postHogClient.getClient(), "identify", {
      configurable: true,
      value: () => {
        throw rejection;
      },
    });

    expect(() => analyticsManager.identify("user-secret")).not.toThrow();

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("PostHog identify failed", {
      operation: "identify",
      problemCode: "analytics-posthog/identify-failed",
    });
  });

  it("should observe asynchronous identify and group rejections exactly once", async () => {
    const client = postHogClient.getClient();
    vi.spyOn(client, "identify").mockRejectedValueOnce(new Error("identify rejected"));
    vi.spyOn(client, "groupIdentify").mockRejectedValueOnce(new Error("group rejected"));

    analyticsManager.identify("user-123");
    analyticsManager.group("tenant", "tenant-123");

    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("PostHog identify failed", {
      operation: "identify",
      errorName: "Error",
      problemCode: "analytics-posthog/identify-failed",
    });
    expect(logger.warn).toHaveBeenCalledWith("PostHog group failed", {
      operation: "group",
      errorName: "Error",
      problemCode: "analytics-posthog/group-failed",
    });
  });

  it("should contain asynchronous failures with uninspectable rejection metadata", async () => {
    const unhandledRejection = vi.fn();
    process.once("unhandledRejection", unhandledRejection);
    vi.spyOn(postHogClient.getClient(), "groupIdentify").mockRejectedValueOnce(
      createUninspectableRejection(),
    );

    try {
      analyticsManager.group("tenant", "group-secret");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith("PostHog group failed", {
        operation: "group",
        problemCode: "analytics-posthog/group-failed",
      });
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandledRejection);
    }
  });

  it("should flush buffered events without preventing later analytics operations", async () => {
    const client = postHogClient.getClient();
    const operationOrder: string[] = [];
    const flushSpy = vi.spyOn(client, "flush").mockImplementation(async () => {
      operationOrder.push("flush");
    });
    const shutdownSpy = vi.spyOn(client, "shutdown");
    const captureSpy = vi.spyOn(client, "capture").mockImplementation(() => {
      operationOrder.push("capture");
    });
    const identifySpy = vi.spyOn(client, "identify");
    const groupSpy = vi.spyOn(client, "groupIdentify");

    analyticsManager.capture("before-flush", { userId: "user-1" });
    await analyticsManager.flush();
    analyticsManager.capture("after-flush", { userId: "user-1" });
    analyticsManager.identify("user-1", { plan: "pro" });
    analyticsManager.group("tenant", "tenant-1");

    expect(flushSpy).toHaveBeenCalledOnce();
    expect(shutdownSpy).not.toHaveBeenCalled();
    expect(captureSpy).toHaveBeenCalledTimes(2);
    expect(captureSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ event: "before-flush" }),
    );
    expect(captureSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ event: "after-flush" }),
    );
    expect(operationOrder).toEqual(["capture", "flush", "capture"]);
    expect(identifySpy).toHaveBeenCalledOnce();
    expect(groupSpy).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("should surface flush failures as typed Problems", async () => {
    vi.spyOn(postHogClient.getClient(), "flush").mockRejectedValueOnce(new Error("flush failed"));

    await expect(analyticsManager.flush()).rejects.toBeInstanceOf(PostHogAnalyticsFlushProblem);
    expect(logger.warn).toHaveBeenCalledWith("PostHog analytics flush failed", {
      errorName: "Error",
      problemCode: "analytics-posthog/flush-failed",
    });
  });

  it("should not leak PostHog secrets when logging flush failures", async () => {
    const secretError = Object.assign(
      new Error("POSTHOG_API_KEY=ph_secret Authorization: Bearer secret"),
      {
        code: "ETIMEDOUT",
        statusCode: 504,
      },
    );
    vi.spyOn(postHogClient.getClient(), "flush").mockRejectedValueOnce(secretError);

    await expect(analyticsManager.flush()).rejects.toBeInstanceOf(PostHogAnalyticsFlushProblem);

    expect(logger.warn).toHaveBeenCalledWith("PostHog analytics flush failed", {
      errorName: "Error",
      upstreamCode: "ETIMEDOUT",
      upstreamStatus: 504,
      problemCode: "analytics-posthog/flush-failed",
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("ph_secret");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("Bearer secret");
  });

  it("should skip capture identify group and flush when analytics is disabled", async () => {
    Container.set(POSTHOG_ANALYTICS_MANAGER_OPTIONS, { enabled: false });
    const disabledManager = new PostHogAnalyticsManager(postHogClient);
    const client = postHogClient.getClient();
    const captureSpy = vi.spyOn(client, "capture");
    const identifySpy = vi.spyOn(client, "identify");
    const groupSpy = vi.spyOn(client, "groupIdentify");
    const flushSpy = vi.spyOn(client, "flush");
    const shutdownSpy = vi.spyOn(client, "shutdown");

    disabledManager.capture("disabled-event", { userId: "user-1" });
    disabledManager.identify("user-1", { plan: "pro" });
    disabledManager.group("tenant", "tenant-1");
    await disabledManager.flush();

    expect(captureSpy).not.toHaveBeenCalled();
    expect(identifySpy).not.toHaveBeenCalled();
    expect(groupSpy).not.toHaveBeenCalled();
    expect(flushSpy).not.toHaveBeenCalled();
    expect(shutdownSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "PostHog analytics operation skipped because analytics is disabled",
      expect.objectContaining({
        provider: "posthog",
        operation: "capture",
        event: "disabled-event",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "PostHog analytics operation skipped because analytics is disabled",
      {
        provider: "posthog",
        operation: "identify",
      },
    );
    expect(logger.info).toHaveBeenCalledWith(
      "PostHog analytics operation skipped because analytics is disabled",
      {
        provider: "posthog",
        operation: "group",
        groupType: "tenant",
      },
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("user-1");
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("tenant-1");
  });

  it("should report unhealthy diagnostics for missing PostHog configuration without leaking tokens", async () => {
    vi.unstubAllEnvs();
    const diagnostics = new PostHogAnalyticsDiagnosticsProvider({ apiKey: "ph_secret" });

    const health = await diagnostics.getHealth();

    expect(health.status).toBe("unhealthy");
    expect(health.details).toEqual(
      expect.objectContaining({
        hasApiKey: true,
        hasHost: false,
        hostSource: "missing",
        configValidation: "invalid",
        liveCheck: "not_started",
        problemCode: "integrations-posthog/missing-config",
      }),
    );
    expect(JSON.stringify(health)).not.toContain("ph_secret");
  });

  it.each(["not-a-url", "ftp://posthog.example"])(
    "should reject the same invalid PostHog host as runtime initialization: %s",
    async (host) => {
      vi.unstubAllEnvs();
      const config = { apiKey: "ph_secret", host };
      const diagnostics = new PostHogAnalyticsDiagnosticsProvider(config);

      const health = await diagnostics.getHealth();

      expect(health.status).toBe("unhealthy");
      expect(health.details).toEqual(
        expect.objectContaining({
          hasApiKey: true,
          hasHost: true,
          hostSource: "config",
          configValidation: "invalid",
          liveCheck: "not_started",
          problemCode: "integrations-posthog/missing-config",
        }),
      );
      expect(() => new PostHogClient(config)).toThrow(health.message);
      expect(JSON.stringify(health)).not.toContain("ph_secret");
    },
  );

  it.each(["http://posthog.example", "https://posthog.example"])(
    "should accept the same valid PostHog host as runtime initialization: %s",
    async (host) => {
      vi.unstubAllEnvs();
      const config = { apiKey: "ph_secret", host };
      const diagnostics = new PostHogAnalyticsDiagnosticsProvider(config);

      const health = await diagnostics.getHealth();

      expect(health.status).toBe("healthy");
      expect(health.details).toEqual(
        expect.objectContaining({
          hasApiKey: true,
          hasHost: true,
          hostSource: "config",
          configValidation: "valid",
          liveCheck: "not_configured",
        }),
      );
      expect(() => new PostHogClient(config)).not.toThrow();
      expect(JSON.stringify(health)).not.toContain("ph_secret");
    },
  );

  it("should validate an environment PostHog host without exposing configuration values", async () => {
    vi.stubEnv("POSTHOG_HOST", "invalid-env-host");
    const diagnostics = new PostHogAnalyticsDiagnosticsProvider({ apiKey: "ph_secret" });

    const health = await diagnostics.getHealth();

    expect(health.status).toBe("unhealthy");
    expect(health.details).toEqual(
      expect.objectContaining({
        hasApiKey: true,
        hasHost: true,
        hostSource: "env",
        configValidation: "invalid",
        liveCheck: "not_started",
      }),
    );
    expect(JSON.stringify(health)).not.toContain("ph_secret");
    expect(JSON.stringify(health)).not.toContain("invalid-env-host");
  });

  it("should accept a valid environment PostHog host consistently with runtime initialization", async () => {
    vi.stubEnv("POSTHOG_HOST", "https://env.posthog.example");
    const config = { apiKey: "ph_secret" };
    const diagnostics = new PostHogAnalyticsDiagnosticsProvider(config);

    const health = await diagnostics.getHealth();

    expect(health.status).toBe("healthy");
    expect(health.details).toEqual(
      expect.objectContaining({
        hasApiKey: true,
        hasHost: true,
        hostSource: "env",
        configValidation: "valid",
        liveCheck: "not_configured",
      }),
    );
    expect(() => new PostHogClient(config)).not.toThrow();
    expect(JSON.stringify(health)).not.toContain("ph_secret");
    expect(JSON.stringify(health)).not.toContain("https://env.posthog.example");
  });

  it("should report disabled diagnostics without requiring credentials", async () => {
    vi.unstubAllEnvs();
    const diagnostics = new PostHogAnalyticsDiagnosticsProvider(
      {},
      {
        enabled: false,
      },
    );

    const health = await diagnostics.getHealth();

    expect(health.status).toBe("degraded");
    expect(health.details).toEqual(
      expect.objectContaining({
        enabled: false,
        hasApiKey: false,
        hasHost: false,
        configValidation: "skipped",
        liveCheck: "disabled",
      }),
    );
  });

  it("should sanitize readiness details and avoid exposing PostHog API keys", async () => {
    const readinessCheck = vi.fn().mockResolvedValue({
      message: "ready",
      details: {
        authorization: "Bearer secret",
        nested: {
          apiKey: "ph_secret",
          region: "eu",
        },
      },
    });
    const diagnostics = new PostHogAnalyticsDiagnosticsProvider(
      {
        apiKey: "ph_secret",
        host: "https://eu.posthog.com",
      },
      {
        readinessCheck,
      },
    );

    const health = await diagnostics.getHealth();

    expect(health.status).toBe("healthy");
    expect(health.details).toEqual(
      expect.objectContaining({
        hasApiKey: true,
        hasHost: true,
        liveCheck: "passed",
        readiness: {
          authorization: "[redacted]",
          nested: {
            apiKey: "[redacted]",
            region: "eu",
          },
        },
      }),
    );
    expect(JSON.stringify(health)).not.toContain("ph_secret");
    expect(readinessCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          apiKey: "ph_secret",
          host: "https://eu.posthog.com",
        },
      }),
    );
  });

  it("should report provider readiness failures as degraded Problem evidence", async () => {
    const readinessError = Object.assign(new Error("upstream unavailable"), {
      code: "ECONNRESET",
      status: 503,
    });
    const diagnostics = new PostHogAnalyticsDiagnosticsProvider(
      {
        apiKey: "ph_secret",
        host: "https://eu.posthog.com",
      },
      {
        readinessCheck: async () => {
          throw readinessError;
        },
      },
    );

    const health = await diagnostics.getHealth();

    expect(health.status).toBe("degraded");
    expect(health.details).toEqual(
      expect.objectContaining({
        liveCheck: "failed",
        problemCode: "analytics-posthog/readiness-failed",
        upstreamCode: "ECONNRESET",
        upstreamStatus: 503,
      }),
    );
    expect(JSON.stringify(health)).not.toContain("ph_secret");
  });

  it("should preserve zero upstream status in readiness failure evidence", async () => {
    const readinessError = Object.assign(new Error("upstream status unavailable"), {
      code: "UNKNOWN",
      status: 0,
    });
    const diagnostics = new PostHogAnalyticsDiagnosticsProvider(
      {
        apiKey: "ph_secret",
        host: "https://eu.posthog.com",
      },
      {
        readinessCheck: async () => {
          throw readinessError;
        },
      },
    );

    const health = await diagnostics.getHealth();

    expect(health.details).toEqual(
      expect.objectContaining({
        problemCode: "analytics-posthog/readiness-failed",
        upstreamCode: "UNKNOWN",
        upstreamStatus: 0,
      }),
    );
  });
});

function createUninspectableRejection(): object {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("provider metadata getter failed");
      },
      getPrototypeOf() {
        throw new Error("provider prototype inspection failed");
      },
    },
  );
}
