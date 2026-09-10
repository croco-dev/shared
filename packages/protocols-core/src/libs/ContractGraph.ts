import "reflect-metadata";
import {
  createProblemRegistrySnapshot,
  Problem,
  ProblemCategory,
  ProblemRegistryValidationProblem,
  type PackageProblemRegistry,
  type PackageProblemRegistryEntry,
} from "@croco/problems-core";
import type { z } from "zod";
import { extractRouteIR } from "./extractRouteIR";
import type { ProblemRegistryReferenceIR, ProblemResponseIR, RouteIR } from "./RouteIR";
import {
  buildContractMonetizationGraph,
  CONTRACT_METERED_METADATA_KEY,
  type ContractMeteredMetadata,
  type ContractMonetizationGraph,
  type ContractMonetizationInput,
} from "./ContractGraphMonetization";
import {
  describeZodSchema,
  getSchemaDescriptorDiagnostics,
  getZodObjectShape,
} from "./SchemaDescriptor";
import {
  type Constructor,
  type ControllerMetadata,
  ENTITLEMENT_REQUIRED_KEY,
  ENTITLEMENT_REQUIREMENTS_KEY,
  type EntitlementRequirementMetadata,
  REST_CONTROLLER_KEY,
  REST_GUARDS_KEY,
  REST_ROLES_KEY,
} from "./sharedTypes";

export type ContractGraphVersion = "croco.contract-graph.v1";
export type ContractDiagnosticSeverity = "error" | "warning";
export type ContractDiagnosticTarget =
  | "graph"
  | "controller"
  | "route"
  | "param"
  | "schema"
  | "problem"
  | "monetization";

export type ContractDiagnostic = {
  readonly code: string;
  readonly severity: ContractDiagnosticSeverity;
  readonly target: ContractDiagnosticTarget;
  readonly message: string;
  readonly routeId?: string;
  readonly contractId?: string;
  readonly controllerName?: string;
  readonly methodName?: string;
  readonly path?: string;
  readonly sourceLocation?: ContractDiagnosticSourceLocation;
  readonly recoveryAction?: string;
};

export type ContractDiagnosticSourceLocation = {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
};

export type ContractGraphController = {
  readonly name: string;
  readonly path: string;
  readonly guards: readonly ContractMetadataReference[];
  readonly roles: readonly string[];
  readonly routeIds: readonly string[];
};

export type ContractMetadataReference = {
  readonly type: "rest.guard";
  readonly id: string;
  readonly kind: "constructor" | "instance";
  readonly name: string;
  readonly declaredAt: "controller" | "route";
  readonly owner: ContractMetadataOwner;
  readonly index: number;
};

export type ContractMetadataOwner = {
  readonly controllerName: string;
  readonly routeId?: string;
  readonly methodName?: string;
};

export type ContractAccessMetadata = {
  readonly guards: readonly ContractMetadataReference[];
  readonly roles: readonly string[];
};

export type ContractEntitlementResourceRequirement = {
  readonly type: string;
  readonly id?: string;
  readonly idParam?: string;
};

export type ContractEntitlementRequirement = {
  readonly feature: string;
  readonly description?: string;
  readonly resource?: ContractEntitlementResourceRequirement;
};

export type ContractPathParam = {
  readonly token: string;
  readonly name: string;
};

type RouteSchemaDiagnosticLocation = "body" | "path" | "query" | "headers" | "response";

type RouteSchemaDiagnosticEntry = {
  readonly schema: z.ZodType;
  readonly location: RouteSchemaDiagnosticLocation | string;
};

export type ContractGraphRoute = RouteIR & {
  readonly routeId: string;
  readonly operationId: string;
  readonly controllerPath: string;
  readonly access: ContractAccessMetadata;
  readonly entitlements: readonly ContractEntitlementRequirement[];
  readonly meter?: {
    readonly key: string;
    readonly descriptor?: ContractMeteredMetadata["meter"];
  };
};

export type BuildContractGraphOptions = {
  readonly strictProblemResponses?: boolean;
  readonly strictSchemas?: boolean;
  readonly problemRegistries?: readonly PackageProblemRegistry[];
  readonly monetization?: ContractMonetizationInput;
  /** Stable discovery diagnostics supplied by contract loaders before graph construction. */
  readonly monetizationDiagnostics?: readonly ContractDiagnostic[];
};

export type ContractGraph = {
  readonly version: ContractGraphVersion;
  readonly controllers: readonly ContractGraphController[];
  readonly routes: readonly ContractGraphRoute[];
  /** Present on graphs built by current Croco versions. Optional for source compatibility with legacy graph literals. */
  readonly monetization?: ContractMonetizationGraph;
  readonly diagnostics: readonly ContractDiagnostic[];
};

type ProblemRegistryIndex = {
  readonly enabled: boolean;
  readonly entriesByCode: ReadonlyMap<string, PackageProblemRegistryEntry>;
  readonly diagnostics: readonly ContractDiagnostic[];
};

export class ContractGraphDiagnosticError extends Problem {
  readonly diagnostics: readonly ContractDiagnostic[];

