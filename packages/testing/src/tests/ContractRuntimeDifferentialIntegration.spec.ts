import "reflect-metadata";
import type { AddressInfo } from "node:net";
import {
  Container,
  Context as FrameworkContext,
  createRuntimeCapabilityManifest,
  type KnownRuntimePlatform,
  type RuntimeCapabilityManifest,
} from "@croco/framework-context";
import {
  createRawHonoWorkerFetchHandler,
  createWorkerFetchHandler,
  type RawHonoFetch,
} from "@croco/preset-cloudflare";
import { buildContractGraph, type ContractGraphRoute } from "@croco/protocols-core";
import {
  Body,
  Controller,
  defineRouteContract,
  Get,
  Header,
  HttpMethod,
  Post,
  Query,
  type RouteBody,
  type RouteMethodReturn,
} from "@croco/protocols-rest";
import {
  createApp,
  startServer,
  type LambdaContext,
  type LambdaEvent,
  type MiddlewareFunction,
  type NodeServerHandle,
} from "@croco/transports-http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONTRACT_RUNTIME_LIFECYCLE_CAPABILITIES,
  type ContractExecutionObservation,
  type ContractGeneratedCase,
  type ContractLifecycleObservation,
  type ContractLifecycleOutcome,
  type ContractRuntimeLifecycleCapability,
  runContractRuntimeDifferential,
} from "../libs/contract-testing";
import { createTestKernel } from "../libs/TestKernel";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const requestSchema = z.object({ name: z.string().min(1) });
const responseSchema = z.object({ accepted: z.boolean(), greeting: z.string() });
const runtimeRouteContract = defineRouteContract({
  id: "testing.runtime-differential.greet",
  method: HttpMethod.POST,
  path: "/runtime-differential/greet",
  operationId: "runtimeDifferentialGreet",
  body: requestSchema,
  response: responseSchema,
});

type RuntimeEvidence = {
  abortSignalPresent: boolean;
  deadlineRemaining: number | undefined;
  flushReturned: boolean;
  shutdownReturned: boolean;
  tracePropagation: unknown;
  waitUntilWorkCompleted: boolean;
};

const runtimeEvidence = new Map<KnownRuntimePlatform, RuntimeEvidence>();
let observedWorkerAbortSignal: AbortSignal | undefined;

@Controller("/runtime-differential")
class ContractRuntimeDifferentialIntegrationController {
  @Post(runtimeRouteContract)
  async greet(
    @Body(runtimeRouteContract) body: RouteBody<typeof runtimeRouteContract>,
  ): Promise<RouteMethodReturn<typeof runtimeRouteContract>> {
    const runtime = FrameworkContext.getRuntimeContext();
    if (!runtime || !isKnownTestPlatform(runtime.platform)) {
      throw new Error("The runtime differential route requires a known adapter runtime context.");
    }

    const evidence: RuntimeEvidence = {
      abortSignalPresent: runtime.abortSignal !== undefined,
      deadlineRemaining: readLambdaRemainingTime(runtime.native),
      flushReturned: false,
      shutdownReturned: false,
      tracePropagation: runtime.trace,
      waitUntilWorkCompleted: false,
    };
    runtimeEvidence.set(runtime.platform, evidence);

    runtime.waitUntil(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          evidence.waitUntilWorkCompleted = true;
          resolve();
        }, 0);
      }),
    );
    await runtime.flush();
    evidence.flushReturned = true;
    await runtime.shutdown();
    evidence.shutdownReturned = true;

    return { accepted: true, greeting: `Hello, ${body.name}` };
  }

  @Get("/worker-context")
  workerContext() {
    observedWorkerAbortSignal = FrameworkContext.getRuntimeContext()?.abortSignal;
    return { ok: true };
  }
}

