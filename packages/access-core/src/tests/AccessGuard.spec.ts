import "reflect-metadata";
import { Context } from "@croco/framework-context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEngine } from "../libs/AccessEngine";
import { Access } from "../libs/decorators/Access";
import { AccessGuard, BadRequestProblem, ForbiddenProblem } from "../libs/guards/AccessGuard";
import type { AccessExecutionContext } from "../libs/interfaces/Guard";
import { createPolicyDecisionTrace } from "../libs/PolicyDecisionTrace";

describe("AccessGuard", () => {
  let accessGuard!: AccessGuard;
  let mockAccessEngine!: AccessEngine;

  const mockUser = { id: "user-1", name: "Test User" };
  const mockTenantId = "tenant-1";

  const createMockContext = (
    target: object,
    handlerName: string,
    user?: unknown,
    tenantId?: string,
    params?: Record<string, string>,
  ): AccessExecutionContext => {
    const request = {
      headers: new Headers(),
      user,
      tenantId,
      params,
    } as unknown as Request;

    return {
      getRequest: () => request,
      getClass: () => target,
      getHandler: () => handlerName,
      getPath: () => "/test",
      getMethod: () => "GET",
    } as AccessExecutionContext;
  };

  const createMockContextWithHttp = (
    target: object,
    handlerName: string,
    options: {
      user?: unknown;
      tenantId?: string;
      params?: Record<string, string>;
      rawParams?: Record<string, string>;
      ctxTenantId?: string;
    } = {},
  ): AccessExecutionContext => {
    const request = {
      headers: new Headers(),
      user: options.user,
      tenantId: options.tenantId,
      params: options.params,
    } as unknown as Request;

    const httpContext = {
      req: {
        params: options.rawParams ?? {},
      },
      param: (name: string) => options.rawParams?.[name],
      get: <T>(key: string) => {
        if (key === "tenantId") {
          return options.ctxTenantId as T;
        }
        return undefined;
      },
    };

    return {
      getRequest: () => request,
      getClass: () => target,
      getHandler: () => handlerName,
      getPath: () => "/test",
      getMethod: () => "GET",
      getHttpContext: () => httpContext,
    } as AccessExecutionContext;
  };

  beforeEach(() => {
    mockAccessEngine = {
      check: vi.fn(),
      grant: vi.fn(),
      revoke: vi.fn(),
      list: vi.fn(),
    } as unknown as AccessEngine;

    accessGuard = new AccessGuard(mockAccessEngine);
  });

  it("should return true when no @Access metadata is present", async () => {
    class TestController {
      publicMethod() {}
    }
    const context = createMockContext(TestController, "publicMethod", mockUser, mockTenantId);

    const result = await accessGuard.canActivate(context);
    expect(result).toBe(true);
    expect(mockAccessEngine.check).not.toHaveBeenCalled();
  });

  it("should throw BadRequestProblem when objectId is missing in params", async () => {
    class TestController {
      @Access("document", "editor")
      protectedMethod() {}
    }
    const context = createMockContext(
      TestController,
      "protectedMethod",
      mockUser,
      mockTenantId,
      {},
    );

    await expect(accessGuard.canActivate(context)).rejects.toThrow(BadRequestProblem);
    await expect(accessGuard.canActivate(context)).rejects.toThrow("Object ID missing");
  });

  it("should throw ForbiddenProblem when access check fails", async () => {
    class TestController {
      @Access("document", "editor")
      protectedMethod() {}
    }
    const context = createMockContext(TestController, "protectedMethod", mockUser, mockTenantId, {
      id: "doc-1",
    });

    vi.spyOn(mockAccessEngine, "check").mockResolvedValue({ decision: "deny", allowed: false });

    const result = accessGuard.canActivate(context);

    await expect(result).rejects.toThrow(ForbiddenProblem);
    await expect(result).rejects.toMatchObject({
      code: "access-core/forbidden",
    });
    expect(mockAccessEngine.check).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: mockTenantId,
        subject: `user:${mockUser.id}`,
        relation: "editor",
        object: "document:doc-1",
        ruleId: "access:document:editor",
      }),
    );
  });

  it("should treat abstain as not allowed", async () => {
    class TestController {
      @Access("document", "editor")
      protectedMethod() {}
    }
    const context = createMockContext(TestController, "protectedMethod", mockUser, mockTenantId, {
      id: "doc-1",
    });

    vi.spyOn(mockAccessEngine, "check").mockResolvedValue({
      decision: "abstain",
      allowed: false,
      reason: "Policy could not decide",
    });

    await expect(accessGuard.canActivate(context)).rejects.toThrow(ForbiddenProblem);
  });

  it("should include the decision id when access check fails", async () => {
    class TestController {
      @Access("document", "editor")
      protectedMethod() {}
    }
    const context = createMockContext(TestController, "protectedMethod", mockUser, mockTenantId, {
      id: "doc-1",
    });
    const trace = createPolicyDecisionTrace({
      policyKind: "access",
      result: "deny",
      ruleId: "access:document:editor",
      subjectRef: `user:${mockUser.id}`,
      resourceRef: "document:doc-1",
      tenantId: mockTenantId,
    });

    vi.spyOn(mockAccessEngine, "check").mockResolvedValue({
      decision: "deny",
      allowed: false,
      trace,
    });

    await expect(accessGuard.canActivate(context)).rejects.toMatchObject({
      extensions: {
        decisionId: trace.decisionId,
      },
    });
  });

  it("should return true when access check passes", async () => {
    class TestController {
      @Access("document", "editor")
      protectedMethod() {}
    }
    const context = createMockContext(TestController, "protectedMethod", mockUser, mockTenantId, {
      id: "doc-1",
    });

    vi.spyOn(mockAccessEngine, "check").mockResolvedValue({ decision: "allow", allowed: true });

    const result = await accessGuard.canActivate(context);
    expect(result).toBe(true);
    expect(mockAccessEngine.check).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: mockTenantId,
        subject: `user:${mockUser.id}`,
        relation: "editor",
        object: "document:doc-1",
        ruleId: "access:document:editor",
      }),
    );
  });

  it("should extract objectId from params.{objectType}Id pattern", async () => {
    class TestController {
      @Access("document", "viewer")
      protectedMethod() {}
    }
    const context = createMockContext(TestController, "protectedMethod", mockUser, mockTenantId, {
      documentId: "doc-123",
    });

    vi.spyOn(mockAccessEngine, "check").mockResolvedValue({ decision: "allow", allowed: true });

    const result = await accessGuard.canActivate(context);
    expect(result).toBe(true);
    expect(mockAccessEngine.check).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: mockTenantId,
        subject: `user:${mockUser.id}`,
        relation: "viewer",
        object: "document:doc-123",
        ruleId: "access:document:viewer",
      }),
    );
  });

  it("should prioritize params.id over params.{objectType}Id", async () => {
    class TestController {
      @Access("document", "viewer")
      protectedMethod() {}
    }
    const context = createMockContext(TestController, "protectedMethod", mockUser, mockTenantId, {
      id: "doc-from-id",
      documentId: "doc-from-documentId",
    });

    vi.spyOn(mockAccessEngine, "check").mockResolvedValue({ decision: "allow", allowed: true });

    const result = await accessGuard.canActivate(context);
    expect(result).toBe(true);
    expect(mockAccessEngine.check).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: mockTenantId,
        subject: `user:${mockUser.id}`,
        relation: "viewer",
        object: "document:doc-from-id",
        ruleId: "access:document:viewer",
      }),
    );
  });

  it("should throw when AccessEngine.check throws an error", async () => {
    class TestController {
      @Access("folder", "owner")
      protectedMethod() {}
    }
    const context = createMockContext(TestController, "protectedMethod", mockUser, mockTenantId, {
      id: "folder-1",
    });

    vi.spyOn(mockAccessEngine, "check").mockRejectedValue(new Error("Database error"));

    await expect(accessGuard.canActivate(context)).rejects.toThrow();
  });

  it("should resolve objectId from http context params when request.params is missing", async () => {
    class TestController {
      @Access("document", "viewer")
      protectedMethod() {}
    }

    const context = createMockContextWithHttp(TestController, "protectedMethod", {
      user: mockUser,
      tenantId: mockTenantId,
      rawParams: { id: "doc-from-http" },
    });

    vi.spyOn(mockAccessEngine, "check").mockResolvedValue({ decision: "allow", allowed: true });

    const result = await accessGuard.canActivate(context);
    expect(result).toBe(true);
    expect(mockAccessEngine.check).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: mockTenantId,
        subject: `user:${mockUser.id}`,
        relation: "viewer",
        object: "document:doc-from-http",
        ruleId: "access:document:viewer",
      }),
    );
  });

  it("should resolve tenantId from http context store when missing on request", async () => {
    class TestController {
      @Access("document", "viewer")
      protectedMethod() {}
    }

    const context = createMockContextWithHttp(TestController, "protectedMethod", {
      user: mockUser,
      rawParams: { id: "doc-ctx-tenant" },
      ctxTenantId: "tenant-from-context",
    });

    vi.spyOn(mockAccessEngine, "check").mockResolvedValue({ decision: "allow", allowed: true });

    const result = await accessGuard.canActivate(context);
    expect(result).toBe(true);
    expect(mockAccessEngine.check).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-from-context",
        subject: `user:${mockUser.id}`,
        relation: "viewer",
        object: "document:doc-ctx-tenant",
        ruleId: "access:document:viewer",
      }),
    );
  });

  it("should resolve tenantId from request context fallback when request and http context lack tenantId", async () => {
    class TestController {
      @Access("document", "viewer")
      protectedMethod() {}
    }

    const context = createMockContextWithHttp(TestController, "protectedMethod", {
      user: mockUser,
      rawParams: { id: "doc-context-fallback" },
    });

    vi.spyOn(mockAccessEngine, "check").mockResolvedValue({ decision: "allow", allowed: true });

    await Context.run({ requestId: "req-1", tenantId: "tenant-from-request-context" }, async () => {
      const result = await accessGuard.canActivate(context);
      expect(result).toBe(true);
    });

    expect(mockAccessEngine.check).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-from-request-context",
        subject: `user:${mockUser.id}`,
        relation: "viewer",
        object: "document:doc-context-fallback",
        ruleId: "access:document:viewer",
      }),
    );
  });

  it("should throw BadRequestProblem when tenantId cannot be resolved", async () => {
    class TestController {
      @Access("document", "viewer")
      protectedMethod() {}
    }

    const context = createMockContextWithHttp(TestController, "protectedMethod", {
      user: mockUser,
      rawParams: { id: "doc-1" },
    });

    await expect(accessGuard.canActivate(context)).rejects.toThrow(BadRequestProblem);
    await expect(accessGuard.canActivate(context)).rejects.toThrow("Tenant ID missing");
    expect(mockAccessEngine.check).not.toHaveBeenCalled();
  });

  it("should return 401 when authenticated user is missing", async () => {
    class TestController {
      @Access("document", "viewer")
      protectedMethod() {}
    }

    const context = createMockContextWithHttp(TestController, "protectedMethod", {
      tenantId: mockTenantId,
      rawParams: { id: "doc-1" },
    });

    await expect(accessGuard.canActivate(context)).rejects.toMatchObject({
      code: "access-core/unauthorized",
      status: 401,
      detail: "Authenticated user missing",
    });
    expect(mockAccessEngine.check).not.toHaveBeenCalled();
  });
  it.each([undefined, null, { id: 42 }])(
    "should reject invalid request user %j with 401",
    async (user) => {
      class TestController {
        @Access("document", "viewer")
        protectedMethod() {}
      }
      const context = createMockContext(TestController, "protectedMethod", user, mockTenantId, {
        id: "doc-1",
      });
      await expect(accessGuard.canActivate(context)).rejects.toMatchObject({
        code: "access-core/unauthorized",
        status: 401,
      });
      expect(mockAccessEngine.check).not.toHaveBeenCalled();
    },
  );

  it.each([
    { requestUser: undefined, expectedId: "context-user" },
    { requestUser: mockUser, expectedId: mockUser.id },
  ])(
    "should resolve principal $expectedId with an active Context",
    async ({ requestUser, expectedId }) => {
      class TestController {
        @Access("document", "viewer")
        protectedMethod() {}
      }
      const context = createMockContext(
        TestController,
        "protectedMethod",
        requestUser,
        mockTenantId,
        { id: "doc-1" },
      );
      vi.mocked(mockAccessEngine.check).mockResolvedValue({ decision: "allow", allowed: true });
      await Context.run({ requestId: "context-auth", user: { id: "context-user" } }, async () => {
        await expect(accessGuard.canActivate(context)).resolves.toBe(true);
      });
      expect(mockAccessEngine.check).toHaveBeenCalledWith(
        expect.objectContaining({ subject: `user:${expectedId}` }),
      );
    },
  );
});
