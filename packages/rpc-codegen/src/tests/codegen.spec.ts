import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import {
  createFrontendActionManifest,
  type FrontendActionManifestEntry,
} from "@croco/presentation-preset";
import { Problem, ProblemCategory } from "@croco/problems-core";
import {
  CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
  type ContractGraph,
  defineRouteSchema,
  type InferRouteSchemaRequest,
  type InferRouteSchemaResponse,
  type RouteIR,
} from "@croco/protocols-core";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkGeneratedClientFiles,
  createFrontendActionManifestFromContractGraph,
  generateClientFiles,
  generateClientFilesFromContractGraph,
} from "../libs/generate";

const TEMP_DIR = path.join(__dirname, "codegen-temp");
const GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS = 15_000;
const VIRTUAL_PROBLEMS_CORE_MODULE = "node_modules/@croco/problems-core/index.d.ts";
type RpcQueryKeyInputProblemConstructor = new (path: string, detail: string) => Problem;
type GeneratedRpcProblemErrorConstructor = new (
  problem: Record<string, unknown>,
  response: Response,
) => Error & {
  readonly problem: Record<string, unknown>;
  readonly response: Response;
};
type GeneratedRpcStatusMismatchErrorConstructor = new (
  response: Response,
  problemStatus: number,
) => Problem & {
  readonly httpStatus: number;
  readonly problemStatus: number;
  readonly response: Response;
};
type GeneratedRpcHandleJsonResponse = (response: Response, telemetry?: unknown) => Promise<unknown>;
type GeneratedRpcHandleJsonResult = (
  response: Response,
  declaredProblems?: readonly {
    readonly code: string;
    readonly category: string;
    readonly status: number;
  }[],
  telemetry?: unknown,
) => Promise<unknown>;
type GeneratedClientFetch = (url: string, init: RequestInit) => Promise<Response>;
type GeneratedUserClientSupport = {
  readonly userClient: {
    readonly getResult: (input: { readonly path: { readonly id: string } }) => Promise<unknown>;
  };
};
const VIRTUAL_PROBLEMS_CORE_SOURCE = `
export enum ProblemCategory {
  BadRequest = "BadRequest",
  Unauthorized = "Unauthorized",
  Forbidden = "Forbidden",
  NotFound = "NotFound",
  Conflict = "Conflict",
  Gone = "Gone",
  ValidationError = "ValidationError",
  BusinessRuleViolation = "BusinessRuleViolation",
  TooManyRequests = "TooManyRequests",
  InternalServerError = "InternalServerError",
  NotImplemented = "NotImplemented",
}

export type ProblemDetails = {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly code: string;
} & Record<string, unknown>;

export type ProblemOptions = {
  readonly type?: string;
  readonly instance?: string;
  readonly extensions?: Record<string, unknown>;
  readonly cause?: Error;
};

export abstract class Problem extends Error {
  readonly code: string;
  readonly category: ProblemCategory;
  readonly detail?: string;
  readonly type: string;
  readonly instance?: string;
  readonly extensions?: Record<string, unknown>;
  readonly cause?: Error;
  readonly title: string;
  readonly status: number;

  protected constructor(
    code?: string,
    category?: ProblemCategory,
    detail?: string,
    options?: ProblemOptions,
  );

  toJSON(): ProblemDetails;
}
`;
const VIRTUAL_REACT_QUERY_MODULE = "node_modules/@tanstack/react-query/index.d.ts";
const VIRTUAL_REACT_QUERY_SOURCE = `
export type QueryKey = readonly unknown[];

export type UseQueryOptions<
  TQueryFnData = unknown,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> = {
  readonly queryKey?: TQueryKey;
  readonly queryFn?: () => Promise<TQueryFnData>;
  readonly enabled?: boolean;
  readonly staleTime?: number;
  readonly select?: (data: TQueryFnData) => TData;
};

export type UseQueryResult<TData = unknown, TError = Error> = {
  readonly data: TData | undefined;
  readonly error: TError | null;
};

export declare function useQuery<
  TQueryFnData = unknown,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey> & {
    readonly queryKey: TQueryKey;
    readonly queryFn: () => Promise<TQueryFnData>;
  },
): UseQueryResult<TData, TError>;

export type UseMutationOptions<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
> = {
  readonly mutationFn?: (variables: TVariables) => Promise<TData>;
  readonly onSuccess?: (data: TData, variables: TVariables, context: TContext | undefined) => void;
};

export type UseMutationResult<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
> = {
  readonly data: TData | undefined;
  readonly error: TError | null;
  readonly mutate: (variables: TVariables) => void;
  readonly context?: TContext;
};

export declare function useMutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TContext> & {
    readonly mutationFn: (variables: TVariables) => Promise<TData>;
  },
): UseMutationResult<TData, TError, TVariables, TContext>;
`;
const EMPTY_INPUT_SCHEMAS = {
  body: null,
  path: null,
  query: null,
  headers: null,
};
const BODY_INPUT_SCHEMAS: RouteIR["inputSchemas"] = {
  body: z.object({
    name: z.string(),
  }) as unknown as RouteIR["inputSchemas"]["body"],
  path: null,
  query: null,
  headers: null,
};
const PATH_INPUT_SCHEMAS = {
  body: null,
  path: z.object({ id: z.string() }) as any,
  query: null,
  headers: null,
};
const QUERY_INPUT_SCHEMAS = {
  body: null,
  path: null,
  query: z.object({ page: z.string() }) as any,
  headers: null,
};
const NON_STRING_QUERY_INPUT_SCHEMAS = {
  body: null,
  path: null,
  query: z.object({
    page: z.number(),
    active: z.boolean().optional(),
    search: z.string().optional(),
    tags: z.array(z.string()),
    deletedAt: z.string().nullable(),
  }) as any,
  headers: null,
};
const HEADER_INPUT_SCHEMAS = {
  body: null,
  path: null,
  query: null,
  headers: z.object({
    authorization: z.string(),
    "x-tenant-id": z.string().optional(),
  }) as any,
};
const ARRAY_HEADER_INPUT_SCHEMAS: RouteIR["inputSchemas"] = {
  body: null,
  path: null,
  query: null,
  headers: z.object({
    "x-tags": z.array(z.string()),
  }) as unknown as NonNullable<RouteIR["inputSchemas"]["headers"]>,
};
const COMBINED_INPUT_SCHEMAS = {
  body: z.object({ name: z.string() }) as any,
  path: z.object({ id: z.string() }) as any,
  query: z.object({ filter: z.string() }) as any,
  headers: null,
};
const BODY_HEADER_INPUT_SCHEMAS = {
  body: z.object({ name: z.string() }) as any,
  path: null,
  query: null,
  headers: z.object({ "x-request-id": z.string() }) as any,
};
const PATH_QUERY_HEADER_INPUT_SCHEMAS: RouteIR["inputSchemas"] = {
  body: null,
  path: z.object({ id: z.string() }) as unknown as NonNullable<RouteIR["inputSchemas"]["path"]>,
  query: z.object({ page: z.string() }) as unknown as NonNullable<RouteIR["inputSchemas"]["query"]>,
  headers: z.object({ authorization: z.string() }) as unknown as NonNullable<
    RouteIR["inputSchemas"]["headers"]
  >,
};
const NUMERIC_NATIVE_ENUM = {
  0: "Draft",
  1: "Published",
  Draft: 0,
  Published: 1,
} as const;
const MIXED_NATIVE_ENUM = {
  0: "Draft",
  Draft: 0,
  Published: "published",
} as const;

