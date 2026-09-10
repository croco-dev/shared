import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ProblemCategory } from "@croco/problems-core";
import type { RouteIR } from "@croco/protocols-core";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateClientFiles } from "../libs/generate";

const outDir = path.join(os.tmpdir(), "opencode-roundtrip-rpc-codegen");
const moduleDir = path.join(os.tmpdir(), "opencode-roundtrip-rpc-codegen-modules");
const EMPTY_INPUT_SCHEMAS = {
  body: null,
  path: null,
  query: null,
  headers: null,
};
const BODY_INPUT_SCHEMAS: RouteIR["inputSchemas"] = {
  body: z.object({
    name: z.string(),
  }) as unknown as RouteIR["inputSchemas"]["body"],
  path: null,
  query: null,
  headers: null,
};
const PATH_QUERY_INPUT_SCHEMAS = {
  body: null,
  path: z.object({ id: z.string() }) as any,
  query: z.object({
    includePosts: z.boolean(),
    page: z.number(),
    search: z.string().optional(),
    tags: z.array(z.string()),
    deletedAt: z.string().nullable(),
  }) as any,
  headers: null,
};
const HEADER_INPUT_SCHEMAS = {
  body: null,
  path: null,
  query: null,
  headers: z.object({
    authorization: z.string(),
    "x-request-id": z.string().optional(),
  }) as any,
};

