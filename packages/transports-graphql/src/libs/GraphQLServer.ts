import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Container, Context as FrameworkContext } from "@croco/framework-context";
import { Logger } from "@croco/framework-logger";
import {
  createProblemResponseDetail,
  createProblemResponseExtensions,
  Problem,
  resolveProblemResponseRedactionPolicy,
} from "@croco/problems-core";
import { isProblem, problemToGraphQLError } from "@croco/protocols-graphql";
import { createYoga, maskError, useExecutionCancellation } from "graphql-yoga";
import {
  GraphQLBodyLimitConfigurationProblem,
  GraphQLRequestBodyAbortedProblem,
  GraphQLRequestBodyTooLargeProblem,
  GraphQLRequestHandlingFailedProblem,
  GraphQLRequestTimeoutConfigurationProblem,
  GraphQLRequestTimeoutProblem,
  GraphQLSchemaNotConfiguredProblem,
  GraphQLServerNotInitializedProblem,
} from "./problems/GraphQLTransportProblems";
import type { GraphQLServerOptions } from "./types";

type YogaHandler = (request: Request) => Promise<Response>;
type NodeRequestAbortScope = {
  readonly aborted: Promise<never>;
  readonly signal: AbortSignal;
  dispose(): void;
};
type NodeRequestPhase =
  | "request-context"
  | "request-url"
  | "request-body"
  | "request-construction"
  | "yoga-execution"
  | "response-headers"
  | "response-body"
  | "response-write";

const DEFAULT_MAX_BODY_SIZE_BYTES = 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;

const CROCO_YOGA_LOGGER = {
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => {
    const [error] = args;
    const problem = getCrocoProblem(error);

    if (problem) {
      console.error(problemToGraphQLError(problem, getGraphQLErrorPath(error)));
      return;
    }

    console.error(...args);
  },
};

export class GraphQLServer {
  private yogaHandler: YogaHandler | null = null;
  private server: Server | null = null;
  private initialized = false;
  private maxBodySizeBytes = DEFAULT_MAX_BODY_SIZE_BYTES;
  private readonly requestTimeoutMs: number | undefined;

  constructor(private options: GraphQLServerOptions = {}) {
    const { requestTimeoutMs } = options;
    if (
      requestTimeoutMs !== undefined &&
      (!Number.isInteger(requestTimeoutMs) ||
        requestTimeoutMs <= 0 ||
        requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS)
    ) {
      throw new GraphQLRequestTimeoutConfigurationProblem();
    }
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const maxBodySizeBytes =
      this.options.maxBodySizeBytes === undefined
        ? DEFAULT_MAX_BODY_SIZE_BYTES
        : this.options.maxBodySizeBytes;
    if (!Number.isSafeInteger(maxBodySizeBytes) || maxBodySizeBytes <= 0) {
      throw new GraphQLBodyLimitConfigurationProblem();
    }
    this.maxBodySizeBytes = maxBodySizeBytes;

    const {
      schema,
      schemaOptions,
      context,
      graphqlEndpoint = "/graphql",
      cors,
      plugins,
    } = this.options;

    let graphqlSchema = schema;

    if (!graphqlSchema && schemaOptions) {
      const { SchemaCompiler } = await import("./SchemaCompiler");
      graphqlSchema = await SchemaCompiler.compileSchema(schemaOptions);
    }

    if (!graphqlSchema) {
      throw new GraphQLSchemaNotConfiguredProblem();
    }

    const yoga = createYoga({
      schema: graphqlSchema,
      graphqlEndpoint,
      cors,
      plugins: [useExecutionCancellation(), ...(plugins ?? [])],
      logging: CROCO_YOGA_LOGGER,
      maskedErrors: {
        maskError: maskCrocoProblemError,
      },
      context: async ({ request }) => {
        const userContext =
          typeof context === "function" ? await context(request) : (context ?? {});
        return {
          ...userContext,
          headers: Object.fromEntries(request.headers),
          request,
        };
      },
    });

    this.yogaHandler = yoga.fetch.bind(yoga) as YogaHandler;

    this.initialized = true;
  }

  getHandler(): YogaHandler {
    if (!this.yogaHandler) {
      throw new GraphQLServerNotInitializedProblem();
    }
    const yoga = this.yogaHandler;
    return async (request: Request) => {
      const requestId = randomUUID();
      return FrameworkContext.run({ requestId }, () => yoga(request));
    };
  }

