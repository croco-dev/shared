import type { ILogger } from "@croco/framework-context";
import type { Hono } from "hono";
import { type RuntimeContextInit, withRuntimeContextEnv } from "./runtimeContext";
import type { LambdaContext, LambdaEvent, LambdaHandler } from "./types";

type FetchDispatcher = Pick<Hono, "fetch">;

type HeadersWithSetCookie = Headers & {
  getSetCookie?: () => string[];
};

type LambdaResponseHeaders = {
  headers: Record<string, string>;
  cookies: string[];
};

function isBinaryContentType(contentType: string): boolean {
  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

  if (mimeType === "") {
    return false;
  }

  if (mimeType.startsWith("text/")) {
    return false;
  }

  if (
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript") ||
    mimeType === "application/x-www-form-urlencoded"
  ) {
    return false;
  }

  return true;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as HeadersWithSetCookie).getSetCookie;
  if (typeof getSetCookie === "function") {
    const cookies = getSetCookie.call(headers);
    if (cookies.length > 0) {
      return cookies;
    }
  }

  const cookies: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      cookies.push(value);
    }
  });

  return cookies;
}

function toLambdaResponseHeaders(headers: Headers): LambdaResponseHeaders {
  const responseHeaders: Record<string, string> = {};
  const cookies = getSetCookieHeaders(headers);

  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      return;
    }

    responseHeaders[key] = value;
  });

  return { headers: responseHeaders, cookies };
}

export interface LambdaExecutionEnv {
  event: LambdaEvent;
  lambdaContext: LambdaContext;
}

export type LambdaExecutionContext = {
  readonly env?: Partial<LambdaExecutionEnv>;
};

export type TypedLambdaHandler = (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<{
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
}>;

export type LambdaHandlerOptions = {
  logger?: ILogger;
  flush?: () => Promise<void> | void;
};

const WAIT_UNTIL_REJECTION_MESSAGE = "Lambda waitUntil task rejected";
const WAIT_UNTIL_REJECTION_REPORTING_FAILURE_MESSAGE =
  "Lambda waitUntil rejection reporting failed";
const LAMBDA_FLUSH_BOUNDARY_ERROR_CODE = "transports-http/lambda-flush-boundary-failed";
const LAMBDA_EVENT_INVALID_CODE = "transports-http/lambda-event-invalid";
const LAMBDA_WAIT_UNTIL_DEADLINE_ERROR_CODE = "transports-http/lambda-wait-until-deadline-exceeded";
const LAMBDA_FLUSH_DIAGNOSTIC_RESERVE_MILLIS = 250;
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647;

type LambdaWaitUntilDeadlineReason = "deadline-exceeded" | "invalid-remaining-time";

type LambdaWaitUntilTaskRecord = {
  readonly index: number;
  observer: Promise<void>;
  result?: PromiseSettledResult<unknown>;
  rejectionReported: boolean;
};

type ValidatedApiGatewayV2Event = {
  method: string;
  path: string;
  queryString: string;
};

function writeWaitUntilDiagnostic(message: string, context: unknown): void {
  let reportingResult: unknown;
  try {
    reportingResult = console.error(message, context);
  } catch {
    return;
  }

  void Promise.resolve(reportingResult).catch(() => undefined);
}

class LambdaFlushBoundaryError extends Error {
  readonly code = LAMBDA_FLUSH_BOUNDARY_ERROR_CODE;
  readonly originalError: unknown;
  readonly flushErrors: readonly unknown[];

  constructor({
    originalError,
    flushErrors,
  }: {
    originalError: unknown;
    flushErrors: readonly unknown[];
  }) {
    super(
      originalError === undefined
        ? "Lambda handler flush callbacks failed"
        : "Lambda handler failed before flush callbacks completed",
    );
    this.name = "LambdaFlushBoundaryError";
    this.originalError = originalError;
    this.flushErrors = [...flushErrors];
  }
}

class LambdaEventValidationError extends Error {
  readonly code = LAMBDA_EVENT_INVALID_CODE;

  constructor(detail: string) {
    super(`Invalid API Gateway v2 Lambda event: ${detail}`);
    this.name = "LambdaEventValidationError";
  }
}

class LambdaWaitUntilDeadlineError extends Error {
  readonly code = LAMBDA_WAIT_UNTIL_DEADLINE_ERROR_CODE;
  readonly reason: LambdaWaitUntilDeadlineReason;
  readonly queuedCount: number;
  readonly inFlightCount: number;
  readonly outstandingTaskIndexes: readonly number[];
  readonly remainingTimeInMillis: number | undefined;

  constructor({
    reason,
    queuedTasks,
    inFlightTasks,
    remainingTimeInMillis,
  }: {
    reason: LambdaWaitUntilDeadlineReason;
    queuedTasks: readonly LambdaWaitUntilTaskRecord[];
    inFlightTasks: readonly LambdaWaitUntilTaskRecord[];
    remainingTimeInMillis: number | undefined;
  }) {
    const queued = queuedTasks.filter((task) => task.result === undefined);
    const inFlight = inFlightTasks.filter((task) => task.result === undefined);
    super(`Lambda waitUntil drain failed: ${reason}`);
    this.name = "LambdaWaitUntilDeadlineError";
    this.reason = reason;
    this.queuedCount = queued.length;
    this.inFlightCount = inFlight.length;
    this.remainingTimeInMillis = remainingTimeInMillis;
    this.outstandingTaskIndexes = [...queued, ...inFlight]
      .map((task) => task.index)
      .sort((left, right) => left - right);
  }
}

function readDiagnosticRemainingTime(lambdaContext: LambdaContext): number | undefined {
  try {
    const remainingTime = lambdaContext.getRemainingTimeInMillis();
    return Number.isFinite(remainingTime) && Number.isSafeInteger(remainingTime)
      ? remainingTime
      : undefined;
  } catch {
    return undefined;
  }
}

function readRequiredString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new LambdaEventValidationError(`${field} must be a string`);
  }

  if (!options.allowEmpty && value.trim().length === 0) {
    throw new LambdaEventValidationError(`${field} must not be empty`);
  }

  return value;
}

