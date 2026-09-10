import { Problem, ProblemCategory } from "@croco/problems-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  All,
  Body,
  Delete,
  defineRouteContract,
  defineRouteProblem,
  Get,
  Head,
  HttpMethod,
  Options,
  Param,
  Patch,
  Post,
  ProblemResponse,
  Put,
  Query,
  ResponseSchema,
  type RouteBody,
  type RouteClientBody,
  type RouteClientPathParams,
  type RouteClientQuery,
  type RouteClientRequest,
  type RouteClientResponse,
  type RouteContractHandler,
  type RouteContractRequest,
  type RouteContractResult,
  type RouteContractSpec,
  type RouteHandler,
  type RouteHandlerBody,
  type RouteHandlerPathParams,
  type RouteHandlerQuery,
  type RouteHandlerRequest,
  type RouteHandlerReturn,
  type RouteMethodReturn,
  type RouteParam,
  type RoutePathParamName,
  type RoutePathParams,
  type RouteProblem,
  type RouteQuery,
  type RouteQueryParam,
  type RouteResponse,
  type RouteWireResponse,
  routeParam,
  routeParamSchema,
  routeProblemResponses,
  routeQueryParam,
  routeQueryParamSchema,
  routeQuerySchema,
  routeResponseSchema,
  validateResponse,
} from "../index";

/* oxlint-disable import/no-duplicates */
// @ts-expect-error TypedRouteConfig was removed because it had no owning runtime path.
import type { TypedRouteConfig as RemovedTypedRouteConfig } from "../index";
// @ts-expect-error InferRouteRequest was coupled to the removed TypedRouteConfig surface.
import type { InferRouteRequest as RemovedInferRouteRequest } from "../index";
// @ts-expect-error InferRouteResponse was coupled to the removed TypedRouteConfig surface.
import type { InferRouteResponse as RemovedInferRouteResponse } from "../index";
// @ts-expect-error TypedRouteHandler was coupled to the removed TypedRouteConfig surface.
import type { TypedRouteHandler as RemovedTypedRouteHandler } from "../index";
// @ts-expect-error ApiEndpoint duplicated the removed route configuration surface.
import type { ApiEndpoint as RemovedApiEndpoint } from "../index";
// @ts-expect-error EndpointRequest was coupled to the removed ApiEndpoint surface.
import type { EndpointRequest as RemovedEndpointRequest } from "../index";
// @ts-expect-error EndpointResponse was coupled to the removed ApiEndpoint surface.
import type { EndpointResponse as RemovedEndpointResponse } from "../index";
/* oxlint-enable import/no-duplicates */

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const createUserSchema = z.object({
  name: z.string(),
});

const userQuerySchema = z.object({
  includePosts: z.boolean().optional(),
});

const contractParameterTypes = defineRouteContract({
  method: HttpMethod.POST,
  path: "/typed/:id",
  params: z.object({
    id: z.string().brand<"UserId">(),
  }),
  query: z.object({
    anyOutput: z.any(),
    defaulted: z.string().default("default"),
    neverOutput: z.never(),
    nullable: z.string().nullable(),
    optional: z.string().optional(),
    page: z.coerce.number().int(),
    preprocessed: z.preprocess((value) => String(value), z.string()),
    transformed: z.string().transform((value) => value.length),
    union: z.union([z.string(), z.number()]),
    unknownOutput: z.unknown(),
  }),
  body: z
    .object({ name: z.string() })
    .transform((value) => ({ ...value, normalized: true as const })),
});

const otherBrand = z.string().brand<"OtherId">();

const lifecycleContract = defineRouteContract({
  method: HttpMethod.POST,
  path: "/lifecycle/:id",
  params: z.object({
    id: z.string().brand<"UserId">(),
  }),
  query: z.object({
    caught: z.string().catch("fallback"),
    coerced: z.coerce.number(),
    defaulted: z.string().default("default"),
    nullable: z.string().nullable(),
    optional: z.string().optional(),
    preprocessed: z.preprocess((value) => String(value), z.string()),
    transformed: z.string().transform((value) => value.length),
  }),
  body: z
    .object({ name: z.string() })
    .transform(({ name }) => ({ normalizedName: name.toUpperCase() })),
  response: z.string().transform((value) => value.length),
});

class UserNotFoundProblem extends Problem {
  constructor(id: string) {
    super("users/not-found", ProblemCategory.NotFound, `User '${id}' was not found.`);
  }
}

class UserForbiddenProblem extends Problem {
  readonly code = "USER_FORBIDDEN";
  readonly category = ProblemCategory.Forbidden;

  constructor() {
    super("USER_FORBIDDEN", ProblemCategory.Forbidden);
  }
}

