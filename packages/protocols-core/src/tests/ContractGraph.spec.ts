import "reflect-metadata";
import { defineProblemRegistry, ProblemCategory } from "@croco/problems-core";
import { Container } from "typedi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  assertContractGraphHasNoErrors,
  buildContractGraph,
  ContractGraphDiagnosticError,
  formatContractDiagnostic,
} from "../libs/ContractGraph";
import {
  assertContractGraphConsumerRouteCoverage,
  createContractGraphConsumerCoverage,
  getContractGraphConsumerRouteCoverageDiagnostics,
} from "../libs/ContractGraphConsumerCoverage";
import { diffContractGraphSnapshots } from "../libs/ContractGraphDiff";
import {
  createContractGraphV1,
  createContractGraphSnapshot,
  isContractGraphSnapshot,
  isContractGraphV1,
  parseContractGraphSnapshot,
  stringifyContractGraphV1,
  stringifyContractGraphSnapshot,
} from "../libs/ContractGraphSnapshot";
import {
  ParamType,
  REST_PARAMS_KEY,
  REST_ROUTES_KEY,
  type ParamMetadata,
  type RouteMetadata,
} from "../libs/sharedTypes";
import {
  defineRouteSchema,
  type InferRouteSchemaRequest,
  type InferRouteSchemaResponse,
} from "../libs/RouteSchema";
import { extractRouteIR } from "../libs/extractRouteIR";
import { CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE } from "../libs/SchemaDescriptor";
import { ENTITLEMENT_REQUIRED_KEY, ENTITLEMENT_REQUIREMENTS_KEY } from "../libs/sharedTypes";
import {
  Body,
  Controller,
  Get,
  Head,
  Header,
  Param,
  Post,
  ProblemResponse,
  Query,
  RequiresEntitlement,
  ResponseSchema,
  Roles,
  UseGuards,
} from "./helpers/test-decorators";