function validateApiGatewayV2Event(event: unknown): ValidatedApiGatewayV2Event {
  if (typeof event !== "object" || event === null) {
    throw new LambdaEventValidationError("event must be an object");
  }

  const lambdaEvent = event as LambdaEvent;
  if (lambdaEvent.version !== "2.0") {
    throw new LambdaEventValidationError('version must be "2.0"');
  }

  const path = readRequiredString(lambdaEvent.rawPath, "rawPath");
  if (!path.startsWith("/")) {
    throw new LambdaEventValidationError("rawPath must start with /");
  }

  return {
    method: readRequiredString(
      lambdaEvent.requestContext?.http?.method,
      "requestContext.http.method",
    ),
    path,
    queryString: readRequiredString(lambdaEvent.rawQueryString, "rawQueryString", {
      allowEmpty: true,
    }),
  };
}

function decodeBase64Body(body: string): Uint8Array<ArrayBuffer> {
  const normalized = body.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const paddingIndex = normalized.indexOf("=");
  const dataLength = paddingIndex === -1 ? normalized.length : paddingIndex;
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
    dataLength % 4 === 1 ||
    (paddingIndex !== -1 && normalized.length % 4 !== 0)
  ) {
    throw new LambdaEventValidationError(
      "body must be a valid base64 string when isBase64Encoded is true",
    );
  }

  const decoded = Buffer.from(normalized, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
}

function reportWaitUntilRejections(
  tasks: readonly LambdaWaitUntilTaskRecord[],
  logger: ILogger | undefined,
): void {
  for (const task of tasks) {
    if (task.result?.status !== "rejected" || task.rejectionReported) {
      continue;
    }

    task.rejectionReported = true;
    const reason = task.result.reason;
    if (!logger) {
      writeWaitUntilDiagnostic(WAIT_UNTIL_REJECTION_MESSAGE, reason);
      continue;
    }

    let reportingResult: unknown;
    try {
      reportingResult = logger.error(WAIT_UNTIL_REJECTION_MESSAGE, {
        taskIndex: task.index,
        reason,
      });
    } catch (reportingError) {
      writeWaitUntilDiagnostic(WAIT_UNTIL_REJECTION_REPORTING_FAILURE_MESSAGE, {
        taskIndex: task.index,
        reason,
        reportingError,
      });
      continue;
    }

    void Promise.resolve(reportingResult).catch((reportingError: unknown) => {
      writeWaitUntilDiagnostic(WAIT_UNTIL_REJECTION_REPORTING_FAILURE_MESSAGE, {
        taskIndex: task.index,
        reason,
        reportingError,
      });
    });
  }
}

function createWaitUntilTaskRecord(
  promise: Promise<unknown>,
  index: number,
): LambdaWaitUntilTaskRecord {
  const task: LambdaWaitUntilTaskRecord = {
    index,
    observer: Promise.resolve(),
    rejectionReported: false,
  };
  task.observer = Promise.resolve(promise).then(
    (value) => {
      task.result = { status: "fulfilled", value };
    },
    (reason: unknown) => {
      task.result = { status: "rejected", reason };
    },
  );
  return task;
}