describe("route contract types", () => {
  const getUserContract = defineRouteContract({
    id: "users.get",
    method: HttpMethod.GET,
    path: "/users/:id",
    operationId: "getUser",
    sourceLocation: { path: "src/controllers/UserController.ts", line: 12 },
    params: z.object({ id: z.string() }),
    query: userQuerySchema,
    response: userSchema,
    problems: [UserNotFoundProblem],
  });

  const createUserContract = defineRouteContract({
    id: "users.create",
    method: HttpMethod.POST,
    path: "/users",
    body: createUserSchema,
    response: userSchema,
  });

  const listUsersContract = defineRouteContract({
    id: "users.list",
    method: HttpMethod.GET,
    path: "/users",
    response: z.array(userSchema),
  });

  const updateUserContract = defineRouteContract({
    method: HttpMethod.POST,
    path: "/users/:id",
    params: z.object({ id: z.string() }),
    response: userSchema,
    problems: [
      defineRouteProblem(UserForbiddenProblem, {
        code: "USER_FORBIDDEN",
        category: ProblemCategory.Forbidden,
      }),
    ],
  });

  it("connects route schemas to controller decorator migration helpers", () => {
    class UsersController {
      @Get(getUserContract)
      getUser(
        @Param(getUserContract, "id") id: RouteParam<typeof getUserContract, "id">,
        @Query(getUserContract, "includePosts")
        includePosts: RouteQueryParam<typeof getUserContract, "includePosts">,
      ): RouteMethodReturn<typeof getUserContract> {
        return { id, name: includePosts ? "Ada Lovelace" : "Ada" };
      }

      @Post(createUserContract)
      @ResponseSchema(createUserContract)
      createUser(
        @Body(createUserContract) body: RouteBody<typeof createUserContract>,
      ): RouteMethodReturn<typeof createUserContract> {
        return { id: "user_1", name: body.name };
      }
    }

    expect(new UsersController().getUser("user_1", true)).toEqual({
      id: "user_1",
      name: "Ada Lovelace",
    });
    expect(routeParamSchema(getUserContract, "id")).toBe(getUserContract.params.shape.id);
    expect(routeQueryParam(getUserContract, "includePosts")).toBe("includePosts");
    expect(routeQuerySchema(getUserContract)).toBe(userQuerySchema);
    expect(routeResponseSchema(getUserContract)).toBe(userSchema);
  });

  it("infers request, response, and Problem types from route contracts", async () => {
    expectTypeOf<RoutePathParamName<typeof getUserContract.path>>().toEqualTypeOf<"id">();
    expectTypeOf<RouteParam<typeof getUserContract, "id">>().toEqualTypeOf<string>();
    expectTypeOf<RouteQuery<typeof getUserContract>>().toEqualTypeOf<{
      includePosts?: boolean | undefined;
    }>();
    expectTypeOf<RouteBody<typeof createUserContract>>().toEqualTypeOf<{
      name: string;
    }>();
    expectTypeOf<RouteResponse<typeof listUsersContract>>().toEqualTypeOf<
      {
        id: string;
        name: string;
      }[]
    >();
    expectTypeOf<RouteResponse<typeof getUserContract>>().toEqualTypeOf<{
      id: string;
      name: string;
    }>();
    expectTypeOf<RouteProblem<typeof getUserContract>>().toEqualTypeOf<UserNotFoundProblem>();
    expectTypeOf<RouteProblem<typeof updateUserContract>>().toEqualTypeOf<UserForbiddenProblem>();
    expectTypeOf(routeProblemResponses(updateUserContract)[0]?.status).toEqualTypeOf<403>();
    expectTypeOf<RoutePathParams<typeof getUserContract>>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<RouteContractRequest<typeof createUserContract>["body"]>().toEqualTypeOf<{
      name: string;
    }>();
    expectTypeOf<RouteContractRequest<typeof createUserContract>["params"]>().toEqualTypeOf<
      RoutePathParams<typeof createUserContract>
    >();
    expectTypeOf<RouteContractResult<typeof createUserContract>>().toEqualTypeOf<
      { id: string; name: string } | Promise<{ id: string; name: string }>
    >();

    const routeHandler: RouteHandler<{ id: string }, { found: boolean }> = ({ id }) => ({
      found: id.length > 0,
    });
    const contractSpec: RouteContractSpec = getUserContract;

    expect(routeHandler({ id: "user_1" })).toEqual({ found: true });
    expect(contractSpec.path).toBe("/users/:id");

    const handler: RouteContractHandler<typeof createUserContract> = async ({ body }) => ({
      id: "user_1",
      name: body.name,
    });

    await expect(handler({ body: { name: "Ada" }, params: {}, query: {} })).resolves.toEqual({
      id: "user_1",
      name: "Ada",
    });
  });
});

