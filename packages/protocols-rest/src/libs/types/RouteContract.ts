import { Problem, ProblemCategory, ProblemCategoryMapper } from "@croco/problems-core";
import { HttpMethod } from "../constants";
import { attachRouteContractProblems } from "../internal/routeContractProblemMetadata";
import { getRouteParameterObject, isRouteParameterSchema } from "../internal/routeParameterSchema";
import type { z } from "zod";
import type { RouteParameterSchema, RouteParameterObject } from "../internal/routeParameterSchema";

type EmptyObject = Record<never, never>;
declare const noRouteParamsSchema: unique symbol;
type NoRouteParamsSchema = {
  readonly [noRouteParamsSchema]: never;
};
type RouteContractTypeError<Message extends string> = {
  readonly __routeContractError__: Message;
};

export type ProblemConstructor<TProblem extends Problem = Problem> = {
  readonly name: string;
  readonly prototype: TProblem;
};

export type RouteProblemStatus<Category extends ProblemCategory> =
  Category extends ProblemCategory.BadRequest
    ? 400
    : Category extends ProblemCategory.Unauthorized
      ? 401
      : Category extends ProblemCategory.Forbidden
        ? 403
        : Category extends ProblemCategory.NotFound
          ? 404
          : Category extends ProblemCategory.Conflict
            ? 409
            : Category extends ProblemCategory.Gone
              ? 410
              : Category extends ProblemCategory.PayloadTooLarge
                ? 413
                : Category extends ProblemCategory.ValidationError
                  ? 422
                  : Category extends ProblemCategory.BusinessRuleViolation
                    ? 422
                    : Category extends ProblemCategory.TooManyRequests
                      ? 429
                      : Category extends ProblemCategory.InternalServerError
                        ? 500
                        : Category extends ProblemCategory.NotImplemented
                          ? 501
                          : number;

export type RouteProblemDeclaration<
  TProblem extends Problem = Problem,
  Code extends string = RouteProblemCode<TProblem>,
  Category extends ProblemCategory = RouteProblemCategory<TProblem>,
  Status extends number = RouteProblemStatus<Category>,
> = {
  readonly problem: ProblemConstructor<TProblem>;
  readonly code: Code;
  readonly category: Category;
  readonly status: Status;
  readonly description?: string;
  readonly type?: string;
};

export type RouteContractProblem = ProblemConstructor | RouteProblemDeclaration;
type RouteProblemCode<TProblem extends Problem> = TProblem["code"] extends infer Code extends string
  ? Code
  : string;
type RouteProblemCategory<TProblem extends Problem> =
  TProblem["category"] extends infer Category extends ProblemCategory ? Category : ProblemCategory;

export type RouteContractSpec<
  Method extends HttpMethod = HttpMethod,
  Path extends string = string,
  Params extends RouteParameterSchema | undefined = RouteParameterSchema | undefined,
  Query extends RouteParameterSchema | undefined = RouteParameterSchema | undefined,
  Body extends z.ZodType | undefined = z.ZodType | undefined,
  Response extends z.ZodType | undefined = z.ZodType | undefined,
  Problems extends readonly RouteContractProblem[] | undefined =
    | readonly RouteContractProblem[]
    | undefined,
> = {
  readonly id?: string;
  readonly method: Method;
  readonly path: Path;
  readonly operationId?: string;
  readonly sourceLocation?: RouteContractSourceLocation;
  readonly params?: Params;
  readonly query?: Query;
  readonly body?: Body;
  readonly response?: Response;
  readonly problems?: Problems;
};

export type AnyRouteContractSpec = RouteContractSpec;

export type RouteContractWithParams = RouteContractSpec & {
  readonly params: RouteParameterSchema;
};

export type RouteContractWithQuery = RouteContractSpec & {
  readonly query: RouteParameterSchema;
};

export type RouteContractWithBody = RouteContractSpec & {
  readonly body: z.ZodType;
};

export type RouteContractWithResponse = RouteContractSpec & {
  readonly response: z.ZodType;
};

export type RouteContractSourceLocation = {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
};

export type RoutePathParamName<Path extends string> = string extends Path
  ? string
  : Path extends `${string}:${infer Token}/${infer Rest}`
    ? NormalizePathParamToken<Token> | RoutePathParamName<`/${Rest}`>
    : Path extends `${string}:${infer Token}`
      ? NormalizePathParamToken<Token>
      : never;

export type RouteClientPathParams<TContract extends RouteContractSpec> = TContract extends {
  readonly params: infer Params extends RouteParameterSchema;
}
  ? z.input<Params>
  : EmptyObject;

export type RouteHandlerPathParams<TContract extends RouteContractSpec> = TContract extends {
  readonly params: infer Params extends RouteParameterSchema;
}
  ? z.output<Params>
  : EmptyObject;