  constructor(diagnostics: readonly ContractDiagnostic[]) {
    super(
      "protocols-core/contract-graph-diagnostics",
      ProblemCategory.ValidationError,
      formatContractDiagnostics(diagnostics),
      { extensions: { diagnostics } },
    );
    this.diagnostics = diagnostics;
  }
}

export function buildContractGraph(
  controllers: readonly Constructor[],
  options: BuildContractGraphOptions = {},
): ContractGraph {
  const graphControllers: ContractGraphController[] = [];
  const graphRoutes: ContractGraphRoute[] = [];
  const diagnostics: ContractDiagnostic[] = [];
  const problemRegistryIndex = createProblemRegistryIndex(options.problemRegistries);

  diagnostics.push(...problemRegistryIndex.diagnostics);
  diagnostics.push(...(options.monetizationDiagnostics ?? []));

  for (const controller of controllers) {
    const controllerMeta = Reflect.getMetadata(REST_CONTROLLER_KEY, controller) as
      | ControllerMetadata
      | undefined;

    if (!controllerMeta) {
      continue;
    }

    const routes = extractRouteIR(controller).map((route) =>
      toContractGraphRoute(route, controllerMeta.path, controller, problemRegistryIndex),
    );

    graphControllers.push({
      name: controller.name,
      path: controllerMeta.path,
      guards: getMetadataReferences(
        Reflect.getMetadata(REST_GUARDS_KEY, controller),
        "controller",
        {
          controllerName: controller.name,
        },
      ),
      roles: getMetadataStrings(Reflect.getMetadata(REST_ROLES_KEY, controller)),
      routeIds: routes.map((route) => route.routeId),
    });
    graphRoutes.push(...routes);

    for (const route of routes) {
      diagnostics.push(...validateRoute(route, options, problemRegistryIndex));
    }
  }

  diagnostics.push(...validateUniqueControllerNames(graphControllers));
  diagnostics.push(...validateUniqueRouteIds(graphRoutes));
  diagnostics.push(...validateUniqueOperationIds(graphRoutes));
  const monetization = buildContractMonetizationGraph(graphRoutes, options.monetization);
  diagnostics.push(...monetization.diagnostics);

  return {
    version: "croco.contract-graph.v1",
    controllers: graphControllers,
    routes: graphRoutes,
    monetization: monetization.graph,
    diagnostics,
  };
}

export function getContractGraphErrors(graph: ContractGraph): readonly ContractDiagnostic[] {
  return graph.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}

export function assertContractGraphHasNoErrors(graph: ContractGraph): void {
  const errors = getContractGraphErrors(graph);

  if (errors.length > 0) {
    throw new ContractGraphDiagnosticError(errors);
  }
}

export function formatContractDiagnostics(diagnostics: readonly ContractDiagnostic[]): string {
  return diagnostics.map(formatContractDiagnostic).join("\n");
}

export function formatContractDiagnostic(diagnostic: ContractDiagnostic): string {
  const route = diagnostic.routeId ? ` ${diagnostic.routeId}` : "";
  const location = diagnostic.sourceLocation
    ? ` ${formatContractDiagnosticSourceLocation(diagnostic.sourceLocation)}`
    : "";

  const recovery = diagnostic.recoveryAction ? ` Recovery: ${diagnostic.recoveryAction}` : "";

  return `${diagnostic.severity.toUpperCase()} ${diagnostic.code}${route}${location}: ${diagnostic.message}${recovery}`;
}

export function getContractPathParamNames(path: string): string[] {
  return getContractPathParams(path).map((param) => param.name);
}

export function getContractPathParams(path: string): ContractPathParam[] {
  return [...path.matchAll(/:([^/]+)/g)]
    .flatMap((match) => {
      const token = match[1];
      if (!token) {
        return [];
      }

      const name = token.replace(/^\.\.\./, "");
      return name.length > 0 ? [{ token, name }] : [];
    })
    .filter((param) => param.name.length > 0);
}

function createProblemRegistryIndex(
  registries: readonly PackageProblemRegistry[] | undefined,
): ProblemRegistryIndex {
  if (!registries || registries.length === 0) {
    return {
      enabled: false,
      entriesByCode: new Map(),
      diagnostics: [],
    };
  }

  try {
    const snapshot = createProblemRegistrySnapshot(registries);

    return {
      enabled: true,
      entriesByCode: new Map(snapshot.problems.map((problem) => [problem.code, problem])),
      diagnostics: [],
    };
  } catch (error) {
    const errors =
      error instanceof ProblemRegistryValidationProblem
        ? error.errors
        : [`ProblemRegistry manifests could not be read: ${String(error)}`];

    return {
      enabled: false,
      entriesByCode: new Map(),
      diagnostics: errors.map((message) => ({
        code: "contract-graph-problem-registry-invalid",
        severity: "error",
        target: "graph",
        message,
      })),
    };
  }
}