function createWaitUntilDeadline(
  lambdaContext: LambdaContext,
  queuedTasks: readonly LambdaWaitUntilTaskRecord[],
): number {
  const startedAt = Date.now();
  let remainingTime: number;
  try {
    remainingTime = lambdaContext.getRemainingTimeInMillis();
  } catch {
    throw new LambdaWaitUntilDeadlineError({
      reason: "invalid-remaining-time",
      queuedTasks,
      inFlightTasks: [],
      remainingTimeInMillis: readDiagnosticRemainingTime(lambdaContext),
    });
  }
  if (
    !Number.isFinite(remainingTime) ||
    !Number.isSafeInteger(remainingTime) ||
    remainingTime > MAX_TIMER_DELAY_MILLIS
  ) {
    throw new LambdaWaitUntilDeadlineError({
      reason: "invalid-remaining-time",
      queuedTasks,
      inFlightTasks: [],
      remainingTimeInMillis: readDiagnosticRemainingTime(lambdaContext),
    });
  }

  const deadline = startedAt + Math.max(remainingTime - LAMBDA_FLUSH_DIAGNOSTIC_RESERVE_MILLIS, 0);
  if (!Number.isSafeInteger(deadline)) {
    throw new LambdaWaitUntilDeadlineError({
      reason: "invalid-remaining-time",
      queuedTasks,
      inFlightTasks: [],
      remainingTimeInMillis: readDiagnosticRemainingTime(lambdaContext),
    });
  }

  return deadline;
}

function deadlineExceeded(
  lambdaContext: LambdaContext,
  queuedTasks: readonly LambdaWaitUntilTaskRecord[],
  inFlightTasks: readonly LambdaWaitUntilTaskRecord[],
): LambdaWaitUntilDeadlineError {
  return new LambdaWaitUntilDeadlineError({
    reason: "deadline-exceeded",
    queuedTasks,
    inFlightTasks,
    remainingTimeInMillis: readDiagnosticRemainingTime(lambdaContext),
  });
}

async function drainWaitUntilTasks({
  pendingTasks,
  allTasks,
  lambdaContext,
  logger,
}: {
  pendingTasks: LambdaWaitUntilTaskRecord[];
  allTasks: readonly LambdaWaitUntilTaskRecord[];
  lambdaContext: LambdaContext;
  logger: ILogger | undefined;
}): Promise<void> {
  if (pendingTasks.length === 0) {
    return;
  }

  let inFlightTasks: LambdaWaitUntilTaskRecord[] = [];

  try {
    const deadline = createWaitUntilDeadline(lambdaContext, pendingTasks);
    while (pendingTasks.length > 0) {
      if (deadline <= Date.now()) {
        throw deadlineExceeded(lambdaContext, pendingTasks, inFlightTasks);
      }

      inFlightTasks = pendingTasks.splice(0);
      const remainingTime = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const didTimeout = await Promise.race([
        Promise.all(inFlightTasks.map((task) => task.observer)).then(() => false),
        new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), remainingTime);
        }),
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      if (didTimeout) {
        throw deadlineExceeded(lambdaContext, pendingTasks, inFlightTasks);
      }

      reportWaitUntilRejections(allTasks, logger);
      inFlightTasks = [];
    }
  } catch (error) {
    reportWaitUntilRejections(allTasks, logger);
    throw error;
  }
}

async function collectLambdaFlushErrors(
  runtimeContext: RuntimeContextInit,
  options: LambdaHandlerOptions,
): Promise<unknown[]> {
  const errors: unknown[] = [];

  try {
    await runtimeContext.flush?.();
  } catch (error) {
    errors.push(error);
  }

  try {
    await options.flush?.();
  } catch (error) {
    errors.push(error);
  }

  return errors;
}

async function runWithLambdaFlushBoundary<T>(
  execute: () => Promise<T> | T,
  runtimeContext: RuntimeContextInit,
  options: LambdaHandlerOptions,
): Promise<T> {
  let hasOriginalError = false;
  let originalError: unknown;
  let result: T | undefined;
  let flushErrors: unknown[] = [];

  try {
    result = await execute();
  } catch (error) {
    hasOriginalError = true;
    originalError = error;
  } finally {
    flushErrors = await collectLambdaFlushErrors(runtimeContext, options);
  }

  if (flushErrors.length > 0) {
    if (!hasOriginalError && flushErrors.length === 1) {
      throw flushErrors[0];
    }

    throw new LambdaFlushBoundaryError({
      originalError: hasOriginalError ? originalError : undefined,
      flushErrors,
    });
  }

  if (hasOriginalError) {
    throw originalError;
  }

  return result as T;
}

/**
 * Hono 앱을 API Gateway v2 형태의 AWS Lambda 핸들러로 연결하는 어댑터입니다.
 */
export class CrocoLambdaAdapter {
  constructor(private readonly dispatcher: FetchDispatcher) {}