export type RouteClientQuery<TContract extends RouteContractSpec> = TContract extends {
  readonly query: infer Query extends RouteParameterSchema;
}
  ? z.input<Query>
  : EmptyObject;

export type RouteHandlerQuery<TContract extends RouteContractSpec> = TContract extends {
  readonly query: infer Query extends RouteParameterSchema;
}
  ? z.output<Query>
  : EmptyObject;

export type RouteClientBody<TContract extends RouteContractSpec> = TContract extends {
  readonly body: infer Body extends z.ZodType;
}
  ? z.input<Body>
  : undefined;

export type RouteHandlerBody<TContract extends RouteContractSpec> = TContract extends {
  readonly body: infer Body extends z.ZodType;
}
  ? z.output<Body>
  : undefined;

export type RouteHandlerReturn<TContract extends RouteContractSpec> = TContract extends {
  readonly response: infer Response extends z.ZodType;
}
  ? z.input<Response>
  : unknown;

export type RouteWireResponse<TContract extends RouteContractSpec> = TContract extends {
  readonly response: infer Response extends z.ZodType;
}
  ? z.output<Response>
  : unknown;

export type RouteClientResponse<TContract extends RouteContractSpec> = RouteWireResponse<TContract>;

export type RoutePathParams<TContract extends RouteContractSpec> =
  RouteHandlerPathParams<TContract>;

export type RouteQuery<TContract extends RouteContractSpec> = RouteHandlerQuery<TContract>;

export type RouteBody<TContract extends RouteContractSpec> = RouteHandlerBody<TContract>;

export type RouteResponse<TContract extends RouteContractSpec> = RouteWireResponse<TContract>;

export type RouteProblem<TContract extends RouteContractSpec> = TContract extends {
  readonly problems: readonly (infer ProblemEntry)[];
}
  ? ProblemEntry extends ProblemConstructor<infer TProblem>
    ? TProblem
    : ProblemEntry extends RouteProblemDeclaration<infer TProblem>
      ? TProblem
      : never
  : never;

export type RouteClientRequest<TContract extends RouteContractSpec> = {
  readonly params: RouteClientPathParams<TContract>;
  readonly query: RouteClientQuery<TContract>;
  readonly body: RouteClientBody<TContract>;
};

export type RouteHandlerRequest<TContract extends RouteContractSpec> = {
  readonly params: RouteHandlerPathParams<TContract>;
  readonly query: RouteHandlerQuery<TContract>;
  readonly body: RouteHandlerBody<TContract>;
};

export type RouteContractRequest<TContract extends RouteContractSpec> =
  RouteHandlerRequest<TContract>;

export type RouteContractResult<TContract extends RouteContractSpec> =
  | RouteHandlerReturn<TContract>
  | Promise<RouteHandlerReturn<TContract>>;

export type RouteContractHandler<TContract extends RouteContractSpec> = (
  request: RouteContractRequest<TContract>,
) => RouteContractResult<TContract>;

export type RouteMethodReturn<TContract extends RouteContractSpec> = RouteContractResult<TContract>;

export type RouteParam<
  TContract extends RouteContractSpec,
  Name extends keyof RoutePathParams<TContract> & string,
> = RoutePathParams<TContract>[Name];

export type RouteQueryParam<
  TContract extends RouteContractSpec,
  Name extends keyof RouteQuery<TContract> & string,
> = RouteQuery<TContract>[Name];

export function defineRouteContract<const TContract extends RouteContractSpec>(
  contract: TContract & ValidateRouteContractPathParams<NoInfer<TContract>>,
): TContract {
  return contract;
}

export function isRouteContractSpec(value: unknown): value is AnyRouteContractSpec {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    readonly body?: unknown;
    readonly id?: unknown;
    readonly method?: unknown;
    readonly operationId?: unknown;
    readonly params?: unknown;
    readonly path?: unknown;
    readonly problems?: unknown;
    readonly query?: unknown;
    readonly response?: unknown;
    readonly sourceLocation?: unknown;
  };

  return (
    isHttpMethod(candidate.method) &&
    typeof candidate.path === "string" &&
    isOptionalString(candidate.id) &&
    isOptionalString(candidate.operationId) &&
    isOptionalRouteContractSourceLocation(candidate.sourceLocation) &&
    isOptionalRouteParameterSchema(candidate.params) &&
    isOptionalRouteParameterSchema(candidate.query) &&
    isOptionalZodType(candidate.body) &&
    isOptionalZodType(candidate.response) &&
    isOptionalRouteContractProblems(candidate.problems)
  );
}

export function hasRouteParamsContract(value: unknown): value is RouteContractWithParams {
  return isRouteContractSpec(value) && isRouteParameterSchema(value.params);
}

