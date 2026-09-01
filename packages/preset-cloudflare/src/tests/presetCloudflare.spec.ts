import { describe, expect, it, vi } from "vitest";
import type { CloudflareFetchEnv, ExecutionContext } from "../fetch";
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
    expect(createWorkerFetchHandler).toBe(createCloudflareWorkersHost);
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
        capabilities: expect.objectContaining({
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
        }),
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
