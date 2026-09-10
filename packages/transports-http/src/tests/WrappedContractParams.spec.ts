import "reflect-metadata";
import { Container } from "@croco/framework-context";
import { Logger } from "@croco/framework-logger";
import {
  Controller,
  Get,
  HttpMethod,
  defineRouteContract,
  Param,
  Query,
  ParamType,
  REST_PARAMS_KEY,
  RequestValidationProblem,
} from "@croco/protocols-rest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp, ErrorHandler, HealthCheckRegistry } from "../index";
import { ParamResolver, resolveParamsWithRoutePipes } from "../libs/ParamResolver";
import type { CrocoHttpContext } from "../libs/types";

function context(
  query: Record<string, string | string[]>,
  params: Record<string, string> = {},
): CrocoHttpContext {
  return {
    req: { query, params },
    query: (name: string) => query[name],
    param: (name: string) => params[name],
  } as CrocoHttpContext;
}

function controller(schema: z.ZodType, names: string[], type = ParamType.QUERY) {
  class Controller {}
  Reflect.defineMetadata(
    REST_PARAMS_KEY,
    new Map([
      [
        "read",
        names.map((name, index) => ({
          type,
          name,
          index,
          contractSchema: schema,
        })),
      ],
    ]),
    Controller,
  );
  return Controller;
}

describe("wrapped contract parameter binding", () => {
  it("parses an async object transform once and injects its output properties", async () => {
    const transform = vi.fn(async ({ value }: { value: string }) => ({
      value: Number(value),
      added: true,
    }));
    const schema = z.object({ value: z.string(), removed: z.string() }).transform(transform);
    const contract = defineRouteContract({
      method: HttpMethod.GET,
      path: "/wrapped",
      query: schema,
      response: z.unknown(),
    });
    class Controller {
      read(@Query(contract, "value") _value: number, @Query(contract, "added") _added: boolean) {}
    }
    const result = await new ParamResolver().resolveParams(
      context({ value: "42", removed: "input" }),
      Controller,
      "read",
    );
    expect(result).toEqual([42, true]);
    expect(transform).toHaveBeenCalledTimes(1);
  });

  it("reports object refinement errors with their query field path", async () => {
    const schema = z
      .object({ value: z.string() })
      .refine(({ value }) => value === "ok", { path: ["value"], message: "must be ok" });
    await expect(
      new ParamResolver().resolveParams(
        context({ value: "bad" }),
        controller(schema, ["value"]),
        "read",
      ),
    ).rejects.toMatchObject({
      code: "protocols-rest/request-validation-failed",
      issues: [{ path: "query.value", message: "must be ok" }],
    });
  });

  it("executes pipeline input and output stages for path parameters", async () => {
    const schema = z
      .object({ value: z.string() })
      .transform(({ value }) => ({ value: Number(value) }))
      .pipe(z.object({ value: z.number().positive() }));
    const contract = defineRouteContract({
      method: HttpMethod.GET,
      path: "/wrapped/:value",
      params: schema,
      response: z.unknown(),
    });
    class Controller {
      read(@Param(contract, "value") _value: number) {}
    }
    const target = Controller;
    await expect(
      new ParamResolver().resolveParams(context({}, { value: "4" }), target, "read"),
    ).resolves.toEqual([4]);
    await expect(
      new ParamResolver().resolveParams(context({}, { value: "-1" }), target, "read"),
    ).rejects.toBeInstanceOf(RequestValidationProblem);
  });

  it("binds renamed path properties from the parsed output", async () => {
    const contract = defineRouteContract({
      method: HttpMethod.GET,
      path: "/renamed/:id",
      params: z.object({ id: z.string() }).transform(({ id }) => ({ renamed: Number(id) })),
    });
    class RenamedController {
      read(@Param(contract, "renamed") renamed: number) {
        return renamed;
      }
    }
    await expect(
      new ParamResolver().resolveParams(context({}, { id: "9" }), RenamedController, "read"),
    ).resolves.toEqual([9]);
  });

  it("normalizes query arrays and rejects repeated scalar values before transforms", async () => {
    const schema = z
      .object({ tags: z.array(z.string()), value: z.coerce.string() })
      .refine(() => true);
    const target = controller(schema, ["tags", "value"]);
    await expect(
      new ParamResolver().resolveParams(context({ tags: "one", value: "ok" }), target, "read"),
    ).resolves.toEqual([["one"], "ok"]);
    await expect(
      new ParamResolver().resolveParams(
        context({ tags: ["one", "two"], value: "ok" }),
        target,
        "read",
      ),
    ).resolves.toEqual([["one", "two"], "ok"]);
    await expect(
      new ParamResolver().resolveParams(
        context({ tags: "one", value: ["a", "b"] }),
        target,
        "read",
      ),
    ).rejects.toBeInstanceOf(RequestValidationProblem);
  });

  it("rejects invalid repeated arrays despite field catch without parsing effects twice", async () => {
    const fieldTransform = vi.fn((value: string) => value.toUpperCase());
    const objectTransform = vi.fn((value: { tags: string[] }) => value);
    const schema = z
      .object({ tags: z.array(z.string().min(2).transform(fieldTransform)).catch(["fallback"]) })
      .transform(objectTransform)
      .pipe(z.object({ tags: z.array(z.string()) }));
    const target = controller(schema, ["tags"]);
    await expect(
      new ParamResolver().resolveParams(context({ tags: ["ab", "cd"] }), target, "read"),
    ).resolves.toEqual([["AB", "CD"]]);
    expect(fieldTransform).toHaveBeenCalledTimes(2);
    expect(objectTransform).toHaveBeenCalledTimes(1);
    await expect(
      new ParamResolver().resolveParams(context({ tags: ["x"] }), target, "read"),
    ).rejects.toBeInstanceOf(RequestValidationProblem);
    expect(objectTransform).toHaveBeenCalledTimes(1);
  });

  it("fails explicitly when a contract transform produces a non-object", async () => {
    const schema = z.object({ value: z.string() }).transform(() => 5);
    await expect(
      new ParamResolver().resolveParams(
        context({ value: "input" }),
        controller(schema, ["value"]),
        "read",
      ),
    ).rejects.toMatchObject({ code: "transports-http/invalid-contract-output" });
  });

  it("isolates parsed values between concurrent requests and parameter sources", async () => {
    const schema = z
      .object({ value: z.string() })
      .transform(async ({ value }) => ({ value: Number(value) }));
    const target = controller(schema, ["value"]);
    const resolver = new ParamResolver();
    await expect(
      Promise.all([
        resolver.resolveParams(context({ value: "1" }), target, "read"),
        resolver.resolveParams(context({ value: "2" }), target, "read"),
      ]),
    ).resolves.toEqual([[1], [2]]);
    Reflect.defineMetadata(
      REST_PARAMS_KEY,
      new Map([
        [
          "read",
          [
            { type: ParamType.QUERY, index: 0, name: "value", contractSchema: schema },
            { type: ParamType.PARAM, index: 1, name: "value", contractSchema: schema },
          ],
        ],
      ]),
      target,
    );
    await expect(
      resolver.resolveParams(context({ value: "3" }, { value: "4" }), target, "read"),
    ).resolves.toEqual([3, 4]);
  });

  it("runs route pipes after the contract transform without scalar fallback parsing", async () => {
    const schema = z.object({ value: z.string() }).transform(() => ({ value: 5 }));
    const pipe = { transform: vi.fn((value: unknown) => Number(value) + 1) };
    await expect(
      resolveParamsWithRoutePipes(
        context({ value: "input" }),
        controller(schema, ["value"]),
        "read",
        [pipe],
        () => undefined,
      ),
    ).resolves.toEqual([6]);
    expect(pipe.transform).toHaveBeenCalledWith(5, { type: "query", name: "value" });
  });
});

