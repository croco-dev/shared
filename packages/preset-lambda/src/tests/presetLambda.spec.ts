import type { LambdaContext, LambdaEvent, RuntimeContextInit } from "@croco/transports-http";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createLambdaBuildTarget,
  createLambdaHandler,
  createLambdaHost,
  createLambdaPreset,
} from "../index";

const lambdaContext: LambdaContext = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "test-function",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:ap-northeast-2:123456789012:function:test-function",
  logGroupName: "/aws/lambda/test-function",
  logStreamName: "2026/03/17/[$LATEST]abcdef",
  memoryLimitInMB: "128",
  awsRequestId: "req-123",
  done: () => undefined,
  fail: () => undefined,
  getRemainingTimeInMillis: () => 5000,
  succeed: () => undefined,
};

function createLambdaEvent(overrides: Partial<LambdaEvent> = {}): LambdaEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: {},
    requestContext: {
      accountId: "123456789012",
      apiId: "api-123",
      domainName: "example.execute-api.ap-northeast-2.amazonaws.com",
      domainPrefix: "example",
      http: {
        method: "GET",
        path: "/",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "gateway-req-123",
      routeKey: "$default",
      stage: "$default",
      time: "17/Mar/2026:12:00:00 +0000",
      timeEpoch: 1710676800000,
    },
    isBase64Encoded: false,
    ...overrides,
  };
}

describe("createLambdaPreset", () => {
  it("exposes separate canonical host and build-target entry points", () => {
    expect(createLambdaPreset).toBe(createLambdaBuildTarget);
    expect(createLambdaHandler).toBe(createLambdaHost);
  });

  it("returns a lambda preset", () => {
    const preset = createLambdaPreset();

    expect(preset.name).toBe("lambda");
    expect(preset.config.name).toBe("lambda");
  });

  it("uses the Lambda handler entry point", () => {
    const preset = createLambdaPreset();

    expect(preset.config.entry).toBe("./handler.js");
  });
});

describe("createLambdaHandler", () => {
  it("creates a Lambda handler function", () => {
    const handler = createLambdaHandler({
      fetch: async () => new Response("ok"),
    });

    expect(typeof handler).toBe("function");
  });

  it("handles a GET event", async () => {
    const handler = createLambdaHandler({
      fetch: async (request: Request) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("https://lambda.local/users?name=croco");

        return new Response("ok", {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        });
      },
    });
    const event = createLambdaEvent({
      rawPath: "/users",
      rawQueryString: "name=croco",
      requestContext: {
        ...createLambdaEvent().requestContext,
        http: {
          ...createLambdaEvent().requestContext.http,
          path: "/users",
        },
      },
    });

    await expect(handler(event, lambdaContext)).resolves.toEqual({
      statusCode: 200,
      headers: {
        "content-type": "text/plain",
      },
      body: "ok",
      isBase64Encoded: false,
    });
  });

  it("preserves the Lambda runtime context for fetch applications", async () => {
    const handler = createLambdaHandler({
      fetch: async (_request: Request, runtimeContext?: RuntimeContextInit) => {
        expect(runtimeContext).toMatchObject({
          platform: "lambda",
          requestId: "gateway-req-123",
          native: {
            event: expect.objectContaining({ version: "2.0" }),
            lambdaContext,
          },
          capabilities: {
            deadline: true,
            env: true,
            flush: true,
            requestLifecycle: true,
            waitUntil: true,
          },
        });

        return new Response("ok");
      },
    });

    await expect(handler(createLambdaEvent(), lambdaContext)).resolves.toMatchObject({
      statusCode: 200,
      body: "ok",
    });
  });

  it.each([
    {
      app: new Hono().get("/", (context) => context.text("hono")),
      branch: "Hono",
    },
    {
      app: { fetch: async () => new Response("fetch") },
      branch: "fetch object",
    },
  ])("flushes before the $branch handler resolves", async ({ app }) => {
    const lifecycle: string[] = [];
    const handler = createLambdaHandler(app, {
      flush: async () => {
        await Promise.resolve();
        lifecycle.push("flush");
      },
    });

    const response = await handler(createLambdaEvent(), lambdaContext);
    lifecycle.push("resolved");

    expect(response.statusCode).toBe(200);
    expect(lifecycle).toEqual(["flush", "resolved"]);
  });

  it("surfaces flush failures", async () => {
    const flushFailure = new Error("telemetry export failed");
    const handler = createLambdaHandler(
      { fetch: async () => new Response("ok") },
      {
        flush: async () => {
          throw flushFailure;
        },
      },
    );

    await expect(handler(createLambdaEvent(), lambdaContext)).rejects.toBe(flushFailure);
  });
});
