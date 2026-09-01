import { beforeEach, describe, expect, it } from "vitest";
import { Component, Container } from "@croco/framework-context";
import type { Guard } from "@croco/framework-context";
import { Controller, Get, UseGuards } from "@croco/protocols-rest";
import type { ExecutionContext } from "@croco/protocols-rest";
import { createCrocoApp } from "../app";
import { getUserAuditEntries, resetUserRuntimeForTests } from "../users";

const protectedRouteToken = "generated-smoke-token";

@Component()
class ProtectedRouteGuard implements Guard<ExecutionContext> {
  canActivate(context: ExecutionContext): boolean {
    return context.getRequest().headers.get("authorization") === `Bearer ${protectedRouteToken}`;
  }
}

@Component()
@Controller("/protected-smoke")
class ProtectedSmokeController {
  @Get()
  @UseGuards(ProtectedRouteGuard)
  read() {
    return { ok: true };
  }
}

class MissingProviderGuard implements Guard<ExecutionContext> {
  canActivate(): boolean {
    return true;
  }
}

@Controller("/missing-provider-smoke")
@UseGuards(MissingProviderGuard)
class MissingProviderController {
  @Get()
  @UseGuards(MissingProviderGuard)
  read() {
    return { ok: true };
  }
}

describe("API server", () => {
  beforeEach(() => {
    resetUserRuntimeForTests();
  });

  it("serves users through the operational app", async () => {
    const app = createCrocoApp();

    const response = await app.fetch(new Request("http://localhost/users"));
    const users = (await response.json()) as Array<{ id: string; name: string }>;

    expect(response.status).toBe(200);
    expect(users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "user-1",
          name: "Ada Lovelace",
        }),
      ]),
    );
    expect(users).toHaveLength(2);
  });

  it("creates users through the operational app and publishes the domain event", async () => {
    const app = createCrocoApp();
    const response = await app.fetch(
      new Request("http://localhost/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Katherine Johnson", email: "katherine@example.com" }),
      }),
    );
    const user = await response.json();

    expect(response.status, JSON.stringify(user)).toBe(200);
    expect(user).toEqual(
      expect.objectContaining({
        name: "Katherine Johnson",
        email: "katherine@example.com",
      }),
    );
    expect(getUserAuditEntries()).toContain(user.id);
  });

  it("returns RFC 7807 Problem details for missing users", async () => {
    const app = createCrocoApp();
    const response = await app.fetch(new Request("http://localhost/users/missing"));
    const problem = await response.json();

    expect(response.status).toBe(404);
    expect(problem).toEqual(
      expect.objectContaining({
        status: 404,
        code: "starter/user-not-found",
      }),
    );
  });

  it("requires credentials for a protected route", async () => {
    const app = createCrocoApp({ extraControllers: [ProtectedSmokeController] });

    const denied = await app.fetch(new Request("http://localhost/protected-smoke"));
    const deniedProblem = await denied.json();
    const allowed = await app.fetch(
      new Request("http://localhost/protected-smoke", {
        headers: { authorization: `Bearer ${protectedRouteToken}` },
      }),
    );
    const allowedBody = await allowed.json();

    expect(denied.status).toBe(403);
    expect(deniedProblem).toEqual(
      expect.objectContaining({
        status: 403,
        code: "ACCESS_DENIED",
      }),
    );
    expect(allowed.status).toBe(200);
    expect(allowedBody).toEqual({ ok: true });
  });

  it("re-enters the application scope for retained host callbacks and fences disposal", async () => {
    let observedScopeId: string | undefined;
    const app = createCrocoApp({
      extraMiddlewares: [
        async (_context, next) => {
          observedScopeId = Container.getActiveScopeId();
          await next();
        },
      ],
    });
    const hostCallback = app.getHono().fetch.bind(app.getHono());

    const response = await hostCallback(new Request("http://localhost/users"));

    expect(response.status).toBe(200);
    expect(observedScopeId).toBe(app.applicationRuntime.scopeId);

    await app.disposeApplicationRuntime();

    expect(() => hostCallback(new Request("http://localhost/users"))).toThrow(
      "has already been disposed",
    );
  });

  it("reports an unregistered template provider during bootstrap", () => {
    const previousDiValidation = process.env.CROCO_HTTP_DI_VALIDATION;
    process.env.CROCO_HTTP_DI_VALIDATION = "enforce";

    try {
      const app = createCrocoApp({ extraControllers: [MissingProviderController] });

      let error: unknown;
      try {
        app.lambdaHandler();
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({
        code: "transports-http/di-bootstrap-validation",
        extensions: {
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: "transports-http/di-missing-provider",
              provider: "MissingProviderGuard",
              usages: ["guard MissingProviderGuard for GET /missing-provider-smoke"],
            }),
          ]),
        },
      });
    } finally {
      if (previousDiValidation === undefined) {
        delete process.env.CROCO_HTTP_DI_VALIDATION;
      } else {
        process.env.CROCO_HTTP_DI_VALIDATION = previousDiValidation;
      }
    }
  });
});
