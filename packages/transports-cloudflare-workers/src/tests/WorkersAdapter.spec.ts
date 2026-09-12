import "reflect-metadata";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { Container, Context as FrameworkContext } from "@croco/framework-context";
import { Logger } from "@croco/framework-logger";
import { Body, Controller, Delete, Get, Param, Post, Put, Raw } from "@croco/protocols-rest";
import type { CrocoApp } from "@croco/transports-http";
import { createApp, ErrorHandler } from "@croco/transports-http";
import { HealthCheckRegistry } from "@croco/transports-http/src/libs/HealthCheckRegistry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toWorkersHandler } from "../libs/adapters/WorkersAdapter";

describe("WorkersAdapter", () => {
  let app!: CrocoApp;
  let observedAbortSignal: AbortSignal | undefined;
  let observedExecutionContext: ExecutionContext | undefined;
  const backgroundTask = Promise.resolve();

  type TestExecutionContext = ExecutionContext & {
    TEST_CTX_VALUE?: string;
  };

  const createExecutionContext = (
    overrides: Partial<TestExecutionContext> = {},
  ): TestExecutionContext =>
    ({
      passThroughOnException: () => {},
      props: {},
      waitUntil: () => {},
      ...overrides,
    }) as TestExecutionContext;

  const mockExecutionContext = createExecutionContext();

  @Controller("/api")
  class TestController {
    @Get("/hello")
    hello() {
      return { message: "Hello, World!" };
    }

    @Get("/users/:id")
    getUser(@Param("id") id: string) {
      return { id, name: "Test User" };
    }

    @Post("/users")
    createUser(@Body() body: { name: string }) {
      return { created: true, data: body };
    }

    @Put("/users/:id")
    updateUser(@Param("id") id: string, @Body() body: { name: string }) {
      return { id, name: body.name };
    }

    @Delete("/users/:id")
    deleteUser(@Param("id") id: string) {
      return { deleted: true, id };
    }

    @Get("/env")
    getEnv(@Raw() raw: unknown) {
      const env = typeof raw === "object" && raw !== null && "env" in raw ? raw.env : undefined;

      return {
        value:
          typeof env === "object" && env !== null && "TEST_VALUE" in env ? env.TEST_VALUE : null,
      };
    }

    @Get("/execution-context")
    getExecutionContext(@Raw() raw: unknown) {
      const executionCtx =
        typeof raw === "object" && raw !== null && "executionCtx" in raw
          ? raw.executionCtx
          : undefined;

      return {
        value:
          typeof executionCtx === "object" &&
          executionCtx !== null &&
          "TEST_CTX_VALUE" in executionCtx
            ? executionCtx.TEST_CTX_VALUE
            : null,
      };
    }

    @Get("/background-task")
    runBackgroundTask(@Raw() raw: { executionCtx: ExecutionContext }) {
      observedExecutionContext = raw.executionCtx;
      raw.executionCtx.waitUntil(backgroundTask);
      return { scheduled: true };
    }

    @Get("/runtime-context")
    getRuntimeContext() {
      const runtime = FrameworkContext.getRuntimeContext();
      const pending = Promise.resolve();

      runtime?.waitUntil(pending);

      return {
        platform: runtime?.platform ?? null,
        requestId: runtime?.requestId ?? null,
        envValue: runtime?.env?.TEST_VALUE ?? null,
        waitUntil: runtime?.capabilities.waitUntil ?? null,
        env: runtime?.capabilities.env ?? null,
        filesystem: runtime?.capabilities.filesystem ?? null,
        nodeApi: runtime?.capabilities.nodeApi ?? null,
        requestLifecycle: runtime?.capabilities.requestLifecycle ?? null,
      };
    }

    @Get("/abort-signal")
    getAbortSignal() {
      const runtime = FrameworkContext.getRuntimeContext();
      observedAbortSignal = runtime?.abortSignal;

      return {
        supported: runtime?.capabilities.abortSignal ?? false,
        present: runtime?.abortSignal !== undefined,
      };
    }
  }

  beforeEach(() => {
    Container.reset();
    observedAbortSignal = undefined;
    observedExecutionContext = undefined;
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      fatal: vi.fn(),
      child: () => logger,
    } as unknown as Logger;
    Container.set(Logger, logger);
    Container.set(ErrorHandler, new ErrorHandler(logger));
    Container.set(HealthCheckRegistry, new HealthCheckRegistry());

    app = createApp({ controllers: [TestController], securityValidation: "off" });
  });

  describe("toWorkersHandler", () => {
    it("should return an object with fetch method", () => {
      const handler = toWorkersHandler(app);

      expect(handler).toBeDefined();
      expect(typeof handler.fetch).toBe("function");
    });

    it("should handle GET request and return app.fetch response", async () => {
      const handler = toWorkersHandler(app);
      const request = new Request("http://localhost/api/hello");
      const env = {};
      const ctx = mockExecutionContext;

      const response = await handler.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ message: "Hello, World!" });
    });

    it("should handle POST request with body", async () => {
      const handler = toWorkersHandler(app);
      const request = new Request("http://localhost/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New User" }),
      });
      const env = {};
      const ctx = mockExecutionContext;

      const response = await handler.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.created).toBe(true);
      expect(json.data).toEqual({ name: "New User" });
    });

    it("should handle PUT request", async () => {
      const handler = toWorkersHandler(app);
      const request = new Request("http://localhost/api/users/1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated User" }),
      });
      const env = {};
      const ctx = mockExecutionContext;

      const response = await handler.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.id).toBe("1");
      expect(json.name).toBe("Updated User");
    });

    it("should handle DELETE request", async () => {
      const handler = toWorkersHandler(app);
      const request = new Request("http://localhost/api/users/1", {
        method: "DELETE",
      });
      const env = {};
      const ctx = mockExecutionContext;

      const response = await handler.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.deleted).toBe(true);
      expect(json.id).toBe("1");
    });

    it("should extract path params correctly", async () => {
      const handler = toWorkersHandler(app);
      const request = new Request("http://localhost/api/users/123");
      const env = {};
      const ctx = mockExecutionContext;

      const response = await handler.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ id: "123", name: "Test User" });
    });

    it("should return 404 for unknown routes", async () => {
      const handler = toWorkersHandler(app);
      const request = new Request("http://localhost/unknown");
      const env = {};
      const ctx = mockExecutionContext;

      const response = await handler.fetch(request, env, ctx);

      expect(response.status).toBe(404);
    });

    it("should inject Cloudflare env when injectEnv is enabled", async () => {
      const handler = toWorkersHandler(app, { injectEnv: true });
      const request = new Request("http://localhost/api/env");
      const env = { TEST_VALUE: "from-worker-env" };
      const ctx = mockExecutionContext;

      const response = await handler.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ value: "from-worker-env" });
    });

    it("should forward Cloudflare execution context when injectEnv is enabled", async () => {
      const handler = toWorkersHandler(app, { injectEnv: true });
      const request = new Request("http://localhost/api/execution-context");
      const env = {};
      const ctx = createExecutionContext({ TEST_CTX_VALUE: "from-worker-ctx" });

      const response = await handler.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ value: "from-worker-ctx" });
    });

    it.each([
      { label: "omitted", options: undefined, expectedEnvValue: null },
      { label: "disabled", options: { injectEnv: false }, expectedEnvValue: null },
      { label: "enabled", options: { injectEnv: true }, expectedEnvValue: "worker-env" },
    ])(
      "should support Hono waitUntil with env injection $label",
      async ({ options, expectedEnvValue }) => {
        const handler = toWorkersHandler(app, options);
        const ctx = createExecutionContext({ waitUntil: vi.fn() });
        const env = { TEST_VALUE: "worker-env" };

        const response = await handler.fetch(
          new Request("http://localhost/api/background-task"),
          env,
          ctx,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ scheduled: true });
        expect(observedExecutionContext).toBe(ctx);
        expect(ctx.waitUntil).toHaveBeenCalledExactlyOnceWith(backgroundTask);

        const envResponse = await handler.fetch(new Request("http://localhost/api/env"), env, ctx);

        expect(envResponse.status).toBe(200);
        await expect(envResponse.json()).resolves.toEqual({ value: expectedEnvValue });
      },
    );

    it("should expose Cloudflare env and waitUntil through RuntimeContext by default", async () => {
      const handler = toWorkersHandler(app);
      const request = new Request("http://localhost/api/runtime-context", {
        headers: {
          "x-request-id": "worker-req-1",
        },
      });
      const env = { TEST_VALUE: "from-runtime-env" };
      const ctx = createExecutionContext({ waitUntil: vi.fn() });

      const response = await handler.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        platform: "cloudflare-workers",
        requestId: "worker-req-1",
        envValue: "from-runtime-env",
        waitUntil: true,
        env: true,
        filesystem: false,
        nodeApi: false,
        requestLifecycle: true,
      });
      expect(ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    });

    it("should propagate the Worker request abort signal through RuntimeContext", async () => {
      const handler = toWorkersHandler(app);
      const controller = new AbortController();
      const request = new Request("http://localhost/api/abort-signal", {
        signal: controller.signal,
      });

      const response = await handler.fetch(request, {}, mockExecutionContext);

      await expect(response.json()).resolves.toEqual({ supported: true, present: true });
      expect(observedAbortSignal).toBe(request.signal);

      controller.abort();

      expect(observedAbortSignal?.aborted).toBe(true);
    });
  });
});