describe("generateClientFiles", () => {
  beforeEach(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it("checks unchanged outputs without changing their bytes, mtimes, or directory contents", () => {
    const routes = [createBasicRoute()];
    const files = generateClientFiles(routes, TEMP_DIR);
    const before = files.map((filePath) => ({
      content: fs.readFileSync(filePath),
      filePath,
      mtimeMs: fs.statSync(filePath).mtimeMs,
    }));
    const directoryEntries = fs.readdirSync(TEMP_DIR);

    expect(checkGeneratedClientFiles(routes, TEMP_DIR)).toEqual([]);
    expect(fs.readdirSync(TEMP_DIR)).toEqual(directoryEntries);
    expect(
      before.map(({ filePath }) => ({
        content: fs.readFileSync(filePath),
        filePath,
        mtimeMs: fs.statSync(filePath).mtimeMs,
      })),
    ).toEqual(before);
  });

  it("reports drift only for generator-owned outputs", () => {
    const routes = [
      createBasicRoute(),
      {
        ...createBasicRoute(),
        controllerName: "ZuluController",
        methodName: "listZulu",
        path: "/zulu",
      },
    ];
    generateClientFiles(routes, TEMP_DIR);
    fs.appendFileSync(path.join(TEMP_DIR, "user.ts"), "// drift\n");
    fs.rmSync(path.join(TEMP_DIR, "rpc.ts"));
    fs.writeFileSync(path.join(TEMP_DIR, "stale.ts"), "export {};\n");

    expect(checkGeneratedClientFiles([createBasicRoute()], TEMP_DIR)).toEqual([
      { filePath: path.join(TEMP_DIR, "index.ts"), status: "changed" },
      { filePath: path.join(TEMP_DIR, "rpc.ts"), status: "missing" },
      { filePath: path.join(TEMP_DIR, "user.ts"), status: "changed" },
      { filePath: path.join(TEMP_DIR, "zulu.ts"), status: "unexpected" },
    ]);
  });

  it("prunes stale generator-owned files and empty directories while preserving unrelated files", () => {
    const frontendActionManifestPath = path.join(TEMP_DIR, "actions", "manifest.json");
    const unrelatedPath = path.join(TEMP_DIR, "notes", "user-authored.ts");
    const unrelatedEmptyDirectory = path.join(TEMP_DIR, "user-empty-directory");
    const routes = [
      createBasicRoute(),
      {
        ...createBasicRoute(),
        controllerName: "AdminController",
        methodName: "listAdmins",
        path: "/admins",
      },
    ];
    const renamedRoute: RouteIR = {
      ...createBasicRoute(),
      controllerName: "AccountController",
      methodName: "listAccounts",
      path: "/accounts",
    };

    generateClientFiles(routes, TEMP_DIR, { frontendActionManifestPath });
    fs.mkdirSync(path.dirname(unrelatedPath), { recursive: true });
    fs.mkdirSync(unrelatedEmptyDirectory);
    fs.writeFileSync(unrelatedPath, "export const owner = 'user';\n");

    generateClientFiles([renamedRoute], TEMP_DIR);

    expect(fs.existsSync(path.join(TEMP_DIR, "admin.ts"))).toBe(false);
    expect(fs.existsSync(path.join(TEMP_DIR, "user.ts"))).toBe(false);
    expect(fs.existsSync(path.join(TEMP_DIR, "account.ts"))).toBe(true);
    expect(fs.existsSync(frontendActionManifestPath)).toBe(false);
    expect(fs.existsSync(path.dirname(frontendActionManifestPath))).toBe(false);
    expect(fs.readFileSync(unrelatedPath, "utf8")).toBe("export const owner = 'user';\n");
    expect(fs.existsSync(unrelatedEmptyDirectory)).toBe(true);
    expect(checkGeneratedClientFiles([renamedRoute], TEMP_DIR)).toEqual([]);
  });

  it("bootstraps legacy generated ownership when the sidecar is missing", () => {
    const routes = [
      createBasicRoute(),
      {
        ...createBasicRoute(),
        controllerName: "AdminController",
        methodName: "listAdmins",
        path: "/admins",
      },
    ];

    generateClientFiles(routes, TEMP_DIR);
    fs.rmSync(path.join(TEMP_DIR, ".croco-rpc-codegen.json"));

    generateClientFiles([createBasicRoute()], TEMP_DIR);

    expect(fs.existsSync(path.join(TEMP_DIR, "admin.ts"))).toBe(false);
    expect(checkGeneratedClientFiles([createBasicRoute()], TEMP_DIR)).toEqual([]);
  });

  it("does not claim an unmarked empty module as generated ownership", () => {
    const indexPath = path.join(TEMP_DIR, "index.ts");

    fs.writeFileSync(indexPath, "export {};\n");
    const before = collectDirectoryContents(TEMP_DIR);

    expect(() => generateClientFiles([createBasicRoute()], TEMP_DIR)).toThrow(
      `Cannot recover generated output ownership in '${TEMP_DIR}' because the legacy rpc.ts and index.ts topology is incomplete.`,
    );
    expect(collectDirectoryContents(TEMP_DIR)).toEqual(before);
  });

  it("bootstraps frontend-problems generated ownership when the sidecar is missing", () => {
    const options = { problemRuntime: "frontend-problems" } as const;
    const routes = [
      createBasicRoute(),
      {
        ...createBasicRoute(),
        controllerName: "AdminController",
        methodName: "listAdmins",
        path: "/admins",
      },
    ];

    generateClientFiles(routes, TEMP_DIR, options);
    fs.rmSync(path.join(TEMP_DIR, ".croco-rpc-codegen.json"));

    generateClientFiles([createBasicRoute()], TEMP_DIR, options);

    expect(fs.existsSync(path.join(TEMP_DIR, "admin.ts"))).toBe(false);
    expect(checkGeneratedClientFiles([createBasicRoute()], TEMP_DIR, options)).toEqual([]);
  });

  it("leaves previous generated outputs intact when validation fails", () => {
    generateClientFiles([createBasicRoute()], TEMP_DIR);
    const before = collectDirectoryContents(TEMP_DIR);
    const invalidRoute: RouteIR = {
      ...createBasicRoute(),
      controllerName: "HooksController",
      methodName: "handleHook",
      httpMethod: "ALL",
      path: "/hooks/:id",
      params: [{ kind: "path", name: "id", schema: null }],
      inputSchemas: PATH_INPUT_SCHEMAS,
    };

    expect(() => generateClientFiles([invalidRoute], TEMP_DIR)).toThrow(
      "Cannot generate RPC client for @All route HooksController.handleHook (/hooks/:id)",
    );
    expect(collectDirectoryContents(TEMP_DIR)).toEqual(before);
  });

  it("rejects a generated path that would overwrite an unrelated file", () => {
    const unrelatedPath = path.join(TEMP_DIR, "account.ts");
    const route: RouteIR = {
      ...createBasicRoute(),
      controllerName: "AccountController",
      methodName: "listAccounts",
      path: "/accounts",
    };

    fs.writeFileSync(unrelatedPath, "export const owner = 'user';\n");
    const before = collectDirectoryContents(TEMP_DIR);

    expect(() => generateClientFiles([route], TEMP_DIR)).toThrow(
      `Generated output path '${unrelatedPath}' already contains an unrelated file.`,
    );
    expect(collectDirectoryContents(TEMP_DIR)).toEqual(before);
  });

  it("replaces case-only renamed generated files without deleting the new output", () => {
    const previousRoute: RouteIR = {
      ...createBasicRoute(),
      controllerName: "APIController",
      methodName: "listAPI",
      path: "/api",
    };
    const renamedRoute: RouteIR = {
      ...createBasicRoute(),
      controllerName: "ApiController",
      methodName: "listApi",
      path: "/api",
    };

    generateClientFiles([previousRoute], TEMP_DIR);
    generateClientFiles([renamedRoute], TEMP_DIR);

    expect(fs.readdirSync(TEMP_DIR)).not.toContain("aPI.ts");
    expect(fs.readdirSync(TEMP_DIR)).toContain("api.ts");
    expect(checkGeneratedClientFiles([renamedRoute], TEMP_DIR)).toEqual([]);
  });

  it("rejects unsafe ownership paths without changing existing outputs", () => {
    generateClientFiles([createBasicRoute()], TEMP_DIR);
    const ownershipManifestPath = path.join(TEMP_DIR, ".croco-rpc-codegen.json");

    fs.writeFileSync(
      ownershipManifestPath,
      JSON.stringify({
        schemaVersion: "croco.rpc-codegen-ownership.v1",
        files: ["../outside.ts"],
        directories: [],
      }),
    );
    const before = collectDirectoryContents(TEMP_DIR);

    expect(() => generateClientFiles([createBasicRoute()], TEMP_DIR)).toThrow(
      `Generated output ownership manifest '${ownershipManifestPath}' contains unsafe path '../outside.ts'.`,
    );
    expect(collectDirectoryContents(TEMP_DIR)).toEqual(before);
  });

  it("validates every stale target before deleting any generated file", () => {
    const routes = [
      createBasicRoute(),
      {
        ...createBasicRoute(),
        controllerName: "AdminController",
        methodName: "listAdmins",
        path: "/admins",
      },
      {
        ...createBasicRoute(),
        controllerName: "ZuluController",
        methodName: "listZulu",
        path: "/zulu",
      },
    ];
    const zuluPath = path.join(TEMP_DIR, "zulu.ts");

    generateClientFiles(routes, TEMP_DIR);
    fs.rmSync(zuluPath);
    fs.mkdirSync(zuluPath);

    expect(() => generateClientFiles([createBasicRoute()], TEMP_DIR)).toThrow(
      `Generated output ownership manifest '${path.join(TEMP_DIR, ".croco-rpc-codegen.json")}' path 'zulu.ts' refers to a directory.`,
    );
    expect(fs.existsSync(path.join(TEMP_DIR, "admin.ts"))).toBe(true);
    expect(fs.statSync(zuluPath).isDirectory()).toBe(true);
  });

  it("keeps unrelated generated-looking files outside the recorded ownership", () => {
    const unrelatedDirectory = path.join(TEMP_DIR, "notes");
    const unrelatedPath = path.join(unrelatedDirectory, "index.ts");

    generateClientFiles([createBasicRoute()], TEMP_DIR);
    fs.mkdirSync(unrelatedDirectory);
    fs.writeFileSync(unrelatedPath, "export * from './rpc';\nexport * as notes from './notes';\n");

    generateClientFiles([createBasicRoute()], TEMP_DIR);

    expect(fs.readFileSync(unrelatedPath, "utf8")).toBe(
      "export * from './rpc';\nexport * as notes from './notes';\n",
    );
  });

  it("reserves the ownership manifest path without case-sensitive aliases", () => {
    const aliasedManifestPath = path.join(TEMP_DIR, ".CROCO-RPC-CODEGEN.JSON");

    expect(() =>
      generateClientFiles([createBasicRoute()], TEMP_DIR, {
        frontendActionManifestPath: aliasedManifestPath,
      }),
    ).toThrow(
      `Generated output path '${aliasedManifestPath}' conflicts with the reserved ownership manifest.`,
    );
    expect(fs.readdirSync(TEMP_DIR)).toEqual([]);
  });

  it("should generate a GET fetch client", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "list",
        httpMethod: "GET",
        path: "/users",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    expect(files).toEqual([
      path.join(TEMP_DIR, "user.ts"),
      path.join(TEMP_DIR, "rpc.ts"),
      path.join(TEMP_DIR, "index.ts"),
    ]);
    const content = fs.readFileSync(files[0], "utf-8");
    const rpcContent = fs.readFileSync(path.join(TEMP_DIR, "rpc.ts"), "utf-8");
    expect(content).toContain("export function createUserClient(config: RpcClientConfig = {})");
    expect(content).toContain("export const userClient = createUserClient();");
    expect(content).toContain("export const userContractRoutes = [");
    expect(content).toContain(
      "{ routeId: 'UserController.list', operationId: 'UserController_list', methodName: 'list', method: 'GET', path: '/users' }",
    );
    expect(content).toContain(
      "import { createRpcClientRequest, handleRpcRequestError, handleRpcRequestResultError, readOptionalJsonResponse, readOptionalJsonResult } from './rpc';\nimport type { RpcClientConfig, RpcClientRequestOptions, RpcClientResult, RpcDeclaredProblem, RpcProblemDetailsFor } from './rpc';",
    );
    expect(rpcContent).toContain("export class RpcClientProblemError extends Error");
    expect(rpcContent).toContain("export class RpcClientResponseError extends Error");
    expect(rpcContent).toContain("if (isRpcProblemDetails(body))");
    expect(content).not.toContain("async function handleJsonResponse<T = unknown>");
    expect(content).toContain(
      "list: (options?: RpcClientRequestOptions): Promise<unknown | undefined> => {",
    );
    expect(content).toContain(
      "const request = createRpcClientRequest(userContractRoutes[0], 'query', '/users', { method: 'GET' }, options, config);",
    );
    expect(content).toContain(
      "readOptionalJsonResult<ListProblem>(response, listProblemDeclarations, request.telemetry)",
    );
  });

  it("should preserve contract graph route id, operation id, schemas, and Problem metadata", () => {
    const graph: ContractGraph = {
      version: "croco.contract-graph.v1",
      controllers: [
        {
          name: "UsersController",
          path: "/users",
          guards: [],
          roles: [],
          routeIds: ["UsersController.getUser"],
        },
      ],
      routes: [
        {
          routeId: "UsersController.getUser",
          operationId: "UsersController_getUser",
          controllerName: "UsersController",
          methodName: "getUser",
          httpMethod: "GET",
          path: "/users/:id",
          controllerPath: "/users",
          routeContract: null,
          params: [{ kind: "path", name: "id", schema: null }],
          inputSchema: null,
          inputSchemas: PATH_INPUT_SCHEMAS,
          outputSchema: z.object({ id: z.string() }) as unknown as RouteIR["outputSchema"],
          domain: null,
          access: { guards: [], roles: [] },
          entitlements: [],
          problemResponses: [
            {
              code: "USER_NOT_FOUND",
              category: ProblemCategory.NotFound,
              status: 404,
              description: "User id is missing, or the user was deleted.",
            },
          ],
        },
      ],
      diagnostics: [],
    };

    const files = generateClientFilesFromContractGraph(graph, TEMP_DIR);
    const content = fs.readFileSync(files[0], "utf-8");

    expect(content).toContain(
      "{ routeId: 'UsersController.getUser', operationId: 'UsersController_getUser', methodName: 'getUser', method: 'GET', path: '/users/:id' }",
    );
    expect(content).toContain("export type GetUserInput = { path: { id: string; }; };");
    expect(content).toContain("export type GetUserOutput = { id: string; };");
    expect(content).toContain(
      "export type GetUserProblem = RpcDeclaredProblem<'USER_NOT_FOUND', 'NotFound', 404>;",
    );
    expect(content).toContain(
      "{ code: 'USER_NOT_FOUND', category: 'NotFound', status: 404, description: 'User id is missing, or the user was deleted.' }",
    );
    expect(content).not.toContain("lifecycle");
    expect(content).not.toContain("deprecation");
  });

  it("leaves existing generated outputs byte-for-byte unchanged when graph coverage fails", () => {
    generateClientFiles([createBasicRoute()], TEMP_DIR);
    const before = collectDirectoryContents(TEMP_DIR);
    const graph = createDuplicateRouteIdContractGraph();

    expect(() => generateClientFilesFromContractGraph(graph, TEMP_DIR)).toThrow(
      "contract-consumer-duplicate-route",
    );
    expect(collectDirectoryContents(TEMP_DIR)).toEqual(before);
  });

  it("does not create an output directory before failed graph coverage validation", () => {
    const outDir = path.join(TEMP_DIR, "missing-output");
    const graph = createDuplicateRouteIdContractGraph();

    expect(() => generateClientFilesFromContractGraph(graph, outDir)).toThrow(
      "contract-consumer-duplicate-route",
    );
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("should emit a deterministic frontend action manifest for REST RPC routes", () => {
    const manifestPath = path.join(TEMP_DIR, "frontend-action-manifest.json");
    const graph: ContractGraph = {
      version: "croco.contract-graph.v1",
      controllers: [
        {
          name: "UsersController",
          path: "/users",
          guards: [],
          roles: [],
          routeIds: ["UsersController.createUser"],
        },
      ],
      routes: [
        {
          routeId: "UsersController.createUser",
          operationId: "UsersController_createUser",
          controllerName: "UsersController",
          methodName: "createUser",
          httpMethod: "POST",
          path: "/users",
          controllerPath: "/users",
          routeContract: null,
          params: [{ kind: "body", name: "", schema: null }],
          inputSchema: null,
          inputSchemas: BODY_INPUT_SCHEMAS,
          outputSchema: z.object({ id: z.string() }) as unknown as RouteIR["outputSchema"],
          domain: null,
          access: {
            guards: [
              {
                type: "rest.guard",
                id: "rest.guard:route:UsersController.createUser:0:constructor:SessionGuard",
                kind: "constructor",
                name: "SessionGuard",
                declaredAt: "route",
                owner: {
                  controllerName: "UsersController",
                  routeId: "UsersController.createUser",
                  methodName: "createUser",
                },
                index: 0,
              },
            ],
            roles: ["admin"],
          },
          entitlements: [
            {
              feature: "users.write",
              description: "Create users in the active tenant",
              resource: { type: "tenant", idParam: "tenantId" },
            },
          ],
          problemResponses: [
            {
              code: "USER_EXISTS",
              category: ProblemCategory.Conflict,
              status: 409,
              description: "The user already exists.",
              type: "https://example.com/problems/user-exists",
            },
          ],
        },
      ],
      diagnostics: [],
    };

    const files = generateClientFilesFromContractGraph(graph, TEMP_DIR, {
      frontendActionManifestPath: manifestPath,
    });
    const manifest = createFrontendActionManifestFromContractGraph(graph);
    const serialized = fs.readFileSync(manifestPath, "utf-8");

    expect(files).toEqual([
      path.join(TEMP_DIR, "users.ts"),
      path.join(TEMP_DIR, "rpc.ts"),
      path.join(TEMP_DIR, "index.ts"),
      manifestPath,
    ]);
    expect(serialized).toBe(JSON.stringify(manifest, null, 2) + "\n");
    expect(serialized).toMatchInlineSnapshot(`
      "{
        "schemaVersion": "croco.frontend-action-manifest.v1",
        "actions": [
          {
            "id": "rest:UsersController.createUser",
            "source": {
              "kind": "rest-rpc-route",
              "packageName": "@croco/rpc-codegen",
              "routeId": "UsersController.createUser",
              "operationId": "UsersController_createUser",
              "controllerName": "UsersController",
              "methodName": "createUser",
              "domain": "users"
            },
            "method": "POST",
            "path": "/users",
            "input": {
              "kind": "generated-type",
              "ref": "CreateUserInput",
              "locations": [
                "body"
              ]
            },
            "output": {
              "kind": "generated-type",
              "ref": "CreateUserOutput"
            },
            "problems": [
              {
                "code": "USER_EXISTS",
                "category": "Conflict",
                "status": 409,
                "description": "The user already exists.",
                "type": "https://example.com/problems/user-exists"
              }
            ],
            "permissions": {
              "guards": [
                {
                  "id": "rest.guard:route:UsersController.createUser:0:constructor:SessionGuard",
                  "name": "SessionGuard",
                  "owner": {
                    "controllerName": "UsersController",
                    "routeId": "UsersController.createUser",
                    "methodName": "createUser"
                  }
                }
              ],
              "roles": [
                "admin"
              ],
              "entitlements": [
                {
                  "feature": "users.write",
                  "description": "Create users in the active tenant",
                  "resource": {
                    "type": "tenant",
                    "idParam": "tenantId"
                  }
                }
              ]
            },
            "invalidates": [
              {
                "kind": "query-key-prefix",
                "target": "users",
                "reason": "mutation"
              }
            ]
          }
        ]
      }
      "
    `);
  });

  it("composes additional producer actions into the generated frontend action manifest", () => {
    const manifestPath = path.join(TEMP_DIR, "frontend-action-manifest.json");
    const metaViteAction: FrontendActionManifestEntry = {
      id: "server-action:signup",
      source: {
        kind: "meta-vite-server-action",
        packageName: "@croco/meta-vite",
        actionName: "signup",
      },
      method: "POST",
      path: "/api/action/signup",
      input: { kind: "none" },
      output: { kind: "none" },
      problems: [],
      permissions: { guards: [], roles: [], entitlements: [] },
      invalidates: [],
    };

    generateClientFiles([createBasicRoute()], TEMP_DIR, {
      frontendActionManifestPath: manifestPath,
      frontendActionManifestInputs: [
        {
          source: "@croco/meta-vite",
          manifest: createFrontendActionManifest([metaViteAction]),
        },
      ],
    });

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      readonly actions: readonly { readonly id: string }[];
    };
    expect(manifest.actions.map(({ id }) => id)).toEqual([
      "rest:UserController.list",
      "server-action:signup",
    ]);
  });

  it("preserves an existing manifest when an additional producer schema is incompatible", () => {
    const manifestPath = path.join(TEMP_DIR, "frontend-action-manifest.json");
    const existing = "existing manifest\n";
    fs.writeFileSync(manifestPath, existing);

    expect(() =>
      generateClientFiles([createBasicRoute()], TEMP_DIR, {
        frontendActionManifestPath: manifestPath,
        frontendActionManifestInputs: [
          {
            source: "legacy producer",
            manifest: { schemaVersion: "croco.frontend-action-manifest.v0", actions: [] },
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "presentation-preset/frontend-action-manifest-invalid",
      }),
    );
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(existing);
  });

  it("should import the shared frontend Problem runtime when configured", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "createUser",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [{ kind: "body", name: "", schema: null }],
        inputSchema: null,
        inputSchemas: BODY_INPUT_SCHEMAS,
        outputSchema: z.object({ id: z.string() }) as unknown as RouteIR["outputSchema"],
        domain: null,
        problemResponses: [
          {
            code: "VALIDATION_FAILED",
            category: ProblemCategory.ValidationError,
            status: 422,
          },
        ],
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR, {
      problemRuntime: "frontend-problems",
    });
    const content = fs.readFileSync(files[0], "utf-8");
    const rpcContent = fs.readFileSync(path.join(TEMP_DIR, "rpc.ts"), "utf-8");

    expect(rpcContent).toContain("} from '@croco/frontend-problems';");
    expect(rpcContent).toContain("ProblemClientError as RpcClientProblemError");
    expect(rpcContent).toContain("ProblemStatusMismatchError as RpcClientStatusMismatchError");
    expect(rpcContent).toContain("ProblemDeclaration as RpcDeclaredProblem");
    expect(rpcContent).not.toContain("export class RpcClientProblemError extends Error");
    expect(rpcContent).not.toContain("function isRpcProblemDetails");
    expect(content).toContain(
      "import { createRpcClientRequest, handleRpcRequestError, handleRpcRequestResultError, handleJsonResponse, handleJsonResult, toRpcFormProblem, serializeRpcQueryKeyInput } from './rpc';\nimport type { RpcClientConfig, RpcClientRequestOptions, RpcClientResult, RpcDeclaredProblem, RpcDomainProblem, RpcFormFieldProblem, RpcFormGlobalProblem, RpcFormModel, RpcProblemDetailsFor, RpcValidationProblem } from './rpc';",
    );
    expect(content).toContain("export type CreateUserResult = RpcClientResult");
    assertGeneratedPackageTypechecks(["index.ts", "rpc.ts", "user.ts"]);
  }, 15_000);

  it("should validate React Query key factories without polluting generated route fingerprints", () => {
    const graph: ContractGraph = {
      version: "croco.contract-graph.v1",
      controllers: [
        {
          name: "UsersController",
          path: "/users",
          guards: [],
          roles: [],
          routeIds: ["UsersController.getUser", "UsersController.create", "UsersController.delete"],
        },
      ],
      routes: [
        {
          routeId: "UsersController.getUser",
          operationId: "UsersController_getUser",
          controllerName: "UsersController",
          methodName: "getUser",
          httpMethod: "GET",
          path: "/users/:id",
          controllerPath: "/users",
          routeContract: null,
          params: [{ kind: "path", name: "id", schema: null }],
          inputSchema: null,
          inputSchemas: PATH_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
          access: { guards: [], roles: [] },
          entitlements: [],
          problemResponses: [],
        },
        {
          routeId: "UsersController.create",
          operationId: "UsersController_create",
          controllerName: "UsersController",
          methodName: "create",
          httpMethod: "POST",
          path: "/users",
          controllerPath: "/users",
          routeContract: null,
          params: [{ kind: "body", name: "", schema: null }],
          inputSchema: null,
          inputSchemas: BODY_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
          access: { guards: [], roles: [] },
          entitlements: [],
          problemResponses: [],
        },
        {
          routeId: "UsersController.delete",
          operationId: "UsersController_delete",
          controllerName: "UsersController",
          methodName: "delete",
          httpMethod: "DELETE",
          path: "/users/:id",
          controllerPath: "/users",
          routeContract: null,
          params: [{ kind: "path", name: "id", schema: null }],
          inputSchema: null,
          inputSchemas: PATH_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
          access: { guards: [], roles: [] },
          entitlements: [],
          problemResponses: [],
        },
      ],
      diagnostics: [],
    };

    const files = generateClientFilesFromContractGraph(graph, TEMP_DIR, { reactQuery: true });
    const content = fs.readFileSync(files[0], "utf-8");

    expect(content).toContain(
      "create: { route: usersContractRoutes[1], invalidates: [usersKeys.all()] },",
    );
    expect(content).toContain(
      "delete: { route: usersContractRoutes[2], invalidates: [usersKeys.all()] },",
    );
  });

  it("should reject ALL routes instead of emitting invalid fetch methods", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "HooksController",
        methodName: "handleHook",
        httpMethod: "ALL",
        path: "/hooks/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      "Cannot generate RPC client for @All route HooksController.handleHook (/hooks/:id): @All is runtime-only and cannot be represented as a concrete generated client request. Use explicit HTTP method decorators for generated contracts.",
    );
    expect(fs.existsSync(path.join(TEMP_DIR, "hooks.ts"))).toBe(false);
  });

  it("should reject routes with more than one body parameter", () => {
    const bodySchema = z.object({
      name: z.string(),
    }) as unknown as RouteIR["inputSchema"];
    const auditSchema = z.object({
      auditId: z.string(),
    }) as unknown as RouteIR["inputSchema"];
    const routes: RouteIR[] = [
      {
        controllerName: "UsersController",
        methodName: "createUser",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [
          { kind: "body", name: "", schema: bodySchema },
          { kind: "body", name: "", schema: auditSchema },
        ],
        inputSchema: bodySchema,
        inputSchemas: BODY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      "Cannot generate RPC client for route UsersController.createUser (/users): generated contracts support one request body per route, but 2 @Body() parameters were found.",
    );
    expect(fs.existsSync(path.join(TEMP_DIR, "users.ts"))).toBe(false);
  });

  it("should reject path variables without matching path parameter metadata", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UsersController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      "Cannot generate RPC client for route UsersController.getUser (/users/:id): route path declares ':id' but no @Param(\"id\") metadata was found.",
    );
    expect(fs.existsSync(path.join(TEMP_DIR, "users.ts"))).toBe(false);
  });

  it("should reject path variables without matching generated path schemas", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UsersController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      "Cannot generate RPC client for route UsersController.getUser (/users/:id): route path declares ':id' but no generated path schema was found.",
    );
    expect(fs.existsSync(path.join(TEMP_DIR, "users.ts"))).toBe(false);
  });

  it("should reject generated path schemas without matching path variables", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UsersController",
        methodName: "listUsers",
        httpMethod: "GET",
        path: "/users",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      "Cannot generate RPC client for route UsersController.listUsers (/users): generated path schema declares 'id' but route path '/users' does not contain ':id'.",
    );
    expect(fs.existsSync(path.join(TEMP_DIR, "users.ts"))).toBe(false);
  });

  it("should serialize POST body input", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "create",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [{ kind: "body", name: "", schema: null }],
        inputSchema: null,
        inputSchemas: BODY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "create: (input: CreateInput, options?: RpcClientRequestOptions): Promise<unknown | undefined> =>",
    );
    expect(content).toContain(
      "const request = createRpcClientRequest(userContractRoutes[0], 'mutation', '/users', { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } }, options, config);",
    );
  });

  it("should generate clients from contract-first route IR", () => {
    const createUserSchema = z.object({ name: z.string() }) as unknown as RouteIR["inputSchema"];
    const userSchema = z.object({ id: z.string(), name: z.string() }) as unknown as
      | RouteIR["outputSchema"]
      | NonNullable<RouteIR["routeContract"]>["outputSchema"];
    const inputSchemas: RouteIR["inputSchemas"] = {
      body: createUserSchema,
      path: null,
      query: null,
      headers: null,
    };
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "create",
        httpMethod: "POST",
        path: "/users",
        routeContract: {
          id: "users.create",
          method: "POST",
          path: "/users",
          operationId: "createUser",
          inputSchemas,
          outputSchema: userSchema,
          problemResponsesDeclared: true,
          problemResponses: [],
        },
        params: [{ kind: "body", name: "", schema: createUserSchema }],
        inputSchema: createUserSchema,
        inputSchemas,
        outputSchema: userSchema,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);
    const content = fs.readFileSync(files[0], "utf-8");

    expect(content).toContain("export type CreateInput = { name: string; };");
    expect(content).toContain("export type CreateOutput = { id: string; name: string; };");
    expect(content).toContain(
      "create: (input: CreateInput, options?: RpcClientRequestOptions): Promise<CreateOutput> =>",
    );
    expect(content).toContain("handleJsonResponse<CreateOutput>(response, request.telemetry)");
  });

  it("should generate one file per controller domain", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "list",
        httpMethod: "GET",
        path: "/users",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
      {
        controllerName: "OrderController",
        methodName: "list",
        httpMethod: "GET",
        path: "/orders",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    expect(files).toEqual([
      path.join(TEMP_DIR, "order.ts"),
      path.join(TEMP_DIR, "user.ts"),
      path.join(TEMP_DIR, "rpc.ts"),
      path.join(TEMP_DIR, "index.ts"),
    ]);
    expect(fs.existsSync(path.join(TEMP_DIR, "user.ts"))).toBe(true);
    expect(fs.existsSync(path.join(TEMP_DIR, "order.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(TEMP_DIR, "index.ts"), "utf-8")).toBe(
      "export * from './rpc';\nexport { createOrderClient, orderClient, orderContractRoutes, orderKeys } from './order';\nexport { createUserClient, userClient, userContractRoutes, userKeys } from './user';\nexport type { OrderClient } from './order';\nexport type { UserClient } from './user';\nexport * as orderRpc from './order';\nexport * as userRpc from './user';\n",
    );
  });

  it("should generate a shared Project manifest bundle source reference", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "list",
        httpMethod: "GET",
        path: "/users",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR, {
      manifestBundlePath: ".croco/manifest/",
    });
    const manifestSource = fs.readFileSync(path.join(TEMP_DIR, "manifest-source.ts"), "utf-8");
    const indexSource = fs.readFileSync(path.join(TEMP_DIR, "index.ts"), "utf-8");

    expect(files).toEqual([
      path.join(TEMP_DIR, "user.ts"),
      path.join(TEMP_DIR, "rpc.ts"),
      path.join(TEMP_DIR, "manifest-source.ts"),
      path.join(TEMP_DIR, "index.ts"),
    ]);
    expect(manifestSource).toBe(`export const crocoManifestBundleSource = {
  schemaVersion: 'croco.rpc.manifest-source.v1',
  directory: '.croco/manifest',
  artifacts: {
    contractGraph: '.croco/manifest/contract-graph.json',
    problems: '.croco/manifest/problems.json',
    diGraph: '.croco/manifest/di-graph.json',
    runtime: '.croco/manifest/runtime.json',
    policies: '.croco/manifest/policies.json',
    providers: '.croco/manifest/providers.json',
  },
} as const;

export type CrocoManifestBundleSource = typeof crocoManifestBundleSource;
`);
    expect(indexSource).toContain(
      "export { crocoManifestBundleSource, type CrocoManifestBundleSource } from './manifest-source';",
    );
    assertGeneratedPackageTypechecks(["index.ts", "rpc.ts", "manifest-source.ts", "user.ts"]);
  });

  it("should reject generated Result method names that collide with route methods", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "user",
      },
      {
        controllerName: "UserController",
        methodName: "getResult",
        httpMethod: "GET",
        path: "/users/:id/result",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: null,
        domain: "user",
      },
    ];

    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      "Cannot generate RPC client for domain 'user': member 'getResult' would be generated for UserController.getResult (/users/:id/result) as a route method, but UserController.get (/users/:id) already generates that member as a result method.",
    );
  });

  it(
    "should generate a package barrel that typechecks with duplicate route type names",
    () => {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "get",
          httpMethod: "GET",
          path: "/users/:id",
          routeContract: null,
          params: [{ kind: "path", name: "id", schema: null }],
          inputSchema: null,
          inputSchemas: PATH_INPUT_SCHEMAS,
          outputSchema: z.object({
            id: z.string(),
          }) as unknown as RouteIR["outputSchema"],
          domain: "user",
        },
        {
          controllerName: "OrderController",
          methodName: "get",
          httpMethod: "GET",
          path: "/orders/:id",
          routeContract: null,
          params: [{ kind: "path", name: "id", schema: null }],
          inputSchema: null,
          inputSchemas: PATH_INPUT_SCHEMAS,
          outputSchema: z.object({
            id: z.string(),
          }) as unknown as RouteIR["outputSchema"],
          domain: "order",
        },
      ];

      generateClientFiles(routes, TEMP_DIR);

      assertGeneratedPackageTypechecks(["index.ts", "rpc.ts", "order.ts", "user.ts"]);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it("should generate React Query hooks when enabled", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "create",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [{ kind: "body", name: "", schema: null }],
        inputSchema: null,
        inputSchemas: BODY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR, { reactQuery: true });

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain("import { useMutation } from '@tanstack/react-query';");
    expect(content).toContain("import type { UseMutationOptions } from '@tanstack/react-query';");
    expect(content).toContain(
      "export function createUserMutations(client: UserClient = userClient)",
    );
    expect(content).toContain(
      "create: (rpc?: RpcClientRequestOptions): CreateMutationFactory => ({",
    );
    expect(content).toContain(
      "createResult: (rpc?: RpcClientRequestOptions): CreateResultMutationFactory => ({",
    );
    expect(content).toContain("export const userMutations = createUserMutations();");
    expect(content).toContain("mutationFn: (input: CreateInput) => client.create(input, rpc)");
    expect(content).toContain("export function useCreate<TContext = unknown>");
    expect(content).toContain("export function useCreateResult<TContext = unknown>");
    expect(content).toContain(
      "return useMutation<unknown | undefined, Error, CreateMutationVariables, TContext>({ ...userMutations.create(rpc), ...mutationOptions });",
    );
  });

  it(
    "should generate query key factories, invalidation manifests, and barrel exports",
    () => {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "list",
          httpMethod: "GET",
          path: "/users",
          routeContract: null,
          params: [{ kind: "query", name: "page", schema: null }],
          inputSchema: null,
          inputSchemas: QUERY_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
        },
        {
          controllerName: "UserController",
          methodName: "create",
          httpMethod: "POST",
          path: "/users",
          routeContract: null,
          params: [{ kind: "body", name: "", schema: null }],
          inputSchema: null,
          inputSchemas: BODY_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
        },
      ];

      const files = generateClientFiles(routes, TEMP_DIR);

      const content = fs.readFileSync(files[0], "utf-8");
      const indexContent = fs.readFileSync(path.join(TEMP_DIR, "index.ts"), "utf-8");
      expect(content).toContain("export const userKeys = {");
      expect(content).toContain("all: () => ['user'] as const,");
      expect(content).toContain(
        "list: (input: ListInput) => [...userKeys.all(), 'list', serializeRpcQueryKeyInput(input)] as const,",
      );
      expect(content).toContain(
        "create: (input: CreateInput) => [...userKeys.all(), 'create', serializeRpcQueryKeyInput(input)] as const,",
      );
      expect(content).toContain("export const userInvalidationManifest = {");
      expect(content).toContain(
        "create: { route: userContractRoutes[1], invalidates: [userKeys.all()] },",
      );
      expect(indexContent).toContain(
        "export { createUserClient, userClient, userContractRoutes, userKeys, userInvalidationManifest } from './user';",
      );
      expect(indexContent).toContain("export type { UserClient } from './user';");
      assertGeneratedClientTypechecks(`${content}
const listKey = userKeys.list({ query: { page: '1' } });
const createInvalidationKey = userInvalidationManifest.create.invalidates[0];
const createInvalidationRouteId: 'UserController.create' = userInvalidationManifest.create.route.routeId;
void listKey;
void createInvalidationKey;
void createInvalidationRouteId;
`);
      assertGeneratedPackageTypechecks(["index.ts", "rpc.ts", "user.ts"]);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it("should serialize query key inputs deterministically and reject unsupported values", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "list",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [
          { kind: "path", name: "id", schema: null },
          { kind: "query", name: "page", schema: null },
          { kind: "header", name: "x-request-id", schema: null },
        ],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ id: z.string() }) as unknown as RouteIR["inputSchemas"]["path"],
          query: z.object({
            active: z.boolean().optional(),
            page: z.number(),
            search: z.string().optional(),
            tags: z.array(z.string().optional()),
          }) as unknown as RouteIR["inputSchemas"]["query"],
          headers: z.object({
            "x-request-id": z.string(),
          }) as unknown as RouteIR["inputSchemas"]["headers"],
        },
        outputSchema: null,
        domain: null,
      },
    ];

    generateClientFiles(routes, TEMP_DIR);

    const { RpcQueryKeyInputError, serializeRpcQueryKeyInput } = loadGeneratedRpcSupport();
    const serialized = serializeRpcQueryKeyInput({
      query: { search: undefined, tags: ["vip", undefined, "new"], page: 2, active: false },
      path: { id: "42" },
      headers: { "x-request-id": "abc" },
    });
    const serializedRecord = serialized as Record<string, unknown>;
    const serializedQuery = serializedRecord.query as Record<string, unknown>;

    expect(serialized).toEqual({
      headers: { "x-request-id": "abc" },
      path: { id: "42" },
      query: { active: false, page: 2, tags: ["vip", "new"] },
    });
    expect(Object.keys(serializedRecord)).toEqual(["headers", "path", "query"]);
    expect(Object.keys(serializedQuery)).toEqual(["active", "page", "tags"]);
    expect(serialized).toEqual(
      serializeRpcQueryKeyInput({
        query: { tags: ["vip", "new"], page: 2, active: false },
        path: { id: "42" },
        headers: { "x-request-id": "abc" },
      }),
    );

    const ordered = serializeRpcQueryKeyInput({
      z: true,
      a: true,
      _: true,
      A: true,
      "-": true,
    }) as Record<string, unknown>;

    expect(Object.keys(ordered)).toEqual(["-", "A", "_", "a", "z"]);
    const unsupportedValueError = captureThrownProblem(
      () => serializeRpcQueryKeyInput({ createdAt: new Date("2026-01-01T00:00:00.000Z") }),
      RpcQueryKeyInputError,
    );
    const finiteNumberError = captureThrownProblem(
      () => serializeRpcQueryKeyInput({ page: Number.NaN }),
      RpcQueryKeyInputError,
    );

    expect(unsupportedValueError).toMatchObject({
      category: ProblemCategory.ValidationError,
      code: "rpc-codegen/query-key-input-unsupported",
      path: "input.createdAt",
      status: 422,
    });
    expect(unsupportedValueError).toHaveProperty(
      "message",
      "RPC query key input only supports JSON-safe primitives, arrays, and plain objects; unsupported value at input.createdAt.",
    );
    expect(unsupportedValueError.toJSON()).toMatchObject({
      code: "rpc-codegen/query-key-input-unsupported",
      path: "input.createdAt",
      status: 422,
    });
    expect(finiteNumberError).toMatchObject({
      category: ProblemCategory.ValidationError,
      code: "rpc-codegen/query-key-input-unsupported",
      path: "input.page",
      status: 422,
    });
    expect(finiteNumberError).toHaveProperty(
      "message",
      "RPC query key input only supports finite numbers; unsupported value at input.page.",
    );
    expect(finiteNumberError.toJSON()).toMatchObject({
      code: "rpc-codegen/query-key-input-unsupported",
      path: "input.page",
      status: 422,
    });
  });

  it("should generate query input types from inputSchemas", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "list",
        httpMethod: "GET",
        path: "/users",
        routeContract: null,
        params: [{ kind: "query", name: "page", schema: null }],
        inputSchema: null,
        inputSchemas: QUERY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain("export type ListInput = { query: { page: string; }; };");
  });

  it("should generate path input types from inputSchemas", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain("export type GetInput = { path: { id: string; }; };");
  });

  it("should generate header input types from inputSchemas", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users",
        routeContract: null,
        params: [
          { kind: "header", name: "authorization", schema: null },
          { kind: "header", name: "x-tenant-id", schema: null },
        ],
        inputSchema: null,
        inputSchemas: HEADER_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "export type GetInput = { headers: { authorization: string; 'x-tenant-id'?: string | undefined; }; };",
    );
  });

  it("should align catch and union parameter types with array serialization", () => {
    const catchFirst = z.union([z.string().catch("fallback"), z.array(z.string())]);
    const catchLast = z.union([z.array(z.string()), z.string().catch("fallback")]);
    const routes: RouteIR[] = [
      {
        controllerName: "FilterController",
        methodName: "list",
        httpMethod: "GET",
        path: "/filters",
        routeContract: null,
        params: [
          {
            kind: "query",
            name: "catchArray",
            schema: z.array(z.string()).catch([]),
          },
          {
            kind: "query",
            name: "catchScalar",
            schema: z.string().catch("fallback"),
          },
          { kind: "query", name: "catchFirst", schema: catchFirst },
          { kind: "query", name: "catchLast", schema: catchLast },
          {
            kind: "header",
            name: "x-catch-array",
            schema: z.array(z.string()).catch([]),
          },
        ],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: null,
          query: z.object({
            catchArray: z.array(z.string()).catch([]),
            catchScalar: z.string().catch("fallback"),
            catchFirst,
            catchLast,
            defaulted: z.string().default("fallback"),
            optionalCatch: z.string().optional().catch("fallback"),
            optionalDefault: z.string().optional().default("fallback"),
            optionalNullable: z.string().optional().nullable(),
          }) as unknown as NonNullable<RouteIR["inputSchemas"]["query"]>,
          headers: z.object({
            "x-catch-array": z.array(z.string()).catch([]),
          }) as unknown as NonNullable<RouteIR["inputSchemas"]["headers"]>,
        },
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);
    const content = fs.readFileSync(files[0], "utf-8");

    expect(content).toContain(
      "export type ListInput = { query: { catchArray?: unknown; catchFirst?: string[] | unknown; catchLast?: string[] | unknown; catchScalar?: unknown; defaulted?: string | undefined; optionalCatch?: unknown; optionalDefault?: string | undefined; optionalNullable?: string | undefined | null; }; headers: { 'x-catch-array'?: unknown; }; };",
    );
    expect(content).toContain("params.append(key, String(item));");
    expect(content).toContain("serialized[key] = serializedValues.join(', ');");
    assertGeneratedClientTypechecks(`${content}
const result = filterClient.list({
  query: {
    catchArray: undefined,
    catchScalar: undefined,
    catchFirst: ['first', 'second'],
    catchLast: undefined,
  },
  headers: { 'x-catch-array': undefined },
});
// @ts-expect-error defaulted request inputs still reject non-string values.
filterClient.list({ query: { defaulted: 42 }, headers: {} });
void result;
`);
  });

  it("reports JSON-unsafe transformed path schemas before missing path field diagnostics", () => {
    const schema = z.object({ id: z.string() }).transform(({ id }) => ({ renamed: id }));
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getUser",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "renamed", schema: null, contractSchema: schema }],
        inputSchema: null,
        inputSchemas: { ...PATH_INPUT_SCHEMAS, path: schema },
        outputSchema: null,
        domain: null,
      },
    ];
    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      /contract-schema-json-unsafe.*Zod transform effects can change runtime values/,
    );
    expect(fs.readdirSync(TEMP_DIR)).toEqual([]);
  });

  it("should reject transformed response schemas instead of emitting the handler-return input", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getDisplayNameLength",
        httpMethod: "GET",
        path: "/users/:id/display-name-length",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: z
          .string()
          .transform((value) => value.length) as unknown as RouteIR["outputSchema"],
        domain: null,
      },
    ];

    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      /contract-schema-json-unsafe.*Zod transform effects can change runtime values/,
    );
  });

  it("should project nested default and catch wrappers according to output semantics", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "getPreferences",
        httpMethod: "GET",
        path: "/users/:id/preferences",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: z.object({
          optionalCatch: z.string().optional().catch("fallback"),
          optionalDefault: z.string().optional().default("fallback"),
          optionalNullable: z.string().optional().nullable(),
        }) as unknown as RouteIR["outputSchema"],
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);
    const content = fs.readFileSync(files[0], "utf-8");

    expect(content).toContain(
      "export type GetPreferencesOutput = { optionalCatch?: string | undefined; optionalDefault: string; optionalNullable?: string | undefined | null; };",
    );
  });

  it("should generate combined input types from inputSchemas", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "update",
        httpMethod: "PATCH",
        path: "/users/:id",
        routeContract: null,
        params: [
          { kind: "path", name: "id", schema: null },
          { kind: "query", name: "filter", schema: null },
          { kind: "body", name: "", schema: null },
        ],
        inputSchema: null,
        inputSchemas: COMBINED_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "export type UpdateInput = { body: { name: string; }; path: { id: string; }; query: { filter: string; }; };",
    );
  });

  it("should generate client DTOs from one route schema object", () => {
    const createUserRoute = defineRouteSchema({
      request: {
        body: z.object({
          name: z.string(),
          email: z.string().email(),
        }),
      },
      response: z.object({
        id: z.string(),
        name: z.string(),
        email: z.string().email(),
      }),
    });
    type CreateUserBody = InferRouteSchemaRequest<typeof createUserRoute>["body"];
    type CreateUserResponse = InferRouteSchemaResponse<typeof createUserRoute>;
    const validBody: CreateUserBody = { name: "Ada", email: "ada@example.com" };
    const validResponse: CreateUserResponse = {
      id: "user-1",
      name: validBody.name,
      email: validBody.email,
    };
    // @ts-expect-error DTO field types are inferred from the schema object.
    const invalidBody: CreateUserBody = { name: "Ada", email: 42 };
    const bodySchema = createUserRoute.request.body as unknown as NonNullable<
      RouteIR["inputSchemas"]["body"]
    >;
    const responseSchema = createUserRoute.response as unknown as NonNullable<
      RouteIR["outputSchema"]
    >;
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "createUser",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [{ kind: "body", name: "", schema: bodySchema }],
        inputSchema: bodySchema,
        inputSchemas: {
          body: bodySchema,
          path: null,
          query: null,
          headers: null,
        },
        outputSchema: responseSchema,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);
    const content = fs.readFileSync(files[0], "utf-8");

    expect(validResponse.id).toBe("user-1");
    expect(invalidBody).toBeDefined();
    expect(content).toContain("export type CreateUserInput = { email: string; name: string; };");
    expect(content).toContain(
      "export type CreateUserOutput = { email: string; id: string; name: string; };",
    );
    expect(content).toContain(
      "createUser: (input: CreateUserInput, options?: RpcClientRequestOptions): Promise<CreateUserOutput>",
    );
  });

  it("should generate output types from outputSchema", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain("export type GetOutput = { id: string; name: string; };");
    expect(content).toContain(
      "get: (input: GetInput, options?: RpcClientRequestOptions): Promise<GetOutput> =>",
    );
    expect(content).toContain("handleJsonResponse<GetOutput>(response, request.telemetry)");
    expect(content).not.toContain("readOptionalJsonResponse(response, request.telemetry)");
  });

  it(
    "should generate typed Problem result unions for exhaustive client handling",
    () => {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "get",
          httpMethod: "GET",
          path: "/users/:id",
          routeContract: null,
          params: [{ kind: "path", name: "id", schema: null }],
          inputSchema: null,
          inputSchemas: PATH_INPUT_SCHEMAS,
          outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
          problemResponses: [
            {
              code: "USER_NOT_FOUND",
              category: ProblemCategory.NotFound,
              status: 404,
              routeContractProblems: [
                {
                  code: "USER_NOT_FOUND",
                  category: ProblemCategory.NotFound,
                  status: 404,
                },
                {
                  code: "USER_FORBIDDEN",
                  category: ProblemCategory.Forbidden,
                  status: 403,
                },
              ],
            },
            {
              code: "USER_FORBIDDEN",
              category: ProblemCategory.Forbidden,
              status: 403,
            },
          ],
          domain: null,
        },
      ];

      const files = generateClientFiles(routes, TEMP_DIR);

      const content = fs.readFileSync(files[0], "utf-8");
      const source = `import { assertExhaustiveProblem } from './rpc';
${content}
async function exerciseGeneratedProblemResult() {
  const result = await userClient.getResult({ path: { id: 'missing' } });

  if (result.ok) {
    const userName: string = result.data.name;
    void userName;
    return;
  }

  if (result.kind === 'external') {
    if (result.response) {
      const externalStatus: number = result.response.status;
      void externalStatus;
    }
    return;
  }

  switch (result.code) {
    case 'USER_NOT_FOUND': {
      const code: 'USER_NOT_FOUND' = result.problem.code;
      const category: 'NotFound' = result.category;
      const status: 404 = result.status;
      void code;
      void category;
      void status;
      return;
    }
    case 'USER_FORBIDDEN': {
      const code: 'USER_FORBIDDEN' = result.problem.code;
      const category: 'Forbidden' = result.declaration.category;
      const status: 403 = result.problem.status;
      void code;
      void category;
      void status;
      return;
    }
    default:
      return assertExhaustiveProblem(result);
  }
}

function handleMissingProblemBranch(failure: Extract<GetResult, { ok: false; kind: 'problem' }>) {
  switch (failure.code) {
    case 'USER_NOT_FOUND':
      return failure.problem.detail;
    default:
      // @ts-expect-error USER_FORBIDDEN remains unhandled, so the default branch is not never.
      return assertExhaustiveProblem(failure);
  }
}

void exerciseGeneratedProblemResult;
void handleMissingProblemBranch;
`;

      expect(content).toContain(
        "import { createRpcClientRequest, handleRpcRequestError, handleRpcRequestResultError, handleJsonResponse, handleJsonResult, serializeRpcQueryKeyInput } from './rpc';\nimport type { RpcClientConfig, RpcClientRequestOptions, RpcClientResult, RpcDeclaredProblem, RpcProblemDetailsFor } from './rpc';",
      );
      expect(content).toContain(
        "export type GetProblem = RpcDeclaredProblem<'USER_NOT_FOUND', 'NotFound', 404> | RpcDeclaredProblem<'USER_FORBIDDEN', 'Forbidden', 403>;",
      );
      expect(content).toContain(
        "export type GetProblemDetails = RpcProblemDetailsFor<GetProblem>;",
      );
      expect(content).toContain("export type GetResult = RpcClientResult<GetOutput, GetProblem>;");
      expect(content).toContain(
        "getResult: (input: GetInput, options?: RpcClientRequestOptions): Promise<GetResult> =>",
      );
      expect(content).toContain(
        "handleJsonResult<GetOutput, GetProblem>(response, getProblemDeclarations, request.telemetry)",
      );
      assertGeneratedClientTypechecks(source);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it("should return declared Problem responses as golden generated-client Result payloads", async () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        problemResponses: [
          {
            code: "USER_NOT_FOUND",
            category: ProblemCategory.NotFound,
            status: 404,
          },
        ],
        domain: null,
      },
    ];
    const problemBody = {
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "USER_NOT_FOUND",
      detail: "User was not found",
      instance: "/users/missing",
      requestId: "request-golden-rpc",
      traceId: "trace-golden-rpc",
    };
    const declaration = { code: "USER_NOT_FOUND", category: "NotFound", status: 404 };

    const response = new Response(JSON.stringify(problemBody), {
      status: 404,
      headers: { "Content-Type": "application/problem+json" },
    });
    const fetchCalls: { readonly url: string; readonly init: RequestInit }[] = [];

    generateClientFiles(routes, TEMP_DIR);
    const { userClient } = loadGeneratedUserClientSupport(async (url, init) => {
      fetchCalls.push({ url, init });

      return response;
    });

    const result = (await userClient.getResult({ path: { id: "missing" } })) as Record<
      string,
      unknown
    >;
    const { response: resultResponse, ...serializableResult } = result;

    expect(fetchCalls).toEqual([{ url: "/users/missing", init: { method: "GET" } }]);
    expect(resultResponse).toBe(response);
    expect(serializableResult).toEqual({
      ok: false,
      kind: "problem",
      code: "USER_NOT_FOUND",
      category: "NotFound",
      status: 404,
      problem: problemBody,
      declaration,
    });
  });

  it("should return undeclared Problem responses as golden external generated-client payloads", async () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: z.object({ id: z.string(), name: z.string() }) as any,
        problemResponses: [
          {
            code: "USER_NOT_FOUND",
            category: ProblemCategory.NotFound,
            status: 404,
          },
        ],
        domain: null,
      },
    ];
    const problemBody = {
      type: "about:blank",
      title: "Conflict",
      status: 409,
      code: "USER_EMAIL_CONFLICT",
      detail: "Email already exists",
      instance: "/users",
      requestId: "request-external-rpc",
      traceId: "trace-external-rpc",
    };
    const declaration = { code: "USER_NOT_FOUND", category: "NotFound", status: 404 };

    generateClientFiles(routes, TEMP_DIR);
    const { handleJsonResult, RpcClientProblemError } = loadGeneratedRpcSupport();
    const response = new Response(JSON.stringify(problemBody), {
      status: 409,
      headers: { "Content-Type": "application/problem+json" },
    });

    const result = (await handleJsonResult(response, [declaration])) as Record<string, unknown>;
    const { error, response: resultResponse, ...serializableResult } = result;

    expect(resultResponse).toBe(response);
    expect(error).toBeInstanceOf(RpcClientProblemError);
    expect((error as InstanceType<GeneratedRpcProblemErrorConstructor>).problem).toEqual(
      problemBody,
    );
    expect(serializableResult).toEqual({
      ok: false,
      kind: "external",
      body: problemBody,
    });
  });

  it("should reject HTTP and Problem status mismatches in direct and Result clients", async () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: z.object({ id: z.string(), name: z.string() }),
        problemResponses: [
          {
            code: "USER_NOT_FOUND",
            category: ProblemCategory.NotFound,
            status: 404,
          },
        ],
        domain: null,
      },
    ];
    const problemBody = {
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "USER_NOT_FOUND",
      detail: "User missing",
    };
    const declaration = { code: "USER_NOT_FOUND", category: "NotFound", status: 404 };

    generateClientFiles(routes, TEMP_DIR);
    const { handleJsonResponse, handleJsonResult, RpcClientStatusMismatchError } =
      loadGeneratedRpcSupport();
    const directResponse = new Response(JSON.stringify(problemBody), { status: 500 });
    const directRequest = handleJsonResponse(directResponse);

    await expect(directRequest).rejects.toBeInstanceOf(RpcClientStatusMismatchError);
    await expect(directRequest).rejects.toMatchObject({
      category: ProblemCategory.InternalServerError,
      code: "rpc-codegen/status-mismatch",
      httpStatus: 500,
      name: "RpcClientStatusMismatchError",
      problemStatus: 404,
      response: directResponse,
      status: 500,
    });
    await expect(directRequest).rejects.toBeInstanceOf(Problem);

    const resultResponse = new Response(JSON.stringify(problemBody), { status: 500 });
    const result = (await handleJsonResult(resultResponse, [declaration])) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({
      ok: false,
      kind: "external",
      body: problemBody,
      error: {
        category: ProblemCategory.InternalServerError,
        code: "rpc-codegen/status-mismatch",
        httpStatus: 500,
        name: "RpcClientStatusMismatchError",
        problemStatus: 404,
        status: 500,
      },
      response: resultResponse,
    });
  });

  it("should keep undeclared route Problem unions as never", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "list",
        httpMethod: "GET",
        path: "/users",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: z.array(z.object({ id: z.string() })) as unknown as RouteIR["outputSchema"],
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain("export type ListProblem = never;");
    expect(content).toContain("export type ListResult = RpcClientResult<ListOutput, ListProblem>;");
  });

  it("should generate JSON-safe literal, enum, union, and record output types", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "StatusController",
        methodName: "get",
        httpMethod: "GET",
        path: "/status",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: z.object({
          version: z.literal("status/v1"),
          status: z.enum(["up", "down"]),
          mode: z.union([z.literal("live"), z.literal("test")]),
          details: z.record(z.string(), z.unknown()),
        }) as unknown as RouteIR["outputSchema"],
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "export type GetOutput = { details: Record<string, unknown>; mode: 'live' | 'test'; status: 'down' | 'up'; version: 'status/v1'; };",
    );
  });

  it("should generate native enum output types without TypeScript reverse mappings", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "StatusController",
        methodName: "get",
        httpMethod: "GET",
        path: "/status",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: z.object({
          numeric: z.nativeEnum(NUMERIC_NATIVE_ENUM),
          mixed: z.nativeEnum(MIXED_NATIVE_ENUM),
        }) as unknown as RouteIR["outputSchema"],
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "export type GetOutput = { mixed: 0 | 'published'; numeric: 0 | 1; };",
    );
    expect(content).not.toContain("'Draft'");
    expect(content).not.toContain("'Published'");
  });

  it("should reject unsupported Zod schemas instead of emitting unknown fallbacks", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "StatusController",
        methodName: "get",
        httpMethod: "GET",
        path: "/status",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: z.object({
          checkedAt: z.date(),
        }) as unknown as RouteIR["outputSchema"],
        domain: null,
      },
    ];

    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      `${CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE} at checkedAt`,
    );
    expect(fs.existsSync(path.join(TEMP_DIR, "status.ts"))).toBe(false);
  });

  it("should reject records with non-string key schemas", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "StatusController",
        methodName: "get",
        httpMethod: "GET",
        path: "/status",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: z.record(z.number(), z.string()) as unknown as RouteIR["outputSchema"],
        domain: null,
      },
    ];

    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      `${CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE}: ZodRecord key schema ZodNumber is unsupported; use z.string() for JSON object keys.`,
    );
    expect(fs.existsSync(path.join(TEMP_DIR, "status.ts"))).toBe(false);
  });

  it("should not write earlier domain files when a later domain has an unsupported schema", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "AlphaController",
        methodName: "list",
        httpMethod: "GET",
        path: "/alpha",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: z.object({ id: z.string() }) as unknown as RouteIR["outputSchema"],
        domain: null,
      },
      {
        controllerName: "ZetaController",
        methodName: "get",
        httpMethod: "GET",
        path: "/zeta",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: z.object({
          checkedAt: z.date(),
        }) as unknown as RouteIR["outputSchema"],
        domain: null,
      },
    ];

    expect(() => generateClientFiles(routes, TEMP_DIR)).toThrow(
      `${CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE} at checkedAt`,
    );
    expect(fs.existsSync(path.join(TEMP_DIR, "alpha.ts"))).toBe(false);
    expect(fs.existsSync(path.join(TEMP_DIR, "zeta.ts"))).toBe(false);
    expect(fs.existsSync(path.join(TEMP_DIR, "rpc.ts"))).toBe(false);
    expect(fs.existsSync(path.join(TEMP_DIR, "index.ts"))).toBe(false);
  });

  it("should not emit zod references for body-only routes", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "create",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [{ kind: "body", name: "", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: z.object({ name: z.string() }) as any,
          path: null,
          query: null,
          headers: null,
        },
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).not.toContain("z.");
  });

  it("should use path input when generating path parameter fetch calls", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "const path = `/users/${encodeURIComponent(String(input.path.id))}`;",
    );
    expect(content).toContain(
      "const request = createRpcClientRequest(userContractRoutes[0], 'query', path, { method: 'GET' }, options, config);",
    );
    expect(content).toContain("readOptionalJsonResponse(response, request.telemetry)");
  });

  it(
    "should escape static and parameterized route paths into valid TypeScript string literals",
    () => {
      const staticRoute = (methodName: string, routePath: string): RouteIR => ({
        controllerName: "VectorController",
        methodName,
        httpMethod: "GET",
        path: routePath,
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      });
      const routes: RouteIR[] = [
        staticRoute("apostrophe", "/users/o'clock"),
        staticRoute("backslash", "/users/tea\\pot"),
        staticRoute("backtick", "/users/tick`tock"),
        staticRoute("interpolation", "/users/${literal}"),
        staticRoute("lineBreaks", "/lines/a\r\nb"),
        staticRoute("separators", "/lines/se\u2028p\u2029arator"),
        {
          controllerName: "VectorController",
          methodName: "apostropheParam",
          httpMethod: "GET",
          path: "/users/o'clock/:id",
          routeContract: null,
          params: [{ kind: "path", name: "id", schema: null }],
          inputSchema: null,
          inputSchemas: PATH_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
        },
        {
          controllerName: "VectorController",
          methodName: "backtickParam",
          httpMethod: "GET",
          path: "/tick`tock/:id",
          routeContract: null,
          params: [{ kind: "path", name: "id", schema: null }],
          inputSchema: null,
          inputSchemas: PATH_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
        },
      ];

      const files = generateClientFiles(routes, TEMP_DIR);

      const content = fs.readFileSync(files[0], "utf-8");
      expect(content).toContain(
        "createRpcClientRequest(vectorContractRoutes[0], 'query', '/users/o\\'clock', { method: 'GET' }, options, config);",
      );
      expect(content).toContain(
        "createRpcClientRequest(vectorContractRoutes[1], 'query', '/users/tea\\\\pot', { method: 'GET' }, options, config);",
      );
      expect(content).toContain(
        "createRpcClientRequest(vectorContractRoutes[2], 'query', '/users/tick\\`tock', { method: 'GET' }, options, config);",
      );
      expect(content).toContain(
        "createRpcClientRequest(vectorContractRoutes[3], 'query', '/users/\\${literal}', { method: 'GET' }, options, config);",
      );
      expect(content).toContain(
        "createRpcClientRequest(vectorContractRoutes[4], 'query', '/lines/a\\r\\nb', { method: 'GET' }, options, config);",
      );
      expect(content).toContain(
        "createRpcClientRequest(vectorContractRoutes[5], 'query', '/lines/se\\u2028p\\u2029arator', { method: 'GET' }, options, config);",
      );
      expect(content).toContain(
        "const path = `/users/o\\'clock/${encodeURIComponent(String(input.path.id))}`;",
      );
      expect(content).toContain(
        "const path = `/tick\\`tock/${encodeURIComponent(String(input.path.id))}`;",
      );
      assertGeneratedPackageTypechecks([
        "index.ts",
        "rpc.ts",
        ...files.map((filePath) => path.basename(filePath)),
      ]);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it("should preserve runtime request path bytes for escaped static and parameterized routes", async () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "list",
        httpMethod: "GET",
        path: "/users/o'clock",
        routeContract: null,
        params: [],
        inputSchema: null,
        inputSchemas: EMPTY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users/o'clock/:id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];
    const fetchCalls: { readonly url: string; readonly init: RequestInit }[] = [];

    generateClientFiles(routes, TEMP_DIR);
    const { userClient } = loadGeneratedUserClientSupport(async (url, init) => {
      fetchCalls.push({ url, init });

      return new Response(null, { status: 204 });
    });

    await userClient.getResult({ path: { id: "42" } });
    // Generated static-route members are not part of the shared support type.
    const clientWithStaticMember = userClient as unknown as {
      readonly list: () => Promise<unknown>;
    };
    await clientWithStaticMember.list();

    expect(fetchCalls.map(({ url }) => url)).toEqual(["/users/o'clock/42", "/users/o'clock"]);
  });

  it("should not rewrite path parameters with matching prefixes", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "PairController",
        methodName: "compare",
        httpMethod: "GET",
        path: "/pairs/:id/:id2",
        routeContract: null,
        params: [
          { kind: "path", name: "id", schema: null },
          { kind: "path", name: "id2", schema: null },
        ],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({
            id: z.string(),
            id2: z.string(),
          }) as unknown as NonNullable<RouteIR["inputSchemas"]["path"]>,
          query: null,
          headers: null,
        },
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "const path = `/pairs/${encodeURIComponent(String(input.path.id))}/${encodeURIComponent(String(input.path.id2))}`;",
    );
    expect(content).not.toContain("${encodeURIComponent(String(input.path.id))}2");
  });

  it("should bracket-access path parameters that are not JavaScript identifiers", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users/:user-id",
        routeContract: null,
        params: [{ kind: "path", name: "user-id", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: null,
          path: z.object({ "user-id": z.string() }) as unknown as NonNullable<
            RouteIR["inputSchemas"]["path"]
          >,
          query: null,
          headers: null,
        },
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "const path = `/users/${encodeURIComponent(String(input.path['user-id']))}`;",
    );
  });

  it("should normalize catch-all path parameters when generating fetch paths", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "AssetController",
        methodName: "get",
        httpMethod: "GET",
        path: "/assets/:...id",
        routeContract: null,
        params: [{ kind: "path", name: "id", schema: null }],
        inputSchema: null,
        inputSchemas: PATH_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "const path = `/assets/${encodeURIComponent(String(input.path.id))}`;",
    );
  });

  it.each([
    { label: "omitted query", query: undefined, headers: {}, omit: "query" },
    { label: "undefined query", query: undefined, headers: {} },
    { label: "null query", query: null, headers: {} },
    { label: "omitted headers", query: {}, headers: undefined, omit: "headers" },
    { label: "undefined headers", query: {}, headers: undefined },
    { label: "null headers", query: {}, headers: null },
    {
      label: "populated containers",
      query: {
        page: 0,
        active: false,
        search: "",
        missing: undefined,
        tags: ["new", undefined, "vip"],
        deletedAt: null,
      },
      headers: {
        "x-tags": ["new", undefined, "vip"],
        "x-missing": undefined,
        "x-null": null,
        "x-active": false,
      },
    },
  ])(
    "should serialize $label without losing request defaults",
    async ({ label, query, headers, omit }) => {
      const route: RouteIR = {
        ...createBasicRoute(),
        methodName: "get",
        httpMethod: "POST",
        inputSchemas: {
          ...BODY_HEADER_INPUT_SCHEMAS,
          query: z.object({
            page: z.number().optional(),
          }) as unknown as RouteIR["inputSchemas"]["query"],
        },
      };
      const fetchCalls: { readonly url: string; readonly init: RequestInit }[] = [];
      generateClientFiles([route], TEMP_DIR);
      const { userClient } = loadGeneratedUserClientSupport(async (url, init) => {
        fetchCalls.push({ url, init });
        return new Response(null, { status: 204 });
      });
      // Exercise JavaScript callers; generated TypeScript still requires the input containers.
      const client = userClient as unknown as Record<
        "get" | "getResult",
        (
          input: Record<string, unknown>,
          options: { headers: Record<string, string> },
        ) => Promise<unknown>
      >;
      const input = {
        body: { name: "Ada" },
        ...(omit === "query" ? {} : { query }),
        ...(omit === "headers" ? {} : { headers }),
      };
      for (const method of ["get", "getResult"] as const) {
        await client[method](input, { headers: { "x-default": "retained" } });
      }
      expect(fetchCalls).toHaveLength(2);
      for (const { url, init } of fetchCalls) {
        expect(url).toBe(
          label === "populated containers"
            ? "/users?page=0&active=false&search=&tags=new&tags=vip&deletedAt=null"
            : "/users",
        );
        expect(init.method).toBe("POST");
        expect(init.body).toBe(JSON.stringify({ name: "Ada" }));
        expect(Object.fromEntries(new Headers(init.headers))).toEqual({
          "content-type": "application/json",
          "x-default": "retained",
          ...(label === "populated containers"
            ? { "x-tags": "new, vip", "x-null": "null", "x-active": "false" }
            : {}),
        });
      }
    },
  );

  it("should serialize query input when generating query parameter fetch calls", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "list",
        httpMethod: "GET",
        path: "/users",
        routeContract: null,
        params: [{ kind: "query", name: "page", schema: null }],
        inputSchema: null,
        inputSchemas: QUERY_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "function serializeQueryParams(query: Record<string, unknown> | null | undefined): string",
    );
    expect(content).toContain("const query = serializeQueryParams(input.query);");
    expect(content).toContain("const url = query ? `${path}?${query}` : path;");
    expect(content).toContain(
      "const request = createRpcClientRequest(userContractRoutes[0], 'query', url, { method: 'GET' }, options, config);",
    );
    expect(content).toContain("readOptionalJsonResponse(response, request.telemetry)");
  });

  it("should serialize header input when generating fetch calls", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "get",
        httpMethod: "GET",
        path: "/users",
        routeContract: null,
        params: [
          { kind: "header", name: "authorization", schema: null },
          { kind: "header", name: "x-tenant-id", schema: null },
        ],
        inputSchema: null,
        inputSchemas: HEADER_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "function serializeHeaders(headers: Record<string, unknown> | null | undefined): Record<string, string>",
    );
    expect(content).toContain("serialized[key] = serializedValues.join(', ');");
    expect(content).toContain("const path = '/users';");
    expect(content).toContain(
      "const request = createRpcClientRequest(userContractRoutes[0], 'query', path, { method: 'GET', headers: serializeHeaders(input.headers) }, options, config);",
    );
  });

  it("should preserve generated headers when body routes set JSON content type", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "create",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [
          { kind: "body", name: "", schema: null },
          { kind: "header", name: "x-request-id", schema: null },
        ],
        inputSchema: null,
        inputSchemas: BODY_HEADER_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "export type CreateInput = { body: { name: string; }; headers: { 'x-request-id': string; }; };",
    );
    expect(content).toContain(
      "const request = createRpcClientRequest(userContractRoutes[0], 'mutation', path, { method: 'POST', body: JSON.stringify(input.body), headers: { ...serializeHeaders(input.headers), 'Content-Type': 'application/json' } }, options, config);",
    );
  });

  it(
    "should typecheck generated React Query factories, hooks, and Result variants",
    () => {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "get",
          httpMethod: "GET",
          path: "/users/:id",
          routeContract: null,
          params: [
            { kind: "path", name: "id", schema: null },
            { kind: "query", name: "page", schema: null },
            { kind: "header", name: "authorization", schema: null },
          ],
          inputSchema: null,
          inputSchemas: PATH_QUERY_HEADER_INPUT_SCHEMAS,
          outputSchema: z.object({
            id: z.string(),
            name: z.string(),
          }) as unknown as RouteIR["outputSchema"],
          problemResponses: [
            {
              code: "USER_NOT_FOUND",
              category: ProblemCategory.NotFound,
              status: 404,
            },
          ],
          domain: null,
        },
        {
          controllerName: "UserController",
          methodName: "create",
          httpMethod: "POST",
          path: "/users",
          routeContract: null,
          params: [
            { kind: "body", name: "", schema: null },
            { kind: "header", name: "x-request-id", schema: null },
          ],
          inputSchema: null,
          inputSchemas: BODY_HEADER_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
        },
      ];

      const files = generateClientFiles(routes, TEMP_DIR, { reactQuery: true });

      const content = fs.readFileSync(files[0], "utf-8");
      expect(content).toContain("import { useMutation, useQuery } from '@tanstack/react-query';");
      expect(content).toContain(
        "import type { UseMutationOptions, UseQueryOptions } from '@tanstack/react-query';",
      );
      expect(content).toContain(
        "export function createUserQueries(client: UserClient = userClient)",
      );
      expect(content).toContain("export const userQueries = createUserQueries();");
      expect(content).toContain("export type GetQueryKey = ReturnType<typeof userKeys.get>;");
      expect(content).toContain("queryKey: userKeys.get(input, cacheScope),");
      expect(content).toContain(
        "queryKey: [...userKeys.get(input, cacheScope), 'result'] as const,",
      );
      expect(content).not.toContain("queryKey: ['rpc', 'user', 'get'");
      expect(content).toContain(
        "getResult: (input: GetInput, cacheScope?: unknown, rpc?: RpcClientRequestOptions): GetResultQueryFactory => ({",
      );
      expect(content).toContain("queryFn: () => client.getResult(input, rpc),");
      expect(content).toContain("export function useGetResult<TData = GetResult>");
      expect(content).toContain(
        "export function createUserMutations(client: UserClient = userClient)",
      );
      expect(content).toContain("export const userMutations = createUserMutations();");
      expect(content).toContain(
        "createResult: (rpc?: RpcClientRequestOptions): CreateResultMutationFactory => ({",
      );
      expect(content).toContain(
        "return useQuery<GetResult, Error, TData, GetResultQueryKey>({ ...userQueries.getResult(input, cacheScope, rpc), ...queryOptions });",
      );
      expect(content).toContain(
        "return useMutation<CreateResult, Error, CreateMutationVariables, TContext>({ ...userMutations.createResult(rpc), ...mutationOptions });",
      );
      assertGeneratedReactQueryClientTypechecks(`${content}
const getInput: GetInput = {
  path: { id: 'user-1' },
  query: { page: '1' },
  headers: { authorization: 'Bearer token' },
};
const configuredClient = createUserClient({
  baseUrl: 'https://api.example.com',
  fetch: async () => new Response(null, { status: 204 }),
  headers: { authorization: 'Bearer default' },
  request: { credentials: 'include' },
});
const configuredQueries = createUserQueries(configuredClient);
const configuredMutations = createUserMutations(configuredClient);
const getFactory = userQueries.get(getInput, 'tenant:user-1');
const getKey: GetQueryKey = getFactory.queryKey;
const getResultFactory = userQueries.getResult(getInput, 'tenant:user-1');
const getResultKey: GetResultQueryKey = getResultFactory.queryKey;
const getResultPromise: Promise<GetResult> = getResultFactory.queryFn();

const selectedUserName = useGet(getInput, {
  cacheScope: 'tenant:user-1',
  staleTime: 1000,
  select: (user) => user.name,
});
const selectedNameData: string | undefined = selectedUserName.data;

const selectedResultProblemCode = useGetResult(getInput, {
  cacheScope: 'tenant:user-1',
  enabled: true,
  select: (result) => {
    if (result.ok) {
      return result.data.id;
    }

    if (result.kind === 'problem') {
      const code: 'USER_NOT_FOUND' = result.code;
      return code;
    }

    const requestError: unknown = result.error;
    void requestError;
    return result.response?.status ?? 'request-failure';
  },
});
const resultSelection: string | number | undefined = selectedResultProblemCode.data;

const createInput: CreateInput = {
  body: { name: 'Ada' },
  headers: { 'x-request-id': 'request-1' },
};
const createFactory = userMutations.create();
const createPromise: Promise<unknown | undefined> = createFactory.mutationFn(createInput);
const createResultFactory = userMutations.createResult();
const createResultPromise: Promise<CreateResult> = createResultFactory.mutationFn(createInput);
const configuredGetResultFactory: GetResultQueryFactory = configuredQueries.getResult(
  getInput,
  'tenant:user-1',
);
const configuredCreateResultFactory: CreateResultMutationFactory = configuredMutations.createResult();
const createHook = useCreate({
  onSuccess: (data, variables) => {
    const response: unknown | undefined = data;
    const name: string = variables.body.name;
    void response;
    void name;
  },
});
const createResultHook = useCreateResult({
  onSuccess: (result, variables) => {
    const resultBranch: CreateResult = result;
    const requestId: string = variables.headers['x-request-id'];
    void resultBranch;
    void requestId;
  },
});

void getKey;
void getResultKey;
void getResultPromise;
void selectedNameData;
void resultSelection;
void createPromise;
void createResultPromise;
void configuredGetResultFactory;
void configuredCreateResultFactory;
void createHook;
void createResultHook;
`);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it(
    "should typecheck generated clients with non-string query inputs",
    () => {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "list",
          httpMethod: "GET",
          path: "/users",
          routeContract: null,
          params: [
            { kind: "query", name: "page", schema: null },
            { kind: "query", name: "active", schema: null },
            { kind: "query", name: "search", schema: null },
            { kind: "query", name: "tags", schema: null },
            { kind: "query", name: "deletedAt", schema: null },
          ],
          inputSchema: null,
          inputSchemas: NON_STRING_QUERY_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
        },
      ];

      const files = generateClientFiles(routes, TEMP_DIR);

      const content = fs.readFileSync(files[0], "utf-8");
      expect(content).toContain(
        "export type ListInput = { query: { active?: boolean | undefined; deletedAt: string | null; page: number; search?: string | undefined; tags: string[]; }; };",
      );
      expect(content).toContain(
        "import { createRpcClientRequest, handleRpcRequestError, handleRpcRequestResultError, readOptionalJsonResponse, readOptionalJsonResult, serializeRpcQueryKeyInput } from './rpc';\nimport type { RpcClientConfig, RpcClientRequestOptions, RpcClientResult, RpcDeclaredProblem, RpcProblemDetailsFor } from './rpc';",
      );
      assertGeneratedClientTypechecks(`${content}
const result: Promise<unknown | undefined> = userClient.list({
  query: { page: 2, active: false, search: undefined, tags: ['new', 'vip'], deletedAt: null },
});
const resultBranch: Promise<ListResult> = userClient.listResult({
  query: { page: 2, active: false, search: undefined, tags: ['new', 'vip'], deletedAt: null },
});
void result;
void resultBranch;
`);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it(
    "should typecheck generated clients with header inputs",
    () => {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "get",
          httpMethod: "GET",
          path: "/users",
          routeContract: null,
          params: [
            { kind: "header", name: "authorization", schema: null },
            { kind: "header", name: "x-tenant-id", schema: null },
          ],
          inputSchema: null,
          inputSchemas: HEADER_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
        },
      ];

      const files = generateClientFiles(routes, TEMP_DIR);

      const content = fs.readFileSync(files[0], "utf-8");
      assertGeneratedClientTypechecks(`${content}
const result: Promise<unknown | undefined> = userClient.get({
  headers: { authorization: 'Bearer token', 'x-tenant-id': undefined },
});
void result;
`);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it(
    "should typecheck generated clients with readonly header array inputs",
    () => {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "get",
          httpMethod: "GET",
          path: "/users",
          routeContract: null,
          params: [{ kind: "header", name: "x-tags", schema: null }],
          inputSchema: null,
          inputSchemas: ARRAY_HEADER_INPUT_SCHEMAS,
          outputSchema: null,
          domain: null,
        },
      ];

      const files = generateClientFiles(routes, TEMP_DIR);
      const content = fs.readFileSync(files[0], "utf-8");

      expect(content).toContain(
        "export type GetInput = { headers: { 'x-tags': readonly string[]; }; };",
      );
      assertGeneratedClientTypechecks(`${content}
const result: Promise<unknown | undefined> = userClient.get({
  headers: { 'x-tags': ['new', 'vip'] as const },
});
void result;
`);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it(
    "should generate form models, submit payload builders, and typed form Problems from body schemas",
    () => {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "create",
          httpMethod: "POST",
          path: "/users",
          routeContract: null,
          params: [{ kind: "body", name: "", schema: null }],
          inputSchema: null,
          inputSchemas: {
            body: z.object({
              name: z.string().min(1),
              email: z.string().email(),
              role: z.enum(["admin", "viewer"]),
              receiveUpdates: z.boolean().optional(),
              retryCount: z.number().nullable(),
            }) as any,
            path: null,
            query: null,
            headers: null,
          },
          outputSchema: z.object({ id: z.string() }) as any,
          problemResponses: [
            {
              code: "USER_VALIDATION",
              category: ProblemCategory.ValidationError,
              status: 422,
            },
            {
              code: "USER_EMAIL_CONFLICT",
              category: ProblemCategory.Conflict,
              status: 409,
            },
          ],
          domain: null,
        },
      ];

      const files = generateClientFiles(routes, TEMP_DIR);

      const content = fs.readFileSync(files[0], "utf-8");
      expect(content).toContain(
        "import { createRpcClientRequest, handleRpcRequestError, handleRpcRequestResultError, handleJsonResponse, handleJsonResult, toRpcFormProblem, serializeRpcQueryKeyInput } from './rpc';\nimport type { RpcClientConfig, RpcClientRequestOptions, RpcClientResult, RpcDeclaredProblem, RpcDomainProblem, RpcFormFieldProblem, RpcFormGlobalProblem, RpcFormModel, RpcProblemDetailsFor, RpcValidationProblem } from './rpc';",
      );
      expect(content).toContain(
        "export type CreateFormFieldName = 'name' | 'email' | 'role' | 'receiveUpdates' | 'retryCount';",
      );
      expect(content).toContain(
        "export type CreateFormValues = { name: string; email: string; role: 'admin' | 'viewer'; receiveUpdates: boolean | null; retryCount: number | null; };",
      );
      expect(content).toContain("export type CreateSubmitPayload = CreateInput;");
      expect(content).toContain(
        "export type CreateFormProblem = RpcFormFieldProblem<CreateFormFieldName, CreateValidationProblem> | RpcFormGlobalProblem<CreateDomainProblem>;",
      );
      expect(content).toContain("export const createFormModel = {");
      expect(content).toContain(
        "{ name: 'role', label: 'Role', control: 'select', valueKind: 'enum', required: true, initialValue: 'admin', options: [{ label: 'admin', value: 'admin' }, { label: 'viewer', value: 'viewer' }] }",
      );
      expect(content).toContain(
        "initialValues: { name: '', email: '', role: 'admin', receiveUpdates: null, retryCount: null },",
      );
      expect(content).toContain(
        "export function buildCreateFormPayload(values: CreateFormValues): CreateSubmitPayload",
      );
      expect(content).toContain(
        "receiveUpdates: values.receiveUpdates === null ? undefined : values.receiveUpdates",
      );
      expect(content).toContain(
        "export function mapCreateFormProblem(failure: Extract<CreateResult, { ok: false; kind: 'problem' }>): CreateFormProblem",
      );
      assertGeneratedClientTypechecks(`${content}
const createValues: CreateFormValues = {
  ...createFormModel.initialValues,
  name: 'Ada',
  email: 'ada@example.com',
  role: 'admin',
};
const createPayload: CreateSubmitPayload = buildCreateFormPayload(createValues);

async function submitCreateForm() {
  const result = await userClient.createResult(createPayload);

  if (result.ok || result.kind === 'external') {
    return;
  }

  const formProblem = mapCreateFormProblem(result);
  switch (formProblem.kind) {
    case 'field-validation': {
      const emailErrors: readonly string[] | undefined = formProblem.fields.email;
      const code: 'USER_VALIDATION' = formProblem.code;
      void emailErrors;
      void code;
      return;
    }
    case 'global-problem': {
      const code: 'USER_EMAIL_CONFLICT' = formProblem.code;
      void code;
      return;
    }
  }
}

void submitCreateForm;
`);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it(
    "should generate context-aware submit payload builders for update body forms",
    () => {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "update",
          httpMethod: "PUT",
          path: "/users/:id",
          routeContract: null,
          params: [
            { kind: "path", name: "id", schema: null },
            { kind: "body", name: "", schema: null },
          ],
          inputSchema: null,
          inputSchemas: {
            body: z.object({ name: z.string(), email: z.string().email() }) as any,
            path: z.object({ id: z.string() }) as any,
            query: null,
            headers: null,
          },
          outputSchema: z.object({ id: z.string() }) as any,
          domain: null,
        },
      ];

      const files = generateClientFiles(routes, TEMP_DIR);

      const content = fs.readFileSync(files[0], "utf-8");
      expect(content).toContain(
        "export function buildUpdateFormPayload(context: Omit<UpdateInput, 'body'>, values: UpdateFormValues): UpdateSubmitPayload",
      );
      expect(content).toContain(
        "return { ...context, body: { name: values.name, email: values.email } };",
      );
      assertGeneratedClientTypechecks(`${content}
const updatePayload: UpdateSubmitPayload = buildUpdateFormPayload(
  { path: { id: 'user-1' } },
  { ...updateFormModel.initialValues, name: 'Ada', email: 'ada@example.com' },
);
const updateResult = userClient.update(updatePayload);
void updateResult;
`);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it(
    "should generate forms for refinement and catch wrapped array fields",
    () => {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "create",
          httpMethod: "POST",
          path: "/users",
          routeContract: null,
          params: [{ kind: "body", name: "", schema: null }],
          inputSchema: null,
          inputSchemas: {
            body: z.object({
              scopes: z.array(z.enum(["read", "write"])).catch([]),
              tags: z.array(z.string()).refine((tags) => tags.length > 0),
            }) as any,
            path: null,
            query: null,
            headers: null,
          },
          outputSchema: null,
          domain: null,
        },
      ];

      const files = generateClientFiles(routes, TEMP_DIR);
      const content = fs.readFileSync(files[0], "utf-8");

      expect(content).toContain(
        "export type CreateFormValues = { scopes: ('read' | 'write')[]; tags: string[]; };",
      );
      expect(content).toContain(
        "{ name: 'scopes', label: 'Scopes', control: 'multi-select', valueKind: 'array', required: true, initialValue: [], options: [{ label: 'read', value: 'read' }, { label: 'write', value: 'write' }] }",
      );
      expect(content).toContain(
        "{ name: 'tags', label: 'Tags', control: 'list', valueKind: 'array', required: true, initialValue: [] }",
      );
      assertGeneratedClientTypechecks(content);
    },
    GENERATED_CLIENT_TYPECHECK_TIMEOUT_MS,
  );

  it("should reject unsupported form body fields with a stable diagnostic and route context", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "create",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [{ kind: "body", name: "", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: z.object({
            name: z.string(),
            profile: z.object({ bio: z.string() }),
          }) as any,
          path: null,
          query: null,
          headers: null,
        },
        outputSchema: null,
        domain: null,
      },
    ];

    try {
      generateClientFiles(routes, TEMP_DIR);
      throw new Error("Expected form schema generation to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "rpc-codegen/unsupported-form-schema",
        detail:
          "Cannot generate RPC form model for route UserController.create (/users): field 'profile' uses unsupported form field schema ZodObject.",
      });
    }
    expect(fs.existsSync(path.join(TEMP_DIR, "user.ts"))).toBe(false);
  });

  it("should reject unsupported non-object form bodies with a stable diagnostic and route context", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "create",
        httpMethod: "POST",
        path: "/users",
        routeContract: null,
        params: [{ kind: "body", name: "", schema: null }],
        inputSchema: null,
        inputSchemas: {
          body: z.string() as any,
          path: null,
          query: null,
          headers: null,
        },
        outputSchema: null,
        domain: null,
      },
    ];

    try {
      generateClientFiles(routes, TEMP_DIR);
      throw new Error("Expected form schema generation to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "rpc-codegen/unsupported-form-schema",
        detail:
          "Cannot generate RPC form model for route UserController.create (/users): body uses unsupported form schema ZodString.",
      });
    }
    expect(fs.existsSync(path.join(TEMP_DIR, "user.ts"))).toBe(false);
  });

  it("should reject form body objects that accept dynamic keys", () => {
    const unsupportedBodies = [
      {
        schema: z.object({ name: z.string() }).passthrough(),
        mode: "passthrough",
      },
      {
        schema: z.object({ name: z.string() }).catchall(z.string()),
        mode: "catchall",
      },
    ];

    for (const { schema, mode } of unsupportedBodies) {
      const routes: RouteIR[] = [
        {
          controllerName: "UserController",
          methodName: "create",
          httpMethod: "POST",
          path: "/users",
          routeContract: null,
          params: [{ kind: "body", name: "", schema: null }],
          inputSchema: null,
          inputSchemas: {
            body: schema as any,
            path: null,
            query: null,
            headers: null,
          },
          outputSchema: null,
          domain: null,
        },
      ];

      try {
        generateClientFiles(routes, TEMP_DIR);
        throw new Error("Expected form schema generation to fail.");
      } catch (error) {
        expect(error).toMatchObject({
          code: "rpc-codegen/unsupported-form-schema",
          detail: `Cannot generate RPC form model for route UserController.create (/users): body object accepts unsupported ${mode} keys; generated form fields must cover every accepted body key.`,
        });
      }
      expect(fs.existsSync(path.join(TEMP_DIR, "user.ts"))).toBe(false);
    }
  });

  it("should serialize body, path, and query input when generating combined fetch calls", () => {
    const routes: RouteIR[] = [
      {
        controllerName: "UserController",
        methodName: "update",
        httpMethod: "PATCH",
        path: "/users/:id",
        routeContract: null,
        params: [
          { kind: "path", name: "id", schema: null },
          { kind: "query", name: "filter", schema: null },
          { kind: "body", name: "", schema: null },
        ],
        inputSchema: null,
        inputSchemas: COMBINED_INPUT_SCHEMAS,
        outputSchema: null,
        domain: null,
      },
    ];

    const files = generateClientFiles(routes, TEMP_DIR);

    const content = fs.readFileSync(files[0], "utf-8");
    expect(content).toContain(
      "const path = `/users/${encodeURIComponent(String(input.path.id))}`;",
    );
    expect(content).toContain("const query = serializeQueryParams(input.query);");
    expect(content).toContain("const url = query ? `${path}?${query}` : path;");
    expect(content).toContain(
      "const request = createRpcClientRequest(userContractRoutes[0], 'mutation', url, { method: 'PATCH', body: JSON.stringify(input.body), headers: { 'Content-Type': 'application/json' } }, options, config);",
    );
  });
});