describe("buildContractGraph", () => {
  beforeEach(() => {
    Container.reset();
    vi.restoreAllMocks();
  });

  it("should build stable controller, route id, operation id, and schema graph nodes", () => {
    const createUserSchema = z.object({ name: z.string() });

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(@Param("id") _id: string, @Query("include") _include: string): void {}

      @Post("/")
      createUser(@Body(createUserSchema) _body: z.infer<typeof createUserSchema>): void {}
    }

    const graph = buildContractGraph([UsersController]);

    expect(graph.version).toBe("croco.contract-graph.v1");
    expect(graph.controllers).toEqual([
      {
        name: "UsersController",
        path: "/users",
        guards: [],
        roles: [],
        routeIds: ["UsersController.getUser", "UsersController.createUser"],
      },
    ]);
    expect(graph.routes).toHaveLength(2);
    expect(graph.routes[0]).toMatchObject({
      routeId: "UsersController.getUser",
      operationId: "UsersController_getUser",
      controllerName: "UsersController",
      methodName: "getUser",
      httpMethod: "GET",
      path: "/users/:id",
      controllerPath: "/users",
    });
    expect(graph.routes[1]?.inputSchemas.body).toBe(createUserSchema);
    expect(graph.diagnostics).toEqual([]);
  });

  it("should preserve a route schema object as the DTO and contract source of truth", () => {
    const createUserRoute = defineRouteSchema({
      request: {
        body: z.object({
          name: z.string().min(1),
          email: z.string().email(),
        }),
      },
      response: z.object({
        id: z.string().uuid(),
        name: z.string(),
        email: z.string().email(),
      }),
    });
    type CreateUserBody = InferRouteSchemaRequest<typeof createUserRoute>["body"];
    type CreateUserRequest = InferRouteSchemaRequest<typeof createUserRoute>;
    type CreateUserResponse = InferRouteSchemaResponse<typeof createUserRoute>;

    const validBody: CreateUserBody = { name: "Ada", email: "ada@example.com" };
    const validRequest: CreateUserRequest = { body: validBody };
    // @ts-expect-error DTO fields are inferred from the schema instead of a hand-maintained type.
    const invalidBody: CreateUserBody = { name: "Ada", email: 42 };

    @Controller("/users")
    class UsersController {
      @Post("/")
      @ResponseSchema(createUserRoute.response)
      createUser(@Body(createUserRoute.request.body) body: CreateUserBody): CreateUserResponse {
        return { id: "4ea573de-cfb9-4696-bc48-216f19f44300", ...body };
      }
    }

    const graph = buildContractGraph([UsersController]);
    const route = graph.routes[0];

    expect(validBody.email).toBe("ada@example.com");
    expect(validRequest.body.email).toBe("ada@example.com");
    expect(invalidBody).toBeDefined();
    expect(route?.inputSchemas.body).toBe(createUserRoute.request.body);
    expect(route?.params[0]?.schema).toBe(createUserRoute.request.body);
    expect(route?.outputSchema).toBe(createUserRoute.response);
    expect(createContractGraphSnapshot(graph).routes[0]).toMatchObject({
      request: {
        body: {
          kind: "object",
          fields: [
            { name: "email", required: true, schema: { kind: "string" } },
            { name: "name", required: true, schema: { kind: "string" } },
          ],
        },
      },
      response: {
        kind: "object",
        fields: [
          { name: "email", required: true, schema: { kind: "string" } },
          { name: "id", required: true, schema: { kind: "string" } },
          { name: "name", required: true, schema: { kind: "string" } },
        ],
      },
    });
    expect(graph.diagnostics).toEqual([]);
  });

  it("should normalize catch-all route parameters when validating path metadata", () => {
    @Controller("/assets")
    class AssetsController {
      @Get("/:...id")
      getAsset(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([AssetsController]);

    expect(graph.routes[0]).toMatchObject({
      routeId: "AssetsController.getAsset",
      path: "/assets/:...id",
    });
    expect(graph.diagnostics).toEqual([]);
    expect(() => assertContractGraphHasNoErrors(graph)).not.toThrow();
  });

  it("should preserve route contract identity and reject body or response decorator drift", () => {
    const bodySchema = z.object({ name: z.string() });
    const otherBodySchema = z.object({ displayName: z.string() });
    const responseSchema = z.object({ id: z.string(), name: z.string() });
    const otherResponseSchema = z.object({ id: z.string(), displayName: z.string() });

    @Controller("/users")
    class UsersController {
      @Post("/")
      @ResponseSchema(otherResponseSchema)
      createUser(@Body(otherBodySchema) _body: z.infer<typeof otherBodySchema>): void {}
    }

    attachRouteContract(UsersController, "createUser", {
      id: "users.create",
      method: "POST",
      path: "/users",
      operationId: "createUser",
      sourceLocation: { path: "src/controllers/UserController.ts", line: 20 },
      body: bodySchema,
      response: responseSchema,
    });

    const graph = buildContractGraph([UsersController]);

    expect(graph.routes[0]).toMatchObject({
      routeContract: {
        id: "users.create",
        method: "POST",
        path: "/users",
        operationId: "createUser",
        sourceLocation: { path: "src/controllers/UserController.ts", line: 20 },
      },
      operationId: "createUser",
    });
    expect(createContractGraphSnapshot(graph).routes[0]?.routeContract).toEqual({
      id: "users.create",
      method: "POST",
      path: "/users",
      operationId: "createUser",
      sourceLocation: { path: "src/controllers/UserController.ts", line: 20 },
    });
    expect(graph.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "contract-route-body-schema-mismatch",
          contractId: "users.create",
          sourceLocation: { path: "src/controllers/UserController.ts", line: 20 },
        }),
        expect.objectContaining({
          code: "contract-route-response-schema-mismatch",
          contractId: "users.create",
          sourceLocation: { path: "src/controllers/UserController.ts", line: 20 },
        }),
      ]),
    );
  });

  it("should expose auth and access metadata references when present", () => {
    const AuthGuard = class SharedAccessGuard {};
    const AuditGuard = class SharedAccessGuard {};

    @UseGuards(AuthGuard)
    @Roles("admin")
    @Controller("/admin")
    class AdminController {
      @UseGuards(AuditGuard)
      @Roles("owner")
      @Get("/:id")
      getAdminAsset(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([AdminController]);

    expect(graph.controllers[0]).toMatchObject({
      name: "AdminController",
      guards: [
        {
          type: "rest.guard",
          id: "rest.guard:controller:AdminController:0:constructor:SharedAccessGuard",
          kind: "constructor",
          name: "SharedAccessGuard",
          declaredAt: "controller",
          owner: { controllerName: "AdminController" },
          index: 0,
        },
      ],
      roles: ["admin"],
    });
    expect(graph.routes[0]?.access).toEqual({
      guards: [
        {
          type: "rest.guard",
          id: "rest.guard:controller:AdminController:0:constructor:SharedAccessGuard",
          kind: "constructor",
          name: "SharedAccessGuard",
          declaredAt: "controller",
          owner: { controllerName: "AdminController" },
          index: 0,
        },
        {
          type: "rest.guard",
          id: "rest.guard:route:AdminController.getAdminAsset:0:constructor:SharedAccessGuard",
          kind: "constructor",
          name: "SharedAccessGuard",
          declaredAt: "route",
          owner: {
            controllerName: "AdminController",
            methodName: "getAdminAsset",
            routeId: "AdminController.getAdminAsset",
          },
          index: 0,
        },
      ],
      roles: ["admin", "owner"],
    });
    expect(graph.routes[0]?.access.guards[0]?.id).not.toBe(graph.routes[0]?.access.guards[1]?.id);
    expect(graph.diagnostics).toEqual([]);
  });

  it("should preserve unnamed guard metadata references", () => {
    const unnamedGuard = function Guard() {};
    Object.defineProperty(unnamedGuard, "name", { value: "" });

    @UseGuards(unnamedGuard)
    @Controller("/admin")
    class AdminController {
      @Get("/")
      getAdmin(): void {}
    }

    const graph = buildContractGraph([AdminController]);

    expect(unnamedGuard.name).toBe("");
    expect(graph.controllers[0]?.guards).toEqual([
      {
        type: "rest.guard",
        id: "rest.guard:controller:AdminController:0:constructor:anonymous",
        kind: "constructor",
        name: "anonymous",
        declaredAt: "controller",
        owner: { controllerName: "AdminController" },
        index: 0,
      },
    ]);
    expect(graph.routes[0]?.access.guards[0]?.name).toBe("anonymous");
    expect(graph.diagnostics).toEqual([]);
  });

  it("should report unsupported and drift-prone route metadata as diagnostics", () => {
    @Controller("/hooks")
    class HooksController {
      @Get("/:id")
      handleHook(@Param("hookId") _hookId: string): void {}
    }

    const graph = buildContractGraph([HooksController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-missing-path-param",
        severity: "error",
        routeId: "HooksController.handleHook",
      }),
      expect.objectContaining({
        code: "contract-route-unbound-path-param",
        severity: "error",
        routeId: "HooksController.handleHook",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject weak request and response schemas in strict schema mode", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(
        @Param("id") _id: string,
        @Query("include") _include: string,
        @Header("x-request-id") _requestId: string,
      ): void {}

      @Post("/")
      createUser(@Body() _body: { name: string }): void {}
    }

    const graph = buildContractGraph([UsersController], { strictSchemas: true });

    const getUserRoute = graph.routes.find(
      (candidate) => candidate.routeId === "UsersController.getUser",
    );
    expect(getUserRoute?.params).toEqual([
      { index: 0, kind: "path", name: "id", schema: null },
      { index: 1, kind: "query", name: "include", schema: null },
      { index: 2, kind: "header", name: "x-request-id", schema: null },
    ]);
    expect((getUserRoute?.inputSchemas.query as z.AnyZodObject).shape.include.isOptional()).toBe(
      true,
    );
    expect(
      (getUserRoute?.inputSchemas.headers as z.AnyZodObject).shape["x-request-id"].isOptional(),
    ).toBe(true);

    expect(graph.diagnostics).toHaveLength(6);
    expect(graph.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "contract-route-missing-response-schema",
          severity: "error",
          routeId: "UsersController.getUser",
        }),
        expect.objectContaining({
          code: "contract-route-missing-named-param-schema",
          severity: "error",
          routeId: "UsersController.getUser",
          message: expect.stringContaining('@Param("id")'),
        }),
        expect.objectContaining({
          code: "contract-route-missing-named-param-schema",
          severity: "error",
          routeId: "UsersController.getUser",
          message: expect.stringContaining('@Query("include")'),
        }),
        expect.objectContaining({
          code: "contract-route-missing-named-param-schema",
          severity: "error",
          routeId: "UsersController.getUser",
          message: expect.stringContaining('@Header("x-request-id")'),
        }),
        expect.objectContaining({
          code: "contract-route-missing-response-schema",
          severity: "error",
          routeId: "UsersController.createUser",
        }),
        expect.objectContaining({
          code: "contract-route-missing-body-schema",
          severity: "error",
          routeId: "UsersController.createUser",
        }),
      ]),
    );
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should accept route contract schemas as the strict schema source of truth", () => {
    const idSchema = z.string().uuid();
    const includeSchema = z.boolean().optional();
    const createUserBody = z.object({ name: z.string().min(1) });
    const createUserResponse = z.object({ id: idSchema, name: z.string() });

    @Controller("/users")
    class UsersController {
      @Post("/:id")
      createUser(
        @Param("id") _id: string,
        @Query("include") _include: boolean | undefined,
        @Body() _body: z.infer<typeof createUserBody>,
      ): void {}
    }

    attachRouteContract(UsersController, "createUser", {
      id: "users.create",
      method: "POST",
      path: "/users/:id",
      params: z.object({ id: idSchema }),
      query: z.object({ include: includeSchema }),
      body: createUserBody,
      response: createUserResponse,
    });

    const graph = buildContractGraph([UsersController], { strictSchemas: true });

    expect(graph.diagnostics).toEqual([]);
    expect(() => assertContractGraphHasNoErrors(graph)).not.toThrow();
  });

  it("should require explicit header schemas even when a route contract backs other schemas", () => {
    const responseSchema = z.object({ ok: z.boolean() });

    @Controller("/users")
    class UsersController {
      @Get("/")
      listUsers(@Header("x-request-id") _requestId: string): void {}
    }

    attachRouteContract(UsersController, "listUsers", {
      method: "GET",
      path: "/users",
      response: responseSchema,
    });

    const graph = buildContractGraph([UsersController], { strictSchemas: true });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-missing-named-param-schema",
        routeId: "UsersController.listUsers",
        message: expect.stringContaining(
          'requires @Header("x-request-id") to receive a Zod schema',
        ),
      }),
    ]);
    expect(graph.diagnostics[0]?.message).not.toContain("route contract field");
  });

  it("should include route contract source locations in strict schema diagnostics", () => {
    const idSchema = z.string();
    const sourceLocation = { path: "src/controllers/UserController.ts", line: 12, column: 4 };

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(@Param("id", idSchema) _id: string): void {}
    }

    attachRouteContract(UsersController, "getUser", {
      method: "GET",
      path: "/users/:id",
      sourceLocation,
      params: z.object({ id: idSchema }),
    });

    const graph = buildContractGraph([UsersController], { strictSchemas: true });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-missing-response-schema",
        routeId: "UsersController.getUser",
        sourceLocation,
      }),
    ]);
    expect(formatContractDiagnostic(graph.diagnostics[0])).toContain(
      "src/controllers/UserController.ts:12:4",
    );
  });

  it("should warn when generated contracts unwrap Zod effects", () => {
    @Controller("/profiles")
    class ProfilesController {
      @Post("/")
      createProfile(@Body(z.string().refine((value) => value.length > 0)) _body: string): void {}
    }

    const graph = buildContractGraph([ProfilesController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-schema-zod-effects-unwrapped",
        severity: "warning",
        routeId: "ProfilesController.createProfile",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).not.toThrow();
    expect(formatContractDiagnostic(graph.diagnostics[0])).toContain(
      "WARNING contract-schema-zod-effects-unwrapped ProfilesController.createProfile",
    );
  });

  it("should warn when generated contracts unwrap nested Zod effects", () => {
    @Controller("/profiles")
    class ProfilesController {
      @Post("/")
      createProfile(
        @Body(z.object({ name: z.string().refine((value) => value.length > 0) }))
        _body: { name: string },
      ): void {}
    }

    const graph = buildContractGraph([ProfilesController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-schema-zod-effects-unwrapped",
        severity: "warning",
        routeId: "ProfilesController.createProfile",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).not.toThrow();
  });

  it("should reject JSON-unsafe schemas with the shared schema diagnostic code", () => {
    @Controller("/profiles")
    class ProfilesController {
      @Post("/")
      createProfile(
        @Body(
          z.object({
            amount: z.bigint(),
            checkedAt: z.date(),
            trimmed: z.string().transform((value) => value.trim()),
          }),
        )
        _body: unknown,
      ): void {}
    }

    const graph = buildContractGraph([ProfilesController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        severity: "error",
        routeId: "ProfilesController.createProfile",
        message: expect.stringContaining("body.amount"),
      }),
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        severity: "error",
        routeId: "ProfilesController.createProfile",
        message: expect.stringContaining("body.checkedAt"),
      }),
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        severity: "error",
        routeId: "ProfilesController.createProfile",
        message: expect.stringContaining("body.trimmed"),
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject JSON-unsafe decorator parameter schemas shadowed by route contracts", () => {
    @Controller("/profiles")
    class ProfilesController {
      @Get("/:id")
      getProfile(@Param("id", z.date()) _id: Date): void {}
    }

    attachRouteContract(ProfilesController, "getProfile", {
      method: "GET",
      path: "/profiles/:id",
      params: z.object({ id: z.string() }),
    });

    const graph = buildContractGraph([ProfilesController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-path-param-schema-mismatch",
        severity: "error",
        routeId: "ProfilesController.getProfile",
      }),
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        severity: "error",
        routeId: "ProfilesController.getProfile",
        message: expect.stringContaining("path.id"),
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject routes with more than one request body parameter", () => {
    @Controller("/users")
    class UsersController {
      @Post("/")
      createUser(
        @Body(z.object({ name: z.string() })) _body: { name: string },
        @Body(z.object({ auditId: z.string() })) _audit: { auditId: string },
      ): void {}
    }

    const graph = buildContractGraph([UsersController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-multiple-body-params",
        severity: "error",
        routeId: "UsersController.createUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject duplicate normalized operation ids", () => {
    @Controller("/users")
    class UsersController {
      @Get("/with-underscore")
      get_user(): void {}
    }

    @Controller("/users-alt")
    class UsersController_get {
      @Get("/plain")
      user(): void {}
    }

    const graph = buildContractGraph([UsersController, UsersController_get]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-duplicate-operation-id",
        severity: "error",
        routeId: "UsersController_get.user",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject duplicate controller names used as contract identity", () => {
    const FirstController = (() => {
      @Controller("/first")
      class DuplicateController {
        @Get("/one")
        one(): void {}
      }

      return DuplicateController;
    })();

    const SecondController = (() => {
      @Controller("/second")
      class DuplicateController {
        @Get("/two")
        two(): void {}
      }

      return DuplicateController;
    })();

    const graph = buildContractGraph([FirstController, SecondController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-controller-duplicate-name",
        severity: "error",
        target: "controller",
        controllerName: "DuplicateController",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should expose explicit HEAD routes without synthesizing GET-implied HEAD contracts", () => {
    @Controller("/head-policy")
    class HeadPolicyController {
      @Get("/get-only")
      getOnly(): void {}

      @Get("/resource")
      getResource(): void {}

      @Head("/resource")
      headResource(): void {}
    }

    const graph = buildContractGraph([HeadPolicyController]);
    const snapshot = createContractGraphV1(graph);
    const getOnlyMethods = graph.routes
      .filter((route) => route.path === "/head-policy/get-only")
      .map((route) => route.httpMethod);
    const resourceMethods = graph.routes
      .filter((route) => route.path === "/head-policy/resource")
      .map((route) => route.httpMethod)
      .sort();
    const snapshotResourceMethods = snapshot.routes
      .filter((route) => route.path === "/head-policy/resource")
      .map((route) => route.method)
      .sort();

    expect(graph.diagnostics).toEqual([]);
    expect(getOnlyMethods).toEqual(["GET"]);
    expect(resourceMethods).toEqual(["GET", "HEAD"]);
    expect(snapshotResourceMethods).toEqual(["GET", "HEAD"]);
  });

  it("should create byte-stable sorted JSON snapshots for the same controller metadata", () => {
    @Controller("/admin")
    class AdminController {
      @Get("/")
      listAdmins(): void {}
    }

    @Controller("/users")
    class UsersController {
      @Post("/")
      createUser(
        @Body(z.object({ email: z.string().optional(), name: z.string() }))
        _body: { name: string; email?: string },
      ): void {}

      @Get("/:id")
      getUser(@Param("id") _id: string): void {}
    }

    const first = stringifyContractGraphSnapshot(
      createContractGraphSnapshot(buildContractGraph([UsersController, AdminController])),
    );
    const second = stringifyContractGraphSnapshot(
      createContractGraphSnapshot(buildContractGraph([AdminController, UsersController])),
    );
    const snapshot = JSON.parse(first);

    expect(first).toBe(second);
    expect(snapshot).toMatchObject({
      snapshotVersion: "croco.contract-graph.snapshot.v1",
      graphVersion: "croco.contract-graph.v1",
      controllerCount: 2,
      routeCount: 3,
      operationIds: [
        "AdminController_listAdmins",
        "UsersController_createUser",
        "UsersController_getUser",
      ],
      consumerCoverage: {
        version: "croco.contract-consumer-coverage.v1",
        routeCount: 3,
        consumers: [
          expect.objectContaining({
            consumerId: "admin-generated",
            requiredRouteFields: expect.arrayContaining([
              "routeId",
              "operationId",
              "request.body",
              "response",
              "problems",
              "access.guards",
              "access.roles",
            ]),
          }),
          expect.objectContaining({
            consumerId: "openapi",
            requiredRouteFields: expect.arrayContaining([
              "routeId",
              "operationId",
              "request.body",
              "response",
              "problems",
            ]),
          }),
          expect.objectContaining({
            consumerId: "rpc-client",
            requiredRouteFields: expect.arrayContaining([
              "routeId",
              "operationId",
              "request.body",
              "response",
              "problems",
            ]),
          }),
        ],
      },
    });
  });

  it("should remove checkout-root prefixes from persisted source locations", () => {
    @Controller("/reports")
    class ReportsController {
      @Get("/")
      listReports(): void {}
    }
    const attachAtRoot = (root: string) => {
      attachRouteContract(ReportsController, "listReports", {
        method: "GET",
        path: "/reports",
        sourceLocation: {
          path: `${root}/apps/api-server/src/controllers/ReportsController.ts`,
          line: 10,
        },
      });
      return stringifyContractGraphV1(
        createContractGraphV1(buildContractGraph([ReportsController])),
      );
    };

    const first = attachAtRoot("/private/tmp/checkout-a");
    const second = attachAtRoot("/workspace/checkout-b");

    expect(first).toBe(second);
    expect(JSON.parse(first).routes[0].source.path).toBe(
      "apps/api-server/src/controllers/ReportsController.ts",
    );
  });

  it("should expose ContractGraph v1 as a deterministic JSON-safe route schema", () => {
    const AuditGuard = class AuditGuard {};
    const createReportBody = z.object({ title: z.string() });
    const reportResponse = z.object({ id: z.string(), title: z.string() });

    @UseGuards(AuditGuard)
    @Roles("admin")
    @Controller("/reports")
    class ReportsController {
      @Post("/")
      @RequiresEntitlement({
        feature: "reports.create",
        description: "Create reports.",
        resource: { type: "report" },
      })
      @ProblemResponse({ code: "REPORT_FORBIDDEN", category: ProblemCategory.Forbidden })
      @ResponseSchema(reportResponse)
      createReport(@Body(createReportBody) _body: z.infer<typeof createReportBody>): void {}
    }

    @Controller("/health")
    class HealthController {
      @Get("/")
      getHealth(): void {}
    }

    attachRouteContract(ReportsController, "createReport", {
      id: "reports.create",
      method: "POST",
      path: "/reports",
      operationId: "createReport",
      sourceLocation: { path: "src/controllers/ReportsController.ts", line: 12 },
      body: createReportBody,
      response: reportResponse,
      problems: [{ code: "REPORT_FORBIDDEN", category: ProblemCategory.Forbidden, status: 403 }],
    });

    const first = stringifyContractGraphV1(
      createContractGraphV1(buildContractGraph([ReportsController, HealthController])),
    );
    const second = stringifyContractGraphV1(
      createContractGraphV1(buildContractGraph([HealthController, ReportsController])),
    );
    const graph = JSON.parse(first);

    expect(first).toBe(second);
    expect(isContractGraphV1(graph)).toBe(true);
    expect(graph).toMatchObject({
      version: "croco.contract-graph.v1",
      diagnostics: [],
      routes: [
        {
          id: "HealthController.getHealth",
          protocol: "rest",
          method: "GET",
          path: "/health",
          source: null,
          inputSchemas: {
            body: null,
            path: null,
            query: null,
            headers: null,
          },
          outputSchema: null,
          policies: [],
          runtime: [{ type: "rest.route", method: "GET", path: "/health" }],
          di: [],
        },
        {
          id: "ReportsController.createReport",
          protocol: "rest",
          method: "POST",
          path: "/reports",
          source: { path: "src/controllers/ReportsController.ts", line: 12 },
          inputSchemas: {
            body: {
              kind: "object",
              fields: [{ name: "title", required: true, schema: { kind: "string" } }],
            },
          },
          outputSchema: {
            kind: "object",
            fields: [
              { name: "id", required: true, schema: { kind: "string" } },
              { name: "title", required: true, schema: { kind: "string" } },
            ],
          },
          problems: [
            {
              code: "REPORT_FORBIDDEN",
              category: "Forbidden",
              status: 403,
              cookbookPath: "/reference/problem-recovery-cookbook/#report-forbidden",
            },
          ],
          policies: expect.arrayContaining([
            {
              type: "entitlement",
              id: expect.stringContaining("entitlement:ReportsController.createReport:0:"),
              owner: {
                controllerName: "ReportsController",
                routeId: "ReportsController.createReport",
                methodName: "createReport",
              },
              entitlement: {
                feature: "reports.create",
                description: "Create reports.",
                resource: { type: "report" },
              },
            },
            {
              type: "rest.role",
              id: "rest.role:ReportsController.createReport:0:admin",
              owner: {
                controllerName: "ReportsController",
                routeId: "ReportsController.createReport",
                methodName: "createReport",
              },
              role: "admin",
            },
          ]),
          runtime: [{ type: "rest.route", method: "POST", path: "/reports" }],
          di: [
            expect.objectContaining({
              type: "rest.guard",
              declaredAt: "controller",
              name: "AuditGuard",
            }),
          ],
        },
      ],
    });

    @Controller("/profiles")
    class ProfilesController {
      @Post("/")
      createProfile(@Body(z.string().refine((value) => value.length > 0)) _body: string): void {}
    }

    expect(createContractGraphV1(buildContractGraph([ProfilesController])).diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-schema-zod-effects-unwrapped",
        severity: "warning",
        routeId: "ProfilesController.createProfile",
      }),
    ]);
  });

  it("should reject malformed ContractGraph v1 envelopes", () => {
    const validRoute = {
      id: "UsersController.list",
      protocol: "rest",
      method: "GET",
      path: "/users",
      source: null,
      inputSchemas: {
        body: null,
        path: null,
        query: null,
        headers: null,
      },
      outputSchema: null,
      problems: [],
      policies: [],
      runtime: [{ type: "rest.route", method: "GET", path: "/users" }],
      di: [],
    };
    const validDiagnostic = {
      code: "contract-route-missing-problem-union",
      severity: "warning",
      target: "route",
      message: "Declare generated client Problem responses.",
      routeId: "UsersController.list",
    };

    expect(
      isContractGraphV1({
        version: "croco.contract-graph.v1",
        routes: [validRoute],
        diagnostics: [validDiagnostic],
      }),
    ).toBe(true);
    expect(
      isContractGraphV1({
        version: "croco.contract-graph.v1",
        routes: [null],
        diagnostics: [],
      }),
    ).toBe(false);
    expect(
      isContractGraphV1({
        version: "croco.contract-graph.v1",
        routes: [{ ...validRoute, method: undefined }],
        diagnostics: [],
      }),
    ).toBe(false);
    expect(
      isContractGraphV1({
        version: "croco.contract-graph.v1",
        routes: [{ ...validRoute, source: { line: 12 } }],
        diagnostics: [],
      }),
    ).toBe(false);
    expect(
      isContractGraphV1({
        version: "croco.contract-graph.v1",
        routes: [validRoute],
        diagnostics: [null],
      }),
    ).toBe(false);
    expect(
      isContractGraphV1({
        version: "croco.contract-graph.v1",
        routes: [validRoute],
        diagnostics: [{ ...validDiagnostic, message: undefined }],
      }),
    ).toBe(false);
  });

  it("should deep-validate persisted ContractGraph snapshot members", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ResponseSchema(z.object({ id: z.string() }))
      getUser(@Param("id") _id: string): void {}
    }

    const snapshot = createContractGraphSnapshot(buildContractGraph([UsersController]));
    const controller = snapshot.controllers[0];
    const route = snapshot.routes[0];

    expect(controller).toBeDefined();
    expect(route).toBeDefined();
    if (!controller || !route) {
      return;
    }

    const validDiagnostic = {
      code: "contract-route-missing-problem-union",
      severity: "warning",
      target: "problem",
      message: "Declare generated client Problem responses.",
      routeId: route.routeId,
    } as const;
    const malformedSnapshots: readonly unknown[] = [
      { ...snapshot, controllerCount: "1" },
      { ...snapshot, operationIds: [route.operationId, 42] },
      { ...snapshot, controllers: [{ ...controller, roles: ["admin", 42] }] },
      { ...snapshot, routes: [{ ...route, httpMethod: 42 }] },
      {
        ...snapshot,
        routes: [
          {
            ...route,
            problems: [
              {
                code: "UPSTREAM_FAILURE",
                category: "InternalServerError",
                status: JSON.parse("1e309") as unknown,
              },
            ],
          },
        ],
      },
      {
        ...snapshot,
        controllers: [
          {
            ...controller,
            guards: [
              {
                type: "rest.guard",
                id: "guard:legacy",
                kind: "constructor",
                name: "LegacyGuard",
                declaredAt: "controller",
                owner: { controllerName: controller.name },
                index: -1,
              },
            ],
          },
        ],
      },
      {
        ...snapshot,
        routes: [
          {
            ...route,
            params: [{ kind: "cookie", name: "id", schema: null }],
          },
        ],
      },
      {
        ...snapshot,
        routes: [
          {
            ...route,
            response: {
              kind: "object",
              typeName: "ZodObject",
              jsonSafe: true,
              fields: [{ name: "id", required: "true", schema: route.response }],
            },
          },
        ],
      },
      { ...snapshot, diagnostics: [{ ...validDiagnostic, target: "unknown" }] },
      {
        ...snapshot,
        consumerCoverage: snapshot.consumerCoverage
          ? {
              ...snapshot.consumerCoverage,
              consumers: [
                {
                  ...snapshot.consumerCoverage.consumers[0],
                  consumerId: "unknown",
                },
              ],
            }
          : null,
      },
    ];

    expect(isContractGraphSnapshot({ ...snapshot, diagnostics: [validDiagnostic] })).toBe(true);
    for (const malformed of malformedSnapshots) {
      expect(isContractGraphSnapshot(malformed)).toBe(false);
    }

    const modernRouteWithoutProblems = { ...route } as Record<string, unknown>;
    delete modernRouteWithoutProblems["problems"];
    expect(parseContractGraphSnapshot({ ...snapshot, routes: [modernRouteWithoutProblems] })).toBe(
      null,
    );
  });

  it("should normalize historical ContractGraph snapshot v1 artifacts", () => {
    const persisted = {
      snapshotVersion: "croco.contract-graph.snapshot.v1",
      graphVersion: "croco.contract-graph.v1",
      controllerCount: 1,
      routeCount: 1,
      operationIds: ["LegacyController_list"],
      controllers: [
        {
          name: "LegacyController",
          path: "/legacy",
          guards: [],
          roles: [],
          routeIds: ["LegacyController.list"],
        },
      ],
      routes: [
        {
          routeId: "LegacyController.list",
          operationId: "LegacyController_list",
          controllerName: "LegacyController",
          methodName: "list",
          httpMethod: "GET",
          path: "/legacy",
          controllerPath: "/legacy",
          domain: null,
          access: { guards: [], roles: [] },
          params: [],
          request: { body: null, path: null, query: null, headers: null },
          response: {
            kind: "object",
            typeName: "ZodObject",
            fields: [
              {
                name: "id",
                required: true,
                schema: { kind: "string", typeName: "ZodString" },
              },
            ],
          },
        },
      ],
      diagnostics: [],
    };

    expect(isContractGraphSnapshot(persisted)).toBe(false);
    expect(parseContractGraphSnapshot(persisted)).toMatchObject({
      routes: [
        {
          routeContract: null,
          entitlements: [],
          problems: [],
          response: {
            jsonSafe: true,
            fields: [{ schema: { jsonSafe: true } }],
          },
        },
      ],
    });

    const legacyRoute = persisted.routes[0];
    expect(
      parseContractGraphSnapshot({
        ...persisted,
        routes: [
          {
            ...legacyRoute,
            response: {
              kind: "effects",
              typeName: "ZodEffects",
              effectType: "transform",
              inner: { kind: "string", typeName: "ZodString" },
            },
          },
        ],
      }),
    ).toBe(null);
    expect(
      parseContractGraphSnapshot({
        ...persisted,
        routes: [
          {
            ...legacyRoute,
            response: { kind: "enum", typeName: "ZodEnum", values: [1] },
          },
        ],
      }),
    ).toBe(null);
  });

  it("should report consumer coverage diagnostics instead of silently dropping unsupported fields", () => {
    const AuthGuard = class AuthGuard {};

    @UseGuards(AuthGuard)
    @Roles("admin")
    @Controller("/admin")
    class AdminController {
      @Get("/")
      listAdmins(): void {}
    }

    const graph = buildContractGraph([AdminController]);
    const report = createContractGraphConsumerCoverage(graph);

    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-consumer-unsupported-route-field",
        severity: "warning",
        routeId: "AdminController.listAdmins",
        message: expect.stringContaining("access.guards"),
      }),
      expect.objectContaining({
        code: "contract-consumer-unsupported-route-field",
        severity: "warning",
        routeId: "AdminController.listAdmins",
        message: expect.stringContaining("access.roles"),
      }),
      expect.objectContaining({
        code: "contract-consumer-unsupported-route-field",
        severity: "warning",
        routeId: "AdminController.listAdmins",
        message: expect.stringContaining("access.guards"),
      }),
      expect.objectContaining({
        code: "contract-consumer-unsupported-route-field",
        severity: "warning",
        routeId: "AdminController.listAdmins",
        message: expect.stringContaining("access.roles"),
      }),
    ]);
    const openApiCoverage = report.consumers.find((consumer) => consumer.consumerId === "openapi");
    expect(openApiCoverage?.routes[0]?.unsupportedFields).toEqual([
      "access.guards",
      "access.roles",
    ]);
  });

  it("should reject generated consumers that omit graph routes", () => {
    @Controller("/users")
    class UsersController {
      @Get("/")
      listUsers(): void {}

      @Post("/")
      createUser(): void {}
    }

    const graph = buildContractGraph([UsersController]);

    expect(() =>
      assertContractGraphConsumerRouteCoverage(graph, "openapi", [
        {
          routeId: "UsersController.listUsers",
          operationId: "UsersController_listUsers",
        },
      ]),
    ).toThrow("contract-consumer-missing-route");
  });

  it("should reject generated consumers that drop operation ids, response schemas, or Problems", () => {
    const userSchema = z.object({ id: z.string() });

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ResponseSchema(userSchema)
      @ProblemResponse({
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
      })
      getUser(@Param("id") _id: string): z.infer<typeof userSchema> {
        return { id: "user_1" };
      }
    }

    const graph = buildContractGraph([UsersController]);
    const diagnostics = getContractGraphConsumerRouteCoverageDiagnostics(graph, "openapi", [
      {
        routeId: "UsersController.getUser",
        consumedFields: [
          "routeId",
          "httpMethod",
          "path",
          "request.body",
          "request.path",
          "request.query",
          "request.headers",
          "response",
          "problems",
        ],
        fieldFingerprints: {
          routeId: "UsersController.getUser",
          httpMethod: "GET",
          path: "/users/:id",
          "request.body": "absent",
          "request.path": "present",
          "request.query": "absent",
          "request.headers": "absent",
          response: "absent",
          problems: "[]",
        },
      },
    ]);

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "contract-consumer-missing-generated-route-field",
      "contract-consumer-missing-generated-route-field",
      "contract-consumer-route-field-mismatch",
      "contract-consumer-route-field-mismatch",
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining("entitlements"),
      expect.stringContaining("operationId"),
      expect.stringContaining("problems"),
      expect.stringContaining("response"),
    ]);
  });

  it("should reject admin-generated consumers that drift access metadata", () => {
    const AuthGuard = class AuthGuard {};

    @UseGuards(AuthGuard)
    @Roles("admin")
    @Controller("/admin")
    class AdminController {
      @Get("/")
      listAdmins(): void {}
    }

    const graph = buildContractGraph([AdminController]);
    const diagnostics = getContractGraphConsumerRouteCoverageDiagnostics(graph, "admin-generated", [
      {
        routeId: "AdminController.listAdmins",
        operationId: "AdminController_listAdmins",
        consumedFields: [
          "routeId",
          "operationId",
          "httpMethod",
          "path",
          "request.body",
          "request.path",
          "request.query",
          "request.headers",
          "response",
          "problems",
          "entitlements",
          "access.guards",
          "access.roles",
        ],
        fieldFingerprints: {
          routeId: "AdminController.listAdmins",
          operationId: "AdminController_listAdmins",
          httpMethod: "GET",
          path: "/admin",
          "request.body": "absent",
          "request.path": "absent",
          "request.query": "absent",
          "request.headers": "absent",
          response: "absent",
          problems: "[]",
          entitlements: "[]",
          "access.guards": "[]",
          "access.roles": "[]",
        },
      },
    ]);

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "contract-consumer-route-field-mismatch",
      "contract-consumer-route-field-mismatch",
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining("access.guards"),
      expect.stringContaining("access.roles"),
    ]);
  });

  it("should reject admin-generated consumers that omit or mutate entitlement metadata", () => {
    @Controller("/reports")
    class ReportsController {
      @Get("/:id")
      @RequiresEntitlement({
        feature: "reports.read",
        resource: { type: "report", idParam: "id" },
      })
      getReport(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([ReportsController]);
    const baseObservedRoute = {
      routeId: "ReportsController.getReport",
      operationId: "ReportsController_getReport",
      consumedFields: [
        "routeId",
        "operationId",
        "httpMethod",
        "path",
        "request.body",
        "request.path",
        "request.query",
        "request.headers",
        "response",
        "problems",
        "access.guards",
        "access.roles",
      ] as const,
      fieldFingerprints: {
        routeId: "ReportsController.getReport",
        operationId: "ReportsController_getReport",
        httpMethod: "GET",
        path: "/reports/:id",
        "request.body": "absent",
        "request.path": "present",
        "request.query": "absent",
        "request.headers": "absent",
        response: "absent",
        problems: "[]",
        "access.guards": "[]",
        "access.roles": "[]",
      },
    };

    const omittedDiagnostics = getContractGraphConsumerRouteCoverageDiagnostics(
      graph,
      "admin-generated",
      [baseObservedRoute],
    );
    const mutatedDiagnostics = getContractGraphConsumerRouteCoverageDiagnostics(
      graph,
      "admin-generated",
      [
        {
          ...baseObservedRoute,
          consumedFields: [...baseObservedRoute.consumedFields, "entitlements"],
          fieldFingerprints: {
            ...baseObservedRoute.fieldFingerprints,
            entitlements: JSON.stringify([{ feature: "reports.export" }]),
          },
        },
      ],
    );

    expect(omittedDiagnostics).toEqual([
      expect.objectContaining({
        code: "contract-consumer-missing-generated-route-field",
        message: expect.stringContaining("entitlements"),
      }),
    ]);
    expect(mutatedDiagnostics).toEqual([
      expect.objectContaining({
        code: "contract-consumer-route-field-mismatch",
        message: expect.stringContaining("entitlements"),
      }),
    ]);
  });

  it("should snapshot declared Problem responses as route failure contracts", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({
        code: "USER_FORBIDDEN",
        category: ProblemCategory.Forbidden,
      })
      @ProblemResponse({
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
        description: "User id is missing.",
      })
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController]);
    const snapshot = createContractGraphSnapshot(graph);

    expect(graph.diagnostics).toEqual([]);
    expect(snapshot.routes[0]?.problems).toEqual([
      {
        code: "USER_FORBIDDEN",
        category: "Forbidden",
        cookbookPath: "/reference/problem-recovery-cookbook/#user-forbidden",
        status: 403,
      },
      {
        code: "USER_NOT_FOUND",
        category: "NotFound",
        cookbookPath: "/reference/problem-recovery-cookbook/#user-not-found",
        description: "User id is missing.",
        status: 404,
      },
    ]);
  });

  it("should snapshot entitlement requirements as route contract artifacts", () => {
    @Controller("/reports")
    class ReportsController {
      @Get("/:id")
      @RequiresEntitlement({
        feature: "reports.export",
        description: "Export report data.",
        resource: { type: "report", idParam: "id" },
      })
      exportReport(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([ReportsController]);
    const snapshot = createContractGraphSnapshot(graph);
    const report = createContractGraphConsumerCoverage(graph);

    expect(graph.routes[0]?.entitlements).toEqual([
      {
        feature: "reports.export",
        description: "Export report data.",
        resource: { type: "report", idParam: "id" },
      },
    ]);
    expect(snapshot.routes[0]?.entitlements).toEqual([
      {
        feature: "reports.export",
        description: "Export report data.",
        resource: { type: "report", idParam: "id" },
      },
    ]);

    @Controller("/legacy-reports")
    class LegacyReportsController {
      @Get("/:id")
      getReport(@Param("id") _id: string): void {}
    }

    Reflect.defineMetadata(
      ENTITLEMENT_REQUIRED_KEY,
      "reports.read",
      LegacyReportsController.prototype,
      "getReport",
    );

    expect(buildContractGraph([LegacyReportsController]).routes[0]?.entitlements).toEqual([
      { feature: "reports.read" },
    ]);
    expect(report.consumers.find((consumer) => consumer.consumerId === "openapi")).toMatchObject({
      requiredRouteFields: expect.arrayContaining(["entitlements"]),
    });
    expect(report.consumers.find((consumer) => consumer.consumerId === "rpc-client")).toMatchObject(
      {
        routes: [
          expect.objectContaining({
            unsupportedFields: ["entitlements"],
          }),
        ],
      },
    );

    @Controller("/multi-reports")
    class MultiReportsController {
      @Get("/")
      @RequiresEntitlement({ feature: "reports.export" })
      @RequiresEntitlement({ feature: "reports.read" })
      listReports(): void {}
    }

    const multiEntitlements = buildContractGraph([MultiReportsController]).routes[0]?.entitlements;

    expect(multiEntitlements).toHaveLength(2);
    expect(multiEntitlements).toEqual(
      expect.arrayContaining([{ feature: "reports.export" }, { feature: "reports.read" }]),
    );

    @Controller("/invalid-reports")
    class InvalidReportsController {
      @Get("/:id")
      getReport(@Param("id") _id: string): void {}
    }

    Reflect.defineMetadata(
      ENTITLEMENT_REQUIREMENTS_KEY,
      [
        { feature: "reports.export", resource: { type: 42 } },
        {
          feature: "reports.read",
          resource: { type: "report", idParam: "id" },
        },
      ],
      InvalidReportsController.prototype,
      "getReport",
    );

    expect(buildContractGraph([InvalidReportsController]).routes[0]?.entitlements).toEqual([
      { feature: "reports.read", resource: { type: "report", idParam: "id" } },
    ]);
  });

  it("should reject duplicate declared Problem codes on a route", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({ code: "USER_NOT_FOUND", category: ProblemCategory.NotFound })
      @ProblemResponse({ code: "USER_NOT_FOUND", category: ProblemCategory.NotFound })
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-duplicate-problem-code",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should attach declared ProblemRegistry entries to route Problem responses", () => {
    const registry = defineProblemRegistry({
      package: "@croco/users-api",
      problems: {
        USERS_API_NOT_FOUND: {
          category: ProblemCategory.NotFound,
          retryable: false,
          public: true,
          status: 404,
          redaction: "public",
        },
      },
    });

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({ code: "USERS_API_NOT_FOUND", category: ProblemCategory.NotFound })
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController], { problemRegistries: [registry] });

    expect(graph.diagnostics).toEqual([]);
    expect(graph.routes[0]?.problemResponses?.[0]?.registry).toEqual({
      package: "@croco/users-api",
      code: "USERS_API_NOT_FOUND",
      category: ProblemCategory.NotFound,
      status: 404,
      retryable: false,
      retryability: "not-retryable",
      public: true,
      visibility: "public",
      redaction: "public",
      cookbookPath: "/reference/problem-recovery-cookbook/#users-api-not-found",
    });
    expect(graph.routes[0]?.problemResponses?.[0]?.registry).not.toHaveProperty("lifecycle");
    expect(graph.routes[0]?.problemResponses?.[0]?.registry).not.toHaveProperty("deprecation");

    expect(createContractGraphSnapshot(graph).routes[0]?.problems[0]?.registry).toEqual(
      graph.routes[0]?.problemResponses?.[0]?.registry,
    );
    expect(createContractGraphSnapshot(graph).routes[0]?.problems[0]?.registry).not.toHaveProperty(
      "lifecycle",
    );
  });

  it("should reject route Problem responses missing from supplied ProblemRegistry manifests", () => {
    const registry = defineProblemRegistry({
      package: "@croco/users-api",
      problems: {
        USERS_API_NOT_FOUND: {
          category: ProblemCategory.NotFound,
          retryable: false,
          public: true,
          status: 404,
          redaction: "public",
        },
      },
    });

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({
        code: "USERS_API_FORBIDDEN",
        category: ProblemCategory.Forbidden,
      })
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController], { problemRegistries: [registry] });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-problem-registry-missing",
        target: "problem",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject route Problem responses that drift from supplied ProblemRegistry manifests", () => {
    const registry = defineProblemRegistry({
      package: "@croco/users-api",
      problems: {
        USERS_API_NOT_FOUND: {
          category: ProblemCategory.NotFound,
          retryable: false,
          public: true,
          status: 404,
          redaction: "public",
        },
      },
    });

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({
        code: "USERS_API_NOT_FOUND",
        category: ProblemCategory.Forbidden,
        status: 403,
      })
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController], { problemRegistries: [registry] });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-problem-registry-mismatch",
        target: "problem",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should accept concrete route statuses for runtime-configurable ProblemRegistry entries", () => {
    const registry = defineProblemRegistry({
      package: "@croco/users-api",
      problems: {
        USERS_API_BODY_TOO_LARGE: {
          category: ProblemCategory.PayloadTooLarge,
          retryable: false,
          public: true,
          status: 413,
          statusPolicy: {
            kind: "runtime-configurable",
            defaultStatus: 413,
            configuration: "bodyLimitMiddleware.statusCode",
          },
          redaction: "public",
        },
      },
    });

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({
        code: "USERS_API_BODY_TOO_LARGE",
        category: ProblemCategory.PayloadTooLarge,
        status: 422,
      })
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController], { problemRegistries: [registry] });

    expect(graph.diagnostics).toEqual([]);
    expect(graph.routes[0]?.problemResponses?.[0]?.registry).toMatchObject({
      status: 413,
      statusPolicy: {
        kind: "runtime-configurable",
        defaultStatus: 413,
        configuration: "bodyLimitMiddleware.statusCode",
      },
    });
  });

  it("should report invalid supplied ProblemRegistry manifests as graph diagnostics", () => {
    const registry = defineProblemRegistry({
      package: "@croco/users-api",
      problems: {
        USERS_API_NOT_FOUND: {
          category: ProblemCategory.NotFound,
          retryable: false,
          public: true,
          status: 404,
          redaction: "public",
        },
      },
    });

    const graph = buildContractGraph([], { problemRegistries: [registry, registry] });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-graph-problem-registry-invalid",
        target: "graph",
      }),
    ]);
    expect(graph.diagnostics[0]?.message).toContain(
      "Problem code 'USERS_API_NOT_FOUND' is declared by both @croco/users-api and @croco/users-api.",
    );
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject manual Problem responses that drift from route contract problems", () => {
    const userIdSchema = z.string();

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({
        code: "USER_FORBIDDEN",
        category: ProblemCategory.Forbidden,
      })
      getUser(@Param("id", userIdSchema) _id: string): void {}
    }

    attachRouteContract(UsersController, "getUser", {
      method: "GET",
      path: "/users/:id",
      params: z.object({ id: userIdSchema }),
      problems: [
        {
          code: "USER_NOT_FOUND",
          category: ProblemCategory.NotFound,
          status: 404,
        },
      ],
    });

    const graph = buildContractGraph([UsersController], { strictProblemResponses: true });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-missing-problem-response",
        routeId: "UsersController.getUser",
      }),
      expect.objectContaining({
        code: "contract-route-problem-response-not-in-contract",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject missing route metadata for route contract problems", () => {
    const userIdSchema = z.string();

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(@Param("id", userIdSchema) _id: string): void {}
    }

    attachRouteContract(UsersController, "getUser", {
      method: "GET",
      path: "/users/:id",
      params: z.object({ id: userIdSchema }),
      problems: [
        {
          code: "USER_NOT_FOUND",
          category: ProblemCategory.NotFound,
          status: 404,
        },
      ],
    });

    const graph = buildContractGraph([UsersController], { strictProblemResponses: true });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-missing-problem-response",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should report a single missing metadata diagnostic for duplicate route contract Problem codes", () => {
    const userIdSchema = z.string();

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(@Param("id", userIdSchema) _id: string): void {}
    }

    attachRouteContract(UsersController, "getUser", {
      method: "GET",
      path: "/users/:id",
      params: z.object({ id: userIdSchema }),
      problems: [
        {
          code: "USER_NOT_FOUND",
          category: ProblemCategory.NotFound,
          status: 404,
        },
        {
          code: "USER_NOT_FOUND",
          category: ProblemCategory.NotFound,
          status: 404,
        },
      ],
    });

    const graph = buildContractGraph([UsersController], { strictProblemResponses: true });

    expect(
      graph.diagnostics.filter(
        (diagnostic) => diagnostic.code === "contract-route-missing-problem-response",
      ),
    ).toEqual([
      expect.objectContaining({
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject Problem responses that are not declared by the route contract", () => {
    const routeContractProblems = [
      {
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
        status: 404,
      },
    ];

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({
        code: "USER_FORBIDDEN",
        category: ProblemCategory.Forbidden,
        status: 403,
      })
      @ProblemResponse({
        ...routeContractProblems[0],
        routeContractProblems,
      })
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-problem-response-not-in-contract",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject Problem response category/status drift from route contracts", () => {
    const routeContractProblems = [
      {
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
        status: 404,
      },
    ];

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({
        code: "USER_NOT_FOUND",
        category: ProblemCategory.Forbidden,
        status: 403,
        routeContractProblems,
      })
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-problem-response-mismatch",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject Problem response status drift from route contracts", () => {
    const routeContractProblems = [
      {
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
        status: 404,
      },
    ];

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
        status: 500,
        routeContractProblems,
      })
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-problem-response-mismatch",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should reject filtered route contract Problem declarations", () => {
    const routeContractProblems = [
      {
        code: "USER_FORBIDDEN",
        category: ProblemCategory.Forbidden,
        status: 403,
      },
      {
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
        status: 404,
      },
    ];

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({
        ...routeContractProblems[0],
        routeContractProblems,
      })
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController]);

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-missing-problem-response",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should warn in strict Problem mode when a route has no declared failure union", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(@Param("id") _id: string): void {}
    }

    const graph = buildContractGraph([UsersController], { strictProblemResponses: true });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-missing-problem-response-contract",
        severity: "warning",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).not.toThrow();
  });

  it("should accept explicit empty route contract Problem declarations in strict Problem mode", () => {
    @Controller("/users")
    class UsersController {
      @Get("/")
      listUsers(): void {}
    }

    attachRouteContract(UsersController, "listUsers", {
      method: "GET",
      path: "/users",
      problems: [],
    });

    const graph = buildContractGraph([UsersController], { strictProblemResponses: true });

    expect(graph.diagnostics).toEqual([]);
    expect(() => assertContractGraphHasNoErrors(graph)).not.toThrow();
  });

  it("should reject Problem responses outside explicit empty route contract declarations", () => {
    const userIdSchema = z.string();

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({ code: "USER_NOT_FOUND", category: ProblemCategory.NotFound })
      getUser(@Param("id", userIdSchema) _id: string): void {}
    }

    attachRouteContract(UsersController, "getUser", {
      method: "GET",
      path: "/users/:id",
      params: z.object({ id: userIdSchema }),
      problems: [],
    });

    const graph = buildContractGraph([UsersController], { strictProblemResponses: true });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "contract-route-problem-response-not-in-contract",
        routeId: "UsersController.getUser",
      }),
    ]);
    expect(() => assertContractGraphHasNoErrors(graph)).toThrow(ContractGraphDiagnosticError);
  });

  it("should classify added routes as non-breaking and removed routes as breaking", () => {
    const BaselineController = (() => {
      @Controller("/users")
      class UsersController {
        @Get("/")
        listUsers(): void {}
      }

      return UsersController;
    })();
    const CurrentController = (() => {
      @Controller("/users")
      class UsersController {
        @Get("/")
        listUsers(): void {}

        @Post("/")
        createUser(@Body(z.object({ name: z.string() })) _body: { name: string }): void {}
      }

      return UsersController;
    })();
    const baseline = createContractGraphSnapshot(buildContractGraph([BaselineController]));
    const current = createContractGraphSnapshot(buildContractGraph([CurrentController]));

    const additiveDiff = diffContractGraphSnapshots(baseline, current);
    const removalDiff = diffContractGraphSnapshots(current, baseline);

    expect(additiveDiff.hasBreakingChanges).toBe(false);
    expect(additiveDiff.nonBreakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-route-added",
        routeId: "UsersController.createUser",
      }),
    ]);
    expect(removalDiff.hasBreakingChanges).toBe(true);
    expect(removalDiff.breakingChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "contract-route-removed",
          routeId: "UsersController.createUser",
        }),
        expect.objectContaining({
          code: "contract-operation-id-removed",
          operationId: "UsersController_createUser",
        }),
      ]),
    );
  });

  it("should classify HTTP method and path changes as breaking", () => {
    const BaselineController = (() => {
      @Controller("/users")
      class UsersController {
        @Get("/:id")
        getUser(@Param("id") _id: string): void {}
      }

      return UsersController;
    })();
    const CurrentController = (() => {
      @Controller("/users")
      class UsersController {
        @Post("/:id/details")
        getUser(@Param("id") _id: string): void {}
      }

      return UsersController;
    })();

    const diff = diffContractGraphSnapshots(
      createContractGraphSnapshot(buildContractGraph([BaselineController])),
      createContractGraphSnapshot(buildContractGraph([CurrentController])),
    );

    expect(diff.hasBreakingChanges).toBe(true);
    expect(diff.breakingChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "contract-route-method-path-changed",
          routeId: "UsersController.getUser",
        }),
      ]),
    );
  });

  it("should classify required request expansion as breaking and optional fields as non-breaking", () => {
    const BaselineController = (() => {
      @Controller("/users")
      class UsersController {
        @Post("/")
        createUser(@Body(z.object({ name: z.string() })) _body: { name: string }): void {}
      }

      return UsersController;
    })();
    const CurrentController = (() => {
      @Controller("/users")
      class UsersController {
        @Post("/")
        createUser(
          @Body(
            z.object({
              age: z.number().optional(),
              email: z.string(),
              name: z.string(),
            }),
          )
          _body: { name: string; email: string; age?: number },
        ): void {}
      }

      return UsersController;
    })();

    const diff = diffContractGraphSnapshots(
      createContractGraphSnapshot(buildContractGraph([BaselineController])),
      createContractGraphSnapshot(buildContractGraph([CurrentController])),
    );

    expect(diff.hasBreakingChanges).toBe(true);
    expect(diff.breakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-request-required-field-added",
        fieldPath: "email",
        location: "body",
      }),
    ]);
    expect(diff.nonBreakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-request-optional-field-added",
        fieldPath: "age",
        location: "body",
      }),
    ]);
  });

  it("should classify request field schema changes as breaking", () => {
    const BaselineController = (() => {
      @Controller("/users")
      class UsersController {
        @Post("/")
        createUser(
          @Body(
            z.object({
              age: z.string(),
              profile: z.object({ nickname: z.string() }),
            }),
          )
          _body: { age: string; profile: { nickname: string } },
        ): void {}
      }

      return UsersController;
    })();
    const CurrentController = (() => {
      @Controller("/users")
      class UsersController {
        @Post("/")
        createUser(
          @Body(
            z.object({
              age: z.number(),
              profile: z.object({ nickname: z.number() }),
            }),
          )
          _body: { age: number; profile: { nickname: number } },
        ): void {}
      }

      return UsersController;
    })();

    const diff = diffContractGraphSnapshots(
      createContractGraphSnapshot(buildContractGraph([BaselineController])),
      createContractGraphSnapshot(buildContractGraph([CurrentController])),
    );

    expect(diff.hasBreakingChanges).toBe(true);
    expect(diff.breakingChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "contract-request-field-schema-incompatible",
          fieldPath: "age",
          location: "body",
        }),
        expect.objectContaining({
          code: "contract-request-field-schema-incompatible",
          fieldPath: "profile.nickname",
          location: "body",
        }),
      ]),
    );
  });

  it("should classify top-level request schema changes as breaking", () => {
    const BaselineController = (() => {
      @Controller("/search")
      class SearchController {
        @Post("/")
        search(@Body(z.string()) _body: string): void {}
      }

      return SearchController;
    })();
    const CurrentController = (() => {
      @Controller("/search")
      class SearchController {
        @Post("/")
        search(@Body(z.number()) _body: number): void {}
      }

      return SearchController;
    })();

    const diff = diffContractGraphSnapshots(
      createContractGraphSnapshot(buildContractGraph([BaselineController])),
      createContractGraphSnapshot(buildContractGraph([CurrentController])),
    );

    expect(diff.hasBreakingChanges).toBe(true);
    expect(diff.breakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-request-schema-incompatible",
        location: "body",
        routeId: "SearchController.search",
      }),
    ]);
  });

  it("should classify response schema removals as incompatible", () => {
    const BaselineController = (() => {
      @Controller("/users")
      class UsersController {
        @ResponseSchema(z.object({ id: z.string(), name: z.string() }))
        @Get("/:id")
        getUser(@Param("id") _id: string): void {}
      }

      return UsersController;
    })();
    const CurrentController = (() => {
      @Controller("/users")
      class UsersController {
        @ResponseSchema(z.object({ id: z.string() }))
        @Get("/:id")
        getUser(@Param("id") _id: string): void {}
      }

      return UsersController;
    })();

    const diff = diffContractGraphSnapshots(
      createContractGraphSnapshot(buildContractGraph([BaselineController])),
      createContractGraphSnapshot(buildContractGraph([CurrentController])),
    );

    expect(diff.hasBreakingChanges).toBe(true);
    expect(diff.breakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-response-schema-incompatible",
        routeId: "UsersController.getUser",
      }),
    ]);
  });

  it("should classify added Problem response codes as breaking and removed codes as non-breaking", () => {
    const BaselineController = (() => {
      @Controller("/users")
      class UsersController {
        @Get("/:id")
        @ProblemResponse({ code: "USER_NOT_FOUND", category: ProblemCategory.NotFound })
        getUser(@Param("id") _id: string): void {}
      }

      return UsersController;
    })();
    const CurrentController = (() => {
      @Controller("/users")
      class UsersController {
        @Get("/:id")
        @ProblemResponse({ code: "USER_FORBIDDEN", category: ProblemCategory.Forbidden })
        @ProblemResponse({ code: "USER_NOT_FOUND", category: ProblemCategory.NotFound })
        getUser(@Param("id") _id: string): void {}
      }

      return UsersController;
    })();
    const baseline = createContractGraphSnapshot(buildContractGraph([BaselineController]));
    const current = createContractGraphSnapshot(buildContractGraph([CurrentController]));

    const additiveDiff = diffContractGraphSnapshots(baseline, current);
    const removalDiff = diffContractGraphSnapshots(current, baseline);

    expect(additiveDiff.hasBreakingChanges).toBe(true);
    expect(additiveDiff.breakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-problem-response-added",
        fieldPath: "USER_FORBIDDEN",
        location: "problem",
      }),
    ]);
    expect(removalDiff.hasBreakingChanges).toBe(true);
    expect(removalDiff.breakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-problem-response-removed",
        fieldPath: "USER_FORBIDDEN",
        location: "problem",
      }),
    ]);
  });

  it("should classify added entitlement requirements as breaking contract changes", () => {
    const BaselineController = (() => {
      @Controller("/reports")
      class ReportsController {
        @Get("/:id")
        getReport(@Param("id") _id: string): void {}
      }

      return ReportsController;
    })();
    const CurrentController = (() => {
      @Controller("/reports")
      class ReportsController {
        @Get("/:id")
        @RequiresEntitlement({
          feature: "reports.export",
          resource: { type: "report", idParam: "id" },
        })
        getReport(@Param("id") _id: string): void {}
      }

      return ReportsController;
    })();
    const baseline = createContractGraphSnapshot(buildContractGraph([BaselineController]));
    const current = createContractGraphSnapshot(buildContractGraph([CurrentController]));

    const additiveDiff = diffContractGraphSnapshots(baseline, current);
    const removalDiff = diffContractGraphSnapshots(current, baseline);

    expect(additiveDiff.hasBreakingChanges).toBe(true);
    expect(additiveDiff.breakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-entitlement-requirement-added",
        fieldPath: "reports.export",
      }),
    ]);
    expect(removalDiff.hasBreakingChanges).toBe(false);
    expect(removalDiff.nonBreakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-entitlement-requirement-removed",
        fieldPath: "reports.export",
      }),
    ]);
  });

  it("should dedupe repeated entitlement requirements before diffing snapshots", () => {
    const BaselineController = (() => {
      @Controller("/reports")
      class ReportsController {
        @Get("/:id")
        getReport(@Param("id") _id: string): void {}
      }

      return ReportsController;
    })();
    const CurrentController = (() => {
      @Controller("/reports")
      class ReportsController {
        @Get("/:id")
        @RequiresEntitlement({ feature: "reports.export" })
        @RequiresEntitlement({ feature: "reports.export" })
        getReport(@Param("id") _id: string): void {}
      }

      return ReportsController;
    })();
    const baseline = createContractGraphSnapshot(buildContractGraph([BaselineController]));
    const current = createContractGraphSnapshot(buildContractGraph([CurrentController]));
    const diff = diffContractGraphSnapshots(baseline, current);

    expect(
      diff.breakingChanges.filter(
        (change) => change.code === "contract-entitlement-requirement-added",
      ),
    ).toEqual([
      expect.objectContaining({
        fieldPath: "reports.export",
      }),
    ]);
  });

  it("should classify Problem category or status changes as breaking", () => {
    const BaselineController = (() => {
      @Controller("/users")
      class UsersController {
        @Get("/:id")
        @ProblemResponse({ code: "USER_NOT_FOUND", category: ProblemCategory.NotFound })
        getUser(@Param("id") _id: string): void {}
      }

      return UsersController;
    })();
    const CurrentController = (() => {
      @Controller("/users")
      class UsersController {
        @Get("/:id")
        @ProblemResponse({ code: "USER_NOT_FOUND", category: ProblemCategory.Forbidden })
        getUser(@Param("id") _id: string): void {}
      }

      return UsersController;
    })();

    const diff = diffContractGraphSnapshots(
      createContractGraphSnapshot(buildContractGraph([BaselineController])),
      createContractGraphSnapshot(buildContractGraph([CurrentController])),
    );

    expect(diff.breakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-problem-response-classification-changed",
        fieldPath: "USER_NOT_FOUND",
        location: "problem",
      }),
    ]);
  });

  it("should classify nullable response expansions as incompatible", () => {
    const BaselineController = (() => {
      @Controller("/users")
      class UsersController {
        @ResponseSchema(z.object({ name: z.string() }))
        @Get("/:id")
        getUser(@Param("id") _id: string): void {}
      }

      return UsersController;
    })();
    const CurrentController = (() => {
      @Controller("/users")
      class UsersController {
        @ResponseSchema(z.object({ name: z.string().nullable() }))
        @Get("/:id")
        getUser(@Param("id") _id: string): void {}
      }

      return UsersController;
    })();

    const diff = diffContractGraphSnapshots(
      createContractGraphSnapshot(buildContractGraph([BaselineController])),
      createContractGraphSnapshot(buildContractGraph([CurrentController])),
    );

    expect(diff.hasBreakingChanges).toBe(true);
    expect(diff.breakingChanges).toEqual([
      expect.objectContaining({
        code: "contract-response-schema-incompatible",
        routeId: "UsersController.getUser",
      }),
    ]);
  });
});

