import "reflect-metadata";
import { getEventListeners } from "node:events";
import { IncomingMessage, request as httpRequest, ServerResponse } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import { Container } from "@croco/framework-context";
import { Logger } from "@croco/framework-logger";
import { Problem, ProblemCategory } from "@croco/problems-core";
import {
  Field,
  FieldResolver,
  GRAPHQL_AUTH_GUARD_OPTIONS,
  GraphQLAuthGuard,
  Mutation,
  Ctx,
  ObjectType,
  Query,
  Resolver,
  Roles,
  Subscription,
  UseGuards,
  UseInterceptors,
} from "@croco/protocols-graphql";
import type {
  GraphQLGuard,
  GraphQLInterceptor,
  GraphQLInterceptorContext,
} from "@croco/protocols-graphql";
import { GraphQLError } from "graphql";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphQLServer } from "../libs/GraphQLServer";
import { SchemaCompiler } from "../libs/SchemaCompiler";
import {
  GraphQLBodyLimitConfigurationProblem,
  GraphQLRequestTimeoutConfigurationProblem,
  GraphQLResolversNotConfiguredProblem,
  GraphQLSchemaNotConfiguredProblem,
  GraphQLServerNotInitializedProblem,
} from "../libs/problems/GraphQLTransportProblems";

@ObjectType()
class User {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String)
  email!: string;
}

@Resolver(() => User)
class UserResolver {
  private readonly userList = [
    { id: "1", name: "Alice", email: "alice@example.com" },
    { id: "2", name: "Bob", email: "bob@example.com" },
  ];

  @Query(() => [User])
  async getUsers(): Promise<User[]> {
    return this.userList;
  }

  @Query(() => String)
  async hello(): Promise<string> {
    return "Hello, GraphQL!";
  }
}

class TestGraphQLProblem extends Problem {
  constructor(
    code: string,
    category: ProblemCategory,
    detail: string,
    extensions?: Record<string, unknown>,
  ) {
    super(code, category, detail, { extensions });
  }
}

@Resolver()
class ProblemResolver {
  @Query(() => String)
  publicProblem(): string {
    throw new TestGraphQLProblem(
      "GRAPHQL_INPUT_INVALID",
      ProblemCategory.ValidationError,
      "Email is invalid",
      {
        field: "email",
        requestId: "request-secret",
        traceId: "trace-secret",
        diagnostics: "provider-secret",
      },
    );
  }

  @Query(() => String)
  safeMessageProblem(): string {
    throw new TestGraphQLProblem(
      "ACCESS_DENIED",
      ProblemCategory.Forbidden,
      "You cannot access this tenant",
      {
        reason: "tenant mismatch",
        providerSecret: "secret",
      },
    );
  }

  @Query(() => String)
  operatorOnlyProblem(): string {
    throw new TestGraphQLProblem(
      "transports-graphql/schema-not-configured",
      ProblemCategory.InternalServerError,
      "Database password is invalid",
      {
        reason: "database password is invalid",
      },
    );
  }

  @Query(() => String)
  unknownProblem(): string {
    throw new TestGraphQLProblem(
      "example/user-not-found",
      ProblemCategory.NotFound,
      "User 123 was not found",
      {
        reason: "deleted",
        diagnostics: "store:primary",
      },
    );
  }

  @Query(() => String)
  wrappedProblem(): string {
    throw new GraphQLError("Wrapped provider secret", {
      originalError: new TestGraphQLProblem(
        "GRAPHQL_INPUT_INVALID",
        ProblemCategory.ValidationError,
        "Wrapped email is invalid",
        {
          field: "email",
          diagnostics: "provider-secret",
        },
      ),
    });
  }

  @Query(() => String)
  unhandledProblem(): string {
    throw Object.assign(new Error("Unhandled provider secret"), {
      code: "ACCESS_DENIED",
      category: ProblemCategory.Forbidden,
    });
  }
}

const policyEvents: string[] = [];

class HeaderGuard implements GraphQLGuard {
  constructor(private readonly requiredAuthorization: string) {}

  canActivate(context: GraphQLInterceptorContext): boolean {
    policyEvents.push("guard");
    const headers = context.context.headers as Record<string, string> | undefined;
    return headers?.authorization === this.requiredAuthorization;
  }
}

class FirstPolicyInterceptor implements GraphQLInterceptor {
  async intercept(
    _context: GraphQLInterceptorContext,
    next: { handle(): Promise<unknown> },
  ): Promise<unknown> {
    policyEvents.push("first:before");
    const result = await next.handle();
    policyEvents.push("first:after");
    return result;
  }
}

class SecondPolicyInterceptor implements GraphQLInterceptor {
  async intercept(
    _context: GraphQLInterceptorContext,
    next: { handle(): Promise<unknown> },
  ): Promise<unknown> {
    policyEvents.push("second:before");
    const result = await next.handle();
    policyEvents.push("second:after");
    return result;
  }
}

@Resolver()
class PolicyResolver {
  @Query(() => String)
  @Roles("admin")
  @UseGuards(HeaderGuard)
  @UseInterceptors(FirstPolicyInterceptor, SecondPolicyInterceptor)
  protectedValue(): string {
    policyEvents.push("resolver");
    return "authorized";
  }
}

@ObjectType()
class PolicyPerson {
  @Field(() => String)
  id!: string;
}

@ObjectType()
class PolicyOrganization {
  @Field(() => String)
  id!: string;
}

class AllowFieldGuard implements GraphQLGuard {
  canActivate(): boolean {
    return true;
  }
}

class DenyFieldGuard implements GraphQLGuard {
  canActivate(): boolean {
    return false;
  }
}

