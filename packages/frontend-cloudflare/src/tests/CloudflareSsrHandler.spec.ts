import type { RenderServer, RuntimeContext } from "@croco/meta-vite";
import { describe, expect, it, vi } from "vitest";
import { createSsrHandler, createSsrHandlerAsFetchHandler } from "../libs/CloudflareSsrHandler";
import { SSR_FAILURE_CODES } from "../libs/types";
import type { SsrFailureReport, SsrWorkerEnv } from "../libs/types";

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

function createStream(payload: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
}

describe("createSsrHandler", () => {
  it("createSsrHandler() returns a function", () => {
    const handler = createSsrHandler();

    expect(handler).toBeInstanceOf(Function);
    expect(handler.length).toBe(3);
  });

  it("function signature type validation - Request, SsrWorkerEnv, ExecutionContext args", async () => {
    const handler = createSsrHandler();

    const mockRequest = new Request("https://example.com/test");
    const mockEnv: SsrWorkerEnv = {};
    const mockCtx = createExecutionContext();

    const result = await handler(mockRequest, mockEnv, mockCtx);

    expect(result).toBeDefined();
    expect(result.status).toBe(500);
    await expect(result.text()).resolves.toBe("No render server configured");
  });

  it("should route API requests through configured apiBindingName", async () => {
    const handler = createSsrHandler({ apiBindingName: "MY_API" });
    const apiResponse = new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
    const customApi = {
      fetch: vi.fn().mockResolvedValue(apiResponse),
    } as unknown as Fetcher;
    const env = {
      MY_API: customApi,
    } as unknown as SsrWorkerEnv;
    const mockCtx = createExecutionContext();

    const result = await handler(new Request("https://example.com/api/users"), env, mockCtx);

    expect(customApi.fetch).toHaveBeenCalledTimes(1);
    expect(customApi.fetch).toHaveBeenCalledWith(expect.any(Request));
    expect(result).toBe(apiResponse);
  });

  it("preserves streaming service-binding API responses", async () => {
    const handler = createSsrHandler({ apiBindingName: "MY_API" });
    const apiResponse = new Response(createStream("streamed api"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    const customApi = {
      fetch: vi.fn().mockResolvedValue(apiResponse),
    } as unknown as Fetcher;
    const env = {
      MY_API: customApi,
    } as unknown as SsrWorkerEnv;

    const result = await handler(
      new Request("https://example.com/api/stream"),
      env,
      createExecutionContext(),
    );
    const reader = result.body?.getReader();

    expect(result).toBe(apiResponse);
    expect(reader).toBeDefined();

    const chunk = await reader?.read();
    expect(chunk?.done).toBe(false);
    expect(new TextDecoder().decode(chunk?.value)).toBe("streamed api");
    expect(result.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it.each(["GET", "HEAD"])(
    "returns a non-404 ASSETS response before API and SSR fallback for %s",
    async (method) => {
      const handler = createSsrHandler({ apiBindingName: "MY_API" });
      const assetResponse = new Response("asset", { status: 200 });
      const assets = {
        fetch: vi.fn().mockResolvedValue(assetResponse),
      } as unknown as Fetcher;
      const api = {
        fetch: vi.fn().mockResolvedValue(new Response("api")),
      } as unknown as Fetcher;
      const env = { ASSETS: assets, MY_API: api } as unknown as SsrWorkerEnv;

      const result = await handler(
        new Request("https://example.com/api/logo.png", { method }),
        env,
        createExecutionContext(),
      );

      expect(result).toBe(assetResponse);
      expect(assets.fetch).toHaveBeenCalledTimes(1);
      expect(api.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "preserves %s request bodies without consulting ASSETS",
    async (method) => {
      for (const pathname of ["/api/users", "/dashboard"]) {
        const payload = JSON.stringify({ message: "preserved body" });
        const request = new Request(`https://example.com${pathname}`, {
          method,
          body: payload,
        });
        const assets = {
          fetch: vi.fn(async (incoming: Request) => {
            await incoming.text();
            return new Response(null, { status: 404 });
          }),
        } as unknown as Fetcher;
        const consumeBody = async (incoming: Request) => {
          expect(incoming).toBe(request);
          expect(incoming.bodyUsed).toBe(false);
          expect(incoming.body?.locked).toBe(false);
          return new Response(await incoming.text());
        };
        const api = { fetch: vi.fn(consumeBody) } as unknown as Fetcher;
        const renderServer = {
          handle: vi.fn(consumeBody),
        } as unknown as RenderServer;
        const handler = createSsrHandler({ renderServer });
        const response = await handler(
          request,
          { ASSETS: assets, API_WORKER: api },
          createExecutionContext(),
        );

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe(payload);
        expect(assets.fetch).not.toHaveBeenCalled();
        expect(api.fetch).toHaveBeenCalledTimes(pathname.startsWith("/api/") ? 1 : 0);
        expect(renderServer.handle).toHaveBeenCalledTimes(pathname.startsWith("/api/") ? 0 : 1);
      }
    },
  );

  it("falls through ASSETS 404 responses to API service binding dispatch", async () => {
    const handler = createSsrHandler({ apiBindingName: "MY_API" });
    const apiResponse = Response.json({ ok: true });
    const assets = {
      fetch: vi.fn().mockResolvedValue(new Response("missing", { status: 404 })),
    } as unknown as Fetcher;
    const api = {
      fetch: vi.fn().mockResolvedValue(apiResponse),
    } as unknown as Fetcher;
    const env = { ASSETS: assets, MY_API: api } as unknown as SsrWorkerEnv;

    const result = await handler(
      new Request("https://example.com/api/users"),
      env,
      createExecutionContext(),
    );

    expect(result).toBe(apiResponse);
    expect(assets.fetch).toHaveBeenCalledTimes(1);
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it("falls through ASSETS failures to SSR with diagnostic evidence", async () => {
    const reports: SsrFailureReport[] = [];
    const renderResponse = new Response("rendered page");
    const renderServer = {
      handle: vi.fn(async () => renderResponse),
    } as unknown as RenderServer;
    const handler = createSsrHandler({
      renderServer,
      onFailure: (report) => {
        reports.push(report);
      },
    });
    const assets = {
      fetch: vi.fn(async () => {
        throw new Error("asset binding unavailable");
      }),
    } as unknown as Fetcher;

    const result = await handler(
      new Request("https://example.com/dashboard?secret=redacted", {
        headers: { "x-croco-correlation-id": "request-asset-1" },
      }),
      { ASSETS: assets },
      createExecutionContext(),
    );

    expect(result).toBe(renderResponse);
    expect(renderServer.handle).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([
      {
        boundary: "asset-binding",
        code: SSR_FAILURE_CODES.ASSET_BINDING,
        correlationId: "request-asset-1",
        error: expect.any(Error),
        method: "GET",
        pathname: "/dashboard",
      },
    ]);
  });

  it("returns a deterministic 500 response when service-binding API routing fails", async () => {
    const reporter = vi.fn();
    const handler = createSsrHandler({ apiBindingName: "MY_API", onFailure: reporter });
    const customApi = {
      fetch: vi.fn(async () => {
        throw new Error("api worker unavailable");
      }),
    } as unknown as Fetcher;

    const result = await handler(
      new Request("https://example.com/api/users", {
        headers: { "x-request-id": "request-api-1" },
      }),
      { MY_API: customApi } as unknown as SsrWorkerEnv,
      createExecutionContext(),
    );

    expect(result.status).toBe(500);
    expect(result.headers.get("content-type")).toBe("application/problem+json");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-croco-diagnostic-code")).toBe(SSR_FAILURE_CODES.API_BINDING);
    expect(result.headers.get("x-croco-correlation-id")).toBe("request-api-1");
    await expect(result.json()).resolves.toEqual({
      type: "about:blank",
      title: "Worker boundary failure",
      status: 500,
      code: SSR_FAILURE_CODES.API_BINDING,
      correlationId: "request-api-1",
    });
    expect(reporter).toHaveBeenCalledWith({
      boundary: "api-binding",
      code: SSR_FAILURE_CODES.API_BINDING,
      correlationId: "request-api-1",
      error: expect.any(Error),
      method: "GET",
      pathname: "/api/users",
    });
    expect(customApi.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes Cloudflare RuntimeContext to the render server", async () => {
    const executionContext = createExecutionContext();
    const env = { FEATURE_FLAG: "enabled" } as unknown as SsrWorkerEnv;
    const renderServer = {
      handle: vi.fn(async (_request, context) =>
        Response.json({
          platform: context?.platform,
          envMatches: context?.env === env,
          executionContextMatches: context?.executionContext === executionContext,
        }),
      ),
    } as unknown as RenderServer;
    const handler = createSsrHandler({ renderServer });

    const response = await handler(
      new Request("https://example.com/dashboard"),
      env,
      executionContext,
    );

    expect(renderServer.handle).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      platform: "cloudflare",
      envMatches: true,
      executionContextMatches: true,
    });
  });

  it("returns a deterministic 500 response when SSR rendering fails", async () => {
    const reporter = vi.fn();
    const renderServer = {
      handle: vi.fn(async () => {
        throw new Error("render failed");
      }),
    } as unknown as RenderServer;
    const handler = createSsrHandler({ renderServer, onFailure: reporter });

    const response = await handler(
      new Request("https://example.com/dashboard", { headers: { "cf-ray": "ray-ssr-1" } }),
      {},
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-croco-diagnostic-code")).toBe(SSR_FAILURE_CODES.SSR_RENDER);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Worker boundary failure",
      status: 500,
      code: SSR_FAILURE_CODES.SSR_RENDER,
      correlationId: "ray-ssr-1",
    });
    expect(reporter).toHaveBeenCalledWith({
      boundary: "ssr-render",
      code: SSR_FAILURE_CODES.SSR_RENDER,
      correlationId: "ray-ssr-1",
      error: expect.any(Error),
      method: "GET",
      pathname: "/dashboard",
    });
  });

  it("preserves the original asset fallback and API failure response when reporters reject", async () => {
    const renderResponse = new Response("rendered page");
    const renderServer = {
      handle: vi.fn(async () => renderResponse),
    } as unknown as RenderServer;
    const assets = {
      fetch: vi.fn(async () => {
        throw new Error("asset secret");
      }),
    } as unknown as Fetcher;
    const api = {
      fetch: vi.fn(async () => {
        throw new Error("api secret");
      }),
    } as unknown as Fetcher;
    const onFailure = vi.fn(async () => {
      throw new Error("reporter unavailable");
    });
    const handler = createSsrHandler({ renderServer, onFailure });

    const pageResponse = await handler(
      new Request("https://example.com/dashboard"),
      { ASSETS: assets },
      createExecutionContext(),
    );
    const apiResponse = await handler(
      new Request("https://example.com/api/users"),
      { API_WORKER: api },
      createExecutionContext(),
    );

    expect(pageResponse).toBe(renderResponse);
    expect(apiResponse.status).toBe(500);
    await expect(apiResponse.text()).resolves.not.toContain("api secret");
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("does not wait for a non-settling reporter before returning fallback and failure responses", async () => {
    const renderResponse = new Response("rendered page");
    const renderServer = {
      handle: vi.fn(async () => renderResponse),
    } as unknown as RenderServer;
    const assets = {
      fetch: vi.fn(async () => {
        throw new Error("asset unavailable");
      }),
    } as unknown as Fetcher;
    const api = {
      fetch: vi.fn(async () => {
        throw new Error("api unavailable");
      }),
    } as unknown as Fetcher;
    const onFailure = vi.fn(() => new Promise<void>(() => {}));
    const handler = createSsrHandler({ renderServer, onFailure });
    const pageExecutionContext = createExecutionContext();
    const apiExecutionContext = createExecutionContext();

    const [pageResponse, apiResponse] = await Promise.all([
      handler(
        new Request("https://example.com/dashboard"),
        { ASSETS: assets },
        pageExecutionContext,
      ),
      handler(
        new Request("https://example.com/api/users"),
        { API_WORKER: api },
        apiExecutionContext,
      ),
    ]);

    expect(pageResponse).toBe(renderResponse);
    expect(apiResponse.status).toBe(500);
    expect(pageExecutionContext.waitUntil).toHaveBeenCalledTimes(1);
    expect(apiExecutionContext.waitUntil).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("preserves streaming render server responses", async () => {
    const renderServer = {
      handle: vi.fn(async () => new Response(createStream("streamed page"))),
    } as unknown as RenderServer;
    const handler = createSsrHandler({ renderServer });

    const response = await handler(
      new Request("https://example.com/stream"),
      {},
      createExecutionContext(),
    );
    const reader = response.body?.getReader();

    expect(reader).toBeDefined();
    const chunk = await reader?.read();
    expect(chunk?.done).toBe(false);
    expect(new TextDecoder().decode(chunk?.value)).toBe("streamed page");
  });
});

describe("createSsrHandlerAsFetchHandler", () => {
  it("uses RuntimeContext env for service-binding API routing", async () => {
    const apiResponse = Response.json({ ok: true });
    const api = {
      fetch: vi.fn().mockResolvedValue(apiResponse),
    } as unknown as Fetcher;
    const env = { API_WORKER: api };
    const context: RuntimeContext = {
      platform: "cloudflare",
      env,
      executionContext: createExecutionContext(),
    };
    const handler = createSsrHandlerAsFetchHandler();

    const response = await handler(new Request("https://example.com/api/users"), context);

    expect(response).toBe(apiResponse);
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes the provided RuntimeContext through to the render server", async () => {
    const context: RuntimeContext = {
      platform: "cloudflare",
      env: { FEATURE_FLAG: "enabled" },
      executionContext: createExecutionContext(),
    };
    const renderServer = {
      handle: vi.fn(async (_request, runtimeContext) =>
        Response.json({
          sameContext: runtimeContext === context,
          featureFlag: (runtimeContext?.env as SsrWorkerEnv | undefined)?.FEATURE_FLAG,
        }),
      ),
    } as unknown as RenderServer;
    const handler = createSsrHandlerAsFetchHandler({ renderServer });

    const response = await handler(new Request("https://example.com/dashboard"), context);

    expect(renderServer.handle).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      sameContext: true,
      featureFlag: "enabled",
    });
  });
});
