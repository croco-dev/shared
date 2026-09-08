import "reflect-metadata";
import { RbacEngine } from "@croco/auth-core";
import type { AuthProvider } from "@croco/auth-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BetterAuthFactory } from "../libs/BetterAuthFactory";
import { BetterAuthProvider } from "../libs/BetterAuthProvider";
import { BetterAuthAuthenticationProblem } from "../libs/problems/BetterAuthAuthenticationProblem";
import { BetterAuthInvalidSessionProblem } from "../libs/problems/BetterAuthInvalidSessionProblem";

function createMockBetterAuthFactory(session: Record<string, unknown> | null): BetterAuthFactory {
  return {
    getAuth: () => ({
      api: {
        getSession: vi
          .fn<(args: { headers: Headers }) => Promise<Record<string, unknown> | null>>()
          .mockResolvedValue(session),
      },
    }),
  } as unknown as BetterAuthFactory;
}

function createMockRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost", { headers });
}

describe("BetterAuthProvider", () => {
  let provider!: BetterAuthProvider;
  let mockFactory!: BetterAuthFactory;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("authenticate", () => {
    it("should return AuthUser when session exists", async () => {
      const mockSession = {
        user: {
          id: "user-123",
          email: "user@example.com",
          name: "John Doe",
          image: "https://example.com/avatar.jpg",
          emailVerified: true,
        },
        session: {
          id: "session-456",
          expiresAt: new Date(Date.now() + 3600000),
          token: "session-token-abc",
        },
      };

      mockFactory = createMockBetterAuthFactory(mockSession);
      provider = new BetterAuthProvider(mockFactory);

      const request = createMockRequest({
        authorization: "Bearer session-token-abc",
      });

      const result = await provider.authenticate(request);

      expect(result).not.toBeNull();
      expect(result).toEqual({
        id: "user-123",
        email: "user@example.com",
        roles: [],
        permissions: [],
        metadata: {
          image: "https://example.com/avatar.jpg",
          emailVerified: true,
        },
      });
    });

    it("should return null when session does not exist", async () => {
      mockFactory = createMockBetterAuthFactory(null);
      provider = new BetterAuthProvider(mockFactory);

      const request = createMockRequest();

      const result = await provider.authenticate(request);

      expect(result).toBeNull();
    });

    it("should handle session with minimal user data", async () => {
      const mockSession = {
        user: {
          id: "user-minimal",
          email: "minimal@example.com",
          emailVerified: false,
        },
      };

      mockFactory = createMockBetterAuthFactory(mockSession);
      provider = new BetterAuthProvider(mockFactory);

      const request = createMockRequest();

      const result = await provider.authenticate(request);

      expect(result).toEqual({
        id: "user-minimal",
        email: "minimal@example.com",
        roles: [],
        permissions: [],
        metadata: {
          image: undefined,
          emailVerified: false,
        },
      });
    });

    it("should pass request headers to getSession API", async () => {
      const mockSession = {
        user: {
          id: "user-456",
          email: "test@example.com",
          emailVerified: true,
        },
      };

      const getSessionSpy = vi
        .fn<(args: { headers: Headers }) => Promise<Record<string, unknown> | null>>()
        .mockResolvedValue(mockSession);
      const mockAuth = {
        api: {
          getSession: getSessionSpy,
        },
      };

      const factoryWithSpy = {
        getAuth: () => mockAuth,
      } as unknown as BetterAuthFactory;

      provider = new BetterAuthProvider(factoryWithSpy);

      const customHeaders = {
        authorization: "Bearer custom-token",
        "user-agent": "TestAgent/1.0",
        "x-forwarded-for": "192.168.1.1",
      };
      const request = createMockRequest(customHeaders);

      await provider.authenticate(request);

      expect(getSessionSpy).toHaveBeenCalledWith({
        headers: request.headers,
      });

      const capturedHeaders = getSessionSpy.mock.calls[0][0].headers;
      expect(capturedHeaders.get("authorization")).toBe("Bearer custom-token");
      expect(capturedHeaders.get("user-agent")).toBe("TestAgent/1.0");
      expect(capturedHeaders.get("x-forwarded-for")).toBe("192.168.1.1");
    });

    it("should handle user with image but no emailVerified flag", async () => {
      const mockSession = {
        user: {
          id: "user-789",
          email: "image@example.com",
          image: "https://example.com/no-verified.jpg",
        },
      };

      mockFactory = createMockBetterAuthFactory(mockSession);
      provider = new BetterAuthProvider(mockFactory);

      const request = createMockRequest();

      const result = await provider.authenticate(request);

      expect(result).toEqual({
        id: "user-789",
        email: "image@example.com",
        roles: [],
        permissions: [],
        metadata: {
          image: "https://example.com/no-verified.jpg",
          emailVerified: undefined,
        },
      });
    });

    it("should initialize with empty roles and permissions arrays", async () => {
      const mockSession = {
        user: {
          id: "user-roles",
          email: "roles@example.com",
          emailVerified: true,
        },
      };

      mockFactory = createMockBetterAuthFactory(mockSession);
      provider = new BetterAuthProvider(mockFactory);

      const request = createMockRequest();
      const result = await provider.authenticate(request);

      expect(result?.roles).toEqual([]);
      expect(result?.permissions).toEqual([]);
      expect(Array.isArray(result?.roles)).toBe(true);
      expect(Array.isArray(result?.permissions)).toBe(true);
    });

    it("should preserve roles and permissions from user fields", async () => {
      const mockSession = {
        user: {
          id: "user-rbac",
          email: "rbac@example.com",
          roles: ["admin", "member"],
          permissions: ["project:read", "project:write"],
        },
      };

      mockFactory = createMockBetterAuthFactory(mockSession);
      provider = new BetterAuthProvider(mockFactory, {
        trustedUserFields: ["roles", "permissions"],
      });

      const result = await provider.authenticate(createMockRequest());

      expect(result?.roles).toEqual(["admin", "member"]);
      expect(result?.permissions).toEqual(["project:read", "project:write"]);
    });

    it.each(["metadata", "userMetadata", "publicMetadata", "privateMetadata", "rbac"])(
      "should ignore untrusted %s claims and emit a redacted warning",
      async (source) => {
        const claims = {
          roles: ["injected-admin"],
          role: "injected-owner",
          permissions: ["injected:*"],
          permission: "injected:write",
          tenantId: "injected-tenant",
          tenant_id: "injected-tenant-alias",
          orgId: "injected-org",
          org_id: "injected-org-alias",
          organizationId: "injected-organization",
          organization_id: "injected-organization-alias",
        };
        provider = new BetterAuthProvider(
          createMockBetterAuthFactory({
            user: { id: "secret-user-id", email: "secret@example.test", [source]: claims },
          }),
        );

        const result = await provider.authenticate(createMockRequest());

        expect(result?.roles).toEqual([]);
        expect(result?.permissions).toEqual([]);
        expect(result).not.toHaveProperty("tenantId");
        expect(result?.metadata).not.toHaveProperty("tenantId");
        expect(result?.metadata).not.toHaveProperty("orgId");
        expect(console.warn).toHaveBeenCalledOnce();
        expect(console.warn).toHaveBeenCalledWith(
          "Ignoring untrusted Better Auth authorization claims",
          { code: "auth-better-auth/untrusted-claims", claims: Object.keys(claims) },
        );
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/injected|secret/);
      },
    );

    it("should deny admin authorization for a session with injected public claims", async () => {
      provider = new BetterAuthProvider(
        createMockBetterAuthFactory({
          user: {
            id: "user-123",
            publicMetadata: { roles: ["admin"], permissions: ["tenant:manage"] },
          },
        }),
      );
      const user = await provider.authenticate(createMockRequest());
      expect(user).not.toBeNull();
      const rbac = new RbacEngine({
        getRolePermissions: (role) => (role === "admin" ? ["tenant:manage"] : []),
      });
      if (!user) throw new Error("Expected an authenticated user");
      expect(rbac.hasRole(user, "admin")).toBe(false);
      expect(rbac.hasPermission(user, "tenant:manage")).toBe(false);
    });

    it("should trust only the admin plugin role at the top level by default", async () => {
      provider = new BetterAuthProvider(
        createMockBetterAuthFactory({
          user: {
            id: "user-123",
            role: "member",
            roles: ["admin"],
            permissions: ["*"],
            tenantId: "other-tenant",
            orgId: "other-org",
          },
        }),
      );
      const result = await provider.authenticate(createMockRequest());
      expect(result?.roles).toEqual(["member"]);
      expect(result?.permissions).toEqual([]);
      expect(result).not.toHaveProperty("tenantId");
      expect(result?.metadata).not.toHaveProperty("tenantId");
      expect(result?.metadata).not.toHaveProperty("orgId");
      expect(console.warn).toHaveBeenCalledOnce();
    });

    it("should use explicit server metadata with alias, filtering, and precedence rules", async () => {
      const warn = vi.fn();
      provider = new BetterAuthProvider(
        createMockBetterAuthFactory({
          user: {
            id: "user-123",
            role: "member",
            tenant_id: "direct-tenant",
            privateMetadata: {
              roles: ["member", "owner", 123],
              permission: "read",
              tenant_id: "private-tenant",
              organization_id: "private-org",
            },
            serverClaims: { roles: ["other-owner"], permissions: ["write", "write", false] },
            publicMetadata: { roles: ["injected-admin"], tenantId: "injected-tenant" },
          },
        }),
        {
          trustedMetadataKeys: ["privateMetadata", "serverClaims"],
          trustedUserFields: ["tenant_id"],
          logger: { warn },
        },
      );
      const result = await provider.authenticate(createMockRequest());
      expect(result?.roles).toEqual(["member", "owner"]);
      expect(result?.permissions).toEqual(["write", "read"]);
      expect(result?.tenantId).toBe("direct-tenant");
      expect(result?.metadata).toMatchObject({ tenantId: "direct-tenant", orgId: "private-org" });
      expect(warn).toHaveBeenCalledOnce();
      expect(console.warn).not.toHaveBeenCalled();
    });

    it.each([
      [{ tenantId: "tenant-1" }, "tenant-1"],
      [{ tenant_id: "tenant-1" }, "tenant-1"],
      [{ orgId: "org-1" }, "org-1"],
      [{ org_id: "org-1" }, "org-1"],
      [{ organizationId: "org-1" }, "org-1"],
      [{ organization_id: "org-1" }, "org-1"],
      [{ tenantId: "tenant-1", orgId: "org-1" }, "tenant-1"],
      [{ tenant_id: "tenant-1", orgId: "org-1" }, "tenant-1"],
      [{ tenantId: "", orgId: "org-1" }, ""],
      [{ tenantId: 42, orgId: "org-1" }, "org-1"],
      [{ tenantId: null, orgId: 42 }, undefined],
      [{}, undefined],
    ])("should expose trusted tenant claims %j as AuthUser.tenantId", async (claims, tenantId) => {
      provider = new BetterAuthProvider(
        createMockBetterAuthFactory({ user: { id: "user-123", serverClaims: claims } }),
        { trustedMetadataKeys: ["serverClaims"] },
      );

      const result = await provider.authenticate(createMockRequest());

      expect(result?.tenantId).toBe(tenantId);
      if (tenantId === undefined) {
        expect(result).not.toHaveProperty("tenantId");
      }
      if (!("tenantId" in claims) && !("tenant_id" in claims)) {
        expect(result?.metadata).not.toHaveProperty("tenantId");
      }
    });

    it("should snapshot trust options and ignore inherited claims and sources", async () => {
      const trustedMetadataKeys = ["privateMetadata", "serverClaims"];
      const trustedUserFields: ["tenantId"] = ["tenantId"];
      const user = Object.assign(
        Object.create({ role: "admin", privateMetadata: { permissions: ["*"] } }),
        {
          id: "user-123",
          publicMetadata: { roles: ["admin"] },
          serverClaims: Object.create({ role: "admin" }),
        },
      );
      provider = new BetterAuthProvider(createMockBetterAuthFactory({ user }), {
        trustedMetadataKeys,
        trustedUserFields,
      });
      trustedMetadataKeys.push("publicMetadata");
      const result = await provider.authenticate(createMockRequest());
      expect(result?.roles).toEqual([]);
      expect(result?.permissions).toEqual([]);
      expect(result).not.toHaveProperty("tenantId");
      expect(result?.metadata).not.toHaveProperty("tenantId");
    });

    it.each([null, "admin", [], 42])(
      "should ignore malformed trusted metadata %j",
      async (privateMetadata) => {
        provider = new BetterAuthProvider(
          createMockBetterAuthFactory({ user: { id: "user-123", privateMetadata } }),
          {
            trustedMetadataKeys: ["privateMetadata"],
          },
        );
        const result = await provider.authenticate(createMockRequest());
        expect(result?.roles).toEqual([]);
        expect(result?.permissions).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
      },
    );

    it("should keep empty or malformed trusted values from falling through to untrusted claims", async () => {
      provider = new BetterAuthProvider(
        createMockBetterAuthFactory({
          user: {
            id: "user-123",
            privateMetadata: { roles: [], permissions: null, tenantId: 42 },
            publicMetadata: { roles: ["admin"], permissions: ["*"], tenantId: "other-tenant" },
          },
        }),
        { trustedMetadataKeys: ["privateMetadata"] },
      );
      const result = await provider.authenticate(createMockRequest());
      expect(result?.roles).toEqual([]);
      expect(result?.permissions).toEqual([]);
      expect(result).not.toHaveProperty("tenantId");
      expect(result?.metadata).not.toHaveProperty("tenantId");
      expect(console.warn).toHaveBeenCalledOnce();
    });

    it("should implement AuthProvider interface", () => {
      mockFactory = createMockBetterAuthFactory(null);
      provider = new BetterAuthProvider(mockFactory);

      expect(provider).toHaveProperty("authenticate");
      expect(typeof provider.authenticate).toBe("function");

      const providerAsInterface: AuthProvider<Request> = provider;
      expect(providerAsInterface.authenticate).not.toBeUndefined();
    });

    it("should map unexpected API errors to a stable Problem", async () => {
      const mockError = new Error("Network error");
      const errorFactory = {
        getAuth: () => ({
          api: {
            getSession: vi
              .fn<(args: { headers: Headers }) => Promise<Record<string, unknown> | null>>()
              .mockRejectedValue(mockError),
          },
        }),
      } as unknown as BetterAuthFactory;

      provider = new BetterAuthProvider(errorFactory);

      const request = createMockRequest();

      await expect(provider.authenticate(request)).rejects.toBeInstanceOf(
        BetterAuthAuthenticationProblem,
      );
    });

    it("should return null for rejected invalid session lookups", async () => {
      const errorFactory = {
        getAuth: () => ({
          api: {
            getSession: vi
              .fn<(args: { headers: Headers }) => Promise<Record<string, unknown> | null>>()
              .mockRejectedValue({ statusCode: 401 }),
          },
        }),
      } as unknown as BetterAuthFactory;

      provider = new BetterAuthProvider(errorFactory);

      await expect(provider.authenticate(createMockRequest())).resolves.toBeNull();
    });

    it("should map retryable rejected session lookups to a stable Problem", async () => {
      const errorFactory = {
        getAuth: () => ({
          api: {
            getSession: vi
              .fn<(args: { headers: Headers }) => Promise<Record<string, unknown> | null>>()
              .mockRejectedValue({ statusCode: 429, message: "rate limit" }),
          },
        }),
      } as unknown as BetterAuthFactory;

      provider = new BetterAuthProvider(errorFactory);

      await expect(provider.authenticate(createMockRequest())).rejects.toBeInstanceOf(
        BetterAuthAuthenticationProblem,
      );
    });

    it("should handle malformed session response", async () => {
      const malformedSession = {
        user: null,
      };

      mockFactory = createMockBetterAuthFactory(malformedSession);
      provider = new BetterAuthProvider(mockFactory);

      const request = createMockRequest();

      await expect(provider.authenticate(request)).rejects.toBeInstanceOf(
        BetterAuthInvalidSessionProblem,
      );
      await expect(provider.authenticate(request)).rejects.toThrow(
        "Better Auth session did not include a valid user payload",
      );
    });
  });

  describe("constructor", () => {
    it("should accept BetterAuthFactory dependency", () => {
      mockFactory = createMockBetterAuthFactory(null);

      expect(() => new BetterAuthProvider(mockFactory)).not.toThrow();
    });

    it("should store factory reference", () => {
      mockFactory = createMockBetterAuthFactory(null);
      provider = new BetterAuthProvider(mockFactory);

      const providerWithFactory = provider as unknown as { factory: BetterAuthFactory };
      expect(providerWithFactory.factory).toBe(mockFactory);
    });
  });

  describe("integration scenarios", () => {
    it("should handle typical login flow", async () => {
      const mockSession = {
        user: {
          id: "user-login",
          email: "newuser@example.com",
          name: "New User",
          emailVerified: true,
        },
      };

      mockFactory = createMockBetterAuthFactory(mockSession);
      provider = new BetterAuthProvider(mockFactory);

      const loginRequest = createMockRequest({
        authorization: "Bearer login-session-token",
      });

      const authUser = await provider.authenticate(loginRequest);

      expect(authUser?.id).toBe("user-login");
      expect(authUser?.email).toBe("newuser@example.com");
    });

    it("should handle logout scenario (no session)", async () => {
      mockFactory = createMockBetterAuthFactory(null);
      provider = new BetterAuthProvider(mockFactory);

      const logoutRequest = createMockRequest();

      const result = await provider.authenticate(logoutRequest);

      expect(result).toBeNull();
    });
  });

  describe("metadata mapping", () => {
    it("should map emailVerified to metadata", async () => {
      const mockSession = {
        user: {
          id: "user-meta",
          email: "meta@example.com",
          emailVerified: true,
          image: "https://example.com/avatar.png",
        },
      };

      mockFactory = createMockBetterAuthFactory(mockSession);
      provider = new BetterAuthProvider(mockFactory);

      const request = createMockRequest();
      const result = await provider.authenticate(request);

      expect(result?.metadata).not.toBeUndefined();
      expect(result?.metadata?.emailVerified).toBe(true);
      expect(result?.metadata?.image).toBe("https://example.com/avatar.png");
    });

    it("should handle missing optional fields", async () => {
      const mockSession = {
        user: {
          id: "user-partial",
          email: "partial@example.com",
        },
      };

      mockFactory = createMockBetterAuthFactory(mockSession);
      provider = new BetterAuthProvider(mockFactory);

      const request = createMockRequest();
      const result = await provider.authenticate(request);

      expect(result?.metadata).not.toBeUndefined();
      expect(result?.metadata?.image).toBeUndefined();
      expect(result?.metadata?.emailVerified).toBeUndefined();
    });
  });
});
