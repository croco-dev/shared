import "reflect-metadata";
import type { ILogger } from "@croco/framework-context";
import { Container, Context, LOGGER_TOKEN } from "@croco/framework-context";
import * as telemetry from "@croco/telemetry-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Auditable } from "../libs/Auditable";
import { AuditInterceptor } from "../libs/AuditInterceptor";
import type { AuditLogRepository } from "../libs/AuditLogRepository";
import { AUDIT_LOG_REPOSITORY_TOKEN } from "../libs/AuditLogRepositoryToken";
import { AUDIT_METADATA_KEY } from "../libs/constants";
import type { AuditExecutionContext, CallHandler } from "../libs/interfaces/Interceptor";
import { AuditClientIpConfigurationProblem } from "../libs/problems/AuditClientIpConfigurationProblem";
import type { AuditLogEntry } from "../libs/types";

type RequestContextStub = {
  requestId: string;
  tenantId: string;
  user: {
    id: string;
  };
  impersonation?: unknown;
};

type MockHttpRequest = {
  headers?: Headers | Record<string, string | readonly string[] | undefined>;
  body?: unknown;
  header?: Record<string, string | undefined> | ((name: string) => string | undefined);
  socket?: {
    remoteAddress?: unknown;
  };
};

type ExecutionContextInput = {
  controller: Function;
  handler: string | symbol;
  httpContext?: unknown;
  method: string;
  path: string;
  request: MockHttpRequest;
};

function createPersistedEntry(entry: Omit<AuditLogEntry, "id" | "createdAt">): AuditLogEntry {
  return {
    id: "audit-log-1",
    createdAt: new Date(),
    ...entry,
  };
}

function createExecutionContext(input: ExecutionContextInput): AuditExecutionContext {
  return {
    getRequest: () => input.request as unknown as Request,
    getClass: () => input.controller as never,
    getHandler: () => input.handler,
    getPath: () => input.path,
    getMethod: () => input.method,
    getHttpContext: () => input.httpContext,
  } as AuditExecutionContext;
}

function createCallHandler(result: unknown): CallHandler {
  return {
    handle: vi.fn(async () => result),
  } as unknown as CallHandler;
}

function createLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(function (this: ILogger) {
      return this;
    }),
  };
}

function createActiveImpersonationContext(requestId: string): RequestContextStub {
  const now = Date.now();
  return {
    requestId,
    tenantId: "tenant-impersonated",
    user: { id: "target-user-1" },
    impersonation: {
      sessionId: "imp-1",
      impersonatorId: "admin-1",
      targetUserId: "target-user-1",
      startedAt: new Date(now - 60_000),
      expiresAt: new Date(now + 60_000),
    },
  };
}

