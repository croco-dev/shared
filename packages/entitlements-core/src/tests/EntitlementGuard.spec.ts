import { createPolicyDecisionTrace } from "@croco/access-core";
import { Container, Context } from "@croco/framework-context";
import * as telemetry from "@croco/telemetry-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENTITLEMENT_REQUIRED_KEY,
  RequireEntitlement,
} from "../libs/decorators/RequireEntitlement";
import { EntitlementGuard, type RouteExecutionContext } from "../libs/EntitlementGuard";
import type { EntitlementManager } from "../libs/EntitlementManager";
import { EntitlementAuditSink, type EntitlementGuardAuditEvent } from "../libs/interfaces";
import {
  EntitlementDeniedProblem,
  EntitlementMissingPlanProblem,
  EntitlementProviderUnavailableProblem,
  EntitlementQuotaExceededProblem,
} from "../libs/problems/EntitlementProblems";
import type { EntitlementCheckOptions, EntitlementCheckResult } from "../libs/types";

class MockEntitlementManager {
  checkResult: EntitlementCheckResult = {
    granted: true,
    status: "allowed",
    featureKey: "test_feature",
    type: "boolean",
    planId: "pro",
  };
  error: Error | null = null;

  async check(
    _tenantId: string,
    _featureKey: string,
    _options?: EntitlementCheckOptions,
  ): Promise<EntitlementCheckResult> {
    if (this.error) {
      throw this.error;
    }

    return this.checkResult;
  }
}

class MockEntitlementAuditSink extends EntitlementAuditSink {
  readonly events: EntitlementGuardAuditEvent[] = [];

  recordEntitlementGuard(event: EntitlementGuardAuditEvent): void {
    this.events.push(event);
  }
}

class FailingEntitlementAuditSink extends EntitlementAuditSink {
  recordEntitlementGuard(_event: EntitlementGuardAuditEvent): void {
    throw new Error("audit sink unavailable");
  }
}

type RequestWithTenant = RouteExecutionContext["getRequest"] extends () => infer T ? T : never;
type RequestWithOptionalTenantUser = Omit<RequestWithTenant, "user"> & {
  params?: Record<string, string>;
  user?: RequestWithTenant["user"] & { tenantId?: string };
};

function createUser(tenantId: string): RequestWithOptionalTenantUser["user"] {
  return {
    id: "user-1",
    roles: [],
    permissions: [],
    tenantId,
  };
}

function createContext(options: {
  target?: unknown;
  handler?: string | symbol;
  request?: Partial<RequestWithOptionalTenantUser>;
  httpTenantId?: string;
}): RouteExecutionContext {
  return {
    getClass: () => options.target ?? {},
    getHandler: () => options.handler ?? "testMethod",
    getRequest: () => options.request as RequestWithTenant,
    getHttpContext: () => ({
      req: { params: {} },
      param: () => undefined,
      get: <T>(key: string): T | undefined =>
        (key === "tenantId" ? options.httpTenantId : undefined) as T | undefined,
    }),
  };
}

