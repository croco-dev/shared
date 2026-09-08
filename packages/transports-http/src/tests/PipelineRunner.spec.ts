import "reflect-metadata";
import {
  Container,
  Context,
  DEV_INSPECTOR_TOKEN,
  RuntimeInspector,
} from "@croco/framework-context";
import { Logger } from "@croco/framework-logger";
import { Problem, ProblemCategory, ProblemFactory } from "@croco/problems-core";
import { HttpExceptionFilter } from "@croco/protocols-rest";
import type { ExceptionFilter, HttpExceptionFilterResponse } from "@croco/protocols-rest";
import { type Span, trace } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTP_CONTEXT_KEYS } from "../libs/contextKeys";
import { ErrorHandler } from "../libs/ErrorHandler";
import { HttpExecutionContext } from "../libs/HttpExecutionContext";
import { PipelineRunner, describeHttpPipelineGraph } from "../libs/PipelineRunner";
import type { CrocoHttpContext } from "../libs/types";

function createMockHttpContext(): CrocoHttpContext {
  const request = new Request("http://localhost/test");

  const req = {
    method: "GET",
    url: request.url,
    path: "/test",
    params: {},
    query: {},
    headers: {},
  };

  const res = {
    status: 200,
    headers: {},
  };

  return {
    req,
    res,
    raw: {
      req: {
        raw: request,
      },
    } as CrocoHttpContext["raw"],
    param: vi.fn(),
    query: vi.fn(),
    header: vi.fn(),
    json: vi.fn(),
    set: vi.fn(),
    get: vi.fn(),
    text: vi
      .fn()
      .mockImplementation((body: string, status: number = 200) => new Response(body, { status })),
    jsonResponse: vi
      .fn()
      .mockImplementation(
        (body: unknown, status: number = 200) => new Response(JSON.stringify(body), { status }),
      ),
    redirect: vi
      .fn()
      .mockImplementation((url: string, status: number = 302) => Response.redirect(url, status)),
  };
}

class OperatorOnlyProblem extends Problem {
  constructor() {
    super(
      "transports-http/di-bootstrap-validation",
      ProblemCategory.InternalServerError,
      "DI bootstrap failed for tenant secret-tenant",
      {
        extensions: {
          issues: [{ message: "container token missing" }],
          reason: "di_failure",
          rawProviderResponse: { token: "secret-provider-token" },
        },
      },
    );
  }
}

class CustomStatusProblem extends Problem {
  constructor(detail: string) {
    super("test/custom-status", ProblemCategory.BadRequest, detail);
  }

  override get status(): number {
    return 418;
  }
}

