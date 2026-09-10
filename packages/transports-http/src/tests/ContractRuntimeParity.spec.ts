import "reflect-metadata";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Container } from "@croco/framework-context";
import { Logger } from "@croco/framework-logger";
import { Problem, ProblemCategory, type ProblemDetails } from "@croco/problems-core";
import {
  assertContractGraphHasNoErrors,
  buildContractGraph,
  type ContractGraph,
  type ContractGraphRoute,
} from "@croco/protocols-core";
import {
  Body,
  type CallHandler,
  Controller,
  defineRouteContract,
  defineRouteProblem,
  Get,
  Header,
  HttpMethod,
  type ExecutionContext,
  type Interceptor,
  Param,
  Post,
  ProblemResponses,
  Query,
  RequestValidationProblem,
  ResponseSchema,
  type RouteHandlerReturn,
  routeProblemResponses,
  UseInterceptors,
} from "@croco/protocols-rest";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { emitOpenAPIFromContractGraph } from "../../../openapi-spec/src/index";
import { generateClientFilesFromContractGraph } from "../../../rpc-codegen/src/index";
import { createApp, type CrocoApp, ErrorHandler, HealthCheckRegistry } from "../index";

const WidgetPathSchema = z.object({
  id: z.string().regex(/^widget_[a-z0-9 ]+$/),
});

const WidgetQuerySchema = z.object({
  mode: z.enum(["merge", "replace"]),
});

const WidgetHeadersSchema = z.object({
  "x-tenant-id": z.string().min(3),
});

const WidgetBodySchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});

const NestedWidgetBodySchema = z.object({
  metadata: z.object({
    color: z.enum(["blue", "green"]),
  }),
});

const NestedWidgetResponseSchema = z.object({
  color: z.enum(["blue", "green"]),
});

const OPTIONAL_REQUEST_BODY_SCHEMA = z.object({ value: z.string() }).optional();
const DEFAULT_REQUEST_BODY_SCHEMA = z.object({ value: z.string() }).default({ value: "default" });
const CATCH_REQUEST_BODY_SCHEMA = z.object({ value: z.string() }).catch({ value: "caught" });
const REQUIRED_REQUEST_BODY_SCHEMA = z.object({ value: z.string() });
const NULLABLE_REQUIRED_REQUEST_BODY_SCHEMA = REQUIRED_REQUEST_BODY_SCHEMA.nullable();

const WidgetResponseSchema = z.object({
  id: z.string(),
  mode: z.enum(["merge", "replace"]),
  tenantId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
});

class WidgetNotFoundProblem extends Problem {
  readonly code = "contract-parity/widget-not-found";
  readonly category = ProblemCategory.NotFound;

  constructor(id: string) {
    super(
      "contract-parity/widget-not-found",
      ProblemCategory.NotFound,
      `Widget '${id}' was not found`,
    );
  }
}

const requestValidationProblem = defineRouteProblem(RequestValidationProblem, {
  code: "protocols-rest/request-validation-failed",
  category: ProblemCategory.ValidationError,
});

const widgetNotFoundProblem = defineRouteProblem(WidgetNotFoundProblem, {
  code: "contract-parity/widget-not-found",
  category: ProblemCategory.NotFound,
});

const updateWidgetRoute = defineRouteContract({
  id: "contract-parity.update-widget",
  method: HttpMethod.POST,
  path: "/contract-parity/widgets/:id",
  operationId: "updateContractParityWidget",
  params: WidgetPathSchema,
  query: WidgetQuerySchema,
  body: WidgetBodySchema,
  response: WidgetResponseSchema,
  problems: [requestValidationProblem, widgetNotFoundProblem],
});

const transformedResponseRoute = defineRouteContract({
  id: "contract-parity.transformed-response",
  method: HttpMethod.GET,
  path: "/contract-parity/transformed-response",
  response: z.string().transform((value) => value.length),
});

type WidgetBody = z.infer<typeof WidgetBodySchema>;
type WidgetMode = z.infer<typeof WidgetQuerySchema>["mode"];
type WidgetResponse = z.infer<typeof WidgetResponseSchema>;
type NestedWidgetBody = z.infer<typeof NestedWidgetBodySchema>;
type NestedWidgetResponse = z.infer<typeof NestedWidgetResponseSchema>;
type GeneratedUpdateWidgetInput = {
  readonly path: { readonly id: string };
  readonly query: { readonly mode: WidgetMode };
  readonly headers: { readonly "x-tenant-id": string };
  readonly body: WidgetBody;
};
type ContractParityGeneratedModule = {
  readonly contractParityClient: {
    readonly updateWidget: (
      input: GeneratedUpdateWidgetInput,
      options?: unknown,
    ) => Promise<WidgetResponse>;
    readonly updateWidgetResult: (
      input: GeneratedUpdateWidgetInput,
      options?: unknown,
    ) => Promise<unknown>;
  };
};

