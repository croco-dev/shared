import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildContractGraph } from "../libs/ContractGraph";
import { createContractGraphSnapshot } from "../libs/ContractGraphSnapshot";
import { extractRouteIR } from "../libs/extractRouteIR";
import { getZodInputObjectSchema, getZodQueryInputSchema } from "../libs/SchemaDescriptor";
import {
  ParamType,
  REST_PARAMS_KEY,
  REST_ROUTES_KEY,
  type ParamMetadata,
  type RouteMetadata,
} from "../libs/sharedTypes";
import { Controller, Get } from "./helpers/test-decorators";

function createController(
  schema: z.ZodType,
  bindingSchema = schema,
  kind: "path" | "query" = "query",
) {
  @Controller("/users")
  class UsersController {
    @Get(kind === "path" ? "/:id" : "/")
    getUser(_value: unknown): void {}
  }
  const routes = Reflect.getMetadata(REST_ROUTES_KEY, UsersController) as RouteMetadata[];
  Reflect.defineMetadata(
    REST_ROUTES_KEY,
    routes.map((route) => ({
      ...route,
      contract: {
        method: "GET",
        response: z.string(),
        path: kind === "path" ? "/users/:id" : "/users",
        [kind === "path" ? "params" : "query"]: schema,
      },
    })),
    UsersController,
  );
  const params: ParamMetadata[] = [
    {
      type: kind === "path" ? ParamType.PARAM : ParamType.QUERY,
      index: 0,
      name: "renamed",
      contractSchema: bindingSchema,
    },
  ];
  Reflect.defineMetadata(REST_PARAMS_KEY, new Map([["getUser", params]]), UsersController);
  return UsersController;
}

