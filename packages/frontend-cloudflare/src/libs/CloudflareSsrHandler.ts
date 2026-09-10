import type { CrocoFetchHandler, RenderServer, RuntimeContext } from "@croco/meta-vite";
import { SSR_FAILURE_CODES } from "./types";
import type { SsrFailureReport, SsrHandlerOptions, SsrWorkerEnv } from "./types";

type CloudflareSsrHandlerOptions = SsrHandlerOptions & { renderServer?: RenderServer };

const DEFAULT_API_BINDING_NAME = "API_WORKER";
const CORRELATION_HEADERS = ["x-croco-correlation-id", "x-request-id", "cf-ray"] as const;

/**
 * Creates a Cloudflare Workers SSR handler using meta-vite's RenderServer.
 *
 * @param options.renderServer - The RenderServer instance for page rendering
 * @param options.apiBindingName - Service Binding name for API worker (default: 'API_WORKER')
 */
export function createSsrHandler(
  options: CloudflareSsrHandlerOptions = {},
): (request: Request, env: SsrWorkerEnv, ctx: ExecutionContext) => Promise<Response> {
  return async (request, env, executionContext): Promise<Response> => {
    return handleSsrRequest(request, options, {
      env,
      runtimeContext: {
        platform: "cloudflare",
        env,
        executionContext,
      },
    });
  };
}

/**
 * Creates a meta-vite CrocoFetchHandler from SSR options.
 * This is the internal handler used by the Cloudflare Workers exported fetch.
 */
export function createSsrHandlerAsFetchHandler(
  options: CloudflareSsrHandlerOptions = {},
): CrocoFetchHandler {
  return async (request: Request, context?: RuntimeContext): Promise<Response> => {
    return handleSsrRequest(request, options, {
      env: context?.env as SsrWorkerEnv | undefined,
      runtimeContext: context,
    });
  };
}

async function handleSsrRequest(
  request: Request,
  options: CloudflareSsrHandlerOptions,
  context: { readonly env?: SsrWorkerEnv; readonly runtimeContext?: RuntimeContext },
): Promise<Response> {
  const { renderServer, apiBindingName = DEFAULT_API_BINDING_NAME } = options;
  const url = new URL(request.url);
  const { env } = context;

  if (env?.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
    try {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        return assetResponse;
      }
    } catch (error) {
      reportBoundaryFailure(request, options, context.runtimeContext?.executionContext, {
        boundary: "asset-binding",
        code: SSR_FAILURE_CODES.ASSET_BINDING,
        error,
      });
    }
  }

  const apiWorker = getFetcherBinding(env, apiBindingName);

  if (apiWorker && url.pathname.startsWith("/api/")) {
    try {
      return await apiWorker.fetch(request);
    } catch (error) {
      const report = reportBoundaryFailure(
        request,
        options,
        context.runtimeContext?.executionContext,
        {
          boundary: "api-binding",
          code: SSR_FAILURE_CODES.API_BINDING,
          error,
        },
      );
      return createFailureResponse(report);
    }
  }

  if (renderServer) {
    try {
      return await renderServer.handle(request, context.runtimeContext);
    } catch (error) {
      const report = reportBoundaryFailure(
        request,
        options,
        context.runtimeContext?.executionContext,
        {
          boundary: "ssr-render",
          code: SSR_FAILURE_CODES.SSR_RENDER,
          error,
        },
      );
      return createFailureResponse(report);
    }
  }

  return new Response("No render server configured", { status: 500 });
}

function getFetcherBinding(
  env: SsrWorkerEnv | undefined,
  bindingName: string,
): Fetcher | undefined {
  const binding = env?.[bindingName];

  if (isFetcher(binding)) {
    return binding;
  }

  return undefined;
}

function isFetcher(value: unknown): value is Fetcher {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof (value as { readonly fetch?: unknown }).fetch === "function"
  );
}

function reportBoundaryFailure(
  request: Request,
  options: CloudflareSsrHandlerOptions,
  executionContext: unknown,
  failure: Pick<SsrFailureReport, "boundary" | "code" | "error">,
): SsrFailureReport {
  const url = new URL(request.url);
  const correlationId = readCorrelationId(request);
  const report: SsrFailureReport = {
    ...failure,
    ...(correlationId ? { correlationId } : {}),
    method: request.method,
    pathname: url.pathname,
  };

  try {
    if (options.onFailure) {
      const reporting = Promise.resolve(options.onFailure(report)).catch(() => undefined);
      if (hasWaitUntil(executionContext)) {
        executionContext.waitUntil(reporting);
      }
    } else {
      logBoundaryFailure(report);
    }
  } catch {
    // Reporting is best-effort and must never replace the original boundary response or fallback.
    return report;
  }

  return report;
}

function hasWaitUntil(value: unknown): value is Pick<ExecutionContext, "waitUntil"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "waitUntil" in value &&
    typeof (value as { readonly waitUntil?: unknown }).waitUntil === "function"
  );
}

function readCorrelationId(request: Request): string | undefined {
  for (const header of CORRELATION_HEADERS) {
    const value = request.headers.get(header)?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function createFailureResponse(report: Pick<SsrFailureReport, "code" | "correlationId">): Response {
  const body = {
    type: "about:blank",
    title: "Worker boundary failure",
    status: 500,
    code: report.code,
    ...(report.correlationId ? { correlationId: report.correlationId } : {}),
  };
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/problem+json",
    "x-croco-diagnostic-code": report.code,
  });

  if (report.correlationId) {
    headers.set("x-croco-correlation-id", report.correlationId);
  }

  return new Response(JSON.stringify(body), { status: 500, headers });
}

function logBoundaryFailure(report: SsrFailureReport): void {
  const message = report.error instanceof Error ? report.error.message : String(report.error);

  // frontend-cloudflare has no DI container dependency (it is an edge runtime package).
  // eslint-disable-next-line no-console
  console.error(`@croco/frontend-cloudflare ${report.code}`, {
    boundary: report.boundary,
    correlationId: report.correlationId,
    method: report.method,
    pathname: report.pathname,
    message,
  });
}