describe("PipelineRunner", () => {
  let logger!: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    fatal: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    child: ReturnType<typeof vi.fn>;
  };

  type MockSpan = Span & {
    addEvent: ReturnType<typeof vi.fn>;
    recordException: ReturnType<typeof vi.fn>;
  };

  function createMockSpan(): MockSpan {
    const setAttribute = vi.fn();
    const setAttributes = vi.fn();
    const addEvent = vi.fn();
    const addLink = vi.fn();
    const addLinks = vi.fn();
    const setStatus = vi.fn();
    const updateName = vi.fn();

    const span = {
      spanContext: vi.fn().mockReturnValue({
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        traceFlags: 1,
      }),
      setAttribute,
      setAttributes,
      addEvent,
      addLink,
      addLinks,
      setStatus,
      updateName,
      end: vi.fn(),
      isRecording: vi.fn().mockReturnValue(true),
      recordException: vi.fn(),
    } as unknown as MockSpan;

    setAttribute.mockReturnValue(span);
    setAttributes.mockReturnValue(span);
    addEvent.mockReturnValue(span);
    addLink.mockReturnValue(span);
    addLinks.mockReturnValue(span);
    setStatus.mockReturnValue(span);
    updateName.mockReturnValue(span);

    return span;
  }

  function createRunner(): PipelineRunner {
    return new PipelineRunner(Container.get(ErrorHandler), logger as unknown as Logger);
  }

  function filterResponse(
    status: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = { "Content-Type": "application/json" },
  ): HttpExceptionFilterResponse {
    return { status, headers, body };
  }

  beforeEach(() => {
    Container.reset();
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => logger),
    };
    Container.set(Logger, logger as unknown as Logger);
    Container.set(ErrorHandler, new ErrorHandler(logger as unknown as Logger));
  });

  it("rejects conflicting tenants before guards while keeping the request readable by filters", async () => {
    const http = createMockHttpContext();
    Object.assign(http.raw.req.raw, { tenantId: "tenant-request" });
    vi.mocked(http.get).mockReturnValue("tenant-http");
    const context = new HttpExecutionContext(http, class Controller {}, "handler");
    const canActivate = vi.fn(() => true);
    const handler = vi.fn(async () => "should not run");
    const filter = new HttpExceptionFilter();
    const catchSpy = vi.spyOn(filter, "catch");

    const result = await createRunner().run(context, handler, {
      guards: [{ canActivate }],
      interceptors: [],
      filters: [filter],
    });

    expect(canActivate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(catchSpy).toHaveReturnedWith(expect.objectContaining({ status: 403 }));
    expect(context.getRequest().url).toBe("http://localhost/test");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "ACCESS_DENIED", status: 403 });
    expect(logger.warn).not.toHaveBeenCalledWith("CROCO_HTTP_FILTER_001", expect.anything());
  });

  it.each([undefined, "", "tenant-http"])(
    "allows compatible request tenant %j through guards",
    async (tenantId) => {
      const http = createMockHttpContext();
      Object.assign(http.raw.req.raw, { tenantId });
      vi.mocked(http.get).mockReturnValue("tenant-http");
      const context = new HttpExecutionContext(http, class Controller {}, "handler");
      const canActivate = vi.fn(() => {
        expect(context.getRequest()).toMatchObject({ tenantId: "tenant-http" });
        return true;
      });
      const handler = vi.fn(async () => "allowed");

      await expect(
        createRunner().run(context, handler, {
          guards: [{ canActivate }],
          interceptors: [],
          filters: [],
        }),
      ).resolves.toBe("allowed");
      expect(canActivate).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("BUG-03 명시적 의존성으로 PipelineRunner 생성 가능", () => {
    expect(() => createRunner()).not.toThrow();
  });

  it("BUG-01 다중 ExceptionFilter 중 매칭 필터 실행", async () => {
    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const httpProblem = ProblemFactory.badRequest("BAD_REQUEST", "bad request");

    const httpProblemFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockImplementation((error: unknown) => {
        if (error instanceof Problem) {
          return filterResponse(409, { code: "HTTP_PROBLEM_FILTER" });
        }
        throw error;
      }),
    };

    const genericFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockReturnValue(filterResponse(500, { code: "GENERIC_FILTER" })),
    };

    const httpProblemResult = await runner.run(
      execContext,
      async () => {
        throw httpProblem;
      },
      {
        guards: [],
        interceptors: [],
        filters: [httpProblemFilter, genericFilter],
      },
    );

    expect(httpProblemResult).toBeInstanceOf(Response);
    expect((httpProblemResult as Response).status).toBe(409);
    expect(await (httpProblemResult as Response).json()).toEqual({ code: "HTTP_PROBLEM_FILTER" });
    expect(httpProblemFilter.catch).toHaveBeenCalledTimes(1);
    expect(genericFilter.catch).not.toHaveBeenCalled();

    const genericErrorResult = await runner.run(
      execContext,
      async () => {
        throw new TypeError("generic failure");
      },
      {
        guards: [],
        interceptors: [],
        filters: [httpProblemFilter, genericFilter],
      },
    );

    expect(genericErrorResult).toBeInstanceOf(Response);
    expect((genericErrorResult as Response).status).toBe(500);
    expect(await (genericErrorResult as Response).json()).toEqual({ code: "GENERIC_FILTER" });
    expect(httpProblemFilter.catch).toHaveBeenCalledTimes(2);
    expect(genericFilter.catch).toHaveBeenCalledTimes(1);
  });

  it("BUG-02 ErrorHandler가 Logger를 가져야 함", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => logger),
    };

    Container.set(Logger, logger as unknown as Logger);
    Container.set(ErrorHandler, new ErrorHandler(logger as unknown as Logger));

    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );

    const result = await runner.run(
      execContext,
      async () => {
        throw new TypeError("boom");
      },
      {
        guards: [],
        interceptors: [],
        filters: [],
      },
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("should preserve the original business error when a filter throws", async () => {
    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const originalProblem = new CustomStatusProblem("original business error");

    const brokenFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockImplementation(() => {
        throw new Error("filter failure");
      }),
    };

    const result = await runner.run(
      execContext,
      async () => {
        throw originalProblem;
      },
      {
        guards: [],
        interceptors: [],
        filters: [brokenFilter],
      },
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(418);
    expect(await (result as Response).json()).toMatchObject({
      code: "test/custom-status",
      detail: "original business error",
      status: 418,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "CROCO_HTTP_FILTER_001",
      expect.objectContaining({
        diagnosticCode: "CROCO_HTTP_FILTER_001",
        filter: "filter[0]",
        reason: "thrown",
        originalProblemCode: "test/custom-status",
        originalProblemCategory: originalProblem.category,
        originalProblemStatus: 418,
      }),
    );
  });

  it("should treat undefined filter results as not handled", async () => {
    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const originalProblem = ProblemFactory.badRequest("BAD_REQUEST", "not handled");

    const passThroughFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockReturnValue(undefined),
    };

    const result = await runner.run(
      execContext,
      async () => {
        throw originalProblem;
      },
      {
        guards: [],
        interceptors: [],
        filters: [passThroughFilter],
      },
    );

    expect(passThroughFilter.catch).toHaveBeenCalledWith(originalProblem, execContext);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(await (result as Response).json()).toMatchObject({
      code: "BAD_REQUEST",
      detail: "not handled",
      status: 400,
    });
    expect(logger.warn).not.toHaveBeenCalledWith("CROCO_HTTP_FILTER_001", expect.anything());
  });

  it("should let a later filter handle the original error after an earlier filter throws", async () => {
    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const originalProblem = ProblemFactory.badRequest("BAD_REQUEST", "original");

    const brokenFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockImplementation(() => {
        throw new Error("filter failure");
      }),
    };
    const handlingFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockReturnValue(filterResponse(422, { code: "HANDLED_AFTER_FAILURE" })),
    };

    const result = await runner.run(
      execContext,
      async () => {
        throw originalProblem;
      },
      {
        guards: [],
        interceptors: [],
        filters: [brokenFilter, handlingFilter],
      },
    );

    expect(handlingFilter.catch).toHaveBeenCalledWith(originalProblem, execContext);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(422);
    expect(await (result as Response).json()).toEqual({ code: "HANDLED_AFTER_FAILURE" });
    expect(logger.warn).toHaveBeenCalledWith(
      "CROCO_HTTP_FILTER_001",
      expect.objectContaining({
        diagnosticCode: "CROCO_HTTP_FILTER_001",
        reason: "thrown",
      }),
    );
  });

  it("should record every throwing filter and fall back to the original route error", async () => {
    const runner = createRunner();
    const inspector = new RuntimeInspector();
    Container.set(DEV_INSPECTOR_TOKEN, inspector);
    inspector.startRequest({ requestId: "req-filter-all-throw" });

    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const originalProblem = new CustomStatusProblem("preserved");

    const filters: ExceptionFilter<unknown, HttpExecutionContext>[] = [
      {
        catch: vi.fn().mockImplementation(() => {
          throw new Error("first filter failure");
        }),
      },
      {
        catch: vi.fn().mockImplementation(() => {
          throw new TypeError("second filter failure");
        }),
      },
    ];

    const result = await Context.run({ requestId: "req-filter-all-throw" }, () =>
      runner.run(
        execContext,
        async () => {
          throw originalProblem;
        },
        {
          guards: [],
          interceptors: [],
          filters,
        },
      ),
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(418);
    expect(await (result as Response).json()).toMatchObject({
      code: "test/custom-status",
      detail: "preserved",
      status: 418,
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      "CROCO_HTTP_FILTER_001",
      expect.objectContaining({
        diagnosticCode: "CROCO_HTTP_FILTER_001",
        filterIndex: 0,
        reason: "thrown",
      }),
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      "CROCO_HTTP_FILTER_001",
      expect.objectContaining({
        diagnosticCode: "CROCO_HTTP_FILTER_001",
        filterIndex: 1,
        reason: "thrown",
      }),
    );

    const timeline = inspector.snapshot().requests[0]?.timeline ?? [];
    expect(timeline.filter((event) => event.name === "CROCO_HTTP_FILTER_001")).toHaveLength(2);
    expect(timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "problem",
          name: "test/custom-status",
          details: expect.objectContaining({ status: 418 }),
        }),
      ]),
    );
  });

  it("should record invalid filter results and fall back to the original route error", async () => {
    const runner = createRunner();
    const inspector = new RuntimeInspector();
    Container.set(DEV_INSPECTOR_TOKEN, inspector);
    inspector.startRequest({ requestId: "req-filter-invalid-result" });

    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const originalProblem = ProblemFactory.badRequest("BAD_REQUEST", "invalid filter return");

    const invalidFilters = [
      {
        catch: vi.fn().mockReturnValue({ status: Number.NaN, headers: {}, body: {} }),
      },
      {
        catch: vi.fn().mockReturnValue(filterResponse(199, { code: "FILTER_STATUS_BELOW_RANGE" })),
      },
      {
        catch: vi.fn().mockReturnValue(filterResponse(600, { code: "FILTER_STATUS_ABOVE_RANGE" })),
      },
      {
        catch: vi.fn().mockReturnValue(filterResponse(200.5, { code: "FILTER_STATUS_FRACTIONAL" })),
      },
      {
        catch: vi.fn().mockReturnValue({ status: 400, headers: new Map(), body: {} }),
      },
      {
        catch: vi.fn().mockReturnValue({ status: 400, headers: { "x-filter": 123 }, body: {} }),
      },
      {
        catch: vi.fn().mockReturnValue({ status: 400, headers: {}, body: [] }),
      },
    ] as unknown as ExceptionFilter<unknown, HttpExecutionContext>[];

    const result = await Context.run({ requestId: "req-filter-invalid-result" }, () =>
      runner.run(
        execContext,
        async () => {
          throw originalProblem;
        },
        {
          guards: [],
          interceptors: [],
          filters: invalidFilters,
        },
      ),
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(await (result as Response).json()).toMatchObject({
      code: "BAD_REQUEST",
      detail: "invalid filter return",
      status: 400,
    });
    expect(logger.warn).toHaveBeenCalledTimes(7);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      "CROCO_HTTP_FILTER_001",
      expect.objectContaining({
        diagnosticCode: "CROCO_HTTP_FILTER_001",
        filterIndex: 0,
        reason: "invalid-return",
        resultType: "object",
      }),
    );
    for (const [callNumber, filterIndex] of [
      [2, 1],
      [3, 2],
      [4, 3],
    ] as const) {
      expect(logger.warn).toHaveBeenNthCalledWith(
        callNumber,
        "CROCO_HTTP_FILTER_001",
        expect.objectContaining({
          diagnosticCode: "CROCO_HTTP_FILTER_001",
          filterIndex,
          reason: "invalid-return",
          resultType: "object",
        }),
      );
      expect(logger.warn.mock.calls[callNumber - 1]?.[1]).not.toHaveProperty("filterErrorName");
    }

    const timeline = inspector.snapshot().requests[0]?.timeline ?? [];
    expect(timeline.filter((event) => event.name === "CROCO_HTTP_FILTER_001")).toHaveLength(7);
  });

  it("should keep filter diagnostics non-throwing for null-prototype filter objects", async () => {
    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const originalProblem = ProblemFactory.badRequest("BAD_REQUEST", "null prototype filter");
    const nullPrototypeFilter = Object.assign(Object.create(null), {
      catch: vi.fn().mockReturnValue({ status: 400, headers: {}, body: [] }),
    }) as ExceptionFilter<unknown, HttpExecutionContext>;

    const result = await runner.run(
      execContext,
      async () => {
        throw originalProblem;
      },
      {
        guards: [],
        interceptors: [],
        filters: [nullPrototypeFilter],
      },
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(await (result as Response).json()).toMatchObject({
      code: "BAD_REQUEST",
      detail: "null prototype filter",
      status: 400,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "CROCO_HTTP_FILTER_001",
      expect.objectContaining({
        diagnosticCode: "CROCO_HTTP_FILTER_001",
        filter: "filter[0]",
        reason: "invalid-return",
      }),
    );
  });

  it("should record filter failures on the active OpenTelemetry span", async () => {
    const runner = createRunner();
    const span = createMockSpan();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const originalProblem = ProblemFactory.badRequest("BAD_REQUEST", "span evidence");

    const brokenFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockImplementation(() => {
        throw new Error("filter span failure");
      }),
    };

    const getActiveSpan = vi.spyOn(trace, "getActiveSpan").mockReturnValue(span);
    const result = await runner.run(
      execContext,
      async () => {
        throw originalProblem;
      },
      {
        guards: [],
        interceptors: [],
        filters: [brokenFilter],
      },
    );
    getActiveSpan.mockRestore();

    expect(result).toBeInstanceOf(Response);
    expect(span.addEvent).toHaveBeenCalledWith(
      "croco.http.exception_filter.failed",
      expect.objectContaining({
        "croco.diagnostic.code": "CROCO_HTTP_FILTER_001",
        "croco.http.exception_filter.index": 0,
        "croco.http.exception_filter.reason": "thrown",
        "croco.problem.original.code": "BAD_REQUEST",
        "croco.problem.original.status": 400,
      }),
    );
    expect(span.recordException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Error",
        message: "filter span failure",
      }),
    );
  });

  it("should let a later filter handle the original error when every diagnostic sink throws", async () => {
    const diagnosticFailures = {
      logger: new Error("logger failed"),
      inspector: new Error("inspector failed"),
      spanEvent: new Error("span event failed"),
      spanException: new Error("span exception failed"),
    };
    logger.warn.mockImplementation(() => {
      throw diagnosticFailures.logger;
    });

    const inspector = new RuntimeInspector();
    const recordEvent = vi.spyOn(inspector, "recordEvent").mockImplementation((input) => {
      if (input.kind === "diagnostic") {
        throw diagnosticFailures.inspector;
      }
    });
    Container.set(DEV_INSPECTOR_TOKEN, inspector);

    const span = createMockSpan();
    span.addEvent.mockImplementation(() => {
      throw diagnosticFailures.spanEvent;
    });
    span.recordException.mockImplementation(() => {
      throw diagnosticFailures.spanException;
    });
    const getActiveSpan = vi.spyOn(trace, "getActiveSpan").mockReturnValue(span);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("diagnostic fallback failed");
    });

    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const originalProblem = ProblemFactory.badRequest("BAD_REQUEST", "original");
    const brokenFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockImplementation(() => {
        throw new Error("filter failed");
      }),
    };
    const handlingFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockReturnValue(filterResponse(422, { code: "HANDLED_AFTER_FAILURE" })),
    };

    try {
      const result = await runner.run(
        execContext,
        async () => {
          throw originalProblem;
        },
        {
          guards: [],
          interceptors: [],
          filters: [brokenFilter, handlingFilter],
        },
      );

      expect(handlingFilter.catch).toHaveBeenCalledWith(originalProblem, execContext);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(422);
      expect(await (result as Response).json()).toEqual({ code: "HANDLED_AFTER_FAILURE" });
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "diagnostic", name: "CROCO_HTTP_FILTER_001" }),
      );
      expect(span.addEvent).toHaveBeenCalledOnce();
      expect(span.recordException).toHaveBeenCalledOnce();
      expect(consoleWarn).toHaveBeenCalledTimes(4);
      expect(consoleWarn.mock.calls.map(([, details]) => details)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sink: "logger", errorName: "Error" }),
          expect.objectContaining({ sink: "inspector", errorName: "Error" }),
          expect.objectContaining({ sink: "span.addEvent", errorName: "Error" }),
          expect.objectContaining({ sink: "span.recordException", errorName: "Error" }),
        ]),
      );
    } finally {
      getActiveSpan.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("should let a later filter handle the original error when inspector resolution throws", async () => {
    const inspectorFailure = new Error("inspector resolution failed");
    const getOptional = vi
      .spyOn(Container, "getOptional")
      .mockReturnValueOnce(undefined)
      .mockImplementation(() => {
        throw inspectorFailure;
      });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const originalProblem = ProblemFactory.badRequest("BAD_REQUEST", "original");
    const brokenFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockImplementation(() => {
        throw new Error("filter failed");
      }),
    };
    const handlingFilter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockReturnValue(filterResponse(422, { code: "HANDLED_AFTER_FAILURE" })),
    };

    try {
      const result = await runner.run(
        execContext,
        async () => {
          throw originalProblem;
        },
        {
          guards: [],
          interceptors: [],
          filters: [brokenFilter, handlingFilter],
        },
      );

      expect(handlingFilter.catch).toHaveBeenCalledWith(originalProblem, execContext);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(422);
      expect(await (result as Response).json()).toEqual({ code: "HANDLED_AFTER_FAILURE" });
      expect(consoleWarn).toHaveBeenCalledWith(
        "Exception filter diagnostic sink failed",
        expect.objectContaining({ sink: "inspector", errorName: "Error" }),
      );
    } finally {
      getOptional.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("should preserve the original fallback response when filter diagnostics throw", async () => {
    logger.warn.mockImplementation(() => {
      throw new Error("logger failed");
    });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const originalProblem = new CustomStatusProblem("preserved fallback");
    const filters: ExceptionFilter<unknown, HttpExecutionContext>[] = [
      {
        catch: vi.fn().mockImplementation(() => {
          throw new Error("first filter failed");
        }),
      },
      {
        catch: vi.fn().mockImplementation(() => {
          throw new Error("second filter failed");
        }),
      },
    ];

    try {
      const result = await runner.run(
        execContext,
        async () => {
          throw originalProblem;
        },
        {
          guards: [],
          interceptors: [],
          filters,
        },
      );

      expect(filters[0]?.catch).toHaveBeenCalledWith(originalProblem, execContext);
      expect(filters[1]?.catch).toHaveBeenCalledWith(originalProblem, execContext);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(418);
      expect(await (result as Response).json()).toMatchObject({
        code: "test/custom-status",
        detail: "preserved fallback",
        status: 418,
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("should redact Problem Details returned from async exception filters", async () => {
    const runner = createRunner();
    const httpContext = createMockHttpContext();
    httpContext.get = vi.fn((key: string) =>
      key === HTTP_CONTEXT_KEYS.traceId ? "filter-trace" : undefined,
    ) as CrocoHttpContext["get"];
    const execContext = new HttpExecutionContext(httpContext, class TestController {}, "handler");
    const filter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockImplementation(async (error: unknown) => {
        if (error instanceof Problem) {
          return {
            status: error.status,
            headers: { "Content-Type": "application/problem+json" },
            body: error.toJSON(),
          };
        }

        throw error;
      }),
    };

    const result = await Context.run({ requestId: "filter-request" }, () =>
      runner.run(
        execContext,
        async () => {
          throw new OperatorOnlyProblem();
        },
        {
          guards: [],
          interceptors: [],
          filters: [filter],
        },
      ),
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);

    const body = await (result as Response).json();
    expect(body).toEqual(
      expect.objectContaining({
        status: 500,
        code: "transports-http/di-bootstrap-validation",
        detail: "An internal error occurred",
        instance: "http://localhost/test",
        traceId: "filter-trace",
        requestId: "filter-request",
      }),
    );
    expect(body).not.toHaveProperty("issues");
    expect(body).not.toHaveProperty("reason");
    expect(body).not.toHaveProperty("rawProviderResponse");
    expect(JSON.stringify(body)).not.toContain("secret-tenant");
    expect(JSON.stringify(body)).not.toContain("secret-provider-token");
  });

  it("should fail closed for unrecognized application/problem+json FilterResponse bodies", async () => {
    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const filter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockImplementation(async (error: unknown) => {
        if (error instanceof Problem) {
          return {
            status: 500,
            headers: {
              "Cache-Control": "no-store",
              "Content-Digest": "sha-256=:stale-digest:",
              "Content-Encoding": "gzip",
              "Content-Length": "999",
              "Content-MD5": "stale-md5",
              "Content-Type": "Application/Problem+Json",
              Digest: "sha-256=:stale-digest:",
              ETag: '"stale-etag"',
              "Repr-Digest": "sha-256=:stale-repr-digest:",
            },
            body: {
              leak: "secret-provider-token",
              rawProviderResponse: { tenant: "secret-tenant" },
              status: 500,
            },
          };
        }

        throw error;
      }),
    };

    const result = await runner.run(
      execContext,
      async () => {
        throw new OperatorOnlyProblem();
      },
      {
        guards: [],
        interceptors: [],
        filters: [filter],
      },
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    expect((result as Response).headers.get("Cache-Control")).toBe("no-store");
    expect((result as Response).headers.get("Content-Digest")).toBeNull();
    expect((result as Response).headers.get("Content-Encoding")).toBeNull();
    expect((result as Response).headers.get("Content-Length")).toBeNull();
    expect((result as Response).headers.get("Content-MD5")).toBeNull();
    expect((result as Response).headers.get("Digest")).toBeNull();
    expect((result as Response).headers.get("ETag")).toBeNull();
    expect((result as Response).headers.get("Repr-Digest")).toBeNull();

    const body = await (result as Response).json();
    expect(body).toEqual(
      expect.objectContaining({
        status: 500,
        code: "transports-http/di-bootstrap-validation",
        detail: "An internal error occurred",
        instance: "http://localhost/test",
      }),
    );
    expect(JSON.stringify(body)).not.toContain("secret-provider-token");
    expect(JSON.stringify(body)).not.toContain("secret-tenant");
    expect(JSON.stringify(body)).not.toContain("rawProviderResponse");
  });

  it("should redact application/problem+json Response returned from async exception filters", async () => {
    const runner = createRunner();
    const execContext = new HttpExecutionContext(
      createMockHttpContext(),
      class TestController {},
      "handler",
    );
    const filter: ExceptionFilter<unknown, HttpExecutionContext> = {
      catch: vi.fn().mockImplementation(async (error: unknown) => {
        if (error instanceof Problem) {
          return new Response(JSON.stringify(error.toJSON()), {
            status: error.status,
            headers: {
              "Cache-Control": "no-store",
              "Content-Digest": "sha-256=:stale-digest:",
              "Content-Encoding": "gzip",
              "Content-Length": "999",
              "Content-MD5": "stale-md5",
              "Content-Type": "Application/Problem+Json",
              Digest: "sha-256=:stale-digest:",
              ETag: '"stale-etag"',
              "Repr-Digest": "sha-256=:stale-repr-digest:",
            },
          });
        }

        throw error;
      }),
    };

    const result = await runner.run(
      execContext,
      async () => {
        throw new OperatorOnlyProblem();
      },
      {
        guards: [],
        interceptors: [],
        filters: [filter],
      },
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    expect((result as Response).headers.get("Cache-Control")).toBe("no-store");
    expect((result as Response).headers.get("Content-Digest")).toBeNull();
    expect((result as Response).headers.get("Content-Encoding")).toBeNull();
    expect((result as Response).headers.get("Content-Length")).toBeNull();
    expect((result as Response).headers.get("Content-MD5")).toBeNull();
    expect((result as Response).headers.get("Digest")).toBeNull();
    expect((result as Response).headers.get("ETag")).toBeNull();
    expect((result as Response).headers.get("Repr-Digest")).toBeNull();

    const body = await (result as Response).json();
    expect(body).toEqual(
      expect.objectContaining({
        status: 500,
        code: "transports-http/di-bootstrap-validation",
        detail: "An internal error occurred",
        instance: "http://localhost/test",
      }),
    );
    expect(body).not.toHaveProperty("issues");
    expect(body).not.toHaveProperty("reason");
    expect(body).not.toHaveProperty("rawProviderResponse");
    expect(JSON.stringify(body)).not.toContain("secret-tenant");
    expect(JSON.stringify(body)).not.toContain("secret-provider-token");
  });

  it.each([
    { name: "malformed JSON", responseBody: "{not-json secret-provider-token" },
    { name: "non-object JSON", responseBody: JSON.stringify(["secret-provider-token"]) },
    {
      name: "unrecognized object",
      responseBody: JSON.stringify({ leak: "secret-provider-token", status: 500 }),
    },
  ])(
    "should fail closed for $name application/problem+json Response bodies returned from filters",
    async ({ responseBody }) => {
      const runner = createRunner();
      const execContext = new HttpExecutionContext(
        createMockHttpContext(),
        class TestController {},
        "handler",
      );
      const filter: ExceptionFilter<unknown, HttpExecutionContext> = {
        catch: vi.fn().mockResolvedValue(
          new Response(responseBody, {
            status: 500,
            headers: {
              "Cache-Control": "no-store",
              "Content-Digest": "sha-256=:stale-digest:",
              "Content-Encoding": "gzip",
              "Content-Length": "999",
              "Content-MD5": "stale-md5",
              "Content-Type": "application/problem+json",
              Digest: "sha-256=:stale-digest:",
              ETag: '"stale-etag"',
              "Repr-Digest": "sha-256=:stale-repr-digest:",
            },
          }),
        ),
      };

      const result = await runner.run(
        execContext,
        async () => {
          throw new OperatorOnlyProblem();
        },
        {
          guards: [],
          interceptors: [],
          filters: [filter],
        },
      );

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(500);
      expect((result as Response).headers.get("Cache-Control")).toBe("no-store");
      expect((result as Response).headers.get("Content-Digest")).toBeNull();
      expect((result as Response).headers.get("Content-Encoding")).toBeNull();
      expect((result as Response).headers.get("Content-Length")).toBeNull();
      expect((result as Response).headers.get("Content-MD5")).toBeNull();
      expect((result as Response).headers.get("Digest")).toBeNull();
      expect((result as Response).headers.get("ETag")).toBeNull();
      expect((result as Response).headers.get("Repr-Digest")).toBeNull();

      const body = await (result as Response).json();
      expect(body).toEqual(
        expect.objectContaining({
          status: 500,
          code: "transports-http/di-bootstrap-validation",
          detail: "An internal error occurred",
          instance: "http://localhost/test",
        }),
      );
      expect(JSON.stringify(body)).not.toContain("secret-provider-token");
      expect(JSON.stringify(body)).not.toContain("rawProviderResponse");
    },
  );

  it("should describe deterministic middleware, guard, interceptor, pipe, handler, and filter order", () => {
    function firstMiddleware() {}
    function secondMiddleware() {}

    class AuthGuard {
      canActivate() {
        return true;
      }
    }

    class EnvelopeInterceptor {
      async intercept(_context: unknown, next: { handle(): Promise<unknown> }) {
        return next.handle();
      }
    }

    class AuditInterceptor {
      async intercept(_context: unknown, next: { handle(): Promise<unknown> }) {
        return next.handle();
      }
    }

    class NormalizePipe {
      transform(value: unknown) {
        return value;
      }
    }

    class HttpProblemFilter {
      catch(error: unknown) {
        return error;
      }
    }

    const graph = describeHttpPipelineGraph({
      target: "GET /orders/:id",
      handlerId: "handler:OrdersController.get",
      handlerLabel: "OrdersController.get",
      middlewares: [firstMiddleware, secondMiddleware],
      guards: [new AuthGuard()],
      interceptors: [new EnvelopeInterceptor(), new AuditInterceptor()],
      pipes: [new NormalizePipe()],
      filters: [new HttpProblemFilter()],
    });

    expect(graph.successOrder).toEqual([
      "middleware:0:before",
      "middleware:1:before",
      "guard:0",
      "interceptor:0:before",
      "interceptor:1:before",
      "pipe:0",
      "handler:OrdersController.get",
      "interceptor:1:after",
      "interceptor:0:after",
      "middleware:1:after",
      "middleware:0:after",
    ]);
    expect(graph.executionOrder).toEqual(graph.successOrder);
    expect(graph.errorOrder).toEqual([
      "middleware:0:before",
      "middleware:1:before",
      "guard:0",
      "interceptor:0:before",
      "interceptor:1:before",
      "pipe:0",
      "handler:OrdersController.get",
      "interceptor:1:after",
      "interceptor:0:after",
      "filter:0",
      "middleware:1:after",
      "middleware:0:after",
    ]);
    expect(graph.phaseOrder.error).toEqual(["filter:0"]);
    expect(graph.nodes.find((node) => node.id === "filter:0")?.failurePropagation).toBe(
      "handle-error",
    );
    expect(graph.debugDump).toContain("request-pipeline GET /orders/:id");
    expect(graph.debugDump).toContain("middleware middleware:0:before (short-circuit)");
  });
});