describe("rpc-codegen round trip", () => {
  beforeEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(moduleDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(moduleDir, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(moduleDir, { recursive: true, force: true });
  });

  it("generates domain clients that can call a mocked server", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "listUsers",
        httpMethod: "GET",
        path: "/users",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "user",
      },
      {
        controllerName: "UserController",
        methodName: "createUser",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [{ kind: "body", name: "", schema: null }],
        inputSchema: null,
        inputSchemas: BODY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "user",
      },
      {
        controllerName: "OrderController",
        methodName: "listOrders",
        httpMethod: "GET",
        path: "/orders",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "order",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);

    expect(files).toEqual([
      path.join(outDir, "order.ts"),
      path.join(outDir, "user.ts"),
      path.join(outDir, "rpc.ts"),
      path.join(outDir, "index.ts"),
    ]);
    expect(fs.readdirSync(outDir).sort()).toEqual([
      ".croco-rpc-codegen.json",
      "index.ts",
      "order.ts",
      "rpc.ts",
      "user.ts",
    ]);

    const userContent = fs.readFileSync(path.join(outDir, "user.ts"), "utf-8");
    const orderContent = fs.readFileSync(path.join(outDir, "order.ts"), "utf-8");

    expect(userContent).toContain("export function createUserClient(config: RpcClientConfig = {})");
    expect(userContent).toContain("export const userClient = createUserClient();");
    expect(userContent).toContain(
      "listUsers: (options?: RpcClientRequestOptions): Promise<unknown | undefined> =>",
    );
    expect(userContent).toContain(
      "createUser: (input: CreateUserInput, options?: RpcClientRequestOptions): Promise<unknown | undefined> =>",
    );
    expect(userContent).toContain(
      "const request = createRpcClientRequest(userContractRoutes[1], 'mutation', '/users', { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } }, options, config);",
    );
    expect(orderContent).toContain(
      "export function createOrderClient(config: RpcClientConfig = {})",
    );
    expect(orderContent).toContain("export const orderClient = createOrderClient();");
    expect(orderContent).toContain(
      "listOrders: (options?: RpcClientRequestOptions): Promise<unknown | undefined> =>",
    );

    const userModule = await importGeneratedClient("user-path-query.ts", userContent);
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      if (url === "/users" && options.method === "GET") {
        return jsonResponse([{ id: "1", name: "Alice" }]);
      }

      if (url === "/users" && options.method === "POST") {
        return jsonResponse({
          id: "2",
          name: JSON.parse(options.body as string).name,
        });
      }

      return jsonResponse({ message: "not found" }, 404);
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(userModule.userClient.listUsers()).resolves.toEqual([{ id: "1", name: "Alice" }]);
    await expect(userModule.userClient.createUser({ name: "Bob" })).resolves.toEqual({
      id: "2",
      name: "Bob",
    });
    expect(fetchMock).toHaveBeenCalledWith("/users", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith("/users", {
      method: "POST",
      body: JSON.stringify({ name: "Bob" }),
      headers: { "Content-Type": "application/json" },
    });
  });

  it.each([
    [
      "https://api.example.com/api/v1/",
      "/https:/health",
      "https://api.example.com/api/v1/https:/health",
    ],
    [
      "https://api.example.com/api/v1/",
      "/https://elsewhere.example/health",
      "https://api.example.com/api/v1/https://elsewhere.example/health",
    ],
    ["https://api.example.com/api/v1", "/users", "https://api.example.com/api/v1/users"],
    ["https://api.example.com/api/v1/", "users", "https://api.example.com/api/v1/users"],
    ["https://api.example.com/api/v1/", "/users", "https://api.example.com/api/v1/users"],
    ["https://api.example.com/api/v1", "users", "https://api.example.com/api/v1/users"],
    ["https://api.example.com/api/v1///", "///users/", "https://api.example.com/api/v1/users/"],
    ["https://api.example.com", "/users", "https://api.example.com/users"],
    ["https://api.example.com/", "users", "https://api.example.com/users"],
    ["https://api.example.com/api/v1", "/", "https://api.example.com/api/v1/"],
    [
      "https://api.example.com/api%20v1/?old=1#old",
      "/users/a%2Fb?tag=a%26b#section",
      "https://api.example.com/api%20v1/users/a%2Fb?tag=a%26b#section",
    ],
    [undefined, "/users?tag=a%26b", "/users?tag=a%26b"],
  ])(
    "preserves the configured base path for %s and %s",
    async (baseUrl, routePath, expectedUrl) => {
      const files = generateClientFiles(
        [
          {
            controllerName: "UserController",
            methodName: "createUser",
            httpMethod: "POST",
            path: routePath,
            routeContract: null,
            params: [{ kind: "body", name: "", schema: null }],
            inputSchema: null,
            inputSchemas: BODY_INPUT_SCHEMAS,
            outputSchema: null,
            domain: "user",
          },
        ],
        outDir,
      );
      const source = fs.readFileSync(files[0], "utf-8");
      const clientModule = await importGeneratedClient(
        `user-base-path-${encodeURIComponent(String(baseUrl) + routePath)}.ts`,
        source,
      );
      const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
      const client = clientModule.createUserClient({ baseUrl, fetch: fetchMock });

      await client.createUser({ name: "Ada" });

      expect(fetchMock).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({ method: "POST" }),
      );
    },
  );

  it("creates isolated clients with configured transport defaults and request precedence", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getCurrentUser",
        httpMethod: "GET",
        path: "/me",
        routeContract: null,
        params: [{ kind: "header", name: "x-precedence", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: null,
          query: null,
          headers: z.object({ "x-precedence": z.string() }) as any,
        },
        outputSchema: null,
        domain: "user",
      },
      {
        controllerName: "UserController",
        methodName: "createUser",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [{ kind: "body", name: "", schema: null }],
        inputSchema: null,
        inputSchemas: BODY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-configured.ts", userContent);
    const globalFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const configuredFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const signal = new AbortController().signal;
    const client = userModule.createUserClient({
      baseUrl: "https://api.example.com/v1/",
      fetch: configuredFetch,
      headers: [
        ["Authorization", "Bearer default"],
        ["x-precedence", "default"],
        ["x-tag", "default-a"],
        ["X-Tag", "default-b"],
      ],
      request: {
        cache: "no-store",
        credentials: "include",
      },
      telemetry: {
        createHeaders: () => ({
          traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
          "x-precedence": "telemetry",
        }),
      },
    });

    vi.stubGlobal("fetch", globalFetch);

    await client.getCurrentUser(
      { headers: { "x-precedence": "route" } },
      {
        headers: [
          ["authorization", "Bearer request"],
          ["x-precedence", "request"],
          ["x-tag", "request-a"],
          ["X-Tag", "request-b"],
        ],
        request: { credentials: "omit" },
        signal,
      },
    );
    await client.getCurrentUser({ headers: { "x-precedence": "route" } });
    await client.createUser({ name: "Ada" });

    expect(globalFetch).not.toHaveBeenCalled();
    expect(configuredFetch).toHaveBeenNthCalledWith(1, "https://api.example.com/v1/me", {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: {
        authorization: "Bearer request",
        traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
        "x-precedence": "request",
        "X-Tag": "request-a, request-b",
      },
      signal,
    });
    expect(configuredFetch).toHaveBeenNthCalledWith(2, "https://api.example.com/v1/me", {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      headers: {
        Authorization: "Bearer default",
        traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
        "x-precedence": "telemetry",
        "X-Tag": "default-a, default-b",
      },
    });
    expect(configuredFetch).toHaveBeenNthCalledWith(3, "https://api.example.com/v1/users", {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      body: JSON.stringify({ name: "Ada" }),
      headers: {
        Authorization: "Bearer default",
        "Content-Type": "application/json",
        traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
        "x-precedence": "telemetry",
        "X-Tag": "default-a, default-b",
      },
    });
  });

  it("normalizes successful no-output response bodies without regressing empty responses", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "HealthController",
        methodName: "health",
        httpMethod: "GET",
        path: "/health",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "health",
      },
      {
        controllerName: "HealthController",
        methodName: "clear",
        httpMethod: "POST",
        path: "/health/cache",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "health",
      },
      {
        controllerName: "HealthController",
        methodName: "fail",
        httpMethod: "GET",
        path: "/health/fail",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "health",
      },
      {
        controllerName: "HealthController",
        methodName: "status",
        httpMethod: "GET",
        path: "/health/status",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "health",
      },
      {
        controllerName: "HealthController",
        methodName: "malformed",
        httpMethod: "GET",
        path: "/health/malformed",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "health",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const healthContent = fs.readFileSync(files[0], "utf-8");
    const rpcContent = fs.readFileSync(path.join(outDir, "rpc.ts"), "utf-8");
    const healthModule = await importGeneratedClient("health.ts", healthContent);
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/health") {
        return new Response(null, { status: 204 });
      }

      if (url === "/health/fail") {
        return new Response("", { status: 500 });
      }

      if (url === "/health/status") {
        return jsonResponse({ ready: true });
      }

      if (url === "/health/malformed") {
        return textResponse("{not-json", 500);
      }

      return new Response("", { status: 200 });
    });

    vi.stubGlobal("fetch", fetchMock);

    expect(rpcContent).toContain("export async function readOptionalJsonResponse(");
    expect(rpcContent).toContain("async function rejectErrorResponse(");
    await expect(healthModule.healthClient.health()).resolves.toBeUndefined();
    await expect(healthModule.healthClient.clear()).resolves.toBeUndefined();
    await expect(healthModule.healthClient.status()).resolves.toEqual({ ready: true });
    await expect(healthModule.healthClient.fail()).rejects.toThrow(
      "RPC request failed with HTTP 500",
    );
    const malformedError = await getRejectedError(healthModule.healthClient.malformed());
    expect(malformedError).toMatchObject({
      name: "RpcClientResponseError",
      response: expect.objectContaining({ status: 500 }),
    });
    expect((malformedError as { readonly cause?: unknown }).cause).toBeInstanceOf(SyntaxError);

    const malformedResult = await healthModule.healthClient.malformedResult();
    expect(malformedResult).toMatchObject({
      ok: false,
      kind: "external",
      response: expect.objectContaining({ status: 500 }),
      error: expect.objectContaining({ name: "RpcClientResponseError" }),
    });
    if (malformedResult.ok || malformedResult.kind !== "external") {
      expect.fail("Expected an external failure result.");
    }
    expect((malformedResult.error as { readonly cause?: unknown }).cause).toBeInstanceOf(
      SyntaxError,
    );
    expect(fetchMock).toHaveBeenCalledWith("/health", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith("/health/cache", { method: "POST" });
    expect(fetchMock).toHaveBeenCalledWith("/health/fail", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith("/health/status", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith("/health/malformed", { method: "GET" });
  });

  it.each(["inline", "frontend-problems"] as const)(
    "preserves response body cancellation with the %s problem runtime",
    async (problemRuntime) => {
      const routeIRs: RouteIR[] = [
        {
          controllerName: "HealthController",
          methodName: "requiredAbort",
          httpMethod: "GET",
          path: "/health/required-abort",
          routeContract: null,
          params: [],
          inputSchema: null,
          inputSchemas: EMPTY_INPUT_SCHEMAS,
          outputSchema: z.object({ ready: z.boolean() }) as unknown as RouteIR["outputSchema"],
          domain: "health",
        },
        {
          controllerName: "HealthController",
          methodName: "optionalAbort",
          httpMethod: "GET",
          path: "/health/optional-abort",
          routeContract: null,
          params: [],
          inputSchema: null,
          inputSchemas: EMPTY_INPUT_SCHEMAS,
          outputSchema: null,
          domain: "health",
        },
        {
          controllerName: "HealthController",
          methodName: "requiredErrorAbort",
          httpMethod: "GET",
          path: "/health/required-error-abort",
          routeContract: null,
          params: [],
          inputSchema: null,
          inputSchemas: EMPTY_INPUT_SCHEMAS,
          outputSchema: z.object({ ready: z.boolean() }) as unknown as RouteIR["outputSchema"],
          domain: "health",
        },
        {
          controllerName: "HealthController",
          methodName: "mutationErrorAbort",
          httpMethod: "POST",
          path: "/health/mutation-error-abort",
          routeContract: null,
          params: [],
          inputSchema: null,
          inputSchemas: EMPTY_INPUT_SCHEMAS,
          outputSchema: z.object({ ready: z.boolean() }) as unknown as RouteIR["outputSchema"],
          domain: "health",
        },
      ];
      const files = generateClientFiles(routeIRs, outDir, { problemRuntime });
      const healthContent = fs.readFileSync(files[0], "utf-8");
      const healthModule = await importGeneratedClient(
        `health-response-abort-${problemRuntime}.ts`,
        healthContent,
      );
      const events: Record<string, unknown>[] = [];
      const telemetry = {
        record: (event: Record<string, unknown>) => {
          events.push(event);
        },
      };
      const cases = [
        {
          createResponse: unreadableJsonResponse,
          invoke: (options: unknown) => healthModule.healthClient.requiredAbort(options),
        },
        {
          createResponse: unreadableJsonResponse,
          invoke: (options: unknown) => healthModule.healthClient.requiredAbortResult(options),
        },
        {
          createResponse: unreadableTextResponse,
          invoke: (options: unknown) => healthModule.healthClient.optionalAbort(options),
        },
        {
          createResponse: unreadableTextResponse,
          invoke: (options: unknown) => healthModule.healthClient.optionalAbortResult(options),
        },
      ];

      for (const testCase of cases) {
        events.length = 0;
        const abort = createAbortError();
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => testCase.createResponse(abort)),
        );

        await expect(testCase.invoke({ telemetry })).rejects.toBe(abort);
        expect(events.map((event) => event.kind)).toEqual([
          "rpc.request.started",
          "rpc.request.cancelled",
        ]);
      }

      if (problemRuntime === "frontend-problems") {
        return;
      }

      const errorCases = [
        {
          invoke: (options: unknown) => healthModule.healthClient.requiredErrorAbort(options),
          returnsResult: false,
          expectedEvents: ["rpc.request.started", "rpc.request.cancelled"],
        },
        {
          invoke: (options: unknown) => healthModule.healthClient.requiredErrorAbortResult(options),
          returnsResult: true,
          expectedEvents: ["rpc.request.started", "rpc.request.cancelled"],
        },
        {
          invoke: (options: unknown) => healthModule.healthClient.mutationErrorAbort(options),
          returnsResult: false,
          expectedEvents: [
            "rpc.request.started",
            "rpc.mutation.started",
            "rpc.request.cancelled",
            "rpc.mutation.cancelled",
          ],
        },
        {
          invoke: (options: unknown) => healthModule.healthClient.mutationErrorAbortResult(options),
          returnsResult: true,
          expectedEvents: [
            "rpc.request.started",
            "rpc.mutation.started",
            "rpc.request.cancelled",
            "rpc.mutation.cancelled",
          ],
        },
      ];

      for (const testCase of errorCases) {
        events.length = 0;
        const abort = createAbortError();
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => unreadableJsonResponse(abort, 500)),
        );

        if (testCase.returnsResult) {
          await expect(testCase.invoke({ telemetry })).resolves.toMatchObject({
            ok: false,
            kind: "external",
            error: abort,
            response: expect.objectContaining({ status: 500 }),
          });
        } else {
          await expect(testCase.invoke({ telemetry })).rejects.toBe(abort);
        }
        expect(events.map((event) => event.kind)).toEqual(testCase.expectedEvents);
      }
    },
  );

  it.each(["inline", "frontend-problems"] as const)(
    "keeps successful response telemetry failures separate with the %s problem runtime",
    async (problemRuntime) => {
      const routeIRs: RouteIR[] = [
        {
          controllerName: "HealthController",
          methodName: "requiredTelemetry",
          httpMethod: "GET",
          path: "/health/required-telemetry",
          routeContract: null,
          params: [],
          inputSchema: null,
          inputSchemas: EMPTY_INPUT_SCHEMAS,
          outputSchema: z.object({ ready: z.boolean() }) as unknown as RouteIR["outputSchema"],
          domain: "health",
        },
        {
          controllerName: "HealthController",
          methodName: "optionalTelemetry",
          httpMethod: "GET",
          path: "/health/optional-telemetry",
          routeContract: null,
          params: [],
          inputSchema: null,
          inputSchemas: EMPTY_INPUT_SCHEMAS,
          outputSchema: null,
          domain: "health",
        },
      ];
      const files = generateClientFiles(routeIRs, outDir, { problemRuntime });
      const healthContent = fs.readFileSync(files[0], "utf-8");
      const healthModule = await importGeneratedClient(
        `health-telemetry-failure-${problemRuntime}.ts`,
        healthContent,
      );
      const cases = [
        {
          invoke: (options: unknown) => healthModule.healthClient.requiredTelemetry(options),
        },
        {
          invoke: (options: unknown) => healthModule.healthClient.requiredTelemetryResult(options),
        },
        {
          invoke: (options: unknown) => healthModule.healthClient.optionalTelemetry(options),
        },
        {
          invoke: (options: unknown) => healthModule.healthClient.optionalTelemetryResult(options),
        },
      ];

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ ready: true })),
      );

      for (const testCase of cases) {
        const events: string[] = [];
        const telemetryError = new Error("telemetry unavailable");
        const telemetry = {
          record: (event: Record<string, unknown>) => {
            events.push(String(event.kind));
            if (event.kind === "rpc.request.succeeded") {
              throw telemetryError;
            }
          },
        };

        await expect(testCase.invoke({ telemetry })).rejects.toBe(telemetryError);
        expect(events).toEqual(["rpc.request.started", "rpc.request.succeeded"]);
      }
    },
  );

  it("generates path and query inputs that can call a mocked server", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [
          { kind: "path", name: "id", schema: null },
          { kind: "query", name: "includePosts", schema: null },
        ],
        inputSchema: null,
        inputSchemas: PATH_QUERY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-output.ts", userContent);
    const fetchMock = vi.fn(async () => jsonResponse({ id: "1", includePosts: true }));

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      userModule.userClient.getUser({
        path: { id: "a/b c?#%" },
        query: {
          includePosts: true,
          page: 2,
          search: undefined,
          tags: ["new", "vip"],
          deletedAt: null,
        },
      }),
    ).resolves.toEqual({ id: "1", includePosts: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/users/a%2Fb%20c%3F%23%25?includePosts=true&page=2&tags=new&tags=vip&deletedAt=null",
      { method: "GET" },
    );
  });

  it("generates header inputs that can call a mocked server", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getCurrentUser",
        httpMethod: "GET",
        path: "/me",
        routeContract: null,
        params: [
          { kind: "header", name: "authorization", schema: null },
          { kind: "header", name: "x-request-id", schema: null },
        ],
        inputSchema: null,
        inputSchemas: HEADER_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-headers.ts", userContent);
    const fetchMock = vi.fn(async () => jsonResponse({ id: "1" }));

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      userModule.userClient.getCurrentUser({
        headers: { authorization: "Bearer token", "x-request-id": undefined },
      }),
    ).resolves.toEqual({ id: "1" });
    expect(fetchMock).toHaveBeenCalledWith("/me", {
      method: "GET",
      headers: { authorization: "Bearer token" },
    });
  });

  it("propagates telemetry headers and records generated client request events", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: z.object({ search: z.string() }) as any,
          headers: null,
        },
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        problemResponses: [
          {
            code: "USER_NOT_FOUND",
            category: ProblemCategory.NotFound,
            status: 404,
          },
        ],
        domain: "user",
      },
      {
        controllerName: "UserController",
        methodName: "createUser",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [{ kind: "body", name: "", schema: null }],
        inputSchema: null,
        inputSchemas: BODY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-telemetry.ts", userContent);
    const events: Record<string, unknown>[] = [];
    const headerContexts: Record<string, unknown>[] = [];
    const telemetry = {
      createHeaders: vi.fn((context: Record<string, unknown>) => {
        headerContexts.push(context);

        return {
          traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
          "x-croco-correlation-id": "corr-1",
          "x-croco-interaction-id": "interaction-1",
        };
      }),
      record: vi.fn((event: Record<string, unknown>) => {
        events.push(event);
      }),
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/users/user-secret%40example.com?search=token-123") {
        return jsonResponse({ id: "1", name: "Alice" });
      }

      if (url === "/users/missing?search=missing-secret") {
        return jsonResponse(
          {
            type: "https://errors.example.com/not-found",
            title: "Not Found",
            status: 404,
            code: "USER_NOT_FOUND",
            detail: "missing private detail",
          },
          404,
        );
      }

      if (url === "/users/forbidden?search=external-secret") {
        return jsonResponse(
          {
            type: "https://errors.example.com/forbidden",
            title: "Forbidden",
            status: 403,
            code: "USER_FORBIDDEN",
            detail: "external private detail",
          },
          403,
        );
      }

      if (url === "/users/malformed?search=malformed-secret") {
        return textResponse("{not-json", 200);
      }

      return new Response(null, { status: 204 });
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      userModule.userClient.getUser(
        { path: { id: "user-secret@example.com" }, query: { search: "token-123" } },
        {
          attempt: 2,
          correlationId: "corr-1",
          interactionId: "interaction-1",
          telemetry,
        },
      ),
    ).resolves.toEqual({ id: "1", name: "Alice" });

    expect(fetchMock).toHaveBeenCalledWith("/users/user-secret%40example.com?search=token-123", {
      method: "GET",
      headers: {
        traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
        "x-croco-correlation-id": "corr-1",
        "x-croco-interaction-id": "interaction-1",
      },
    });
    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.request.retry",
      "rpc.request.succeeded",
    ]);
    expect(events[0]).toMatchObject({
      attempt: 2,
      correlationId: "corr-1",
      interactionId: "interaction-1",
      operationId: "UserController_getUser",
      routeId: "UserController.getUser",
      routeKind: "query",
    });
    expect(headerContexts[0]).not.toHaveProperty("url");
    expect(JSON.stringify(events)).not.toContain("user-secret@example.com");
    expect(JSON.stringify(events)).not.toContain("token-123");

    events.length = 0;

    const problemResult = await userModule.userClient.getUserResult(
      { path: { id: "missing" }, query: { search: "missing-secret" } },
      { telemetry },
    );

    expect(problemResult).toMatchObject({
      ok: false,
      kind: "problem",
      code: "USER_NOT_FOUND",
    });
    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.request.problem",
    ]);
    expect(events[1]).toMatchObject({
      problem: {
        code: "USER_NOT_FOUND",
        status: 404,
        category: "NotFound",
        type: "https://errors.example.com/not-found",
        title: "Not Found",
      },
      status: 404,
    });
    expect(events[1]).not.toHaveProperty("body");
    expect(events[1]).not.toHaveProperty("url");
    expect(JSON.stringify(events)).not.toContain("missing-secret");
    expect(JSON.stringify(events)).not.toContain("missing private detail");

    events.length = 0;

    const externalResult = await userModule.userClient.getUserResult(
      { path: { id: "forbidden" }, query: { search: "external-secret" } },
      { telemetry },
    );

    expect(externalResult).toMatchObject({
      ok: false,
      kind: "external",
    });
    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.request.external_failure",
    ]);
    expect(events[1]).toMatchObject({
      errorName: "RpcClientProblemError",
      problem: {
        code: "USER_FORBIDDEN",
        status: 403,
        type: "https://errors.example.com/forbidden",
        title: "Forbidden",
      },
      status: 403,
    });
    expect(events[1]).not.toHaveProperty("errorMessage");
    expect(events[1]).not.toHaveProperty("url");
    expect(JSON.stringify(events)).not.toContain("external-secret");
    expect(JSON.stringify(events)).not.toContain("external private detail");

    events.length = 0;

    const malformedError = await getRejectedError(
      userModule.userClient.getUser(
        { path: { id: "malformed" }, query: { search: "malformed-secret" } },
        { telemetry },
      ),
    );
    expect(malformedError).toMatchObject({
      name: "RpcClientResponseError",
      response: expect.objectContaining({ status: 200 }),
    });
    expect((malformedError as { readonly cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.request.external_failure",
    ]);

    events.length = 0;

    const malformedResult = await userModule.userClient.getUserResult(
      { path: { id: "malformed" }, query: { search: "malformed-secret" } },
      { telemetry },
    );
    expect(malformedResult).toMatchObject({
      ok: false,
      kind: "external",
      response: expect.objectContaining({ status: 200 }),
      error: expect.objectContaining({ name: "RpcClientResponseError" }),
    });
    if (malformedResult.ok || malformedResult.kind !== "external") {
      expect.fail("Expected an external failure result.");
    }
    expect((malformedResult.error as { readonly cause?: unknown }).cause).toBeInstanceOf(
      SyntaxError,
    );
    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.request.external_failure",
    ]);

    events.length = 0;

    await expect(
      userModule.userClient.createUser({ name: "Bob" }, { telemetry }),
    ).resolves.toBeUndefined();

    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.mutation.started",
      "rpc.request.succeeded",
      "rpc.mutation.succeeded",
    ]);
  });

  it("returns generated Result request failures without changing throwing methods", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: null,
          headers: null,
        },
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-network-failure.ts", userContent);
    const events: Record<string, unknown>[] = [];
    const networkError = new TypeError("fetch failed");
    const telemetry = {
      record: (event: Record<string, unknown>) => {
        events.push(event);
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw networkError;
      }),
    );

    await expect(userModule.userClient.getUser({ path: { id: "1" } }, { telemetry })).rejects.toBe(
      networkError,
    );
    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.request.external_failure",
    ]);

    events.length = 0;

    await expect(
      userModule.userClient.getUserResult({ path: { id: "1" } }, { telemetry }),
    ).resolves.toEqual({
      ok: false,
      kind: "external",
      error: networkError,
    });
    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.request.external_failure",
    ]);
  });

  it("returns generated Result body-stream failures with the available response", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: null,
          headers: null,
        },
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-body-stream-failure.ts", userContent);
    const response = new Response(null, { status: 200 });
    const bodyError = new TypeError("terminated");
    const events: Record<string, unknown>[] = [];
    const telemetry = {
      record: (event: Record<string, unknown>) => {
        events.push(event);
      },
    };

    const jsonSpy = vi.spyOn(response, "json").mockRejectedValue(bodyError);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(
      userModule.userClient.getUserResult({ path: { id: "1" } }, { telemetry }),
    ).resolves.toEqual({
      ok: false,
      kind: "external",
      error: bodyError,
      response,
    });
    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.request.external_failure",
    ]);
    expect(events[1]).toMatchObject({ status: 200, errorName: "TypeError" });

    const telemetryError = new Error("telemetry unavailable");
    let telemetryCallCount = 0;
    jsonSpy.mockResolvedValue({ id: "1", name: "Alice" });

    await expect(
      userModule.userClient.getUserResult(
        { path: { id: "1" } },
        {
          telemetry: {
            record: () => {
              telemetryCallCount += 1;
              if (telemetryCallCount === 2) {
                throw telemetryError;
              }
            },
          },
        },
      ),
    ).rejects.toBe(telemetryError);
  });

  it("returns generated optional Result text-stream failures with the available response", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "deleteUser",
        httpMethod: "DELETE",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: null,
          headers: null,
        },
        outputSchema: null,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient(
      "user-optional-body-stream-failure.ts",
      userContent,
    );
    const response = new Response(null, { status: 200 });
    const bodyError = new TypeError("terminated");

    vi.spyOn(response, "text").mockRejectedValue(bodyError);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(userModule.userClient.deleteUserResult({ path: { id: "1" } })).resolves.toEqual({
      ok: false,
      kind: "external",
      error: bodyError,
      response,
    });
  });

  it("records cancelled generated client requests for throwing and Result methods", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: null,
          headers: null,
        },
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-cancelled-telemetry.ts", userContent);
    const events: Record<string, unknown>[] = [];
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw abort;
      }),
    );

    const telemetry = {
      record: (event: Record<string, unknown>) => {
        events.push(event);
      },
    };

    await expect(userModule.userClient.getUser({ path: { id: "1" } }, { telemetry })).rejects.toBe(
      abort,
    );

    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.request.cancelled",
    ]);
    expect(events[1]).toMatchObject({
      errorName: "AbortError",
    });
    expect(events[1]).not.toHaveProperty("errorMessage");

    events.length = 0;

    await expect(
      userModule.userClient.getUserResult({ path: { id: "1" } }, { telemetry }),
    ).resolves.toEqual({
      ok: false,
      kind: "external",
      error: abort,
    });
    expect(events.map((event) => event.kind)).toEqual([
      "rpc.request.started",
      "rpc.request.cancelled",
    ]);
    expect(events[1]).toMatchObject({
      errorName: "AbortError",
    });
    expect(events[1]).not.toHaveProperty("errorMessage");
  });

  it("generates outputSchema types that compile", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: null,
          headers: null,
        },
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user.ts", userContent);
    const fetchMock = vi.fn(async () => jsonResponse({ id: "1", name: "Alice" }));

    vi.stubGlobal("fetch", fetchMock);

    await expect(userModule.userClient.getUser({ path: { id: "1" } })).resolves.toEqual({
      id: "1",
      name: "Alice",
    });
  });

  it("rejects non-2xx Problem responses with preserved details", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: null,
          headers: null,
        },
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-problem.ts", userContent);
    const problem = {
      type: "https://errors.example.com/not-found",
      title: "Not Found",
      status: 404,
      code: "USER_NOT_FOUND",
      detail: "User missing",
      traceId: "trace-1",
    };
    const fetchMock = vi.fn(async () => jsonResponse(problem, 404));

    vi.stubGlobal("fetch", fetchMock);

    const error = await getRejectedError(
      userModule.userClient.getUser({ path: { id: "missing" } }),
    );
    const problemError = error as {
      readonly name: string;
      readonly problem: Record<string, unknown>;
      readonly response: Response;
    };

    expect(problemError.name).toBe("RpcClientProblemError");
    expect(problemError.problem).toEqual(problem);
    expect(problemError.response.status).toBe(404);
  });

  it("resolves declared Problem responses through the typed result branch", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: null,
          headers: null,
        },
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        problemResponses: [
          {
            code: "USER_NOT_FOUND",
            category: ProblemCategory.NotFound,
            status: 404,
          },
        ],
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-problem-result.ts", userContent);
    const problem = {
      type: "https://errors.example.com/not-found",
      title: "Not Found",
      status: 404,
      code: "USER_NOT_FOUND",
      detail: "User missing",
    };
    const fetchMock = vi.fn(async () => jsonResponse(problem, 404));

    vi.stubGlobal("fetch", fetchMock);

    const result = await userModule.userClient.getUserResult({
      path: { id: "missing" },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "problem",
      code: "USER_NOT_FOUND",
      category: "NotFound",
      status: 404,
      problem,
      declaration: {
        code: "USER_NOT_FOUND",
        category: "NotFound",
        status: 404,
      },
    });
  });

  it("treats undeclared Problem Details as external result failures", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: null,
          headers: null,
        },
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        problemResponses: [
          {
            code: "USER_NOT_FOUND",
            category: ProblemCategory.NotFound,
            status: 404,
          },
        ],
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient(
      "user-undeclared-problem-result.ts",
      userContent,
    );
    const problem = {
      type: "https://errors.example.com/forbidden",
      title: "Forbidden",
      status: 403,
      code: "USER_FORBIDDEN",
      detail: "User forbidden",
    };
    const fetchMock = vi.fn(async () => jsonResponse(problem, 403));

    vi.stubGlobal("fetch", fetchMock);

    const result = await userModule.userClient.getUserResult({
      path: { id: "forbidden" },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "external",
      body: problem,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "external") {
      expect(result.error).toBeInstanceOf(Error);
      if (result.error instanceof Error) {
        expect(result.error.name).toBe("RpcClientProblemError");
      }
    }
  });

  it("rejects non-JSON error responses without parsing them as success", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: null,
          headers: null,
        },
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-non-json.ts", userContent);
    const fetchMock = vi.fn(async () => textResponse("upstream unavailable", 503));

    vi.stubGlobal("fetch", fetchMock);

    const error = await getRejectedError(userModule.userClient.getUser({ path: { id: "1" } }));
    const responseError = error as {
      readonly name: string;
      readonly message: string;
      readonly response: Response;
    };

    expect(responseError.name).toBe("RpcClientResponseError");
    expect(responseError.message).toBe("RPC request failed with HTTP 503");
    expect(responseError.response.status).toBe(503);
  });

  it("rejects non-Problem JSON error responses with preserved body", async () => {
    const routeIRs: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as any,
          query: null,
          headers: null,
        },
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        domain: "user",
      },
    ];

    const files = generateClientFiles(routeIRs, outDir);
    const userContent = fs.readFileSync(files[0], "utf-8");
    const userModule = await importGeneratedClient("user-json-error.ts", userContent);
    const body = { message: "bad request" };
    const fetchMock = vi.fn(async () => jsonResponse(body, 400));

    vi.stubGlobal("fetch", fetchMock);

    const error = await getRejectedError(userModule.userClient.getUser({ path: { id: "1" } }));
    const responseError = error as {
      readonly name: string;
      readonly body: unknown;
      readonly response: Response;
    };

    expect(responseError.name).toBe("RpcClientResponseError");
    expect(responseError.body).toEqual(body);
    expect(responseError.response.status).toBe(400);
  });
});