@Controller("/query-transport")
class QueryTransportController {
  @Get("/")
  read(
    @Query("null-value", z.string().optional()) nullValue: string | undefined,
    @Query("undefined-value", z.string().optional()) undefinedValue: string | undefined,
    @Query("empty", z.array(z.string()).optional()) empty: string[] | undefined,
    @Query("literal", z.array(z.literal("only")).optional()) literal: "only"[] | undefined,
    @Query("values", z.array(z.string()).optional()) values: string[] | undefined,
    @Header("x-literal", z.array(z.literal("only"))) headerLiteral: "only"[],
  ) {
    return {
      emptyOmitted: empty === undefined,
      nullOmitted: nullValue === undefined,
      undefinedOmitted: undefinedValue === undefined,
      literal,
      headerLiteral,
      values,
    };
  }
}

const stableHeaderMiddleware: MiddlewareFunction = async (_context, next) => {
  const response = await next();
  if (response instanceof Response) {
    response.headers.set("x-contract-version", "runtime-differential-v1");
  }
  return response;
};

const route = getRuntimeRoute();
const testCase: ContractGeneratedCase = {
  kind: "valid",
  canarySecret: "croco-canary-runtime-differential",
  input: {
    body: { name: "Ada" },
    headers: { "x-croco-fuzz-canary": "croco-canary-runtime-differential" },
  },
};

