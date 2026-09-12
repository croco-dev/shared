import { createApp } from "@croco/transports-http";
import { describe, expect, it, vi } from "vitest";
import type {
  CloudflareFetchEnv,
  CloudflareHostExecutionContext,
  CloudflareHostRawHonoFetch,
  ExecutionContext,
  RawHonoFetch,
} from "../fetch";
import {
  createCloudflareBuildTarget,
  createCloudflareWorkersHost,
  createCloudflarePreset,
  createRawHonoWorkerFetchHandler,
  createWorkerFetchHandler,
} from "../index";

const createExecutionContext = (): ExecutionContext => ({
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
});

const createHostExecutionContext = (): CloudflareHostExecutionContext => ({
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
});

type PreviousExecutionContext = {
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly passThroughOnException: () => void;
};

type PreviousCloudflareFetchHandler = (
  request: Request,
  env: CloudflareFetchEnv,
  ctx: PreviousExecutionContext,
) => Response | Promise<Response>;

describe("createCloudflarePreset", () => {
  it("exposes separate canonical host and build-target entry points", () => {
    expect(createCloudflarePreset).toBe(createCloudflareBuildTarget);
    expect(createWorkerFetchHandler).not.toBe(createCloudflareWorkersHost);
  });

  it("returns a cloudflare preset", () => {
    const preset = createCloudflarePreset();

    expect(preset.name).toBe("cloudflare");
    expect(preset.config.name).toBe("cloudflare");
  });

  it("uses the Worker fetch entry point", () => {
    const preset = createCloudflarePreset();

    expect(preset.config.entry).toBe("./fetch.js");
  });
});