function createBasicRoute(): RouteIR {
  return {
    controllerName: "UserController",
    methodName: "list",
    httpMethod: "GET",
    path: "/users",
    routeContract: null,
    params: [],
    inputSchema: null,
    inputSchemas: EMPTY_INPUT_SCHEMAS,
    outputSchema: null,
    domain: null,
  };
}

function createDuplicateRouteIdContractGraph(): ContractGraph {
  const userRoute = {
    ...createBasicRoute(),
    routeId: "SharedRoute.list",
    operationId: "UserController_list",
    controllerPath: "/users",
    access: { guards: [], roles: [] },
    entitlements: [],
    problemResponses: [],
  };
  const accountRoute = {
    ...userRoute,
    controllerName: "AccountController",
    methodName: "listAccounts",
    operationId: "AccountController_listAccounts",
    path: "/accounts",
    controllerPath: "/accounts",
  };

  return {
    version: "croco.contract-graph.v1",
    controllers: [
      {
        name: userRoute.controllerName,
        path: userRoute.controllerPath,
        guards: [],
        roles: [],
        routeIds: [userRoute.routeId],
      },
      {
        name: accountRoute.controllerName,
        path: accountRoute.controllerPath,
        guards: [],
        roles: [],
        routeIds: [accountRoute.routeId],
      },
    ],
    routes: [userRoute, accountRoute],
    diagnostics: [],
  };
}

