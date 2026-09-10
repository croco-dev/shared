import "reflect-metadata";
import { Problem, ProblemCategory } from "@croco/problems-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractRouteIR } from "../libs/extractRouteIR";
import {
  REST_PARAMS_KEY,
  REST_ROUTES_KEY,
  type ParamMetadata,
  type RouteMetadata,
} from "../libs/sharedTypes";
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  ProblemResponse,
  Query,
  Raw,
} from "./helpers/test-decorators";

const RESPONSE_SCHEMA_KEY = Symbol.for("croco:rest:responseSchema");

class UserNotFoundProblem extends Problem {
  constructor() {
    super("USER_NOT_FOUND", ProblemCategory.NotFound, "User not found");
  }
}

function ResponseSchema(schema: z.ZodType): MethodDecorator {
  return (target, propertyKey) => {
    const ctor = target.constructor;

    Reflect.defineMetadata(RESPONSE_SCHEMA_KEY, schema, ctor, propertyKey);
  };
}

describe("extractRouteIR", () => {
  it("should extract a GET route with a path param", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(@Param("id") _id: string): void {}
    }

    const routes = extractRouteIR(UsersController);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      controllerName: "UsersController",
      methodName: "getUser",
      httpMethod: "GET",
      path: "/users/:id",
      domain: null,
      inputSchema: null,
      outputSchema: null,
    });
    expect(routes[0]?.params).toEqual([{ index: 0, kind: "path", name: "id", schema: null }]);
  });

  it("should extract a POST route with body schema as input schema", () => {
    const createOrderSchema = z.object({ productId: z.string() });

    @Controller("/orders")
    class OrdersController {
      @Post("/")
      createOrder(@Body(createOrderSchema) _body: z.infer<typeof createOrderSchema>): void {}
    }

    const routes = extractRouteIR(OrdersController);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      controllerName: "OrdersController",
      methodName: "createOrder",
      httpMethod: "POST",
      path: "/orders",
      domain: null,
      outputSchema: null,
    });
    expect(routes[0]?.inputSchema).toBe(createOrderSchema);
    expect(routes[0]?.params).toEqual([
      { index: 0, kind: "body", name: "", schema: createOrderSchema },
    ]);
  });

  it("should preserve raw parameter positions as context parameters", () => {
    const createOrderSchema = z.object({ productId: z.string() });

    @Controller("/orders")
    class OrdersController {
      @Post("/")
      createOrder(
        @Raw() _raw: unknown,
        @Body(createOrderSchema) _body: z.infer<typeof createOrderSchema>,
      ): void {}
    }

    const paramsMap = Reflect.getMetadata(REST_PARAMS_KEY, OrdersController) as Map<
      string | symbol,
      ParamMetadata[]
    >;
    const originalParams = paramsMap.get("createOrder");
    expect(originalParams?.map((param) => param.index)).toEqual([1, 0]);

    const route = extractRouteIR(OrdersController)[0];

    expect(route?.params).toEqual([
      { index: 0, kind: "ctx", name: "", schema: null },
      { index: 1, kind: "body", name: "", schema: createOrderSchema },
    ]);
    expect(route?.inputSchemas.body).toBe(createOrderSchema);
    expect(originalParams?.map((param) => param.index)).toEqual([1, 0]);
  });

  it("should preserve the declared successful response status", () => {
    @Controller("/orders")
    class OrdersController {
      @Post("/")
      createOrder(): void {}
    }
    const metadata = Reflect.getMetadata(REST_ROUTES_KEY, OrdersController) as RouteMetadata[];
    const first = metadata[0];
    if (!first) throw new TypeError("Expected route metadata.");
    first.statusCode = 201;

    expect(extractRouteIR(OrdersController)[0]?.successStatus).toBe(201);
  });

  it("should set inputSchemas.body for a POST route with a body schema", () => {
    const createUserSchema = z.object({ name: z.string() });

    @Controller("/users")
    class UsersController {
      @Post("/")
      createUser(@Body(createUserSchema) _body: z.infer<typeof createUserSchema>): void {}
    }

    const routes = extractRouteIR(UsersController);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.inputSchemas.body).toBe(createUserSchema);
    expect(routes[0]?.inputSchemas.path).toBeNull();
    expect(routes[0]?.inputSchemas.query).toBeNull();
    expect(routes[0]?.inputSchema).toBe(createUserSchema);
  });

  it("should set inputSchemas.path with default string schema for a path param without explicit schema", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(@Param("id") _id: string): void {}
    }

    const routes = extractRouteIR(UsersController);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.inputSchemas.body).toBeNull();
    expect(routes[0]?.inputSchemas.path).toBeTruthy();
    expect((routes[0]?.inputSchemas.path as z.AnyZodObject).shape).toHaveProperty("id");
    expect((routes[0]?.inputSchemas.path as z.AnyZodObject).shape.id).toBeInstanceOf(z.ZodString);
    expect(routes[0]?.inputSchemas.query).toBeNull();
    expect(routes[0]?.inputSchemas.headers).toBeNull();
    expect(routes[0]?.params).toEqual([{ index: 0, kind: "path", name: "id", schema: null }]);
  });

  it("should extract path and query params for a route", () => {
    @Controller("/items")
    class ItemsController {
      @Get("/:id")
      getItem(@Param("id") _id: string, @Query("filter") _filter: string): void {}
    }

    const routes = extractRouteIR(ItemsController);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.params).toHaveLength(2);
    expect(routes[0]?.params).toEqual([
      { index: 0, kind: "path", name: "id", schema: null },
      { index: 1, kind: "query", name: "filter", schema: null },
    ]);
    expect((routes[0]?.inputSchemas.query as z.AnyZodObject).shape.filter.isOptional()).toBe(true);
  });

  it("should set inputSchemas for body, path, and query params", () => {
    const updateItemSchema = z.object({ name: z.string() });

    @Controller("/items")
    class ItemsController {
      @Post("/:id")
      updateItem(
        @Body(updateItemSchema) _body: z.infer<typeof updateItemSchema>,
        @Param("id", z.string()) _id: string,
        @Query("filter", z.string()) _filter: string,
      ): void {}
    }

    const routes = extractRouteIR(ItemsController);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.inputSchemas.body).toBe(updateItemSchema);
    expect(routes[0]?.inputSchemas.path).toBeTruthy();
    expect((routes[0]?.inputSchemas.path as z.AnyZodObject).shape.id).toBeInstanceOf(z.ZodString);
    expect(routes[0]?.inputSchemas.query).toBeTruthy();
    expect((routes[0]?.inputSchemas.query as z.AnyZodObject).shape.filter).toBeInstanceOf(
      z.ZodString,
    );
    expect(routes[0]?.inputSchema).toBe(updateItemSchema);
  });

  it("should set inputSchemas.headers with optional fallback schema for schema-less header params", () => {
    @Controller("/users")
    class UsersController {
      @Get("/")
      listUsers(@Header("x-tenant-id") _tenantId: string): void {}
    }

    const routes = extractRouteIR(UsersController);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.inputSchemas.body).toBeNull();
    expect(routes[0]?.inputSchemas.path).toBeNull();
    expect(routes[0]?.inputSchemas.query).toBeNull();
    expect(routes[0]?.inputSchemas.headers).toBeTruthy();
    expect(
      (routes[0]?.inputSchemas.headers as z.AnyZodObject).shape["x-tenant-id"].isOptional(),
    ).toBe(true);
    expect(routes[0]?.params).toEqual([
      { index: 0, kind: "header", name: "x-tenant-id", schema: null },
    ]);
  });

  it("should extract outputSchema from response schema metadata", () => {
    const userSchema = z.object({ id: z.string() });

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ResponseSchema(userSchema)
      getUser(@Param("id") _id: string): void {}
    }

    const routes = extractRouteIR(UsersController);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.outputSchema).toBe(userSchema);
  });

  it.each([
    ["/api/v1", "/users", "/api/v1/users"],
    ["", "/users", "/users"],
    ["/", "/users", "/users"],
    ["/api/v1/", "users/", "/api/v1/users"],
    ["/api/v1", "/", "/api/v1"],
    ["", "", "/"],
    ["/api/v1", "/api/v1/users", "/api/v1/users"],
    ["/api/v1/", "/api/v1/users/", "/api/v1/users"],
    ["/api/v1", "/api/v1", "/api/v1"],
    ["/api/v1", "/api/v10/users", "/api/v1/api/v10/users"],
  ])("should resolve controller %s and contract %s to %s", (prefix, path, expected) => {
    @Controller(prefix)
    class UsersController {
      @Get("/decorator-path")
      listUsers(): void {}
    }

    attachRouteContract(UsersController, "listUsers", { method: "GET", path });

    expect(extractRouteIR(UsersController)[0]?.path).toBe(expected);
  });

  it("should extract path, input, and output schemas from route contract metadata", () => {
    const userIdSchema = z.string().uuid();
    const includePostsSchema = z.boolean().optional();
    const tenantIdSchema = z.string().uuid();
    const paramsSchema = z.object({ id: userIdSchema });
    const querySchema = z.object({ includePosts: includePostsSchema });
    const userSchema = z.object({ id: z.string(), name: z.string() });

    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(
        @Param("id", userIdSchema) _id: string,
        @Query("includePosts", includePostsSchema) _includePosts: boolean | undefined,
        @Header("x-tenant-id", tenantIdSchema) _tenantId: string,
      ): void {}
    }

    attachRouteContract(UsersController, "getUser", {
      id: "users.get",
      method: "GET",
      path: "/users/:id",
      operationId: "getUser",
      sourceLocation: { path: "src/controllers/UserController.ts", line: 12 },
      params: paramsSchema,
      query: querySchema,
      response: userSchema,
    });

    const routes = extractRouteIR(UsersController);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: "/users/:id",
      routeContract: {
        id: "users.get",
        method: "GET",
        path: "/users/:id",
        operationId: "getUser",
        sourceLocation: { path: "src/controllers/UserController.ts", line: 12 },
        problemResponsesDeclared: false,
      },
    });
    expect(routes[0]?.inputSchemas.path).toBe(paramsSchema);
    expect(routes[0]?.inputSchemas.query).toBe(querySchema);
    expect((routes[0]?.inputSchemas.headers as z.AnyZodObject).shape["x-tenant-id"]).toBe(
      tenantIdSchema,
    );
    expect(routes[0]?.outputSchema).toBe(userSchema);
    expect(routes[0]?.params).toEqual([
      { index: 0, kind: "path", name: "id", schema: userIdSchema },
      { index: 1, kind: "query", name: "includePosts", schema: includePostsSchema },
      { index: 2, kind: "header", name: "x-tenant-id", schema: tenantIdSchema },
    ]);
  });

  it.each(["response-only", "body", "params", "query", "all"] as const)(
    "should preserve decorator inputs and prefer declared contract schemas for %s contracts",
    (declaredInput) => {
      const bodySchema = z.object({ name: z.string().min(1) });
      const idSchema = z.string().uuid();
      const filterSchema = z.string().min(1);
      const headerSchema = z.string().min(1);
      const responseSchema = z.object({ id: z.string() });
      const contractBody = z.object({ title: z.string() });
      const contractParams = z.object({ id: z.number() });
      const contractQuery = z.object({ filter: z.boolean() });
      const contract = {
        method: "POST" as const,
        path: "/users/:id",
        response: responseSchema,
        ...(declaredInput === "body" || declaredInput === "all" ? { body: contractBody } : {}),
        ...(declaredInput === "params" || declaredInput === "all"
          ? { params: contractParams }
          : {}),
        ...(declaredInput === "query" || declaredInput === "all" ? { query: contractQuery } : {}),
      };

      @Controller("/users")
      class UsersController {
        @Post("/:id")
        updateUser(
          @Body(bodySchema) _body: unknown,
          @Param("id", idSchema) _id: string,
          @Query("filter", filterSchema) _filter: string,
          @Header("x-tenant-id", headerSchema) _tenantId: string,
        ): void {}
      }

      const decoratorRoute = extractRouteIR(UsersController)[0];
      attachRouteContract(UsersController, "updateUser", contract);
      const route = extractRouteIR(UsersController)[0];

      expect(route?.inputSchemas.body).toBe(contract.body ?? bodySchema);
      expect(route?.inputSchema).toBe(route?.inputSchemas.body);
      if (contract.params) {
        expect(route?.inputSchemas.path).toBe(contract.params);
      } else {
        expect((route?.inputSchemas.path as z.AnyZodObject).shape.id).toBe(idSchema);
        expect(route?.inputSchemas.path?.safeParse({ id: "invalid" }).success).toBe(false);
      }
      if (contract.query) {
        expect(route?.inputSchemas.query).toBe(contract.query);
      } else {
        expect((route?.inputSchemas.query as z.AnyZodObject).shape.filter).toBe(filterSchema);
        expect(route?.inputSchemas.query?.safeParse({ filter: "" }).success).toBe(false);
      }
      expect((route?.inputSchemas.headers as z.AnyZodObject).shape["x-tenant-id"]).toBe(
        headerSchema,
      );
      expect(route?.params).toEqual(decoratorRoute?.params);
      expect(route?.outputSchema).toBe(responseSchema);
      expect(route?.routeContract?.inputSchemas).toEqual({
        body: contract.body ?? null,
        path: contract.params ?? null,
        query: contract.query ?? null,
        headers: null,
      });
    },
  );

  it("should keep absent inputs null for a response-only contract without parameters", () => {
    @Controller("/users")
    class UsersController {
      @Get("/")
      listUsers(): void {}
    }
    attachRouteContract(UsersController, "listUsers", {
      method: "GET",
      path: "/users",
      response: z.array(z.string()),
    });

    const route = extractRouteIR(UsersController)[0];

    expect(route?.inputSchema).toBeNull();
    expect(route?.inputSchemas).toEqual({ body: null, path: null, query: null, headers: null });
  });

  it("should extract route contract Problem responses from contract metadata", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(@Param("id") _id: string): void {}
    }

    attachRouteContract(UsersController, "getUser", {
      method: "GET",
      path: "/users/:id",
      problems: [
        {
          code: "USER_NOT_FOUND",
          category: ProblemCategory.NotFound,
          description: "The requested user does not exist.",
        },
      ],
    });

    const routes = extractRouteIR(UsersController);

    expect(routes[0]?.routeContract?.problemResponses).toEqual([
      {
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
        cookbookPath: "/reference/problem-recovery-cookbook/#user-not-found",
        description: "The requested user does not exist.",
        status: 404,
      },
    ]);
    expect(routes[0]?.routeContract?.problemResponsesDeclared).toBe(true);
  });

  it("should extract route contract Problem responses from Problem constructors", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(@Param("id") _id: string): void {}
    }

    attachRouteContract(UsersController, "getUser", {
      method: "GET",
      path: "/users/:id",
      problems: [UserNotFoundProblem],
    });

    const routes = extractRouteIR(UsersController);

    expect(routes[0]?.routeContract?.problemResponses).toEqual([
      {
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
        cookbookPath: "/reference/problem-recovery-cookbook/#user-not-found",
        status: 404,
      },
    ]);
    expect(routes[0]?.routeContract?.problemResponsesDeclared).toBe(true);
  });

  it("should preserve explicit empty route contract Problem declarations", () => {
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

    const routes = extractRouteIR(UsersController);

    expect(routes[0]?.routeContract?.problemResponses).toEqual([]);
    expect(routes[0]?.routeContract?.problemResponsesDeclared).toBe(true);
  });

  it("should set outputSchema to null when response schema metadata is missing", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      getUser(@Param("id") _id: string): void {}
    }

    const routes = extractRouteIR(UsersController);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.outputSchema).toBeNull();
  });

  it("should extract declared Problem responses with explicit HTTP status", () => {
    @Controller("/users")
    class UsersController {
      @Get("/:id")
      @ProblemResponse({
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
        description: "The user id does not exist.",
        status: 500,
      })
      getUser(@Param("id") _id: string): void {}
    }

    const routes = extractRouteIR(UsersController);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.problemResponses).toEqual([
      {
        code: "USER_NOT_FOUND",
        category: ProblemCategory.NotFound,
        cookbookPath: "/reference/problem-recovery-cookbook/#user-not-found",
        description: "The user id does not exist.",
        status: 500,
      },
    ]);
  });

  it("should return an empty array for a class without route metadata", () => {
    class PlainClass {}

    expect(extractRouteIR(PlainClass)).toEqual([]);
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
