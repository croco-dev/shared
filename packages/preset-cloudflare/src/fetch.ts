import type { RuntimeContextInit } from "@croco/transports-http";

export type CloudflareFetchEnv = {
  readonly [key: string]: unknown;
};

export type ExecutionContext = {
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly passThroughOnException: () => void;
};

type HonoExecutionContext = ExecutionContext & {
  readonly props: unknown;
};

export type CloudflareHostExecutionContext = ExecutionContext & {
  readonly props: unknown;
  readonly exports?: unknown;
};

export type CloudflareFetchHandler = (
  request: Request,
  env: CloudflareFetchEnv,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

export type CloudflareHostFetchHandler = (
  request: Request,
  env: CloudflareFetchEnv,
  ctx: CloudflareHostExecutionContext,
) => Response | Promise<Response>;

export type CloudflareHostRuntimeContext = RuntimeContextInit<"cloudflare-workers">;

/** @deprecated Runtime callbacks should accept `CloudflareHostRuntimeContext`. */
export type CloudflareRuntimeContext = {
  readonly platform: "cloudflare-workers";
  readonly requestId?: string;
  readonly abortSignal: AbortSignal;
  readonly env: Record<string, unknown>;
  readonly native: {
    readonly executionContext: ExecutionContext;
  };
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly capabilities: {
    readonly env: true;
    readonly filesystem: false;
    readonly nodeApi: false;
    readonly requestLifecycle: true;
    readonly waitUntil: true;
    readonly flush: false;
    readonly streamingResponse: true;
    readonly deadline: false;
    readonly abortSignal: true;
    readonly shutdown: false;
  };
};

export type CloudflareAppFetch<TExecutionContext extends ExecutionContext = ExecutionContext> = (
  request: Request,
  runtimeContext?: CloudflareRuntimeContext,
  options?: {
    readonly env?: CloudflareFetchEnv;
    readonly executionContext?: TExecutionContext;
  },
) => Response | Promise<Response>;

export type CloudflareHostAppFetch = (
  request: Request,
  runtimeContext?: CloudflareHostRuntimeContext,
  options?: {
    readonly env?: CloudflareFetchEnv;
    readonly executionContext?: CloudflareHostExecutionContext;
  },
) => Response | Promise<Response>;

export type RawHonoFetch = (
  request: Request,
  env: CloudflareFetchEnv,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

export type CloudflareHostRawHonoFetch = (
  request: Request,
  env: CloudflareFetchEnv,
  ctx: CloudflareHostExecutionContext,
) => Response | Promise<Response>;

export type WorkerFetchHandlerOptions = {
  readonly mode?: "runtime" | "raw-hono";
};

export function createCloudflareWorkersHost(
  honoApp: {
    readonly fetch: CloudflareHostAppFetch | CloudflareHostRawHonoFetch;
  },
  options: WorkerFetchHandlerOptions = {},
): CloudflareHostFetchHandler {
  if (options.mode === "raw-hono") {
    const rawHonoApp = honoApp as { readonly fetch: CloudflareHostRawHonoFetch };
    return async (request, env, ctx) => rawHonoApp.fetch(request, env, ctx);
  }

  return async (
    request: Request,
    env: CloudflareFetchEnv,
    ctx: CloudflareHostExecutionContext,
  ): Promise<Response> => {
    const runtimeContext = createHostRuntimeContext(request, env, ctx);
    const fetch = honoApp.fetch as CloudflareHostAppFetch;

    return fetch.call(honoApp, request, runtimeContext, { env, executionContext: ctx });
  };
}

/** @deprecated Use `createCloudflareWorkersHost`. */
export function createWorkerFetchHandler(
  honoApp: {
    readonly fetch: CloudflareAppFetch | RawHonoFetch;
  },
  options?: WorkerFetchHandlerOptions,
): CloudflareFetchHandler;
export function createWorkerFetchHandler(
  honoApp: {
    readonly fetch: CloudflareAppFetch<
      ExecutionContext & {
        readonly props: unknown;
      }
    >;
  },
  options?: WorkerFetchHandlerOptions,
): CloudflareFetchHandler;
export function createWorkerFetchHandler(
  honoApp: {
    readonly fetch: CloudflareAppFetch | CloudflareAppFetch<HonoExecutionContext> | RawHonoFetch;
  },
  options: WorkerFetchHandlerOptions = {},
): CloudflareFetchHandler {
  if (options.mode === "raw-hono") {
    return createRawHonoWorkerFetchHandler(honoApp as { readonly fetch: RawHonoFetch });
  }

  return async (
    request: Request,
    env: CloudflareFetchEnv,
    ctx: ExecutionContext,
  ): Promise<Response> => {
    const runtimeContext = createLegacyRuntimeContext(request, env, ctx);
    const executionContext = toHonoExecutionContext(ctx);
    const fetch = honoApp.fetch as CloudflareAppFetch<HonoExecutionContext>;

    return fetch.call(honoApp, request, runtimeContext, { env, executionContext });
  };
}

export function createRawHonoWorkerFetchHandler(honoApp: {
  readonly fetch: RawHonoFetch;
}): CloudflareFetchHandler {
  return async (
    request: Request,
    env: CloudflareFetchEnv,
    ctx: ExecutionContext,
  ): Promise<Response> => {
    return honoApp.fetch(request, env, ctx);
  };
}

function createHostRuntimeContext(
  request: Request,
  env: CloudflareFetchEnv,
  ctx: CloudflareHostExecutionContext,
): CloudflareHostRuntimeContext {
  return {
    platform: "cloudflare-workers",
    requestId: request.headers.get("x-request-id") ?? undefined,
    abortSignal: request.signal,
    env: env as Record<string, unknown>,
    native: {
      executionContext: ctx,
    },
    waitUntil: (promise) => ctx.waitUntil(promise),
  };
}

function createLegacyRuntimeContext(
  request: Request,
  env: CloudflareFetchEnv,
  ctx: ExecutionContext,
): CloudflareRuntimeContext {
  return {
    platform: "cloudflare-workers",
    requestId: request.headers.get("x-request-id") ?? undefined,
    abortSignal: request.signal,
    env: env as Record<string, unknown>,
    native: {
      executionContext: ctx,
    },
    waitUntil: (promise) => ctx.waitUntil(promise),
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
  };
}

function toHonoExecutionContext(ctx: ExecutionContext): HonoExecutionContext {
  if ("props" in ctx) {
    return ctx;
  }

  return {
    waitUntil: (promise) => ctx.waitUntil(promise),
    passThroughOnException: () => ctx.passThroughOnException(),
    props: undefined,
  };
}