  async start(port: number): Promise<void> {
    await this.initialize();

    if (!this.yogaHandler) {
      throw new GraphQLServerNotInitializedProblem("Server not initialized.");
    }

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      let phase: NodeRequestPhase = "request-context";
      const abortScope = this.createNodeRequestAbortScope(req, res);

      const nodeRequest = Promise.resolve().then(() => {
        const requestId = randomUUID();
        phase = "request-url";
        return FrameworkContext.run({ requestId }, async () => {
          abortScope.signal.throwIfAborted();
          const host = req.headers.host;
          const baseUrl =
            host && !/[\s\\/?#@]/.test(host) && URL.canParse(`http://${host}`)
              ? `http://${host}`
              : "http://localhost";
          const url = new URL(req.url || "/", baseUrl);
          const method = req.method || "GET";

          let body: string | undefined;

          if (req.method !== "GET" && req.method !== "HEAD") {
            phase = "request-body";
            body = await this.getBody(req, abortScope.signal);
          }

          phase = "request-construction";
          const request = new Request(url, {
            method,
            headers: req.headers as HeadersInit,
            body,
            signal: abortScope.signal,
          });

          if (!this.yogaHandler) {
            throw new GraphQLServerNotInitializedProblem("Server not initialized.");
          }

          phase = "yoga-execution";
          const response = await this.yogaHandler(request);
          abortScope.signal.throwIfAborted();

          phase = "response-headers";
          res.statusCode = response.status;
          const setCookieHeaders = getSetCookieHeaders(response.headers);
          if (setCookieHeaders.length > 0) {
            res.setHeader("set-cookie", setCookieHeaders);
          }
          response.headers.forEach((value: string, key: string) => {
            if (key.toLowerCase() === "set-cookie") return;
            res.setHeader(key, value);
          });

          phase = "response-body";
          const responseBody = await response.text();
          abortScope.signal.throwIfAborted();
          phase = "response-write";
          await this.writeNodeResponse(res, responseBody);
        });
      });
      const requestLifecycle = Promise.race([nodeRequest, abortScope.aborted]);

      void requestLifecycle
        .catch((error: unknown) => this.handleNodeRequestFailure(error, phase, req, res))
        .catch((error: unknown) => {
          this.recordNodeRequestFailure(error, "response-write");
          if (!res.destroyed) {
            this.destroyNodeResponse(res);
          }
        })
        .finally(() => abortScope.dispose());
    };

    this.server = createServer(handler);

    await new Promise<void>((resolve, reject) => {
      this.server?.listen(port, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          try {
            const logger = Container.get(Logger);
            logger.info(
              `GraphQL Server running on http://localhost:${port}${this.options.graphqlEndpoint || "/graphql"}`,
            );
          } catch {
            // Intentionally ignored: Logger is optional for startup logging
          }
          resolve();
        }
      });
    });
  }

  private getBody(req: IncomingMessage, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const maxBodySizeBytes = this.maxBodySizeBytes;
      const contentLength = req.headers["content-length"];

      if (typeof contentLength === "string") {
        const parsedContentLength = Number(contentLength);

        if (Number.isFinite(parsedContentLength) && parsedContentLength > maxBodySizeBytes) {
          reject(new GraphQLRequestBodyTooLargeProblem(maxBodySizeBytes));
          return;
        }
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      const cleanup = () => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("aborted", onAborted);
        signal.removeEventListener("abort", onSignalAbort);
      };

      const onData = (chunk: Buffer) => {
        totalBytes += chunk.length;

        if (totalBytes > maxBodySizeBytes) {
          cleanup();
          req.pause();
          reject(new GraphQLRequestBodyTooLargeProblem(maxBodySizeBytes));
          return;
        }

        chunks.push(chunk);
      };

      const onEnd = () => {
        cleanup();
        resolve(Buffer.concat(chunks).toString());
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onAborted = () => {
        cleanup();
        reject(new GraphQLRequestBodyAbortedProblem());
      };

      const onSignalAbort = () => {
        cleanup();
        reject(signal.reason);
      };

      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("aborted", onAborted);
      signal.addEventListener("abort", onSignalAbort, { once: true });
    });
  }

  private createNodeRequestAbortScope(
    req: IncomingMessage,
    res: ServerResponse,
  ): NodeRequestAbortScope {
    const controller = new AbortController();
    let rejectAbort: (reason: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = (reason: Error) => {
      if (controller.signal.aborted) return;
      controller.abort(reason);
      rejectAbort(reason);
    };
    const onRequestAborted = () =>
      abort(
        req.complete
          ? new GraphQLRequestHandlingFailedProblem()
          : new GraphQLRequestBodyAbortedProblem(),
      );
    const onResponseClose = () => {
      if (!res.writableFinished) {
        abort(new GraphQLRequestHandlingFailedProblem());
      }
    };
    const requestTimeoutMs = this.requestTimeoutMs;
    const timeout =
      requestTimeoutMs === undefined
        ? undefined
        : setTimeout(
            () => abort(new GraphQLRequestTimeoutProblem(requestTimeoutMs)),
            requestTimeoutMs,
          );

    req.once("aborted", onRequestAborted);
    res.once("close", onResponseClose);

    return {
      aborted,
      signal: controller.signal,
      dispose: () => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        req.off("aborted", onRequestAborted);
        res.off("close", onResponseClose);
      },
    };
  }

  private async handleNodeRequestFailure(
    error: unknown,
    phase: NodeRequestPhase,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.recordNodeRequestFailure(error, phase);

    if (res.destroyed || res.writableFinished) {
      return;
    }

    const problem = error instanceof Problem ? error : new GraphQLRequestHandlingFailedProblem();

    if (res.headersSent || res.writableEnded) {
      this.destroyNodeResponse(res);
      return;
    }

    for (const headerName of res.getHeaderNames()) {
      res.removeHeader(headerName);
    }

    const redactionPolicy = resolveProblemResponseRedactionPolicy(problem);
    const detail = createProblemResponseDetail(problem.detail, redactionPolicy);
    const body = {
      type: problem.type,
      title: problem.title,
      status: problem.status,
      code: problem.code,
      ...(detail !== undefined ? { detail } : {}),
      ...createProblemResponseExtensions(problem.extensions, redactionPolicy),
    };

    res.statusCode = problem.status;
    res.setHeader("content-type", "application/problem+json");
    const bodyTooLarge = problem instanceof GraphQLRequestBodyTooLargeProblem;
    if (bodyTooLarge) {
      res.setHeader("connection", "close");
    }
    try {
      await this.writeNodeResponse(res, JSON.stringify(body));
    } finally {
      if (bodyTooLarge) {
        req.destroy();
      }
    }
  }

  private writeNodeResponse(res: ServerResponse, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        res.off("finish", onFinish);
        res.off("error", onError);
        res.off("close", onClose);
      };
      const onFinish = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        if (res.writableFinished) return;
        cleanup();
        reject(new GraphQLRequestHandlingFailedProblem());
      };

      res.once("finish", onFinish);
      res.once("error", onError);
      res.once("close", onClose);

      try {
        res.end(body);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private destroyNodeResponse(res: ServerResponse): void {
    try {
      res.destroy();
    } catch {
      return;
    }
  }

  private recordNodeRequestFailure(error: unknown, phase: NodeRequestPhase): void {
    const problemCode =
      error instanceof Problem ? error.code : "transports-graphql/request-handling-failed";
    const diagnostic = { phase, problemCode };

    try {
      if (Container.has(Logger)) {
        Container.get(Logger).error("GraphQL request failed", diagnostic);
        return;
      }
      console.error("GraphQL request failed", diagnostic);
    } catch {
      try {
        console.error("GraphQL request failed", diagnostic);
      } catch {
        return;
      }
    }
  }

  stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;

  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers);
  }

  const setCookieHeaders: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      setCookieHeaders.push(value);
    }
  });
  return setCookieHeaders;
}

function maskCrocoProblemError(error: unknown, message: string, isDev?: boolean): Error {
  const problem = getCrocoProblem(error);

  if (!problem) {
    return maskError(error, message, isDev);
  }

  return problemToGraphQLError(problem, getGraphQLErrorPath(error));
}

function getCrocoProblem(error: unknown): Problem | undefined {
  let currentError: unknown = error;
  const visited = new Set<Error>();

  while (currentError instanceof Error && !visited.has(currentError)) {
    if (isProblem(currentError)) {
      return currentError;
    }

    visited.add(currentError);

    if (!isGraphQLError(currentError)) {
      return undefined;
    }

    currentError = currentError.originalError;
  }

  return undefined;
}

function getGraphQLErrorPath(error: unknown): readonly (string | number)[] | undefined {
  return error instanceof Error && isGraphQLError(error) ? error.path : undefined;
}

function isGraphQLError(error: Error): error is Error & {
  originalError?: unknown;
  path?: readonly (string | number)[];
} {
  return error.name === "GraphQLError";
}
