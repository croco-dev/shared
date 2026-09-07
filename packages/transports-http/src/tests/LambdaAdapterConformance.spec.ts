import "reflect-metadata";
import { Buffer } from "node:buffer";
import type { ILogger } from "@croco/framework-context";
import { Container, LOGGER_TOKEN } from "@croco/framework-context";
import { Logger } from "@croco/framework-logger";
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Options,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Raw,
} from "@croco/protocols-rest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp, type CrocoApp } from "../libs/CrocoApp";
import {
  getLambdaContext,
  getLambdaEvent,
  type LambdaExecutionContext,
} from "../libs/CrocoLambdaAdapter";
import { toLambdaHandler } from "../libs/adapters/LambdaAdapter";
import { ErrorHandler } from "../libs/ErrorHandler";
import { HealthCheckRegistry } from "../libs/HealthCheckRegistry";
import { bodyLimitMiddleware } from "../libs/middleware/BodyLimitMiddleware";
import type { LambdaContext, LambdaEvent } from "../libs/types";

type RawLambdaContext = LambdaExecutionContext & {
  req: {
    raw: Request;
  };
};

function createTestLogger(): ILogger {
  const logger: ILogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    debug: () => {},
    child: () => logger,
  };

  return logger;
}

function createLambdaContext(overrides: Partial<LambdaContext> = {}): LambdaContext {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: "lambda-conformance",
    functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:ap-northeast-2:123456789012:function:lambda-conformance",
    memoryLimitInMB: "128",
    awsRequestId: "aws-request-123",
    logGroupName: "/aws/lambda/lambda-conformance",
    logStreamName: "2026/07/09/[$LATEST]abcdef",
    getRemainingTimeInMillis: () => 3000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
    ...overrides,
  };
}

function createLambdaEvent(
  overrides: Partial<LambdaEvent> & {
    method?: string;
    path?: string;
    authorizer?: Record<string, unknown>;
  } = {},
): LambdaEvent {
  const method = overrides.method ?? "GET";
  const path = overrides.path ?? "/lambda-conformance/items/item-123";
  const requestContext = {
    accountId: "123456789012",
    apiId: "api-123",
    domainName: "example.execute-api.ap-northeast-2.amazonaws.com",
    domainPrefix: "example",
    http: {
      method,
      path,
      protocol: "HTTP/1.1",
      sourceIp: "203.0.113.10",
      userAgent: "vitest",
    },
    requestId: "api-request-123",
    routeKey: `${method} ${path}`,
    stage: "$default",
    time: "09/Jul/2026:14:00:00 +0000",
    timeEpoch: 1783605600000,
    ...(overrides.authorizer ? { authorizer: overrides.authorizer } : {}),
    ...overrides.requestContext,
  } as LambdaEvent["requestContext"];

  const event: LambdaEvent = {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    cookies: undefined,
    headers: {
      host: "example.execute-api.ap-northeast-2.amazonaws.com",
    },
    queryStringParameters: undefined,
    requestContext,
    body: undefined,
    pathParameters: undefined,
    isBase64Encoded: false,
    stageVariables: undefined,
  };

  return {
    ...event,
    ...overrides,
    requestContext,
    rawPath: overrides.rawPath ?? path,
    rawQueryString: overrides.rawQueryString ?? "",
  };
}

function createInvalidLambdaEvent(
  override: (event: LambdaEvent & Record<string, unknown>) => void,
): LambdaEvent {
  const event = createLambdaEvent() as LambdaEvent & Record<string, unknown>;
  override(event);
  return event;
}

async function readJsonBody(response: Awaited<ReturnType<ReturnType<typeof toLambdaHandler>>>) {
  return JSON.parse(response.body ?? "") as unknown;
}