const GENERATED_RPC_TEMP_ROOT = path.join(
  __dirname,
  "../../node_modules/.croco-contract-runtime-parity",
);

@Controller("/contract-parity")
class ContractParityController {
  @Post(updateWidgetRoute)
  @ProblemResponses(...routeProblemResponses(updateWidgetRoute))
  updateWidget(
    @Param(updateWidgetRoute, "id") id: string,
    @Query(updateWidgetRoute, "mode") mode: WidgetMode,
    @Header("x-tenant-id", WidgetHeadersSchema.shape["x-tenant-id"]) tenantId: string,
    @Body(updateWidgetRoute) body: WidgetBody,
  ): WidgetResponse {
    if (id === "widget_missing") {
      throw new WidgetNotFoundProblem(id);
    }

    return {
      id,
      mode,
      tenantId,
      name: body.name,
      enabled: body.enabled,
    };
  }
}

class ReplaceTransformedResponseInterceptor implements Interceptor<ExecutionContext> {
  async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
    await next.handle();
    return "intercepted";
  }
}

@Controller("/contract-parity")
class TransformedResponseController {
  @Get(transformedResponseRoute)
  @UseInterceptors(ReplaceTransformedResponseInterceptor)
  transformedResponse(): RouteHandlerReturn<typeof transformedResponseRoute> {
    return "wire-value";
  }
}

@Controller("/contract-parity")
class NestedBodyValidationController {
  @Post("/nested-body")
  @ResponseSchema(NestedWidgetResponseSchema)
  createNestedWidget(@Body(NestedWidgetBodySchema) body: NestedWidgetBody): NestedWidgetResponse {
    return { color: body.metadata.color };
  }
}

@Controller("/contract-parity/omitted-body")
class OmittedBodyController {
  @Post("/catch")
  caught(@Body(CATCH_REQUEST_BODY_SCHEMA) body: z.infer<typeof CATCH_REQUEST_BODY_SCHEMA>): {
    value: string;
  } {
    return body;
  }
}

@Controller("/contract-parity/omitted-body")
class OmittedBodyContractController {
  @Post("/optional")
  optional(
    @Body(OPTIONAL_REQUEST_BODY_SCHEMA) body: z.infer<typeof OPTIONAL_REQUEST_BODY_SCHEMA>,
  ): {
    value: string;
  } {
    return { value: body?.value ?? "omitted" };
  }

  @Post("/default")
  defaulted(@Body(DEFAULT_REQUEST_BODY_SCHEMA) body: z.infer<typeof DEFAULT_REQUEST_BODY_SCHEMA>): {
    value: string;
  } {
    return body;
  }

  @Post("/required")
  required(
    @Body(REQUIRED_REQUEST_BODY_SCHEMA) body: z.infer<typeof REQUIRED_REQUEST_BODY_SCHEMA>,
  ): {
    value: string;
  } {
    return body;
  }

  @Post("/nullable-required")
  nullableRequired(
    @Body(NULLABLE_REQUIRED_REQUEST_BODY_SCHEMA)
    body: z.infer<typeof NULLABLE_REQUIRED_REQUEST_BODY_SCHEMA>,
  ): { value: string | null } {
    return { value: body?.value ?? null };
  }
}

@Controller("/contract-parity/repeated")
class RepeatedParametersController {
  @Get("/")
  read(
    @Query(
      "tag",
      z
        .array(z.string())
        .refine((tags) => tags.every((tag) => tag.length > 0))
        .optional(),
    )
    tags: string[] | undefined,
    @Header("x-scope", z.array(z.string()).optional()) scopes: string[] | undefined,
    @Query("mode", z.string().optional()) mode: string | undefined,
  ): { tags: string[] | null; scopes: string[] | null; mode: string | null } {
    return {
      tags: tags ?? null,
      scopes: scopes ?? null,
      mode: mode ?? null,
    };
  }

  @Get("/fallback")
  readFallback(@Query("mode", z.string().catch("fallback")) mode: string): { mode: string } {
    return { mode };
  }

