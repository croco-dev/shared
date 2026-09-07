import { Container } from "typedi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckoutResult } from "@croco/billing-core";
import { EntitlementManager } from "@croco/entitlements-core";
import { EventPublisher } from "@croco/events-core";
import { Container as CrocoContainer, LOGGER_TOKEN } from "@croco/framework-context";
import type { ILogger } from "@croco/framework-context";
import { ApplicationRuntime } from "@croco/framework-module";
import { InMemoryIdempotencyStore } from "@croco/idempotency-core";
import { DuplicateRecordProblem, IdempotencyManager } from "@croco/metering-core";
import type { PendingMeteringDelivery } from "@croco/metering-core";
import type {
  LambdaContext,
  LambdaEvent,
  MiddlewareFunction,
  NodeServerHandle,
} from "@croco/transports-http";
import { TelemetryRuntime } from "@croco/telemetry-sdk-node";
import { createCrocoApp } from "../app";
import { JobsController } from "../controllers/JobsController";
import { assertDemoEndpointsEnabled, SaasController } from "../controllers/SaasController";
import { saasDemoSnapshotSchema } from "../controllers/schemas";
import { renderDemoMemberHtml } from "../html";
import { generatedSaasProviderProfileManifest } from "../generatedSaasProviderProfile";
import { InMemoryRedisClient } from "../inMemoryAdapters";
import {
  ApplicationBootstrapProblem,
  DemoEndpointDisabledProblem,
  SaasProviderProfileMismatchProblem,
  SaasProviderProfileRuntimeUnavailableProblem,
} from "../problems";
import {
  getSaasProviderProfile,
  isSaasDemoEndpointEnabled,
  SAAS_DEMO_ENDPOINTS_ENABLED_ENV,
} from "../providerProfiles";
import {
  assertSaasDemoSnapshot,
  createSaasRuntime,
  createSaasDemoRuntime,
  DemoBillingGateway,
  defaultSaasRuntime,
  runSaasCampaignSmoke,
  runSaasDemoFlow,
  SAAS_RUNTIME_STATE_TOKEN,
  SaasRuntimeState,
  seedDefaultSaasRuntime,
} from "../saasDemo";

const executableProfileTest = generatedSaasProviderProfileManifest.composition.executable
  ? it
  : (_name: string, _test: () => void | Promise<void>): void => {};