function collectDirectoryContents(directory: string): ReadonlyMap<string, Buffer> {
  return new Map(
    fs
      .readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = path.join(entry.parentPath, entry.name);

        return [path.relative(directory, filePath), fs.readFileSync(filePath)];
      }),
  );
}

function assertGeneratedClientTypechecks(
  source: string,
  rpcSource = fs.readFileSync(path.join(TEMP_DIR, "rpc.ts"), "utf-8"),
): void {
  assertVirtualTypeScriptSourcesTypecheck(
    new Map([
      ["generated-client.ts", source],
      ["rpc.ts", rpcSource],
    ]),
    ["generated-client.ts"],
  );
}

function assertGeneratedReactQueryClientTypechecks(
  source: string,
  rpcSource = fs.readFileSync(path.join(TEMP_DIR, "rpc.ts"), "utf-8"),
): void {
  assertVirtualTypeScriptSourcesTypecheck(
    new Map([
      ["generated-client.ts", source],
      ["rpc.ts", rpcSource],
      [VIRTUAL_REACT_QUERY_MODULE, VIRTUAL_REACT_QUERY_SOURCE],
    ]),
    ["generated-client.ts"],
  );
}

function assertGeneratedPackageTypechecks(fileNames: readonly string[]): void {
  const sources = new Map(
    fileNames.map((fileName) => [
      fileName,
      fs.readFileSync(path.join(TEMP_DIR, fileName), "utf-8"),
    ]),
  );

  assertVirtualTypeScriptSourcesTypecheck(sources, fileNames);
}