  @Get("/variants")
  readVariants(
    @Query("plain", z.union([z.string(), z.array(z.string())])) plain: string | string[],
    @Query("catch-first", z.union([z.string().catch("fallback"), z.array(z.string())]))
    catchFirst: string | string[],
    @Query("catch-last", z.union([z.array(z.string()), z.string().catch("fallback")]))
    catchLast: string | string[],
    @Query("any", z.any()) anyValue: unknown,
    @Query("unknown", z.unknown()) unknownValue: unknown,
  ): Record<string, unknown> {
    return { plain, catchFirst, catchLast, anyValue, unknownValue };
  }

  @Get("/validated")
  readValidated(
    @Query("tag", z.array(z.string().min(2)).catch([])) tags: string[],
    @Query(
      "scope",
      z
        .array(z.string())
        .refine((values) => values.length >= 3, "Expected at least three values")
        .catch([]),
    )
    scopes: string[],
  ): { tags: string[]; scopes: string[] } {
    return { tags, scopes };
  }

  @Get("/header-validated")
  readValidatedHeaders(
    @Header("x-tag", z.array(z.string().min(2)).catch([])) tags: string[],
    @Header(
      "x-scope",
      z
        .array(z.string())
        .refine((values) => values.length >= 3, "Expected at least three scopes")
        .catch([]),
    )
    scopes: string[],
  ): { tags: string[]; scopes: string[] } {
    return { tags, scopes };
  }
}

@Controller("/contract-parity/schema-less")
class SchemaLessParametersController {
  @Get("/")
  read(
    @Query("tag") tag: string | undefined,
    @Header("x-request-id") requestId: string | undefined,
  ): { tag: string | null; requestId: string | null } {
    return { tag: tag ?? null, requestId: requestId ?? null };
  }
}

type ValidationProblemDetails = ProblemDetails & {
  readonly issues?: readonly {
    readonly path: string;
    readonly message: string;
  }[];
};

