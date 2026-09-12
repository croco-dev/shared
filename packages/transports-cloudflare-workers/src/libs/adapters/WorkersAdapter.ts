import type { ExecutionContext } from "@cloudflare/workers-types";
import type { CrocoApp, RuntimeContextInit } from "@croco/transports-http";
import type { CloudflareEnv, WorkersFetchHandler, WorkersHandlerOptions } from "../types";

export function toWorkersHandler(
  app: CrocoApp,
  options: WorkersHandlerOptions = {},
): WorkersFetchHandler {
  const { injectEnv = false } = options;

  return {
    async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
      const runtimeContext = createWorkersRuntimeContext(request, env, ctx);

      if (injectEnv) {
        return app.fetch(request, runtimeContext, { env, executionContext: ctx });
      }

      return app.fetch(request, runtimeContext, { executionContext: ctx });
    },
  };
}

function createWorkersRuntimeContext(
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): RuntimeContextInit {
  return {
    platform: "cloudflare-workers",
    requestId: request.headers.get("x-request-id") ?? undefined,
    abortSignal: request.signal,
    env,
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