export function hasRouteQueryContract(value: unknown): value is RouteContractWithQuery {
  return isRouteContractSpec(value) && isRouteParameterSchema(value.query);
}

export function hasRouteBodyContract(value: unknown): value is RouteContractWithBody {
  return isRouteContractSpec(value) && isZodType(value.body);
}

export function hasRouteResponseContract(value: unknown): value is RouteContractWithResponse {
  return isRouteContractSpec(value) && isZodType(value.response);
}

export function defineRouteProblem<
  const TProblem extends Problem,
  const Code extends RouteProblemCode<TProblem>,
  const Category extends RouteProblemCategory<TProblem>,
>(
  problem: ProblemConstructor<TProblem>,
  declaration: {
    readonly code: Code;
    readonly category: Category;
    readonly description?: string;
    readonly type?: string;
  },
): RouteProblemDeclaration<TProblem, Code, Category, RouteProblemStatus<Category>> {
  return {
    problem,
    code: declaration.code,
    category: declaration.category,
    status: ProblemCategoryMapper.toHttpStatus(
      declaration.category,
    ) as RouteProblemStatus<Category>,
    ...(declaration.description ? { description: declaration.description } : {}),
    ...(declaration.type ? { type: declaration.type } : {}),
  };
}

export function routeProblemResponses<
  const TProblems extends readonly RouteProblemDeclaration[],
>(contract: { readonly problems: TProblems }): RouteProblemResponses<TProblems> {
  const contractProblems = contract.problems.map(toProblemResponseMetadata);

  return contractProblems.map((problem) =>
    attachRouteContractProblems(problem, contractProblems),
  ) as RouteProblemResponses<TProblems>;
}

export function routeParam<
  TContract extends RouteContractSpec,
  Name extends keyof RoutePathParams<TContract> & string,
>(_contract: TContract, name: Name): Name {
  return name;
}

export function routeParamSchema<
  TContract extends RouteContractWithParams,
  Name extends RoutePathParamName<TContract["path"]> &
    keyof RouteParameterObject<TContract["params"]>["shape"] &
    string,
>(contract: TContract, name: Name): RouteParameterObject<TContract["params"]>["shape"][Name] {
  return getRouteParameterObject(contract.params).shape[name] as RouteParameterObject<
    TContract["params"]
  >["shape"][Name];
}

export function routeQueryParam<
  TContract extends RouteContractSpec,
  Name extends keyof RouteQuery<TContract> & string,
>(_contract: TContract, name: Name): Name {
  return name;
}

export function routeQueryParamSchema<
  TContract extends RouteContractWithQuery,
  Name extends keyof RouteParameterObject<TContract["query"]>["shape"] & string,
>(contract: TContract, name: Name): RouteParameterObject<TContract["query"]>["shape"][Name] {
  return getRouteParameterObject(contract.query).shape[name] as RouteParameterObject<
    TContract["query"]
  >["shape"][Name];
}

export function routePathParamsSchema<TContract extends RouteContractWithParams>(
  contract: TContract,
): TContract["params"] {
  return contract.params;
}

export function routeQuerySchema<TContract extends RouteContractWithQuery>(
  contract: TContract,
): TContract["query"] {
  return contract.query;
}

export function routeBodySchema<TContract extends RouteContractWithBody>(
  contract: TContract,
): TContract["body"] {
  return contract.body;
}

export function routeResponseSchema<TContract extends RouteContractWithResponse>(
  contract: TContract,
): TContract["response"] {
  return contract.response;
}

type ValidateRouteContractPathParams<TContract extends RouteContractSpec> =
  TContract["path"] extends infer Path extends string
    ? ContractPathParamError<Path, ContractParamsSchema<TContract>>
    : unknown;

type ContractParamsSchema<TContract extends RouteContractSpec> = "params" extends keyof TContract
  ? TContract["params"] extends RouteParameterSchema
    ? TContract["params"]
    : NoRouteParamsSchema
  : NoRouteParamsSchema;

type ContractPathParamError<
  Path extends string,
  Params extends RouteParameterSchema | NoRouteParamsSchema,
> =
  MissingPathParamNames<Path, Params> extends infer Missing extends string
    ? ExtraPathParamNames<Path, Params> extends infer Extra extends string
      ? [Missing] extends [never]
        ? [Extra] extends [never]
          ? unknown
          : RouteContractTypeError<`Route params schema declares '${Extra}' but '${Path}' does not contain that path parameter.`>
        : RouteContractTypeError<`Route path '${Path}' declares path parameter '${Missing}' but the params schema does not.`>
      : never
    : never;

type MissingPathParamNames<
  Path extends string,
  Params extends RouteParameterSchema | NoRouteParamsSchema,
> = Exclude<RoutePathParamName<Path>, ZodObjectKey<Params>>;