describe("REST contract-to-runtime parity", () => {
  let app: CrocoApp;
  let graph: ContractGraph;
  let route: ContractGraphRoute;
  let rpcOutDir: string;
  let rpcModuleDir: string;

  beforeEach(() => {
    Container.reset();
    fs.mkdirSync(GENERATED_RPC_TEMP_ROOT, { recursive: true });
    rpcOutDir = fs.mkdtempSync(path.join(GENERATED_RPC_TEMP_ROOT, "rpc-out-"));
    rpcModuleDir = fs.mkdtempSync(path.join(GENERATED_RPC_TEMP_ROOT, "rpc-modules-"));

    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      fatal: vi.fn(),
      child: () => logger,
    } as unknown as Logger;
    Container.set(Logger, logger);
    Container.set(ErrorHandler, new ErrorHandler(logger));
    Container.set(HealthCheckRegistry, new HealthCheckRegistry());

    graph = buildContractGraph([ContractParityController], {
      strictProblemResponses: true,
      strictSchemas: true,
    });
    assertContractGraphHasNoErrors(graph);

    const graphRoute = graph.routes.find(
      (candidate) => candidate.routeId === "ContractParityController.updateWidget",
    );
    if (!graphRoute) {
      throw new Error("ContractParityController.updateWidget was not present in ContractGraph.");
    }

    route = graphRoute;
    app = createApp({
      controllers: [
        ContractParityController,
        RepeatedParametersController,
        SchemaLessParametersController,
        TransformedResponseController,
      ],
      securityValidation: "off",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(GENERATED_RPC_TEMP_ROOT, { recursive: true, force: true });
  });

  it.each(["/users", "/api/v1/users"] as const)(
    "mounts contract %s under its controller in the graph and HTTP runtime",
    async (path) => {
      const contract = defineRouteContract({
        method: HttpMethod.GET,
        path,
        response: z.string(),
      });

      @Controller("/api/v1")
      class UsersController {
        @Get(contract)
        listUsers(): string {
          return "users";
        }
      }

      const graph = buildContractGraph([UsersController]);
      assertContractGraphHasNoErrors(graph);
      expect(graph.routes[0]?.path).toBe("/api/v1/users");
      expect(graph.routes[0]?.routeContract?.path).toBe(path);

      const app = createApp({ controllers: [UsersController], securityValidation: "off" });
      const response = await app.fetch(new Request("http://localhost/api/v1/users"));
      expect(response.status).toBe(200);
      expect(await response.json()).toBe("users");
      expect((await app.fetch(new Request("http://localhost/users"))).status).toBe(404);
      expect((await app.fetch(new Request("http://localhost/api/v1/api/v1/users"))).status).toBe(
        404,
      );
    },
  );

  it("keeps accepted contract metadata aligned with the fixture route", () => {
    expect(route).toMatchObject({
      routeId: "ContractParityController.updateWidget",
      operationId: "updateContractParityWidget",
      httpMethod: "POST",
      path: "/contract-parity/widgets/:id",
      routeContract: {
        id: "contract-parity.update-widget",
        method: "POST",
        path: "/contract-parity/widgets/:id",
      },
    });
    expect(route.inputSchemas.path).toBe(WidgetPathSchema);
    expect(route.inputSchemas.query).toBe(WidgetQuerySchema);
    expectRouteSchemaParse(route, "headers", route.inputSchemas.headers, {
      "x-tenant-id": "tenant-a",
    });
    expect(route.inputSchemas.body).toBe(WidgetBodySchema);
    expect(route.outputSchema).toBe(WidgetResponseSchema);
    expect(route.problemResponses?.map((response) => response.code).sort()).toEqual([
      "contract-parity/widget-not-found",
      "protocols-rest/request-validation-failed",
    ]);
    expect(route.routeContract?.problemResponses.map((response) => response.code).sort()).toEqual([
      "contract-parity/widget-not-found",
      "protocols-rest/request-validation-failed",
    ]);
  });

  it("matches success responses to the route response contract at runtime", async () => {
    const response = await app.fetch(
      createUpdateRequest({
        id: "widget_123",
        mode: "replace",
        tenantId: "tenant-a",
        body: { name: "Contract widget", enabled: true },
      }),
    );

    const body = await expectJsonResponse(response, route, 200);
    expectRouteSchemaParse(route, "response", route.outputSchema, body);
    expect(body).toEqual({
      id: "widget_123",
      mode: "replace",
      tenantId: "tenant-a",
      name: "Contract widget",
      enabled: true,
    });
  });

  it("parses handler returns into transformed wire responses", async () => {
    const response = await app.fetch(
      new Request("http://localhost/contract-parity/transformed-response"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toBe(11);
  });

  it("accepts missing, single, and repeated optional list parameters", async () => {
    const missing = await app.fetch(new Request("http://localhost/contract-parity/repeated"));
    expect(await missing.json()).toEqual({
      tags: null,
      scopes: null,
      mode: null,
    });

    const single = await app.fetch(
      new Request("http://localhost/contract-parity/repeated?tag=first", {
        headers: { "x-scope": "read" },
      }),
    );
    expect(await single.json()).toEqual({
      tags: ["first"],
      scopes: ["read"],
      mode: null,
    });

    const headers = new Headers([
      ["x-scope", "read"],
      ["x-scope", "write"],
    ]);
    const repeated = await app.fetch(
      new Request("http://localhost/contract-parity/repeated?tag=first&tag=second", { headers }),
    );
    expect(await repeated.json()).toEqual({
      tags: ["first", "second"],
      scopes: ["read", "write"],
      mode: null,
    });
  });

  it("rejects repeated query values for scalar schemas", async () => {
    const response = await app.fetch(
      new Request("http://localhost/contract-parity/repeated?mode=first&mode=second"),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "protocols-rest/request-validation-failed",
      status: 422,
    });
  });

  it("keeps schema-less named parameter runtime and generated fallbacks scalar", async () => {
    const missing = await app.fetch(new Request("http://localhost/contract-parity/schema-less"));
    expect(await missing.json()).toEqual({ tag: null, requestId: null });

    const single = await app.fetch(
      new Request("http://localhost/contract-parity/schema-less?tag=first", {
        headers: { "x-request-id": "request-1" },
      }),
    );
    expect(await single.json()).toEqual({ tag: "first", requestId: "request-1" });

    const repeated = await app.fetch(
      new Request("http://localhost/contract-parity/schema-less?tag=first&tag=second"),
    );
    expect(repeated.status).toBe(422);
    expect(await repeated.json()).toMatchObject({
      code: "protocols-rest/request-validation-failed",
      issues: [expect.objectContaining({ path: "query.value" })],
    });

    const fallbackGraph = buildContractGraph([SchemaLessParametersController]);
    const fallbackRoute = fallbackGraph.routes[0];
    expect(fallbackRoute?.params).toEqual([
      expect.objectContaining({ kind: "query", name: "tag", schema: null }),
      expect.objectContaining({ kind: "header", name: "x-request-id", schema: null }),
    ]);

    const fallbackSpec = emitOpenAPIFromContractGraph(fallbackGraph);
    expect(fallbackSpec.paths?.["/contract-parity/schema-less"]?.get?.parameters).toEqual([
      { in: "query", name: "tag", required: false, schema: { type: "string" } },
      {
        in: "header",
        name: "x-request-id",
        required: false,
        schema: { type: "string" },
      },
    ]);

    const generatedSource = generateClientFilesFromContractGraph(fallbackGraph, rpcOutDir)
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    expect(generatedSource).toContain(
      "query: { tag?: string | undefined; }; headers: { 'x-request-id'?: string | undefined; };",
    );
  });

  it("rejects repeated query values before a scalar catch schema can mask them", async () => {
    const single = await app.fetch(
      new Request("http://localhost/contract-parity/repeated/fallback?mode=first"),
    );
    expect(await single.json()).toEqual({ mode: "first" });

    const repeated = await app.fetch(
      new Request("http://localhost/contract-parity/repeated/fallback?mode=first&mode=second"),
    );

    expect(repeated.status).toBe(422);
    expect(await repeated.json()).toMatchObject({
      code: "protocols-rest/request-validation-failed",
      status: 422,
      issues: [{ path: "query.value", message: "Expected a single query value" }],
    });
  });

  it("preserves repeated query arrays for plain, catch-union, any, and unknown schemas", async () => {
    const response = await app.fetch(
      new Request(
        "http://localhost/contract-parity/repeated/variants?plain=one&plain=two&catch-first=one&catch-first=two&catch-last=one&catch-last=two&any=one&any=two&unknown=one&unknown=two",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plain: ["one", "two"],
      catchFirst: ["one", "two"],
      catchLast: ["one", "two"],
      anyValue: ["one", "two"],
      unknownValue: ["one", "two"],
    });
  });

  it("keeps single query values scalar for mixed union schemas", async () => {
    const response = await app.fetch(
      new Request(
        "http://localhost/contract-parity/repeated/variants?plain=one&catch-first=one&catch-last=one&any=one&unknown=one",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plain: "one",
      catchFirst: "one",
      catchLast: "one",
      anyValue: "one",
      unknownValue: "one",
    });
  });

  it("surfaces catch-free array element and refinement failures", async () => {
    const invalidElement = await app.fetch(
      new Request(
        "http://localhost/contract-parity/repeated/validated?tag=a&tag=valid&scope=one&scope=two&scope=three",
      ),
    );
    expect(invalidElement.status).toBe(422);
    expect(await invalidElement.json()).toMatchObject({
      issues: [expect.objectContaining({ path: "query.0" })],
    });

    const invalidRefinement = await app.fetch(
      new Request(
        "http://localhost/contract-parity/repeated/validated?tag=valid&tag=also-valid&scope=one&scope=two",
      ),
    );
    expect(invalidRefinement.status).toBe(422);
    expect(await invalidRefinement.json()).toMatchObject({
      issues: [{ path: "query.value", message: "Expected at least three values" }],
    });
  });

  it("validates present catch-array headers while preserving missing-header fallbacks", async () => {
    const missing = await app.fetch(
      new Request("http://localhost/contract-parity/repeated/header-validated"),
    );
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ tags: [], scopes: [] });

    const valid = await app.fetch(
      new Request("http://localhost/contract-parity/repeated/header-validated", {
        headers: { "x-tag": "first, second", "x-scope": "read, write, admin" },
      }),
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({
      tags: ["first", "second"],
      scopes: ["read", "write", "admin"],
    });

    const invalidElement = await app.fetch(
      new Request("http://localhost/contract-parity/repeated/header-validated", {
        headers: { "x-tag": "a, valid", "x-scope": "read, write, admin" },
      }),
    );
    expect(invalidElement.status).toBe(422);
    expect(await invalidElement.json()).toMatchObject({
      issues: [expect.objectContaining({ path: "headers.0" })],
    });

    const invalidRefinement = await app.fetch(
      new Request("http://localhost/contract-parity/repeated/header-validated", {
        headers: { "x-tag": "valid, also-valid", "x-scope": "read, write" },
      }),
    );
    expect(invalidRefinement.status).toBe(422);
    expect(await invalidRefinement.json()).toMatchObject({
      issues: [{ path: "headers.value", message: "Expected at least three scopes" }],
    });
  });

  it.each([
    {
      name: "path parameter",
      request: createUpdateRequest({
        id: "invalid",
        mode: "replace",
        tenantId: "tenant-a",
        body: { name: "Contract widget", enabled: true },
      }),
      schemaLocation: "path" as const,
      schemaInput: { id: "invalid" },
      issuePath: "params.value",
    },
    {
      name: "query parameter",
      request: createUpdateRequest({
        id: "widget_123",
        mode: "delete",
        tenantId: "tenant-a",
        body: { name: "Contract widget", enabled: true },
      }),
      schemaLocation: "query" as const,
      schemaInput: { mode: "delete" },
      issuePath: "query.value",
    },
    {
      name: "header parameter",
      request: createUpdateRequest({
        id: "widget_123",
        mode: "replace",
        tenantId: "x",
        body: { name: "Contract widget", enabled: true },
      }),
      schemaLocation: "headers" as const,
      schemaInput: { "x-tenant-id": "x" },
      issuePath: "headers.value",
    },
    {
      name: "body payload",
      request: createUpdateRequest({
        id: "widget_123",
        mode: "replace",
        tenantId: "tenant-a",
        body: { name: "", enabled: true },
      }),
      schemaLocation: "body" as const,
      schemaInput: { name: "", enabled: true },
      issuePath: "body.name",
    },
  ])(
    "matches $name validation failures to declared request metadata",
    async ({ request, schemaLocation, schemaInput, issuePath }) => {
      expectRouteSchemaFailure(
        route,
        schemaLocation,
        route.inputSchemas[schemaLocation],
        schemaInput,
      );

      const response = await app.fetch(request);
      const problem = await expectProblemResponse(response, route, {
        status: 422,
        code: "protocols-rest/request-validation-failed",
      });

      expectProblemIssuePath(route, problem, issuePath);
    },
  );

  it("locks nested body validation failures with the same Problem response shape", async () => {
    const nestedApp = createApp({
      controllers: [NestedBodyValidationController],
      securityValidation: "off",
    });
    const response = await nestedApp.fetch(
      new Request("http://localhost/contract-parity/nested-body", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ metadata: { color: "red" } }),
      }),
    );

    expect(response.status).toBe(422);
    const problem = (await response.json()) as ValidationProblemDetails;

    expect(problem).toMatchObject({
      type: "about:blank",
      title: "Validation Error",
      status: 422,
      code: "protocols-rest/request-validation-failed",
      instance: "http://localhost/contract-parity/nested-body",
      detail: expect.stringContaining("body.metadata.color"),
      issues: expect.any(Array),
    });
    expect(problem.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "body.metadata.color",
          message: expect.any(String),
        }),
      ]),
    );
  });

  it("keeps omitted request-body runtime behavior aligned with OpenAPI requiredness", async () => {
    const omittedBodyApp = createApp({
      controllers: [OmittedBodyController, OmittedBodyContractController],
      securityValidation: "off",
    });
    const omittedBodyGraph = buildContractGraph([OmittedBodyContractController]);
    assertContractGraphHasNoErrors(omittedBodyGraph);
    const spec = emitOpenAPIFromContractGraph(omittedBodyGraph);

    const cases = [
      { path: "optional", required: false, expectedBody: { value: "omitted" } },
      { path: "default", required: false, expectedBody: { value: "default" } },
      { path: "catch", expectedBody: { value: "caught" } },
      { path: "required", required: true, expectedStatus: 422 },
      { path: "nullable-required", required: true, expectedStatus: 422 },
    ] as const;

    for (const testCase of cases) {
      if ("required" in testCase) {
        const operation = spec.paths?.[`/contract-parity/omitted-body/${testCase.path}`]?.post;
        expect(operation?.requestBody).toMatchObject({ required: testCase.required });
      }

      const response = await omittedBodyApp.fetch(
        new Request(`http://localhost/contract-parity/omitted-body/${testCase.path}`, {
          method: "POST",
        }),
      );

      if ("expectedBody" in testCase) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(testCase.expectedBody);
      } else {
        expect(response.status).toBe(testCase.expectedStatus);
        expect(await response.json()).toMatchObject({
          code: "protocols-rest/request-validation-failed",
          status: 422,
          issues: [expect.objectContaining({ path: "body.value" })],
        });
      }
    }

    const malformedResponse = await omittedBodyApp.fetch(
      new Request("http://localhost/contract-parity/omitted-body/optional", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );
    expect(malformedResponse.status).toBe(422);
    expect(await malformedResponse.json()).toMatchObject({
      code: "protocols-rest/request-validation-failed",
      issues: [
        {
          path: "body.value",
          message: "Request body must contain valid JSON",
        },
      ],
    });
  });

  it("keeps generated OpenAPI and RPC artifacts aligned with the validation matrix", async () => {
    const spec = emitOpenAPIFromContractGraph(graph);
    const operation = spec.paths?.["/contract-parity/widgets/{id}"]?.post;

    expect(operation).toBeDefined();
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          in: "path",
          name: "id",
          required: true,
          schema: expect.objectContaining({
            type: "string",
            pattern: "^widget_[a-z0-9 ]+$",
          }),
        }),
        expect.objectContaining({
          in: "query",
          name: "mode",
          required: true,
          schema: expect.objectContaining({ enum: ["merge", "replace"], type: "string" }),
        }),
        expect.objectContaining({
          in: "header",
          name: "x-tenant-id",
          required: true,
          schema: expect.objectContaining({ minLength: 3, type: "string" }),
        }),
      ]),
    );
    expect(operation?.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1 },
              enabled: { type: "boolean" },
            },
            required: ["name", "enabled"],
          },
        },
      },
    });
    expect(operation?.responses?.[422]).toMatchObject({
      "x-croco-problems": [
        expect.objectContaining({
          code: "protocols-rest/request-validation-failed",
          category: "ValidationError",
          status: 422,
        }),
      ],
    });

    const module = await importGeneratedContractParityClient(
      generateClientFilesFromContractGraph(graph, rpcOutDir),
      rpcOutDir,
      rpcModuleDir,
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const requestUrl = rawUrl.startsWith("http://")
        ? rawUrl
        : `http://localhost${rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`}`;

      return app.fetch(new Request(requestUrl, init));
    });
    vi.stubGlobal("fetch", fetchMock);

    const input: GeneratedUpdateWidgetInput = {
      path: { id: "widget_hello world" },
      query: { mode: "replace" },
      headers: { "x-tenant-id": "tenant-a" },
      body: { name: "Generated widget", enabled: true },
    };
    const response = await module.contractParityClient.updateWidget(input);

    expect(response).toEqual({
      id: "widget_hello world",
      mode: "replace",
      tenantId: "tenant-a",
      name: "Generated widget",
      enabled: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/contract-parity/widgets/widget_hello%20world?mode=replace",
      {
        method: "POST",
        headers: {
          "x-tenant-id": "tenant-a",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input.body),
      },
    );

    const rpcProblem = await module.contractParityClient.updateWidgetResult({
      ...input,
      body: { name: "", enabled: true },
    });
    expect(rpcProblem).toMatchObject({
      ok: false,
      kind: "problem",
      code: "protocols-rest/request-validation-failed",
      category: "ValidationError",
      status: 422,
      problem: expect.objectContaining({
        code: "protocols-rest/request-validation-failed",
        status: 422,
      }),
    });

    const artifactGraph = buildContractGraph(
      [ContractParityController, NestedBodyValidationController],
      {
        strictProblemResponses: true,
        strictSchemas: true,
      },
    );
    assertContractGraphHasNoErrors(artifactGraph);

    const nestedOperation =
      emitOpenAPIFromContractGraph(artifactGraph).paths?.["/contract-parity/nested-body"]?.post;
    expect(nestedOperation?.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              metadata: {
                type: "object",
                properties: {
                  color: { enum: ["blue", "green"], type: "string" },
                },
                required: ["color"],
              },
            },
            required: ["metadata"],
          },
        },
      },
    });

    const nestedRpcOutDir = fs.mkdtempSync(path.join(GENERATED_RPC_TEMP_ROOT, "nested-rpc-out-"));
    expect(() => generateClientFilesFromContractGraph(artifactGraph, nestedRpcOutDir)).toThrow(
      expect.objectContaining({
        code: "rpc-codegen/unsupported-form-schema",
        detail: expect.stringContaining(
          "field 'metadata' uses unsupported form field schema ZodObject.",
        ),
      }),
    );
  });

  it("matches declared domain Problem responses at runtime", async () => {
    const response = await app.fetch(
      createUpdateRequest({
        id: "widget_missing",
        mode: "replace",
        tenantId: "tenant-a",
        body: { name: "Contract widget", enabled: true },
      }),
    );

    await expectProblemResponse(response, route, {
      status: 404,
      code: "contract-parity/widget-not-found",
    });
  });
});

function createUpdateRequest(options: {
  readonly id: string;
  readonly mode: string;
  readonly tenantId: string;
  readonly body: unknown;
}): Request {
  return new Request(
    `http://localhost/contract-parity/widgets/${options.id}?mode=${options.mode}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": options.tenantId,
      },
      body: JSON.stringify(options.body),
    },
  );
}