class AllowSubscriptionGuard implements GraphQLGuard {
  canActivate(): boolean {
    return true;
  }
}

@Resolver()
class PolicyFieldQueryResolver {
  @Query(() => PolicyPerson)
  person(): PolicyPerson {
    return { id: "person" };
  }

  @Query(() => PolicyOrganization, { nullable: true })
  organization(): PolicyOrganization {
    return { id: "organization" };
  }
}

@Resolver(() => PolicyPerson)
class PolicyPersonFieldResolver {
  @FieldResolver(() => String)
  @UseGuards(AllowFieldGuard)
  id(): string {
    return "person";
  }
}

@Resolver(() => PolicyOrganization)
class PolicyOrganizationFieldResolver {
  @FieldResolver(() => String)
  @UseGuards(DenyFieldGuard)
  id(): string {
    return "organization";
  }
}

@Resolver()
class PolicySubscriptionResolver {
  @Query(() => String)
  policyHealth(): string {
    return "ok";
  }

  @Subscription(() => String, { topics: "policy-update" })
  @UseGuards(AllowSubscriptionGuard)
  @Roles("admin")
  policyUpdate(): string {
    return "authorized";
  }
}

type LoggerMock = Logger & {
  child: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function createLoggerMock(): LoggerMock {
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as LoggerMock;
  logger.child.mockReturnValue(logger);
  return logger;
}

describe("GraphQLServer integration", () => {
  const server = new GraphQLServer({
    schemaOptions: {
      resolvers: [UserResolver],
      autoDiscover: false,
    },
  });

  beforeAll(async () => {
    Container.reset();
    await server.initialize();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("should compile schema successfully", () => {
    expect(server).not.toBeNull();
  });

  it("should execute hello query", async () => {
    const handler = server.getHandler();
    const request = new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
          query {
            hello
          }
        `,
      }),
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.errors).toBeUndefined();
    expect(data.data.hello).toBe("Hello, GraphQL!");
  });

  it("should execute users query returning array", async () => {
    const handler = server.getHandler();
    const request = new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
          query {
            getUsers {
              id
              name
              email
            }
          }
        `,
      }),
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.errors).toBeUndefined();
    expect(Array.isArray(data.data.getUsers)).toBe(true);
    expect(data.data.getUsers.length).toBe(2);
    expect(data.data.getUsers[0].name).toBe("Alice");
    expect(data.data.getUsers[1].name).toBe("Bob");
  });

  it("should execute user query with arguments", async () => {
    const handler = server.getHandler();
    const request = new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
          query {
            getUsers {
              id
              name
              email
            }
          }
        `,
      }),
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.errors).toBeUndefined();
    expect(Array.isArray(data.data.getUsers)).toBe(true);
    expect(data.data.getUsers[0].id).toBe("1");
  });

  it("should handle invalid query gracefully", async () => {
    const handler = server.getHandler();
    const request = new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
          query {
            nonExistentField
          }
        `,
      }),
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.errors).not.toBeNull();
    expect(Array.isArray(data.errors)).toBe(true);
  });

  it("should start and stop server", async () => {
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
    });

    await testServer.initialize();
    await testServer.start(4001);

    const handler = testServer.getHandler();
    expect(typeof handler).toBe("function");

    await testServer.stop();
  });

  it("should preserve every Set-Cookie response header", async () => {
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
    });

    await testServer.initialize();

    const headers = new Headers({ "x-test-header": "preserved" });
    headers.append("set-cookie", "session=session-token; HttpOnly; Path=/");
    headers.append("set-cookie", "csrf=csrf-token; SameSite=Strict; Path=/");
    Reflect.set(testServer, "yogaHandler", async () => new Response("ok", { headers }));

    await testServer.start(4003);

    try {
      const response = await fetch("http://localhost:4003/graphql");

      expect(response.headers.getSetCookie()).toEqual([
        "session=session-token; HttpOnly; Path=/",
        "csrf=csrf-token; SameSite=Strict; Path=/",
      ]);
      expect(response.headers.get("x-test-header")).toBe("preserved");
    } finally {
      await testServer.stop();
    }
  });

  it("should abort GraphQL execution and return a stable timeout Problem", async () => {
    let executionSignal: AbortSignal | undefined;
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
      requestTimeoutMs: 100,
    });

    await testServer.initialize();
    Reflect.set(testServer, "yogaHandler", async (request: Request) => {
      executionSignal = request.signal;
      await new Promise((resolve) => setTimeout(resolve, 250));
      return new Response("late response");
    });
    await testServer.start(42209);

    try {
      const response = await fetch("http://localhost:42209/graphql");
      const responseBody = await response.text();

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(JSON.parse(responseBody)).toMatchObject({
        code: "transports-graphql/request-timeout",
        status: 500,
      });
      expect(executionSignal?.aborted).toBe(true);
    } finally {
      await testServer.stop();
    }
  });

  it("should propagate the timeout signal through Yoga to the active resolver", async () => {
    const logger = createLoggerMock();
    Container.set(Logger, logger);
    let resolveExecutionSignal: ((signal: AbortSignal) => void) | undefined;
    const executionSignalPromise = new Promise<AbortSignal>((resolve) => {
      resolveExecutionSignal = resolve;
    });
    let resolverAborted = false;

    @Resolver()
    class TimeoutResolver {
      @Query(() => String)
      slow(@Ctx() context: { request: Request }): Promise<string> {
        const signal = context.request.signal;
        resolveExecutionSignal?.(signal);
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              resolverAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
    }

    const testServer = new GraphQLServer({
      schemaOptions: { resolvers: [TimeoutResolver], autoDiscover: false },
      requestTimeoutMs: 100,
    });

    await testServer.start(42210);

    try {
      const responsePromise = fetch("http://localhost:42210/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ slow }" }),
      });
      const executionSignal = await executionSignalPromise;
      const response = await responsePromise;
      const responseBody = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(500);
      expect(responseBody).toMatchObject({
        code: "transports-graphql/request-timeout",
        status: 500,
      });
      expect(executionSignal.aborted).toBe(true);
      expect(resolverAborted).toBe(true);
      expect(logger.error).toHaveBeenCalledWith("GraphQL request failed", {
        phase: "yoga-execution",
        problemCode: "transports-graphql/request-timeout",
      });
    } finally {
      await testServer.stop();
      Container.reset();
    }
  });

  it("should release the deadline and disconnect listeners after a normal request", async () => {
    const requestOnceSpy = vi.spyOn(IncomingMessage.prototype, "once");
    const requestOffSpy = vi.spyOn(IncomingMessage.prototype, "off");
    const responseOnceSpy = vi.spyOn(ServerResponse.prototype, "once");
    const responseOffSpy = vi.spyOn(ServerResponse.prototype, "off");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
      requestTimeoutMs: 1_000,
    });

    await testServer.start(42211);

    try {
      const response = await fetch("http://localhost:42211/graphql");
      await response.text();

      const timeoutCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1_000);
      const timeoutHandle = setTimeoutSpy.mock.results[timeoutCallIndex]?.value;
      const requestAbortListener = requestOnceSpy.mock.calls.find(
        ([eventName, listener]) =>
          eventName === "aborted" &&
          typeof listener === "function" &&
          listener.name === "onRequestAborted",
      )?.[1];
      const responseCloseListener = responseOnceSpy.mock.calls.find(
        ([eventName, listener]) =>
          eventName === "close" &&
          typeof listener === "function" &&
          listener.name === "onResponseClose",
      )?.[1];

      expect(timeoutCallIndex).toBeGreaterThanOrEqual(0);
      expect(timeoutHandle).toBeDefined();
      expect(requestAbortListener).toBeDefined();
      expect(responseCloseListener).toBeDefined();
      await vi.waitFor(() => {
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
        expect(requestOffSpy).toHaveBeenCalledWith("aborted", requestAbortListener);
        expect(responseOffSpy).toHaveBeenCalledWith("close", responseCloseListener);
      });
    } finally {
      await testServer.stop();
      requestOnceSpy.mockRestore();
      requestOffSpy.mockRestore();
      responseOnceSpy.mockRestore();
      responseOffSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it("should abort execution and clear its deadline when the client disconnects", async () => {
    const logger = createLoggerMock();
    Container.set(Logger, logger);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let resolveExecutionSignal: ((signal: AbortSignal) => void) | undefined;
    const executionSignalPromise = new Promise<AbortSignal>((resolve) => {
      resolveExecutionSignal = resolve;
    });
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
      requestTimeoutMs: 60_000,
    });

    await testServer.initialize();
    Reflect.set(testServer, "yogaHandler", async (request: Request) => {
      const signal = request.signal;
      resolveExecutionSignal?.(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await testServer.start(42212);

    const request = httpRequest({ host: "localhost", port: 42212, path: "/graphql" });
    request.on("error", () => undefined);

    try {
      request.end();
      const executionSignal = await executionSignalPromise;
      const timeoutCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 60_000);
      const timeoutHandle = setTimeoutSpy.mock.results[timeoutCallIndex]?.value;

      request.destroy();

      await vi.waitFor(() => {
        expect(executionSignal.aborted).toBe(true);
        expect(getEventListeners(executionSignal, "abort")).toHaveLength(0);
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
      });
      expect(logger.error).toHaveBeenCalledWith(
        "GraphQL request failed",
        expect.objectContaining({ phase: "yoga-execution" }),
      );
    } finally {
      request.destroy();
      await testServer.stop();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      Container.reset();
    }
  });

  it("should throw a typed problem when no schema is configured", async () => {
    const testServer = new GraphQLServer();

    await expect(testServer.initialize()).rejects.toBeInstanceOf(GraphQLSchemaNotConfiguredProblem);
  });

  it("should throw a typed problem when handler is requested before initialize", () => {
    const testServer = new GraphQLServer();

    expect(() => testServer.getHandler()).toThrow(GraphQLServerNotInitializedProblem);
  });

  it("should throw a typed problem when schema compilation has no resolvers", async () => {
    const testServer = new GraphQLServer({
      schemaOptions: {
        autoDiscover: false,
      },
    });

    await expect(testServer.initialize()).rejects.toBeInstanceOf(
      GraphQLResolversNotConfiguredProblem,
    );
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    0,
    0.5,
    2_147_483_648,
    null as unknown as number,
  ])(
    "should reject unsafe requestTimeoutMs configuration %s during construction",
    (requestTimeoutMs) => {
      const construct = () => new GraphQLServer({ requestTimeoutMs });

      expect(construct).toThrow(GraphQLRequestTimeoutConfigurationProblem);
      expect(construct).toThrow("requestTimeoutMs must be an integer between 1 and 2147483647");
    },
  );

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    0,
    0.5,
    2 ** 53,
    null as unknown as number,
  ])(
    "should reject unsafe maxBodySizeBytes configuration %s during initialization",
    async (maxBodySizeBytes) => {
      const testServer = new GraphQLServer({
        schemaOptions: {
          resolvers: [UserResolver],
          autoDiscover: false,
        },
        maxBodySizeBytes,
      });

      await expect(testServer.initialize()).rejects.toMatchObject({
        code: "transports-graphql/body-limit-invalid-configuration",
        category: "InternalServerError",
        detail: "maxBodySizeBytes must be a finite positive safe integer",
      });
      await expect(testServer.initialize()).rejects.toBeInstanceOf(
        GraphQLBodyLimitConfigurationProblem,
      );
    },
  );

  it("should enforce the exact byte boundary for buffered and streamed bodies", async () => {
    const body = JSON.stringify({ query: "{ hello } # 😀" });
    const limit = Buffer.byteLength(body);
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
      maxBodySizeBytes: limit,
    });

    await testServer.start(4003);

    try {
      const bufferedAtLimit = await fetch("http://localhost:4003/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const bufferedOverLimit = await fetch("http://localhost:4003/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `${body} `,
      });
      const multibyteOffset = body.indexOf("😀");
      const streamedAtLimit = await sendChunkedRequest(4003, [
        body.slice(0, multibyteOffset),
        body.slice(multibyteOffset),
      ]);
      const streamedOverLimit = await sendChunkedRequest(4003, [body, " "]);

      expect(bufferedAtLimit.status).toBe(200);
      expect(bufferedOverLimit.status).toBe(413);
      expect(streamedAtLimit.status).toBe(200);
      expect(streamedOverLimit.status).toBe(413);
    } finally {
      await testServer.stop();
    }
  });

  it("should reject oversized request bodies with 413", async () => {
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
      maxBodySizeBytes: 32,
    });

    await testServer.initialize();
    await testServer.start(4002);

    const response = await fetch("http://localhost:4002/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "{ hello }",
        padding: "x".repeat(128),
      }),
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await response.json()) as { code: string; detail: string; title: string };

    expect(problem.code).toBe("transports-graphql/request-body-too-large");
    expect(problem.title).toBe("Payload Too Large");
    expect(problem.detail).toContain("Payload Too Large");

    await testServer.stop();
  });

  it.each([
    { name: "missing HTTP/1.0 Host", version: "1.0", host: undefined, authority: "localhost" },
    { name: "unbracketed IPv6 Host", version: "1.1", host: "::1", authority: "localhost" },
    { name: "invalid character in Host", version: "1.1", host: "bad host", authority: "localhost" },
    {
      name: "embedded tab in Host",
      version: "1.1",
      host: "exa\tmple.test",
      authority: "localhost",
    },
    { name: "malformed bracketed Host", version: "1.1", host: "[", authority: "localhost" },
    { name: "userinfo in Host", version: "1.1", host: "user@localhost", authority: "localhost" },
    { name: "path in Host", version: "1.1", host: "example.test/path", authority: "localhost" },
    {
      name: "valid Host",
      version: "1.1",
      host: "example.test:8080",
      authority: "example.test:8080",
    },
  ])(
    "should resolve $name to $authority and execute the request",
    async ({ version, host, authority }) => {
      const testServer = new GraphQLServer({
        schemaOptions: { resolvers: [UserResolver], autoDiscover: false },
      });
      await testServer.initialize();
      const yogaHandler = vi.fn(async (request: Request) => new Response(request.url));
      Reflect.set(testServer, "yogaHandler", yogaHandler);
      await testServer.start(4004);

      try {
        const hostHeader = host === undefined ? "" : `Host: ${host}\r\n`;
        const response = await sendRawHttpRequest(
          4004,
          `GET /graphql?query=test HTTP/${version}\r\n${hostHeader}Connection: close\r\n\r\n`,
        );

        expect(response).toContain("200 OK");
        expect(response.split("\r\n\r\n")[1]).toBe(`http://${authority}/graphql?query=test`);
        expect(yogaHandler).toHaveBeenCalledOnce();
      } finally {
        await testServer.stop();
      }
    },
  );

  it("should redact invalid absolute request-target failures", async () => {
    const logger = createLoggerMock();
    Container.set(Logger, logger);
    const testServer = new GraphQLServer({
      schemaOptions: { resolvers: [UserResolver], autoDiscover: false },
    });
    await testServer.start(4004);

    try {
      const response = await sendRawHttpRequest(
        4004,
        "GET http://[/graphql HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );

      expect(response).toContain("HTTP/1.1 500 Internal Server Error");
      expect(JSON.parse(response.split("\r\n\r\n")[1] ?? "")).toMatchObject({
        code: "transports-graphql/request-handling-failed",
        detail: "An internal error occurred",
        status: 500,
      });
      expect(logger.error).toHaveBeenCalledWith("GraphQL request failed", {
        phase: "request-url",
        problemCode: "transports-graphql/request-handling-failed",
      });
    } finally {
      await testServer.stop();
      Container.reset();
    }
  });

  it.each([
    {
      name: "advertised Content-Length",
      framing: "Content-Length: 1000",
      body: "x",
      nextChunk: undefined,
    },
    {
      name: "incremental chunked body",
      framing: "Transfer-Encoding: chunked",
      body: "10\r\nxxxxxxxxxxxxxxxx\r\n",
      nextChunk: "1\r\nx\r\n",
    },
  ])(
    "should finish 413 and destroy the unfinished $name upload",
    async ({ framing, body, nextChunk }) => {
      const testServer = new GraphQLServer({
        schemaOptions: { resolvers: [UserResolver], autoDiscover: false },
        maxBodySizeBytes: 16,
      });
      await testServer.start(42213);
      const nodeServer = Reflect.get(testServer, "server") as Server;
      const destruction: { error: Error | undefined; finished: boolean }[] = [];
      let receivedFirstChunk: (() => void) | undefined;
      const firstChunk = new Promise<void>((resolve) => {
        receivedFirstChunk = resolve;
      });
      nodeServer.once("request", (request, response) => {
        if (nextChunk !== undefined) {
          const emit = request.emit;
          vi.spyOn(request, "emit").mockImplementation(function (
            this: IncomingMessage,
            event: string | symbol,
            ...args: unknown[]
          ) {
            const emitted = emit.call(this, event, ...args);
            if (event === "data") receivedFirstChunk?.();
            return emitted;
          });
        }
        const destroy = request.destroy;
        vi.spyOn(request, "destroy").mockImplementation(function (
          this: IncomingMessage,
          error?: Error,
        ) {
          destruction.push({ error, finished: response.writableFinished });
          return destroy.call(this, error);
        });
      });

      try {
        const response = await sendRawHttpRequest(
          42213,
          `POST /graphql HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n${framing}\r\n\r\n${body}`,
          {
            unfinished: true,
            continuation:
              nextChunk === undefined ? undefined : { after: firstChunk, data: nextChunk },
          },
        );

        expect(response).toContain("HTTP/1.1 413 Payload Too Large");
        expect(response.toLowerCase()).toContain("connection: close");
        expect(JSON.parse(response.split("\r\n\r\n")[1] ?? "")).toMatchObject({
          code: "transports-graphql/request-body-too-large",
          status: 413,
          title: "Payload Too Large",
        });
        expect(destruction).toContainEqual({ error: undefined, finished: true });
      } finally {
        await testServer.stop();
      }
    },
  );

  it("should destroy an oversized upload when writing its 413 response fails", async () => {
    const testServer = new GraphQLServer({
      schemaOptions: { resolvers: [UserResolver], autoDiscover: false },
      maxBodySizeBytes: 16,
    });
    await testServer.start(42213);
    const nodeServer = Reflect.get(testServer, "server") as Server;
    const destruction: { error: Error | undefined; finished: boolean }[] = [];
    nodeServer.once("request", (request, response) => {
      const destroy = request.destroy;
      vi.spyOn(request, "destroy").mockImplementation(function (
        this: IncomingMessage,
        error?: Error,
      ) {
        destruction.push({ error, finished: response.writableFinished });
        return destroy.call(this, error);
      });
      vi.spyOn(response, "end").mockImplementation(function (this: ServerResponse) {
        this.flushHeaders();
        Object.defineProperties(this, {
          writableEnded: { configurable: true, value: true },
          writableFinished: { configurable: true, value: false },
        });
        setImmediate(() => this.emit("error", new Error("response write failed")));
        return this;
      });
    });

    try {
      await sendRawHttpRequest(
        42213,
        "POST /graphql HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 1000\r\n\r\nx",
        { unfinished: true },
      );

      expect(destruction).toContainEqual({ error: undefined, finished: false });
    } finally {
      await testServer.stop();
    }
  });

  it("should preserve safe Problem details when Yoga rejects", async () => {
    const logger = createLoggerMock();
    Container.set(Logger, logger);
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
    });

    await testServer.initialize();
    Reflect.set(testServer, "yogaHandler", async () => {
      throw new TestGraphQLProblem(
        "ACCESS_DENIED",
        ProblemCategory.Forbidden,
        "You cannot access this tenant",
        { reason: "tenant mismatch", providerSecret: "secret" },
      );
    });
    await testServer.start(4005);

    try {
      const response = await fetch("http://localhost:4005/graphql");
      const problem = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(problem).toMatchObject({
        code: "ACCESS_DENIED",
        detail: "You cannot access this tenant",
        reason: "tenant mismatch",
        status: 403,
      });
      expect(problem).not.toHaveProperty("providerSecret");
      expect(logger.error).toHaveBeenCalledWith("GraphQL request failed", {
        phase: "yoga-execution",
        problemCode: "ACCESS_DENIED",
      });
    } finally {
      await testServer.stop();
      Container.reset();
    }
  });

  it("should replace Yoga rejections with one stable internal failure", async () => {
    const logger = createLoggerMock();
    Container.set(Logger, logger);
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
    });

    await testServer.initialize();
    Reflect.set(testServer, "yogaHandler", async () => {
      throw new Error("provider credential leaked");
    });
    await testServer.start(4006);

    try {
      const response = await fetch("http://localhost:4006/graphql");
      const responseBody = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(responseBody)).toEqual({
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        code: "transports-graphql/request-handling-failed",
        detail: "An internal error occurred",
      });
      expect(responseBody).not.toContain("provider credential leaked");
      expect(logger.error).toHaveBeenCalledWith("GraphQL request failed", {
        phase: "yoga-execution",
        problemCode: "transports-graphql/request-handling-failed",
      });
    } finally {
      await testServer.stop();
      Container.reset();
    }
  });

  it("should replace response streaming failures without stale response headers", async () => {
    const logger = createLoggerMock();
    Container.set(Logger, logger);
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
    });

    await testServer.initialize();
    const yogaResponse = new Response("unused", {
      headers: {
        "content-length": "999",
        "set-cookie": "session=should-not-be-sent",
        "x-yoga-response": "should-not-be-sent",
      },
    });
    Reflect.set(yogaResponse, "text", async () => {
      throw new Error("stream provider secret");
    });
    Reflect.set(testServer, "yogaHandler", async () => yogaResponse);
    await testServer.start(4007);

    try {
      const response = await fetch("http://localhost:4007/graphql");
      const responseBody = await response.text();

      expect(response.status).toBe(500);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("x-yoga-response")).toBeNull();
      expect(responseBody).not.toContain("stream provider secret");
      expect(JSON.parse(responseBody)).toMatchObject({
        code: "transports-graphql/request-handling-failed",
        status: 500,
      });
      expect(logger.error).toHaveBeenCalledWith("GraphQL request failed", {
        phase: "response-body",
        problemCode: "transports-graphql/request-handling-failed",
      });
    } finally {
      await testServer.stop();
      Container.reset();
    }
  });

  it("should destroy a committed response after an asynchronous write failure", async () => {
    const logger = createLoggerMock();
    Container.set(Logger, logger);
    const destroySpy = vi.spyOn(ServerResponse.prototype, "destroy");
    const endSpy = vi
      .spyOn(ServerResponse.prototype, "end")
      .mockImplementationOnce(function (this: ServerResponse) {
        this.flushHeaders();
        Object.defineProperties(this, {
          writableEnded: { configurable: true, value: true },
          writableFinished: { configurable: true, value: false },
        });
        setImmediate(() => this.emit("error", new Error("socket write provider secret")));
        return this;
      });
    const testServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [UserResolver],
        autoDiscover: false,
      },
    });

    await testServer.start(4008);

    try {
      await expect(
        fetch("http://localhost:4008/graphql").then((response) => response.text()),
      ).rejects.toThrow();
      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith("GraphQL request failed", {
          phase: "response-write",
          problemCode: "transports-graphql/request-handling-failed",
        });
        expect(destroySpy).toHaveBeenCalled();
      });
    } finally {
      endSpy.mockRestore();
      destroySpy.mockRestore();
      await testServer.stop();
      Container.reset();
    }
  });

  describe("Problem masking", () => {
    const problemServer = new GraphQLServer({
      schemaOptions: {
        resolvers: [ProblemResolver],
        autoDiscover: false,
      },
    });

    beforeAll(async () => {
      await problemServer.initialize();
    });

    afterAll(async () => {
      await problemServer.stop();
    });

    it("should redact public resolver Problems", async () => {
      const { response, data } = await executeQuery(problemServer, "{ publicProblem }");

      expect(response.status).toBe(200);
      expect(data.errors[0].message).toBe("Email is invalid");
      expect(data.errors[0].extensions).toMatchObject({
        code: "GRAPHQL_INPUT_INVALID",
        status: 422,
        title: "Validation Error",
        field: "email",
      });
      expect(data.errors[0].extensions).not.toHaveProperty("requestId");
      expect(data.errors[0].extensions).not.toHaveProperty("traceId");
      expect(data.errors[0].extensions).not.toHaveProperty("diagnostics");
      expect(data.errors[0].extensions).not.toHaveProperty("redactionPolicy");
      expect(JSON.stringify(data.errors[0])).not.toContain("request-secret");
      expect(JSON.stringify(data.errors[0])).not.toContain("trace-secret");
      expect(JSON.stringify(data.errors[0])).not.toContain("provider-secret");
    });

    it("should retain safe-message resolver Problems", async () => {
      const { data } = await executeQuery(problemServer, "{ safeMessageProblem }");

      expect(data.errors[0].message).toBe("You cannot access this tenant");
      expect(data.errors[0].extensions).toMatchObject({
        code: "ACCESS_DENIED",
        status: 403,
        reason: "tenant mismatch",
      });
      expect(data.errors[0].extensions).not.toHaveProperty("providerSecret");
    });

    it("should redact operator-only resolver Problems", async () => {
      const { data } = await executeQuery(problemServer, "{ operatorOnlyProblem }");

      expect(data.errors[0].message).toBe("An internal error occurred");
      expect(data.errors[0].extensions).toEqual({
        code: "transports-graphql/schema-not-configured",
        status: 500,
        title: "Internal Server Error",
        type: "about:blank",
      });
    });

    it("should use category fallback for unknown resolver Problem codes", async () => {
      const { data } = await executeQuery(problemServer, "{ unknownProblem }");

      expect(data.errors[0].message).toBe("User 123 was not found");
      expect(data.errors[0].extensions).toMatchObject({
        code: "example/user-not-found",
        status: 404,
        reason: "deleted",
      });
      expect(data.errors[0].extensions).not.toHaveProperty("diagnostics");
    });

    it("should redact wrapped Problems and preserve their GraphQL path", async () => {
      const { data } = await executeQuery(problemServer, "{ wrappedProblem }");

      expect(data.errors[0].message).toBe("Wrapped email is invalid");
      expect(data.errors[0].path).toEqual(["wrappedProblem"]);
      expect(data.errors[0].extensions).toMatchObject({
        code: "GRAPHQL_INPUT_INVALID",
        field: "email",
      });
      expect(data.errors[0].extensions).not.toHaveProperty("diagnostics");
    });

    it("should keep Yoga masking for non-Problem errors", async () => {
      const { data } = await executeQuery(problemServer, "{ unhandledProblem }");

      expect(data.errors[0].message).toBe("Unexpected error.");
      expect(data.errors[0].message).not.toContain("provider secret");
    });

    it("should redact Problems thrown while creating context", async () => {
      const contextServer = new GraphQLServer({
        schemaOptions: {
          resolvers: [ProblemResolver],
          autoDiscover: false,
        },
        context: () => {
          throw new TestGraphQLProblem(
            "transports-graphql/schema-not-configured",
            ProblemCategory.InternalServerError,
            "Context provider secret",
            { diagnostics: "context-secret" },
          );
        },
      });

      await contextServer.initialize();

      try {
        const { data } = await executeQuery(contextServer, "{ publicProblem }");

        expect(data.errors[0].message).toBe("An internal error occurred");
        expect(data.errors[0].extensions).toEqual({
          code: "transports-graphql/schema-not-configured",
          status: 500,
          title: "Internal Server Error",
          type: "about:blank",
        });
        expect(JSON.stringify(data.errors[0])).not.toContain("context-secret");
      } finally {
        await contextServer.stop();
      }
    });

    it("should redact every Croco Problem before Yoga logs it", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const contextServer = new GraphQLServer({
        schemaOptions: {
          resolvers: [ProblemResolver],
          autoDiscover: false,
        },
        context: () => {
          throw new TestGraphQLProblem(
            "transports-graphql/schema-not-configured",
            ProblemCategory.InternalServerError,
            "Context provider secret",
            { diagnostics: "context-secret" },
          );
        },
      });

      await contextServer.initialize();

      try {
        await executeQuery(problemServer, "{ publicProblem }");
        await executeQuery(problemServer, "{ safeMessageProblem }");
        await executeQuery(problemServer, "{ operatorOnlyProblem }");
        await executeQuery(problemServer, "{ unknownProblem }");
        await executeQuery(problemServer, "{ wrappedProblem }");
        await executeQuery(contextServer, "{ publicProblem }");

        const loggedErrors = errorSpy.mock.calls
          .flat()
          .map((value) =>
            value instanceof GraphQLError
              ? JSON.stringify({
                  extensions: value.extensions,
                  message: value.message,
                  name: value.name,
                })
              : String(value),
          )
          .join("\n");

        expect(loggedErrors).toContain("An internal error occurred");
        for (const secret of [
          "request-secret",
          "trace-secret",
          "provider-secret",
          "providerSecret",
          "Database password is invalid",
          "database password is invalid",
          "store:primary",
          "Wrapped provider secret",
          "Context provider secret",
          "context-secret",
        ]) {
          expect(loggedErrors).not.toContain(secret);
        }
      } finally {
        await contextServer.stop();
        errorSpy.mockRestore();
      }
    });

    it("should preserve configured Yoga plugins", async () => {
      let pluginExecuted = false;
      const pluginServer = new GraphQLServer({
        schemaOptions: {
          resolvers: [ProblemResolver],
          autoDiscover: false,
        },
        plugins: [
          {
            onExecute() {
              pluginExecuted = true;
            },
          },
        ],
      });

      await pluginServer.initialize();

      try {
        await executeQuery(pluginServer, "{ publicProblem }");
        expect(pluginExecuted).toBe(true);
      } finally {
        await pluginServer.stop();
      }
    });
  });

  describe("Container-resolved GraphQLAuthGuard", () => {
    const verifiedUser = { id: "authenticated-user" };
    const verifier = vi.fn();
    const resolverExecuted = vi.fn();
    let authServer: GraphQLServer;

    @Resolver()
    class AuthenticatedResolver {
      @Query(() => String)
      @UseGuards(GraphQLAuthGuard)
      authenticatedQuery(@Ctx() context: { user: typeof verifiedUser }): string {
        resolverExecuted(context.user);
        return context.user.id;
      }

      @Mutation(() => String)
      @UseGuards(GraphQLAuthGuard)
      authenticatedMutation(@Ctx() context: { user: typeof verifiedUser }): string {
        resolverExecuted(context.user);
        return context.user.id;
      }
    }

    beforeEach(async () => {
      Container.reset();
      verifier.mockReset();
      resolverExecuted.mockReset();
      Container.register(GraphQLAuthGuard, "singleton");
      Container.set(GRAPHQL_AUTH_GUARD_OPTIONS, { verifier });
      authServer = new GraphQLServer({
        schemaOptions: { resolvers: [AuthenticatedResolver], autoDiscover: false },
      });
      await authServer.initialize();
    });

    afterEach(async () => {
      await authServer.stop();
      Container.reset();
    });

    it.each([
      ["query", "authenticatedQuery"],
      ["mutation", "authenticatedMutation"],
    ])("should inject configured auth options for a protected %s", async (operation, field) => {
      verifier.mockResolvedValue(verifiedUser);

      const { data } = await executeQuery(authServer, `${operation} { ${field} }`, {
        authorization: "Bearer valid-token",
      });

      expect(data.errors).toBeUndefined();
      expect(data.data).toEqual({ [field]: verifiedUser.id });
      expect(verifier).toHaveBeenCalledExactlyOnceWith("valid-token");
      expect(resolverExecuted).toHaveBeenCalledExactlyOnceWith(verifiedUser);
      expect(resolverExecuted.mock.calls[0][0]).toBe(verifiedUser);
    });

    it.each([
      ["query", "authenticatedQuery"],
      ["mutation", "authenticatedMutation"],
    ])(
      "should reject a protected %s without a token before executing its resolver",
      async (operation, field) => {
        const { data } = await executeQuery(authServer, `${operation} { ${field} }`);

        expect(data.data).toBeNull();
        expect(data.errors[0].extensions).toMatchObject({
          code: "protocols-graphql/auth-missing-header",
          status: 401,
        });
        expect(verifier).not.toHaveBeenCalled();
        expect(resolverExecuted).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["query", "authenticatedQuery"],
      ["mutation", "authenticatedMutation"],
    ])(
      "should reject a protected %s with an invalid token before executing its resolver",
      async (operation, field) => {
        verifier.mockResolvedValue(null);

        const { data } = await executeQuery(authServer, `${operation} { ${field} }`, {
          authorization: "Bearer invalid-token",
        });

        expect(data.data).toBeNull();
        expect(data.errors[0].extensions).toMatchObject({
          code: "protocols-graphql/auth-invalid-token",
          status: 401,
        });
        expect(verifier).toHaveBeenCalledExactlyOnceWith("invalid-token");
        expect(resolverExecuted).not.toHaveBeenCalled();
      },
    );
  });

  describe("Declared policy execution", () => {
    beforeEach(() => {
      Container.reset();
      policyEvents.length = 0;
      Container.set(HeaderGuard, new HeaderGuard("Bearer admin"));
      Container.set(FirstPolicyInterceptor, new FirstPolicyInterceptor());
      Container.set(SecondPolicyInterceptor, new SecondPolicyInterceptor());
      Container.set(AllowFieldGuard, new AllowFieldGuard());
      Container.set(DenyFieldGuard, new DenyFieldGuard());
      Container.set(AllowSubscriptionGuard, new AllowSubscriptionGuard());
    });

    afterEach(() => {
      Container.reset();
    });

    it("should execute declared guards, roles, and interceptors in order", async () => {
      const policyServer = new GraphQLServer({
        schemaOptions: {
          resolvers: [PolicyResolver],
          autoDiscover: false,
        },
        context: () => ({ user: { roles: ["admin"] } }),
      });

      await policyServer.initialize();

      try {
        const { data } = await executeQuery(policyServer, "{ protectedValue }", {
          authorization: "Bearer admin",
        });

        expect(data.errors).toBeUndefined();
        expect(data.data.protectedValue).toBe("authorized");
        expect(policyEvents).toEqual([
          "guard",
          "first:before",
          "second:before",
          "resolver",
          "second:after",
          "first:after",
        ]);
      } finally {
        await policyServer.stop();
      }
    });

    it("should preserve Croco Problem semantics when a declared guard denies access", async () => {
      const policyServer = new GraphQLServer({
        schemaOptions: {
          resolvers: [PolicyResolver],
          autoDiscover: false,
        },
        context: () => ({ user: { roles: ["admin"] } }),
      });

      await policyServer.initialize();

      try {
        const { data } = await executeQuery(policyServer, "{ protectedValue }");

        expect(data.data).toBeNull();
        expect(data.errors[0]).toMatchObject({
          message: "Access denied by guard",
          extensions: {
            code: "protocols-graphql/guard-denied",
            status: 403,
          },
        });
        expect(policyEvents).toEqual(["guard"]);
      } finally {
        await policyServer.stop();
      }
    });

    it("should deny access when declared roles do not match the request context", async () => {
      const policyServer = new GraphQLServer({
        schemaOptions: {
          resolvers: [PolicyResolver],
          autoDiscover: false,
        },
        context: () => ({ user: { roles: ["member"] } }),
      });

      await policyServer.initialize();

      try {
        const { data } = await executeQuery(policyServer, "{ protectedValue }", {
          authorization: "Bearer admin",
        });

        expect(data.data).toBeNull();
        expect(data.errors[0]).toMatchObject({
          message: "Access denied by guard",
          extensions: {
            code: "protocols-graphql/guard-denied",
            status: 403,
          },
        });
        expect(policyEvents).toEqual(["guard"]);
      } finally {
        await policyServer.stop();
      }
    });

    it("should match field-resolver policies to their parent GraphQL type", async () => {
      const policyServer = new GraphQLServer({
        schemaOptions: {
          resolvers: [
            PolicyFieldQueryResolver,
            PolicyPersonFieldResolver,
            PolicyOrganizationFieldResolver,
          ],
          autoDiscover: false,
        },
      });

      await policyServer.initialize();

      try {
        const { data } = await executeQuery(policyServer, "{ person { id } organization { id } }");

        expect(data.data).toEqual({ person: { id: "person" }, organization: null });
        expect(data.errors[0]).toMatchObject({
          path: ["organization", "id"],
          extensions: {
            code: "protocols-graphql/guard-denied",
            status: 403,
          },
        });
      } finally {
        await policyServer.stop();
      }
    });

    it("should enforce declared policy before a subscription acquires an iterator", async () => {
      let subscribeCalls = 0;
      const schema = await SchemaCompiler.compileSchema({
        resolvers: [PolicySubscriptionResolver],
        autoDiscover: false,
        pubSub: {
          publish: async () => undefined,
          subscribe: () => {
            subscribeCalls++;
            return {
              [Symbol.asyncIterator](): AsyncIterator<unknown> {
                return {
                  next: async () => new Promise<IteratorResult<unknown>>(() => undefined),
                };
              },
            };
          },
        },
      });

      const subscription = schema.getSubscriptionType()?.getFields()["policyUpdate"]?.subscribe;
      expect(subscription).toBeDefined();

      await expect(
        subscription?.(undefined, {}, { user: { roles: ["member"] } }, undefined as never),
      ).rejects.toMatchObject({
        code: "protocols-graphql/guard-denied",
        status: 403,
      });
      expect(subscribeCalls).toBe(0);
    });
  });
});

async function executeQuery(
  server: GraphQLServer,
  query: string,
  headers: Record<string, string> = {},
) {
  const response = await server.getHandler()(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query }),
    }),
  );

  return {
    response,
    data: await response.json(),
  };
}

function sendRawHttpRequest(
  port: number,
  request: string,
  options: {
    readonly unfinished?: boolean;
    readonly continuation?: { readonly after: Promise<void>; readonly data: string };
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      if (options.unfinished) {
        socket.write(request);
        if (options.continuation !== undefined) {
          const continuation = options.continuation;
          void continuation.after.then(() => {
            if (!socket.destroyed) socket.write(continuation.data);
          });
        }
      } else {
        socket.end(request);
      }
    });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Server did not close the request socket within 1000 ms"));
    }, 1_000);

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(response);
    });
    socket.on("error", reject);
  });
}

function sendChunkedRequest(
  port: number,
  chunks: readonly string[],
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "localhost",
        port,
        path: "/graphql",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const responseChunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => responseChunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(responseChunks).toString(),
          });
        });
      },
    );

    request.on("error", reject);
    for (const chunk of chunks) {
      request.write(chunk);
    }
    request.end();
  });
}