function loadGeneratedRpcSupport(): {
  readonly RpcQueryKeyInputError: RpcQueryKeyInputProblemConstructor;
  readonly RpcClientProblemError: GeneratedRpcProblemErrorConstructor;
  readonly RpcClientStatusMismatchError: GeneratedRpcStatusMismatchErrorConstructor;
  readonly handleJsonResponse: GeneratedRpcHandleJsonResponse;
  readonly handleJsonResult: GeneratedRpcHandleJsonResult;
  readonly serializeRpcQueryKeyInput: (value: unknown) => unknown;
} {
  const rpcModule = loadGeneratedRpcModule();

  const RpcQueryKeyInputError = rpcModule.RpcQueryKeyInputError;
  const RpcClientProblemError = rpcModule.RpcClientProblemError;
  const RpcClientStatusMismatchError = rpcModule.RpcClientStatusMismatchError;
  const handleJsonResponse = rpcModule.handleJsonResponse;
  const handleJsonResult = rpcModule.handleJsonResult;
  const serializeRpcQueryKeyInput = rpcModule.serializeRpcQueryKeyInput;

  expect(RpcQueryKeyInputError).toBeTypeOf("function");
  expect(RpcClientProblemError).toBeTypeOf("function");
  expect(RpcClientStatusMismatchError).toBeTypeOf("function");
  expect(handleJsonResponse).toBeTypeOf("function");
  expect(handleJsonResult).toBeTypeOf("function");
  expect(serializeRpcQueryKeyInput).toBeTypeOf("function");

  return {
    RpcQueryKeyInputError: RpcQueryKeyInputError as RpcQueryKeyInputProblemConstructor,
    RpcClientProblemError: RpcClientProblemError as GeneratedRpcProblemErrorConstructor,
    RpcClientStatusMismatchError:
      RpcClientStatusMismatchError as GeneratedRpcStatusMismatchErrorConstructor,
    handleJsonResponse: handleJsonResponse as GeneratedRpcHandleJsonResponse,
    handleJsonResult: handleJsonResult as GeneratedRpcHandleJsonResult,
    serializeRpcQueryKeyInput: serializeRpcQueryKeyInput as (value: unknown) => unknown,
  };
}