function toContractGraphRoute(
  route: RouteIR,
  controllerPath: string,
  controllerCtor: Constructor,
  problemRegistryIndex: ProblemRegistryIndex,
): ContractGraphRoute {
  const routeId = `${route.controllerName}.${route.methodName}`;
  const problemResponses = attachProblemRegistryReferences(
    route.problemResponses,
    problemRegistryIndex.entriesByCode,
  );
  const routeContract = route.routeContract
    ? {
        ...route.routeContract,
        problemResponses: attachProblemRegistryReferences(
          route.routeContract.problemResponses,
          problemRegistryIndex.entriesByCode,
        ),
      }
    : null;

  return {
    ...route,
    routeContract,
    problemResponses,
    routeId,
    operationId: route.routeContract?.operationId ?? routeId.replace(/[^A-Za-z0-9_]+/g, "_"),
    controllerPath,
    access: {
      guards: [
        ...getMetadataReferences(
          Reflect.getMetadata(REST_GUARDS_KEY, controllerCtor),
          "controller",
          { controllerName: route.controllerName },
        ),
        ...getMetadataReferences(
          Reflect.getMetadata(REST_GUARDS_KEY, controllerCtor, route.methodName),
          "route",
          {
            controllerName: route.controllerName,
            methodName: route.methodName,
            routeId,
          },
        ),
      ],
      roles: [
        ...getMetadataStrings(Reflect.getMetadata(REST_ROLES_KEY, controllerCtor)),
        ...getMetadataStrings(
          Reflect.getMetadata(REST_ROLES_KEY, controllerCtor, route.methodName),
        ),
      ],
    },
    entitlements: [
      ...getEntitlementRequirements(controllerCtor),
      ...getEntitlementRequirements(controllerCtor.prototype),
      ...getEntitlementRequirements(controllerCtor, route.methodName),
      ...getEntitlementRequirements(controllerCtor.prototype, route.methodName),
    ],
    ...getMeteredRouteMetadata(controllerCtor, route.methodName),
  };
}

function getMeteredRouteMetadata(
  controllerCtor: Constructor,
  methodName: string,
): Pick<ContractGraphRoute, "meter"> {
  const metadata = Reflect.getMetadata(
    CONTRACT_METERED_METADATA_KEY,
    controllerCtor.prototype,
    methodName,
  ) as ContractMeteredMetadata | undefined;
  const key = metadata?.meter?.key ?? metadata?.meterId;

  return key ? { meter: { key, ...(metadata?.meter ? { descriptor: metadata.meter } : {}) } } : {};
}

function attachProblemRegistryReferences(
  responses: readonly ProblemResponseIR[] | undefined,
  entriesByCode: ReadonlyMap<string, PackageProblemRegistryEntry>,
): readonly ProblemResponseIR[] {
  if (!responses) {
    return [];
  }

  return responses.map((response) => {
    const entry = entriesByCode.get(response.code);
    const routeContractProblems = response.routeContractProblems
      ? attachProblemRegistryReferences(response.routeContractProblems, entriesByCode)
      : undefined;

    return {
      ...response,
      ...(entry ? { registry: toProblemRegistryReference(entry) } : {}),
      ...(routeContractProblems ? { routeContractProblems } : {}),
    };
  });
}

function toProblemRegistryReference(
  entry: PackageProblemRegistryEntry,
): ProblemRegistryReferenceIR {
  return {
    package: entry.package,
    code: entry.code,
    category: entry.category,
    status: entry.status,
    ...(entry.statusPolicy ? { statusPolicy: entry.statusPolicy } : {}),
    retryable: entry.retryable,
    retryability: entry.retryability,
    public: entry.public,
    visibility: entry.visibility,
    redaction: entry.redaction,
    cookbookPath: entry.cookbookPath,
  };
}

function validateRoute(
  route: ContractGraphRoute,
  options: BuildContractGraphOptions,
  problemRegistryIndex: ProblemRegistryIndex,
): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];

  if (route.httpMethod.toUpperCase() === "ALL") {
    diagnostics.push(
      createRouteDiagnostic(
        route,
        "contract-route-unsupported-all-method",
        "error",
        "@All is runtime-only and cannot be represented as a concrete generated contract. Use explicit HTTP method decorators for OpenAPI and typed clients.",
      ),
    );
  }

  diagnostics.push(...validatePathParams(route));
  diagnostics.push(...validateNamedParams(route));
  diagnostics.push(...validateBodyParams(route));
  diagnostics.push(...validateRouteContract(route));
  diagnostics.push(...validateStrictSchemas(route, options));
  diagnostics.push(...validateRouteSchemas(route));
  diagnostics.push(...validateProblemResponses(route));
  diagnostics.push(...validateProblemRegistryReferences(route, problemRegistryIndex));
  diagnostics.push(...validateStrictProblemResponses(route, options));

  return diagnostics;
}

function validateStrictSchemas(
  route: ContractGraphRoute,
  options: BuildContractGraphOptions,
): ContractDiagnostic[] {
  if (!options.strictSchemas) {
    return [];
  }

  const diagnostics: ContractDiagnostic[] = [];

  if (!route.outputSchema) {
    diagnostics.push(
      createRouteDiagnostic(
        route,
        "contract-route-missing-response-schema",
        "error",
        "Strict schema mode requires a success response schema before RPC/OpenAPI generation. Add @ResponseSchema(...), use an HTTP method route contract with response, or split no-content behavior into an explicit contract.",
      ),
    );
  }

  for (const param of route.params) {
    if (param.kind === "ctx") {
      continue;
    }

    if (param.kind === "body") {
      if (!param.schema && !route.routeContract?.inputSchemas.body) {
        diagnostics.push(
          createRouteDiagnostic(
            route,
            "contract-route-missing-body-schema",
            "error",
            "Strict schema mode requires @Body() to receive a Zod schema or a route contract with a body schema so generated request contracts cannot widen to unknown.",
            param.sourceLocation,
          ),
        );
      }

      continue;
    }

    if (param.name.length === 0 || isNamedParamSchemaBacked(route, param)) {
      continue;
    }

    diagnostics.push(
      createRouteDiagnostic(
        route,
        "contract-route-missing-named-param-schema",
        "error",
        getMissingNamedParamSchemaMessage(param),
        param.sourceLocation,
      ),
    );
  }

  return diagnostics;
}