describe("EntitlementGuard", () => {
  let guard!: EntitlementGuard;
  let mockManager!: MockEntitlementManager;
  let auditSink!: MockEntitlementAuditSink;

  beforeEach(() => {
    Container.reset();
    vi.restoreAllMocks();
    mockManager = new MockEntitlementManager();
    auditSink = new MockEntitlementAuditSink();
    Container.set(EntitlementAuditSink.token, auditSink);
    guard = new EntitlementGuard(mockManager as unknown as EntitlementManager);
  });

  it("should pass when no metadata is present", async () => {
    const context = createContext({
      request: {
        tenantId: "tenant-123",
        user: createUser("tenant-123"),
      },
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
  });

  it("should pass when entitlement is granted", async () => {
    class TestController {
      testMethod() {}
    }

    Reflect.defineMetadata(
      ENTITLEMENT_REQUIRED_KEY,
      "test_feature",
      TestController.prototype,
      "testMethod",
    );

    mockManager.checkResult = {
      granted: true,
      status: "allowed",
      featureKey: "test_feature",
      type: "boolean",
      planId: "pro",
    };

    const context = createContext({
      target: TestController,
      request: {
        tenantId: "tenant-123",
        user: createUser("tenant-123"),
      },
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
  });

  it("should read entitlement metadata from static method decorators", async () => {
    class TestController {
      @RequireEntitlement({ feature: "reports.export" })
      static testMethod() {}

      instanceMethod() {}
    }

    const checkSpy = vi.spyOn(mockManager, "check");
    const context = createContext({
      target: TestController,
      request: {
        tenantId: "tenant-123",
        user: createUser("tenant-123"),
      },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(checkSpy).toHaveBeenCalledWith(
      "tenant-123",
      "reports.export",
      expect.objectContaining({
        ruleId: "entitlement:reports.export",
        sourceLocation: expect.objectContaining({
          file: expect.stringContaining("EntitlementGuard.spec.ts"),
        }),
        subjectRef: "user:user-1",
      }),
    );
  });

  it("should throw EntitlementDeniedProblem with decision id when entitlement is denied", async () => {
    class TestController {
      testMethod() {}
    }

    Reflect.defineMetadata(
      ENTITLEMENT_REQUIRED_KEY,
      "test_feature",
      TestController.prototype,
      "testMethod",
    );

    const trace = createPolicyDecisionTrace({
      policyKind: "entitlement",
      result: "deny",
      ruleId: "entitlement:test_feature",
      subjectRef: "user:user-1",
      resourceRef: "entitlement:test_feature",
      tenantId: "tenant-123",
    });
    mockManager.checkResult = {
      granted: false,
      status: "denied",
      featureKey: "test_feature",
      type: "boolean",
      reason: "limit_exceeded",
      trace,
    };

    const context = createContext({
      target: TestController,
      request: {
        tenantId: "tenant-123",
        user: createUser("tenant-123"),
      },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(EntitlementDeniedProblem);
    await expect(guard.canActivate(context)).rejects.toThrow("Entitlement");
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      extensions: {
        decisionId: trace.decisionId,
      },
    });
  });

  it("should throw EntitlementDeniedProblem when tenantId is missing", async () => {
    const recordEventSpy = vi.spyOn(telemetry, "recordEvent").mockImplementation(() => {});

    class TestController {
      testMethod() {}
    }

    Reflect.defineMetadata(
      ENTITLEMENT_REQUIRED_KEY,
      "test_feature",
      TestController.prototype,
      "testMethod",
    );

    const context = createContext({
      target: TestController,
      request: {},
    });

    const activation = guard.canActivate(context);

    await expect(activation).rejects.toThrow(EntitlementDeniedProblem);
    await expect(activation).rejects.toThrow("tenantId not found");
    expect(recordEventSpy).toHaveBeenCalledWith(
      "entitlement.guard.denied",
      expect.objectContaining({
        "entitlement.feature": "test_feature",
        "entitlement.status": "denied",
        "tenant.id": "unknown",
        "route.id": "TestController.testMethod",
        "entitlement.reason": "missing_authenticated_tenant",
        "problem.code": "ENTITLEMENT_DENIED",
      }),
    );
    expect(auditSink.events).toEqual([
      expect.objectContaining({
        type: "entitlement.guard.denied",
        tenantId: "unknown",
        feature: "test_feature",
        status: "denied",
        reason: "missing_authenticated_tenant",
        problemCode: "ENTITLEMENT_DENIED",
        route: {
          controllerName: "TestController",
          handlerName: "testMethod",
          routeId: "TestController.testMethod",
        },
      }),
    ]);
  });

  it("should record denied evidence when resource id is missing", async () => {
    const recordEventSpy = vi.spyOn(telemetry, "recordEvent").mockImplementation(() => {});

    class TestController {
      @RequireEntitlement({
        feature: "reports.export",
        resource: { type: "report", idParam: "reportId" },
      })
      testMethod() {}
    }

    const checkSpy = vi.spyOn(mockManager, "check");
    const context = createContext({
      target: TestController,
      request: {
        tenantId: "tenant-123",
        user: createUser("tenant-123"),
      },
    });

    const activation = guard.canActivate(context);

    await expect(activation).rejects.toThrow(EntitlementDeniedProblem);
    await expect(activation).rejects.toThrow("resource id not found");
    expect(checkSpy).not.toHaveBeenCalled();
    expect(recordEventSpy).toHaveBeenCalledWith(
      "entitlement.guard.denied",
      expect.objectContaining({
        "entitlement.feature": "reports.export",
        "entitlement.status": "denied",
        "tenant.id": "tenant-123",
        "user.id": "user-1",
        "route.id": "TestController.testMethod",
        "entitlement.reason": "missing_resource",
        "problem.code": "ENTITLEMENT_DENIED",
      }),
    );
    expect(auditSink.events).toEqual([
      expect.objectContaining({
        type: "entitlement.guard.denied",
        tenantId: "tenant-123",
        feature: "reports.export",
        status: "denied",
        userId: "user-1",
        reason: "missing_resource",
        problemCode: "ENTITLEMENT_DENIED",
        route: {
          controllerName: "TestController",
          handlerName: "testMethod",
          routeId: "TestController.testMethod",
        },
      }),
    ]);
  });

  it.each(["request", "framework Context"] as const)(
    "should evaluate the %s tenant without a static principal tenant",
    async (source) => {
      class TestController {
        @RequireEntitlement({ feature: "test_feature" })
        testMethod() {}
      }

      const checkSpy = vi.spyOn(mockManager, "check");
      const context = createContext({
        target: TestController,
        request: {
          principal: { type: "apikey", id: "key-1", permissions: [] },
          ...(source === "request" ? { tenantId: "tenant-dynamic" } : {}),
        },
      });

      await Context.run(
        {
          requestId: "request-dynamic",
          ...(source === "framework Context" ? { tenantId: "tenant-dynamic" } : {}),
        },
        () => expect(guard.canActivate(context)).resolves.toBe(true),
      );
      expect(checkSpy).toHaveBeenCalledExactlyOnceWith(
        "tenant-dynamic",
        "test_feature",
        expect.objectContaining({ ruleId: "entitlement:test_feature" }),
      );
      expect(auditSink.events).toEqual([
        expect.objectContaining({ type: "entitlement.guard.allowed", tenantId: "tenant-dynamic" }),
      ]);
    },
  );

  it("should evaluate organization switches in isolated asynchronous request contexts", async () => {
    class TestController {
      @RequireEntitlement({ feature: "test_feature" })
      testMethod() {}
    }

    const checkSpy = vi.spyOn(mockManager, "check");
    const context = createContext({
      target: TestController,
      request: { user: { id: "user-1", roles: [], permissions: [] } },
    });
    for (const tenants of [
      ["tenant-a", "tenant-b"],
      ["tenant-b", "tenant-a"],
    ]) {
      await Promise.all(
        tenants.map((tenantId) =>
          Context.run({ requestId: tenantId, tenantId }, async () => {
            await Promise.resolve();
            await expect(guard.canActivate(context)).resolves.toBe(true);
          }),
        ),
      );
    }
    expect(checkSpy.mock.calls.map(([tenantId]) => tenantId)).toEqual([
      "tenant-a",
      "tenant-b",
      "tenant-b",
      "tenant-a",
    ]);
    expect(auditSink.events.map(({ tenantId }) => tenantId)).toEqual([
      "tenant-a",
      "tenant-b",
      "tenant-b",
      "tenant-a",
    ]);
    expect(Context.getTenantId()).toBeNull();
  });

  it.each([
    {
      requestTenant: "tenant-b",
      frameworkTenant: "tenant-a",
      httpTenant: undefined,
      source: "request",
    },
    {
      requestTenant: "tenant-a",
      frameworkTenant: undefined,
      httpTenant: "tenant-b",
      source: "HTTP context",
    },
    {
      requestTenant: undefined,
      frameworkTenant: "tenant-a",
      httpTenant: "tenant-b",
      source: "HTTP context",
    },
  ])(
    "should deny conflicting dynamic tenant sources: $source",
    async ({ requestTenant, frameworkTenant, httpTenant, source }) => {
      class TestController {
        @RequireEntitlement({ feature: "test_feature" })
        testMethod() {}
      }

      const checkSpy = vi.spyOn(mockManager, "check");
      const context = createContext({
        target: TestController,
        request: { tenantId: requestTenant },
        httpTenantId: httpTenant,
      });
      await Context.run({ requestId: "request-conflict", tenantId: frameworkTenant }, () =>
        expect(guard.canActivate(context)).rejects.toThrow(`${source} tenantId conflicts`),
      );
      expect(checkSpy).not.toHaveBeenCalled();
      expect(auditSink.events).toEqual([
        expect.objectContaining({ tenantId: "tenant-a", reason: "tenant_mismatch" }),
      ]);
    },
  );

  it("should reject conflicting principal and user tenants even when dynamic sources agree", async () => {
    class TestController {
      @RequireEntitlement({ feature: "test_feature" })
      testMethod() {}
    }
    const checkSpy = vi.spyOn(mockManager, "check");
    const context = createContext({
      target: TestController,
      request: {
        principal: { type: "apikey", id: "key-1", permissions: [], tenantId: "tenant-a" },
        user: createUser("tenant-b"),
        tenantId: "tenant-a",
      },
    });
    await Context.run({ requestId: "request-conflict", tenantId: "tenant-a" }, () =>
      expect(guard.canActivate(context)).rejects.toThrow(
        "authenticated principal and user tenantId conflicts",
      ),
    );
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, "", 42, {}])(
    "should reject absent or invalid authoritative tenant sources: %j",
    async (tenantId) => {
      class TestController {
        @RequireEntitlement({ feature: "test_feature" })
        testMethod() {}
      }
      const checkSpy = vi.spyOn(mockManager, "check");
      const context = createContext({
        target: TestController,
        request: { tenantId: tenantId as string },
        httpTenantId: "tenant-http-only",
      });
      await Context.run({ requestId: "request-invalid", tenantId: tenantId as string }, () =>
        expect(guard.canActivate(context)).rejects.toThrow("authenticated tenantId not found"),
      );
      expect(checkSpy).not.toHaveBeenCalled();
      expect(auditSink.events).toEqual([
        expect.objectContaining({ reason: "missing_authenticated_tenant" }),
      ]);
    },
  );

  it("should preserve entitlement denials for a dynamically resolved tenant", async () => {
    class TestController {
      @RequireEntitlement({ feature: "test_feature" })
      testMethod() {}
    }
    mockManager.checkResult = {
      granted: false,
      status: "denied",
      featureKey: "test_feature",
      type: "boolean",
      reason: "not_entitled",
    };
    const checkSpy = vi.spyOn(mockManager, "check");
    const context = createContext({
      target: TestController,
      request: { tenantId: "tenant-dynamic" },
    });
    await expect(guard.canActivate(context)).rejects.toThrow(EntitlementDeniedProblem);
    expect(checkSpy).toHaveBeenCalledExactlyOnceWith(
      "tenant-dynamic",
      "test_feature",
      expect.any(Object),
    );
    expect(auditSink.events).toEqual([
      expect.objectContaining({ tenantId: "tenant-dynamic", reason: "not_entitled" }),
    ]);
  });

  it("should deny a request tenant that conflicts with the authenticated user", async () => {
    class TestController {
      testMethod() {}
    }

    Reflect.defineMetadata(
      ENTITLEMENT_REQUIRED_KEY,
      "test_feature",
      TestController.prototype,
      "testMethod",
    );

    const checkSpy = vi.spyOn(mockManager, "check");
    const context = createContext({
      target: TestController,
      request: {
        tenantId: "paid-tenant",
        user: createUser("caller-tenant"),
      },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      "request tenantId conflicts with the authenticated tenant",
    );
    expect(checkSpy).not.toHaveBeenCalled();
    expect(auditSink.events).toEqual([
      expect.objectContaining({
        tenantId: "caller-tenant",
        reason: "tenant_mismatch",
      }),
    ]);
  });

  it("should use a verified tenant when every active tenant source agrees", async () => {
    class TestController {
      testMethod() {}
    }

    Reflect.defineMetadata(
      ENTITLEMENT_REQUIRED_KEY,
      "test_feature",
      TestController.prototype,
      "testMethod",
    );

    const checkSpy = vi.spyOn(mockManager, "check");
    const context = createContext({
      target: TestController,
      httpTenantId: "tenant-verified",
      request: {
        tenantId: "tenant-verified",
        user: createUser("tenant-verified"),
      },
    });

    await Context.run({ requestId: "request-verified", tenantId: "tenant-verified" }, () =>
      expect(guard.canActivate(context)).resolves.toBe(true),
    );

    expect(checkSpy).toHaveBeenCalledWith(
      "tenant-verified",
      "test_feature",
      expect.objectContaining({ ruleId: "entitlement:test_feature" }),
    );
  });

  it("should deny conflicting HTTP and framework tenant contexts", async () => {
    class TestController {
      testMethod() {}
    }

    Reflect.defineMetadata(
      ENTITLEMENT_REQUIRED_KEY,
      "test_feature",
      TestController.prototype,
      "testMethod",
    );

    const checkSpy = vi.spyOn(mockManager, "check");
    const httpConflict = createContext({
      target: TestController,
      httpTenantId: "other-tenant",
      request: { user: createUser("caller-tenant") },
    });

    await expect(guard.canActivate(httpConflict)).rejects.toThrow(
      "HTTP context tenantId conflicts with the authenticated tenant",
    );

    const frameworkConflict = createContext({
      target: TestController,
      request: { user: createUser("caller-tenant") },
    });
    await Context.run({ requestId: "request-conflict", tenantId: "other-tenant" }, () =>
      expect(guard.canActivate(frameworkConflict)).rejects.toThrow(
        "framework Context tenantId conflicts with the authenticated tenant",
      ),
    );

    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("should accept an authenticated API key principal tenant", async () => {
    class TestController {
      testMethod() {}
    }

    Reflect.defineMetadata(
      ENTITLEMENT_REQUIRED_KEY,
      "test_feature",
      TestController.prototype,
      "testMethod",
    );

    const checkSpy = vi.spyOn(mockManager, "check");
    const context = createContext({
      target: TestController,
      request: {
        tenantId: "tenant-api-key",
        principal: {
          type: "apikey",
          id: "key-1",
          permissions: [],
          tenantId: "tenant-api-key",
        },
      },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(checkSpy).toHaveBeenCalledWith(
      "tenant-api-key",
      "test_feature",
      expect.objectContaining({ ruleId: "entitlement:test_feature" }),
    );
  });

  it("should fallback to user.tenantId when request.tenantId is missing", async () => {
    class TestController {
      testMethod() {}
    }

    Reflect.defineMetadata(
      ENTITLEMENT_REQUIRED_KEY,
      "test_feature",
      TestController.prototype,
      "testMethod",
    );

    mockManager.checkResult = {
      granted: true,
      status: "allowed",
      featureKey: "test_feature",
      type: "boolean",
      planId: "pro",
    };

    const checkSpy = vi.spyOn(mockManager, "check");
    const context = createContext({
      target: TestController,
      request: {
        user: createUser("tenant-from-user"),
      },
    });

    await guard.canActivate(context);

    expect(checkSpy).toHaveBeenCalledWith(
      "tenant-from-user",
      "test_feature",
      expect.objectContaining({
        ruleId: "entitlement:test_feature",
        subjectRef: "user:user-1",
      }),
    );
  });

  it("should expose route requirement, tenant, user, resource, telemetry, and audit evidence", async () => {
    const recordEventSpy = vi.spyOn(telemetry, "recordEvent").mockImplementation(() => {});

    class TestController {
      @RequireEntitlement({
        feature: "reports.export",
        resource: { type: "report", idParam: "reportId" },
      })
      testMethod() {}
    }

    const checkSpy = vi.spyOn(mockManager, "check");
    const context = createContext({
      target: TestController,
      request: {
        tenantId: "tenant-123",
        user: createUser("tenant-123"),
        params: { reportId: "report-1" },
      },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(checkSpy).toHaveBeenCalledWith(
      "tenant-123",
      "reports.export",
      expect.objectContaining({
        ruleId: "entitlement:reports.export",
        subjectRef: "user:user-1",
        inputs: expect.objectContaining({
          userId: "user-1",
          resourceType: "report",
          resourceId: "report-1",
          routeId: "TestController.testMethod",
        }),
      }),
    );
    expect(recordEventSpy).toHaveBeenCalledWith(
      "entitlement.guard.allowed",
      expect.objectContaining({
        "entitlement.feature": "reports.export",
        "entitlement.status": "allowed",
        "tenant.id": "tenant-123",
        "user.id": "user-1",
        "resource.type": "report",
        "resource.id": "report-1",
        "route.id": "TestController.testMethod",
      }),
    );
    expect(auditSink.events).toEqual([
      expect.objectContaining({
        type: "entitlement.guard.allowed",
        tenantId: "tenant-123",
        feature: "reports.export",
        status: "allowed",
        userId: "user-1",
        resource: { type: "report", id: "report-1" },
        route: {
          controllerName: "TestController",
          handlerName: "testMethod",
          routeId: "TestController.testMethod",
        },
      }),
    ]);
  });

  it("should map missing plan and quota denial results to standard Problems with decision ids", async () => {
    class TestController {
      @RequireEntitlement({ feature: "reports.export" })
      testMethod() {}
    }

    const context = createContext({
      target: TestController,
      request: {
        tenantId: "tenant-123",
        user: createUser("tenant-123"),
      },
    });
    const missingPlanTrace = createPolicyDecisionTrace({
      policyKind: "entitlement",
      result: "deny",
      ruleId: "entitlement:reports.export",
      tenantId: "tenant-123",
    });

    mockManager.checkResult = {
      granted: false,
      status: "denied",
      featureKey: "reports.export",
      type: "boolean",
      reason: "no_subscription",
      trace: missingPlanTrace,
    };

    await expect(guard.canActivate(context)).rejects.toThrow(EntitlementMissingPlanProblem);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      extensions: {
        decisionId: missingPlanTrace.decisionId,
      },
    });

    const quotaTrace = createPolicyDecisionTrace({
      policyKind: "entitlement",
      result: "deny",
      ruleId: "entitlement:reports.export",
      tenantId: "tenant-123",
    });
    mockManager.checkResult = {
      granted: false,
      status: "denied",
      featureKey: "reports.export",
      type: "metered",
      reason: "quota_exceeded",
      usage: 11,
      quota: 10,
      exceeded: true,
      remaining: -1,
      overagePolicy: "BLOCK",
      trace: quotaTrace,
    };

    await expect(guard.canActivate(context)).rejects.toThrow(EntitlementQuotaExceededProblem);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      extensions: {
        decisionId: quotaTrace.decisionId,
      },
    });
  });

  it("should record denied evidence when the entitlement provider is unavailable", async () => {
    const recordEventSpy = vi.spyOn(telemetry, "recordEvent").mockImplementation(() => {});

    class TestController {
      @RequireEntitlement({ feature: "reports.export" })
      testMethod() {}
    }

    mockManager.error = new Error("billing connection failed");

    const context = createContext({
      target: TestController,
      request: {
        tenantId: "tenant-123",
        user: createUser("tenant-123"),
      },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(EntitlementProviderUnavailableProblem);
    expect(recordEventSpy).toHaveBeenCalledWith(
      "entitlement.guard.denied",
      expect.objectContaining({
        "entitlement.feature": "reports.export",
        "entitlement.status": "unknown",
        "entitlement.reason": "provider_unavailable",
        "problem.code": "ENTITLEMENT_PROVIDER_UNAVAILABLE",
      }),
    );
    expect(auditSink.events).toEqual([
      expect.objectContaining({
        type: "entitlement.guard.denied",
        feature: "reports.export",
        status: "unknown",
        problemCode: "ENTITLEMENT_PROVIDER_UNAVAILABLE",
      }),
    ]);
  });

  it("should not let audit sink failures override allowed guard decisions", async () => {
    const recordEventSpy = vi.spyOn(telemetry, "recordEvent").mockImplementation(() => {});
    Container.set(EntitlementAuditSink.token, new FailingEntitlementAuditSink());

    class TestController {
      @RequireEntitlement({ feature: "reports.export" })
      testMethod() {}
    }

    const context = createContext({
      target: TestController,
      request: {
        tenantId: "tenant-123",
        user: createUser("tenant-123"),
      },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(recordEventSpy).toHaveBeenCalledWith(
      "entitlement.guard.audit_failed",
      expect.objectContaining({
        "entitlement.feature": "reports.export",
        "entitlement.status": "allowed",
        "tenant.id": "tenant-123",
        "route.id": "TestController.testMethod",
        "audit.event": "entitlement.guard.allowed",
      }),
    );
  });

  it("should not let audit sink failures override denied guard decisions", async () => {
    const recordEventSpy = vi.spyOn(telemetry, "recordEvent").mockImplementation(() => {});
    Container.set(EntitlementAuditSink.token, new FailingEntitlementAuditSink());

    class TestController {
      @RequireEntitlement({ feature: "reports.export" })
      testMethod() {}
    }

    mockManager.checkResult = {
      granted: false,
      status: "denied",
      featureKey: "reports.export",
      type: "boolean",
      reason: "not_entitled",
    };

    const context = createContext({
      target: TestController,
      request: {
        tenantId: "tenant-123",
        user: createUser("tenant-123"),
      },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(EntitlementDeniedProblem);
    expect(recordEventSpy).toHaveBeenCalledWith(
      "entitlement.guard.audit_failed",
      expect.objectContaining({
        "entitlement.feature": "reports.export",
        "entitlement.status": "denied",
        "tenant.id": "tenant-123",
        "route.id": "TestController.testMethod",
        "audit.event": "entitlement.guard.denied",
      }),
    );
  });
});
