import "reflect-metadata";
import type { ILogger } from "@croco/framework-context";
import { Container, Context, LOGGER_TOKEN } from "@croco/framework-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Auditable } from "../libs/Auditable";
import type { AuditLogRepository } from "../libs/AuditLogRepository";
import { AUDIT_LOG_REPOSITORY_TOKEN } from "../libs/AuditLogRepositoryToken";
import { AUDIT_METADATA_KEY } from "../libs/constants";
import { AuditableDecoratorProblem } from "../libs/problems/AuditableDecoratorProblem";
import type { AuditableOptions, AuditLogEntry } from "../libs/types";

type RequestContextStub = {
  requestId: string;
  tenantId: string;
  user: {
    id: string;
  };
};

function createPersistedEntry(entry: Omit<AuditLogEntry, "id" | "createdAt">): AuditLogEntry {
  return {
    id: "audit-log-1",
    createdAt: new Date(),
    ...entry,
  };
}

describe("@Auditable", () => {
  beforeEach(() => {
    Container.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Container.reset();
  });

  it("should publish interceptor metadata on the controller constructor and method", () => {
    class TestController {
      @Auditable({ action: "project.create", resourceType: "Project" })
      create() {}
    }

    expect(Reflect.getOwnMetadata(AUDIT_METADATA_KEY, TestController, "create")).toEqual({
      source: "decorator",
    });
  });

  it("should publish interceptor metadata for a static method", () => {
    class TestController {
      @Auditable({ action: "project.create", resourceType: "Project" })
      static create() {}
    }

    expect(Reflect.getOwnMetadata(AUDIT_METADATA_KEY, TestController, "create")).toEqual({
      source: "decorator",
    });
  });

  it("should wrap method and call AuditLogRepository.create after method execution", async () => {
    const events: string[] = [];
    const createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) => {
      events.push("audit");
      return createPersistedEntry(entry);
    });

    const repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;

    vi.spyOn(Container, "get").mockReturnValue(repository);
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-1",
      tenantId: "tenant-1",
      user: { id: "actor-1" },
    } as RequestContextStub);

    class TestService {
      private readonly prefix = "wrapped";

      @Auditable({
        action: "project.update",
        resourceType: "Project",
        resourceIdIndex: 0,
        payloadIndex: 1,
        includeResult: true,
      })
      async update(
        resourceId: string,
        payload: { name: string; diff: Record<string, unknown> },
      ): Promise<string> {
        events.push("method");
        return `${this.prefix}:${resourceId}:${payload.name}`;
      }
    }

    const service = new TestService();
    const result = await service.update("project-1", {
      name: "croco",
      diff: { name: { before: "legacy", after: "croco" } },
    });

    await Promise.resolve();

    expect(result).toBe("wrapped:project-1:croco");
    expect(events).toEqual(["method", "audit"]);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        actorId: "actor-1",
        action: "project.update",
        resourceType: "Project",
        resourceId: "project-1",
        payload: expect.objectContaining({
          arguments: [
            "project-1",
            { name: "croco", diff: { name: { before: "legacy", after: "croco" } } },
          ],
          input: { name: "croco", diff: { name: { before: "legacy", after: "croco" } } },
          result: "wrapped:project-1:croco",
        }),
        diff: { name: { before: "legacy", after: "croco" } },
      }),
    );
  });

  it("should select reordered non-leading resource and payload parameters", async () => {
    const createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) =>
      createPersistedEntry(entry),
    );
    const repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;

    vi.spyOn(Container, "get").mockReturnValue(repository);
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-reordered",
      tenantId: "tenant-reordered",
      user: { id: "actor-reordered" },
    } as RequestContextStub);

    class TestService {
      @Auditable({
        action: "project.reorder",
        resourceType: "Project",
        resourceIdIndex: 2,
        payloadIndex: 1,
        throwOnFailure: true,
      })
      async update(
        requestContext: { source: string },
        payload: { diff: Record<string, unknown>; name: string },
        resourceId: string,
      ): Promise<string> {
        return `${requestContext.source}:${resourceId}:${payload.name}`;
      }
    }

    await expect(
      new TestService().update(
        { source: "handler" },
        { name: "croco", diff: { name: { before: "old", after: "croco" } } },
        "project-reordered",
      ),
    ).resolves.toBe("handler:project-reordered:croco");

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "project-reordered",
        payload: expect.objectContaining({
          input: { name: "croco", diff: { name: { before: "old", after: "croco" } } },
        }),
        diff: { name: { before: "old", after: "croco" } },
      }),
    );
  });

  it("should preserve optional parameter selection when selected arguments are omitted", async () => {
    const createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) =>
      createPersistedEntry(entry),
    );
    const repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;

    vi.spyOn(Container, "get").mockReturnValue(repository);
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-optional",
      tenantId: "tenant-optional",
      user: { id: "actor-optional" },
    } as RequestContextStub);

    class TestService {
      @Auditable({
        action: "project.optional",
        resourceType: "Project",
        resourceIdIndex: 1,
        payloadIndex: 2,
        throwOnFailure: true,
      })
      async update(
        requestContext: { source: string },
        resourceId?: string,
        payload?: { diff: Record<string, unknown> },
      ): Promise<string> {
        return `${requestContext.source}:${resourceId ?? "missing"}:${payload ? "payload" : "empty"}`;
      }
    }

    await expect(new TestService().update({ source: "handler" })).resolves.toBe(
      "handler:missing:empty",
    );

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "unknown",
        payload: { arguments: [{ source: "handler" }] },
        diff: null,
      }),
    );
  });

  it.each([-1, 1, 0.5, Number.NaN])(
    "should reject unresolved parameter index %s",
    (resourceIdIndex) => {
      expect(() => {
        class TestService {
          @Auditable({
            action: "project.invalid-selector",
            resourceType: "Project",
            resourceIdIndex,
          })
          read(resourceId: string): string {
            return resourceId;
          }
        }

        return TestService;
      }).toThrow(AuditableDecoratorProblem);
    },
  );

  it("should reject defaulted parameter selectors instead of assuming declared arity", () => {
    expect(() => {
      class TestService {
        @Auditable({
          action: "project.default-selector",
          resourceType: "Project",
          payloadIndex: 1,
        })
        update(resourceId: string, payload: Record<string, unknown> = {}): string {
          void payload;
          return resourceId;
        }
      }

      return TestService;
    }).toThrow("before the first default or rest parameter");
  });

  it("should reject rest parameter selectors instead of auditing one variadic argument", () => {
    expect(() => {
      class TestService {
        @Auditable({
          action: "project.rest-selector",
          resourceType: "Project",
          payloadIndex: 1,
        })
        update(resourceId: string, ...payloads: Record<string, unknown>[]): string {
          void payloads;
          return resourceId;
        }
      }

      return TestService;
    }).toThrow("before the first default or rest parameter");
  });

  it("should require Auditable to inspect the method before rest-argument wrappers", () => {
    function RestArgumentWrapper(): MethodDecorator {
      return (_target, _propertyKey, descriptor) => {
        const methodDescriptor = descriptor as PropertyDescriptor;
        const originalMethod = methodDescriptor.value as (...args: unknown[]) => unknown;
        methodDescriptor.value = function (this: unknown, ...args: unknown[]): unknown {
          return originalMethod.apply(this, args);
        };
      };
    }

    expect(() => {
      class SupportedService {
        @RestArgumentWrapper()
        @Auditable({
          action: "project.composed",
          resourceType: "Project",
          resourceIdIndex: 0,
          payloadIndex: 1,
        })
        update(resourceId: string, payload: Record<string, unknown>): string {
          void payload;
          return resourceId;
        }
      }

      return SupportedService;
    }).not.toThrow();

    expect(() => {
      class UnsupportedService {
        @Auditable({
          action: "project.composed",
          resourceType: "Project",
          resourceIdIndex: 0,
          payloadIndex: 1,
        })
        @RestArgumentWrapper()
        update(resourceId: string, payload: Record<string, unknown>): string {
          void payload;
          return resourceId;
        }
      }

      return UnsupportedService;
    }).toThrow("place @Auditable closest to the method");
  });

  it("should reject legacy named selectors with an explicit migration error", () => {
    expect(() =>
      Auditable({
        action: "project.legacy-selector",
        resourceType: "Project",
        resourceIdParam: "missing",
      } as unknown as AuditableOptions),
    ).toThrow("migrate to resourceIdIndex and payloadIndex");
  });

  it("should call audit repository in fire-and-forget mode without awaiting", async () => {
    const createDeferred: { resolve: ((value: AuditLogEntry) => void) | null } = {
      resolve: null,
    };
    const createSpy = vi.fn(
      () =>
        new Promise<AuditLogEntry>((resolve) => {
          createDeferred.resolve = resolve;
        }),
    );

    const repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;

    vi.spyOn(Container, "get").mockReturnValue(repository);
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-2",
      tenantId: "tenant-2",
      user: { id: "actor-2" },
    } as RequestContextStub);

    class TestService {
      @Auditable({
        action: "project.create",
        resourceType: "Project",
        resourceIdIndex: 0,
        payloadIndex: 1,
        includeResult: true,
      })
      async create(
        resourceId: string,
        payload: Record<string, unknown>,
      ): Promise<{ ok: boolean; resourceId: string; payload: Record<string, unknown> }> {
        return { ok: true, resourceId, payload };
      }
    }

    const service = new TestService();
    const result = await service.create("project-2", { name: "new-project" });

    await Promise.resolve();

    expect(result).toEqual({ ok: true, resourceId: "project-2", payload: { name: "new-project" } });
    expect(createSpy).toHaveBeenCalledTimes(1);

    if (createDeferred.resolve) {
      createDeferred.resolve(
        createPersistedEntry({
          tenantId: "tenant-2",
          actorId: "actor-2",
          action: "project.create",
          resourceType: "Project",
          resourceId: "project-2",
          payload: {
            arguments: ["project-2", { name: "new-project" }],
            input: { name: "new-project" },
            result: { ok: true, resourceId: "project-2", payload: { name: "new-project" } },
          },
          diff: null,
          metadata: {},
        }),
      );
    }
  });

  it("should write failure audit log when decorated method throws", async () => {
    const createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) =>
      createPersistedEntry(entry),
    );
    const repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;

    vi.spyOn(Container, "get").mockReturnValue(repository);
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-3",
      tenantId: "tenant-3",
      user: { id: "actor-3" },
    } as RequestContextStub);

    class TestService {
      @Auditable({
        action: "project.delete",
        resourceType: "Project",
        resourceIdIndex: 0,
        payloadIndex: 1,
      })
      async remove(
        resourceId: string,
        payload: { reason: string; diff: Record<string, unknown> },
      ): Promise<void> {
        void payload;
        throw new Error(`delete failed: ${resourceId}`);
      }
    }

    const service = new TestService();

    await expect(
      service.remove("project-3", {
        reason: "permission denied",
        diff: { status: { before: "ACTIVE", after: "DELETED" } },
      }),
    ).rejects.toThrow("delete failed: project-3");

    await Promise.resolve();

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-3",
        actorId: "actor-3",
        action: "project.delete",
        resourceType: "Project",
        resourceId: "project-3",
        payload: expect.objectContaining({
          arguments: [
            "project-3",
            {
              reason: "permission denied",
              diff: { status: { before: "ACTIVE", after: "DELETED" } },
            },
          ],
          input: {
            reason: "permission denied",
            diff: { status: { before: "ACTIVE", after: "DELETED" } },
          },
          error: "delete failed: project-3",
        }),
        diff: { status: { before: "ACTIVE", after: "DELETED" } },
      }),
    );
  });

  it("should redact nested secret-bearing values without changing non-sensitive fields", async () => {
    const createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) =>
      createPersistedEntry(entry),
    );
    const repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;

    vi.spyOn(Container, "get").mockReturnValue(repository);
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-redaction",
      tenantId: "tenant-redaction",
      user: { id: "actor-redaction" },
    } as RequestContextStub);

    class TestService {
      @Auditable({
        action: "credential.rotate",
        resourceType: "Credential",
        resourceIdIndex: 0,
        payloadIndex: 1,
      })
      async rotate(resourceId: string, payload: Record<string, unknown>): Promise<void> {
        void resourceId;
        void payload;
      }
    }

    let serializationHookCalls = 0;
    await new TestService().rotate("credential-1", {
      name: "primary",
      password: "plain-password",
      db_password: "database-password",
      diff: {
        dbPassword: { before: "old-password", after: "new-password" },
        enabled: { before: false, after: true },
      },
      nested: {
        toJSON: () => {
          serializationHookCalls += 1;
          return { password: "serialization-bypass" };
        },
        apiKey: "api-key-value",
        "x-api-key": "header-api-key-value",
        enabled: true,
        description: "Apply basic validation and use digest authentication",
        items: [
          { accessToken: "access-token-value", label: "first" },
          { authorization: "Bearer bearer-value", label: "second" },
        ],
        createdAt: Object.defineProperty(new Date("2026-08-13T00:00:00.000Z"), "getTime", {
          enumerable: true,
          get: () => {
            throw new Error("date getTime getter must not run");
          },
        }),
      },
    });

    await Promise.resolve();

    const expectedInput = {
      name: "primary",
      password: "[Redacted]",
      db_password: "[Redacted]",
      diff: {
        dbPassword: "[Redacted]",
        enabled: { before: false, after: true },
      },
      nested: {
        apiKey: "[Redacted]",
        "x-api-key": "[Redacted]",
        enabled: true,
        description: "Apply basic validation and use digest authentication",
        items: [
          { accessToken: "[Redacted]", label: "first" },
          { authorization: "[Redacted]", label: "second" },
        ],
        createdAt: new Date("2026-08-13T00:00:00.000Z"),
      },
    };
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          arguments: ["credential-1", expectedInput],
          input: expectedInput,
        },
        diff: {
          dbPassword: "[Redacted]",
          enabled: { before: false, after: true },
        },
      }),
    );
    expect(JSON.stringify(createSpy.mock.calls[0]?.[0].payload)).not.toContain(
      "serialization-bypass",
    );
    expect(serializationHookCalls).toBe(0);
  });

  it("should omit results by default and sanitize explicitly included results", async () => {
    const createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) =>
      createPersistedEntry(entry),
    );
    const repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;

    vi.spyOn(Container, "get").mockReturnValue(repository);
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-result-policy",
      tenantId: "tenant-result-policy",
      user: { id: "actor-result-policy" },
    } as RequestContextStub);

    class TestService {
      @Auditable({ action: "session.default", resourceType: "Session" })
      async createDefault(): Promise<Record<string, unknown>> {
        return { sessionId: "session-1", refreshToken: "default-secret" };
      }

      @Auditable({ action: "session.explicit", resourceType: "Session", includeResult: true })
      async createExplicit(): Promise<Record<string, unknown>> {
        return { sessionId: "session-2", refreshToken: "explicit-secret", active: true };
      }

      @Auditable({ action: "session.accessors", resourceType: "Session", includeResult: true })
      async createWithAccessors(): Promise<Record<string, unknown>> {
        return Object.defineProperties(
          { sessionId: "session-3", active: true },
          {
            refreshToken: {
              enumerable: true,
              get: () => {
                throw new Error("secret getter must not run");
              },
            },
            displayName: {
              enumerable: true,
              get: () => {
                throw new Error("ordinary getter must not run");
              },
            },
          },
        );
      }
    }

    const service = new TestService();
    await service.createDefault();
    await service.createExplicit();
    const accessorResult = await service.createWithAccessors();
    await Promise.resolve();

    expect(createSpy.mock.calls[0]?.[0].payload).toEqual({ arguments: [] });
    expect(createSpy.mock.calls[1]?.[0].payload).toEqual({
      arguments: [],
      result: { sessionId: "session-2", refreshToken: "[Redacted]", active: true },
    });
    expect(accessorResult.sessionId).toBe("session-3");
    expect(createSpy.mock.calls[2]?.[0].payload).toEqual({
      arguments: [],
      result: {
        sessionId: "session-3",
        active: true,
        refreshToken: "[Redacted]",
        displayName: "[Accessor]",
      },
    });
  });

  it("should redact secret-bearing labels in persisted error messages", async () => {
    const createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) =>
      createPersistedEntry(entry),
    );
    const repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;

    vi.spyOn(Container, "get").mockReturnValue(repository);
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-error-redaction",
      tenantId: "tenant-error-redaction",
      user: { id: "actor-error-redaction" },
    } as RequestContextStub);

    class TestService {
      @Auditable({ action: "session.fail", resourceType: "Session" })
      async fail(): Promise<void> {
        throw new Error(
          'request failed {"password":"pa\'ss,tail","apiKey":"key\\\"value,tail"}\nCookie: sid=first-secret; csrf=second-secret\nauthorization=Bearer bearer-value',
        );
      }
    }

    await expect(new TestService().fail()).rejects.toThrow("pa'ss,tail");
    await Promise.resolve();

    expect(createSpy.mock.calls[0]?.[0].payload).toEqual({
      arguments: [],
      error:
        'request failed {"password":"[Redacted]","apiKey":"[Redacted]"}\nCookie: [Redacted]\nauthorization=[Redacted]',
    });
  });

  it("should not invoke input accessors while constructing audit payloads", async () => {
    const createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) =>
      createPersistedEntry(entry),
    );
    const repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;
    let accessorCalls = 0;

    vi.spyOn(Container, "get").mockReturnValue(repository);
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-input-accessor",
      tenantId: "tenant-input-accessor",
      user: { id: "actor-input-accessor" },
    } as RequestContextStub);

    const payload = Object.defineProperties(
      { name: "safe-name" },
      {
        diff: {
          enumerable: true,
          get: () => {
            accessorCalls += 1;
            throw new Error("diff getter must not run");
          },
        },
        password: {
          enumerable: true,
          get: () => {
            accessorCalls += 1;
            throw new Error("password getter must not run");
          },
        },
      },
    );

    class TestService {
      @Auditable({
        action: "credential.accessor",
        resourceType: "Credential",
        resourceIdIndex: 0,
        payloadIndex: 1,
      })
      async update(resourceId: string, input: Record<string, unknown>): Promise<string> {
        void input;
        return `updated:${resourceId}`;
      }
    }

    await expect(new TestService().update("credential-2", payload)).resolves.toBe(
      "updated:credential-2",
    );
    await Promise.resolve();

    expect(accessorCalls).toBe(0);
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        diff: null,
        payload: {
          arguments: [
            "credential-2",
            { name: "safe-name", diff: "[Accessor]", password: "[Redacted]" },
          ],
          input: { name: "safe-name", diff: "[Accessor]", password: "[Redacted]" },
        },
      }),
    );
  });

  it("should keep uninspectable diffs within the object-or-null storage contract", async () => {
    const createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) =>
      createPersistedEntry(entry),
    );
    const repository = {
      create: createSpy,
      find: vi.fn(),
    } as unknown as AuditLogRepository;
    const uninspectableDiff = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("diff cannot be inspected");
        },
      },
    );

    vi.spyOn(Container, "get").mockReturnValue(repository);
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-uninspectable-diff",
      tenantId: "tenant-uninspectable-diff",
      user: { id: "actor-uninspectable-diff" },
    } as RequestContextStub);

    class TestService {
      @Auditable({
        action: "credential.diff",
        resourceType: "Credential",
        resourceIdIndex: 0,
        payloadIndex: 1,
      })
      async update(resourceId: string, payload: Record<string, unknown>): Promise<string> {
        void payload;
        return resourceId;
      }
    }

    await expect(
      new TestService().update("credential-3", { diff: uninspectableDiff }),
    ).resolves.toBe("credential-3");
    await Promise.resolve();

    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        diff: null,
      }),
    );
  });

  describe("audit dependency resolution", () => {
    it.each(["repository", "logger"])(
      "should block business execution when the %s is missing in strict mode",
      async (missingDependency) => {
        const business = vi.fn(() => "updated");
        const create = vi.fn();
        if (missingDependency === "logger") {
          Container.set(AUDIT_LOG_REPOSITORY_TOKEN, { create, find: vi.fn() });
        }

        class TestService {
          @Auditable({ action: "project.update", resourceType: "Project", throwOnFailure: true })
          update(): string {
            return business();
          }
        }

        await expect(new TestService().update()).rejects.toThrow(AuditableDecoratorProblem);
        expect(business).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      },
    );

    it.each([true, false, undefined])(
      "should respect throwOnFailure=%s when dependency resolution throws",
      async (throwOnFailure) => {
        vi.spyOn(Container, "getMany").mockImplementation(() => {
          throw new Error("dependency factory failed");
        });
        const business = vi.fn(async () => "updated");

        class TestService {
          @Auditable({ action: "project.update", resourceType: "Project", throwOnFailure })
          async update(): Promise<string> {
            return business();
          }
        }

        const result = new TestService().update();
        if (throwOnFailure) {
          await expect(result).rejects.toThrow(AuditableDecoratorProblem);
          expect(business).not.toHaveBeenCalled();
        } else {
          await expect(result).resolves.toBe("updated");
          expect(business).toHaveBeenCalledTimes(1);
        }
      },
    );
  });

  it("should execute decorated method when audit dependencies are missing", async () => {
    vi.spyOn(Context, "get").mockReturnValue({
      requestId: "req-missing-audit",
      tenantId: "tenant-missing-audit",
      user: { id: "actor-missing-audit" },
    } as RequestContextStub);

    class TestService {
      @Auditable({
        action: "project.update",
        resourceType: "Project",
        resourceIdIndex: 0,
        payloadIndex: 1,
      })
      async update(resourceId: string, payload: { name: string }): Promise<string> {
        return `updated:${resourceId}:${payload.name}`;
      }
    }

    const service = new TestService();

    await expect(service.update("project-missing-audit", { name: "still-runs" })).resolves.toBe(
      "updated:project-missing-audit:still-runs",
    );
  });

  describe("audit log write failure", () => {
    it("should log warning when audit log write fails", async () => {
      const auditError = new Error("database connection failed");
      const createSpy = vi.fn(async () => {
        throw auditError;
      });

      const repository = {
        create: createSpy,
        find: vi.fn(),
      } as unknown as AuditLogRepository;

      const loggerMock: ILogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(function (this: ILogger) {
          return this;
        }),
      };

      vi.spyOn(Container, "get").mockImplementation((token) => {
        if (token === LOGGER_TOKEN) {
          return loggerMock;
        }
        return repository;
      });

      vi.spyOn(Context, "get").mockReturnValue({
        requestId: "req-4",
        tenantId: "tenant-4",
        user: { id: "actor-4" },
      } as RequestContextStub);

      class TestService {
        @Auditable({
          action: "project.update",
          resourceType: "Project",
          resourceIdIndex: 0,
          payloadIndex: 1,
        })
        async update(resourceId: string, payload: { name: string }): Promise<string> {
          return `updated:${resourceId}:${payload.name}`;
        }
      }

      const service = new TestService();
      const result = await service.update("project-4", { name: "updated-project" });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(result).toBe("updated:project-4:updated-project");
      expect(createSpy).toHaveBeenCalled();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "[Auditable] Failed to write audit log",
        expect.objectContaining({
          error: "database connection failed",
        }),
      );
    });

    it("should maintain fire-and-forget pattern when audit log write fails", async () => {
      const auditError = new Error("audit service unavailable");
      let createCallCount = 0;
      const createSpy = vi.fn(async () => {
        createCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw auditError;
      });

      const repository = {
        create: createSpy,
        find: vi.fn(),
      } as unknown as AuditLogRepository;

      const loggerMock: ILogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(function (this: ILogger) {
          return this;
        }),
      };

      vi.spyOn(Container, "get").mockImplementation((token) => {
        if (token === LOGGER_TOKEN) {
          return loggerMock;
        }
        return repository;
      });

      vi.spyOn(Context, "get").mockReturnValue({
        requestId: "req-5",
        tenantId: "tenant-5",
        user: { id: "actor-5" },
      } as RequestContextStub);

      class TestService {
        @Auditable({
          action: "project.create",
          resourceType: "Project",
          resourceIdIndex: 0,
          payloadIndex: 1,
        })
        async create(resourceId: string, payload: { name: string }): Promise<string> {
          return `created:${resourceId}:${payload.name}`;
        }
      }

      const service = new TestService();
      const startTime = Date.now();
      const result = await service.create("project-5", { name: "fast-project" });
      const endTime = Date.now();

      expect(result).toBe("created:project-5:fast-project");
      expect(endTime - startTime).toBeLessThan(50);
      expect(createCallCount).toBe(1);
    });

    it("should propagate audit log write failure when throwOnFailure is enabled", async () => {
      const auditError = new Error("audit persistence failed");
      const createSpy = vi.fn(async () => {
        throw auditError;
      });

      const repository = {
        create: createSpy,
        find: vi.fn(),
      } as unknown as AuditLogRepository;

      const loggerMock: ILogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(function (this: ILogger) {
          return this;
        }),
      };

      vi.spyOn(Container, "get").mockImplementation((token) => {
        if (token === LOGGER_TOKEN) {
          return loggerMock;
        }
        return repository;
      });

      vi.spyOn(Context, "get").mockReturnValue({
        requestId: "req-6",
        tenantId: "tenant-6",
        user: { id: "actor-6" },
      } as RequestContextStub);

      class TestService {
        @Auditable({
          action: "project.create",
          resourceType: "Project",
          resourceIdIndex: 0,
          payloadIndex: 1,
          throwOnFailure: true,
        })
        async create(resourceId: string, payload: { name: string }): Promise<string> {
          return `created:${resourceId}:${payload.name}`;
        }
      }

      const service = new TestService();

      await expect(service.create("project-6", { name: "strict-project" })).rejects.toThrow(
        auditError,
      );
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "[Auditable] Failed to write audit log",
        expect.objectContaining({
          error: "audit persistence failed",
        }),
      );
    });
  });

  describe("impersonation context", () => {
    const nowTimestamp = Date.parse("2026-08-28T00:00:00.000Z");

    function activeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        sessionId: "imp-1",
        impersonatorId: "admin-1",
        targetUserId: "user-1",
        startedAt: new Date(nowTimestamp),
        expiresAt: new Date(nowTimestamp + 60_000),
        ...overrides,
      };
    }

    async function captureAuditEntry(
      impersonation: unknown,
      contextOverride?: RequestContextStub,
    ): Promise<Omit<AuditLogEntry, "id" | "createdAt"> | undefined> {
      const createSpy = vi.fn(async (entry: Omit<AuditLogEntry, "id" | "createdAt">) =>
        createPersistedEntry(entry),
      );
      const repository = {
        create: createSpy,
        find: vi.fn(),
      } as unknown as AuditLogRepository;

      vi.spyOn(Container, "get").mockReturnValue(repository);
      vi.spyOn(Context, "get").mockReturnValue(
        contextOverride ??
          ({
            requestId: "req-impersonation",
            tenantId: "tenant-impersonation",
            user: { id: "actor-1" },
            impersonation,
          } as RequestContextStub),
      );

      class TestService {
        @Auditable({
          action: "project.read",
          resourceType: "Project",
          throwOnFailure: true,
        })
        async read(): Promise<void> {}
      }

      await new TestService().read();

      expect(createSpy).toHaveBeenCalledTimes(1);
      return createSpy.mock.calls[0]?.[0];
    }

    it("should attribute active impersonation to the impersonator", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(nowTimestamp);

      const entry = await captureAuditEntry(activeState());

      expect(entry).toEqual(
        expect.objectContaining({
          actorId: "admin-1",
          metadata: {
            impersonation: true,
            impersonatorId: "admin-1",
            targetUserId: "user-1",
          },
        }),
      );
    });

    it.each([
      ["a truthy non-object", true],
      ["a string", "active"],
      ["a partial object", { sessionId: "imp-1" }],
      ["a blank identifier", activeState({ impersonatorId: "   " })],
      ["a serialized timestamp", activeState({ startedAt: new Date(nowTimestamp).toISOString() })],
      ["an invalid date", activeState({ expiresAt: new Date("invalid") })],
      [
        "a future session",
        activeState({
          startedAt: new Date(nowTimestamp + 1),
          expiresAt: new Date(nowTimestamp + 60_000),
        }),
      ],
      ["a reversed interval", activeState({ expiresAt: new Date(nowTimestamp - 1) })],
      ["a session expiring now", activeState({ expiresAt: new Date(nowTimestamp) })],
      [
        "a throwing accessor",
        Object.defineProperty(activeState(), "sessionId", {
          get: () => {
            throw new Error("untrusted accessor");
          },
        }),
      ],
    ])("should avoid user attribution for %s", async (_description, impersonation) => {
      vi.useFakeTimers();
      vi.setSystemTime(nowTimestamp);

      const entry = await captureAuditEntry(impersonation);

      expect(entry).toEqual(
        expect.objectContaining({
          actorId: "unknown",
          metadata: { impersonation: true, invalidImpersonationContext: true },
        }),
      );
    });

    it("should avoid user attribution for a throwing context accessor", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(nowTimestamp);
      const context = Object.defineProperty(
        {
          requestId: "req-impersonation",
          tenantId: "tenant-impersonation",
          user: { id: "actor-1" },
        },
        "impersonation",
        {
          get: () => {
            throw new Error("untrusted context accessor");
          },
        },
      );

      const entry = await captureAuditEntry(undefined, context);

      expect(entry).toEqual(
        expect.objectContaining({
          actorId: "unknown",
          metadata: { impersonation: true, invalidImpersonationContext: true },
        }),
      );
    });
  });
});
