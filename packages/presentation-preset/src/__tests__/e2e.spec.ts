import { createWorkerFetchHandler } from "@croco/preset-cloudflare";
import type { ExecutionContext } from "@croco/preset-cloudflare/src/fetch";
import type { LambdaContext, LambdaEvent } from "@croco/preset-lambda";
import { createLambdaHandler } from "@croco/preset-lambda";
import { createNodeEntry } from "@croco/preset-node";
import { describe, expect, it } from "vitest";

const createExecutionContext = (): ExecutionContext => ({
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: undefined,
});

const createLambdaContext = (): LambdaContext => ({
  callbackWaitsForEmptyEventLoop: false,
  functionName: "test",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:test",
  logGroupName: "/test",
  logStreamName: "test",
  memoryLimitInMB: "128",
  awsRequestId: "test",
  done: () => undefined,
  fail: () => undefined,
  getRemainingTimeInMillis: () => 5000,
  succeed: () => undefined,
});

const createLambdaEvent = (overrides: Partial<LambdaEvent> = {}): LambdaEvent => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: "/",
  rawQueryString: "",
  headers: {},
  requestContext: {
    accountId: "123",
    apiId: "api",
    domainName: "lambda.local",
    domainPrefix: "lambda",
    http: {
      method: "GET",
      path: "/",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "test",
    },
    requestId: "req",
    routeKey: "$default",
    stage: "$default",
    time: new Date().toISOString(),
    timeEpoch: Date.now(),
  },
  isBase64Encoded: false,
  ...overrides,
});

describe("E2E: Lambda preset integration", () => {
  it("handles a GET event and returns 200", async () => {
    const handler = createLambdaHandler({
      fetch: async (request: Request) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("https://lambda.local/api/health");
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const event = createLambdaEvent({
      rawPath: "/api/health",
      requestContext: {
        ...createLambdaEvent().requestContext,
        http: {
          ...createLambdaEvent().requestContext.http,
          method: "GET",
          path: "/api/health",
        },
        routeKey: "GET /api/health",
      },
      routeKey: "GET /api/health",
    });

    const response = await handler(event, createLambdaContext());
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify({ status: "ok" }));
  });

  it("handles a POST event with body", async () => {
    const handler = createLambdaHandler({
      fetch: async (request: Request) => {
        const body = await request.text();
        expect(body).toBe('{"name":"test"}');
        return new Response("created", { status: 201 });
      },
    });

    const event = createLambdaEvent({
      rawPath: "/api/data",
      body: '{"name":"test"}',
      headers: { "content-type": "application/json" },
      requestContext: {
        ...createLambdaEvent().requestContext,
        http: {
          ...createLambdaEvent().requestContext.http,
          method: "POST",
          path: "/api/data",
        },
        routeKey: "POST /api/data",
      },
      routeKey: "POST /api/data",
    });

    const response = await handler(event, createLambdaContext());
    expect(response.statusCode).toBe(201);
  });

  it("handles query string parameters", async () => {
    const handler = createLambdaHandler({
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("page")).toBe("1");
        expect(url.searchParams.get("limit")).toBe("10");
        return new Response("ok", { status: 200 });
      },
    });

    const event = createLambdaEvent({
      rawPath: "/api/items",
      rawQueryString: "page=1&limit=10",
      requestContext: {
        ...createLambdaEvent().requestContext,
        http: {
          ...createLambdaEvent().requestContext.http,
          method: "GET",
          path: "/api/items",
        },
        routeKey: "GET /api/items",
      },
      routeKey: "GET /api/items",
    });

    const response = await handler(event, createLambdaContext());
    expect(response.statusCode).toBe(200);
  });
});

describe("E2E: Cloudflare preset integration", () => {
  it("handles a fetch request and returns 200", async () => {
    const handler = createWorkerFetchHandler({
      fetch: async (request: Request) => {
        expect(request.url).toBe("https://example.com/api/health");
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const request = new Request("https://example.com/api/health");
    const response = await handler(request, {}, createExecutionContext());
    expect(response.status).toBe(200);
  });
});

describe("E2E: Node preset integration", () => {
  it("starts server and makes HTTP request", async () => {
    const entry = createNodeEntry(
      {
        fetch: async (request: Request) => {
          expect(request.method).toBe("GET");
          expect(request.url).toContain("/api/health");
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
      { port: 0, hostname: "127.0.0.1" },
    );

    try {
      await entry.start();
      const address = entry.server?.address();
      expect(address).not.toBeNull();
      const port = typeof address === "object" && address ? address.port : 3000;

      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok" });
    } finally {
      await entry.close();
    }
  });
});