function attachRouteContract(
  controller: Function,
  methodName: string,
  contract: NonNullable<RouteMetadata["contract"]>,
): void {
  const routes = Reflect.getMetadata(REST_ROUTES_KEY, controller) as RouteMetadata[];

  Reflect.defineMetadata(
    REST_ROUTES_KEY,
    routes.map((route) => (route.methodName === methodName ? { ...route, contract } : route)),
    controller,
  );
}

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

  it.each([true, false])(
    "identifies extra wrapped path schema fields without inventing bindings (route contract: %s)",
    (withRouteContract) => {
      const schema = z
        .object({ id: z.string(), extra: z.string().optional() })
        .transform((value) => ({ renamed: value.id }));
      const ControllerClass = createController(schema, schema, "path");
      if (!withRouteContract) {
        const routes = Reflect.getMetadata(REST_ROUTES_KEY, ControllerClass) as RouteMetadata[];
        Reflect.defineMetadata(
          REST_ROUTES_KEY,
          routes.map(({ contract: _contract, ...route }) => route),
          ControllerClass,
        );
      }

      const graph = buildContractGraph([ControllerClass]);
      const diagnostics = graph.diagnostics.filter(
        ({ code }) => code === "contract-route-unbound-path-param",
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.message).toBe(
        "Contract params schema field 'extra' is not present in route path '/users/:id'.",
      );
      expect(graph.diagnostics.some(({ message }) => message.includes('@Param("extra")'))).toBe(
        false,
      );
    },
  );

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
});