function getMissingNamedParamSchemaMessage(param: ContractGraphRoute["params"][number]): string {
  const decorator = `@${getParamDecoratorName(param.kind)}("${param.name}")`;
  const routeContractField =
    param.kind === "path" ? "params" : param.kind === "query" ? "query" : null;

  if (!routeContractField) {
    return `Strict schema mode requires ${decorator} to receive a Zod schema so generated ${param.kind} contracts do not rely on implicit string fallback.`;
  }

  return `Strict schema mode requires ${decorator} to receive a Zod schema or a route contract ${routeContractField} field so generated ${param.kind} contracts do not rely on implicit string fallback.`;
}

function isNamedParamSchemaBacked(
  route: ContractGraphRoute,
  param: ContractGraphRoute["params"][number],
): boolean {
  if (param.schema) {
    return true;
  }

  const contractSchema =
    param.kind === "path"
      ? route.routeContract?.inputSchemas.path
      : param.kind === "query"
        ? route.routeContract?.inputSchemas.query
        : null;

  if (!contractSchema) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(getNamedSchemaShape(contractSchema), param.name);
}

function validateRouteContract(route: ContractGraphRoute): ContractDiagnostic[] {
  const contract = route.routeContract;

  if (!contract) {
    return [];
  }

  return [
    ...validateContractMethod(route),
    ...validateContractNamedParams(route, "path", contract.inputSchemas.path),
    ...validateContractNamedParams(route, "query", contract.inputSchemas.query),
    ...validateContractBody(route),
    ...validateContractResponse(route),
  ];
}

function validateContractMethod(route: ContractGraphRoute): ContractDiagnostic[] {
  const contract = route.routeContract;

  if (!contract || contract.method.toUpperCase() === route.httpMethod.toUpperCase()) {
    return [];
  }

  return [
    createRouteDiagnostic(
      route,
      "contract-route-method-mismatch",
      "error",
      `Route contract declares ${contract.method.toUpperCase()} but the route decorator registered ${route.httpMethod.toUpperCase()}. Use the HTTP method decorator that matches the contract.`,
    ),
  ];
}

function validateContractNamedParams(
  route: ContractGraphRoute,
  kind: "path" | "query",
  contractSchema: z.ZodType | null,
): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const contractShape = getNamedSchemaShape(contractSchema);
  const contractNames = new Set(Object.keys(contractShape));
  const params = route.params.filter((param) => param.kind === kind);
  const pathParamNames = kind === "path" ? new Set(getContractPathParamNames(route.path)) : null;

  if (kind === "path" && pathParamNames && pathParamNames.size > 0 && contractNames.size === 0) {
    diagnostics.push(
      createRouteDiagnostic(
        route,
        "contract-route-missing-path-param-schema",
        "error",
        `Route contract path '${route.path}' declares path parameters but the contract has no params schema.`,
      ),
    );
  }

  for (const name of contractNames) {
    const param = params.find((candidate) => candidate.name === name);

    if (!param) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          kind === "path"
            ? "contract-route-missing-path-param-binding"
            : "contract-route-missing-query-param-binding",
          "error",
          `Route contract declares ${kind} parameter '${name}' but the controller method does not bind it with @${kind === "path" ? "Param" : "Query"}(contract, "${name}").`,
        ),
      );
      continue;
    }

    if (param.schema && param.schema !== contractShape[name]) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          kind === "path"
            ? "contract-route-path-param-schema-mismatch"
            : "contract-route-query-param-schema-mismatch",
          "error",
          `Controller @${kind === "path" ? "Param" : "Query"}("${name}") schema does not match the route contract schema. Use @${kind === "path" ? "Param" : "Query"}(contract, "${name}") or route ${kind} schema helpers so the contract remains the source of truth.`,
        ),
      );
    }
  }

  for (const param of params) {
    if (!contractNames.has(param.name)) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          kind === "path"
            ? "contract-route-uncontracted-path-param"
            : "contract-route-uncontracted-query-param",
          "error",
          `Controller binds ${kind} parameter '${param.name}' but the route contract does not declare it.`,
        ),
      );
    }
  }

  return diagnostics;
}