describe("Lambda adapter API Gateway v2 conformance", () => {
  let app: CrocoApp;
  let handler: ReturnType<typeof toLambdaHandler>;
  let lambdaContext: LambdaContext;

  beforeEach(() => {
    Container.reset();
    const logger = createTestLogger();
    Container.set(Logger, logger);
    Container.set(LOGGER_TOKEN, logger);
    Container.set(ErrorHandler, new ErrorHandler(logger));
    Container.set(HealthCheckRegistry, new HealthCheckRegistry());

    app = createApp({
      controllers: [LambdaConformanceController],
      securityValidation: "off",
    });
    handler = toLambdaHandler(app);
    lambdaContext = createLambdaContext();
  });

  @Controller("/lambda-conformance")
  class LambdaConformanceController {
    @Get("/items/:id")
    getItem(
      @Param("id") id: string,
      @Query("tag", z.array(z.string()).optional()) tag: string[] | undefined,
      @Query("page") page: string | undefined,
      @Query("encoded") encoded: string | undefined,
      @Header("x-request-header") requestHeader: string | undefined,
      @Header("cookie") cookieHeader: string | undefined,
      @Raw() raw: RawLambdaContext,
    ) {
      const event = getLambdaEvent(raw);
      const url = new URL(raw.req.raw.url);

      return {
        method: raw.req.raw.method,
        path: url.pathname,
        id,
        tag,
        allTags: url.searchParams.getAll("tag"),
        page,
        encoded,
        requestHeader,
        cookieHeader,
        eventCookies: event?.cookies ?? [],
        authorizer: event?.requestContext.authorizer ?? null,
        requestId: event?.requestContext.requestId ?? null,
        stage: event?.requestContext.stage ?? null,
      };
    }

    @Post("/json")
    jsonBody(@Body() body: unknown, @Header("content-type") contentType: string | undefined) {
      return {
        contentType,
        body,
      };
    }

    @Put("/text")
    async textBody(@Raw() raw: RawLambdaContext): Promise<Response> {
      const text = await raw.req.raw.text();

      return new Response(text, {
        status: 202,
        headers: {
          "content-type": "text/plain",
          "x-text-length": String(text.length),
        },
      });
    }

    @Post("/binary")
    async binaryBody(@Raw() raw: RawLambdaContext): Promise<Response> {
      const bytes = new Uint8Array(await raw.req.raw.arrayBuffer());

      return new Response(bytes, {
        status: 201,
        headers: {
          "content-type": "image/png",
          "x-byte-length": String(bytes.byteLength),
        },
      });
    }

    @Delete("/items/:id")
    deleteItem(@Param("id") id: string): Response {
      return new Response(JSON.stringify({ deleted: true, id }), {
        status: 202,
        headers: {
          "content-type": "application/json",
          "x-delete-result": "accepted",
        },
      });
    }

    @Patch("/methods/:id")
    patchMethod(@Param("id") id: string) {
      return {
        method: "PATCH",
        id,
      };
    }

    @Options("/methods")
    optionsMethod(): Response {
      return new Response(null, {
        status: 204,
        headers: {
          allow: "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
          "x-options-result": "ok",
        },
      });
    }

    @Get("/head-target")
    headTarget(@Raw() raw: RawLambdaContext): Response {
      return new Response("head body must be stripped by the runtime", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "x-observed-method": raw.req.raw.method,
        },
      });
    }

    @Get("/cookies")
    responseCookies(): Response {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: [
          ["content-type", "application/json"],
          ["set-cookie", "session=abc; Path=/; HttpOnly"],
          ["set-cookie", "theme=dark; Path=/"],
          ["x-cookie-result", "ok"],
        ],
      });
    }

    @Get("/helpers")
    helpers(@Raw() raw: RawLambdaContext) {
      const event = getLambdaEvent(raw);
      const context = getLambdaContext(raw);

      return {
        routeKey: event?.routeKey ?? null,
        requestId: event?.requestContext.requestId ?? null,
        stage: event?.requestContext.stage ?? null,
        authorizer: event?.requestContext.authorizer ?? null,
        awsRequestId: context?.awsRequestId ?? null,
        functionName: context?.functionName ?? null,
      };
    }
  }

  it("maps common GET request metadata from API Gateway v2 events", async () => {
    const response = await handler(
      createLambdaEvent({
        method: "GET",
        path: "/lambda-conformance/items/item-123",
        rawQueryString: "tag=red&tag=blue&page=2&encoded=a%20b",
        headers: {
          host: "example.execute-api.ap-northeast-2.amazonaws.com",
          "x-request-header": "header-value",
          cookie: "a=1",
        },
        cookies: ["session=abc", "theme=dark"],
        authorizer: {
          jwt: {
            claims: {
              sub: "user-123",
            },
          },
        },
      }),
      lambdaContext,
    );

    expect(response.statusCode).toBe(200);
    expect(response.isBase64Encoded).toBe(false);
    expect(await readJsonBody(response)).toEqual({
      method: "GET",
      path: "/lambda-conformance/items/item-123",
      id: "item-123",
      tag: ["red", "blue"],
      allTags: ["red", "blue"],
      page: "2",
      encoded: "a b",
      requestHeader: "header-value",
      cookieHeader: "a=1; session=abc; theme=dark",
      eventCookies: ["session=abc", "theme=dark"],
      authorizer: {
        jwt: {
          claims: {
            sub: "user-123",
          },
        },
      },
      requestId: "api-request-123",
      stage: "$default",
    });
  });

  it("decodes JSON and text request bodies", async () => {
    const jsonResponse = await handler(
      createLambdaEvent({
        method: "POST",
        path: "/lambda-conformance/json",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Croco", count: 2 }),
      }),
      lambdaContext,
    );
    const textResponse = await handler(
      createLambdaEvent({
        method: "PUT",
        path: "/lambda-conformance/text",
        headers: {
          "content-type": "text/plain",
        },
        body: "plain body",
      }),
      lambdaContext,
    );

    expect(jsonResponse.statusCode).toBe(200);
    expect(await readJsonBody(jsonResponse)).toEqual({
      contentType: "application/json",
      body: {
        name: "Croco",
        count: 2,
      },
    });
    expect(textResponse.statusCode).toBe(202);
    expect(textResponse.headers?.["x-text-length"]).toBe("10");
    expect(textResponse.body).toBe("plain body");
    expect(textResponse.isBase64Encoded).toBe(false);
  });

  it("decodes base64 request bodies and base64-encodes binary responses", async () => {
    const input = Buffer.from([0, 1, 2, 3, 254, 255]);
    const response = await handler(
      createLambdaEvent({
        method: "POST",
        path: "/lambda-conformance/binary",
        headers: {
          "content-type": "application/octet-stream",
        },
        body: input.toString("base64"),
        isBase64Encoded: true,
      }),
      lambdaContext,
    );

    expect(response.statusCode).toBe(201);
    expect(response.headers?.["content-type"]).toBe("image/png");
    expect(response.headers?.["x-byte-length"]).toBe("6");
    expect(response.isBase64Encoded).toBe(true);
    expect(Buffer.from(response.body ?? "", "base64")).toEqual(input);
  });

  it("enforces the same actual-byte limit for Lambda text and base64 bodies", async () => {
    app = createApp({
      controllers: [LambdaConformanceController],
      middlewares: [bodyLimitMiddleware({ limit: 4 })],
      securityValidation: "off",
    });
    handler = toLambdaHandler(app);

    const acceptedText = await handler(
      createLambdaEvent({
        method: "PUT",
        path: "/lambda-conformance/text",
        headers: { "content-type": "text/plain" },
        body: "1234",
      }),
      lambdaContext,
    );
    const falseLowText = await handler(
      createLambdaEvent({
        method: "PUT",
        path: "/lambda-conformance/text",
        headers: { "content-type": "text/plain", "content-length": "1" },
        body: "12345",
      }),
      lambdaContext,
    );
    const malformedText = await handler(
      createLambdaEvent({
        method: "PUT",
        path: "/lambda-conformance/text",
        headers: { "content-type": "text/plain", "content-length": "4x" },
        body: "12345",
      }),
      lambdaContext,
    );
    const acceptedBinary = await handler(
      createLambdaEvent({
        method: "POST",
        path: "/lambda-conformance/binary",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from([0, 1, 2, 3]).toString("base64"),
        isBase64Encoded: true,
      }),
      lambdaContext,
    );
    const rejectedBinary = await handler(
      createLambdaEvent({
        method: "POST",
        path: "/lambda-conformance/binary",
        headers: { "content-type": "application/octet-stream", "content-length": "1" },
        body: Buffer.from([0, 1, 2, 3, 4]).toString("base64"),
        isBase64Encoded: true,
      }),
      lambdaContext,
    );

    expect(acceptedText.statusCode).toBe(202);
    expect(acceptedText.body).toBe("1234");
    for (const rejected of [falseLowText, malformedText, rejectedBinary]) {
      expect(rejected.statusCode).toBe(413);
      expect(await readJsonBody(rejected)).toMatchObject({
        code: "transports-http/request-body-too-large",
        status: 413,
        limit: 4,
      });
    }
    expect(acceptedBinary.statusCode).toBe(201);
    expect(Buffer.from(acceptedBinary.body ?? "", "base64")).toEqual(Buffer.from([0, 1, 2, 3]));
  });

  it("serializes response status, headers, cookies, and JSON bodies", async () => {
    const deleteResponse = await handler(
      createLambdaEvent({
        method: "DELETE",
        path: "/lambda-conformance/items/item-123",
      }),
      lambdaContext,
    );
    const cookieResponse = await handler(
      createLambdaEvent({
        method: "GET",
        path: "/lambda-conformance/cookies",
      }),
      lambdaContext,
    );

    expect(deleteResponse.statusCode).toBe(202);
    expect(deleteResponse.headers?.["x-delete-result"]).toBe("accepted");
    expect(await readJsonBody(deleteResponse)).toEqual({
      deleted: true,
      id: "item-123",
    });
    expect(cookieResponse.statusCode).toBe(200);
    expect(cookieResponse.headers?.["x-cookie-result"]).toBe("ok");
    expect(cookieResponse.cookies).toEqual(["session=abc; Path=/; HttpOnly", "theme=dark; Path=/"]);
    expect(await readJsonBody(cookieResponse)).toEqual({ ok: true });
  });

  it("passes PATCH, OPTIONS, and HEAD method shapes through the Lambda adapter", async () => {
    const patchResponse = await handler(
      createLambdaEvent({
        method: "PATCH",
        path: "/lambda-conformance/methods/patch-123",
      }),
      lambdaContext,
    );
    const optionsResponse = await handler(
      createLambdaEvent({
        method: "OPTIONS",
        path: "/lambda-conformance/methods",
      }),
      lambdaContext,
    );
    const headResponse = await handler(
      createLambdaEvent({
        method: "HEAD",
        path: "/lambda-conformance/head-target",
      }),
      lambdaContext,
    );

    expect(patchResponse.statusCode).toBe(200);
    expect(await readJsonBody(patchResponse)).toEqual({
      method: "PATCH",
      id: "patch-123",
    });
    expect(optionsResponse.statusCode).toBe(204);
    expect(optionsResponse.headers?.allow).toBe("GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD");
    expect(optionsResponse.headers?.["x-options-result"]).toBe("ok");
    expect(optionsResponse.body).toBe("");
    expect(headResponse.statusCode).toBe(200);
    expect(headResponse.headers?.["x-observed-method"]).toBe("HEAD");
    expect(headResponse.body).toBe("");
  });

  it("exposes original Lambda event and context through helper functions", async () => {
    const response = await handler(
      createLambdaEvent({
        method: "GET",
        path: "/lambda-conformance/helpers",
        routeKey: "GET /lambda-conformance/helpers",
        requestContext: {
          accountId: "123456789012",
          apiId: "api-123",
          domainName: "example.execute-api.ap-northeast-2.amazonaws.com",
          domainPrefix: "example",
          http: {
            method: "GET",
            path: "/lambda-conformance/helpers",
            protocol: "HTTP/1.1",
            sourceIp: "203.0.113.10",
            userAgent: "vitest",
          },
          requestId: "api-request-helpers",
          routeKey: "GET /lambda-conformance/helpers",
          stage: "prod",
          time: "09/Jul/2026:14:00:00 +0000",
          timeEpoch: 1783605600000,
          authorizer: {
            lambda: {
              tenantId: "tenant-123",
            },
          },
        },
      }),
      createLambdaContext({
        awsRequestId: "aws-request-helpers",
        functionName: "lambda-helper-conformance",
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(await readJsonBody(response)).toEqual({
      routeKey: "GET /lambda-conformance/helpers",
      requestId: "api-request-helpers",
      stage: "prod",
      authorizer: {
        lambda: {
          tenantId: "tenant-123",
        },
      },
      awsRequestId: "aws-request-helpers",
      functionName: "lambda-helper-conformance",
    });
  });

  it("rejects malformed or unsupported API Gateway v2 event shapes", async () => {
    const invalidEvents = [
      null as unknown as LambdaEvent,
      createInvalidLambdaEvent((event) => {
        event.version = "1.0";
      }),
      createInvalidLambdaEvent((event) => {
        delete (event as Partial<LambdaEvent>).rawPath;
      }),
      createInvalidLambdaEvent((event) => {
        event.rawPath = "lambda-conformance/items/item-123";
      }),
      createInvalidLambdaEvent((event) => {
        delete (event as Partial<LambdaEvent>).rawQueryString;
      }),
      createInvalidLambdaEvent((event) => {
        delete (event.requestContext.http as Partial<LambdaEvent["requestContext"]["http"]>).method;
      }),
      createInvalidLambdaEvent((event) => {
        event.body = "not-valid-base64!";
        event.isBase64Encoded = true;
      }),
    ];

    for (const event of invalidEvents) {
      await expect(handler(event, lambdaContext)).rejects.toMatchObject({
        name: "LambdaEventValidationError",
        code: "transports-http/lambda-event-invalid",
      });
    }
  });

  it("flushes before rejecting a malformed API Gateway v2 event", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const flushingHandler = toLambdaHandler(app, { flush });

    await expect(
      flushingHandler(
        createInvalidLambdaEvent((event) => {
          event.version = "1.0";
        }),
        lambdaContext,
      ),
    ).rejects.toMatchObject({
      name: "LambdaEventValidationError",
      code: "transports-http/lambda-event-invalid",
    });

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