function loadGeneratedRpcModule(fetchImpl?: GeneratedClientFetch): Record<string, unknown> {
  const rpcSource = fs.readFileSync(path.join(TEMP_DIR, "rpc.ts"), "utf-8");
  const outputText = ts.transpileModule(rpcSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context = {
    exports: {} as Record<string, unknown>,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    require(specifier: string): Record<string, unknown> {
      expect(specifier).toBe("@croco/problems-core");

      return { Problem, ProblemCategory };
    },
  };

  vm.runInNewContext(outputText, context);

  return context.exports;
}

function loadGeneratedUserClientSupport(
  fetchImpl: GeneratedClientFetch,
): GeneratedUserClientSupport {
  const rpcModule = loadGeneratedRpcModule(fetchImpl);
  const userSource = fs.readFileSync(path.join(TEMP_DIR, "user.ts"), "utf-8");
  const outputText = ts.transpileModule(userSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context = {
    exports: {} as Record<string, unknown>,
    fetch: fetchImpl,
    URLSearchParams,
    require(specifier: string): Record<string, unknown> {
      expect(specifier).toBe("./rpc");

      return rpcModule;
    },
  };

  vm.runInNewContext(outputText, context);

  const userClient = context.exports.userClient;
  expect(userClient).toBeTypeOf("object");
  expect((userClient as GeneratedUserClientSupport["userClient"]).getResult).toBeTypeOf("function");

  return { userClient: userClient as GeneratedUserClientSupport["userClient"] };
}

function captureThrownProblem(
  action: () => unknown,
  ErrorCtor: RpcQueryKeyInputProblemConstructor,
): Problem {
  const error = captureThrownError(action);

  expect(error).toBeInstanceOf(ErrorCtor);
  assertProblem(error);

  return error;
}

function captureThrownError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  expect.fail("Expected action to throw.");
}

function assertProblem(error: unknown): asserts error is Problem {
  expect(error).toBeInstanceOf(Problem);
}

function assertVirtualTypeScriptSourcesTypecheck(
  sources: ReadonlyMap<string, string>,
  rootFileNames: readonly string[],
): void {
  const virtualSources = new Map(sources);
  virtualSources.set(VIRTUAL_PROBLEMS_CORE_MODULE, VIRTUAL_PROBLEMS_CORE_SOURCE);
  const packagesDir = path.resolve(__dirname, "../../..");
  const compilerOptions: ts.CompilerOptions = {
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    paths: {
      "@croco/frontend-problems": [path.join(packagesDir, "frontend-problems/src/index.ts")],
      "@croco/problems-core": [path.join(packagesDir, "problems-core/src/index.ts")],
    },
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  };
  const host = ts.createCompilerHost(compilerOptions);

  host.getSourceFile = (name, languageVersion) => {
    const text = getVirtualSource(virtualSources, name);

    if (text !== undefined) {
      return ts.createSourceFile(name, text, languageVersion, true);
    }

    const fileText = ts.sys.readFile(name);

    return fileText === undefined
      ? undefined
      : ts.createSourceFile(name, fileText, languageVersion, true);
  };
  host.fileExists = (name) =>
    getVirtualSource(virtualSources, name) !== undefined || ts.sys.fileExists(name);
  host.readFile = (name) => getVirtualSource(virtualSources, name) ?? ts.sys.readFile(name);
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => {
      if (moduleName === "@croco/problems-core") {
        return {
          resolvedFileName: VIRTUAL_PROBLEMS_CORE_MODULE,
          extension: ts.Extension.Dts,
        };
      }

      if (
        moduleName === "@tanstack/react-query" &&
        getVirtualSource(virtualSources, VIRTUAL_REACT_QUERY_MODULE) !== undefined
      ) {
        return {
          resolvedFileName: VIRTUAL_REACT_QUERY_MODULE,
          extension: ts.Extension.Dts,
        };
      }

      return ts.resolveModuleName(moduleName, containingFile, compilerOptions, host).resolvedModule;
    });

  const program = ts.createProgram([...rootFileNames], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const messages = diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );

  expect(messages).toEqual([]);
}

function getVirtualSource(sources: ReadonlyMap<string, string>, name: string): string | undefined {
  const direct = sources.get(name);

  if (direct !== undefined) {
    return direct;
  }

  const basenameSource = sources.get(path.basename(name));

  if (basenameSource === undefined) {
    return undefined;
  }

  if (!path.isAbsolute(name)) {
    return path.dirname(name) === "." ? basenameSource : undefined;
  }

  return path.dirname(name) === process.cwd() ? basenameSource : undefined;
}