describe("route contract lifecycle types", () => {
  it("separates client request inputs from parsed handler inputs", () => {
    expectTypeOf<RouteClientPathParams<typeof lifecycleContract>["id"]>().toEqualTypeOf<string>();
    expectTypeOf<RouteHandlerPathParams<typeof lifecycleContract>["id"]>().toEqualTypeOf<
      z.output<typeof lifecycleContract.params.shape.id>
    >();
    expectTypeOf<RouteClientQuery<typeof lifecycleContract>["coerced"]>().toEqualTypeOf<number>();
    expectTypeOf<RouteHandlerQuery<typeof lifecycleContract>["coerced"]>().toEqualTypeOf<number>();
    expectTypeOf<RouteClientQuery<typeof lifecycleContract>["defaulted"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<
      RouteHandlerQuery<typeof lifecycleContract>["defaulted"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      RouteClientQuery<typeof lifecycleContract>["transformed"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      RouteHandlerQuery<typeof lifecycleContract>["transformed"]
    >().toEqualTypeOf<number>();
    expectTypeOf<
      RouteClientQuery<typeof lifecycleContract>["preprocessed"]
    >().toEqualTypeOf<unknown>();
    expectTypeOf<
      RouteHandlerQuery<typeof lifecycleContract>["preprocessed"]
    >().toEqualTypeOf<string>();
    expectTypeOf<RouteClientQuery<typeof lifecycleContract>["optional"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<RouteHandlerQuery<typeof lifecycleContract>["optional"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<RouteClientQuery<typeof lifecycleContract>["nullable"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<RouteHandlerQuery<typeof lifecycleContract>["nullable"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<RouteClientQuery<typeof lifecycleContract>["caught"]>().toEqualTypeOf<unknown>();
    expectTypeOf<RouteHandlerQuery<typeof lifecycleContract>["caught"]>().toEqualTypeOf<string>();
    expectTypeOf<RouteClientBody<typeof lifecycleContract>>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<RouteHandlerBody<typeof lifecycleContract>>().toEqualTypeOf<{
      normalizedName: string;
    }>();

    const clientRequest: RouteClientRequest<typeof lifecycleContract> = {
      params: { id: "user_1" },
      query: {
        caught: 42,
        coerced: 42,
        nullable: null,
        preprocessed: 7,
        transformed: "Ada",
      },
      body: { name: "Ada" },
    };
    const handlerRequest: RouteHandlerRequest<typeof lifecycleContract> = {
      params: lifecycleContract.params.parse(clientRequest.params),
      query: lifecycleContract.query.parse(clientRequest.query),
      body: lifecycleContract.body.parse(clientRequest.body),
    };

    expect(handlerRequest).toEqual({
      params: { id: "user_1" },
      query: {
        caught: "fallback",
        coerced: 42,
        defaulted: "default",
        nullable: null,
        preprocessed: "7",
        transformed: 3,
      },
      body: { normalizedName: "ADA" },
    });
    expect(lifecycleContract.query.parse({ ...clientRequest.query, coerced: "42" }).coerced).toBe(
      42,
    );

    expectTypeOf<RouteContractRequest<typeof lifecycleContract>>().toEqualTypeOf<
      RouteHandlerRequest<typeof lifecycleContract>
    >();
    expectTypeOf<RoutePathParams<typeof lifecycleContract>>().toEqualTypeOf<
      RouteHandlerPathParams<typeof lifecycleContract>
    >();
    expectTypeOf<RouteQuery<typeof lifecycleContract>>().toEqualTypeOf<
      RouteHandlerQuery<typeof lifecycleContract>
    >();
    expectTypeOf<RouteBody<typeof lifecycleContract>>().toEqualTypeOf<
      RouteHandlerBody<typeof lifecycleContract>
    >();

    const transformedQuerySchema = routeQueryParamSchema(lifecycleContract, "transformed");
    const brandedPathSchema = routeParamSchema(lifecycleContract, "id");
    expectTypeOf<z.input<typeof transformedQuerySchema>>().toEqualTypeOf<string>();
    expectTypeOf<z.output<typeof transformedQuerySchema>>().toEqualTypeOf<number>();
    expectTypeOf<z.input<typeof brandedPathSchema>>().toEqualTypeOf<string>();
    expectTypeOf<z.output<typeof brandedPathSchema>>().toEqualTypeOf<
      z.output<typeof lifecycleContract.params.shape.id>
    >();
  });

  it("separates handler response inputs from wire and client outputs", () => {
    expectTypeOf<RouteHandlerReturn<typeof lifecycleContract>>().toEqualTypeOf<string>();
    expectTypeOf<RouteWireResponse<typeof lifecycleContract>>().toEqualTypeOf<number>();
    expectTypeOf<RouteClientResponse<typeof lifecycleContract>>().toEqualTypeOf<number>();
    expectTypeOf<RouteResponse<typeof lifecycleContract>>().toEqualTypeOf<number>();
    expectTypeOf<RouteContractResult<typeof lifecycleContract>>().toEqualTypeOf<
      string | Promise<string>
    >();
    expectTypeOf<RouteMethodReturn<typeof lifecycleContract>>().toEqualTypeOf<
      string | Promise<string>
    >();

    const handlerReturn: RouteHandlerReturn<typeof lifecycleContract> = "Ada";
    const wireResponse: RouteWireResponse<typeof lifecycleContract> = validateResponse(
      lifecycleContract.response,
      handlerReturn,
    );

    expect(wireResponse).toBe(3);
  });
});

// @ts-expect-error transform client inputs use the schema's pre-transform string type.
const invalidLifecycleClientTransform: RouteClientQuery<typeof lifecycleContract>["transformed"] =
  3;

// @ts-expect-error handler inputs use the coerced number output.
const invalidLifecycleHandlerCoerce: RouteHandlerQuery<typeof lifecycleContract>["coerced"] = "42";

const invalidLifecycleHandlerBrand: RouteHandlerPathParams<typeof lifecycleContract> = {
  // @ts-expect-error handler path params retain the schema brand.
  id: "user_1",
};

// @ts-expect-error defaulted handler inputs cannot omit the parsed default value.
const invalidLifecycleHandlerDefault: RouteHandlerQuery<typeof lifecycleContract>["defaulted"] =
  undefined;

// @ts-expect-error preprocessed handler inputs use the parsed string output.
const invalidLifecycleHandlerPreprocess: RouteHandlerQuery<
  typeof lifecycleContract
>["preprocessed"] = 7;

// @ts-expect-error optional handler inputs accept strings or undefined, not numbers.
const invalidLifecycleHandlerOptional: RouteHandlerQuery<typeof lifecycleContract>["optional"] = 7;

// @ts-expect-error nullable handler inputs accept strings or null, not undefined.
const invalidLifecycleHandlerNullable: RouteHandlerQuery<typeof lifecycleContract>["nullable"] =
  undefined;

// @ts-expect-error caught handler inputs use the parsed fallback-compatible string output.
const invalidLifecycleHandlerCatch: RouteHandlerQuery<typeof lifecycleContract>["caught"] = 7;

// @ts-expect-error handler return values use the response schema's pre-transform input.
const invalidLifecycleHandlerReturn: RouteHandlerReturn<typeof lifecycleContract> = 3;

// @ts-expect-error wire responses use the response schema's transformed output.
const invalidLifecycleWireResponse: RouteWireResponse<typeof lifecycleContract> = "Ada";

void [
  invalidLifecycleClientTransform,
  invalidLifecycleHandlerCoerce,
  invalidLifecycleHandlerBrand,
  invalidLifecycleHandlerDefault,
  invalidLifecycleHandlerPreprocess,
  invalidLifecycleHandlerOptional,
  invalidLifecycleHandlerNullable,
  invalidLifecycleHandlerCatch,
  invalidLifecycleHandlerReturn,
  invalidLifecycleWireResponse,
];

// @ts-expect-error route path declares id, not userId.
defineRouteContract({
  method: HttpMethod.GET,
  path: "/users/:id",
  params: z.object({ userId: z.string() }),
});

// @ts-expect-error params schema declares id, but the route path has no path parameters.
defineRouteContract({
  method: HttpMethod.GET,
  path: "/users",
  params: z.object({ id: z.string() }),
});

const unionParamsSchema =
  Math.random() > 0.5 ? z.object({ id: z.string() }) : z.object({ userId: z.string() });

// @ts-expect-error union params schemas still expose extra path params on paramless routes.
defineRouteContract({
  method: HttpMethod.GET,
  path: "/users",
  params: unionParamsSchema,
});

const responseContract = defineRouteContract({
  method: HttpMethod.GET,
  path: "/users/:id",
  params: z.object({ id: z.string() }),
  response: userSchema,
});

const postContractForNegativeTest = defineRouteContract({
  method: HttpMethod.POST,
  path: "/users",
  body: createUserSchema,
  response: userSchema,
});

const transformedResponseContract = defineRouteContract({
  method: HttpMethod.GET,
  path: "/transformed-response",
  response: z.string().transform((value) => value.length),
});

const responseLessContract = defineRouteContract({
  method: HttpMethod.GET,
  path: "/response-less",
});

const selectResponseContract: boolean = true;
const mixedResponseContract = selectResponseContract ? responseContract : responseLessContract;
const responseContractUnion = selectResponseContract
  ? defineRouteContract({
      method: HttpMethod.GET,
      path: "/union-id",
      response: z.object({ id: z.string() }),
    })
  : defineRouteContract({
      method: HttpMethod.GET,
      path: "/union-name",
      response: z.object({ name: z.string() }),
    });
const schemaUnionResponseContract = defineRouteContract({
  method: HttpMethod.GET,
  path: "/schema-union",
  response: z.union([z.string(), z.number()]),
});

class NominalResponse {
  readonly #brand = true;

  constructor(readonly value: string) {}

  isNominal(): boolean {
    return this.#brand;
  }
}

const nominalResponseContract = defineRouteContract({
  method: HttpMethod.GET,
  path: "/nominal-response",
  response: z.instanceof(NominalResponse),
});
const nominalArrayResponseContract = defineRouteContract({
  method: HttpMethod.GET,
  path: "/nominal-array-response",
  response: z.array(z.instanceof(NominalResponse)),
});

const responseContractsByMethod = {
  all: defineRouteContract({ method: HttpMethod.ALL, path: "/all", response: z.string() }),
  delete: defineRouteContract({
    method: HttpMethod.DELETE,
    path: "/delete",
    response: z.string(),
  }),
  get: defineRouteContract({ method: HttpMethod.GET, path: "/get", response: z.string() }),
  head: defineRouteContract({ method: HttpMethod.HEAD, path: "/head", response: z.string() }),
  options: defineRouteContract({
    method: HttpMethod.OPTIONS,
    path: "/options",
    response: z.string(),
  }),
  patch: defineRouteContract({ method: HttpMethod.PATCH, path: "/patch", response: z.string() }),
  post: defineRouteContract({ method: HttpMethod.POST, path: "/post", response: z.string() }),
  put: defineRouteContract({ method: HttpMethod.PUT, path: "/put", response: z.string() }),
  unknown: defineRouteContract({
    method: HttpMethod.GET,
    path: "/unknown",
    response: z.unknown(),
  }),
};

const anyAndStringResponseContract = selectResponseContract
  ? defineRouteContract({
      method: HttpMethod.GET,
      path: "/any-response",
      response: z.any(),
    })
  : responseContractsByMethod.get;

const readonlyArrayResponseContract = defineRouteContract({
  method: HttpMethod.GET,
  path: "/readonly-array",
  response: z.object({
    items: z.array(z.object({ id: z.string() })),
    tuple: z.tuple([z.string(), z.number()]),
  }),
});

const readonlyRestTupleResponseContract = defineRouteContract({
  method: HttpMethod.GET,
  path: "/readonly-rest-tuple",
  response: z.tuple([z.string()]).rest(z.number()),
});

describe("readonly handler return arrays", () => {
  it("preserves response shape while accepting readonly array inputs", () => {
    expectTypeOf<RouteHandlerReturn<typeof readonlyArrayResponseContract>>().toEqualTypeOf<{
      items: { id: string }[];
      tuple: [string, number];
    }>();

    const handlerReturn = {
      items: Object.freeze([{ id: "user_1" }]),
      tuple: ["ok", 1] as const,
    } as const;

    expect(validateResponse(readonlyArrayResponseContract.response, handlerReturn)).toEqual({
      items: [{ id: "user_1" }],
      tuple: ["ok", 1],
    });
  });

  it("preserves variadic tuple prefixes while accepting readonly tuples", () => {
    expectTypeOf<RouteHandlerReturn<typeof readonlyRestTupleResponseContract>>().toEqualTypeOf<
      [string, ...number[]]
    >();

    const handlerReturn = ["ok", 1, 2] as const;

    expect(validateResponse(readonlyRestTupleResponseContract.response, handlerReturn)).toEqual([
      "ok",
      1,
      2,
    ]);
  });
});

describe("nominal handler returns", () => {
  it("preserves the response schema's instance identity", () => {
    expectTypeOf<
      RouteHandlerReturn<typeof nominalResponseContract>
    >().toEqualTypeOf<NominalResponse>();
    expect(() =>
      validateResponse(nominalResponseContract.response, {
        value: "not-an-instance",
        isNominal: () => true,
      }),
    ).toThrow();
  });

  it("accepts readonly arrays without erasing element identity", () => {
    const handlerReturn = Object.freeze([new NominalResponse("ok")]);

    expect(validateResponse(nominalArrayResponseContract.response, handlerReturn)).toEqual([
      handlerReturn[0],
    ]);
  });
});

// @ts-expect-error RouteHandlerReturn must preserve z.instanceof nominal identity.
const invalidNominalHandlerReturn: RouteHandlerReturn<typeof nominalResponseContract> = {
  value: "not-an-instance",
  isNominal: () => true,
};

void invalidNominalHandlerReturn;

// @ts-expect-error routeParam only accepts names declared by the route path and params schema.
routeParam(responseContract, "userId");

const invalidResponseHandler: RouteContractHandler<typeof responseContract> = () => ({
  // @ts-expect-error response id must stay a string because it is inferred from the response schema.
  id: 123,
  name: "Ada",
});

void invalidResponseHandler;

class InvalidMethodController {
  // @ts-expect-error @Get cannot consume a POST route contract.
  @Get(postContractForNegativeTest)
  invalidMethod(): z.input<typeof userSchema> {
    return { id: "user_1", name: "Ada" };
  }
}

const methodObserver: MethodDecorator = () => undefined;

class ValidContractMethodController {
  @Get(responseContractsByMethod.get)
  sync(): string {
    return "ok";
  }

  @Get(responseContractsByMethod.get)
  async async(): Promise<string> {
    return "ok";
  }

  @Get(transformedResponseContract)
  transformed(): RouteHandlerReturn<typeof transformedResponseContract> {
    return "before-transform";
  }

  @Get(responseContractsByMethod.unknown)
  unknownHandlerSlot(): unknown {
    return Symbol("accepted by unknown response schema");
  }

  @methodObserver
  @Get(responseContractsByMethod.get)
  strictDecoratorAppliedFirst(): string {
    return "ok";
  }

  @Get(responseContractsByMethod.get)
  @methodObserver
  strictDecoratorAppliedLast(): string {
    return "ok";
  }

  @Get(responseLessContract)
  responseLess(): void {}

  @Get(mixedResponseContract)
  mixedResponse(): z.input<typeof userSchema> {
    return { id: "user_1", name: "Ada" };
  }

  @Get(responseContractUnion)
  responseUnion(): { id: string; name: string } {
    return { id: "user_1", name: "Ada" };
  }

  @Get(schemaUnionResponseContract)
  schemaUnion(): string {
    return "accepted by one branch of the response schema";
  }

  @Get(anyAndStringResponseContract)
  anyAndStringResponseUnion(): string {
    return "accepted by every runtime contract member";
  }

  @Get(nominalResponseContract)
  nominalResponse(): NominalResponse {
    return new NominalResponse("ok");
  }

  @Get(nominalArrayResponseContract)
  nominalArrayResponse(): readonly NominalResponse[] {
    return [new NominalResponse("ok")];
  }

  @Get(readonlyArrayResponseContract)
  readonlyArrays(): {
    readonly items: readonly { readonly id: string }[];
    readonly tuple: readonly [string, number];
  } {
    return { items: [{ id: "user_1" }], tuple: ["ok", 1] };
  }

  @Get(readonlyRestTupleResponseContract)
  readonlyRestTuple(): readonly [string, ...number[]] {
    return ["ok", 1, 2];
  }

  @Get("/loose")
  stringRouteRemainsLoose(): number {
    return 1;
  }
}

class InvalidContractMethodController {
  // @ts-expect-error contract-bound GET methods must return the response handler type.
  @Get(responseContractsByMethod.get)
  invalidGet(): number {
    return 1;
  }

  // @ts-expect-error contract-bound POST methods must return the response handler type.
  @Post(responseContractsByMethod.post)
  invalidPost(): number {
    return 1;
  }

  // @ts-expect-error contract-bound PUT methods must return the response handler type.
  @Put(responseContractsByMethod.put)
  invalidPut(): number {
    return 1;
  }

  // @ts-expect-error contract-bound PATCH methods must return the response handler type.
  @Patch(responseContractsByMethod.patch)
  invalidPatch(): number {
    return 1;
  }

  // @ts-expect-error contract-bound DELETE methods must return the response handler type.
  @Delete(responseContractsByMethod.delete)
  invalidDelete(): number {
    return 1;
  }

  // @ts-expect-error contract-bound OPTIONS methods must return the response handler type.
  @Options(responseContractsByMethod.options)
  invalidOptions(): number {
    return 1;
  }

  // @ts-expect-error contract-bound HEAD methods must return the response handler type.
  @Head(responseContractsByMethod.head)
  invalidHead(): number {
    return 1;
  }

  // @ts-expect-error contract-bound ALL methods must return the response handler type.
  @All(responseContractsByMethod.all)
  invalidAll(): number {
    return 1;
  }

  // @ts-expect-error async controller returns use the awaited annotation.
  @Get(responseContractsByMethod.get)
  async invalidAsync(): Promise<number> {
    return 1;
  }

  // @ts-expect-error response transforms validate the handler-return input, not the wire output.
  @Get(transformedResponseContract)
  invalidTransformed(): number {
    return 1;
  }

  // @ts-expect-error any cannot bypass contract-bound return validation.
  @Get(responseContractsByMethod.get)
  invalidAny(): any {
    return "hidden";
  }

  // @ts-expect-error unknown is not accepted by a narrower response handler slot.
  @Get(responseContractsByMethod.get)
  invalidUnknown(): unknown {
    return "hidden";
  }

  // @ts-expect-error void hides the response value required by the contract.
  @Get(responseContractsByMethod.get)
  invalidVoid(): void {}

  // @ts-expect-error never cannot vacuously satisfy a response contract.
  @Get(responseContractsByMethod.get)
  invalidNever(): never {
    throw new Error("type fixture only");
  }

  // @ts-expect-error a mixed union must validate every response-bearing contract member.
  @Get(mixedResponseContract)
  invalidMixedResponse(): number {
    return 1;
  }

  // @ts-expect-error a response-bearing union requires a return accepted by every member.
  @Get(responseContractUnion)
  invalidResponseUnion(): { id: string } {
    return { id: "user_1" };
  }

  // @ts-expect-error a value outside a single response schema's union remains invalid.
  @Get(schemaUnionResponseContract)
  invalidSchemaUnion(): boolean {
    return true;
  }

  // @ts-expect-error z.any in one runtime contract member must not erase another member's return contract.
  @Get(anyAndStringResponseContract)
  invalidAnyAndStringResponseUnion(): number {
    return 1;
  }

  // @ts-expect-error readonly-array normalization must not erase nominal instance identity.
  @Get(nominalResponseContract)
  invalidNominalResponse(): { readonly value: string; readonly isNominal: () => boolean } {
    return { value: "not-an-instance", isNominal: () => true };
  }

  // @ts-expect-error readonly-array normalization must preserve each element's nominal identity.
  @Get(nominalArrayResponseContract)
  invalidNominalArrayResponse(): readonly {
    readonly value: string;
    readonly isNominal: () => boolean;
  }[] {
    return [{ value: "not-an-instance", isNominal: () => true }];
  }

  // @ts-expect-error readonly compatibility must preserve tuple length and element types.
  @Get(readonlyArrayResponseContract)
  invalidReadonlyTuple(): {
    readonly items: readonly { readonly id: string }[];
    readonly tuple: readonly [string];
  } {
    return { items: [{ id: "user_1" }], tuple: ["missing-number"] };
  }

  // @ts-expect-error readonly compatibility must preserve a variadic tuple's fixed prefix.
  @Get(readonlyRestTupleResponseContract)
  invalidReadonlyRestTuple(): readonly [number, ...number[]] {
    return [1, 2];
  }

  // @ts-expect-error generic return annotations cannot prove a stable handler-return value.
  @Get(responseContractsByMethod.get)
  invalidGeneric<Value extends string>(value: Value): Value {
    return value;
  }

  invalidOverload(value: string): string;
  invalidOverload(value: number): number;
  // @ts-expect-error overloaded implementations do not expose the decorated return annotation.
  @Get(responseContractsByMethod.get)
  invalidOverload(value: string | number): string | number {
    return value;
  }

  // @ts-expect-error contract-bound route methods require a public instance method target.
  @Get(responseContractsByMethod.get)
  protected invalidProtected(): string {
    return "hidden";
  }

  // @ts-expect-error contract-bound route methods require a public instance method target.
  @Get(responseContractsByMethod.get)
  private invalidPrivate(): string {
    return "hidden";
  }

  // @ts-expect-error static targets do not own controller route metadata.
  @Get(responseContractsByMethod.get)
  static invalidStatic(): string {
    return "hidden";
  }
}

class InvalidBodyController {
  invalidBody(
    // @ts-expect-error @Body(contract) requires a route contract with a body schema.
    @Body(responseContract) _body: unknown,
  ): void {}
}

void InvalidMethodController;
void ValidContractMethodController;
void InvalidContractMethodController;
void InvalidBodyController;

class ValidContractParameterController {
  valid(
    @Param(contractParameterTypes, "id") id: string,
    @Query(contractParameterTypes, "page") page: number,
    @Query(contractParameterTypes, "defaulted") defaulted: string,
    @Query(contractParameterTypes, "transformed") transformed: number,
    @Query(contractParameterTypes, "preprocessed") preprocessed: string,
    @Query(contractParameterTypes, "optional") optional: string | undefined,
    @Query(contractParameterTypes, "nullable") nullable: string | null,
    @Query(contractParameterTypes, "union") union: string | number,
    @Query(contractParameterTypes, "anyOutput") anyOutput: unknown,
    @Query(contractParameterTypes, "unknownOutput") unknownOutput: unknown,
    @Body(contractParameterTypes) body: { name: string; normalized: true },
  ): void {
    void [
      id,
      page,
      defaulted,
      transformed,
      preprocessed,
      optional,
      nullable,
      union,
      anyOutput,
      unknownOutput,
      body,
    ];
  }

  acceptsNeverOutput(@Query(contractParameterTypes, "neverOutput") neverOutput: unknown): void {
    void neverOutput;
  }

  acceptsSafeWiderAnnotations(
    @Param(contractParameterTypes, "id") id: string | null,
    @Query(contractParameterTypes, "page") page: unknown,
  ): void {
    void [id, page];
  }

  legacyLooseOverloads(
    @Param("id", z.string()) id: number,
    @Query("page", z.coerce.number()) page: string,
    @Body(z.object({ name: z.string() })) body: boolean,
  ): void {
    void [id, page, body];
  }
}

class InvalidContractParameterController {
  invalidCoercion(
    // @ts-expect-error parsed number output is not assignable to a string annotation.
    @Query(contractParameterTypes, "page") page: string,
  ): void {
    void page;
  }

  invalidTransform(
    // @ts-expect-error transformed number output is not assignable to the pre-transform string.
    @Query(contractParameterTypes, "transformed") transformed: string,
  ): void {
    void transformed;
  }

  invalidBrand(
    // @ts-expect-error UserId output is not assignable to an unrelated brand.
    @Param(contractParameterTypes, "id") id: z.infer<typeof otherBrand>,
  ): void {
    void id;
  }

  invalidOptional(
    // @ts-expect-error optional output includes undefined.
    @Query(contractParameterTypes, "optional") optional: string,
  ): void {
    void optional;
  }

  invalidNullable(
    // @ts-expect-error nullable output includes null.
    @Query(contractParameterTypes, "nullable") nullable: string,
  ): void {
    void nullable;
  }

  invalidUnion(
    // @ts-expect-error the complete parsed union must be accepted by the annotation.
    @Query(contractParameterTypes, "union") union: string,
  ): void {
    void union;
  }

  invalidBody(
    // @ts-expect-error body parameters receive the transformed output.
    @Body(contractParameterTypes) body: { name: number; normalized: true },
  ): void {
    void body;
  }

  invalidAny(
    // @ts-expect-error any cannot bypass strict contract-bound parameter validation.
    @Query(contractParameterTypes, "page") page: any,
  ): void {
    void page;
  }

  invalidAnyOutput(
    // @ts-expect-error unconstrained parsed output can only be delivered to unknown.
    @Query(contractParameterTypes, "anyOutput") value: string,
  ): void {
    void value;
  }

  invalidNever(
    // @ts-expect-error a parsed number cannot be delivered to never.
    @Query(contractParameterTypes, "page") page: never,
  ): void {
    void page;
  }

  invalidKey(
    // @ts-expect-error contract query keys remain validated.
    @Query(contractParameterTypes, "missing") missing: unknown,
  ): void {
    void missing;
  }
}

class InvalidGenericContractParameterController {
  invalidGeneric<Value>(
    // @ts-expect-error generic method annotations cannot prove a stable contract input slot.
    @Query(contractParameterTypes, "page") page: Value,
  ): void {
    void page;
  }

  invalidConstrainedGeneric<Value extends number>(
    // @ts-expect-error constrained generics may still be instantiated with a narrower subtype.
    @Query(contractParameterTypes, "page") page: Value,
  ): void {
    void page;
  }
}

class InvalidVisibilityContractParameterController {
  private invalidPrivate(
    // @ts-expect-error contract-bound parameters require a public instance method target.
    @Query(contractParameterTypes, "page") page: number,
  ): void {
    void page;
  }

  protected invalidProtected(
    // @ts-expect-error contract-bound parameters require a public instance method target.
    @Query(contractParameterTypes, "page") page: number,
  ): void {
    void page;
  }

  static invalidStatic(
    // @ts-expect-error static targets do not own controller parameter metadata.
    @Query(contractParameterTypes, "page") page: number,
  ): void {
    void page;
  }
}

class InvalidContractParameterConstructor {
  constructor(
    // @ts-expect-error contract-bound parameter decorators require a method target.
    @Body(contractParameterTypes) body: RouteBody<typeof contractParameterTypes>,
  ) {
    void body;
  }
}

void ValidContractParameterController;
void InvalidContractParameterController;
void InvalidGenericContractParameterController;
void InvalidVisibilityContractParameterController;
void InvalidContractParameterConstructor;

defineRouteProblem(UserForbiddenProblem, {
  // @ts-expect-error typed Problem helpers preserve the subclass literal code.
  code: "USER_NOT_FOUND",
  category: ProblemCategory.Forbidden,
});

defineRouteProblem(UserForbiddenProblem, {
  code: "USER_FORBIDDEN",
  // @ts-expect-error typed Problem helpers preserve the subclass literal category.
  category: ProblemCategory.NotFound,
});

ProblemResponse({
  code: "USER_FORBIDDEN",
  category: ProblemCategory.Forbidden,
  // @ts-expect-error route contract provenance is attached only by routeProblemResponses(contract).
  routeContractProblems: [],
});

type RemovedRouteTypes = [
  RemovedTypedRouteConfig,
  RemovedInferRouteRequest<never>,
  RemovedInferRouteResponse<never>,
  RemovedTypedRouteHandler<never>,
  RemovedApiEndpoint,
  RemovedEndpointRequest<never>,
  RemovedEndpointResponse<never>,
];

const removedRouteTypes: RemovedRouteTypes | undefined = undefined;
void removedRouteTypes;

const wrappedParamsInput = z.object({ id: z.string() });
const wrappedQueryInput = z.object({ count: z.string() });
const wrappedParameterContract = defineRouteContract({
  method: HttpMethod.GET,
  path: "/wrapped/:id",
  params: wrappedParamsInput
    .refine(({ id }) => id.length > 0)
    .transform(({ id }) => ({ id: id.length })),
  query: wrappedQueryInput
    .transform(({ count }) => ({ total: Number(count) }))
    .pipe(z.object({ total: z.number() }).refine(({ total }) => total > 0)),
});

describe("wrapped parameter contract types", () => {
  it("preserves input and output types independently", () => {
    expectTypeOf<RouteClientPathParams<typeof wrappedParameterContract>>().toEqualTypeOf<{
      id: string;
    }>();
    expectTypeOf<RouteHandlerPathParams<typeof wrappedParameterContract>>().toEqualTypeOf<{
      id: number;
    }>();
    expectTypeOf<RouteClientQuery<typeof wrappedParameterContract>>().toEqualTypeOf<{
      count: string;
    }>();
    expectTypeOf<RouteHandlerQuery<typeof wrappedParameterContract>>().toEqualTypeOf<{
      total: number;
    }>();
    expectTypeOf(routeParamSchema(wrappedParameterContract, "id")).toEqualTypeOf<z.ZodString>();
    expectTypeOf(
      routeQueryParamSchema(wrappedParameterContract, "count"),
    ).toEqualTypeOf<z.ZodString>();
    expect(routeParamSchema(wrappedParameterContract, "id")).toBe(wrappedParamsInput.shape.id);
    expect(routeQueryParamSchema(wrappedParameterContract, "count")).toBe(
      wrappedQueryInput.shape.count,
    );
    expect(routeQueryParam(wrappedParameterContract, "total")).toBe("total");
  });
});

// @ts-expect-error wrapped parameter input must declare every path name.
defineRouteContract({
  method: HttpMethod.GET,
  path: "/wrapped/:missing",
  params: wrappedParamsInput.refine(() => true),
});
// @ts-expect-error transforms cannot replace the path names required on the wire.
defineRouteContract({
  method: HttpMethod.GET,
  path: "/wrapped/:renamed",
  params: wrappedParamsInput.transform(({ id }) => ({ renamed: id })),
});
defineRouteContract({
  method: HttpMethod.GET,
  path: "/wrapped",
  // @ts-expect-error scalar-input transforms are not route parameter objects.
  query: z.string().transform((value) => ({ value })),
});
defineRouteContract({
  method: HttpMethod.GET,
  path: "/wrapped/:id",
  // @ts-expect-error parameter schema outputs must remain objects.
  params: wrappedParamsInput.transform(({ id }) => id),
});
defineRouteContract({
  method: HttpMethod.GET,
  path: "/wrapped/:id",
  // @ts-expect-error pipeline outputs must remain objects.
  params: wrappedParamsInput.pipe(z.string()),
});

function invalidWrappedSchemaHelpers(): void {
  // @ts-expect-error output-only properties do not have an input field schema.
  routeQueryParamSchema(wrappedParameterContract, "total");
  // @ts-expect-error query binding names use output keys.
  routeQueryParam(wrappedParameterContract, "count");
}
void invalidWrappedSchemaHelpers;

const renamedPathContract = defineRouteContract({
  method: HttpMethod.GET,
  path: "/renamed/:id",
  params: z.object({ id: z.string() }).transform(({ id }) => ({ renamed: Number(id) })),
});
class RenamedPathController {
  read(@Param(renamedPathContract, "renamed") renamed: number) {
    return renamed;
  }
}
void RenamedPathController;
expectTypeOf(routeParam(renamedPathContract, "renamed")).toEqualTypeOf<"renamed">();
function invalidRenamedPathBindings(): void {
  // @ts-expect-error the input-only path name is absent from the handler output.
  routeParam(renamedPathContract, "id");
}
void invalidRenamedPathBindings;