describe("SaaS golden path demo", () => {
  beforeEach(() => {
    Container.reset();
    CrocoContainer.reset();
  });

  it("reports generated execution status and rejects documentation-only bootstraps", async () => {
    const executable = generatedSaasProviderProfileManifest.composition.executable;

    expect(getSaasProviderProfile()).toMatchObject({
      status: executable ? "executable" : "documentation-only",
    });

    if (!executable) {
      await expect(createCrocoApp({ profileMode: "zero-credential" })).rejects.toThrow(
        "CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE",
      );
    }
  });

  it("models provider profile selection failures as Problems", () => {
    const requestedProfile = `${getSaasProviderProfile().name}-mismatch`;

    expect(() => getSaasProviderProfile(requestedProfile)).toThrow(
      SaasProviderProfileMismatchProblem,
    );
    expect(new SaasProviderProfileRuntimeUnavailableProblem("saas-cloudflare")).toMatchObject({
      code: "CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE",
      message: "CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE: saas-cloudflare",
    });
  });

  it("deduplicates concurrent membership event relay calls", async () => {
    let releasePublication!: () => void;
    const publicationBlocked = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publishNow = vi
      .spyOn(EventPublisher.prototype, "publishNow")
      .mockImplementation(() => publicationBlocked);
    try {
      const runtime = createSaasDemoRuntime();
      await runtime.membershipStore.execute({
        operation: "add",
        idempotencyKey: "member:add:concurrent-relay",
        membershipId: "membership-concurrent-relay",
        tenantId: "tenant-concurrent-relay",
        userId: "user-concurrent-relay",
        role: "member",
        maxSeats: null,
      });

      const firstRelay = runtime.membershipManager.publishPendingEvents();
      const secondRelay = runtime.membershipManager.publishPendingEvents();
      await vi.waitFor(() => expect(publishNow).toHaveBeenCalledTimes(1));
      releasePublication();

      await expect(Promise.all([firstRelay, secondRelay])).resolves.toEqual([1, 1]);
    } finally {
      releasePublication();
      publishNow.mockRestore();
    }
  });

  it("replays pending metering delivery state without changing its operation identity", async () => {
    const manager = new IdempotencyManager(new InMemoryRedisClient());
    const firstClaim = await manager.claimMeteringProcessingOrThrow(
      "tenant-1",
      "api_requests",
      "request-1",
    );
    const delivery: PendingMeteringDelivery = {
      usageRecord: {
        id: firstClaim.operationId,
        tenantId: "tenant-1",
        meterId: "api_requests",
        value: 1,
        timestamp: new Date().toISOString(),
        idempotencyKey: "request-1",
      },
    };

    await manager.markMeteringEventsPublishing(
      "tenant-1",
      "api_requests",
      "request-1",
      firstClaim.token,
      delivery,
    );
    await manager.releaseMeteringEvents("tenant-1", "api_requests", "request-1", firstClaim.token);

    const replayClaim = await manager.claimMeteringProcessingOrThrow(
      "tenant-1",
      "api_requests",
      "request-1",
    );
    expect(replayClaim.operationId).toBe(firstClaim.operationId);
    expect(replayClaim.delivery).toEqual(delivery);

    await manager.completeMeteringProcessing(
      "tenant-1",
      "api_requests",
      "request-1",
      replayClaim.token,
    );
    const duplicateClaim = manager.claimMeteringProcessingOrThrow(
      "tenant-1",
      "api_requests",
      "request-1",
    );
    await expect(duplicateClaim).rejects.toThrow(DuplicateRecordProblem);
    await expect(duplicateClaim).rejects.toMatchObject({ code: "metering/duplicate-record" });
  });

  it("keeps demo checkout sessions distinct and shareable across runtimes", async () => {
    const billingGateway = new DemoBillingGateway();
    const checkoutIdempotencyStore = new InMemoryIdempotencyStore<CheckoutResult>();
    const firstRuntime = createSaasRuntime({ billingGateway, checkoutIdempotencyStore });
    const secondRuntime = createSaasRuntime({ billingGateway, checkoutIdempotencyStore });
    const baseParams = {
      billingAccountId: "tenant-1",
      email: "owner@example.com",
      productId: "team",
      successUrl: "https://example.com/success",
    };

    const first = await billingGateway.createCheckout({
      ...baseParams,
      idempotencyKey: "checkout-operation-1",
    });
    const replay = await billingGateway.createCheckout({
      ...baseParams,
      idempotencyKey: "checkout-operation-1",
    });
    const distinct = await billingGateway.createCheckout({
      ...baseParams,
      idempotencyKey: "checkout-operation-2",
    });

    expect(firstRuntime.billingGateway).toBe(billingGateway);
    expect(secondRuntime.billingGateway).toBe(billingGateway);
    expect(replay).toEqual(first);
    expect(distinct.checkoutId).not.toBe(first.checkoutId);
    expect(distinct.checkoutUrl).not.toBe(first.checkoutUrl);
  });

  executableProfileTest(
    "boots the explicit zero-credential profile without unrelated global DI diagnostics",
    async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      let app: Awaited<ReturnType<typeof createCrocoApp>> | undefined;
      process.env.NODE_ENV = "production";

      try {
        app = await createCrocoApp({ profileMode: "zero-credential" });
        const response = await app.fetch(new Request("http://localhost/health"));

        expect(response.status).toBe(200);
        expect(app.describeBootstrapValidationPolicy()).toEqual({
          di: "warn",
          security: "enforce",
        });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        await app?.disposeApplicationRuntime();
        if (previousNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = previousNodeEnv;
        }
        warn.mockRestore();
      }
    },
  );

  executableProfileTest(
    "keeps telemetry unavailable in zero-credential mode when the environment enables it",
    async () => {
      const previousTelemetryEnabled = process.env.TELEMETRY_ENABLED;
      let app: Awaited<ReturnType<typeof createCrocoApp>> | undefined;

      try {
        await TelemetryRuntime.reset();
        process.env.TELEMETRY_ENABLED = "true";
        app = await createCrocoApp({ profileMode: "zero-credential" });

        expect(TelemetryRuntime.getInstance().getConfig()).toMatchObject({
          enabled: false,
          trace: { enabled: false },
        });
        expect(TelemetryRuntime.getInstance().isInitialized()).toBe(false);
      } finally {
        await app?.disposeApplicationRuntime();
        await TelemetryRuntime.reset();
        if (previousTelemetryEnabled === undefined) {
          delete process.env.TELEMETRY_ENABLED;
        } else {
          process.env.TELEMETRY_ENABLED = previousTelemetryEnabled;
        }
      }
    },
  );

  executableProfileTest(
    "closes the Node listener before disposing the application runtime",
    async () => {
      const app = await createCrocoApp({ profileMode: "zero-credential" });
      const server = await app.listen(0);

      expect(server.listening).toBe(true);

      await app.disposeApplicationRuntime();

      expect(server.listening).toBe(false);
      expect(() => app.applicationRuntime.run(() => undefined)).toThrow(/already been disposed/);
    },
  );

  executableProfileTest("leaves signal ownership to an explicit Node host", async () => {
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");
    const app = await createCrocoApp({ profileMode: "zero-credential", hostPlatform: "node" });

    try {
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    } finally {
      await app.disposeApplicationRuntime();
    }
  });

  executableProfileTest(
    "preserves bootstrap failure when runtime disposal also rejects",
    async () => {
      const bootstrapFailure = new Error("provider initialization failed");
      const cleanupFailure = new Error("provider shutdown failed");
      const initialize = vi
        .spyOn(ApplicationRuntime.prototype, "initialize")
        .mockRejectedValue(bootstrapFailure);
      const dispose = vi
        .spyOn(ApplicationRuntime.prototype, "dispose")
        .mockRejectedValue(cleanupFailure);

      try {
        const failure = await createCrocoApp({
          profileMode: "zero-credential",
          hostPlatform: "node",
        }).catch((cause: unknown) => cause);

        expect(failure).toBeInstanceOf(ApplicationBootstrapProblem);
        expect(failure).toMatchObject({
          cause: bootstrapFailure,
          extensions: {
            bootstrapFailure: "Error: provider initialization failed",
            cleanupFailures: [
              {
                phase: "application-runtime-dispose",
                detail: "Error: provider shutdown failed",
              },
            ],
          },
        });
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        const runtime = initialize.mock.contexts[0] as ApplicationRuntime | undefined;
        initialize.mockRestore();
        dispose.mockRestore();
        await runtime?.dispose();
      }
    },
  );

  executableProfileTest("does not overwrite a caller-provided global logger", async () => {
    const logger: ILogger = {
      child: () => logger,
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    CrocoContainer.set(LOGGER_TOKEN, logger);

    const app = await createCrocoApp({ profileMode: "zero-credential" });

    expect(CrocoContainer.get(LOGGER_TOKEN)).toBe(logger);
    await app.disposeApplicationRuntime();
  });

  executableProfileTest("owns bootstrap providers in distinct application runtimes", async () => {
    const first = await createCrocoApp({ profileMode: "zero-credential" });
    const second = await createCrocoApp({ profileMode: "zero-credential" });

    expect(first.applicationRuntime.scopeId).not.toBe(second.applicationRuntime.scopeId);
    expect(first.applicationRuntime.get(LOGGER_TOKEN)).not.toBe(
      second.applicationRuntime.get(LOGGER_TOKEN),
    );
    expect(first.applicationRuntime.get(EntitlementManager)).not.toBe(
      second.applicationRuntime.get(EntitlementManager),
    );
    expect(CrocoContainer.has(LOGGER_TOKEN)).toBe(false);

    await Promise.all([first.disposeApplicationRuntime(), second.disposeApplicationRuntime()]);
  });

  executableProfileTest(
    "runs exported host callbacks inside their owning application runtime",
    async () => {
      const firstScopes: string[] = [];
      const secondScopes: string[] = [];
      const first = await createCrocoApp({
        profileMode: "zero-credential",
        additionalMiddlewares: [captureActiveScope(firstScopes)],
      });
      const second = await createCrocoApp({
        profileMode: "zero-credential",
        additionalMiddlewares: [captureActiveScope(secondScopes)],
      });
      let firstServer: NodeServerHandle | undefined;
      let secondServer: NodeServerHandle | undefined;

      try {
        const firstNodeHandler = first.nodeHandler();
        const secondNodeHandler = second.nodeHandler();
        await Promise.all([
          firstNodeHandler(new Request("http://localhost/ops/health")),
          secondNodeHandler(new Request("http://localhost/ops/health")),
        ]);

        const firstLambdaHandler = first.lambdaHandler();
        const secondLambdaHandler = second.lambdaHandler();
        await Promise.all([
          firstLambdaHandler(createLambdaEvent(), createLambdaContext("first")),
          secondLambdaHandler(createLambdaEvent(), createLambdaContext("second")),
        ]);

        const firstHono = first.getHono();
        const secondHono = second.getHono();
        await Promise.all([
          firstHono.fetch(new Request("http://localhost/ops/health")),
          secondHono.fetch(new Request("http://localhost/ops/health")),
        ]);

        [firstServer, secondServer] = await Promise.all([first.listen(0), second.listen(0)]);
        await Promise.all([waitForListening(firstServer), waitForListening(secondServer)]);
        await Promise.all([
          fetch(`${getServerUrl(firstServer)}/ops/health`),
          fetch(`${getServerUrl(secondServer)}/ops/health`),
        ]);

        expect(firstScopes).toEqual(Array(4).fill(first.applicationRuntime.scopeId));
        expect(secondScopes).toEqual(Array(4).fill(second.applicationRuntime.scopeId));
        expect(first.applicationRuntime.scopeId).not.toBe(second.applicationRuntime.scopeId);
      } finally {
        await Promise.all([
          firstServer ? closeServer(firstServer) : Promise.resolve(),
          secondServer ? closeServer(secondServer) : Promise.resolve(),
        ]);
        await Promise.all([first.disposeApplicationRuntime(), second.disposeApplicationRuntime()]);
      }
    },
  );

  it("creates tenant and owner membership", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());

    expect(snapshot.tenant.slug).toBe("acme");
    expect(snapshot.tenant.status).toBe("trial");
    expect(snapshot.membership.ownerRole).toBe("owner");
    expect(snapshot.contract).toEqual({
      version: "saas-smoke-contract/v1",
      providerProfile: generatedSaasProviderProfileManifest.profile.name,
    });
  });

  it("creates invitation and member membership", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());

    expect(snapshot.invitation.status).toBe("accepted");
    expect(snapshot.invitation.invitedUserId).toBe("user_member");
    expect(snapshot.membership.memberRole).toBe("member");
    expect(snapshot.membership.memberCount).toBe(2);
  });

  it("freezes and broadcasts the generated SaaS member campaign without credentials", async () => {
    const runtime = createSaasDemoRuntime();
    const demo = await runSaasDemoFlow(runtime);
    const campaign = await runSaasCampaignSmoke(runtime, demo.tenant.id);

    expect(campaign.snapshot).toMatchObject({
      id: "saas-campaign-snapshot-1",
      state: "complete",
      memberCount: 2,
      campaignId: "saas.member-welcome",
      messageId: "saas.member-welcome",
    });
    expect(campaign.execution.status).toBe("completed");
    expect(campaign.progress).toEqual({
      total: 2,
      completed: 2,
      queued: 2,
      suppressed: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
    });
  });

  it("escapes untrusted member values before rendering campaign HTML", () => {
    expect(renderDemoMemberHtml(`<img src=x onerror="alert('member')">`, "owner & admin")).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(&#39;member&#39;)&quot;&gt; joined as owner &amp; admin.</p>",
    );
  });

  it("enforces membership seats from entitlement quota", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());

    expect(snapshot.membership.seatLimit).toMatchObject({
      quota: 2,
      usage: 3,
      exceeded: true,
      remaining: 0,
      failureCode: "SEAT_LIMIT_EXCEEDED",
      rejectedUserId: "user_over_limit",
    });
  });

  it("allows configured permission for invited member", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());

    expect(snapshot.auth).toEqual({
      userId: "user_member",
      sessionId: "session_demo_member",
      roles: ["member"],
      permission: "tenant:read",
      allowed: true,
    });
    expect(snapshot.access.allowed).toBe(true);
  });

  it("records usage for tenant", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());

    expect(snapshot.metering).toMatchObject({
      meterId: "api_requests",
      recordedValue: 3,
      currentUsage: 3,
    });
  });

  it("records AI usage and blocks over-quota LLM usage", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());

    expect(snapshot.ai).toMatchObject({
      provider: "in-memory",
      modelId: "demo-assistant",
      responseText: "Usage is under control.",
      promptQuota: 50,
      quotaFailureCode: "llm-metering/quota-exceeded",
    });
    expect(snapshot.ai.promptUsage).toBe(snapshot.ai.promptTokens);
    expect(snapshot.ai.totalTokens).toBe(snapshot.ai.promptTokens + snapshot.ai.completionTokens);
    expect(snapshot.ai.costUsd).toBeGreaterThan(0);
  });

  it("returns entitlement status after usage is recorded", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());

    expect(snapshot.entitlement).toMatchObject({
      featureKey: "api.requests",
      granted: true,
      quota: 2,
      usage: 3,
      remaining: 0,
      planId: "team",
      planVersionRef: "team@v1",
      overagePolicy: "ALLOW_WITH_OVERAGE",
    });
    expect(snapshot.billing.entitlementPlanId).toBe("team");
    expect(snapshot.billing.mockEvent).toMatchObject({
      eventId: "billing.subscription_activated:tenant_acme:team",
      eventType: "billing.subscription_activated",
      externalSubscriptionId: "external_subscription_tenant_acme",
      planVersionRef: "team@v1",
      processedStatus: "completed",
      duplicateFailureCode: "billing/webhook-already-processed",
    });
  });

  it("commits billable API usage locally and converges after a retryable provider outage", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());

    expect(snapshot.billableUsage).toMatchObject({
      planVersionRef: "team@v1",
      journalDurability: "persistent",
      included: {
        eventId: "usage:tenant_acme:api_requests:included:v1",
        value: 2,
        recordOutcome: "recorded",
        deliveryOutcome: "accepted",
        delivery: { accepted: 1, retryableFailed: 0, terminalFailed: 0 },
      },
      overage: {
        eventId: "usage:tenant_acme:api_requests:overage:v1",
        value: 1,
        recordOutcome: "recorded",
        initialDeliveryOutcome: "retryable-failed",
        finalDeliveryOutcome: "accepted",
      },
      providerOutage: {
        delivery: { accepted: 0, retryableFailed: 1, terminalFailed: 0 },
        failureCode: "billing-polar/retryable-upstream",
        backlogCount: 1,
        oldestPendingAgeMs: 1000,
      },
      recovery: {
        command: "pnpm --dir apps/api-server demo:usage-recover",
        processBoundary: "separate-node-process",
        delivery: { accepted: 1, retryableFailed: 0, terminalFailed: 0 },
      },
      replay: {
        eventId: "usage:tenant_acme:api_requests:overage:v1",
        outcome: "duplicate",
        providerAcceptedUsageBefore: 3,
        providerAcceptedUsageAfter: 3,
      },
      providerAcceptedUsage: 3,
      finalConvergence: {
        backlogCount: 0,
        oldestPendingAgeMs: null,
        retryCount: 1,
        terminalFailureCount: 0,
        converged: true,
      },
    });
  });

  it("seeds dashboard-ready normal and over-quota usage states", async () => {
    const runtime = createSaasDemoRuntime();
    const snapshot = await runSaasDemoFlow(runtime);

    const meters = await runtime.meterRegistry.getByTenant(snapshot.tenant.id);
    const storageUsage = await runtime.meteringService.getUsage({
      tenantId: snapshot.tenant.id,
      meterId: "storage_gb",
      period: "billing_cycle",
    });
    const storageEntitlement = await runtime.entitlementManager.check(
      snapshot.tenant.id,
      "storage.gb",
    );

    expect(meters.map((meter) => meter.meterId).sort()).toEqual([
      "api_requests",
      "llm.completion_tokens",
      "llm.cost_usd_nanos",
      "llm.prompt_tokens",
      "storage_gb",
    ]);
    expect(meters.find((meter) => meter.meterId === "api_requests")?.metadata).toMatchObject({
      featureKey: "api.requests",
      unit: "request",
    });
    expect(meters.find((meter) => meter.meterId === "api_requests")).toMatchObject({
      billing: "required",
      aggregation: "COUNT",
      unit: "request",
      quota: 2,
      allowOverQuota: true,
    });
    expect(meters.find((meter) => meter.meterId === "storage_gb")?.metadata).toMatchObject({
      featureKey: "storage.gb",
      unit: "GB",
    });
    expect(meters.find((meter) => meter.meterId === "llm.prompt_tokens")?.metadata).toMatchObject({
      provider: "in-memory",
      unit: "token",
    });
    expect(
      meters.find((meter) => meter.meterId === "llm.completion_tokens")?.metadata,
    ).toMatchObject({
      provider: "in-memory",
      unit: "token",
    });
    expect(meters.find((meter) => meter.meterId === "llm.cost_usd_nanos")?.metadata).toMatchObject({
      provider: "in-memory",
      unit: "usd_nanos",
    });
    expect(storageUsage).toBe(105);
    expect(storageEntitlement).toMatchObject({
      featureKey: "storage.gb",
      granted: true,
      quota: 100,
      usage: 105,
      remaining: 0,
      exceeded: true,
      overagePolicy: "WARN",
    });
  });

  it("exposes health and diagnostics endpoints", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());

    expect(snapshot.operations).toEqual({
      healthStatus: "up",
      diagnosticsSummary: "all_healthy",
    });
    expect(() => assertSaasDemoSnapshot(snapshot)).not.toThrow();
  });

  it("keeps lifecycle evidence in the demo response contract", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());
    const parsed = saasDemoSnapshotSchema.parse(snapshot);

    expect(parsed.lifecycle).toMatchObject({
      ruleId: "saas-risk-onboarding-follow-up",
      firstRunStatus: "succeeded",
      duplicateRunStatus: "skipped",
      duplicateSkipReason: "idempotency_key_reused",
      emittedActionType: "cs.follow_up",
      emittedActionCount: 1,
    });
  });

  executableProfileTest("derives the executable runtime profile from generated metadata", () => {
    expect(getSaasProviderProfile("saas-node-postgres")).toMatchObject({
      status: "executable",
      commands: expect.arrayContaining(["pnpm demo:smoke"]),
      packages: expect.arrayContaining([
        "@croco/auth-better-auth",
        "@croco/billing-polar",
        "@croco/tasks-qstash",
        "@croco/tx-drizzle",
      ]),
      env: expect.arrayContaining([
        SAAS_DEMO_ENDPOINTS_ENABLED_ENV,
        "DATABASE_URL",
        "POLAR_WEBHOOK_SECRET",
        "CLOUDINARY_URL",
      ]),
    });
    const mismatchedProfile = `${getSaasProviderProfile().name}-mismatch`;
    expect(() => getSaasProviderProfile(mismatchedProfile)).toThrow(
      SaasProviderProfileMismatchProblem,
    );
  });

  it("keeps demo endpoints closed unless explicitly enabled outside production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env[SAAS_DEMO_ENDPOINTS_ENABLED_ENV];

    try {
      delete process.env[SAAS_DEMO_ENDPOINTS_ENABLED_ENV];
      process.env.NODE_ENV = "development";
      expect(isSaasDemoEndpointEnabled()).toBe(false);
      await expect(assertDemoEndpointsEnabled()).rejects.toBeInstanceOf(
        DemoEndpointDisabledProblem,
      );

      process.env[SAAS_DEMO_ENDPOINTS_ENABLED_ENV] = "true";
      expect(isSaasDemoEndpointEnabled()).toBe(true);
      await expect(assertDemoEndpointsEnabled()).resolves.toBeUndefined();

      process.env.NODE_ENV = "production";
      expect(isSaasDemoEndpointEnabled()).toBe(false);
      await expect(assertDemoEndpointsEnabled()).rejects.toBeInstanceOf(
        DemoEndpointDisabledProblem,
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }

      if (previousFlag === undefined) {
        delete process.env[SAAS_DEMO_ENDPOINTS_ENABLED_ENV];
      } else {
        process.env[SAAS_DEMO_ENDPOINTS_ENABLED_ENV] = previousFlag;
      }
    }
  });

  it("resets the shared demo runtime before endpoint seeding", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env[SAAS_DEMO_ENDPOINTS_ENABLED_ENV];

    try {
      process.env.NODE_ENV = "development";
      process.env[SAAS_DEMO_ENDPOINTS_ENABLED_ENV] = "true";

      CrocoContainer.set(
        SAAS_RUNTIME_STATE_TOKEN,
        new SaasRuntimeState({ create: createSaasDemoRuntime }),
      );
      const controller = new SaasController();
      const first = await controller.seedDemo();
      const second = await controller.seedDemo();

      expect(first.tenant.id).toBe("tenant_acme");
      expect(second.tenant.id).toBe("tenant_acme");
      expect(second.billing.mockEvent.duplicateFailureCode).toBe(
        "billing/webhook-already-processed",
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }

      if (previousFlag === undefined) {
        delete process.env[SAAS_DEMO_ENDPOINTS_ENABLED_ENV];
      } else {
        process.env[SAAS_DEMO_ENDPOINTS_ENABLED_ENV] = previousFlag;
      }
    }
  });

  it("runs an inspectable billing sync background job", async () => {
    const snapshot = await runSaasDemoFlow(createSaasDemoRuntime());

    expect(snapshot.jobs).toMatchObject({
      type: "billing-sync",
      status: "completed",
      failurePolicyState: "succeeded",
      logCount: 2,
    });
  });

  it("exposes the billing sync job through operations controller", async () => {
    const seeded = await seedDefaultSaasRuntime();
    CrocoContainer.set(
      SAAS_RUNTIME_STATE_TOKEN,
      new SaasRuntimeState({
        create: createSaasDemoRuntime,
        initial: defaultSaasRuntime,
      }),
    );
    const controller = new JobsController();

    const listReport = (await controller.list(undefined, "billing-sync")) as {
      summary: string;
      total: number;
      jobs: readonly { id: string; failurePolicy: { state: string } }[];
    };

    expect(listReport).toMatchObject({
      summary: "healthy",
      total: 1,
      jobs: [
        {
          id: seeded.jobs.id,
          failurePolicy: { state: "succeeded" },
        },
      ],
    });

    const logs = await controller.logs(seeded.jobs.id);

    expect(logs.map((entry) => entry.message)).toEqual([
      "Billing sync started",
      "Billing subscription active",
    ]);
  });
});