describe("AuditInterceptor", () => {
  let interceptor!: AuditInterceptor;
  let repository!: AuditLogRepository;
  let createSpy!: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Container.reset();
    createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) =>
      createPersistedEntry(entry),
    );
    repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;
    interceptor = new AuditInterceptor(repository);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Container.reset();
  });

  async function expectRecordedIp(
    request: MockHttpRequest,
    expectedIp: string,
    trustedProxyHops: number = 0,
    httpContext?: unknown,
  ): Promise<void> {
    interceptor = new AuditInterceptor(repository, { trustedProxyHops });

    class ClientIpController {
      read() {}
    }

    const context = createExecutionContext({
      controller: ClientIpController,
      handler: "read",
      httpContext,
      method: "GET",
      path: "/client-ip",
      request,
    });

    await interceptor.intercept(context, createCallHandler({ ok: true }));

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          http: {
            method: "GET",
            path: "/client-ip",
            ip: expectedIp,
          },
        },
      }),
    );
  }

  it("should ignore forwarded headers by default and persist the direct client IP", async () => {
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-1",
      tenantId: "tenant-1",
      user: { id: "actor-1" },
    } as RequestContextStub);

    class TestController {
      update() {}
    }

    const context = createExecutionContext({
      controller: TestController,
      handler: "update",
      method: "PATCH",
      path: "/projects/project-1",
      request: {
        headers: {
          "x-forwarded-for": "203.0.113.10, 70.41.3.18",
        },
        socket: {
          remoteAddress: "192.0.2.10",
        },
        body: { name: "croco" },
      },
    });

    const expectedResult = { ok: true, projectId: "project-1" };
    const next = createCallHandler(expectedResult);

    const result = await interceptor.intercept(context, next);

    await Promise.resolve();

    expect(result).toEqual(expectedResult);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        actorId: "actor-1",
        action: "TestController.update",
        resourceType: "TestController",
        resourceId: "/projects/project-1",
        metadata: {
          http: {
            method: "PATCH",
            path: "/projects/project-1",
            ip: "192.0.2.10",
            body: { name: "croco" },
          },
        },
      }),
    );
  });

  it("should attribute an impersonated request to the administrator", async () => {
    vi.spyOn(Context, "get").mockReturnValue(
      createActiveImpersonationContext("req-impersonated-success"),
    );

    class TestController {
      update() {}
    }

    const context = createExecutionContext({
      controller: TestController,
      handler: "update",
      method: "PATCH",
      path: "/users/target-user-1",
      request: { headers: {} },
    });

    await interceptor.intercept(context, createCallHandler({ updated: true }));

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        metadata: {
          impersonation: true,
          impersonatorId: "admin-1",
          targetUserId: "target-user-1",
          http: {
            method: "PATCH",
            path: "/users/target-user-1",
            ip: "unknown",
          },
        },
      }),
    );
  });

  it("should attribute a failed impersonated request to the administrator", async () => {
    vi.spyOn(Context, "get").mockReturnValue(
      createActiveImpersonationContext("req-impersonated-failure"),
    );

    class TestController {
      remove() {}
    }

    const context = createExecutionContext({
      controller: TestController,
      handler: "remove",
      method: "DELETE",
      path: "/users/target-user-1",
      request: { headers: {} },
    });
    const handlerError = new Error("removal denied");

    await expect(
      interceptor.intercept(context, {
        handle: vi.fn(async () => {
          throw handlerError;
        }),
      } as CallHandler),
    ).rejects.toBe(handlerError);

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        metadata: {
          impersonation: true,
          impersonatorId: "admin-1",
          targetUserId: "target-user-1",
          http: {
            method: "DELETE",
            path: "/users/target-user-1",
            ip: "unknown",
          },
        },
      }),
    );
  });

  it("should avoid target-user attribution for an invalid impersonation context", async () => {
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-invalid-impersonation",
      tenantId: "tenant-impersonated",
      user: { id: "target-user-1" },
      impersonation: { sessionId: "imp-incomplete" },
    } as RequestContextStub);

    class TestController {
      read() {}
    }

    const context = createExecutionContext({
      controller: TestController,
      handler: "read",
      method: "GET",
      path: "/users/target-user-1",
      request: { headers: {} },
    });

    await interceptor.intercept(context, createCallHandler({ id: "target-user-1" }));

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "unknown",
        metadata: {
          impersonation: true,
          invalidImpersonationContext: true,
          http: {
            method: "GET",
            path: "/users/target-user-1",
            ip: "unknown",
          },
        },
      }),
    );
  });

  it("should fail closed when audit persistence fails", async () => {
    createSpy.mockRejectedValueOnce(new Error("repository unavailable"));
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-2",
      tenantId: "tenant-2",
      user: { id: "actor-2" },
    } as RequestContextStub);

    class TestController {
      update() {}
    }

    const context = createExecutionContext({
      controller: TestController,
      handler: "update",
      method: "PATCH",
      path: "/projects/project-2",
      request: {
        headers: {},
      },
    });

    await expect(interceptor.intercept(context, createCallHandler({ ok: true }))).rejects.toThrow(
      "repository unavailable",
    );
  });

  it("should preserve the handler failure when failure audit persistence also fails", async () => {
    const handlerError = new Error("validation failed");
    const auditWriteError = new Error("repository unavailable");
    const telemetryError = new Error("telemetry unavailable");
    createSpy.mockRejectedValueOnce(auditWriteError);
    const recordErrorSpy = vi.spyOn(telemetry, "recordError").mockImplementation(() => {
      throw telemetryError;
    });
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-double-failure",
      tenantId: "tenant-double-failure",
      user: { id: "actor-double-failure" },
    } as RequestContextStub);

    class TestController {
      update() {}
    }

    const context = createExecutionContext({
      controller: TestController,
      handler: "update",
      method: "PATCH",
      path: "/projects/project-double-failure",
      request: {
        headers: {},
      },
    });
    const next = {
      handle: vi.fn(async () => {
        throw handlerError;
      }),
    } as CallHandler;

    await expect(interceptor.intercept(context, next)).rejects.toBe(handlerError);

    expect((handlerError as Error & { cause?: unknown }).cause).toBe(auditWriteError);
    expect(recordErrorSpy).toHaveBeenCalledWith(auditWriteError);
  });

  it("should create exactly one entry for a successful @Auditable handler", async () => {
    Container.set(AUDIT_LOG_REPOSITORY_TOKEN, repository);
    Container.set(LOGGER_TOKEN, createLogger());
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-decorated-success",
      tenantId: "tenant-decorated",
      user: { id: "actor-decorated" },
    } as RequestContextStub);

    class TestController {
      @Auditable({
        action: "project.create",
        resourceType: "Project",
        resourceIdIndex: 0,
        throwOnFailure: true,
      })
      async create(resourceId: string): Promise<{ created: boolean }> {
        return { created: true };
      }
    }

    const controller = new TestController();

    const context = createExecutionContext({
      controller: TestController,
      handler: "create",
      method: "POST",
      path: "/projects",
      request: {
        headers: {},
        header: {
          "x-real-ip": "198.51.100.20",
        },
        body: { name: "new-project" },
      },
    });

    const next = {
      handle: vi.fn(() => controller.create("project-1")),
    } as CallHandler;

    const result = await interceptor.intercept(context, next);

    expect(result).toEqual({ created: true });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.create",
        resourceType: "Project",
        resourceId: "project-1",
      }),
    );
  });

  it("should create exactly one entry for a failing @Auditable handler", async () => {
    Container.set(AUDIT_LOG_REPOSITORY_TOKEN, repository);
    Container.set(LOGGER_TOKEN, createLogger());
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-decorated-failure",
      tenantId: "tenant-decorated",
      user: { id: "actor-decorated" },
    } as RequestContextStub);

    class TestController {
      @Auditable({
        action: "project.delete",
        resourceType: "Project",
        resourceIdIndex: 0,
        throwOnFailure: true,
      })
      async remove(resourceId: string): Promise<void> {
        throw new Error(`delete failed: ${resourceId}`);
      }
    }

    const controller = new TestController();
    const context = createExecutionContext({
      controller: TestController,
      handler: "remove",
      method: "DELETE",
      path: "/projects/project-2",
      request: {
        headers: {},
      },
    });
    const next = {
      handle: vi.fn(() => controller.remove("project-2")),
    } as CallHandler;

    await expect(interceptor.intercept(context, next)).rejects.toThrow("delete failed: project-2");

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.delete",
        resourceType: "Project",
        resourceId: "project-2",
        payload: expect.objectContaining({
          error: "delete failed: project-2",
        }),
      }),
    );
  });

  it("should use interceptor coverage when the decorator audit write fails", async () => {
    const decoratorCreateSpy = vi.fn(async () => {
      throw new Error("decorator repository unavailable");
    });
    const decoratorRepository = {
      create: decoratorCreateSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;
    Container.set(AUDIT_LOG_REPOSITORY_TOKEN, decoratorRepository);
    Container.set(LOGGER_TOKEN, createLogger());
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-decorator-write-fallback",
      tenantId: "tenant-write-fallback",
      user: { id: "actor-write-fallback" },
    } as RequestContextStub);

    class TestController {
      @Auditable({ action: "project.publish", resourceType: "Project" })
      async publish(): Promise<{ published: boolean }> {
        return { published: true };
      }
    }

    const controller = new TestController();
    const context = createExecutionContext({
      controller: TestController,
      handler: "publish",
      method: "POST",
      path: "/projects/project-3/publish",
      request: { headers: {} },
    });

    await expect(
      interceptor.intercept(context, {
        handle: vi.fn(() => controller.publish()),
      } as CallHandler),
    ).resolves.toEqual({ published: true });

    expect(decoratorCreateSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TestController.publish",
        resourceId: "/projects/project-3/publish",
      }),
    );
  });

  it("should use interceptor failure coverage when the decorator audit write fails", async () => {
    const decoratorCreateSpy = vi.fn(async () => {
      throw new Error("decorator repository unavailable");
    });
    const decoratorRepository = {
      create: decoratorCreateSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;
    Container.set(AUDIT_LOG_REPOSITORY_TOKEN, decoratorRepository);
    Container.set(LOGGER_TOKEN, createLogger());
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-decorator-failure-write-fallback",
      tenantId: "tenant-write-fallback",
      user: { id: "actor-write-fallback" },
    } as RequestContextStub);

    class TestController {
      @Auditable({ action: "project.reject", resourceType: "Project" })
      async reject(): Promise<void> {
        throw new Error("project rejected");
      }
    }

    const controller = new TestController();
    const context = createExecutionContext({
      controller: TestController,
      handler: "reject",
      method: "DELETE",
      path: "/projects/project-4",
      request: { headers: {} },
    });

    await expect(
      interceptor.intercept(context, {
        handle: vi.fn(() => controller.reject()),
      } as CallHandler),
    ).rejects.toThrow("project rejected");

    expect(decoratorCreateSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TestController.reject",
        payload: { error: "project rejected" },
      }),
    );
  });

  it("should use interceptor coverage when @Auditable dependencies are missing", async () => {
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-decorated-fallback",
      tenantId: "tenant-fallback",
      user: { id: "actor-fallback" },
    } as RequestContextStub);

    class TestController {
      @Auditable({ action: "project.update", resourceType: "Project" })
      async update(): Promise<{ updated: boolean }> {
        return { updated: true };
      }
    }

    const controller = new TestController();
    const context = createExecutionContext({
      controller: TestController,
      handler: "update",
      method: "PATCH",
      path: "/projects/project-3",
      request: { headers: {} },
    });

    await expect(
      interceptor.intercept(context, {
        handle: vi.fn(() => controller.update()),
      } as CallHandler),
    ).resolves.toEqual({ updated: true });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TestController.update",
        resourceType: "TestController",
        resourceId: "/projects/project-3",
      }),
    );
  });

  it("should use interceptor failure coverage when @Auditable dependencies are missing", async () => {
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-decorated-failure-fallback",
      tenantId: "tenant-fallback",
      user: { id: "actor-fallback" },
    } as RequestContextStub);

    class TestController {
      @Auditable({ action: "project.archive", resourceType: "Project" })
      async archive(): Promise<void> {
        throw new Error("archive failed");
      }
    }

    const controller = new TestController();
    const context = createExecutionContext({
      controller: TestController,
      handler: "archive",
      method: "DELETE",
      path: "/projects/project-4",
      request: { headers: {} },
    });

    await expect(
      interceptor.intercept(context, {
        handle: vi.fn(() => controller.archive()),
      } as CallHandler),
    ).rejects.toThrow("archive failed");

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TestController.archive",
        payload: { error: "archive failed" },
      }),
    );
  });

  it("should use interceptor coverage when a lazy decorator dependency cannot resolve", async () => {
    Container.registerLazy(AUDIT_LOG_REPOSITORY_TOKEN, () => {
      throw new Error("decorator repository unavailable");
    });
    Container.set(LOGGER_TOKEN, createLogger());
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-decorated-lazy-fallback",
      tenantId: "tenant-lazy-fallback",
      user: { id: "actor-lazy-fallback" },
    } as RequestContextStub);

    class TestController {
      @Auditable({ action: "project.restore", resourceType: "Project" })
      async restore(): Promise<{ restored: boolean }> {
        return { restored: true };
      }
    }

    const controller = new TestController();
    const context = createExecutionContext({
      controller: TestController,
      handler: "restore",
      method: "POST",
      path: "/projects/project-5/restore",
      request: { headers: {} },
    });

    await expect(
      interceptor.intercept(context, {
        handle: vi.fn(() => controller.restore()),
      } as CallHandler),
    ).resolves.toEqual({ restored: true });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TestController.restore",
        resourceId: "/projects/project-5/restore",
      }),
    );
  });

  it("should preserve interceptor skips for custom audit metadata", async () => {
    class TestController {
      create() {}
    }

    Reflect.defineMetadata(AUDIT_METADATA_KEY, { source: "custom" }, TestController, "create");

    const context = createExecutionContext({
      controller: TestController,
      handler: "create",
      method: "POST",
      path: "/projects",
      request: { headers: {} },
    });

    await expect(
      interceptor.intercept(context, createCallHandler({ created: true })),
    ).resolves.toEqual({ created: true });

    expect(createSpy).not.toHaveBeenCalled();
  });

  it("should use interceptor coverage when decorator audit preparation fails", async () => {
    Container.set(AUDIT_LOG_REPOSITORY_TOKEN, repository);
    Container.set(LOGGER_TOKEN, createLogger());
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-decorated-preparation-fallback",
      tenantId: "tenant-preparation-fallback",
      user: { id: "actor-preparation-fallback" },
    } as RequestContextStub);

    class TestController {
      @Auditable({
        action: "project.update",
        resourceType: "Project",
        resourceIdIndex: 0,
      })
      async update(resourceId: unknown): Promise<unknown> {
        return resourceId;
      }
    }

    const controller = new TestController();
    const context = createExecutionContext({
      controller: TestController,
      handler: "update",
      method: "PATCH",
      path: "/projects/project-6",
      request: { headers: {} },
    });
    const unconvertibleResourceId = Object.create(null) as object;

    await expect(
      interceptor.intercept(context, {
        handle: vi.fn(() => controller.update(unconvertibleResourceId)),
      } as CallHandler),
    ).rejects.toThrow();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TestController.update",
        resourceId: "/projects/project-6",
      }),
    );
  });

  it("should create exactly one entry for a static @Auditable handler", async () => {
    Container.set(AUDIT_LOG_REPOSITORY_TOKEN, repository);
    Container.set(LOGGER_TOKEN, createLogger());
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-static-decorated",
      tenantId: "tenant-static",
      user: { id: "actor-static" },
    } as RequestContextStub);

    class TestController {
      @Auditable({
        action: "project.list",
        resourceType: "Project",
        throwOnFailure: true,
      })
      static async list(): Promise<string[]> {
        return ["project-1"];
      }
    }

    const context = createExecutionContext({
      controller: TestController,
      handler: "list",
      method: "GET",
      path: "/projects",
      request: { headers: {} },
    });

    await expect(
      interceptor.intercept(context, {
        handle: vi.fn(() => TestController.list()),
      } as CallHandler),
    ).resolves.toEqual(["project-1"]);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.list",
        resourceType: "Project",
      }),
    );
  });

  it("should create exactly one entry through nested interceptors", async () => {
    Container.set(AUDIT_LOG_REPOSITORY_TOKEN, repository);
    Container.set(LOGGER_TOKEN, createLogger());
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-nested-decorated",
      tenantId: "tenant-nested",
      user: { id: "actor-nested" },
    } as RequestContextStub);

    class TestController {
      @Auditable({
        action: "project.read",
        resourceType: "Project",
        throwOnFailure: true,
      })
      async read(): Promise<string> {
        return "project-1";
      }
    }

    const controller = new TestController();
    const nestedInterceptor = new AuditInterceptor(repository);
    const context = createExecutionContext({
      controller: TestController,
      handler: "read",
      method: "GET",
      path: "/projects/project-1",
      request: { headers: {} },
    });

    await expect(
      interceptor.intercept(context, {
        handle: () =>
          nestedInterceptor.intercept(context, {
            handle: vi.fn(() => controller.read()),
          }),
      }),
    ).resolves.toBe("project-1");

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.read",
        resourceType: "Project",
      }),
    );
  });

  it.each([
    { label: "successful", shouldFail: false },
    { label: "failing", shouldFail: true },
  ])(
    "should create one fallback entry through nested interceptors for a $label handler",
    async ({ shouldFail }) => {
      const decoratorCreateSpy = vi.fn(async () => {
        throw new Error("decorator repository unavailable");
      });
      const decoratorRepository = {
        create: decoratorCreateSpy,
        find: vi.fn(),
      } as unknown as AuditLogRepository;
      Container.set(AUDIT_LOG_REPOSITORY_TOKEN, decoratorRepository);
      Container.set(LOGGER_TOKEN, createLogger());
      vi.spyOn(Context, "get").mockReturnValue({
        requestId: "req-nested-write-fallback",
        tenantId: "tenant-nested-write-fallback",
        user: { id: "actor-nested-write-fallback" },
      } as RequestContextStub);

      class TestController {
        @Auditable({ action: "project.process", resourceType: "Project" })
        async process(): Promise<string> {
          if (shouldFail) {
            throw new Error("project processing failed");
          }
          return "processed";
        }
      }

      const controller = new TestController();
      const nestedInterceptor = new AuditInterceptor(repository);
      const context = createExecutionContext({
        controller: TestController,
        handler: "process",
        method: "POST",
        path: "/projects/project-5/process",
        request: { headers: {} },
      });
      const invocation = interceptor.intercept(context, {
        handle: () =>
          nestedInterceptor.intercept(context, {
            handle: vi.fn(() => controller.process()),
          }),
      });

      if (shouldFail) {
        await expect(invocation).rejects.toThrow("project processing failed");
      } else {
        await expect(invocation).resolves.toBe("processed");
      }

      expect(decoratorCreateSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "TestController.process",
          ...(shouldFail ? { payload: { error: "project processing failed" } } : {}),
        }),
      );
    },
  );

  it("should create exactly one entry for an inherited @Auditable handler", async () => {
    Container.set(AUDIT_LOG_REPOSITORY_TOKEN, repository);
    Container.set(LOGGER_TOKEN, createLogger());
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-inherited-decorated",
      tenantId: "tenant-inherited",
      user: { id: "actor-inherited" },
    } as RequestContextStub);

    class BaseController {
      @Auditable({
        action: "project.inherited-read",
        resourceType: "Project",
        throwOnFailure: true,
      })
      async read(): Promise<string> {
        return "project-1";
      }
    }

    class TestController extends BaseController {}

    const controller = new TestController();
    const context = createExecutionContext({
      controller: TestController,
      handler: "read",
      method: "GET",
      path: "/projects/project-1",
      request: { headers: {} },
    });

    await expect(
      interceptor.intercept(context, {
        handle: vi.fn(() => controller.read()),
      } as CallHandler),
    ).resolves.toBe("project-1");

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.inherited-read",
        resourceType: "Project",
      }),
    );
  });

  it("should preserve audit coverage for distinct nested decorated handlers", async () => {
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-distinct-nested-decorated",
      tenantId: "tenant-distinct-nested",
      user: { id: "actor-distinct-nested" },
    } as RequestContextStub);

    class InnerController {
      @Auditable({
        action: "inner.read",
        resourceType: "InnerProject",
        throwOnFailure: true,
      })
      async read(): Promise<string> {
        return "project-1";
      }
    }

    const innerController = new InnerController();
    const innerInterceptor = new AuditInterceptor(repository);
    const innerContext = createExecutionContext({
      controller: InnerController,
      handler: "read",
      method: "GET",
      path: "/inner-projects/project-1",
      request: { headers: {} },
    });

    class OuterController {
      @Auditable({ action: "outer.run", resourceType: "OuterProject" })
      async run(): Promise<unknown> {
        Container.set(AUDIT_LOG_REPOSITORY_TOKEN, repository);
        Container.set(LOGGER_TOKEN, createLogger());
        return innerInterceptor.intercept(innerContext, {
          handle: vi.fn(() => innerController.read()),
        });
      }
    }

    const outerController = new OuterController();
    const outerContext = createExecutionContext({
      controller: OuterController,
      handler: "run",
      method: "POST",
      path: "/outer-projects/run",
      request: { headers: {} },
    });

    await expect(
      interceptor.intercept(outerContext, {
        handle: vi.fn(() => outerController.run()),
      } as CallHandler),
    ).resolves.toBe("project-1");

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls.map(([entry]) => entry.action)).toEqual([
      "inner.read",
      "OuterController.run",
    ]);
  });

  it("should work standalone without @Auditable metadata", async () => {
    vi.spyOn(Context, "get").mockReturnValue(null);

    class PublicController {
      health() {}
    }

    const context = createExecutionContext({
      controller: PublicController,
      handler: "health",
      method: "GET",
      path: "/health",
      request: {
        headers: {
          "x-forwarded-for": "127.0.0.1",
          "x-real-ip": "127.0.0.2",
          "cf-connecting-ip": "127.0.0.3",
        },
      },
    });

    const next = createCallHandler({ ok: true });

    const result = await interceptor.intercept(context, next);

    await Promise.resolve();

    expect(result).toEqual({ ok: true });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "unknown",
        actorId: "unknown",
        action: "PublicController.health",
        resourceType: "PublicController",
        metadata: {
          http: {
            method: "GET",
            path: "/health",
            ip: "unknown",
          },
        },
      }),
    );
  });

  it("should resolve the rightmost forwarded address through one trusted proxy", async () => {
    await expectRecordedIp(
      {
        headers: { "x-forwarded-for": "198.51.100.40, 203.0.113.20" },
        socket: { remoteAddress: "192.0.2.20" },
      },
      "203.0.113.20",
      1,
    );
  });

  it("should resolve the direct Node address from the HTTP execution context", async () => {
    await expectRecordedIp({ headers: { "x-forwarded-for": "203.0.113.30" } }, "192.0.2.30", 0, {
      raw: {
        env: {
          incoming: {
            socket: { remoteAddress: "192.0.2.30" },
          },
        },
      },
    });
  });

  it("should resolve the direct Lambda source without trusting forwarded headers", async () => {
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-lambda",
      runtime: {
        platform: "lambda",
        native: {
          event: {
            requestContext: {
              http: { sourceIp: "192.0.2.31" },
            },
          },
        },
      },
    } as never);

    await expectRecordedIp({ headers: { "x-forwarded-for": "203.0.113.31" } }, "192.0.2.31");
  });

  it("should resolve the forwarded address at the configured trusted hop boundary", async () => {
    await expectRecordedIp(
      {
        headers: { "x-forwarded-for": "192.0.2.200, 198.51.100.41, 203.0.113.21" },
        socket: { remoteAddress: "192.0.2.21" },
      },
      "198.51.100.41",
      2,
    );
  });

  it("should not let a malformed untrusted prefix degrade a valid trusted boundary", async () => {
    await expectRecordedIp(
      {
        headers: { "x-forwarded-for": "attacker.example, 198.51.100.41, 203.0.113.21" },
        socket: { remoteAddress: "192.0.2.21" },
      },
      "198.51.100.41",
      2,
    );
  });

  it("should normalize a trusted IPv6 address", async () => {
    await expectRecordedIp(
      {
        headers: new Headers({
          "X-Forwarded-For": "198.51.100.44, 2001:0db8:0000:0000:0000:0000:0000:0044",
        }),
        socket: { remoteAddress: "192.0.2.24" },
      },
      "2001:db8::44",
      1,
    );
  });

  it.each([
    ["a chain shorter than the trusted boundary", "198.51.100.42"],
    ["an empty forwarded address", "198.51.100.42, , 203.0.113.22"],
    ["a malformed trusted suffix", "198.51.100.42, attacker.example, 203.0.113.22"],
    ["an address with a port", "198.51.100.42:443, 203.0.113.22"],
    ["an out-of-range IPv4 address", "999.51.100.42, 203.0.113.22"],
  ])("should use the direct address for %s", async (_case, forwardedFor) => {
    await expectRecordedIp(
      {
        headers: { "x-forwarded-for": forwardedFor },
        socket: { remoteAddress: "192.0.2.22" },
      },
      "192.0.2.22",
      2,
    );
  });

  it("should reject ambiguous forwarded header values", async () => {
    await expectRecordedIp(
      {
        headers: {
          "x-forwarded-for": ["198.51.100.43", "203.0.113.23"],
        },
        socket: { remoteAddress: "192.0.2.23" },
      },
      "192.0.2.23",
      1,
    );
  });

  it("should reject duplicate case-variant forwarded header keys", async () => {
    await expectRecordedIp(
      {
        headers: {
          "X-Forwarded-For": "198.51.100.45",
          "x-forwarded-for": "203.0.113.25",
        },
        socket: { remoteAddress: "192.0.2.25" },
      },
      "192.0.2.25",
      1,
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "should reject invalid trusted proxy hop counts (%s)",
    (trustedProxyHops) => {
      expect(() => new AuditInterceptor(repository, { trustedProxyHops })).toThrowError(
        AuditClientIpConfigurationProblem,
      );
    },
  );
});