describe("wrapped contract HTTP requests", () => {
  afterEach(() => Container.reset());

  it("boots a wrapped contract route and injects transformed values or returns validation failure", async () => {
    Container.reset();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: () => logger,
    } as unknown as Logger;
    Container.set(Logger, logger);
    Container.set(ErrorHandler, new ErrorHandler(logger));
    Container.set(HealthCheckRegistry, new HealthCheckRegistry());
    const contract = defineRouteContract({
      method: HttpMethod.GET,
      path: "/wrapped-http/:id",
      params: z.object({ id: z.string() }).transform(({ id }) => ({ id: Number(id) })),
      query: z
        .object({ count: z.string().regex(/^\d+$/) })
        .transform(async ({ count }) => ({ count: Number(count), doubled: Number(count) * 2 })),
      response: z.object({ id: z.number(), count: z.number(), doubled: z.number() }),
    });
    @Controller("")
    class WrappedController {
      @Get(contract)
      read(
        @Param(contract, "id") id: number,
        @Query(contract, "count") count: number,
        @Query(contract, "doubled") doubled: number,
      ) {
        return { id, count, doubled };
      }
    }
    const app = createApp({ controllers: [WrappedController], securityValidation: "off" });
    const accepted = await app.fetch(new Request("http://localhost/wrapped-http/7?count=3"));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ id: 7, count: 3, doubled: 6 });
    const rejected = await app.fetch(new Request("http://localhost/wrapped-http/7?count=bad"));
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      code: "protocols-rest/request-validation-failed",
      issues: [{ path: "query.count", message: "Invalid" }],
    });
  });
});