function validateContractBody(route: ContractGraphRoute): ContractDiagnostic[] {
  const contract = route.routeContract;

  if (!contract) {
    return [];
  }

  const bodyParams = route.params.filter((param) => param.kind === "body");
  const contractBody = contract.inputSchemas.body;

  if (!contractBody) {
    if (bodyParams.length === 0) {
      return [];
    }

    return [
      createRouteDiagnostic(
        route,
        "contract-route-uncontracted-body-param",
        "error",
        "Controller binds @Body() but the route contract does not declare a body schema.",
      ),
    ];
  }

  if (bodyParams.length === 0) {
    return [
      createRouteDiagnostic(
        route,
        "contract-route-missing-body-binding",
        "error",
        "Route contract declares a body schema but the controller method does not bind it with @Body(contract).",
      ),
    ];
  }

  return bodyParams
    .filter((param) => param.schema && param.schema !== contractBody)
    .map((param) =>
      createRouteDiagnostic(
        route,
        "contract-route-body-schema-mismatch",
        "error",
        `Controller @Body() schema does not match the route contract body schema at parameter '${param.name}'. Use @Body(contract) so request validation and generated contracts share the same schema.`,
      ),
    );
}

function validateContractResponse(route: ContractGraphRoute): ContractDiagnostic[] {
  const contract = route.routeContract;

  if (!contract) {
    return [];
  }

  if (route.outputSchema === contract.outputSchema) {
    return [];
  }

  if (!contract.outputSchema) {
    return [
      createRouteDiagnostic(
        route,
        "contract-route-uncontracted-response-schema",
        "error",
        "Controller declares @ResponseSchema() but the route contract does not declare a response schema.",
      ),
    ];
  }

  return [
    createRouteDiagnostic(
      route,
      "contract-route-response-schema-mismatch",
      "error",
      "Controller @ResponseSchema() metadata does not match the route contract response schema. Use @ResponseSchema(contract) or omit @ResponseSchema when @Get(contract) is the source of truth.",
    ),
  ];
}

function validateProblemResponses(route: ContractGraphRoute): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const seenCodes = new Set<string>();

  for (const response of route.problemResponses ?? []) {
    const existing = seenCodes.has(response.code);

    if (existing) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          "contract-route-duplicate-problem-code",
          "error",
          `Route declares duplicate Problem code '${response.code}'. Problem response codes must be unique per route so generated clients can exhaustively discriminate failures.`,
        ),
      );
      continue;
    }

    seenCodes.add(response.code);
  }

  diagnostics.push(...validateRouteContractProblemResponses(route));

  return diagnostics;
}

function validateProblemRegistryReferences(
  route: ContractGraphRoute,
  problemRegistryIndex: ProblemRegistryIndex,
): ContractDiagnostic[] {
  if (!problemRegistryIndex.enabled) {
    return [];
  }

  const diagnostics: ContractDiagnostic[] = [];
  const seenCodes = new Set<string>();
  const responses = [
    ...(route.problemResponses ?? []),
    ...(route.routeContract?.problemResponses ?? []),
  ];

  for (const response of responses) {
    if (seenCodes.has(response.code)) {
      continue;
    }

    seenCodes.add(response.code);

    const entry = problemRegistryIndex.entriesByCode.get(response.code);

    if (!entry) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          "contract-route-problem-registry-missing",
          "error",
          `Route declares Problem code '${response.code}', but no supplied ProblemRegistry manifest declares it.`,
        ),
      );
      continue;
    }

    const statusMatches =
      entry.statusPolicy?.kind === "runtime-configurable" || entry.status === response.status;

    if (entry.category !== response.category || !statusMatches) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          "contract-route-problem-registry-mismatch",
          "error",
          `Route declares Problem code '${response.code}' as ${response.category}/${response.status}, but the ProblemRegistry declares ${entry.category}/${entry.status}.`,
        ),
      );
    }
  }

  return diagnostics;
}

function validateRouteContractProblemResponses(route: ContractGraphRoute): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const problemResponses = route.problemResponses ?? [];
  const contractResponses = route.routeContract?.problemResponsesDeclared
    ? dedupeProblemResponsesByCode(route.routeContract.problemResponses)
    : getRouteContractProblemResponses(problemResponses);

  if (contractResponses.length === 0 && !route.routeContract?.problemResponsesDeclared) {
    return diagnostics;
  }

  const declaredByCode = new Map(problemResponses.map((response) => [response.code, response]));
  const contractByCode = new Map(contractResponses.map((response) => [response.code, response]));

  for (const contractResponse of contractResponses) {
    const declared = declaredByCode.get(contractResponse.code);

    if (!declared) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          "contract-route-missing-problem-response",
          "error",
          `Route contract declares Problem code '${contractResponse.code}', but the route metadata does not include it. Use routeProblemResponses(contract) without filtering the contract failure surface.`,
        ),
      );
      continue;
    }

    if (!hasSameProblemClassification(declared, contractResponse)) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          "contract-route-problem-response-mismatch",
          "error",
          `Route metadata declares Problem code '${declared.code}' as ${declared.category}/${declared.status}, but the route contract declares ${contractResponse.category}/${contractResponse.status}. Keep @ProblemResponse metadata derived from the route contract.`,
        ),
      );
    }
  }

  for (const declared of problemResponses) {
    if (contractByCode.has(declared.code)) {
      continue;
    }

    diagnostics.push(
      createRouteDiagnostic(
        route,
        "contract-route-problem-response-not-in-contract",
        "error",
        `Route declares Problem code '${declared.code}' outside the route contract. Add it to the contract problems list or remove the extra @ProblemResponse declaration.`,
      ),
    );
  }

  return diagnostics;
}