async function expectJsonResponse(
  response: Response,
  route: ContractGraphRoute,
  expectedStatus: number,
): Promise<unknown> {
  if (response.status !== expectedStatus) {
    throw new Error(
      `[${route.routeId}] expected HTTP ${expectedStatus}, received ${response.status}: ${await response.text()}`,
    );
  }

  return response.json();
}

async function expectProblemResponse(
  response: Response,
  route: ContractGraphRoute,
  expected: {
    readonly status: number;
    readonly code: string;
  },
): Promise<ValidationProblemDetails> {
  const problem = (await expectJsonResponse(
    response,
    route,
    expected.status,
  )) as ValidationProblemDetails;
  const declared = route.problemResponses?.find((candidate) => candidate.code === expected.code);

  if (!declared) {
    throw new Error(
      `[${route.routeId}] runtime Problem '${expected.code}' is not declared in route metadata.`,
    );
  }

  if (declared.status !== expected.status) {
    throw new Error(
      `[${route.routeId}] declared Problem '${expected.code}' status ${declared.status} does not match expected runtime status ${expected.status}.`,
    );
  }

  if (problem.code !== expected.code) {
    throw new Error(
      `[${route.routeId}] expected runtime Problem code '${expected.code}', received '${problem.code}'.`,
    );
  }

  if (problem.status !== expected.status) {
    throw new Error(
      `[${route.routeId}] expected runtime Problem status ${expected.status}, received ${problem.status}.`,
    );
  }

  expect(problem).toMatchObject({
    type: "about:blank",
    status: expected.status,
    code: expected.code,
    instance: expect.stringMatching(/^http:\/\/localhost\/contract-parity\/widgets\//),
  });

  if (expected.code === "protocols-rest/request-validation-failed") {
    expect(problem).toMatchObject({
      title: "Validation Error",
      detail: expect.any(String),
      issues: expect.any(Array),
    });
  }

  return problem;
}

function expectRouteSchemaParse(
  route: ContractGraphRoute,
  location: string,
  schema: z.ZodType | null,
  value: unknown,
): void {
  if (!schema) {
    throw new Error(`[${route.routeId}] missing ${location} schema metadata.`);
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `[${route.routeId}] runtime ${location} value did not match contract metadata: ${result.error.message}`,
    );
  }
}