describe("createWorkerFetchHandler", () => {
  it("returns a function", () => {
    const handler = createWorkerFetchHandler({ fetch: async () => new Response("ok") });

    expect(typeof handler).toBe("function");
  });

  it("accepts execution contexts from the previous public contract", async () => {
    const request = new Request("https://example.com/users");
    const env: CloudflareFetchEnv = {};
    const ctx: PreviousExecutionContext = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    };
    const fetch = vi.fn(async () => new Response("ok"));
    const handler: PreviousCloudflareFetchHandler = createWorkerFetchHandler({ fetch });

    await expect(handler(request, env, ctx)).resolves.toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ native: { executionContext: ctx } }),
      { env, executionContext: expect.objectContaining({ props: undefined }) },
    );
  });

  it("passes requests with runtime context to the app", async () => {
    const request = new Request("https://example.com/users");
    const response = new Response("ok");
    const env: CloudflareFetchEnv = {};
    const ctx = createExecutionContext();
    const fetch = vi.fn(async () => response);
    const handler = createWorkerFetchHandler({ fetch });

    await expect(handler(request, env, ctx)).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        platform: "cloudflare-workers",
        env,
        native: {
          executionContext: ctx,
        },
        capabilities: {
          env: true,
          filesystem: false,
          nodeApi: false,
          requestLifecycle: true,
          waitUntil: true,
          flush: false,
          streamingResponse: true,
          deadline: false,
          abortSignal: true,
          shutdown: false,
        },
      }),
      { env, executionContext: expect.objectContaining({ props: undefined }) },
    );
  });

  it("passes the request abort signal through runtime context", async () => {
    const request = new Request("https://example.com/users");
    const env: CloudflareFetchEnv = {};
    const ctx = createExecutionContext();
    const fetch = vi.fn(async () => new Response("ok"));
    const handler = createWorkerFetchHandler({ fetch });

    await handler(request, env, ctx);

    expect(fetch).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ abortSignal: request.signal }),
      { env, executionContext: expect.objectContaining({ props: undefined }) },
    );
  });

  it("exposes Cloudflare env and waitUntil through runtime context", async () => {
    const request = new Request("https://example.com/users", {
      headers: {
        "x-request-id": "worker-req-1",
      },
    });
    const env: CloudflareFetchEnv = { KV_NAMESPACE: "users-kv" };
    const ctx = createExecutionContext();
    const pending = Promise.resolve();
    const fetch = vi.fn(async (_request: Request, runtimeContext) => {
      runtimeContext?.waitUntil?.(pending);
      return new Response(
        JSON.stringify({
          platform: runtimeContext?.platform,
          requestId: runtimeContext?.requestId,
          value: runtimeContext?.env?.KV_NAMESPACE,
        }),
      );
    });
    const handler = createWorkerFetchHandler({ fetch });

    const response = await handler(request, env, ctx);

    await expect(response.json()).resolves.toEqual({
      platform: "cloudflare-workers",
      requestId: "worker-req-1",
      value: "users-kv",
    });
    expect(ctx.waitUntil).toHaveBeenCalledWith(pending);
  });

  it("preserves the app receiver when invoking fetch", async () => {
    const response = new Response("ok");
    const app = {
      response,
      fetch() {
        return this.response;
      },
    };
    const handler = createCloudflareWorkersHost(app);

    await expect(
      handler(new Request("https://example.com/health"), {}, createHostExecutionContext()),
    ).resolves.toBe(response);
  });

  it("passes initialization context through the canonical host", async () => {
    const request = new Request("https://example.com/users");
    const response = new Response("ok");
    const env: CloudflareFetchEnv = {};
    const ctx = createHostExecutionContext();
    const fetch = vi.fn(async () => response);
    const handler = createCloudflareWorkersHost({ fetch });

    await expect(handler(request, env, ctx)).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        platform: "cloudflare-workers",
        env,
        abortSignal: request.signal,
        waitUntil: expect.any(Function),
      }),
      { env, executionContext: ctx },
    );
  });

  it("requires raw Hono forwarding to select the explicit dispatch mode", async () => {
    const request = new Request("https://example.com/users");
    const response = new Response("ok");
    const env: CloudflareFetchEnv = {};
    const ctx = createHostExecutionContext();
    const fetch: CloudflareHostRawHonoFetch = vi.fn(async () => response);

    // @ts-expect-error Raw Hono callbacks must opt into raw-Hono argument dispatch.
    createCloudflareWorkersHost({ fetch });
    const handler = createCloudflareWorkersHost({ fetch }, { mode: "raw-hono" });

    await expect(handler(request, env, ctx)).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledWith(request, env, ctx);
  });

  it("requires explicit raw dispatch for legacy Hono callbacks", async () => {
    const request = new Request("https://worker.test/legacy");
    const env = { MY_KV: "users-kv" };
    const ctx = createExecutionContext();
    const fetch: RawHonoFetch = vi.fn(async () => new Response("ok"));
    // @ts-expect-error Legacy raw callbacks must not enter runtime dispatch by default.
    createWorkerFetchHandler({ fetch });
    const handler: PreviousCloudflareFetchHandler = createWorkerFetchHandler(
      { fetch },
      { mode: "raw-hono" },
    );

    await expect(handler(request, env, ctx)).resolves.toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request, env, ctx);
  });

  it.each(["legacy", "canonical", "helper"] as const)(
    "preserves real Hono bindings and execution context through the %s raw adapter",
    async (adapter) => {
      const app = createApp({ controllers: [], securityValidation: "off", diValidation: "off" });
      const hono = app.getHono();
      // @ts-expect-error Current Hono dispatch requires an explicit raw mode.
      createWorkerFetchHandler(hono);
      const binding = { value: "users-kv" };
      const env = Object.freeze({ MY_KV: binding });
      const pending = Promise.resolve();
      const ctx = createHostExecutionContext();
      hono.get("/worker-bindings", (c) => {
        const bindings = c.env as typeof env;
        expect(bindings).toBe(env);
        expect(bindings.MY_KV).toBe(binding);
        expect(c.executionCtx).toBe(ctx);
        c.executionCtx.waitUntil(pending);
        c.executionCtx.passThroughOnException();
        return c.text(bindings.MY_KV.value);
      });
      const handler =
        adapter === "legacy"
          ? createWorkerFetchHandler(hono, { mode: "raw-hono" })
          : adapter === "canonical"
            ? createCloudflareWorkersHost(hono, { mode: "raw-hono" })
            : createRawHonoWorkerFetchHandler(hono);

      const response = await handler(new Request("https://worker.test/worker-bindings"), env, ctx);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("users-kv");
      expect(ctx.waitUntil).toHaveBeenCalledExactlyOnceWith(pending);
      expect(ctx.passThroughOnException).toHaveBeenCalledOnce();
      expect(Object.keys(env)).toEqual(["MY_KV"]);
    },
  );

  it("keeps raw Hono forwarding behind an explicit compatibility helper", async () => {
    const request = new Request("https://example.com/users");
    const response = new Response("ok");
    const env: CloudflareFetchEnv = {};
    const ctx = createExecutionContext();
    const fetch = vi.fn(async () => response);
    const handler = createRawHonoWorkerFetchHandler({ fetch });

    await expect(handler(request, env, ctx)).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledWith(request, env, ctx);
  });
});