type ExtraPathParamNames<
  Path extends string,
  Params extends RouteParameterSchema | NoRouteParamsSchema,
> = Exclude<ZodObjectKey<Params>, RoutePathParamName<Path>>;

type ZodObjectKey<Schema extends RouteParameterSchema | NoRouteParamsSchema> =
  Schema extends RouteParameterSchema
    ? Extract<keyof RouteParameterObject<Schema>["shape"], string>
    : never;

type NormalizePathParamToken<Token extends string> = Token extends `...${infer Name}`
  ? Name
  : Token;

function isHttpMethod(value: unknown): value is HttpMethod {
  return typeof value === "string" && HTTP_METHODS.has(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalRouteContractSourceLocation(
  value: unknown,
): value is RouteContractSourceLocation | undefined {
  if (value === undefined) {
    return true;
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    readonly column?: unknown;
    readonly line?: unknown;
    readonly path?: unknown;
  };

  return (
    typeof candidate.path === "string" &&
    (candidate.line === undefined || typeof candidate.line === "number") &&
    (candidate.column === undefined || typeof candidate.column === "number")
  );
}

function isOptionalRouteParameterSchema(value: unknown): value is RouteParameterSchema | undefined {
  return value === undefined || isRouteParameterSchema(value);
}

function isOptionalZodType(value: unknown): value is z.ZodType | undefined {
  return value === undefined || isZodType(value);
}

function isOptionalRouteContractProblems(
  value: unknown,
): value is readonly RouteContractProblem[] | undefined {
  if (value === undefined) {
    return true;
  }

  try {
    if (!Array.isArray(value)) {
      return false;
    }

    const problemCount = value.length;
    for (let index = 0; index < problemCount; index += 1) {
      if (!isRouteContractProblem(value[index])) {
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
}

function isRouteContractProblem(value: unknown): value is RouteContractProblem {
  return isProblemConstructor(value) || isRouteProblemDeclaration(value);
}

function isProblemConstructor(value: unknown): value is ProblemConstructor {
  return (
    typeof value === "function" &&
    typeof value.name === "string" &&
    value.prototype instanceof Problem
  );
}

function isRouteProblemDeclaration(value: unknown): value is RouteProblemDeclaration {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    readonly category?: unknown;
    readonly code?: unknown;
    readonly description?: unknown;
    readonly problem?: unknown;
    readonly status?: unknown;
    readonly type?: unknown;
  };

  return (
    isProblemConstructor(candidate.problem) &&
    typeof candidate.code === "string" &&
    candidate.code.trim().length > 0 &&
    isProblemCategory(candidate.category) &&
    candidate.status === ProblemCategoryMapper.toHttpStatus(candidate.category) &&
    isOptionalString(candidate.description) &&
    isOptionalString(candidate.type)
  );
}

function isProblemCategory(value: unknown): value is ProblemCategory {
  return typeof value === "string" && PROBLEM_CATEGORIES.has(value);
}

function isZodType(value: unknown): value is z.ZodType {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { readonly safeParse?: unknown };

  return typeof candidate.safeParse === "function";
}

const HTTP_METHODS = new Set<string>(Object.values(HttpMethod));
const PROBLEM_CATEGORIES = new Set<string>(Object.values(ProblemCategory));

type RouteProblemResponses<TProblems extends readonly RouteProblemDeclaration[]> = {
  readonly [Index in keyof TProblems]: RouteProblemResponseFor<TProblems[Index]>;
};

type RouteProblemResponseFor<TProblem extends RouteProblemDeclaration> = TProblem extends {
  readonly code: infer Code extends string;
  readonly category: infer Category extends ProblemCategory;
  readonly status: infer Status extends number;
}
  ? RouteProblemResponseOptions<Code, Category, Status> &
      RouteProblemResponseMetadata<Code, Category, Status>
  : never;

type RouteProblemResponseMetadata<
  Code extends string = string,
  Category extends ProblemCategory = ProblemCategory,
  Status extends number = number,
> = {
  readonly code: Code;
  readonly category: Category;
  readonly status: Status;
  readonly description?: string;
  readonly type?: string;
};

type RouteProblemResponseOptions<
  Code extends string = string,
  Category extends ProblemCategory = ProblemCategory,
  Status extends number = number,
> = {
  readonly code: Code;
  readonly category: Category;
  readonly status?: Status;
  readonly description?: string;
  readonly type?: string;
};

function toProblemResponseMetadata(problem: RouteProblemDeclaration): RouteProblemResponseMetadata {
  return {
    code: problem.code,
    category: problem.category,
    status: problem.status,
    ...(problem.description ? { description: problem.description } : {}),
    ...(problem.type ? { type: problem.type } : {}),
  };
}