describe("ContractRuntimeDifferentialIntegration", () => {
  const servers: NodeServerHandle[] = [];

  beforeEach(() => {
    Container.reset();
    runtimeEvidence.clear();
    observedWorkerAbortSignal = undefined;
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
    runtimeEvidence.clear();
    observedWorkerAbortSignal = undefined;
    Container.reset();
  });

  it("proves one typed contract across real Node, Lambda, and Cloudflare Workers adapter paths without credentials", async () => {
    const app = createApp({
      controllers: [ContractRuntimeDifferentialIntegrationController],
      middlewares: [stableHeaderMiddleware],
      securityValidation: "off",
      diValidation: "off",
    });
    const nodeManifest = createRuntimeCapabilityManifest("node");
    const lambdaManifest = createRuntimeCapabilityManifest("lambda");
    const workersManifest = createRuntimeCapabilityManifest("cloudflare-workers");
    let lambdaFlushCallbacks = 0;
    const lambdaHandler = app.lambdaHandler({
      flush: () => {
        lambdaFlushCallbacks += 1;
      },
    });
    const workerHandler = createRawHonoWorkerFetchHandler(
      app.getHono() as unknown as { readonly fetch: RawHonoFetch },
    );

    const report = await runContractRuntimeDifferential({
      route,
      testCase,
      stableHeaders: ["x-contract-version"],
      targets: [
        {
          runtime: "node",
          capabilities: nodeManifest,
          execute: async (generatedCase) => {
            const server = await startServer(app, 0);
            servers.push(server);
            await waitForListening(server);
            const address = server.address() as AddressInfo | null;
            if (!address) {
              throw new Error("Node adapter did not expose a listening address.");
            }
            const response = await fetch(
              `http://127.0.0.1:${address.port}${runtimeRouteContract.path}`,
              createRequestInit(generatedCase),
            );
            return observeFetchResponse("node", nodeManifest, response, {
              flushCallbacks: 0,
              waitUntilCallbacks: 0,
            });
          },
        },
        {
          runtime: "lambda",
          capabilities: lambdaManifest,
          execute: async (generatedCase) => {
            const response = await lambdaHandler(
              createLambdaEvent(generatedCase),
              createLambdaContext(),
            );
            const evidence = requireRuntimeEvidence("lambda");
            return {
              status: response.statusCode,
              body: JSON.parse(response.body ?? "null") as unknown,
              headers: response.headers,
              tracePropagation: evidence.tracePropagation,
              lifecycle: createLifecycleObservations(lambdaManifest, {
                streamingResponse: unsupported("adapter-buffered-response"),
                deadline:
                  evidence.deadlineRemaining === 5_000
                    ? succeeded("remaining-time-observed")
                    : failed("remaining-time-missing"),
                abortSignal: evidence.abortSignalPresent
                  ? succeeded("request-signal-observed")
                  : unsupported("request-signal-absent"),
                waitUntil: evidence.waitUntilWorkCompleted
                  ? succeeded("adapter-drained")
                  : failed("adapter-returned-before-work"),
                flush:
                  evidence.flushReturned && lambdaFlushCallbacks === 1
                    ? succeeded("callback-completed")
                    : failed("callback-missing"),
                shutdown: evidence.shutdownReturned
                  ? unsupported("runtime-callback-absent")
                  : failed("runtime-call-incomplete"),
              }),
            };
          },
        },
        {
          runtime: "cloudflare-workers",
          capabilities: workersManifest,
          execute: async (generatedCase) => {
            const waitUntilTasks: Promise<unknown>[] = [];
            const executionContext: Parameters<RawHonoFetch>[2] = {
              waitUntil: (promise) => void waitUntilTasks.push(promise),
              passThroughOnException: () => {},
            };
            const response = await workerHandler(
              new Request(
                `https://worker.test${runtimeRouteContract.path}`,
                createRequestInit(generatedCase),
              ),
              {},
              executionContext,
            );
            await Promise.all(waitUntilTasks);
            return observeFetchResponse("cloudflare-workers", workersManifest, response, {
              flushCallbacks: 0,
              waitUntilCallbacks: waitUntilTasks.length,
            });
          },
        },
      ],
    });

    expect(report.status).toBe("passed");
    expect(report.allowedLifecycleDifferences).toEqual([
      "abortSignal",
      "deadline",
      "flush",
      "streamingResponse",
      "waitUntil",
    ]);
    expect(Object.keys(report.observations).sort()).toEqual([
      "cloudflare-workers",
      "lambda",
      "node",
    ]);
  });

  it("passes the Worker request signal through a real CrocoApp runtime handler", async () => {
    const app = createApp({
      controllers: [ContractRuntimeDifferentialIntegrationController],
      securityValidation: "off",
      diValidation: "off",
    });
    const handler = createWorkerFetchHandler(app);
    const request = new Request("https://worker.test/runtime-differential/worker-context");
    const executionContext: Parameters<RawHonoFetch>[2] = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    };

    const response = await handler(request, {}, executionContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(observedWorkerAbortSignal).toBe(request.signal);
  });

  it("omits nullish and empty query values while string-encoding array entries through TestKernel", async () => {
    await using kernel = await createTestKernel({
      adapter: "node",
      bootstrap: () =>
        createApp({
          controllers: [QueryTransportController],
          securityValidation: "off",
          diValidation: "off",
        }),
      fidelity: "adapter",
      validation: { di: "off", security: "off" },
    });

    const response = await kernel.http.get("/query-transport", {
      headers: { "x-literal": "only" },
      query: {
        "null-value": null,
        "undefined-value": undefined,
        empty: [],
        literal: ["only"],
        values: [0, false, null, undefined],
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      emptyOmitted: true,
      nullOmitted: true,
      undefinedOmitted: true,
      literal: ["only"],
      headerLiteral: ["only"],
      values: ["0", "false"],
    });
  });
});

function getRuntimeRoute(): ContractGraphRoute {
  const graph = buildContractGraph([ContractRuntimeDifferentialIntegrationController]);
  const graphRoute = graph.routes.find(
    ({ operationId }) => operationId === "runtimeDifferentialGreet",
  );
  if (!graphRoute) {
    throw new Error(
      "The typed runtime differential route was not emitted into the contract graph.",
    );
  }
  return graphRoute;
}

function isKnownTestPlatform(platform: string): platform is KnownRuntimePlatform {
  return platform === "node" || platform === "lambda" || platform === "cloudflare-workers";
}

function readLambdaRemainingTime(
  native: Readonly<Record<string, unknown>> | undefined,
): number | undefined {
  const lambdaContext = native?.lambdaContext;
  if (
    typeof lambdaContext !== "object" ||
    lambdaContext === null ||
    !("getRemainingTimeInMillis" in lambdaContext) ||
    typeof lambdaContext.getRemainingTimeInMillis !== "function"
  ) {
    return undefined;
  }
  return lambdaContext.getRemainingTimeInMillis();
}

function createRequestInit(generatedCase: ContractGeneratedCase): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      traceparent: TRACEPARENT,
      ...(generatedCase.input.headers as Record<string, string>),
      ...generatedCase.input.transportHeaders,
    },
    body: JSON.stringify(generatedCase.input.body),
  };
}

