import { Problem, ProblemCategory } from "@croco/problems-core";
import type { Constructor, ExecutionContext } from "@croco/protocols-rest";

/**
 * Adapts a tRPC procedure invocation to Croco's controller execution context.
 */
export class TrpcExecutionContext<TContext = unknown> implements ExecutionContext {
  constructor(
    private readonly trpcContext: TContext,
    private readonly controllerClass: Constructor,
    private readonly handlerName: string | symbol,
    private readonly path: string,
    private readonly method: string,
  ) {}

  getRequest(): Request {
    return readRequest(this.trpcContext);
  }

  getClass(): Constructor {
    return this.controllerClass;
  }

  getHandler(): string | symbol {
    return this.handlerName;
  }

  getPath(): string {
    return this.path;
  }

  getMethod(): string {
    return this.method;
  }

  getTrpcContext(): TContext {
    return this.trpcContext;
  }
}

class TrpcRequestUnavailableProblem extends Problem {
  readonly code = "protocols-trpc/request-unavailable";
  readonly category = ProblemCategory.InternalServerError;

  constructor() {
    super(undefined, undefined, "The tRPC context does not contain a supported HTTP request");
  }
}

class TrpcRequestNormalizationProblem extends Problem {
  readonly code = "protocols-trpc/request-normalization-failed";
  readonly category = ProblemCategory.InternalServerError;

  constructor(cause: Error) {
    super(undefined, undefined, "The tRPC HTTP request could not be normalized", { cause });
  }
}

function readRequest(context: unknown): Request {
  if (context instanceof Request) {
    return context;
  }

  if (isRecord(context)) {
    const request = context.request ?? context.req;

    if (request instanceof Request) {
      return request;
    }

    const normalizedRequest = normalizeNodeRequest(request);
    if (normalizedRequest instanceof Request) {
      return normalizedRequest;
    }
    if (normalizedRequest) {
      throw normalizedRequest;
    }
  }

  throw new TrpcRequestUnavailableProblem();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeNodeRequest(
  value: unknown,
): Request | TrpcRequestNormalizationProblem | undefined {
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.method !== "string") {
    return undefined;
  }

  try {
    const headers = new Headers();
    if (isRecord(value.headers)) {
      for (const [name, headerValue] of Object.entries(value.headers)) {
        if (name.startsWith(":")) {
          continue;
        }

        if (typeof headerValue === "string") {
          headers.set(name, headerValue);
        } else if (Array.isArray(headerValue)) {
          for (const item of headerValue) {
            if (typeof item === "string") {
              headers.append(name, item);
            }
          }
        }
      }
    }

    const authority = isRecord(value.headers) ? value.headers[":authority"] : undefined;
    if (!headers.has("host") && typeof authority === "string") {
      headers.set("host", authority);
    }
    const host = headers.get("host") ?? "localhost";
    const encrypted = isRecord(value.socket) && value.socket.encrypted === true;
    const url = new URL(value.url, `${encrypted ? "https" : "http"}://${host}`);

    return new Request(url, { method: value.method, headers });
  } catch (error) {
    return new TrpcRequestNormalizationProblem(toError(error));
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Unknown request normalization failure");
}
