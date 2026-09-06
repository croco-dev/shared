import { createHmac } from "node:crypto";
import "reflect-metadata";
import { InMemoryIdempotencyStore } from "@croco/idempotency-core";
import { ProblemCategory } from "@croco/problems-core";
import { createAuthProviderConformanceSuite } from "@croco/testing";
import { describe, expect, it, vi } from "vitest";
import { BetterAuthDiagnosticsProvider } from "../libs/BetterAuthDiagnosticsProvider";
import type { BetterAuthFactory } from "../libs/BetterAuthFactory";
import { BetterAuthProvider } from "../libs/BetterAuthProvider";
import { BetterAuthWebhookProcessor } from "../libs/BetterAuthWebhookProcessor";
import type { BetterAuthSessionProvider, BetterAuthWebhookHandler } from "../libs/types";

const TEST_SIGNING_SECRET = "test-secret";
const SECRET_SAMPLE = "super-secret-token";
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

function createMockBetterAuthFactory(session: unknown, error?: unknown): BetterAuthFactory {
  return {
    getAuth: () => ({
      api: {
        getSession: vi
          .fn<(args: { headers: Headers }) => Promise<unknown>>()
          .mockImplementation(async () => {
            if (error) {
              throw error;
            }
            return session;
          }),
      },
    }),
  } as unknown as BetterAuthFactory;
}

function createProvider(session: unknown, error?: unknown): BetterAuthProvider {
  return new BetterAuthProvider(createMockBetterAuthFactory(session, error), {
    trustedMetadataKeys: ["privateMetadata"],
  });
}