describe("wrapped object contract bindings", () => {
  const input = z.object({ id: z.string(), filter: z.string().optional() });
  const schemas = [
    input.refine((value) => value.id.length > 0),
    input.transform((value) => ({ renamed: value.id })),
    input.pipe(z.object({ id: z.string() })).transform((value) => ({ renamed: value.id })),
  ];

  it.each(schemas)("retains the whole input schema and output binding in RouteIR", (schema) => {
    const [route] = extractRouteIR(createController(schema));
    expect(route?.inputSchemas?.query).toBe(schema);
    expect(route?.params[0]).toMatchObject({
      name: "renamed",
      schema: null,
      contractSchema: schema,
    });
  });

  it.each(schemas)(
    "accepts whole-schema query validation without separate input bindings",
    (schema) => {
      const graph = buildContractGraph([createController(schema)], { strictSchemas: true });
      expect(
        graph.diagnostics.filter(
          (diagnostic) =>
            diagnostic.severity === "error" && diagnostic.code !== "contract-schema-json-unsafe",
        ),
      ).toEqual([]);
      expect(createContractGraphSnapshot(graph).routes[0]?.params[0]).not.toHaveProperty(
        "contractSchema",
      );
    },
  );

  it.each(["path", "query"] as const)(
    "preserves whole %s binding schemas without a route-level contract",
    (kind) => {
      const schema = z.object({ id: z.string() }).transform((value) => ({ renamed: value.id }));
      const ControllerClass = createController(schema, schema, kind);
      const routes = Reflect.getMetadata(REST_ROUTES_KEY, ControllerClass) as RouteMetadata[];
      Reflect.defineMetadata(
        REST_ROUTES_KEY,
        routes.map(({ contract: _contract, ...route }) => route),
        ControllerClass,
      );
      const [route] = extractRouteIR(ControllerClass);
      expect(route?.inputSchemas?.[kind]).toBe(schema);
      const graph = buildContractGraph([ControllerClass]);
      expect(graph.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "contract-schema-json-unsafe",
          severity: "error",
        }),
      );
    },
  );

  it.each(["path", "query"] as const)(
    "rejects distinct whole %s binding schemas without a route-level contract",
    (kind) => {
      const schema = z.object({ id: z.string() }).refine(() => true);
      const ControllerClass = createController(schema, schema, kind);
      const routes = Reflect.getMetadata(REST_ROUTES_KEY, ControllerClass) as RouteMetadata[];
      Reflect.defineMetadata(
        REST_ROUTES_KEY,
        routes.map(({ contract: _contract, ...route }) => route),
        ControllerClass,
      );
      const paramsMap = Reflect.getMetadata(REST_PARAMS_KEY, ControllerClass) as Map<
        string,
        ParamMetadata[]
      >;
      paramsMap.get("getUser")?.push({
        type: kind === "path" ? ParamType.PARAM : ParamType.QUERY,
        index: 1,
        name: "other",
        contractSchema: z.object({ id: z.string() }).transform((value) => ({ other: value.id })),
      });
      const graph = buildContractGraph([ControllerClass]);
      expect(graph.diagnostics).toContainEqual(
        expect.objectContaining({
          code: `contract-route-${kind}-param-schema-mismatch`,
          severity: "error",
        }),
      );
      expect(graph.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "contract-schema-json-unsafe",
          severity: "error",
        }),
      );
    },
  );

  it.each(["path", "query"] as const)(
    "checks mixed legacy %s bindings against the whole schema",
    (kind) => {
      const input = z.object({ id: z.string() });
      const schema = input.refine(() => true);
      for (const [name, field, expectedCode] of [
        ["extra", z.number(), `contract-route-uncontracted-${kind}-param`],
        ["id", z.number(), `contract-route-${kind}-param-schema-mismatch`],
        ["id", input.shape.id, undefined],
      ] as const) {
        const ControllerClass = createController(schema, schema, kind);
        const routes = Reflect.getMetadata(REST_ROUTES_KEY, ControllerClass) as RouteMetadata[];
        Reflect.defineMetadata(
          REST_ROUTES_KEY,
          routes.map(({ contract: _contract, ...route }) => route),
          ControllerClass,
        );
        const paramsMap = Reflect.getMetadata(REST_PARAMS_KEY, ControllerClass) as Map<
          string,
          ParamMetadata[]
        >;
        paramsMap.get("getUser")?.push({
          type: kind === "path" ? ParamType.PARAM : ParamType.QUERY,
          index: 1,
          name,
          pipes: [{ schema: field }],
        });
        const graph = buildContractGraph([ControllerClass]);
        const errors = graph.diagnostics.filter(({ severity }) => severity === "error");
        if (expectedCode) {
          expect(errors).toContainEqual(expect.objectContaining({ code: expectedCode }));
        } else {
          expect(errors).toEqual([]);
        }
      }
    },
  );

  it("checks path completeness against the input shape when output names change", () => {
    const schema = z.object({ id: z.string() }).transform((value) => ({ renamed: value.id }));
    const graph = buildContractGraph([createController(schema, schema, "path")], {
      strictSchemas: true,
    });
    expect(
      graph.diagnostics.filter(
        (diagnostic) =>
          diagnostic.severity === "error" && diagnostic.code !== "contract-schema-json-unsafe",
      ),
    ).toEqual([]);
  });

  it("rejects bindings backed by a different object schema", () => {
    const schema = input.refine(() => true);
    const graph = buildContractGraph([
      createController(
        schema,
        input.refine(() => true),
      ),
    ]);
    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "contract-route-query-param-schema-mismatch",
      }),
    );
  });

  it("still rejects mismatched per-field schemas alongside whole-object bindings", () => {
    const schema = input.refine(() => true);
    const ControllerClass = createController(schema);
    const paramsMap = Reflect.getMetadata(REST_PARAMS_KEY, ControllerClass) as Map<
      string,
      ParamMetadata[]
    >;
    paramsMap.get("getUser")?.push({
      type: ParamType.QUERY,
      index: 1,
      name: "id",
      pipes: [{ schema: z.number() }],
    });
    const graph = buildContractGraph([ControllerClass]);
    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "contract-route-query-param-schema-mismatch",
      }),
    );
  });

  it("keeps missing-binding diagnostics for ordinary per-field contracts", () => {
    const ControllerClass = createController(input);
    Reflect.defineMetadata(REST_PARAMS_KEY, new Map(), ControllerClass);
    const graph = buildContractGraph([ControllerClass]);
    expect(
      graph.diagnostics.filter(
        (diagnostic) => diagnostic.code === "contract-route-missing-query-param-binding",
      ),
    ).toHaveLength(2);
  });

  it("unwraps nested effects and pipeline inputs without choosing the output schema", () => {
    const output = z.object({ renamed: z.string() });
    const schema = input.transform((value) => ({ renamed: value.id })).pipe(output);
    expect(getZodInputObjectSchema(schema)).toBe(input);
    expect(getZodInputObjectSchema(z.string())).toBeUndefined();
    expect(getZodInputObjectSchema(z.object({}))).toBeDefined();
  });
  it("preserves query schema identity when input fields need no projection", () => {
    const schema = z
      .object({ tags: z.array(z.string()), count: z.number().catch(0) })
      .refine(() => true)
      .pipe(z.object({ tags: z.array(z.string()), count: z.number() }));
    expect(getZodQueryInputSchema(schema, { tags: ["one"], count: "invalid" })).toBe(schema);
  });

  it("removes array catches through pipeline input while retaining one outer transform execution", () => {
    let executions = 0;
    const schema = z
      .object({ tags: z.array(z.number()).catch([]) })
      .transform((value) => {
        executions++;
        return { renamed: value.tags };
      })
      .pipe(z.object({ renamed: z.array(z.number()) }));
    const projected = getZodQueryInputSchema(schema, { tags: ["invalid"] });
    expect(projected.safeParse({ tags: ["invalid"] }).success).toBe(false);
    expect(executions).toBe(0);
    expect(projected.parse({ tags: [1, 2] })).toEqual({ renamed: [1, 2] });
    expect(executions).toBe(1);
    expect(schema.parse({ tags: ["invalid"] })).toEqual({ renamed: [] });
  });
});