function validateStrictProblemResponses(
  route: ContractGraphRoute,
  options: BuildContractGraphOptions,
): ContractDiagnostic[] {
  if (
    !options.strictProblemResponses ||
    (route.problemResponses?.length ?? 0) > 0 ||
    route.routeContract?.problemResponsesDeclared
  ) {
    return [];
  }

  return [
    createRouteDiagnostic(
      route,
      "contract-route-missing-problem-response-contract",
      "warning",
      "Strict Problem contract mode could not find declared route failures. Keep the generated client failure union as never only when this public route cannot throw Croco Problems; otherwise declare failures with routeProblemResponses(contract).",
    ),
  ];
}

function getRouteContractProblemResponses(
  problemResponses: NonNullable<ContractGraphRoute["problemResponses"]>,
): NonNullable<ContractGraphRoute["problemResponses"]> {
  const responsesByCode = new Map<
    string,
    NonNullable<ContractGraphRoute["problemResponses"]>[number]
  >();

  for (const response of problemResponses) {
    for (const contractResponse of response.routeContractProblems ?? []) {
      const existing = responsesByCode.get(contractResponse.code);

      if (existing && !hasSameProblemClassification(existing, contractResponse)) {
        responsesByCode.set(contractResponse.code, contractResponse);
        continue;
      }

      responsesByCode.set(contractResponse.code, contractResponse);
    }
  }

  return [...responsesByCode.values()].sort(compareProblemResponses);
}

function dedupeProblemResponsesByCode(
  responses: readonly NonNullable<ContractGraphRoute["problemResponses"]>[number][],
): NonNullable<ContractGraphRoute["problemResponses"]> {
  const responsesByCode = new Map<
    string,
    NonNullable<ContractGraphRoute["problemResponses"]>[number]
  >();

  for (const response of responses) {
    responsesByCode.set(response.code, response);
  }

  return [...responsesByCode.values()].sort(compareProblemResponses);
}

function hasSameProblemClassification(
  left: NonNullable<ContractGraphRoute["problemResponses"]>[number],
  right: NonNullable<ContractGraphRoute["problemResponses"]>[number],
): boolean {
  return left.category === right.category && left.status === right.status;
}

function compareProblemResponses(
  left: NonNullable<ContractGraphRoute["problemResponses"]>[number],
  right: NonNullable<ContractGraphRoute["problemResponses"]>[number],
): number {
  return left.code.localeCompare(right.code) || left.status - right.status;
}

function validatePathParams(route: ContractGraphRoute): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const pathParamNames = new Set(getContractPathParamNames(route.path));
  const declaredParamNames = new Set(
    route.params.filter((param) => param.kind === "path").map((param) => param.name),
  );

  for (const name of pathParamNames) {
    if (!declaredParamNames.has(name)) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          "contract-route-missing-path-param",
          "error",
          `Route path declares ':${name}' but no @Param("${name}") metadata was found.`,
        ),
      );
    }
  }

  for (const name of declaredParamNames) {
    if (name.length > 0 && !pathParamNames.has(name)) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          "contract-route-unbound-path-param",
          "error",
          `@Param("${name}") is not present in route path '${route.path}'.`,
        ),
      );
    }
  }

  return diagnostics;
}

function validateNamedParams(route: ContractGraphRoute): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];

  for (const kind of ["path", "query", "header"] as const) {
    const params = route.params.filter((param) => param.kind === kind);
    const seenNames = new Set<string>();

    for (const param of params) {
      if (param.name.length === 0) {
        diagnostics.push(
          createRouteDiagnostic(
            route,
            "contract-param-missing-name",
            "error",
            `${kind} parameters must include a metadata name for generated contracts.`,
          ),
        );
        continue;
      }

      if (seenNames.has(param.name)) {
        diagnostics.push(
          createRouteDiagnostic(
            route,
            "contract-param-duplicate-name",
            "error",
            `Duplicate ${kind} parameter '${param.name}' cannot be represented unambiguously.`,
          ),
        );
      }

      seenNames.add(param.name);
    }
  }

  return diagnostics;
}

function validateBodyParams(route: ContractGraphRoute): ContractDiagnostic[] {
  const bodyParams = route.params.filter((param) => param.kind === "body");

  if (bodyParams.length <= 1) {
    return [];
  }

  return [
    createRouteDiagnostic(
      route,
      "contract-route-multiple-body-params",
      "error",
      `Generated contracts support one request body per route, but ${bodyParams.length} @Body() parameters were found.`,
    ),
  ];
}

function validateRouteSchemas(route: ContractGraphRoute): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];

  for (const entry of getRouteSchemaEntries(route)) {
    const descriptor = describeZodSchema(entry.schema);

    for (const diagnostic of getSchemaDescriptorDiagnostics(descriptor)) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          diagnostic.code,
          diagnostic.severity,
          `${formatSchemaLocation(entry.location, diagnostic.schemaPath)}: ${diagnostic.message}`,
        ),
      );
    }
  }

  return diagnostics;
}