async function observeFetchResponse(
  platform: "node" | "cloudflare-workers",
  manifest: RuntimeCapabilityManifest,
  response: Response,
  callbacks: { readonly flushCallbacks: number; readonly waitUntilCallbacks: number },
): Promise<ContractExecutionObservation> {
  const evidence = requireRuntimeEvidence(platform);
  const bodyWasStream = response.body instanceof ReadableStream;
  const body = (await response.json()) as unknown;

  return {
    status: response.status,
    body,
    headers: Object.fromEntries(response.headers.entries()),
    tracePropagation: evidence.tracePropagation,
    lifecycle: createLifecycleObservations(manifest, {
      streamingResponse: bodyWasStream
        ? succeeded("response-stream-consumed")
        : failed("response-stream-missing"),
      deadline:
        evidence.deadlineRemaining === undefined
          ? unsupported("native-deadline-absent")
          : succeeded("remaining-time-observed"),
      abortSignal: evidence.abortSignalPresent
        ? succeeded("request-signal-observed")
        : unsupported("request-signal-absent"),
      waitUntil:
        platform === "cloudflare-workers" && callbacks.waitUntilCallbacks === 1
          ? succeeded("adapter-drained")
          : platform === "cloudflare-workers"
            ? failed("adapter-returned-before-work")
            : unsupported("runtime-callback-absent"),
      flush:
        callbacks.flushCallbacks > 0
          ? succeeded("callback-completed")
          : unsupported("runtime-callback-absent"),
      shutdown: evidence.shutdownReturned
        ? unsupported("runtime-callback-absent")
        : failed("runtime-call-incomplete"),
    }),
  };
}

function createLifecycleObservations(
  manifest: RuntimeCapabilityManifest,
  outcomes: Readonly<Record<ContractRuntimeLifecycleCapability, ContractLifecycleOutcome>>,
): Readonly<Record<ContractRuntimeLifecycleCapability, ContractLifecycleObservation>> {
  return Object.fromEntries(
    CONTRACT_RUNTIME_LIFECYCLE_CAPABILITIES.map((capability) => [
      capability,
      {
        supported: manifest.capabilities[capability],
        outcome: outcomes[capability],
      },
    ]),
  ) as Readonly<Record<ContractRuntimeLifecycleCapability, ContractLifecycleObservation>>;
}

function succeeded(value: unknown): ContractLifecycleOutcome {
  return { status: "succeeded", value };
}

function unsupported(reason: unknown): ContractLifecycleOutcome {
  return { status: "unsupported", reason };
}

function failed(message: string): ContractLifecycleOutcome {
  return { status: "failed", error: message };
}

function requireRuntimeEvidence(platform: KnownRuntimePlatform): RuntimeEvidence {
  const evidence = runtimeEvidence.get(platform);
  if (!evidence) {
    throw new Error(`The ${platform} adapter did not expose runtime evidence to the typed route.`);
  }
  return evidence;
}

function createLambdaEvent(generatedCase: ContractGeneratedCase): LambdaEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: runtimeRouteContract.path,
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
      traceparent: TRACEPARENT,
      ...(generatedCase.input.headers as Record<string, string>),
      ...generatedCase.input.transportHeaders,
    },
    requestContext: {
      accountId: "testing",
      apiId: "testing",
      domainName: "lambda.local",
      domainPrefix: "lambda",
      http: {
        method: "POST",
        path: runtimeRouteContract.path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "lambda-runtime-differential",
      routeKey: "$default",
      stage: "$default",
      time: "09/Aug/2026:00:00:00 +0000",
      timeEpoch: 1_786_233_600_000,
    },
    body: JSON.stringify(generatedCase.input.body),
    isBase64Encoded: false,
  };
}

function createLambdaContext(): LambdaContext {
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName: "runtime-differential",
    functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:local:0:function:runtime-differential",
    memoryLimitInMB: "128",
    awsRequestId: "lambda-runtime-differential",
    logGroupName: "/aws/lambda/runtime-differential",
    logStreamName: "local",
    getRemainingTimeInMillis: () => 5_000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

function waitForListening(server: NodeServerHandle): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function closeServer(server: NodeServerHandle): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