function createRequest(token?: string): Request {
  return new Request("http://localhost", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function createMockSessionProvider(): BetterAuthSessionProvider {
  return {
    getSession: vi.fn().mockResolvedValue(null),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    revokeUserSessions: vi.fn().mockResolvedValue(undefined),
  };
}

function createSignature(body: string, secret = TEST_SIGNING_SECRET): string {
  const digest = createHmac("sha256", secret).update(normalizeWebhookBody(body)).digest("hex");
  return `sha256=${digest}`;
}

function createWebhookRequest(
  body: string,
  signature?: string,
): { headers: Headers; text: () => Promise<string> } {
  return {
    headers: new Headers(signature ? { "x-better-auth-signature": signature } : {}),
    text: () => Promise.resolve(normalizeWebhookBody(body)),
  };
}

function createWebhookProcessor(handlers: BetterAuthWebhookHandler): BetterAuthWebhookProcessor {
  return new BetterAuthWebhookProcessor(
    {
      signingSecret: TEST_SIGNING_SECRET,
      idempotencyStore: new InMemoryIdempotencyStore(),
    },
    handlers,
    createMockSessionProvider(),
  );
}

function isBetterAuthLiveSmokeEnabled(): boolean {
  return (
    process.env.BETTER_AUTH_LIVE_SMOKE === "1" &&
    Boolean(process.env.BETTER_AUTH_LIVE_SESSION_URL) &&
    Boolean(process.env.BETTER_AUTH_LIVE_SESSION_TOKEN)
  );
}

describe("Better Auth conformance", () => {
  const expectedUser = {
    id: "user_123",
    email: "user@example.com",
    roles: ["admin"],
    permissions: ["tenant:read"],
    metadata: {
      image: undefined,
      emailVerified: true,
      orgId: "org_123",
      tenantId: "tenant_123",
    },
  };
  const validSession = {
    user: {
      id: "user_123",
      email: "user@example.com",
      emailVerified: true,
      privateMetadata: {
        roles: ["admin"],
        permissions: ["tenant:read"],
        orgId: "org_123",
        tenantId: "tenant_123",
      },
    },
  };
  const suite = createAuthProviderConformanceSuite({
    providerName: "auth-better-auth",
    secretSamples: [SECRET_SAMPLE],
    auth: {
      expectedUser,
      authenticateValid: () => createProvider(validSession).authenticate(createRequest("valid")),
      authenticateMissingCredentials: () => createProvider(null).authenticate(createRequest()),
      invalidCredentials: {
        allowNull: true,
        run: () => createProvider(null).authenticate(createRequest("invalid")),
      },
      malformedPayload: {
        code: "auth-better-auth/invalid-session-payload",
        category: ProblemCategory.InternalServerError,
        run: () => createProvider({ user: null }).authenticate(createRequest("malformed")),
      },
      upstreamFailure: {
        code: "auth-better-auth/authentication-failed",
        category: ProblemCategory.InternalServerError,
        retryable: true,
        run: () =>
          createProvider(null, {
            status: 503,
            message: `upstream timeout token=${SECRET_SAMPLE}`,
          }).authenticate(createRequest("upstream-failure")),
      },
    },
    webhooks: {
      processValid: async () => {
        const handler = vi.fn().mockResolvedValue(undefined);
        const body = JSON.stringify({
          type: "session.revoked",
          data: { id: "session_123" },
        });
        const processor = createWebhookProcessor({
          "session.revoked": handler,
        });

        await processor.processWebhook(createWebhookRequest(body, createSignature(body)));

        expect(handler).toHaveBeenCalledWith({ id: "session_123" });
      },
      invalidSignature: {
        code: "auth-better-auth/invalid-webhook-signature",
        category: ProblemCategory.Unauthorized,
        run: () =>
          createWebhookProcessor({}).processWebhook(
            createWebhookRequest(JSON.stringify({ type: "session.revoked" }), "invalid"),
          ),
      },
      invalidPayload: {
        code: "auth-better-auth/invalid-webhook-payload",
        category: ProblemCategory.BadRequest,
        run: () => {
          const body = JSON.stringify({ data: {} });
          return createWebhookProcessor({}).processWebhook(
            createWebhookRequest(body, createSignature(body)),
          );
        },
      },
    },
    readiness: {
      requiredEnv: ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET"],
      createMissingConfigHealth: () =>
        new BetterAuthDiagnosticsProvider({
          baseURL: "",
          secret: "",
          webhookSecret: SECRET_SAMPLE,
          databaseConfigured: false,
        }).getHealth(),
      createReadyHealth: () =>
        new BetterAuthDiagnosticsProvider({
          baseURL: "https://auth.example.com",
          secret: SECRET_SAMPLE,
          webhookSecret: SECRET_SAMPLE,
          databaseConfigured: true,
        }).getHealth(),
    },
    tenantMapping: {
      createEvidence: async () => {
        const user = await createProvider(validSession).authenticate(createRequest("valid"));

        return {
          externalOrgId: "org_123",
          expectedTenantId: "tenant_123",
          resolvedTenantId:
            typeof user?.metadata?.tenantId === "string" ? user.metadata.tenantId : null,
          userMetadata: user?.metadata,
          expectedUserMetadata: {
            orgId: "org_123",
            tenantId: "tenant_123",
          },
        };
      },
    },
    liveSmoke: {
      requiredEnv: [
        "BETTER_AUTH_LIVE_SMOKE",
        "BETTER_AUTH_LIVE_SESSION_URL",
        "BETTER_AUTH_LIVE_SESSION_TOKEN",
      ],
      isEnabled: isBetterAuthLiveSmokeEnabled,
      run: async () => {
        const url = process.env.BETTER_AUTH_LIVE_SESSION_URL;
        const token = process.env.BETTER_AUTH_LIVE_SESSION_TOKEN;
        if (!url || !token) {
          throw new Error("Better Auth live smoke is enabled without URL and token.");
        }

        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          throw new Error(`Better Auth live smoke failed with HTTP ${response.status}.`);
        }
      },
    },
  });

  it.each(suite.cases)("$name", async ({ run }) => {
    await run();
  });

  it("redacts readiness check diagnostics", async () => {
    const health = await new BetterAuthDiagnosticsProvider(
      {
        baseURL: "https://auth.example.com",
        secret: SECRET_SAMPLE,
        webhookSecret: SECRET_SAMPLE,
        databaseConfigured: true,
      },
      {
        readinessCheck: async () => ({
          message: `ready ${SECRET_SAMPLE}`,
          details: {
            cookie: "session=unlisted-cookie",
            privateKey: "raw-private-key",
            rawValue: SECRET_SAMPLE,
            nested: { safe: `ready ${SECRET_SAMPLE}` },
          },
        }),
      },
    ).getHealth();

    expect(health.status).toBe("healthy");
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain(SECRET_SAMPLE);
    expect(serialized).not.toContain("raw-private-key");
    expect(serialized).not.toContain("unlisted-cookie");
    expect(health.message).toBe("ready [redacted]");
  });

  it("redacts readiness check failures", async () => {
    const health = await new BetterAuthDiagnosticsProvider(
      {
        baseURL: "https://auth.example.com",
        secret: SECRET_SAMPLE,
        webhookSecret: SECRET_SAMPLE,
        databaseConfigured: true,
      },
      {
        readinessCheck: async () => {
          throw Object.assign(new Error(`upstream timeout ${SECRET_SAMPLE}`), {
            status: 503,
          });
        },
      },
    ).getHealth();

    expect(health.status).toBe("degraded");
    expect(JSON.stringify(health)).not.toContain(SECRET_SAMPLE);
    expect(health.details).toMatchObject({
      problemCode: "auth-better-auth/authentication-failed",
      problemStatus: 500,
    });
  });
});
