import "reflect-metadata";
import { Context } from "@croco/framework-context";
import { recordError } from "@croco/telemetry-api";
import type { AuditLogRepository } from "./AuditLogRepository";
import {
  createAuditCoordinationState,
  markAuditWrite,
  runWithAuditCoordination,
} from "./auditCoordination";
import { AUDIT_METADATA_KEY } from "./constants";
import { resolveImpersonationContext } from "./impersonationState";
import type { AuditExecutionContext, CallHandler, Interceptor } from "./interfaces/Interceptor";
import { AuditClientIpConfigurationProblem } from "./problems/AuditClientIpConfigurationProblem";
import type { AuditLogEntry } from "./types";

type RequestHeaderValue = string | readonly string[] | undefined;

type RequestHeaders = Headers | Record<string, RequestHeaderValue>;

type RequestLike = {
  headers?: RequestHeaders;
  body?: unknown;
  connection?: unknown;
  raw?: unknown;
  remoteAddress?: unknown;
  socket?: unknown;
};

type HttpMetadata = {
  method: string;
  path: string;
  ip: string;
  body?: unknown;
};

type AuditableMetadata = {
  source?: string;
  [key: string]: unknown;
};

class AuditWriteFailureAggregateError extends Error {
  readonly errors: readonly unknown[];

  constructor(errors: readonly unknown[]) {
    super("Handler failure includes audit-write failure evidence");
    this.name = "AuditWriteFailureAggregateError";
    this.errors = errors;
  }
}

function attachAuditWriteCause(handlerError: unknown, auditWriteError: unknown): void {
  if (!(handlerError instanceof Error)) {
    return;
  }

  try {
    const existingCause = (handlerError as Error & { cause?: unknown }).cause;
    const diagnosticCause =
      existingCause === undefined
        ? auditWriteError
        : new AuditWriteFailureAggregateError([existingCause, auditWriteError]);
    Object.defineProperty(handlerError, "cause", {
      configurable: true,
      value: diagnosticCause,
    });
  } catch {
    return;
  }
}

function safelyRecordError(error: unknown): void {
  try {
    recordError(error);
  } catch {
    return;
  }
}

export type AuditInterceptorOptions = {
  readonly trustedProxyHops?: number;
};

function isHeadersInstance(headers: unknown): headers is Headers {
  return headers instanceof Headers;
}

function hasGetMethod(headers: unknown): boolean {
  return typeof (headers as { get?: unknown }).get === "function";
}

function readHeaderValue(
  headers: RequestHeaders | undefined,
  headerName: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (isHeadersInstance(headers)) {
    return headers.get(headerName) ?? undefined;
  }

  if (hasGetMethod(headers)) {
    const getter = (headers as unknown as { get(name: string): string | null }).get;
    const result = getter(headerName);
    if (typeof result === "string") {
      return result;
    }
  }

  const headerRecord = headers as Record<string, RequestHeaderValue>;
  const matches = Object.entries(headerRecord).filter(([key]) => key.toLowerCase() === headerName);
  if (matches.length !== 1) {
    return undefined;
  }

  const value = matches[0]?.[1];
  return typeof value === "string" ? value : undefined;
}