function captureActiveScope(scopes: string[]): MiddlewareFunction {
  return async (_context, next) => {
    scopes.push(CrocoContainer.getActiveScopeId() ?? "missing");
    return next();
  };
}

function createLambdaEvent(): LambdaEvent {
  return {
    version: "2.0",
    routeKey: "GET /ops/health",
    rawPath: "/ops/health",
    rawQueryString: "",
    headers: {},
    requestContext: {
      accountId: "123456789012",
      apiId: "api-123",
      domainName: "example.execute-api.ap-northeast-2.amazonaws.com",
      domainPrefix: "example",
      http: {
        method: "GET",
        path: "/ops/health",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "api-request-123",
      routeKey: "GET /ops/health",
      stage: "$default",
      time: "30/Aug/2026:00:00:00 +0000",
      timeEpoch: 1_788_048_000_000,
    },
    isBase64Encoded: false,
  };
}

function createLambdaContext(requestId: string): LambdaContext {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: "runtime-scope-test",
    functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:ap-northeast-2:123456789012:function:runtime-scope-test",
    memoryLimitInMB: "128",
    awsRequestId: requestId,
    logGroupName: "/aws/lambda/runtime-scope-test",
    logStreamName: "2026/08/30/[$LATEST]abcdef",
    getRemainingTimeInMillis: () => 5_000,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
  };
}

async function waitForListening(server: NodeServerHandle): Promise<void> {
  if (server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function getServerUrl(server: NodeServerHandle): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Generated API server did not expose a TCP address.");
  }

  const hostname = address.address === "::" ? "[::1]" : address.address;
  return `http://${hostname}:${address.port}`;
}

async function closeServer(server: NodeServerHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
