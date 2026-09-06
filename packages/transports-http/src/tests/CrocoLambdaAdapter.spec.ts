import type { ILogger } from "@croco/framework-context";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrocoLambdaAdapter } from "../libs/CrocoLambdaAdapter";
import { getRuntimeContextInitFromEnv } from "../libs/runtimeContext";
import type { LambdaContext, LambdaEvent } from "../libs/types";

const DEADLINE_CODE = "transports-http/lambda-wait-until-deadline-exceeded";

function createLambdaContext(remainingTimeInMillis = 5_000): LambdaContext {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: "lambda-wait-until-test",
    functionVersion: "$LATEST",
    invokedFunctionArn:
      "arn:aws:lambda:ap-northeast-2:123456789012:function:lambda-wait-until-test",
    memoryLimitInMB: "128",
    awsRequestId: "aws-request-123",
    logGroupName: "/aws/lambda/lambda-wait-until-test",
    logStreamName: "2026/07/13/[$LATEST]abcdef",
    getRemainingTimeInMillis: () => remainingTimeInMillis,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

function createLambdaEvent(path = "/test"): LambdaEvent {
  return {
    version: "2.0",
    routeKey: `GET ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: {},
    requestContext: {
      accountId: "123456789012",
      apiId: "api-123",
      domainName: "example.execute-api.ap-northeast-2.amazonaws.com",
      domainPrefix: "example",
      http: {
        method: "GET",
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "api-request-123",
      routeKey: `GET ${path}`,
      stage: "$default",
      time: "13/Jul/2026:00:00:00 +0000",
      timeEpoch: 1_783_900_800_000,
    },
    isBase64Encoded: false,
  };
}

function readDeadlineError(error: unknown) {
  return error as Error & {
    code: string;
    reason: string;
    queuedCount: number;
    inFlightCount: number;
    outstandingTaskIndexes: readonly number[];
    remainingTimeInMillis: number | undefined;
  };
}

describe("CrocoLambdaAdapter base64 request bodies", () => {
  const variants = [
    { name: "standard", encode: (body: string) => body },
    { name: "LF wrapping", encode: (body: string) => body.replace(/.{4}/g, "$&\n") },
    { name: "CRLF wrapping", encode: (body: string) => body.replace(/.{4}/g, "$&\r\n") },
    { name: "spaces and tabs", encode: (body: string) => ` \t${body.split("").join(" \t")}\n` },
    { name: "URL-safe", encode: (body: string) => body.replace(/\+/g, "-").replace(/\//g, "_") },
    { name: "omitted padding", encode: (body: string) => body.replace(/=+$/, "") },
    {
      name: "URL-safe, whitespace, and omitted padding",
      encode: (body: string) =>
        ` \t${body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").split("").join("\r\n")} `,
    },
  ];

  describe.each(variants)("$name", ({ encode }) => {
    it.each([4, 5, 6])("preserves all bytes of a %i-byte binary request", async (length) => {
      const bytes = Uint8Array.from([0xfb, 0xff, 0x00, 0x80, 0xfe, 0x01]).slice(0, length);
      const received: Uint8Array[] = [];
      const app = new Hono();
      app.post("/test", async (context) => {
        received.push(new Uint8Array(await context.req.raw.arrayBuffer()));
        return context.text("ok");
      });
      const event = createLambdaEvent();
      event.requestContext.http.method = "POST";
      event.body = encode(Buffer.from(bytes).toString("base64"));
      event.isBase64Encoded = true;

      const response = await new CrocoLambdaAdapter(app).createHandler()(
        event,
        createLambdaContext(),
      );

      expect(response.statusCode).toBe(200);
      expect(received).toEqual([bytes]);
    });
  });

  it.each(["", " \t\r\n"])("accepts an empty encoded body %j", async (body) => {
    const app = new Hono();
    app.post("/test", async (context) =>
      context.text(String((await context.req.arrayBuffer()).byteLength)),
    );
    const event = createLambdaEvent();
    event.requestContext.http.method = "POST";
    event.body = body;
    event.isBase64Encoded = true;

    const response = await new CrocoLambdaAdapter(app).createHandler()(
      event,
      createLambdaContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("0");
  });

  it.each([
    "!!!!",
    "+/8!",
    "A",
    "AAAAA",
    "=",
    "====",
    "AA=",
    "AAA==",
    "AAAA=",
    "AA===",
    "AA==AA",
    "AA= A",
    "AA\u0000==",
  ])("rejects malformed base64 %j before dispatch", async (body) => {
    const dispatch = vi.fn(() => new Response("unexpected"));
    const event = createLambdaEvent();
    event.requestContext.http.method = "POST";
    event.body = body;
    event.isBase64Encoded = true;

    await expect(
      new CrocoLambdaAdapter({ fetch: dispatch }).createHandler()(event, createLambdaContext()),
    ).rejects.toMatchObject({
      name: "LambdaEventValidationError",
      code: "transports-http/lambda-event-invalid",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("CrocoLambdaAdapter waitUntil draining", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drains transitively registered work before resolving the response", async () => {
    const markers: string[] = [];
    const app = new Hono();
    app.get("/test", (context) => {
      const runtime = getRuntimeContextInitFromEnv(context.env);
      runtime?.waitUntil?.(
        Promise.resolve().then(() => {
          markers.push("first");
          runtime.waitUntil?.(
            Promise.resolve().then(() => {
              markers.push("second");
            }),
          );
        }),
      );
      return context.json({ ok: true });
    });

    const response = await new CrocoLambdaAdapter(app).createHandler()(
      createLambdaEvent(),
      createLambdaContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(markers).toEqual(["first", "second"]);
  });

  it("logs later-generation rejections once with global enqueue indexes", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => logger),
    } as unknown as ILogger & { error: ReturnType<typeof vi.fn> };
    const app = new Hono();
    app.get("/test", (context) => {
      const runtime = getRuntimeContextInitFromEnv(context.env);
      runtime?.waitUntil?.(
        Promise.resolve().then(() => {
          runtime.waitUntil?.(Promise.reject(new Error("second generation")));
        }),
      );
      return context.json({ ok: true });
    });

    const response = await new CrocoLambdaAdapter(app).createHandler({
      logger,
    })(createLambdaEvent(), createLambdaContext());

    expect(response.statusCode).toBe(200);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("Lambda waitUntil task rejected", {
      taskIndex: 1,
      reason: expect.objectContaining({ message: "second generation" }),
    });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    2_147_483_648,
    9_007_199_254_740_992,
  ])("fails closed for invalid remaining time %s", async (remainingTimeInMillis) => {
    const app = new Hono();
    app.get("/test", (context) => {
      getRuntimeContextInitFromEnv(context.env)?.waitUntil?.(new Promise(() => {}));
      return context.json({ ok: true });
    });

    let thrown: unknown;
    try {
      await new CrocoLambdaAdapter(app).createHandler()(
        createLambdaEvent(),
        createLambdaContext(remainingTimeInMillis),
      );
    } catch (error) {
      thrown = error;
    }

    expect(readDeadlineError(thrown)).toMatchObject({
      code: DEADLINE_CODE,
      reason: "invalid-remaining-time",
      queuedCount: 1,
      inFlightCount: 0,
      outstandingTaskIndexes: [0],
    });
  });

  it("reports an already-observed rejection while failing an invalid remaining time", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => logger),
    } as unknown as ILogger & { error: ReturnType<typeof vi.fn> };
    const app = new Hono();
    app.get("/test", async (context) => {
      getRuntimeContextInitFromEnv(context.env)?.waitUntil?.(
        Promise.reject(new Error("observed failure")),
      );
      await Promise.resolve();
      return context.json({ ok: true });
    });

    await expect(
      new CrocoLambdaAdapter(app).createHandler({ logger })(
        createLambdaEvent(),
        createLambdaContext(Number.NaN),
      ),
    ).rejects.toMatchObject({
      code: DEADLINE_CODE,
      reason: "invalid-remaining-time",
    });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("Lambda waitUntil task rejected", {
      taskIndex: 0,
      reason: expect.objectContaining({ message: "observed failure" }),
    });
  });

  it.each([0, -1, 1, 249, 250])(
    "fails deterministically for expired remaining time %s",
    async (remainingTimeInMillis) => {
      const app = new Hono();
      app.get("/test", (context) => {
        getRuntimeContextInitFromEnv(context.env)?.waitUntil?.(new Promise(() => {}));
        return context.json({ ok: true });
      });

      await expect(
        new CrocoLambdaAdapter(app).createHandler()(
          createLambdaEvent(),
          createLambdaContext(remainingTimeInMillis),
        ),
      ).rejects.toMatchObject({
        code: DEADLINE_CODE,
        reason: "deadline-exceeded",
        queuedCount: 1,
        inFlightCount: 0,
        outstandingTaskIndexes: [0],
        remainingTimeInMillis,
      });
    },
  );

  it("succeeds with an empty queue even when no time remains", async () => {
    const app = new Hono();
    app.get("/test", (context) => context.json({ ok: true }));

    const response = await new CrocoLambdaAdapter(app).createHandler()(
      createLambdaEvent(),
      createLambdaContext(0),
    );

    expect(response.statusCode).toBe(200);
  });

  it("accepts the maximum Node timer delay for settled work", async () => {
    const app = new Hono();
    app.get("/test", (context) => {
      getRuntimeContextInitFromEnv(context.env)?.waitUntil?.(Promise.resolve());
      return context.json({ ok: true });
    });

    const response = await new CrocoLambdaAdapter(app).createHandler()(
      createLambdaEvent(),
      createLambdaContext(2_147_483_647),
    );

    expect(response.statusCode).toBe(200);
  });

  it("fails closed when the absolute deadline is not a safe integer", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    const app = new Hono();
    app.get("/test", (context) => {
      getRuntimeContextInitFromEnv(context.env)?.waitUntil?.(Promise.resolve());
      return context.json({ ok: true });
    });

    await expect(
      new CrocoLambdaAdapter(app).createHandler()(createLambdaEvent(), createLambdaContext(251)),
    ).rejects.toMatchObject({
      code: DEADLINE_CODE,
      reason: "invalid-remaining-time",
    });
  });

  it("reserves 250 milliseconds for deadline diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const lambdaContext = createLambdaContext();
    lambdaContext.getRemainingTimeInMillis = () => 1_000 - Date.now();
    const app = new Hono();
    app.get("/test", (context) => {
      getRuntimeContextInitFromEnv(context.env)?.waitUntil?.(new Promise(() => {}));
      return context.json({ ok: true });
    });

    const handlerResult = new CrocoLambdaAdapter(app).createHandler()(
      createLambdaEvent(),
      lambdaContext,
    );
    const capturedError = handlerResult.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(750);

    expect(await capturedError).toMatchObject({
      code: DEADLINE_CODE,
      reason: "deadline-exceeded",
      remainingTimeInMillis: 250,
    });
  });

  it.each(["throws", "malformed"] as const)(
    "preserves the earned deadline error when the diagnostic resample %s",
    async (diagnosticFailure) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      let reads = 0;
      const lambdaContext = createLambdaContext();
      lambdaContext.getRemainingTimeInMillis = () => {
        reads += 1;
        if (reads === 1) {
          return 300;
        }
        if (diagnosticFailure === "throws") {
          throw new Error("diagnostic read failed");
        }
        return Number.NaN;
      };
      const app = new Hono();
      app.get("/test", (context) => {
        getRuntimeContextInitFromEnv(context.env)?.waitUntil?.(new Promise(() => {}));
        return context.json({ ok: true });
      });

      const handlerResult = new CrocoLambdaAdapter(app).createHandler()(
        createLambdaEvent(),
        lambdaContext,
      );
      const capturedError = handlerResult.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(50);

      expect(await capturedError).toMatchObject({
        code: DEADLINE_CODE,
        reason: "deadline-exceeded",
        remainingTimeInMillis: undefined,
      });
    },
  );

  it("bounds endlessly replenished settled work with one absolute deadline", async () => {
    let now = 100;
    let generatedTasks = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const app = new Hono();
    app.get("/test", (context) => {
      const runtime = getRuntimeContextInitFromEnv(context.env);
      const enqueueNext = () => {
        generatedTasks += 1;
        if (generatedTasks < 100) {
          runtime?.waitUntil?.(Promise.resolve().then(enqueueNext));
        }
      };
      enqueueNext();
      return context.json({ ok: true });
    });

    await expect(
      new CrocoLambdaAdapter(app).createHandler()(createLambdaEvent(), createLambdaContext(5)),
    ).rejects.toMatchObject({
      code: DEADLINE_CODE,
      reason: "deadline-exceeded",
    });
  });

  it("reports only unsettled in-flight and queued tasks when the deadline fires", async () => {
    vi.useFakeTimers();
    const app = new Hono();
    app.get("/test", (context) => {
      const runtime = getRuntimeContextInitFromEnv(context.env);
      const hangingTask = new Promise<void>(() => {
        setTimeout(() => {
          runtime?.waitUntil?.(Promise.resolve());
          runtime?.waitUntil?.(new Promise(() => {}));
        }, 0);
      });
      runtime?.waitUntil?.(hangingTask);
      return context.json({ ok: true });
    });
    const handlerResult = new CrocoLambdaAdapter(app).createHandler()(
      createLambdaEvent(),
      createLambdaContext(275),
    );
    const capturedError = handlerResult.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(25);

    expect(await capturedError).toMatchObject({
      code: DEADLINE_CODE,
      reason: "deadline-exceeded",
      queuedCount: 1,
      inFlightCount: 1,
      outstandingTaskIndexes: [0, 2],
    });
  });

  it("observes and reports a queued rejection behind a hanging task exactly once", async () => {
    vi.useFakeTimers();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => logger),
    } as unknown as ILogger & { error: ReturnType<typeof vi.fn> };
    const app = new Hono();
    app.get("/test", (context) => {
      const runtime = getRuntimeContextInitFromEnv(context.env);
      const hangingTask = new Promise<void>(() => {
        setTimeout(() => {
          runtime?.waitUntil?.(Promise.reject(new Error("queued rejection")));
        }, 0);
      });
      runtime?.waitUntil?.(hangingTask);
      return context.json({ ok: true });
    });
    const handlerResult = new CrocoLambdaAdapter(app).createHandler({ logger })(
      createLambdaEvent(),
      createLambdaContext(275),
    );
    const capturedError = handlerResult.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(25);

    expect(await capturedError).toMatchObject({
      code: DEADLINE_CODE,
      queuedCount: 0,
      inFlightCount: 1,
      outstandingTaskIndexes: [0],
    });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("Lambda waitUntil task rejected", {
      taskIndex: 1,
      reason: expect.objectContaining({ message: "queued rejection" }),
    });
  });

  it("coalesces a route flush with the handler boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let routeFlush: Promise<void> | undefined;
    const lambdaContext = createLambdaContext();
    const getRemainingTimeInMillis = vi.fn(() => 300 - Date.now());
    lambdaContext.getRemainingTimeInMillis = getRemainingTimeInMillis;
    const app = new Hono();
    app.get("/test", (context) => {
      const runtime = getRuntimeContextInitFromEnv(context.env);
      runtime?.waitUntil?.(new Promise(() => {}));
      routeFlush = Promise.resolve(runtime?.flush?.());
      return context.json({ ok: true });
    });

    const handlerResult = new CrocoLambdaAdapter(app).createHandler()(
      createLambdaEvent(),
      lambdaContext,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(routeFlush).toBeDefined();
    expect(getRemainingTimeInMillis).toHaveBeenCalledOnce();
    const routeErrorResult = routeFlush?.catch((error: unknown) => error);
    const handlerErrorResult = handlerResult.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(50);

    const routeError = await routeErrorResult;
    expect(routeError).toMatchObject({ code: DEADLINE_CODE });
    expect(await handlerErrorResult).toBe(routeError);
    expect(getRemainingTimeInMillis).toHaveBeenCalledTimes(2);
  });

  it("latches an unawaited pre-boundary failure and replays its exact error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const flush = vi.fn().mockResolvedValue(undefined);
    const lambdaContext = createLambdaContext();
    lambdaContext.getRemainingTimeInMillis = () => 300 - Date.now();
    let resumeRoute: (() => void) | undefined;
    const routePaused = new Promise<void>((resolve) => {
      resumeRoute = resolve;
    });
    let replayedError: unknown;
    const app = new Hono();
    app.get("/test", async (context) => {
      const runtime = getRuntimeContextInitFromEnv(context.env);
      runtime?.waitUntil?.(new Promise(() => {}));
      void runtime?.flush?.();
      await routePaused;
      try {
        await runtime?.flush?.();
      } catch (error) {
        replayedError = error;
      }
      return context.json({ ok: true });
    });

    try {
      const handlerResult = new CrocoLambdaAdapter(app).createHandler({ flush })(
        createLambdaEvent(),
        lambdaContext,
      );
      const handlerErrorResult = handlerResult.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(50);
      resumeRoute?.();
      await vi.advanceTimersByTimeAsync(0);

      const handlerError = await handlerErrorResult;
      expect(handlerError).toBe(replayedError);
      expect(readDeadlineError(handlerError).code).toBe(DEADLINE_CODE);
      expect(unhandledRejections).toEqual([]);
      expect(flush).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("releases successful flush ownership so later work is drained", async () => {
    const markers: string[] = [];
    const app = new Hono();
    app.get("/test", async (context) => {
      const runtime = getRuntimeContextInitFromEnv(context.env);
      runtime?.waitUntil?.(
        Promise.resolve().then(() => {
          markers.push("first");
        }),
      );
      await runtime?.flush?.();
      runtime?.waitUntil?.(
        Promise.resolve().then(() => {
          markers.push("second");
        }),
      );
      return context.json({ ok: true });
    });

    const response = await new CrocoLambdaAdapter(app).createHandler()(
      createLambdaEvent(),
      createLambdaContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(markers).toEqual(["first", "second"]);
  });

  it("preserves handler, runtime deadline, and external flush failures in order", async () => {
    const routeError = new Error("route failed");
    const externalFlushError = new Error("external flush failed");
    const flush = vi.fn().mockRejectedValue(externalFlushError);
    const app = new Hono();
    app.onError((error) => {
      throw error;
    });
    app.get("/test", (context) => {
      getRuntimeContextInitFromEnv(context.env)?.waitUntil?.(new Promise(() => {}));
      throw routeError;
    });

    let thrown: unknown;
    try {
      await new CrocoLambdaAdapter(app).createHandler({ flush })(
        createLambdaEvent(),
        createLambdaContext(0),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "LambdaFlushBoundaryError",
      originalError: routeError,
      flushErrors: [expect.objectContaining({ code: DEADLINE_CODE }), externalFlushError],
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it.each(["synchronously", "asynchronously"] as const)(
    "preserves a successful response when rejection reporting sinks fail %s",
    async (failureMode) => {
      const loggerError = new Error("logger failed");
      const consoleSinkError = new Error("console failed");
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
        if (failureMode === "synchronously") {
          throw consoleSinkError;
        }
        return Promise.reject(consoleSinkError);
      });
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(() => {
          if (failureMode === "synchronously") {
            throw loggerError;
          }
          return Promise.reject(loggerError);
        }),
        debug: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => logger),
      } as unknown as ILogger & { error: ReturnType<typeof vi.fn> };
      const flush = vi.fn().mockResolvedValue(undefined);
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);
      const app = new Hono();
      app.get("/test", (context) => {
        getRuntimeContextInitFromEnv(context.env)?.waitUntil?.(
          Promise.reject(new Error("task failed")),
        );
        return context.json({ ok: true });
      });

      try {
        const response = await new CrocoLambdaAdapter(app).createHandler({ logger, flush })(
          createLambdaEvent(),
          createLambdaContext(),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(response.statusCode).toBe(200);
        expect(logger.error).toHaveBeenCalledOnce();
        expect(consoleError).toHaveBeenCalledOnce();
        expect(consoleError).toHaveBeenCalledWith("Lambda waitUntil rejection reporting failed", {
          taskIndex: 0,
          reason: expect.objectContaining({ message: "task failed" }),
          reportingError: loggerError,
        });
        expect(flush).toHaveBeenCalledOnce();
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    },
  );

  it.each(["synchronously", "asynchronously"] as const)(
    "preserves a successful response when the console rejection sink fails %s",
    async (failureMode) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
        if (failureMode === "synchronously") {
          throw new Error("console failed");
        }
        return Promise.reject(new Error("console failed"));
      });
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);
      const app = new Hono();
      app.get("/test", (context) => {
        getRuntimeContextInitFromEnv(context.env)?.waitUntil?.(
          Promise.reject(new Error("task failed")),
        );
        return context.json({ ok: true });
      });

      try {
        const response = await new CrocoLambdaAdapter(app).createHandler()(
          createLambdaEvent(),
          createLambdaContext(),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(response.statusCode).toBe(200);
        expect(consoleError).toHaveBeenCalledOnce();
        expect(consoleError).toHaveBeenCalledWith(
          "Lambda waitUntil task rejected",
          expect.objectContaining({ message: "task failed" }),
        );
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    },
  );
});