async function importGeneratedClient(fileName: string, source: string) {
  const rpcSource = fs.readFileSync(path.join(outDir, "rpc.ts"), "utf-8");
  const rpcOutput = ts.transpileModule(rpcSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const rpcFileName = `rpc-${fileName.replace(/\.ts$/, "")}.mjs`;
  const output = ts.transpileModule(source.replace("from './rpc';", `from './${rpcFileName}';`), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });

  expect(rpcOutput.diagnostics).toEqual([]);
  expect(output.diagnostics).toEqual([]);

  const modulePath = path.join(moduleDir, fileName.replace(/\.ts$/, ".mjs"));
  writeProblemsCoreRuntime(moduleDir);
  writeFrontendProblemsRuntime(moduleDir);
  fs.writeFileSync(path.join(moduleDir, rpcFileName), rpcOutput.outputText);
  fs.writeFileSync(modulePath, output.outputText);

  return import(pathToFileURL(modulePath).href) as Promise<{
    readonly createUserClient: (config?: {
      readonly baseUrl?: string;
      readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
      readonly headers?: HeadersInit;
      readonly request?: Omit<RequestInit, "body" | "headers" | "method" | "signal">;
      readonly telemetry?: unknown;
    }) => {
      readonly createUser: (
        input: { readonly name: string },
        options?: unknown,
      ) => Promise<unknown>;
      readonly getCurrentUser: (
        input: { readonly headers: { readonly "x-precedence": string } },
        options?: unknown,
      ) => Promise<unknown>;
    };
    readonly userClient: {
      readonly listUsers: () => Promise<unknown>;
      readonly createUser: (
        input: { readonly name: string },
        options?: unknown,
      ) => Promise<unknown>;
      readonly getUser: (
        input: {
          readonly path: { readonly id: string };
          readonly query?: Record<string, unknown>;
        },
        options?: unknown,
      ) => Promise<unknown>;
      readonly getUserResult: (
        input: {
          readonly path: { readonly id: string };
          readonly query?: Record<string, unknown>;
        },
        options?: unknown,
      ) => Promise<
        | {
            readonly ok: true;
            readonly data: unknown;
            readonly response: Response;
          }
        | {
            readonly ok: false;
            readonly kind: "problem";
            readonly code: string;
            readonly category: string;
            readonly status: number;
            readonly problem: unknown;
            readonly declaration: unknown;
            readonly response: Response;
          }
        | {
            readonly ok: false;
            readonly kind: "external";
            readonly error: unknown;
            readonly response?: Response;
            readonly body?: unknown;
          }
      >;
      readonly deleteUserResult: (
        input: { readonly path: { readonly id: string } },
        options?: unknown,
      ) => Promise<unknown>;
      readonly getCurrentUser: (
        input: {
          readonly headers: {
            readonly authorization: string;
            readonly "x-request-id": string | undefined;
          };
        },
        options?: unknown,
      ) => Promise<unknown>;
    };
    readonly healthClient: {
      readonly health: () => Promise<unknown>;
      readonly clear: () => Promise<unknown>;
      readonly fail: () => Promise<unknown>;
      readonly status: () => Promise<unknown>;
      readonly malformed: () => Promise<unknown>;
      readonly malformedResult: () => Promise<
        | { readonly ok: true; readonly data: unknown; readonly response: Response }
        | {
            readonly ok: false;
            readonly kind: "external";
            readonly error: Error;
            readonly response: Response;
          }
      >;
      readonly unreadable: (options?: unknown) => Promise<unknown>;
      readonly unreadableResult: (options?: unknown) => Promise<
        | { readonly ok: true; readonly data: unknown; readonly response: Response }
        | {
            readonly ok: false;
            readonly kind: "external";
            readonly error: Error;
            readonly response: Response;
          }
      >;
      readonly requiredAbort: (options?: unknown) => Promise<unknown>;
      readonly requiredAbortResult: (options?: unknown) => Promise<unknown>;
      readonly optionalAbort: (options?: unknown) => Promise<unknown>;
      readonly optionalAbortResult: (options?: unknown) => Promise<unknown>;
      readonly requiredErrorAbort: (options?: unknown) => Promise<unknown>;
      readonly requiredErrorAbortResult: (options?: unknown) => Promise<unknown>;
      readonly mutationErrorAbort: (options?: unknown) => Promise<unknown>;
      readonly mutationErrorAbortResult: (options?: unknown) => Promise<unknown>;
      readonly requiredTelemetry: (options?: unknown) => Promise<unknown>;
      readonly requiredTelemetryResult: (options?: unknown) => Promise<unknown>;
      readonly optionalTelemetry: (options?: unknown) => Promise<unknown>;
      readonly optionalTelemetryResult: (options?: unknown) => Promise<unknown>;
    };
  }>;
}