function expectRouteSchemaFailure(
  route: ContractGraphRoute,
  location: string,
  schema: z.ZodType | null,
  value: unknown,
): void {
  if (!schema) {
    throw new Error(`[${route.routeId}] missing ${location} schema metadata.`);
  }

  const result = schema.safeParse(value);
  if (result.success) {
    throw new Error(
      `[${route.routeId}] test fixture for ${location} did not violate the accepted contract metadata.`,
    );
  }
}

function readValidationIssuePaths(problem: ValidationProblemDetails): string[] {
  return Array.isArray(problem.issues) ? problem.issues.map((issue) => issue.path) : [];
}

function expectProblemIssuePath(
  route: ContractGraphRoute,
  problem: ValidationProblemDetails,
  expectedPath: string,
): void {
  const issuePaths = readValidationIssuePaths(problem);
  if (!issuePaths.includes(expectedPath)) {
    throw new Error(
      `[${route.routeId}] expected runtime validation issue '${expectedPath}', received [${issuePaths.join(", ")}].`,
    );
  }

  expect(problem.detail).toEqual(expect.stringContaining(expectedPath));
  expect(problem.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: expectedPath,
        message: expect.any(String),
      }),
    ]),
  );
}

async function importGeneratedContractParityClient(
  files: readonly string[],
  rpcOutDir: string,
  rpcModuleDir: string,
): Promise<ContractParityGeneratedModule> {
  const domainFile = files.find((file) => path.basename(file) === "contractParity.ts");

  if (!domainFile) {
    throw new Error(`Expected generated contractParity.ts, got: ${files.join(", ")}`);
  }

  const rpcSource = fs.readFileSync(path.join(rpcOutDir, "rpc.ts"), "utf-8");
  const domainSource = fs.readFileSync(domainFile, "utf-8");
  const rpcOutput = ts.transpileModule(rpcSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const domainOutput = ts.transpileModule(
    domainSource.replace("from './rpc';", "from './rpc.mjs';"),
    {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    },
  );

  expect(rpcOutput.diagnostics).toEqual([]);
  expect(domainOutput.diagnostics).toEqual([]);

  const modulePath = path.join(rpcModuleDir, "contractParity.mjs");

  fs.writeFileSync(path.join(rpcModuleDir, "rpc.mjs"), rpcOutput.outputText);
  fs.writeFileSync(modulePath, domainOutput.outputText);

  return import(pathToFileURL(modulePath).href) as Promise<ContractParityGeneratedModule>;
}