function validateUniqueRouteIds(routes: readonly ContractGraphRoute[]): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const routeIds = new Map<string, ContractGraphRoute>();

  for (const route of routes) {
    const existingRoute = routeIds.get(route.routeId);

    if (existingRoute) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          "contract-route-duplicate-id",
          "error",
          `Route id '${route.routeId}' is already used by ${existingRoute.controllerName}.${existingRoute.methodName}.`,
        ),
      );
      continue;
    }

    routeIds.set(route.routeId, route);
  }

  return diagnostics;
}

function validateUniqueControllerNames(
  controllers: readonly ContractGraphController[],
): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const controllerNames = new Map<string, ContractGraphController>();

  for (const controller of controllers) {
    const existingController = controllerNames.get(controller.name);

    if (existingController) {
      diagnostics.push({
        code: "contract-controller-duplicate-name",
        severity: "error",
        target: "controller",
        controllerName: controller.name,
        path: controller.path,
        message: `Controller name '${controller.name}' is already used for path '${existingController.path}'. Controller names must be unique because route ids and access metadata references use them as contract identity.`,
      });
      continue;
    }

    controllerNames.set(controller.name, controller);
  }

  return diagnostics;
}

function validateUniqueOperationIds(routes: readonly ContractGraphRoute[]): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const operationIds = new Map<string, ContractGraphRoute>();

  for (const route of routes) {
    const existingRoute = operationIds.get(route.operationId);

    if (existingRoute) {
      diagnostics.push(
        createRouteDiagnostic(
          route,
          "contract-route-duplicate-operation-id",
          "error",
          `Operation id '${route.operationId}' is already used by ${existingRoute.controllerName}.${existingRoute.methodName}.`,
        ),
      );
      continue;
    }

    operationIds.set(route.operationId, route);
  }

  return diagnostics;
}

function getNamedSchemaShape(schema: z.ZodType | null): Record<string, z.ZodType> {
  const shape = schema ? getZodObjectShape(schema) : {};
  const result: Record<string, z.ZodType> = {};

  for (const [name, value] of Object.entries(shape)) {
    if (isZodType(value)) {
      result[name] = value;
    }
  }

  return result;
}

function getRouteSchemaEntries(route: ContractGraphRoute): RouteSchemaDiagnosticEntry[] {
  const candidates: readonly {
    readonly schema: z.ZodType | null;
    readonly location: RouteSchemaDiagnosticLocation;
  }[] = [
    { schema: route.inputSchemas.body, location: "body" },
    { schema: route.inputSchemas.path, location: "path" },
    { schema: route.inputSchemas.query, location: "query" },
    { schema: route.inputSchemas.headers, location: "headers" },
    { schema: route.outputSchema, location: "response" },
  ];
  const entries: RouteSchemaDiagnosticEntry[] = [];
  const seen = new Set<z.ZodType>();

  for (const candidate of candidates) {
    if (!candidate.schema || seen.has(candidate.schema)) {
      continue;
    }

    seen.add(candidate.schema);
    entries.push({ schema: candidate.schema, location: candidate.location });
  }

  for (const param of route.params) {
    if (
      !param.schema ||
      seen.has(param.schema) ||
      isParamSchemaCoveredByRouteSchema(route, param)
    ) {
      continue;
    }

    seen.add(param.schema);
    entries.push({
      schema: param.schema,
      location: formatParamSchemaLocation(param.kind, param.name),
    });
  }

  return entries;
}

function isParamSchemaCoveredByRouteSchema(
  route: ContractGraphRoute,
  param: ContractGraphRoute["params"][number],
): boolean {
  switch (param.kind) {
    case "body":
      return route.inputSchemas.body === param.schema;
    case "path":
    case "query":
    case "header": {
      const schema =
        param.kind === "path"
          ? route.inputSchemas.path
          : param.kind === "query"
            ? route.inputSchemas.query
            : route.inputSchemas.headers;

      return getNamedSchemaShape(schema)[param.name] === param.schema;
    }
    case "ctx":
      return false;
  }
}

function formatParamSchemaLocation(
  kind: ContractGraphRoute["params"][number]["kind"],
  name: string,
): string {
  if (kind === "ctx") {
    return "ctx";
  }

  return name.length > 0 ? `${kind}.${name}` : kind;
}

function isZodType(value: unknown): value is z.ZodType {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { readonly safeParse?: unknown };

  return typeof candidate.safeParse === "function";
}

function formatSchemaLocation(
  location: RouteSchemaDiagnosticLocation | string,
  schemaPath: readonly string[],
): string {
  return schemaPath.length > 0 ? `${location}.${schemaPath.join(".")}` : location;
}

function createRouteDiagnostic(
  route: ContractGraphRoute,
  code: string,
  severity: ContractDiagnosticSeverity,
  message: string,
  sourceLocation?: ContractDiagnosticSourceLocation,
): ContractDiagnostic {
  const diagnosticSourceLocation =
    sourceLocation ?? route.routeContract?.sourceLocation ?? route.sourceLocation;

  return {
    code,
    severity,
    target: getDiagnosticTarget(code),
    message,
    routeId: route.routeId,
    ...(route.routeContract?.id ? { contractId: route.routeContract.id } : {}),
    controllerName: route.controllerName,
    methodName: route.methodName,
    path: route.path,
    ...(diagnosticSourceLocation ? { sourceLocation: diagnosticSourceLocation } : {}),
  };
}