  createHandler(options: LambdaHandlerOptions = {}): LambdaHandler {
    return async (event: LambdaEvent, lambdaContext: LambdaContext) => {
      const pendingTasks: LambdaWaitUntilTaskRecord[] = [];
      const allTasks: LambdaWaitUntilTaskRecord[] = [];
      let activeFlush: Promise<void> | undefined;
      let hasTerminalFlushError = false;
      let terminalFlushError: unknown;
      const flushWaitUntilTasks = (): Promise<void> => {
        if (hasTerminalFlushError) {
          return Promise.reject(terminalFlushError);
        }

        if (activeFlush !== undefined) {
          return activeFlush;
        }

        const flush = drainWaitUntilTasks({
          pendingTasks,
          allTasks,
          lambdaContext,
          logger: options.logger,
        });
        activeFlush = flush;
        void flush.then(
          () => {
            if (activeFlush === flush) {
              activeFlush = undefined;
            }
          },
          (error: unknown) => {
            hasTerminalFlushError = true;
            terminalFlushError = error;
            if (activeFlush === flush) {
              activeFlush = undefined;
            }
          },
        );
        return flush;
      };
      const runtimeContext: RuntimeContextInit = {
        platform: "lambda",
        requestId: event?.requestContext?.requestId ?? lambdaContext.awsRequestId,
        env: process.env,
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
        native: {
          event,
          lambdaContext,
        },
        waitUntil: (promise) => {
          const task = createWaitUntilTaskRecord(Promise.resolve(promise), allTasks.length);
          allTasks.push(task);
          pendingTasks.push(task);
        },
        flush: flushWaitUntilTasks,
        capabilities: {
          env: true,
          filesystem: true,
          nodeApi: true,
          requestLifecycle: true,
          waitUntil: true,
          flush: true,
          streamingResponse: false,
          deadline: true,
          abortSignal: false,
          shutdown: false,
        },
      };

      const executionEnv = withRuntimeContextEnv(
        {
          event,
          lambdaContext,
        },
        runtimeContext,
      ) as LambdaExecutionEnv & Record<string, unknown>;

      const response = await runWithLambdaFlushBoundary(
        () => {
          const { method, path, queryString } = validateApiGatewayV2Event(event);
          const url = `https://lambda.local${path}${queryString ? `?${queryString}` : ""}`;

          const headers = new Headers();
          if (event.headers) {
            for (const [key, value] of Object.entries(event.headers)) {
              if (value !== undefined && value !== null) {
                headers.set(key, value);
              }
            }
          }
          if (event.cookies && event.cookies.length > 0) {
            const cookiesByName = new Map<string, string>();
            for (const source of [headers.get("cookie") ?? "", ...event.cookies]) {
              for (const part of source.split(";")) {
                const cookie = part.trim();
                const separator = cookie.indexOf("=");
                if (separator <= 0) {
                  continue;
                }
                const name = cookie.slice(0, separator).trim();
                if (!cookiesByName.has(name)) {
                  cookiesByName.set(name, cookie);
                }
              }
            }
            headers.set("cookie", [...cookiesByName.values()].join("; "));
          }

          let body: BodyInit | null = null;
          if (event.body) {
            body = event.isBase64Encoded ? decodeBase64Body(event.body) : event.body;
          }

          const request = new Request(url, {
            method,
            headers,
            body: ["GET", "HEAD"].includes(method) ? null : body,
          });

          return this.dispatcher.fetch(request, executionEnv);
        },
        runtimeContext,
        options,
      );

      const contentType = response.headers.get("content-type") ?? "";
      const isBinary = isBinaryContentType(contentType);
      const responseBody = isBinary
        ? Buffer.from(await response.arrayBuffer()).toString("base64")
        : await response.text();
      const { headers: responseHeaders, cookies } = toLambdaResponseHeaders(response.headers);

      return {
        statusCode: response.status,
        headers: responseHeaders,
        ...(cookies.length > 0 ? { cookies } : {}),
        body: responseBody,
        isBase64Encoded: isBinary,
      };
    };
  }

  getExecutionEnv(c: { env: LambdaExecutionEnv }): LambdaExecutionEnv {
    return c.env;
  }
}

/**
 * Hono 컨텍스트에서 원본 Lambda 이벤트를 추출합니다.
 */
export function getLambdaEvent(honoContext: LambdaExecutionContext): LambdaEvent | undefined {
  return honoContext.env?.event;
}

/**
 * Hono 컨텍스트에서 원본 Lambda 컨텍스트를 추출합니다.
 */
export function getLambdaContext(honoContext: LambdaExecutionContext): LambdaContext | undefined {
  return honoContext.env?.lambdaContext;
}