function writeProblemsCoreRuntime(parentDir: string): void {
  const packageDir = path.join(parentDir, "node_modules", "@croco", "problems-core");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ type: "module", exports: "./index.mjs" }),
  );
  fs.writeFileSync(
    path.join(packageDir, "index.mjs"),
    `export const ProblemCategory = {
  ValidationError: 'ValidationError',
};

export class Problem extends Error {
  constructor(code, category, detail, options = {}) {
    super(detail ?? code ?? 'Problem');
    this.name = this.constructor.name;
    this.code = this.code ?? code;
    this.category = this.category ?? category;
    this.detail = detail;
    this.extensions = options.extensions;
  }

  toJSON() {
    return {
      code: this.code,
      category: this.category,
      detail: this.detail,
      ...(this.extensions ?? {}),
    };
  }
}
`,
  );
}

function writeFrontendProblemsRuntime(parentDir: string): void {
  const packageDir = path.join(parentDir, "node_modules", "@croco", "frontend-problems");
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../../frontend-problems/src/index.ts"),
    "utf-8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });

  expect(output.diagnostics).toEqual([]);
  expect(output.outputText).not.toMatch(/\bfrom\s+["']\.{1,2}\//);
  expect(output.outputText).not.toMatch(/\bimport\s*(?:\(\s*)?["']\.{1,2}\//);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ type: "module", exports: "./index.mjs" }),
  );
  fs.writeFileSync(path.join(packageDir, "index.mjs"), output.outputText);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

function unreadableTextResponse(cause: unknown): Response {
  const response = new Response("unreadable", { status: 200 });
  Object.defineProperty(response, "text", {
    configurable: true,
    value: async () => Promise.reject(cause),
  });

  return response;
}

function unreadableJsonResponse(cause: unknown, status = 200): Response {
  const response = new Response("unreadable", { status });
  Object.defineProperty(response, "json", {
    configurable: true,
    value: async () => Promise.reject(cause),
  });

  return response;
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";

  return error;
}

async function getRejectedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected promise to reject.");
}