function normalizeIpAddress(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const candidate = value.trim();
  if (!candidate) {
    return undefined;
  }

  if (!candidate.includes(":")) {
    const octets = candidate.split(".");
    if (octets.length !== 4) {
      return undefined;
    }

    const isValidIpv4 = octets.every(
      (octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255,
    );
    return isValidIpv4 ? candidate : undefined;
  }

  if (!/^[0-9a-fA-F:.]+$/.test(candidate)) {
    return undefined;
  }

  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRemoteAddress(value: unknown): string | undefined {
  return normalizeIpAddress(asRecord(value)?.["remoteAddress"]);
}

function resolveLambdaSourceIp(): string | undefined {
  const runtime = Context.getRuntimeContext();
  if (runtime?.platform !== "lambda") {
    return undefined;
  }

  const event = asRecord(runtime.native?.["event"]);
  const requestContext = asRecord(event?.["requestContext"]);
  const http = asRecord(requestContext?.["http"]);
  return normalizeIpAddress(http?.["sourceIp"]);
}

function resolveHttpContextRemoteAddress(context: AuditExecutionContext): string | undefined {
  const getHttpContext = (
    context as AuditExecutionContext & {
      getHttpContext?: () => unknown;
    }
  ).getHttpContext;
  if (typeof getHttpContext !== "function") {
    return undefined;
  }

  const httpContext = asRecord(getHttpContext.call(context));
  const raw = asRecord(httpContext?.["raw"]);
  const env = asRecord(raw?.["env"]);
  const server = asRecord(env?.["server"]);
  const incoming = asRecord(server?.["incoming"] ?? env?.["incoming"]);
  return readRemoteAddress(incoming?.["socket"]);
}

function resolveRequestRemoteAddress(request: Request): string | undefined {
  const requestLike = request as RequestLike;
  const raw = asRecord(requestLike.raw);

  return (
    readRemoteAddress(requestLike.socket) ??
    readRemoteAddress(requestLike.connection) ??
    readRemoteAddress(raw?.["socket"]) ??
    normalizeIpAddress(requestLike.remoteAddress)
  );
}

function resolveDirectIp(context: AuditExecutionContext, request: Request): string {
  return (
    resolveLambdaSourceIp() ??
    resolveHttpContextRemoteAddress(context) ??
    resolveRequestRemoteAddress(request) ??
    "unknown"
  );
}

function resolveForwardedIp(request: Request, trustedProxyHops: number): string | undefined {
  const requestLike = request as RequestLike;
  const forwardedFor = readHeaderValue(requestLike.headers, "x-forwarded-for");
  if (!forwardedFor) {
    return undefined;
  }

  const forwardedAddresses = forwardedFor.split(",").map((candidate) => candidate.trim());
  if (forwardedAddresses.some((candidate) => candidate.length === 0)) {
    return undefined;
  }

  const selectedIndex = forwardedAddresses.length - trustedProxyHops;
  if (selectedIndex < 0) {
    return undefined;
  }

  const trustedBoundary = forwardedAddresses.slice(selectedIndex).map(normalizeIpAddress);
  if (trustedBoundary.some((candidate) => candidate === undefined)) {
    return undefined;
  }

  return trustedBoundary[0];
}

function extractIp(
  context: AuditExecutionContext,
  request: Request,
  trustedProxyHops: number,
): string {
  const directIp = resolveDirectIp(context, request);
  if (trustedProxyHops === 0) {
    return directIp;
  }

  return resolveForwardedIp(request, trustedProxyHops) ?? directIp;
}

function extractRequestBody(request: Request): unknown {
  const requestLike = request as RequestLike;
  return requestLike.body;
}

function toHttpMetadata(context: AuditExecutionContext, trustedProxyHops: number): HttpMetadata {
  const request = context.getRequest();
  const method = context.getMethod();
  const path = context.getPath();
  const ip = extractIp(context, request, trustedProxyHops);
  const body = extractRequestBody(request);

  const metadata: HttpMetadata = {
    method,
    path,
    ip,
  };

  if (body !== undefined) {
    metadata.body = body;
  }

  return metadata;
}

function mergeMetadata(
  existing: AuditableMetadata | undefined,
  impersonation: AuditableMetadata,
  http: HttpMetadata,
): AuditableMetadata {
  const safeExisting = existing && typeof existing === "object" ? existing : {};

  return {
    ...safeExisting,
    ...impersonation,
    http,
  };
}

function resolveAction(controllerName: string, handlerName: string | symbol): string {
  return `${controllerName}.${String(handlerName)}`;
}

function resolveResourceType(controllerName: string): string {
  return controllerName;
}

function resolveResourceId(path: string): string {
  return path;
}

function resolveAuditMetadataTarget(target: object, handler: string | symbol): object {
  let current: object | null = target;
  while (current) {
    if (Reflect.hasOwnMetadata(AUDIT_METADATA_KEY, current, handler)) {
      return current;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return target;
}

export class AuditInterceptor implements Interceptor<AuditExecutionContext> {
  private readonly trustedProxyHops: number;

  constructor(
    private readonly repository: AuditLogRepository,
    options: AuditInterceptorOptions = {},
  ) {
    const trustedProxyHops = options.trustedProxyHops ?? 0;
    if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 0) {
      throw new AuditClientIpConfigurationProblem(
        "Audit trustedProxyHops must be a non-negative safe integer.",
      );
    }

    this.trustedProxyHops = trustedProxyHops;
  }

  private async writeAuditLog(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<void> {
    await this.repository.create(entry);
  }

  async intercept(context: AuditExecutionContext, next: CallHandler): Promise<unknown> {
    const target = context.getClass();
    const handler = context.getHandler();
    const http = toHttpMetadata(context, this.trustedProxyHops);
    const existingMetadata = Reflect.getMetadata(AUDIT_METADATA_KEY, target, handler) as
      | AuditableMetadata
      | undefined;

    const isDecoratorMetadata = existingMetadata?.source === "decorator";
    if (existingMetadata && !isDecoratorMetadata) {
      return next.handle();
    }

    const contextData = Context.get();
    const impersonation = resolveImpersonationContext(contextData);
    const activeImpersonation = impersonation.status === "active" ? impersonation.state : null;
    const actorId =
      activeImpersonation?.impersonatorId ??
      (impersonation.status === "invalid" ? "unknown" : (contextData?.user?.id ?? "unknown"));
    const impersonationMetadata: AuditableMetadata = activeImpersonation
      ? {
          impersonation: true,
          impersonatorId: activeImpersonation.impersonatorId,
          targetUserId: activeImpersonation.targetUserId,
        }
      : impersonation.status === "invalid"
        ? { impersonation: true, invalidImpersonationContext: true }
        : {};
    const controllerName = target.name || "UnknownController";
    const coordination = isDecoratorMetadata
      ? createAuditCoordinationState(resolveAuditMetadataTarget(target, handler), handler)
      : undefined;

    try {
      const result = await (coordination
        ? runWithAuditCoordination(coordination, () => next.handle())
        : next.handle());

      if (coordination?.auditWritten) {
        return result;
      }

      await this.writeAuditLog({
        tenantId: contextData?.tenantId ?? "unknown",
        actorId,
        action: resolveAction(controllerName, handler),
        resourceType: resolveResourceType(controllerName),
        resourceId: resolveResourceId(http.path),
        payload: {
          result,
        },
        diff: null,
        metadata: mergeMetadata(existingMetadata, impersonationMetadata, http),
      });
      if (coordination) {
        markAuditWrite(coordination.target, coordination.propertyKey);
      }

      return result;
    } catch (error) {
      if (coordination?.auditWritten) {
        throw error;
      }

      try {
        await this.writeAuditLog({
          tenantId: contextData?.tenantId ?? "unknown",
          actorId,
          action: resolveAction(controllerName, handler),
          resourceType: resolveResourceType(controllerName),
          resourceId: resolveResourceId(http.path),
          payload: {
            error: error instanceof Error ? error.message : String(error),
          },
          diff: null,
          metadata: mergeMetadata(existingMetadata, impersonationMetadata, http),
        });
        if (coordination) {
          markAuditWrite(coordination.target, coordination.propertyKey);
        }
      } catch (auditWriteError) {
        attachAuditWriteCause(error, auditWriteError);
        safelyRecordError(auditWriteError);
      }

      throw error;
    }
  }
}