function formatContractDiagnosticSourceLocation(
  sourceLocation: ContractDiagnosticSourceLocation,
): string {
  const line = sourceLocation.line === undefined ? "" : `:${sourceLocation.line}`;
  const column = sourceLocation.column === undefined ? "" : `:${sourceLocation.column}`;

  return `${sourceLocation.path}${line}${column}`;
}

function getParamDecoratorName(kind: ContractGraphRoute["params"][number]["kind"]): string {
  switch (kind) {
    case "path":
      return "Param";
    case "query":
      return "Query";
    case "header":
      return "Header";
    case "body":
      return "Body";
    case "ctx":
      return "Ctx";
  }
}

function getDiagnosticTarget(code: string): ContractDiagnosticTarget {
  if (isProblemRegistryDiagnosticCode(code)) {
    return "problem";
  }

  if (code.includes("param")) {
    return "param";
  }

  if (code.includes("schema")) {
    return "schema";
  }

  return "route";
}

function isProblemRegistryDiagnosticCode(code: string): boolean {
  return (
    code === "contract-route-problem-registry-missing" ||
    code === "contract-route-problem-registry-mismatch"
  );
}

function getMetadataReferences(
  value: unknown,
  declaredAt: ContractMetadataReference["declaredAt"],
  owner: ContractMetadataOwner,
): ContractMetadataReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => getMetadataReference(item, declaredAt, owner, index))
    .filter((reference): reference is ContractMetadataReference => reference !== null);
}

function getMetadataReference(
  value: unknown,
  declaredAt: ContractMetadataReference["declaredAt"],
  owner: ContractMetadataOwner,
  index: number,
): ContractMetadataReference | null {
  if (typeof value === "function") {
    return createGuardReference("constructor", getMetadataName(value), declaredAt, owner, index);
  }

  if (value && typeof value === "object" && "constructor" in value) {
    const constructor = value.constructor;

    if (typeof constructor === "function") {
      return createGuardReference(
        "instance",
        getMetadataName(constructor),
        declaredAt,
        owner,
        index,
      );
    }
  }

  return null;
}

function getMetadataName(value: { readonly name: string }): string {
  return value.name.length > 0 ? value.name : "anonymous";
}

function createGuardReference(
  kind: ContractMetadataReference["kind"],
  name: string,
  declaredAt: ContractMetadataReference["declaredAt"],
  owner: ContractMetadataOwner,
  index: number,
): ContractMetadataReference {
  const ownerId = owner.routeId ?? owner.controllerName;

  return {
    type: "rest.guard",
    id: `rest.guard:${declaredAt}:${ownerId}:${index}:${kind}:${name}`,
    kind,
    name,
    declaredAt,
    owner,
    index,
  };
}

function getMetadataStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function getEntitlementRequirements(
  target: object,
  propertyKey?: string | symbol,
): ContractEntitlementRequirement[] {
  const current =
    propertyKey === undefined
      ? Reflect.getMetadata(ENTITLEMENT_REQUIREMENTS_KEY, target)
      : Reflect.getMetadata(ENTITLEMENT_REQUIREMENTS_KEY, target, propertyKey);
  const requirements = normalizeEntitlementRequirements(current);

  if (requirements.length > 0) {
    return requirements;
  }

  const legacy =
    propertyKey === undefined
      ? Reflect.getMetadata(ENTITLEMENT_REQUIRED_KEY, target)
      : Reflect.getMetadata(ENTITLEMENT_REQUIRED_KEY, target, propertyKey);

  return typeof legacy === "string" && legacy.length > 0 ? [{ feature: legacy }] : [];
}

function normalizeEntitlementRequirements(value: unknown): ContractEntitlementRequirement[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isEntitlementRequirementMetadata).map((requirement) => ({
    feature: requirement.feature,
    ...(requirement.description ? { description: requirement.description } : {}),
    ...(requirement.resource
      ? { resource: normalizeEntitlementResource(requirement.resource) }
      : {}),
  }));
}

function isEntitlementRequirementMetadata(value: unknown): value is EntitlementRequirementMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    readonly feature?: unknown;
    readonly resource?: unknown;
  };

  return (
    typeof candidate.feature === "string" &&
    candidate.feature.length > 0 &&
    (candidate.resource === undefined || isEntitlementResourceMetadata(candidate.resource))
  );
}

function normalizeEntitlementResource(
  resource: NonNullable<EntitlementRequirementMetadata["resource"]>,
): ContractEntitlementResourceRequirement {
  return {
    type: resource.type,
    ...(resource.id ? { id: resource.id } : {}),
    ...(resource.idParam ? { idParam: resource.idParam } : {}),
  };
}

function isEntitlementResourceMetadata(
  value: unknown,
): value is NonNullable<EntitlementRequirementMetadata["resource"]> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    readonly type?: unknown;
    readonly id?: unknown;
    readonly idParam?: unknown;
  };

  return (
    typeof candidate.type === "string" &&
    candidate.type.length > 0 &&
    (candidate.id === undefined || (typeof candidate.id === "string" && candidate.id.length > 0)) &&
    (candidate.idParam === undefined ||
      (typeof candidate.idParam === "string" && candidate.idParam.length > 0))
  );
}
