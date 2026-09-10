import * as fs from "node:fs";
import * as path from "node:path";
import {
  createFrontendActionManifest,
  mergeFrontendActionManifests,
  serializeFrontendActionManifest,
  type FrontendActionEntitlement,
  type FrontendActionInputLocation,
  type FrontendActionManifest,
  type FrontendActionManifestEntry,
  type FrontendActionManifestMergeInput,
  type FrontendActionMetadataReference,
  type FrontendActionPermissionMetadata,
  type FrontendActionProblem,
  type FrontendActionShapeReference,
} from "@croco/presentation-preset";
import { Problem, ProblemCategory } from "@croco/problems-core";
import {
  assertContractGraphConsumerRouteCoverage,
  assertContractGraphHasNoErrors,
  createProjectManifestBundleArtifactPaths,
  type ContractGraph,
  type ContractGraphConsumerRouteField,
  type ContractGraphObservedConsumerRoute,
  type ContractSchemaDescriptor,
  describeZodSchema,
  formatSchemaDiagnostic,
  getSchemaDescriptorDiagnostics,
  getZodArrayElementSchema,
  getZodDefaultValue,
  getZodInnerSchema,
  getZodObjectShape,
  getZodObjectUnsupportedDynamicKeyMode,
  getZodSchemaTypeName,
  isZodArraySchema,
  getContractPathParamNames,
  getContractPathParams,
  normalizeProjectManifestBundlePath,
  type RouteIR,
} from "@croco/protocols-core";

export type GenerateClientOptions = {
  readonly frontendActionManifestInputs?: readonly FrontendActionManifestMergeInput[];
  readonly frontendActionManifestPath?: string;
  readonly manifestBundlePath?: string;
  readonly problemRuntime?: GenerateClientProblemRuntime;
  readonly reactQuery?: boolean;
};

export type GenerateClientProblemRuntime = "inline" | "frontend-problems";

type GeneratedClientRoute = RouteIR & {
  readonly routeId?: string;
  readonly operationId?: string;
};

type DomainRoutes = {
  readonly domain: string;
  readonly routes: GeneratedClientRoute[];
};

type GeneratedClientFile = {
  readonly filePath: string;
  readonly content: string;
};

export type GeneratedClientDrift = {
  readonly filePath: string;
  readonly status: "changed" | "missing" | "unexpected";
};

type GeneratedClientRouteWithAccess = GeneratedClientRoute & {
  readonly access?: {
    readonly guards?: readonly FrontendActionMetadataReference[];
    readonly roles?: readonly string[];
  };
  readonly entitlements?: readonly FrontendActionEntitlement[];
};

type ResponseHelperOptions = {
  readonly hasOutputRoutes: boolean;
  readonly hasNoOutputRoutes: boolean;
  readonly hasFormRoutes: boolean;
  readonly hasQueryKeyInputs: boolean;
};

type GeneratedFormField = {
  readonly name: string;
  readonly label: string;
  readonly control: "text" | "number" | "checkbox" | "select" | "multi-select" | "list";
  readonly valueKind: "string" | "number" | "boolean" | "enum" | "array";
  readonly required: boolean;
  readonly valueType: string;
  readonly initialValueExpression: string;
  readonly payloadValueExpression: string;
  readonly options: readonly FormFieldOption[];
};

type FormFieldOption = {
  readonly label: string;
  readonly value: string | number | boolean | null;
};

type FormFieldSchemaAnalysis = {
  readonly schema: unknown;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly defaultValue?: unknown;
};

class RpcCodegenContractProblem extends Problem {
  constructor(detail: string) {
    super("rpc-codegen/invalid-contract", ProblemCategory.ValidationError, detail);
  }
}

class RpcCodegenUnsupportedFormSchemaProblem extends Problem {
  constructor(route: GeneratedClientRoute, detail: string) {
    super(
      "rpc-codegen/unsupported-form-schema",
      ProblemCategory.ValidationError,
      `Cannot generate RPC form model for route ${formatRoute(route)}: ${detail}`,
    );
  }
}

const GENERATED_CLIENT_OWNERSHIP_SCHEMA_VERSION = "croco.rpc-codegen-ownership.v1";
const GENERATED_CLIENT_OWNERSHIP_MANIFEST_NAME = ".croco-rpc-codegen.json";
const MAX_LEGACY_GENERATED_FILE_BYTES = 16 * 1024 * 1024;

type GeneratedClientOwnership = {
  readonly files: readonly string[];
  readonly directories: readonly string[];
};

type GeneratedClientOwnershipManifest = GeneratedClientOwnership & {
  readonly schemaVersion: typeof GENERATED_CLIENT_OWNERSHIP_SCHEMA_VERSION;
};

export function generateClientFilesFromContractGraph(
  graph: ContractGraph,
  outDir: string,
  options: GenerateClientOptions = {},
): string[] {
  assertContractGraphHasNoErrors(graph);

  const files = emitClientFiles([...graph.routes], outDir, options);
  const generatedContents = new Map(files.map((file) => [file.filePath, file.content]));

  assertContractGraphConsumerRouteCoverage(
    graph,
    "rpc-client",
    collectGeneratedRpcConsumerRoutes([...generatedContents.keys()], generatedContents),
  );

  writeGeneratedClientFiles(files, outDir);

  return files.map((file) => file.filePath);
}

export function generateClientFiles(
  routes: GeneratedClientRoute[],
  outDir: string,
  options: GenerateClientOptions = {},
): string[] {
  const files = emitClientFiles(routes, outDir, options);

  writeGeneratedClientFiles(files, outDir);

  return files.map((file) => file.filePath);
}

function writeGeneratedClientFiles(files: readonly GeneratedClientFile[], outDir: string): void {
  const previousOwnership = readGeneratedClientOwnershipManifest(outDir);
  const currentOwnedPaths = collectOwnedOutputPaths(files, outDir);
  const currentOwnedDirectories = collectOwnedOutputDirectories(
    currentOwnedPaths,
    previousOwnership.directories,
    outDir,
  );
  const staleOwnedPaths = previousOwnership.files.filter(
    (filePath) => !currentOwnedPaths.has(filePath),
  );
  const staleOwnedDirectories = previousOwnership.directories.filter(
    (directory) => !currentOwnedDirectories.has(directory),
  );

  assertNoUnownedOutputCollisions(files, outDir, previousOwnership.files);
  assertOwnedOutputDirectoriesCanBeRemoved(outDir, staleOwnedDirectories);

  for (const filePath of staleOwnedPaths) {
    assertOwnedFilePathDoesNotTraverseSymlink(outDir, filePath);
  }

  for (const filePath of staleOwnedPaths) {
    removeOwnedOutputFile(outDir, filePath);
  }

  removeOwnedOutputDirectories(outDir, staleOwnedDirectories);

  fs.mkdirSync(outDir, { recursive: true });

  for (const file of files) {
    fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
    fs.writeFileSync(file.filePath, file.content);
  }

  fs.writeFileSync(
    getGeneratedClientOwnershipManifestPath(outDir),
    serializeGeneratedClientOwnershipManifest(currentOwnedPaths, currentOwnedDirectories),
  );
}

function emitClientFiles(
  routes: GeneratedClientRoute[],
  outDir: string,
  options: GenerateClientOptions,
): readonly GeneratedClientFile[] {
  assertGeneratedClientRoutes(routes);

  if (options.frontendActionManifestInputs && !options.frontendActionManifestPath) {
    throw new RpcCodegenContractProblem(
      "frontendActionManifestInputs requires frontendActionManifestPath so the aggregate has one explicit destination.",
    );
  }

  const domainRouteGroups = groupRoutesByDomain(routes);
  const domainFiles = domainRouteGroups.map((domainRoutes) => {
    const content = generateDomainClient(domainRoutes, options);

    assertNoZodImport(content);

    return {
      filePath: path.join(outDir, `${domainRoutes.domain}.ts`),
      content,
    };
  });
  const supportPath = path.join(outDir, "rpc.ts");
  const supportContent = generateRpcSupport(options);
  const indexPath = path.join(outDir, "index.ts");
  const indexContent = generateClientIndex(domainRouteGroups, options);
  const manifestSourceFile = options.manifestBundlePath
    ? {
        filePath: path.join(outDir, "manifest-source.ts"),
        content: generateManifestSource(options.manifestBundlePath),
      }
    : null;
  const frontendActionManifestFile = options.frontendActionManifestPath
    ? {
        filePath: options.frontendActionManifestPath,
        content: serializeFrontendActionManifest(
          mergeFrontendActionManifests([
            ...(options.frontendActionManifestInputs ?? []),
            {
              source: "@croco/rpc-codegen",
              manifest: createFrontendActionManifestFromRoutes(routes),
            },
          ]),
        ),
      }
    : null;
  const files: readonly GeneratedClientFile[] = [
    ...domainFiles,
    { filePath: supportPath, content: supportContent },
    ...(manifestSourceFile ? [manifestSourceFile] : []),
    { filePath: indexPath, content: indexContent },
    ...(frontendActionManifestFile ? [frontendActionManifestFile] : []),
  ];

  return files;
}

export function createFrontendActionManifestFromContractGraph(
  graph: ContractGraph,
): FrontendActionManifest {
  assertContractGraphHasNoErrors(graph);

  return createFrontendActionManifestFromRoutes([...graph.routes]);
}

export function createFrontendActionManifestFromRoutes(
  routes: readonly GeneratedClientRoute[],
): FrontendActionManifest {
  assertGeneratedClientRoutes(routes);

  return createFrontendActionManifest(routes.map(createFrontendActionManifestEntry));
}

function createFrontendActionManifestEntry(
  route: GeneratedClientRoute,
): FrontendActionManifestEntry {
  const routeId = getRouteId(route);
  const operationId = getOperationId(route);
  const domain = getDomainName(route);

  return {
    id: `rest:${routeId}`,
    source: {
      kind: "rest-rpc-route",
      packageName: "@croco/rpc-codegen",
      routeId,
      operationId,
      controllerName: route.controllerName,
      methodName: route.methodName,
      domain,
    },
    method: route.httpMethod.toUpperCase(),
    path: route.path,
    input: createFrontendActionInputReference(route),
    output: createFrontendActionOutputReference(route),
    problems: createFrontendActionProblems(route),
    permissions: createFrontendActionPermissions(route),
    invalidates: isMutationRoute(route)
      ? [{ kind: "query-key-prefix", target: domain, reason: "mutation" }]
      : [],
  };
}

function createFrontendActionInputReference(
  route: GeneratedClientRoute,
): FrontendActionShapeReference {
  const locations = getFrontendActionInputLocations(route);

  if (locations.length === 0) {
    return { kind: "none" };
  }

  return {
    kind: "generated-type",
    ref: getInputTypeName(route),
    locations,
  };
}

function createFrontendActionOutputReference(
  route: GeneratedClientRoute,
): FrontendActionShapeReference {
  if (!route.outputSchema) {
    return { kind: "none" };
  }

  return {
    kind: "generated-type",
    ref: getOutputTypeName(route),
  };
}

function getFrontendActionInputLocations(
  route: GeneratedClientRoute,
): readonly FrontendActionInputLocation[] {
  const locations: FrontendActionInputLocation[] = [];

  if (route.inputSchemas.body) {
    locations.push("body");
  }
  if (route.inputSchemas.path) {
    locations.push("path");
  }
  if (route.inputSchemas.query) {
    locations.push("query");
  }
  if (route.inputSchemas.headers) {
    locations.push("headers");
  }

  return locations;
}

function createFrontendActionProblems(
  route: GeneratedClientRoute,
): readonly FrontendActionProblem[] {
  return [...(route.problemResponses ?? [])]
    .sort(
      (left, right) =>
        compareStrings(left.code, right.code) ||
        compareStrings(String(left.category), String(right.category)) ||
        left.status - right.status,
    )
    .map((problem) => ({
      code: problem.code,
      category: String(problem.category),
      status: problem.status,
      ...(problem.description ? { description: problem.description } : {}),
      ...(problem.type ? { type: problem.type } : {}),
      ...(problem.cookbookPath ? { cookbookPath: problem.cookbookPath } : {}),
    }));
}

function createFrontendActionPermissions(
  route: GeneratedClientRoute,
): FrontendActionPermissionMetadata {
  const metadata = route as GeneratedClientRouteWithAccess;

  return {
    guards: [...(metadata.access?.guards ?? [])]
      .map(normalizeFrontendActionGuard)
      .sort(
        (left, right) => compareStrings(left.id, right.id) || compareStrings(left.name, right.name),
      ),
    roles: [...(metadata.access?.roles ?? [])].sort(compareStrings),
    entitlements: [...(metadata.entitlements ?? [])]
      .map(normalizeFrontendActionEntitlement)
      .sort(compareFrontendActionEntitlements),
  };
}

function normalizeFrontendActionGuard(
  guard: FrontendActionMetadataReference,
): FrontendActionMetadataReference {
  return {
    id: guard.id,
    name: guard.name,
    ...(guard.owner
      ? {
          owner: {
            controllerName: guard.owner.controllerName,
            ...(guard.owner.routeId ? { routeId: guard.owner.routeId } : {}),
            ...(guard.owner.methodName ? { methodName: guard.owner.methodName } : {}),
          },
        }
      : {}),
  };
}

function normalizeFrontendActionEntitlement(
  entitlement: FrontendActionEntitlement,
): FrontendActionEntitlement {
  return {
    feature: entitlement.feature,
    ...(entitlement.description ? { description: entitlement.description } : {}),
    ...(entitlement.resource
      ? {
          resource: {
            type: entitlement.resource.type,
            ...(entitlement.resource.id ? { id: entitlement.resource.id } : {}),
            ...(entitlement.resource.idParam ? { idParam: entitlement.resource.idParam } : {}),
          },
        }
      : {}),
  };
}

function compareFrontendActionEntitlements(
  left: FrontendActionEntitlement,
  right: FrontendActionEntitlement,
): number {
  return compareStrings(JSON.stringify(left), JSON.stringify(right));
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertGeneratedClientRoutes(routes: readonly GeneratedClientRoute[]): void {
  for (const route of routes) {
    if (route.httpMethod.toUpperCase() === "ALL") {
      throw new RpcCodegenContractProblem(
        `Cannot generate RPC client for @All route ${formatRoute(route)}: @All is runtime-only and cannot be represented as a concrete generated client request. Use explicit HTTP method decorators for generated contracts.`,
      );
    }

    const bodyParamCount = route.params.filter((param) => param.kind === "body").length;

    if (bodyParamCount > 1) {
      throw new RpcCodegenContractProblem(
        `Cannot generate RPC client for route ${formatRoute(route)}: generated contracts support one request body per route, but ${bodyParamCount} @Body() parameters were found.`,
      );
    }

    assertGeneratedClientPathParams(route);
  }

  for (const domainRoutes of groupRoutesByDomain(routes)) {
    assertGeneratedClientMethodNames(domainRoutes);
  }
}

function assertGeneratedClientMethodNames(domainRoutes: DomainRoutes): void {
  const members = new Map<string, { readonly route: RouteIR; readonly kind: string }>();

  for (const route of domainRoutes.routes) {
    for (const member of [
      { name: route.methodName, kind: "route method" },
      { name: getResultMethodName(route), kind: "result method" },
    ]) {
      const existing = members.get(member.name);

      if (existing) {
        throw new RpcCodegenContractProblem(
          `Cannot generate RPC client for domain '${domainRoutes.domain}': member '${member.name}' would be generated for ${formatRoute(route)} as a ${member.kind}, but ${formatRoute(existing.route)} already generates that member as a ${existing.kind}. Rename one route method because generated Result methods reserve the '<methodName>Result' member pattern.`,
        );
      }

      members.set(member.name, { route, kind: member.kind });
    }
  }
}

function assertGeneratedClientPathParams(route: GeneratedClientRoute): void {
  const pathParamNames = new Set(getContractPathParamNames(route.path));
  const declaredParamNames = new Set(
    route.params.filter((param) => param.kind === "path").map((param) => param.name),
  );
  const schemaParamNames = new Set(
    route.inputSchemas.path ? getObjectFieldNames(route.inputSchemas.path) : [],
  );

  for (const name of pathParamNames) {
    if (!declaredParamNames.has(name)) {
      throw new RpcCodegenContractProblem(
        `Cannot generate RPC client for route ${formatRoute(route)}: route path declares ':${name}' but no @Param("${name}") metadata was found.`,
      );
    }

    if (!schemaParamNames.has(name)) {
      throw new RpcCodegenContractProblem(
        `Cannot generate RPC client for route ${formatRoute(route)}: route path declares ':${name}' but no generated path schema was found.`,
      );
    }
  }

  for (const name of declaredParamNames) {
    if (name.length > 0 && !pathParamNames.has(name)) {
      throw new RpcCodegenContractProblem(
        `Cannot generate RPC client for route ${formatRoute(route)}: @Param("${name}") is not present in route path '${route.path}'.`,
      );
    }
  }

  for (const name of schemaParamNames) {
    if (!pathParamNames.has(name)) {
      throw new RpcCodegenContractProblem(
        `Cannot generate RPC client for route ${formatRoute(route)}: generated path schema declares '${name}' but route path '${route.path}' does not contain ':${name}'.`,
      );
    }
  }
}

function groupRoutesByDomain(routes: readonly GeneratedClientRoute[]): DomainRoutes[] {
  const groups = new Map<string, GeneratedClientRoute[]>();

  for (const route of routes) {
    const domain = getDomainName(route);
    groups.set(domain, [...(groups.get(domain) ?? []), route]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([domain, domainRoutes]) => ({ domain, routes: domainRoutes }));
}

function generateDomainClient(domainRoutes: DomainRoutes, options: GenerateClientOptions): string {
  const clientName = `${domainRoutes.domain}Client`;
  const clientTypeName = `${toPascalCase(domainRoutes.domain)}Client`;
  const clientFactoryName = `create${clientTypeName}`;
  const inputTypes = domainRoutes.routes.map(generateInputType).filter((type) => type.length > 0);
  const outputTypes = domainRoutes.routes.map(generateOutputType).filter((type) => type.length > 0);
  const problemTypes = domainRoutes.routes.map(generateProblemTypes);
  const problemDeclarations = domainRoutes.routes.map(generateProblemDeclarations).join("\n");
  const formArtifacts = domainRoutes.routes
    .map(generateFormArtifacts)
    .filter((artifact) => artifact.length > 0);
  const types = [...inputTypes, ...outputTypes, ...problemTypes];
  const responseHelperImports = getResponseHelperImports({
    hasOutputRoutes: domainRoutes.routes.some((route) => route.outputSchema),
    hasNoOutputRoutes: domainRoutes.routes.some((route) => !route.outputSchema),
    hasFormRoutes: formArtifacts.length > 0,
    hasQueryKeyInputs: domainRoutes.routes.some(needsInput),
  });
  const queryHelpers = domainRoutes.routes.some((route) => route.inputSchemas.query)
    ? `function serializeQueryParams(query: Record<string, unknown> | null | undefined): string {
  if (query === undefined || query === null) {
    return '';
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    const values = Array.isArray(value) ? value : [value];

    for (const item of values) {
      if (item === undefined) {
        continue;
      }

      params.append(key, String(item));
    }
  }

  return params.toString();
}
`
    : "";
  const headerHelpers = domainRoutes.routes.some((route) => route.inputSchemas.headers)
    ? `function serializeHeaders(headers: Record<string, unknown> | null | undefined): Record<string, string> {
  if (headers === undefined || headers === null) {
    return {};
  }

  const serialized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const values = Array.isArray(value) ? value : [value];
    const serializedValues = values.filter((item) => item !== undefined).map((item) => String(item));

    if (serializedValues.length === 0) {
      continue;
    }

    serialized[key] = serializedValues.join(', ');
  }

  return serialized;
}
`
    : "";
  const clientMethods = domainRoutes.routes
    .map((route, index) => generateClientMethod(route, domainRoutes.domain, index))
    .map((method) =>
      method
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    )
    .join("\n");
  const imports = options.reactQuery ? generateReactQueryImports(domainRoutes) : "";
  const hooks = options.reactQuery ? `\n${generateReactQueryHooks(domainRoutes, clientName)}` : "";
  const routeMetadata = generateContractRouteMetadata(domainRoutes);
  const queryKeys = generateQueryKeys(domainRoutes);
  const invalidationManifest = generateInvalidationManifest(domainRoutes);

  return `${imports}${responseHelperImports}${types.join("\n")}
${problemDeclarations}
${formArtifacts.join("\n")}
${routeMetadata}
${queryKeys}
${invalidationManifest}
${queryHelpers}${headerHelpers}
export function ${clientFactoryName}(config: RpcClientConfig = {}) {
  return {
${clientMethods}
  };
}

export type ${clientTypeName} = ReturnType<typeof ${clientFactoryName}>;

export const ${clientName} = ${clientFactoryName}();
${hooks}`;
}

function generateContractRouteMetadata(domainRoutes: DomainRoutes): string {
  const entries = domainRoutes.routes
    .map(
      (route) =>
        `  { routeId: ${literalValueToTypeScript(getRouteId(route))}, operationId: ${literalValueToTypeScript(getOperationId(route))}, methodName: ${literalValueToTypeScript(route.methodName)}, method: ${literalValueToTypeScript(route.httpMethod.toUpperCase())}, path: ${literalValueToTypeScript(route.path)} }`,
    )
    .join(",\n");

  return `export const ${domainRoutes.domain}ContractRoutes = [
${entries}
] as const;`;
}

function generateQueryKeys(domainRoutes: DomainRoutes): string {
  const keysName = getQueryKeysName(domainRoutes);
  const entries = domainRoutes.routes
    .map((route) => {
      const parameters = getQueryKeyFactoryParameters(route);
      const keyParts = [`...${keysName}.all()`, literalValueToTypeScript(route.methodName)];
      const inputExpression = getQueryKeyInputExpression(route);

      if (inputExpression) {
        keyParts.push(`serializeRpcQueryKeyInput(${inputExpression})`);
      }

      if (hasReactQueryCacheScope(route)) {
        keyParts.push("serializeRpcQueryKeyInput(cacheScope)");
      }

      return `  ${getQueryKeyFactoryProperty(route)}: (${parameters}) => [${keyParts.join(", ")}] as const,`;
    })
    .join("\n");

  return `export const ${keysName} = {
  all: () => [${literalValueToTypeScript(domainRoutes.domain)}] as const,
${entries}
};`;
}

function generateInvalidationManifest(domainRoutes: DomainRoutes): string {
  const mutationRoutes = domainRoutes.routes.filter(isMutationRoute);

  if (mutationRoutes.length === 0) {
    return "";
  }

  const keysName = getQueryKeysName(domainRoutes);
  const entries = mutationRoutes
    .map(
      (route) =>
        `  ${route.methodName}: { route: ${domainRoutes.domain}ContractRoutes[${domainRoutes.routes.indexOf(route)}], invalidates: [${keysName}.all()] },`,
    )
    .join("\n");

  return `export const ${domainRoutes.domain}InvalidationManifest = {
${entries}
} as const;`;
}

function collectGeneratedRpcConsumerRoutes(
  files: readonly string[],
  generatedContents?: ReadonlyMap<string, string>,
): ContractGraphObservedConsumerRoute[] {
  const routes: ContractGraphObservedConsumerRoute[] = [];
  const metadataPattern =
    /routeId: '([^']+)', operationId: '([^']+)', methodName: '([^']+)', method: '([^']+)', path: '([^']+)'/g;

  for (const file of files) {
    if (path.basename(file) === "rpc.ts" || path.basename(file) === "index.ts") {
      continue;
    }

    const content = generatedContents?.get(file) ?? fs.readFileSync(file, "utf-8");

    for (const match of content.matchAll(metadataPattern)) {
      const routeId = match[1];
      const operationId = match[2];
      const methodName = match[3];
      const method = match[4];
      const routePath = match[5];

      if (routeId && operationId && methodName && method && routePath) {
        routes.push(
          createGeneratedRpcConsumerRoute(content, {
            routeId,
            operationId,
            methodName,
            method,
            path: routePath,
          }),
        );
      }
    }
  }

  return routes;
}

function createGeneratedRpcConsumerRoute(
  content: string,
  route: {
    readonly routeId: string;
    readonly operationId: string;
    readonly methodName: string;
    readonly method: string;
    readonly path: string;
  },
): ContractGraphObservedConsumerRoute {
  const methodBlock = getGeneratedMethodBlock(content, route.methodName);
  const problemDeclarations = getProblemDeclarationsFingerprint(content, route.methodName);

  return {
    routeId: route.routeId,
    operationId: route.operationId,
    consumedFields: collectGeneratedRpcConsumedFields(),
    fieldFingerprints: {
      routeId: route.routeId,
      operationId: route.operationId,
      httpMethod: route.method,
      path: route.path,
      "request.body": methodBlock.includes("body: JSON.stringify(") ? "present" : "absent",
      "request.path": methodBlock.includes("input.path") ? "present" : "absent",
      "request.query": methodBlock.includes("serializeQueryParams(input.query)")
        ? "present"
        : "absent",
      "request.headers": methodBlock.includes("serializeHeaders(input.headers)")
        ? "present"
        : "absent",
      response: content.includes(
        `export type ${getGeneratedTypeName(route.methodName, "Output")} =`,
      )
        ? "present"
        : "absent",
      problems: problemDeclarations,
    },
  };
}

function collectGeneratedRpcConsumedFields(): ContractGraphConsumerRouteField[] {
  return [
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
  ];
}

function getGeneratedMethodBlock(content: string, methodName: string): string {
  const methodMarker = `    ${methodName}:`;
  const resultMarker = `    ${methodName}Result:`;
  const clientStart = content.search(
    /\nexport function create[A-Za-z_$][A-Za-z0-9_$]*Client\(config: RpcClientConfig = \{\}\) \{\n/,
  );
  const searchStart = clientStart === -1 ? 0 : clientStart;
  const methodStart = content.indexOf(methodMarker, searchStart);
  const resultStart = content.indexOf(resultMarker, methodStart);

  if (methodStart === -1 || resultStart === -1) {
    return "";
  }

  const nextRouteStart = content
    .slice(resultStart + resultMarker.length)
    .search(/\n    [A-Za-z_$][A-Za-z0-9_$]*:/);

  if (nextRouteStart === -1) {
    return content.slice(methodStart);
  }

  return content.slice(methodStart, resultStart + resultMarker.length + nextRouteStart);
}

function getProblemDeclarationsFingerprint(content: string, methodName: string): string {
  const declarationPattern = new RegExp(
    `export const ${escapeRegExp(methodName)}ProblemDeclarations = \\[([\\s\\S]*?)\\] as const`,
  );
  const declaration = content.match(declarationPattern)?.[1] ?? "";
  const problems = [...declaration.matchAll(/\{ ([^}]+) \}/g)].map((match) =>
    parseGeneratedProblemDeclaration(match[1] ?? ""),
  );

  return JSON.stringify(problems.sort(compareGeneratedProblems));
}

function parseGeneratedProblemDeclaration(declaration: string): {
  readonly code: string;
  readonly category: string;
  readonly status: number;
  readonly description?: string;
  readonly type?: string;
} {
  const fields = new Map<string, string | number>();
  const fieldPattern = /(\w+): ('(?:\\.|[^'\\])*'|\d+)/g;

  for (const match of declaration.matchAll(fieldPattern)) {
    const name = match[1];
    const rawValue = match[2];

    if (name && rawValue) {
      fields.set(name, parseGeneratedProblemValue(rawValue));
    }
  }

  return {
    code: String(fields.get("code")),
    category: String(fields.get("category")),
    status: Number(fields.get("status")),
    ...(typeof fields.get("description") === "string"
      ? { description: String(fields.get("description")) }
      : {}),
    ...(typeof fields.get("type") === "string" ? { type: String(fields.get("type")) } : {}),
  };
}

function parseGeneratedProblemValue(value: string): string | number {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }

  return value;
}

function compareGeneratedProblems(
  left: { readonly code: string; readonly category: string; readonly status: number },
  right: { readonly code: string; readonly category: string; readonly status: number },
): number {
  return (
    left.code.localeCompare(right.code) ||
    left.category.localeCompare(right.category) ||
    left.status - right.status
  );
}

function getGeneratedTypeName(methodName: string, suffix: string): string {
  return `${toPascalCase(methodName)}${suffix}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generateClientIndex(
  domainRoutes: readonly DomainRoutes[],
  options: GenerateClientOptions = {},
): string {
  const clientExports = domainRoutes.map((domainRoute) => {
    const clientTypeName = `${toPascalCase(domainRoute.domain)}Client`;
    const exports = [
      `create${clientTypeName}`,
      `${domainRoute.domain}Client`,
      `${domainRoute.domain}ContractRoutes`,
      getQueryKeysName(domainRoute),
      ...(domainRoute.routes.some(isMutationRoute)
        ? [`${domainRoute.domain}InvalidationManifest`]
        : []),
    ];

    return `export { ${exports.join(", ")} } from './${domainRoute.domain}';`;
  });
  const clientTypeExports = domainRoutes.map(
    (domainRoute) =>
      `export type { ${toPascalCase(domainRoute.domain)}Client } from './${domainRoute.domain}';`,
  );
  const namespaceExports = domainRoutes.map(
    (domainRoute) => `export * as ${domainRoute.domain}Rpc from './${domainRoute.domain}';`,
  );
  const manifestSourceExport = options.manifestBundlePath
    ? "export { crocoManifestBundleSource, type CrocoManifestBundleSource } from './manifest-source';"
    : null;

  return `export * from './rpc';
${[
  ...clientExports,
  ...clientTypeExports,
  ...namespaceExports,
  ...(manifestSourceExport ? [manifestSourceExport] : []),
].join("\n")}
`;
}

function generateManifestSource(manifestBundlePath: string): string {
  const directory = normalizeProjectManifestBundlePath(manifestBundlePath);
  const artifacts = createProjectManifestBundleArtifactPaths(directory);

  return `export const crocoManifestBundleSource = {
  schemaVersion: 'croco.rpc.manifest-source.v1',
  directory: ${literalValueToTypeScript(directory)},
  artifacts: {
${Object.entries(artifacts)
  .map(([key, artifactPath]) => `    ${key}: ${literalValueToTypeScript(artifactPath)},`)
  .join("\n")}
  },
} as const;

export type CrocoManifestBundleSource = typeof crocoManifestBundleSource;
`;
}

function getResponseHelperImports(options: ResponseHelperOptions): string {
  const valueHelpers: string[] = [
    "createRpcClientRequest",
    "handleRpcRequestError",
    "handleRpcRequestResultError",
  ];

  if (options.hasOutputRoutes) {
    valueHelpers.push("handleJsonResponse");
    valueHelpers.push("handleJsonResult");
  }

  if (options.hasNoOutputRoutes) {
    valueHelpers.push("readOptionalJsonResponse");
    valueHelpers.push("readOptionalJsonResult");
  }

  if (options.hasFormRoutes) {
    valueHelpers.push("toRpcFormProblem");
  }

  if (options.hasQueryKeyInputs) {
    valueHelpers.push("serializeRpcQueryKeyInput");
  }

  const typeHelpers = [
    "RpcClientConfig",
    "RpcClientRequestOptions",
    "RpcClientResult",
    "RpcDeclaredProblem",
  ];

  if (options.hasFormRoutes) {
    typeHelpers.push(
      "RpcDomainProblem",
      "RpcFormFieldProblem",
      "RpcFormGlobalProblem",
      "RpcFormModel",
    );
  }

  typeHelpers.push("RpcProblemDetailsFor");

  if (options.hasFormRoutes) {
    typeHelpers.push("RpcValidationProblem");
  }

  return `import { ${valueHelpers.join(", ")} } from './rpc';
import type { ${typeHelpers.join(", ")} } from './rpc';\n`;
}

function generateRpcSupport(options: GenerateClientOptions = {}): string {
  if (options.problemRuntime === "frontend-problems") {
    return `import { Problem, ProblemCategory } from '@croco/problems-core';
import {
  ProblemClientError as RpcClientProblemError,
  ProblemResponseError as RpcClientResponseError,
  ProblemStatusMismatchError as RpcClientStatusMismatchError,
  assertProblemExhaustive as assertExhaustiveProblem,
  handleJsonResponse as handleProblemJsonResponse,
  handleJsonResult as handleProblemJsonResult,
  readOptionalJsonResponse as readProblemOptionalJsonResponse,
  readOptionalJsonResult as readProblemOptionalJsonResult,
  toProblemFormProblem as toRpcFormProblem,
} from '@croco/frontend-problems';

import type {
  ProblemClientExternalFailure as RpcClientResponseFailure,
  ProblemClientProblemFailure as RpcClientProblemFailure,
  ProblemClientSuccess as RpcClientSuccess,
  ProblemDeclaration as RpcDeclaredProblem,
  ProblemDetails as RpcProblemDetails,
  ProblemDetailsFor as RpcProblemDetailsFor,
  ProblemDomainDeclaration as RpcDomainProblem,
  ProblemFormField as RpcFormField,
  ProblemFormFieldControl as RpcFormFieldControl,
  ProblemFormFieldErrors as RpcFormFieldErrors,
  ProblemFormFieldOption as RpcFormFieldOption,
  ProblemFormFieldProblem as RpcFormFieldProblem,
  ProblemFormFieldValueKind as RpcFormFieldValueKind,
  ProblemFormGlobalProblem as RpcFormGlobalProblem,
  ProblemFormModel as RpcFormModel,
  ProblemFormProblem as RpcFormProblem,
  ProblemValidationDeclaration as RpcValidationProblem,
} from '@croco/frontend-problems';

export {
  RpcClientProblemError,
  RpcClientResponseError,
  RpcClientStatusMismatchError,
  assertExhaustiveProblem,
  toRpcFormProblem,
};

export type {
  ProblemClientProblemFailure as RpcClientProblemFailure,
  ProblemClientSuccess as RpcClientSuccess,
  ProblemDeclaration as RpcDeclaredProblem,
  ProblemDetails as RpcProblemDetails,
  ProblemDetailsFor as RpcProblemDetailsFor,
  ProblemDomainDeclaration as RpcDomainProblem,
  ProblemFormField as RpcFormField,
  ProblemFormFieldControl as RpcFormFieldControl,
  ProblemFormFieldErrors as RpcFormFieldErrors,
  ProblemFormFieldOption as RpcFormFieldOption,
  ProblemFormFieldProblem as RpcFormFieldProblem,
  ProblemFormFieldValueKind as RpcFormFieldValueKind,
  ProblemFormGlobalProblem as RpcFormGlobalProblem,
  ProblemFormModel as RpcFormModel,
  ProblemFormProblem as RpcFormProblem,
  ProblemValidationDeclaration as RpcValidationProblem,
} from '@croco/frontend-problems';

export type RpcClientExternalFailure =
  | RpcClientResponseFailure
  | {
      readonly ok: false;
      readonly kind: 'external';
      readonly error: unknown;
      readonly response: Response;
      readonly body?: undefined;
    }
  | {
      readonly ok: false;
      readonly kind: 'external';
      readonly error: unknown;
      readonly response?: undefined;
      readonly body?: undefined;
    };

export type RpcClientFailure<Problem extends RpcDeclaredProblem = never> =
  | ([Problem] extends [never] ? never : RpcClientProblemFailure<Problem>)
  | RpcClientExternalFailure;

export type RpcClientResult<T, Problem extends RpcDeclaredProblem = never> =
  | RpcClientSuccess<T>
  | RpcClientFailure<Problem>;
${generateRpcQueryKeySupport(false)}
${generateRpcTelemetrySupport()}

export async function handleJsonResponse<T = unknown>(
  response: Response,
  telemetry?: RpcTelemetryRequestState,
): Promise<T> {
  let data: T;
  try {
    data = await handleProblemJsonResponse<T>(response);
  } catch (error) {
    recordRpcTelemetryProblemRuntimeError(error, response, telemetry);
    throw error;
  }

  recordRpcTelemetrySuccess(response, telemetry);
  return data;
}

export async function handleJsonResult<
  T = unknown,
  Problem extends RpcDeclaredProblem = never,
>(
  response: Response,
  declaredProblems: readonly Problem[] = [],
  telemetry?: RpcTelemetryRequestState,
): Promise<RpcClientResult<T, Problem>> {
  let result: RpcClientResult<T, Problem>;
  try {
    result = await handleProblemJsonResult<T, Problem>(response, declaredProblems);
  } catch (error) {
    if (isRpcAbortError(error)) {
      return handleRpcRequestResultError(error, telemetry);
    }

    return handleRpcResponseResultError(error, response, telemetry);
  }

  recordRpcTelemetryResult(result, telemetry);
  return result;
}

export async function readOptionalJsonResponse(
  response: Response,
  telemetry?: RpcTelemetryRequestState,
): Promise<unknown | undefined> {
  let data: unknown | undefined;
  try {
    data = await readProblemOptionalJsonResponse(response);
  } catch (error) {
    recordRpcTelemetryProblemRuntimeError(error, response, telemetry);
    throw error;
  }

  recordRpcTelemetrySuccess(response, telemetry);
  return data;
}

export async function readOptionalJsonResult<Problem extends RpcDeclaredProblem = never>(
  response: Response,
  declaredProblems: readonly Problem[] = [],
  telemetry?: RpcTelemetryRequestState,
): Promise<RpcClientResult<unknown | undefined, Problem>> {
  let result: RpcClientResult<unknown | undefined, Problem>;
  try {
    result = await readProblemOptionalJsonResult<Problem>(response, declaredProblems);
  } catch (error) {
    if (isRpcAbortError(error)) {
      return handleRpcRequestResultError(error, telemetry);
    }

    return handleRpcResponseResultError(error, response, telemetry);
  }

  recordRpcTelemetryResult(result, telemetry);
  return result;
}

function recordRpcTelemetryProblemRuntimeError(
  error: unknown,
  response: Response,
  telemetry?: RpcTelemetryRequestState,
): void {
  if (isRpcAbortError(error)) {
    return handleRpcRequestError(error, telemetry);
  }

  if (error instanceof RpcClientProblemError) {
    recordRpcTelemetryProblem(error.problem, undefined, response, telemetry);
    return;
  }

  recordRpcTelemetryExternal(error, response, telemetry);
}
`;
  }

  return `import { Problem, ProblemCategory } from '@croco/problems-core';

export type RpcProblemDetails<
  Code extends string = string,
  Status extends number = number,
> = {
  type: string;
  title: string;
  status: Status;
  code: Code;
  detail?: string;
  instance?: string;
} & Record<string, unknown>;

export type RpcDeclaredProblem<
  Code extends string = string,
  Category extends string = string,
  Status extends number = number,
> = {
  readonly code: Code;
  readonly category: Category;
  readonly status: Status;
  readonly description?: string;
  readonly type?: string;
  readonly cookbookPath?: string;
};

export type RpcProblemDetailsFor<Problem extends RpcDeclaredProblem> =
  Problem extends RpcDeclaredProblem
    ? RpcProblemDetails<Problem['code'], Problem['status']>
    : never;

export type RpcClientSuccess<T> = {
  readonly ok: true;
  readonly data: T;
  readonly response: Response;
};

export type RpcClientProblemFailure<Problem extends RpcDeclaredProblem> =
  Problem extends RpcDeclaredProblem
    ? {
        readonly ok: false;
        readonly kind: 'problem';
        readonly code: Problem['code'];
        readonly category: Problem['category'];
        readonly status: Problem['status'];
        readonly problem: RpcProblemDetailsFor<Problem>;
        readonly declaration: Problem;
        readonly response: Response;
      }
    : never;

export type RpcClientExternalFailure =
  | {
      readonly ok: false;
      readonly kind: 'external';
      readonly error: unknown;
      readonly response: Response;
      readonly body?: unknown;
    }
  | {
      readonly ok: false;
      readonly kind: 'external';
      readonly error: unknown;
      readonly response?: undefined;
      readonly body?: undefined;
    };

export type RpcClientFailure<Problem extends RpcDeclaredProblem = never> =
  | ([Problem] extends [never] ? never : RpcClientProblemFailure<Problem>)
  | RpcClientExternalFailure;

export type RpcClientResult<T, Problem extends RpcDeclaredProblem = never> =
  | RpcClientSuccess<T>
  | RpcClientFailure<Problem>;

${generateRpcTelemetrySupport()}

export type RpcQueryKeyValue =
  | string
  | number
  | boolean
  | null
  | readonly RpcQueryKeyValue[]
  | { readonly [key: string]: RpcQueryKeyValue };

export type RpcFormFieldControl =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'multi-select'
  | 'list';

export type RpcFormFieldValueKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'array';

export type RpcFormFieldOption = {
  readonly label: string;
  readonly value: string | number | boolean | null;
};

export type RpcFormField<Value = unknown> = {
  readonly name: string;
  readonly label: string;
  readonly control: RpcFormFieldControl;
  readonly valueKind: RpcFormFieldValueKind;
  readonly required: boolean;
  readonly initialValue: Value;
  readonly options?: readonly RpcFormFieldOption[];
};

export type RpcFormModel<
  Values extends Record<string, unknown>,
  FieldName extends keyof Values & string,
> = {
  readonly routeId: string;
  readonly operationId: string;
  readonly methodName: string;
  readonly method: string;
  readonly path: string;
  readonly fieldNames: readonly FieldName[];
  readonly fields: readonly RpcFormField<Values[FieldName]>[];
  readonly initialValues: Values;
};

export type RpcValidationProblem<Problem extends RpcDeclaredProblem> = Extract<
  Problem,
  { readonly category: 'ValidationError' }
>;

export type RpcDomainProblem<Problem extends RpcDeclaredProblem> = Exclude<
  Problem,
  RpcValidationProblem<Problem>
>;

export type RpcFormFieldErrors<FieldName extends string> = Partial<
  Record<FieldName, readonly string[]>
>;

export type RpcFormFieldProblem<
  FieldName extends string,
  Problem extends RpcDeclaredProblem,
> = [Problem] extends [never]
  ? never
  : Problem extends RpcDeclaredProblem
    ? {
        readonly kind: 'field-validation';
        readonly code: Problem['code'];
        readonly category: Problem['category'];
        readonly status: Problem['status'];
        readonly fields: RpcFormFieldErrors<FieldName>;
        readonly problem: RpcProblemDetailsFor<Problem>;
        readonly declaration: Problem;
        readonly response: Response;
      }
    : never;

export type RpcFormGlobalProblem<Problem extends RpcDeclaredProblem> = [Problem] extends [never]
  ? never
  : Problem extends RpcDeclaredProblem
    ? {
        readonly kind: 'global-problem';
        readonly code: Problem['code'];
        readonly category: Problem['category'];
        readonly status: Problem['status'];
        readonly problem: RpcProblemDetailsFor<Problem>;
        readonly declaration: Problem;
        readonly response: Response;
      }
    : never;

export type RpcFormProblem<
  FieldName extends string,
  Problem extends RpcDeclaredProblem,
> =
  | RpcFormFieldProblem<FieldName, RpcValidationProblem<Problem>>
  | RpcFormGlobalProblem<RpcDomainProblem<Problem>>;

export class RpcClientProblemError extends Error {
  readonly problem: RpcProblemDetails;
  readonly response: Response;

  constructor(problem: RpcProblemDetails, response: Response) {
    super(problem.detail ?? problem.title);
    this.name = 'RpcClientProblemError';
    this.problem = problem;
    this.response = response;
  }
}

export class RpcClientResponseError extends Error {
  readonly response: Response;
  readonly body?: unknown;
  readonly cause?: unknown;

  constructor(response: Response, body?: unknown, cause?: unknown) {
    super(\`RPC request failed with HTTP \${response.status}\`);
    this.name = 'RpcClientResponseError';
    this.response = response;
    this.body = body;
    this.cause = cause;
  }
}

export class RpcClientStatusMismatchError extends Problem {
  readonly code = 'rpc-codegen/status-mismatch';
  readonly category = ProblemCategory.InternalServerError;
  readonly response: Response;
  readonly httpStatus: number;
  readonly problemStatus: number;

  constructor(response: Response, problemStatus: number) {
    super(
      undefined,
      undefined,
      \`RPC Problem status mismatch: HTTP \${response.status}, Problem \${problemStatus}\`,
    );
    this.response = response;
    this.httpStatus = response.status;
    this.problemStatus = problemStatus;
  }
}

export class RpcQueryKeyInputError extends Problem {
  readonly code = 'rpc-codegen/query-key-input-unsupported';
  readonly category = ProblemCategory.ValidationError;
  readonly path: string;

  constructor(path: string, detail: string) {
    super(undefined, undefined, \`RPC query key input \${detail}; unsupported value at \${path}.\`, {
      extensions: { path },
    });
    this.path = path;
  }
}

export async function handleJsonResponse<T = unknown>(
  response: Response,
  telemetry?: RpcTelemetryRequestState,
): Promise<T> {
  if (!response.ok) {
    return rejectErrorResponse(response, telemetry);
  }

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch (cause) {
    if (isRpcAbortError(cause)) {
      return handleRpcRequestError(cause, telemetry);
    }

    if (cause instanceof SyntaxError) {
      const error = new RpcClientResponseError(response, undefined, cause);
      recordRpcTelemetryExternal(error, response, telemetry);
      throw error;
    }

    recordRpcTelemetryExternal(cause, response, telemetry);
    throw cause;
  }

  recordRpcTelemetrySuccess(response, telemetry);
  return data;
}

export async function handleJsonResult<
  T = unknown,
  Problem extends RpcDeclaredProblem = never,
>(
  response: Response,
  declaredProblems: readonly Problem[] = [],
  telemetry?: RpcTelemetryRequestState,
): Promise<RpcClientResult<T, Problem>> {
  if (!response.ok) {
    return readErrorResult(response, declaredProblems, telemetry);
  }

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch (cause) {
    if (isRpcAbortError(cause)) {
      return handleRpcRequestResultError(cause, telemetry);
    }

    return handleRpcResponseResultError(
      cause instanceof SyntaxError ? new RpcClientResponseError(response, undefined, cause) : cause,
      response,
      telemetry,
    );
  }

  const result: RpcClientResult<T, Problem> = { ok: true, data, response };
  recordRpcTelemetryResult(result, telemetry);

  return result;
}

export async function readOptionalJsonResponse(
  response: Response,
  telemetry?: RpcTelemetryRequestState,
): Promise<unknown | undefined> {
  if (!response.ok) {
    return rejectErrorResponse(response, telemetry);
  }

  if (response.status === 204) {
    recordRpcTelemetrySuccess(response, telemetry);
    return undefined;
  }

  let body: string | undefined;
  let data: unknown | undefined;
  try {
    body = await response.text();
  } catch (cause) {
    if (isRpcAbortError(cause)) {
      return handleRpcRequestError(cause, telemetry);
    }

    recordRpcTelemetryExternal(cause, response, telemetry);
    throw cause;
  }

  try {
    data = body.length === 0 ? undefined : (JSON.parse(body) as unknown);
  } catch (cause) {
    const error = new RpcClientResponseError(response, body, cause);
    recordRpcTelemetryExternal(error, response, telemetry);
    throw error;
  }

  recordRpcTelemetrySuccess(response, telemetry);
  return data;
}

export async function readOptionalJsonResult<Problem extends RpcDeclaredProblem = never>(
  response: Response,
  declaredProblems: readonly Problem[] = [],
  telemetry?: RpcTelemetryRequestState,
): Promise<RpcClientResult<unknown | undefined, Problem>> {
  if (!response.ok) {
    return readErrorResult(response, declaredProblems, telemetry);
  }

  if (response.status === 204) {
    const result: RpcClientResult<unknown | undefined, Problem> = { ok: true, data: undefined, response };
    recordRpcTelemetryResult(result, telemetry);

    return result;
  }

  let body: string;

  try {
    body = await response.text();
  } catch (cause) {
    if (isRpcAbortError(cause)) {
      return handleRpcRequestResultError(cause, telemetry);
    }

    return handleRpcResponseResultError(cause, response, telemetry);
  }

  if (body.length === 0) {
    const result: RpcClientResult<unknown | undefined, Problem> = { ok: true, data: undefined, response };
    recordRpcTelemetryResult(result, telemetry);

    return result;
  }

  let data: unknown;

  try {
    data = JSON.parse(body) as unknown;
  } catch (cause) {
    const error = new RpcClientResponseError(response, body, cause);
    return handleRpcResponseResultError(error, response, telemetry);
  }

  const result: RpcClientResult<unknown | undefined, Problem> = { ok: true, data, response };
  recordRpcTelemetryResult(result, telemetry);

  return result;
}

export function assertExhaustiveProblem(problem: never): never {
  const value = problem as { readonly code?: unknown } | undefined;
  const suffix = typeof value?.code === 'string' ? \`: \${value.code}\` : '';

  throw new Error(\`Unhandled RPC Problem variant\${suffix}\`);
}

export function serializeRpcQueryKeyInput(value: unknown): RpcQueryKeyValue {
  return serializeRpcQueryKeyValue(value, 'input') ?? null;
}

function serializeRpcQueryKeyValue(value: unknown, path: string): RpcQueryKeyValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      return value;
    }

    throw new RpcQueryKeyInputError(path, 'only supports finite numbers');
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const result = serializeRpcQueryKeyValue(item, \`\${path}[\${index}]\`);

      return result === undefined ? [] : [result];
    });
  }

  if (isRpcQueryKeyRecord(value)) {
    const serialized: Record<string, RpcQueryKeyValue> = {};

    for (const [key, item] of Object.entries(value).sort(compareRpcQueryKeyRecordEntries)) {
      const result = serializeRpcQueryKeyValue(item, \`\${path}.\${key}\`);

      if (result !== undefined) {
        serialized[key] = result;
      }
    }

    return serialized;
  }

  throw new RpcQueryKeyInputError(path, 'only supports JSON-safe primitives, arrays, and plain objects');
}

function isRpcQueryKeyRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return (
    prototype === Object.prototype ||
    prototype === null ||
    Object.prototype.hasOwnProperty.call(prototype, 'isPrototypeOf')
  );
}

function compareRpcQueryKeyRecordEntries(
  [left]: [string, unknown],
  [right]: [string, unknown],
): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

async function rejectErrorResponse(
  response: Response,
  telemetry?: RpcTelemetryRequestState,
): Promise<never> {
  let body: unknown;

  try {
    body = await response.json();
  } catch (cause) {
    if (isRpcAbortError(cause)) {
      return handleRpcRequestError(cause, telemetry);
    }

    const error = new RpcClientResponseError(response, undefined, cause);
    recordRpcTelemetryExternal(error, response, telemetry);
    throw error;
  }

  if (isRpcProblemDetails(body)) {
    const statusMismatch = createRpcStatusMismatchError(response, body);

    if (statusMismatch) {
      recordRpcTelemetryExternal(statusMismatch, response, telemetry);
      throw statusMismatch;
    }

    const error = new RpcClientProblemError(body, response);
    recordRpcTelemetryProblem(body, undefined, response, telemetry);
    throw error;
  }

  const error = new RpcClientResponseError(response, body);
  recordRpcTelemetryExternal(error, response, telemetry);
  throw error;
}

async function readErrorResult<Problem extends RpcDeclaredProblem>(
  response: Response,
  declaredProblems: readonly Problem[],
  telemetry?: RpcTelemetryRequestState,
): Promise<RpcClientFailure<Problem>> {
  let body: unknown;

  try {
    body = await response.json();
  } catch (cause) {
    if (isRpcAbortError(cause)) {
      return handleRpcResponseResultError(cause, response, telemetry);
    }

    const error = new RpcClientResponseError(response, undefined, cause);
    const result: RpcClientFailure<Problem> = {
      ok: false,
      kind: 'external',
      error,
      response,
    };
    recordRpcTelemetryResult(result, telemetry);

    return result;
  }

  if (isRpcProblemDetails(body)) {
    const statusMismatch = createRpcStatusMismatchError(response, body);

    if (statusMismatch) {
      const result: RpcClientFailure<Problem> = {
        ok: false,
        kind: 'external',
        error: statusMismatch,
        response,
        body,
      };
      recordRpcTelemetryResult(result, telemetry);

      return result;
    }

    const declaration = findDeclaredProblem(body, declaredProblems);

    if (declaration) {
      const result = {
        ok: false,
        kind: 'problem',
        code: declaration.code,
        category: declaration.category,
        status: declaration.status,
        problem: body as RpcProblemDetailsFor<Problem>,
        declaration,
        response,
      } as RpcClientFailure<Problem>;
      recordRpcTelemetryResult(result, telemetry);

      return result;
    }

    const error = new RpcClientProblemError(body, response);
    const result: RpcClientFailure<Problem> = {
      ok: false,
      kind: 'external',
      error,
      response,
      body,
    };
    recordRpcTelemetryResult(result, telemetry);

    return {
      ...result,
    };
  }

  const result: RpcClientFailure<Problem> = {
    ok: false,
    kind: 'external',
    error: new RpcClientResponseError(response, body),
    response,
    body,
  };
  recordRpcTelemetryResult(result, telemetry);

  return result;
}

export function toRpcFormProblem<
  FieldName extends string,
  Problem extends RpcDeclaredProblem,
>(
  failure: RpcClientProblemFailure<Problem>,
  fieldNames: readonly FieldName[],
): RpcFormProblem<FieldName, Problem> {
  if (failure.category === 'ValidationError') {
    return {
      kind: 'field-validation',
      code: failure.code,
      category: failure.category,
      status: failure.status,
      fields: extractRpcFormFieldErrors(failure.problem, fieldNames),
      problem: failure.problem,
      declaration: failure.declaration,
      response: failure.response,
    } as RpcFormProblem<FieldName, Problem>;
  }

  return {
    kind: 'global-problem',
    code: failure.code,
    category: failure.category,
    status: failure.status,
    problem: failure.problem,
    declaration: failure.declaration,
    response: failure.response,
  } as RpcFormProblem<FieldName, Problem>;
}

function extractRpcFormFieldErrors<FieldName extends string>(
  problem: RpcProblemDetails,
  fieldNames: readonly FieldName[],
): RpcFormFieldErrors<FieldName> {
  const source = getRpcFormFieldErrorSource(problem);
  const errors: Partial<Record<FieldName, readonly string[]>> = {};

  if (!source) {
    return errors;
  }

  for (const fieldName of fieldNames) {
    const value = source[fieldName];

    if (typeof value === 'string') {
      errors[fieldName] = [value];
      continue;
    }

    if (Array.isArray(value)) {
      const messages = value.filter((item): item is string => typeof item === 'string');

      if (messages.length > 0) {
        errors[fieldName] = messages;
      }
    }
  }

  return errors;
}

function getRpcFormFieldErrorSource(problem: RpcProblemDetails): Record<string, unknown> | undefined {
  if (isRecord(problem.fields)) {
    return problem.fields;
  }

  if (isRecord(problem.fieldErrors)) {
    return problem.fieldErrors;
  }

  return undefined;
}

function findDeclaredProblem<Problem extends RpcDeclaredProblem>(
  problem: RpcProblemDetails,
  declaredProblems: readonly Problem[],
): Problem | undefined {
  return declaredProblems.find(
    (declaration) => declaration.code === problem.code && declaration.status === problem.status,
  );
}

function createRpcStatusMismatchError(
  response: Response,
  problem: RpcProblemDetails,
): RpcClientStatusMismatchError | undefined {
  return response.status === problem.status
    ? undefined
    : new RpcClientStatusMismatchError(response, problem.status);
}

function isRpcProblemDetails(value: unknown): value is RpcProblemDetails {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.type === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'number' &&
    typeof value.code === 'string' &&
    (value.detail === undefined || typeof value.detail === 'string') &&
    (value.instance === undefined || typeof value.instance === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
  `;
}

function generateRpcTelemetrySupport(): string {
  return `export type RpcRouteKind = 'query' | 'mutation';

export type RpcRouteTelemetryMetadata = {
  readonly routeId: string;
  readonly operationId: string;
  readonly methodName: string;
  readonly method: string;
  readonly path: string;
};

export type RpcTelemetryEventKind =
  | 'rpc.request.started'
  | 'rpc.request.retry'
  | 'rpc.request.succeeded'
  | 'rpc.request.problem'
  | 'rpc.request.external_failure'
  | 'rpc.request.cancelled'
  | 'rpc.mutation.started'
  | 'rpc.mutation.succeeded'
  | 'rpc.mutation.problem'
  | 'rpc.mutation.external_failure'
  | 'rpc.mutation.cancelled';

export type RpcTelemetryProblemSummary = {
  readonly code: string;
  readonly status: number;
  readonly category?: string;
  readonly type?: string;
  readonly title?: string;
};

export type RpcTelemetryRequestContext = RpcRouteTelemetryMetadata & {
  readonly routeKind: RpcRouteKind;
  readonly interactionId?: string;
  readonly correlationId?: string;
  readonly traceparent?: string;
  readonly attempt?: number;
};

export type RpcTelemetryEvent = RpcTelemetryRequestContext & {
  readonly kind: RpcTelemetryEventKind;
  readonly timestamp: number;
  readonly durationMs?: number;
  readonly status?: number;
  readonly problem?: RpcTelemetryProblemSummary;
  readonly errorName?: string;
  readonly errorMessage?: string;
};

export type RpcTelemetryBridge = {
  readonly createHeaders?: (
    context: RpcTelemetryRequestContext,
  ) => Record<string, string> | undefined;
  readonly record?: (event: RpcTelemetryEvent) => void;
};

export type RpcClientFetch = (url: string, init: RequestInit) => Promise<Response>;

export type RpcClientRequestDefaults = Omit<
  RequestInit,
  'body' | 'headers' | 'method' | 'signal'
>;

export type RpcClientRequestOptions = {
  readonly telemetry?: RpcTelemetryBridge;
  readonly interactionId?: string;
  readonly correlationId?: string;
  readonly traceparent?: string;
  readonly attempt?: number;
  readonly headers?: HeadersInit;
  readonly request?: RpcClientRequestDefaults;
  readonly signal?: AbortSignal;
};

export type RpcClientConfig = RpcClientRequestOptions & {
  readonly baseUrl?: string;
  readonly fetch?: RpcClientFetch;
};

export type RpcTelemetryRequestState = RpcTelemetryRequestContext & {
  readonly telemetry: RpcTelemetryBridge;
  readonly startedAt: number;
};

export type RpcClientRequest = {
  readonly url: string;
  readonly init: RequestInit;
  readonly fetch: RpcClientFetch;
  readonly telemetry?: RpcTelemetryRequestState;
};

function joinRpcUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  base.pathname = base.pathname.replace(/\\/+$/, '') + '/';
  return new URL('./' + path.replace(/^\\/+/, ''), base).toString();
}

export function createRpcClientRequest(
  route: RpcRouteTelemetryMetadata,
  routeKind: RpcRouteKind,
  url: string,
  init: RequestInit,
  options: RpcClientRequestOptions = {},
  config: RpcClientConfig = {},
): RpcClientRequest {
  const effectiveOptions: RpcClientRequestOptions = { ...config, ...options };
  const context = createRpcTelemetryRequestContext(route, routeKind, effectiveOptions);
  const telemetryHeaders = effectiveOptions.telemetry?.createHeaders?.(context);
  const headers = mergeRpcHeaders(config.headers, init.headers, telemetryHeaders, options.headers);
  const requestInit: RequestInit = {
    ...config.request,
    ...options.request,
    ...init,
    ...(headers ? { headers } : {}),
    ...(effectiveOptions.signal ? { signal: effectiveOptions.signal } : {}),
  };
  const fetchImpl = config.fetch ?? fetch;
  const request = {
    url: config.baseUrl === undefined ? url : joinRpcUrl(config.baseUrl, url),
    init: requestInit,
    fetch: (requestUrl: string, fetchInit: RequestInit) => fetchImpl(requestUrl, fetchInit),
  };

  if (!effectiveOptions.telemetry) {
    return request;
  }

  const telemetry: RpcTelemetryRequestState = {
    ...context,
    telemetry: effectiveOptions.telemetry,
    startedAt: nowRpcTelemetry(),
  };

  recordRpcTelemetryEvent(telemetry, 'rpc.request.started');

  if ((effectiveOptions.attempt ?? 1) > 1) {
    recordRpcTelemetryEvent(telemetry, 'rpc.request.retry');
  }

  if (routeKind === 'mutation') {
    recordRpcTelemetryEvent(telemetry, 'rpc.mutation.started');
  }

  return { ...request, telemetry };
}

export function handleRpcRequestError(
  error: unknown,
  telemetry?: RpcTelemetryRequestState,
): never {
  const failure = handleRpcRequestResultError(error, telemetry);
  throw failure.error;
}

export function handleRpcRequestResultError(
  error: unknown,
  telemetry?: RpcTelemetryRequestState,
): RpcClientExternalFailure {
  if (isRpcAbortError(error)) {
    recordRpcTelemetryEvent(telemetry, 'rpc.request.cancelled', describeRpcError(error));
    recordRpcMutationTelemetryEvent(telemetry, 'rpc.mutation.cancelled', describeRpcError(error));
  } else {
    recordRpcTelemetryEvent(telemetry, 'rpc.request.external_failure', describeRpcError(error));
    recordRpcMutationTelemetryEvent(telemetry, 'rpc.mutation.external_failure', describeRpcError(error));
  }

  return { ok: false, kind: 'external', error };
}

function handleRpcResponseResultError(
  error: unknown,
  response: Response,
  telemetry?: RpcTelemetryRequestState,
): RpcClientExternalFailure {
  if (isRpcAbortError(error)) {
    const event = { status: response.status, ...describeRpcError(error) };
    recordRpcTelemetryEvent(telemetry, 'rpc.request.cancelled', event);
    recordRpcMutationTelemetryEvent(telemetry, 'rpc.mutation.cancelled', event);
  } else {
    recordRpcTelemetryExternal(error, response, telemetry);
  }

  return { ok: false, kind: 'external', error, response };
}

function createRpcTelemetryRequestContext(
  route: RpcRouteTelemetryMetadata,
  routeKind: RpcRouteKind,
  options: RpcClientRequestOptions,
): RpcTelemetryRequestContext {
  return {
    routeId: route.routeId,
    operationId: route.operationId,
    methodName: route.methodName,
    method: route.method,
    path: route.path,
    routeKind,
    ...(options.interactionId ? { interactionId: options.interactionId } : {}),
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options.traceparent ? { traceparent: options.traceparent } : {}),
    ...(options.attempt ? { attempt: options.attempt } : {}),
  };
}

function mergeRpcHeaders(
  ...sources: readonly (HeadersInit | Record<string, string> | undefined)[]
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const headerNames = new Map<string, string>();

  const setHeader = (key: string, value: string): void => {
    const normalizedKey = key.toLowerCase();
    const previousKey = headerNames.get(normalizedKey);

    if (previousKey && previousKey !== key) {
      delete headers[previousKey];
    }

    headers[key] = value;
    headerNames.set(normalizedKey, key);
  };

  for (const source of sources) {
    if (!source) {
      continue;
    }

    if (typeof Headers !== 'undefined' && source instanceof Headers) {
      source.forEach((value, key) => {
        setHeader(key, value);
      });
      continue;
    }

    if (Array.isArray(source)) {
      const tupleHeaders = new Map<string, { readonly name: string; readonly value: string }>();

      for (const [key, value] of source) {
        const normalizedKey = key.toLowerCase();
        const previous = tupleHeaders.get(normalizedKey);
        tupleHeaders.set(normalizedKey, {
          name: key,
          value: previous ? previous.value + ', ' + value : value,
        });
      }

      for (const { name, value } of tupleHeaders.values()) {
        setHeader(name, value);
      }
      continue;
    }

    for (const [key, value] of Object.entries(source)) {
      setHeader(key, String(value));
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function recordRpcTelemetryResult<Problem extends RpcDeclaredProblem>(
  result: RpcClientResult<unknown, Problem>,
  telemetry?: RpcTelemetryRequestState,
): void {
  if (result.ok) {
    recordRpcTelemetrySuccess(result.response, telemetry);
    return;
  }

  if (result.kind === 'problem') {
    recordRpcTelemetryProblem(result.problem, result.declaration, result.response, telemetry);
    return;
  }

  if (result.response) {
    recordRpcTelemetryExternal(result.error, result.response, telemetry);
    return;
  }

  recordRpcTelemetryEvent(telemetry, 'rpc.request.external_failure', describeRpcError(result.error));
  recordRpcMutationTelemetryEvent(telemetry, 'rpc.mutation.external_failure', describeRpcError(result.error));
}

function recordRpcTelemetrySuccess(
  response: Response,
  telemetry?: RpcTelemetryRequestState,
): void {
  recordRpcTelemetryEvent(telemetry, 'rpc.request.succeeded', { status: response.status });
  recordRpcMutationTelemetryEvent(telemetry, 'rpc.mutation.succeeded', { status: response.status });
}

function recordRpcTelemetryProblem<Problem extends RpcDeclaredProblem>(
  problem: RpcProblemDetails,
  declaration: Problem | undefined,
  response: Response,
  telemetry?: RpcTelemetryRequestState,
): void {
  const event = {
    status: response.status,
    problem: summarizeRpcProblem(problem, declaration),
  };

  recordRpcTelemetryEvent(telemetry, 'rpc.request.problem', event);
  recordRpcMutationTelemetryEvent(telemetry, 'rpc.mutation.problem', event);
}

function recordRpcTelemetryExternal(
  error: unknown,
  response: Response,
  telemetry?: RpcTelemetryRequestState,
): void {
  if (error instanceof RpcClientProblemError) {
    const problemEvent = {
      status: response.status,
      errorName: error.name,
      problem: summarizeRpcProblem(error.problem, undefined),
    };

    recordRpcTelemetryEvent(telemetry, 'rpc.request.external_failure', problemEvent);
    recordRpcMutationTelemetryEvent(telemetry, 'rpc.mutation.external_failure', problemEvent);
    return;
  }

  const event = {
    status: response.status,
    ...describeRpcError(error),
  };

  recordRpcTelemetryEvent(telemetry, 'rpc.request.external_failure', event);
  recordRpcMutationTelemetryEvent(telemetry, 'rpc.mutation.external_failure', event);
}

function recordRpcMutationTelemetryEvent(
  telemetry: RpcTelemetryRequestState | undefined,
  kind: Extract<RpcTelemetryEventKind, \`rpc.mutation.\${string}\`>,
  fields: Partial<RpcTelemetryEvent> = {},
): void {
  if (telemetry?.routeKind !== 'mutation') {
    return;
  }

  recordRpcTelemetryEvent(telemetry, kind, fields);
}

function recordRpcTelemetryEvent(
  telemetry: RpcTelemetryRequestState | undefined,
  kind: RpcTelemetryEventKind,
  fields: Partial<RpcTelemetryEvent> = {},
): void {
  if (!telemetry) {
    return;
  }

  const durationMs = kind === 'rpc.request.started' || kind === 'rpc.request.retry' || kind === 'rpc.mutation.started'
    ? undefined
    : Math.max(0, nowRpcTelemetry() - telemetry.startedAt);

  telemetry.telemetry.record?.({
    routeId: telemetry.routeId,
    operationId: telemetry.operationId,
    methodName: telemetry.methodName,
    method: telemetry.method,
    path: telemetry.path,
    routeKind: telemetry.routeKind,
    ...(telemetry.interactionId ? { interactionId: telemetry.interactionId } : {}),
    ...(telemetry.correlationId ? { correlationId: telemetry.correlationId } : {}),
    ...(telemetry.traceparent ? { traceparent: telemetry.traceparent } : {}),
    ...(telemetry.attempt ? { attempt: telemetry.attempt } : {}),
    kind,
    timestamp: Date.now(),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...fields,
  });
}

function summarizeRpcProblem<Problem extends RpcDeclaredProblem>(
  problem: RpcProblemDetails,
  declaration?: Problem,
): RpcTelemetryProblemSummary {
  return {
    code: problem.code,
    status: problem.status,
    ...(declaration?.category ? { category: declaration.category } : {}),
    ...(problem.type ? { type: problem.type } : {}),
    ...(problem.title ? { title: problem.title } : {}),
  };
}

function describeRpcError(error: unknown): Pick<RpcTelemetryEvent, 'errorName'> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
    };
  }

  return {
    errorName: typeof error,
  };
}

function isRpcAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function nowRpcTelemetry(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
`;
}

function generateRpcQueryKeySupport(includeProblemImport = true): string {
  const problemImport = includeProblemImport
    ? "import { Problem, ProblemCategory } from '@croco/problems-core';\n\n"
    : "";

  return `${problemImport}export type RpcQueryKeyValue =
  | string
  | number
  | boolean
  | null
  | readonly RpcQueryKeyValue[]
  | { readonly [key: string]: RpcQueryKeyValue };

export class RpcQueryKeyInputError extends Problem {
  readonly code = 'rpc-codegen/query-key-input-unsupported';
  readonly category = ProblemCategory.ValidationError;
  readonly path: string;

  constructor(path: string, detail: string) {
    super(undefined, undefined, \`RPC query key input \${detail}; unsupported value at \${path}.\`, {
      extensions: { path },
    });
    this.path = path;
  }
}

export function serializeRpcQueryKeyInput(value: unknown): RpcQueryKeyValue {
  return serializeRpcQueryKeyValue(value, 'input') ?? null;
}

function serializeRpcQueryKeyValue(value: unknown, path: string): RpcQueryKeyValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      return value;
    }

    throw new RpcQueryKeyInputError(path, 'only supports finite numbers');
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const result = serializeRpcQueryKeyValue(item, \`\${path}[\${index}]\`);

      return result === undefined ? [] : [result];
    });
  }

  if (isRpcQueryKeyRecord(value)) {
    const serialized: Record<string, RpcQueryKeyValue> = {};

    for (const [key, item] of Object.entries(value).sort(compareRpcQueryKeyRecordEntries)) {
      const result = serializeRpcQueryKeyValue(item, \`\${path}.\${key}\`);

      if (result !== undefined) {
        serialized[key] = result;
      }
    }

    return serialized;
  }

  throw new RpcQueryKeyInputError(path, 'only supports JSON-safe primitives, arrays, and plain objects');
}

function isRpcQueryKeyRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return (
    prototype === Object.prototype ||
    prototype === null ||
    Object.prototype.hasOwnProperty.call(prototype, 'isPrototypeOf')
  );
}

function compareRpcQueryKeyRecordEntries(
  [left]: [string, unknown],
  [right]: [string, unknown],
): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
`;
}

function generateInputType(route: GeneratedClientRoute): string {
  if (!needsInput(route)) {
    return "";
  }

  if (hasLegacyBodyInput(route)) {
    return `export type ${getInputTypeName(route)} = ${zodInputTypeToTypeScript("body", route.inputSchemas.body)};`;
  }

  const fields = getInputSchemaEntries(route).map(
    ([name, schema]) => `${name}: ${zodInputTypeToTypeScript(name, schema)};`,
  );

  return `export type ${getInputTypeName(route)} = { ${fields.join(" ")} };`;
}

function generateOutputType(route: GeneratedClientRoute): string {
  if (!route.outputSchema) {
    return "";
  }

  return `export type ${getOutputTypeName(route)} = ${zodTypeToTypeScript(route.outputSchema)};`;
}

function generateProblemTypes(route: GeneratedClientRoute): string {
  const problemResponses = route.problemResponses ?? [];
  const problemUnion =
    problemResponses.length === 0
      ? "never"
      : unionTypes(
          problemResponses.map(
            (problem) =>
              `RpcDeclaredProblem<${literalValueToTypeScript(problem.code)}, ${literalValueToTypeScript(problem.category)}, ${problem.status}>`,
          ),
        );

  return `export type ${getProblemTypeName(route)} = ${problemUnion};
export type ${getProblemDetailsTypeName(route)} = RpcProblemDetailsFor<${getProblemTypeName(route)}>;
export type ${getResultTypeName(route)} = RpcClientResult<${getSuccessType(route)}, ${getProblemTypeName(route)}>;`;
}

function generateProblemDeclarations(route: GeneratedClientRoute): string {
  const declarations = (route.problemResponses ?? [])
    .map((problem) => {
      const fields = [
        `code: ${literalValueToTypeScript(problem.code)}`,
        `category: ${literalValueToTypeScript(problem.category)}`,
        `status: ${problem.status}`,
      ];

      if (problem.description) {
        fields.push(`description: ${literalValueToTypeScript(problem.description)}`);
      }

      if (problem.type) {
        fields.push(`type: ${literalValueToTypeScript(problem.type)}`);
      }

      if (problem.cookbookPath) {
        fields.push(`cookbookPath: ${literalValueToTypeScript(problem.cookbookPath)}`);
      }

      return `  { ${fields.join(", ")} }`;
    })
    .join(",\n");

  return `export const ${getProblemDeclarationsName(route)} = [
${declarations}
] as const satisfies readonly RpcDeclaredProblem[];`;
}

function generateFormArtifacts(route: GeneratedClientRoute): string {
  const bodySchema = getFormBodyObjectSchema(route);

  if (!bodySchema) {
    return "";
  }

  const fields = Object.entries(getZodObjectShape(bodySchema)).map(([name, schema]) =>
    generateFormField(route, name, schema),
  );
  const fieldNameType = unionTypes(fields.map((field) => literalValueToTypeScript(field.name)));
  const valueFields = fields.map((field) => `${formatObjectKey(field.name)}: ${field.valueType};`);
  const fieldEntries = fields.map(
    (field) =>
      `{ name: ${literalValueToTypeScript(field.name)}, label: ${literalValueToTypeScript(field.label)}, control: ${literalValueToTypeScript(field.control)}, valueKind: ${literalValueToTypeScript(field.valueKind)}, required: ${field.required}, initialValue: ${field.initialValueExpression}${formatFormFieldOptions(field.options)} }`,
  );
  const fieldNames = fields.map((field) => literalValueToTypeScript(field.name)).join(", ");
  const initialValues = fields
    .map((field) => `${formatObjectKey(field.name)}: ${field.initialValueExpression}`)
    .join(", ");
  const submitFields = fields
    .map((field) => `${formatObjectKey(field.name)}: ${field.payloadValueExpression}`)
    .join(", ");
  const inputTypeName = getInputTypeName(route);
  const formValuesTypeName = getFormValuesTypeName(route);
  const submitPayloadTypeName = getSubmitPayloadTypeName(route);
  const validationProblemTypeName = getValidationProblemTypeName(route);
  const domainProblemTypeName = getDomainProblemTypeName(route);
  const formProblemTypeName = getFormProblemTypeName(route);
  const formModelName = getFormModelName(route);
  const buildPayloadName = getBuildFormPayloadName(route);
  const mapProblemName = getMapFormProblemName(route);
  const buildPayloadParameters = hasLegacyBodyInput(route)
    ? `values: ${formValuesTypeName}`
    : `context: Omit<${inputTypeName}, 'body'>, values: ${formValuesTypeName}`;
  const payloadExpression = hasLegacyBodyInput(route)
    ? `{ ${submitFields} }`
    : `{ ...context, body: { ${submitFields} } }`;

  return `export type ${getFormFieldNameTypeName(route)} = ${fieldNameType};
export type ${formValuesTypeName} = { ${valueFields.join(" ")} };
export type ${submitPayloadTypeName} = ${inputTypeName};
export type ${validationProblemTypeName} = RpcValidationProblem<${getProblemTypeName(route)}>;
export type ${domainProblemTypeName} = RpcDomainProblem<${getProblemTypeName(route)}>;
export type ${formProblemTypeName} = RpcFormFieldProblem<${getFormFieldNameTypeName(route)}, ${validationProblemTypeName}> | RpcFormGlobalProblem<${domainProblemTypeName}>;

export const ${formModelName} = {
  routeId: ${literalValueToTypeScript(getRouteId(route))},
  operationId: ${literalValueToTypeScript(getOperationId(route))},
  methodName: ${literalValueToTypeScript(route.methodName)},
  method: ${literalValueToTypeScript(route.httpMethod.toUpperCase())},
  path: ${literalValueToTypeScript(route.path)},
  fieldNames: [${fieldNames}],
  fields: [
    ${fieldEntries.join(",\n    ")}
  ],
  initialValues: { ${initialValues} },
} as const satisfies RpcFormModel<${formValuesTypeName}, ${getFormFieldNameTypeName(route)}>;

export function ${buildPayloadName}(${buildPayloadParameters}): ${submitPayloadTypeName} {
  return ${payloadExpression};
}

export function ${mapProblemName}(failure: Extract<${getResultTypeName(route)}, { ok: false; kind: 'problem' }>): ${formProblemTypeName} {
  return toRpcFormProblem<${getFormFieldNameTypeName(route)}, ${getProblemTypeName(route)}>(failure, ${formModelName}.fieldNames);
}`;
}

function getFormBodyObjectSchema(route: GeneratedClientRoute): unknown | undefined {
  if (!route.inputSchemas.body) {
    return undefined;
  }

  const analysis = analyzeFormFieldSchema(route.inputSchemas.body);
  const schemaName = getSchemaName(analysis.schema);

  if (schemaName !== "ZodObject") {
    throw new RpcCodegenUnsupportedFormSchemaProblem(
      route,
      `body uses unsupported form schema ${schemaName || "unknown schema"}.`,
    );
  }

  const unsupportedObjectMode = getUnsupportedFormBodyObjectMode(analysis.schema);

  if (unsupportedObjectMode) {
    throw new RpcCodegenUnsupportedFormSchemaProblem(
      route,
      `body object accepts unsupported ${unsupportedObjectMode} keys; generated form fields must cover every accepted body key.`,
    );
  }

  return analysis.schema;
}

function getUnsupportedFormBodyObjectMode(schema: unknown): string | undefined {
  return getZodObjectUnsupportedDynamicKeyMode(schema);
}

function generateFormField(
  route: GeneratedClientRoute,
  name: string,
  schema: unknown,
): GeneratedFormField {
  const analysis = analyzeFormFieldSchema(schema);
  const schemaName = getSchemaName(analysis.schema);
  const required = !analysis.optional && !analysis.nullable && analysis.defaultValue === undefined;
  const baseValueType = getFormFieldBaseValueType(route, name, analysis.schema);
  const valueType =
    analysis.optional || analysis.nullable ? `${baseValueType} | null` : baseValueType;
  const initialValueExpression = getFormFieldInitialValueExpression(route, name, analysis);
  const payloadValueExpression =
    analysis.optional && !analysis.nullable
      ? `${getFormValuesAccessor(name)} === null ? undefined : ${getFormValuesAccessor(name)}`
      : getFormValuesAccessor(name);

  if (schemaName === "ZodString") {
    return {
      name,
      label: toFormLabel(name),
      control: "text",
      valueKind: "string",
      required,
      valueType,
      initialValueExpression,
      payloadValueExpression,
      options: [],
    };
  }

  if (schemaName === "ZodNumber") {
    return {
      name,
      label: toFormLabel(name),
      control: "number",
      valueKind: "number",
      required,
      valueType,
      initialValueExpression,
      payloadValueExpression,
      options: [],
    };
  }

  if (schemaName === "ZodBoolean") {
    return {
      name,
      label: toFormLabel(name),
      control: "checkbox",
      valueKind: "boolean",
      required,
      valueType,
      initialValueExpression,
      payloadValueExpression,
      options: [],
    };
  }

  const options = getFormFieldOptions(analysis.schema);

  if (options.length > 0) {
    return {
      name,
      label: toFormLabel(name),
      control: "select",
      valueKind: "enum",
      required,
      valueType,
      initialValueExpression,
      payloadValueExpression,
      options,
    };
  }

  if (isZodArraySchema(analysis.schema)) {
    const elementAnalysis = analyzeFormFieldSchema(getZodArrayElementSchema(analysis.schema));
    const elementSchemaName = getSchemaName(elementAnalysis.schema);
    const elementOptions = getFormFieldOptions(elementAnalysis.schema);

    if (
      elementSchemaName !== "ZodString" &&
      elementSchemaName !== "ZodNumber" &&
      elementSchemaName !== "ZodBoolean" &&
      elementOptions.length === 0
    ) {
      throw new RpcCodegenUnsupportedFormSchemaProblem(
        route,
        `field '${name}' uses unsupported array element schema ${elementSchemaName || "unknown schema"}.`,
      );
    }

    return {
      name,
      label: toFormLabel(name),
      control: elementOptions.length > 0 ? "multi-select" : "list",
      valueKind: "array",
      required,
      valueType,
      initialValueExpression,
      payloadValueExpression,
      options: elementOptions,
    };
  }

  throw new RpcCodegenUnsupportedFormSchemaProblem(
    route,
    `field '${name}' uses unsupported form field schema ${schemaName || "unknown schema"}.`,
  );
}

function analyzeFormFieldSchema(schema: unknown): FormFieldSchemaAnalysis {
  let current = schema;
  let optional = false;
  let nullable = false;
  let defaultValue: unknown;

  while (true) {
    const schemaName = getSchemaName(current);

    if (schemaName === "ZodOptional") {
      optional = true;
      current = getZodInnerSchema(current);
      continue;
    }

    if (schemaName === "ZodNullable") {
      nullable = true;
      current = getZodInnerSchema(current);
      continue;
    }

    if (schemaName === "ZodDefault") {
      optional = true;
      defaultValue = getZodDefaultValue(current);
      current = getZodInnerSchema(current);
      continue;
    }

    if (schemaName === "ZodCatch") {
      current = getZodInnerSchema(current);
      continue;
    }

    if (schemaName === "ZodBranded" || schemaName === "ZodReadonly") {
      current = getZodInnerSchema(current);
      continue;
    }

    return {
      schema: current,
      optional,
      nullable,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };
  }
}

function getFormFieldBaseValueType(
  route: GeneratedClientRoute,
  name: string,
  schema: unknown,
): string {
  try {
    return zodTypeToTypeScript(schema);
  } catch (error) {
    if (error instanceof RpcCodegenContractProblem) {
      throw new RpcCodegenUnsupportedFormSchemaProblem(
        route,
        `field '${name}' uses unsupported form field schema ${getSchemaName(schema) || "unknown schema"}.`,
      );
    }

    throw error;
  }
}

function getFormFieldInitialValueExpression(
  route: GeneratedClientRoute,
  name: string,
  analysis: FormFieldSchemaAnalysis,
): string {
  if (analysis.defaultValue !== undefined) {
    return formLiteralValueToTypeScript(route, name, analysis.defaultValue);
  }

  if (analysis.optional || analysis.nullable) {
    return "null";
  }

  const schemaName = getSchemaName(analysis.schema);

  if (schemaName === "ZodString") {
    return "''";
  }

  if (schemaName === "ZodNumber") {
    return "0";
  }

  if (schemaName === "ZodBoolean") {
    return "false";
  }

  const options = getFormFieldOptions(analysis.schema);

  if (options.length > 0) {
    return formLiteralValueToTypeScript(route, name, options[0]?.value);
  }

  if (isZodArraySchema(analysis.schema)) {
    return "[]";
  }

  throw new RpcCodegenUnsupportedFormSchemaProblem(
    route,
    `field '${name}' uses unsupported form field schema ${schemaName || "unknown schema"}.`,
  );
}

function getFormFieldOptions(schema: unknown): FormFieldOption[] {
  const descriptor = describeZodSchema(schema as never);

  if (!descriptor?.jsonSafe) {
    return [];
  }

  if (descriptor.kind === "enum") {
    return (descriptor.values ?? []).map(toFormFieldOption);
  }

  if (descriptor.kind === "literal") {
    const value = descriptor.value;

    return isLiteralTypeValue(value) ? [toFormFieldOption(value)] : [];
  }

  if (descriptor.kind === "union") {
    const literalValues = (descriptor.options ?? []).map(getLiteralFormOptionValue);

    return literalValues.every(isLiteralTypeValue) ? literalValues.map(toFormFieldOption) : [];
  }

  return [];
}

function getLiteralFormOptionValue(descriptor: ContractSchemaDescriptor): unknown {
  return descriptor.kind === "literal" ? descriptor.value : undefined;
}

function toFormFieldOption(value: string | number | boolean | null): FormFieldOption {
  return {
    label: String(value),
    value,
  };
}

function isLiteralTypeValue(value: unknown): value is string | number | boolean | null {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function formatFormFieldOptions(options: readonly FormFieldOption[]): string {
  if (options.length === 0) {
    return "";
  }

  const entries = options
    .map(
      (option) =>
        `{ label: ${literalValueToTypeScript(option.label)}, value: ${literalValueToTypeScript(option.value)} }`,
    )
    .join(", ");

  return `, options: [${entries}]`;
}

function formLiteralValueToTypeScript(
  route: GeneratedClientRoute,
  name: string,
  value: unknown,
): string {
  if (isLiteralTypeValue(value)) {
    return literalValueToTypeScript(value);
  }

  if (Array.isArray(value) && value.every(isLiteralTypeValue)) {
    return `[${value.map(literalValueToTypeScript).join(", ")}]`;
  }

  throw new RpcCodegenUnsupportedFormSchemaProblem(
    route,
    `field '${name}' has a non-JSON-safe default value.`,
  );
}

function getFormValuesAccessor(name: string): string {
  return isJavaScriptIdentifier(name) ? `values.${name}` : `values[${formatObjectKey(name)}]`;
}

function toFormLabel(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();

  if (spaced.length === 0) {
    return name;
  }

  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function generateClientMethod(
  route: GeneratedClientRoute,
  domain: string,
  routeIndex: number,
): string {
  const input = needsInput(route)
    ? `input${hasRequiredInput(route) ? "" : "?"}: ${getInputTypeName(route)}`
    : "";
  const fetchOptions = getFetchOptions(route);
  const response = getResponseExpression(route);
  const resultResponse = getResultResponseExpression(route);
  const returnType = getReturnType(route);
  const resultReturnType = getResultReturnType(route);
  const routeMetadata = `${domain}ContractRoutes[${routeIndex}]`;
  const routeKind = isMutationRoute(route) ? "mutation" : "query";
  const requestOptions =
    input.length > 0
      ? `${input}, options?: RpcClientRequestOptions`
      : "options?: RpcClientRequestOptions";

  if (hasStructuredInput(route)) {
    return `  ${route.methodName}: (${requestOptions}): ${returnType} => {
    const path = ${getPathExpression(route)};
${getQueryStatements(route)}    const request = createRpcClientRequest(${routeMetadata}, '${routeKind}', ${getUrlExpression(route)}, ${fetchOptions}, options, config);
    return request.fetch(request.url, request.init).catch((error) => handleRpcRequestError(error, request.telemetry)).then((response) => ${response});
  },
  ${getResultMethodName(route)}: (${requestOptions}): ${resultReturnType} => {
    const path = ${getPathExpression(route)};
${getQueryStatements(route)}    const request = createRpcClientRequest(${routeMetadata}, '${routeKind}', ${getUrlExpression(route)}, ${fetchOptions}, options, config);
    return request.fetch(request.url, request.init).then((response) => ${resultResponse}, (error) => handleRpcRequestResultError(error, request.telemetry));
  },`;
  }

  return `  ${route.methodName}: (${requestOptions}): ${returnType} => {
    const request = createRpcClientRequest(${routeMetadata}, '${routeKind}', ${getPathExpression(route)}, ${fetchOptions}, options, config);
    return request.fetch(request.url, request.init).catch((error) => handleRpcRequestError(error, request.telemetry)).then((response) => ${response});
  },
  ${getResultMethodName(route)}: (${requestOptions}): ${resultReturnType} => {
    const request = createRpcClientRequest(${routeMetadata}, '${routeKind}', ${getPathExpression(route)}, ${fetchOptions}, options, config);
    return request.fetch(request.url, request.init).then((response) => ${resultResponse}, (error) => handleRpcRequestResultError(error, request.telemetry));
  },`;
}

function getFetchOptions(route: GeneratedClientRoute): string {
  const options = [`method: '${route.httpMethod.toUpperCase()}'`];

  if (hasBody(route)) {
    options.push(`body: JSON.stringify(${hasStructuredInput(route) ? "input.body" : "input"})`);
  }

  const headers = getHeadersExpression(route);

  if (headers.length > 0) {
    options.push(`headers: ${headers}`);
  }

  return `{ ${options.join(", ")} }`;
}

function getHeadersExpression(route: GeneratedClientRoute): string {
  const hasHeaderInput =
    route.inputSchemas.headers !== null && route.inputSchemas.headers !== undefined;

  if (hasHeaderInput && hasBody(route)) {
    return `{ ...serializeHeaders(input.headers), 'Content-Type': 'application/json' }`;
  }

  if (hasHeaderInput) {
    return "serializeHeaders(input.headers)";
  }

  if (hasBody(route)) {
    return "{ 'Content-Type': 'application/json' }";
  }

  return "";
}

function getResponseExpression(route: GeneratedClientRoute): string {
  if (!route.outputSchema) {
    return "readOptionalJsonResponse(response, request.telemetry)";
  }

  return `handleJsonResponse<${getOutputTypeName(route)}>(response, request.telemetry)`;
}

function getResultResponseExpression(route: GeneratedClientRoute): string {
  const problemDeclarations = getProblemDeclarationsName(route);
  const problemType = getProblemTypeName(route);

  if (!route.outputSchema) {
    return `readOptionalJsonResult<${problemType}>(response, ${problemDeclarations}, request.telemetry)`;
  }

  return `handleJsonResult<${getOutputTypeName(route)}, ${problemType}>(response, ${problemDeclarations}, request.telemetry)`;
}

function getReturnType(route: GeneratedClientRoute): string {
  if (!route.outputSchema) {
    return "Promise<unknown | undefined>";
  }

  return `Promise<${getOutputTypeName(route)}>`;
}

function getResultReturnType(route: GeneratedClientRoute): string {
  return `Promise<${getResultTypeName(route)}>`;
}

function getSuccessType(route: GeneratedClientRoute): string {
  if (!route.outputSchema) {
    return "unknown | undefined";
  }

  return getOutputTypeName(route);
}

function generateReactQueryImports(domainRoutes: DomainRoutes): string {
  const hasQueryRoutes = domainRoutes.routes.some(isReactQueryQueryRoute);
  const hasMutationRoutes = domainRoutes.routes.some((route) => !isReactQueryQueryRoute(route));
  const valueImports = [
    ...(hasMutationRoutes ? ["useMutation"] : []),
    ...(hasQueryRoutes ? ["useQuery"] : []),
  ];
  const typeImports = [
    ...(hasMutationRoutes ? ["UseMutationOptions"] : []),
    ...(hasQueryRoutes ? ["UseQueryOptions"] : []),
  ];
  const imports = [
    ...(valueImports.length > 0
      ? [`import { ${valueImports.join(", ")} } from '@tanstack/react-query';`]
      : []),
    ...(typeImports.length > 0
      ? [`import type { ${typeImports.join(", ")} } from '@tanstack/react-query';`]
      : []),
  ];

  return `${imports.join("\n")}\n`;
}

function generateReactQueryHooks(domainRoutes: DomainRoutes, clientName: string): string {
  const queries = domainRoutes.routes.filter(isReactQueryQueryRoute);
  const mutations = domainRoutes.routes.filter((route) => !isReactQueryQueryRoute(route));
  const typeArtifacts = domainRoutes.routes.map(generateReactQueryTypeArtifacts).join("\n");
  const queryFactories = generateReactQueryFactories(domainRoutes.domain, queries, clientName);
  const mutationFactories = generateReactMutationFactories(
    domainRoutes.domain,
    mutations,
    clientName,
  );
  const hooks = domainRoutes.routes.map((route) => generateReactQueryHook(route)).join("\n");

  return [typeArtifacts, queryFactories, mutationFactories, hooks]
    .filter((artifact) => artifact.length > 0)
    .join("\n");
}

function generateReactQueryTypeArtifacts(route: GeneratedClientRoute): string {
  if (isReactQueryQueryRoute(route)) {
    return `export type ${getQueryKeyTypeName(route)} = ${getReactQueryKeyType(route, false)};
export type ${getResultQueryKeyTypeName(route)} = ${getReactQueryKeyType(route, true)};
export type ${getQueryFactoryTypeName(route)} = {
  readonly queryKey: ${getQueryKeyTypeName(route)};
  readonly queryFn: () => Promise<${getSuccessType(route)}>;
};
export type ${getResultQueryFactoryTypeName(route)} = {
  readonly queryKey: ${getResultQueryKeyTypeName(route)};
  readonly queryFn: () => Promise<${getResultTypeName(route)}>;
};
export type ${getQueryOptionsTypeName(route)}<TData = ${getSuccessType(route)}> = Omit<UseQueryOptions<${getSuccessType(route)}, Error, TData, ${getQueryKeyTypeName(route)}>, 'queryKey' | 'queryFn'>${getReactQueryCacheScopeOptionsType(route)} & { readonly rpc?: RpcClientRequestOptions };
export type ${getResultQueryOptionsTypeName(route)}<TData = ${getResultTypeName(route)}> = Omit<UseQueryOptions<${getResultTypeName(route)}, Error, TData, ${getResultQueryKeyTypeName(route)}>, 'queryKey' | 'queryFn'>${getReactQueryCacheScopeOptionsType(route)} & { readonly rpc?: RpcClientRequestOptions };`;
  }

  return `export type ${getMutationVariablesTypeName(route)} = ${getMutationVariablesType(route)};
export type ${getMutationFactoryTypeName(route)} = {
  readonly mutationFn: ${getMutationFnType(route, getSuccessType(route))};
};
export type ${getResultMutationFactoryTypeName(route)} = {
  readonly mutationFn: ${getMutationFnType(route, getResultTypeName(route))};
};
export type ${getMutationOptionsTypeName(route)}<TContext = unknown> = Omit<UseMutationOptions<${getSuccessType(route)}, Error, ${getMutationVariablesTypeName(route)}, TContext>, 'mutationFn'> & { readonly rpc?: RpcClientRequestOptions };
export type ${getResultMutationOptionsTypeName(route)}<TContext = unknown> = Omit<UseMutationOptions<${getResultTypeName(route)}, Error, ${getMutationVariablesTypeName(route)}, TContext>, 'mutationFn'> & { readonly rpc?: RpcClientRequestOptions };`;
}

function generateReactQueryFactories(
  domain: string,
  routes: readonly GeneratedClientRoute[],
  clientName: string,
): string {
  if (routes.length === 0) {
    return "";
  }

  const entries = routes.map((route) => generateReactQueryFactoryEntry(domain, route, "client"));
  const clientTypeName = `${toPascalCase(domain)}Client`;
  const factoryName = `create${toPascalCase(domain)}Queries`;

  return `export function ${factoryName}(client: ${clientTypeName} = ${clientName}) {
  return {
${entries.join("\n")}
  };
}

export const ${domain}Queries = ${factoryName}();`;
}

function generateReactQueryFactoryEntry(
  domain: string,
  route: GeneratedClientRoute,
  clientName: string,
): string {
  const input = `${getReactQueryFactoryParameters(route)}${needsInput(route) ? ", " : ""}rpc?: RpcClientRequestOptions`;
  const queryKey = getReactQueryKeyExpression(domain, route, false);
  const resultQueryKey = getReactQueryKeyExpression(domain, route, true);

  return `  ${route.methodName}: (${input}): ${getQueryFactoryTypeName(route)} => ({
    queryKey: ${queryKey},
    queryFn: () => ${getClientCallExpression(clientName, route, route.methodName, "rpc")},
  }),
  ${getResultMethodName(route)}: (${input}): ${getResultQueryFactoryTypeName(route)} => ({
    queryKey: ${resultQueryKey},
    queryFn: () => ${getClientCallExpression(clientName, route, getResultMethodName(route), "rpc")},
  }),`;
}

function generateReactMutationFactories(
  domain: string,
  routes: readonly GeneratedClientRoute[],
  clientName: string,
): string {
  if (routes.length === 0) {
    return "";
  }

  const entries = routes.map((route) => generateReactMutationFactoryEntry(route, "client"));
  const clientTypeName = `${toPascalCase(domain)}Client`;
  const factoryName = `create${toPascalCase(domain)}Mutations`;

  return `export function ${factoryName}(client: ${clientTypeName} = ${clientName}) {
  return {
${entries.join("\n")}
  };
}

export const ${domain}Mutations = ${factoryName}();`;
}

function generateReactMutationFactoryEntry(
  route: GeneratedClientRoute,
  clientName: string,
): string {
  const input = getMutationFnParameter(route);

  return `  ${route.methodName}: (rpc?: RpcClientRequestOptions): ${getMutationFactoryTypeName(route)} => ({
    mutationFn: (${input}) => ${getClientCallExpression(clientName, route, route.methodName, "rpc")},
  }),
  ${getResultMethodName(route)}: (rpc?: RpcClientRequestOptions): ${getResultMutationFactoryTypeName(route)} => ({
    mutationFn: (${input}) => ${getClientCallExpression(clientName, route, getResultMethodName(route), "rpc")},
  }),`;
}

function generateReactQueryHook(route: GeneratedClientRoute): string {
  const hookName = `use${toPascalCase(route.methodName)}`;
  const resultHookName = `use${toPascalCase(getResultMethodName(route))}`;

  if (!isReactQueryQueryRoute(route)) {
    return `export function ${hookName}<TContext = unknown>(options?: ${getMutationOptionsTypeName(route)}<TContext>) {
  const { rpc, ...mutationOptions } = options ?? {};

  return useMutation<${getSuccessType(route)}, Error, ${getMutationVariablesTypeName(route)}, TContext>({ ...${getDomainName(route)}Mutations.${route.methodName}(rpc), ...mutationOptions });
}

export function ${resultHookName}<TContext = unknown>(options?: ${getResultMutationOptionsTypeName(route)}<TContext>) {
  const { rpc, ...mutationOptions } = options ?? {};

  return useMutation<${getResultTypeName(route)}, Error, ${getMutationVariablesTypeName(route)}, TContext>({ ...${getDomainName(route)}Mutations.${getResultMethodName(route)}(rpc), ...mutationOptions });
}`;
  }

  const input = getInputParameter(route);
  const callInput = needsInput(route) ? "input" : "";
  const factoryCallArguments = getReactQueryFactoryCallArguments(route);

  if (hasReactQueryCacheScope(route)) {
    return `export function ${hookName}<TData = ${getSuccessType(route)}>(${input}, options?: ${getQueryOptionsTypeName(route)}<TData>) {
  const { cacheScope, rpc, ...queryOptions } = options ?? {};

  return useQuery<${getSuccessType(route)}, Error, TData, ${getQueryKeyTypeName(route)}>({ ...${getDomainName(route)}Queries.${route.methodName}(${factoryCallArguments}${factoryCallArguments.length > 0 ? ", " : ""}rpc), ...queryOptions });
}

export function ${resultHookName}<TData = ${getResultTypeName(route)}>(${input}, options?: ${getResultQueryOptionsTypeName(route)}<TData>) {
  const { cacheScope, rpc, ...queryOptions } = options ?? {};

  return useQuery<${getResultTypeName(route)}, Error, TData, ${getResultQueryKeyTypeName(route)}>({ ...${getDomainName(route)}Queries.${getResultMethodName(route)}(${factoryCallArguments}${factoryCallArguments.length > 0 ? ", " : ""}rpc), ...queryOptions });
}`;
  }

  return `export function ${hookName}<TData = ${getSuccessType(route)}>(${input}${needsInput(route) ? ", " : ""}options?: ${getQueryOptionsTypeName(route)}<TData>) {
  const { rpc, ...queryOptions } = options ?? {};

  return useQuery<${getSuccessType(route)}, Error, TData, ${getQueryKeyTypeName(route)}>({ ...${getDomainName(route)}Queries.${route.methodName}(${callInput}${callInput.length > 0 ? ", " : ""}rpc), ...queryOptions });
}

export function ${resultHookName}<TData = ${getResultTypeName(route)}>(${input}${needsInput(route) ? ", " : ""}options?: ${getResultQueryOptionsTypeName(route)}<TData>) {
  const { rpc, ...queryOptions } = options ?? {};

  return useQuery<${getResultTypeName(route)}, Error, TData, ${getResultQueryKeyTypeName(route)}>({ ...${getDomainName(route)}Queries.${getResultMethodName(route)}(${callInput}${callInput.length > 0 ? ", " : ""}rpc), ...queryOptions });
}`;
}

function isReactQueryQueryRoute(route: GeneratedClientRoute): boolean {
  return route.httpMethod.toUpperCase() === "GET";
}

function getInputParameter(route: GeneratedClientRoute): string {
  if (!needsInput(route)) {
    return "";
  }

  return `input${hasRequiredInput(route) ? "" : "?"}: ${getInputTypeName(route)}`;
}

function getMutationFnParameter(route: GeneratedClientRoute): string {
  if (!needsInput(route)) {
    return "";
  }

  return `input${hasRequiredInput(route) ? "" : "?"}: ${getInputTypeName(route)}`;
}

function getMutationFnType(route: GeneratedClientRoute, returnType: string): string {
  if (!needsInput(route)) {
    return `() => Promise<${returnType}>`;
  }

  return `(input${hasRequiredInput(route) ? "" : "?"}: ${getInputTypeName(route)}) => Promise<${returnType}>`;
}

function getClientCallExpression(
  clientName: string,
  route: GeneratedClientRoute,
  methodName: string,
  optionsExpression: string,
): string {
  if (!needsInput(route)) {
    return `${clientName}.${methodName}(${optionsExpression})`;
  }

  return `${clientName}.${methodName}(input, ${optionsExpression})`;
}

function getMutationVariablesType(route: GeneratedClientRoute): string {
  if (!needsInput(route)) {
    return "void";
  }

  return hasRequiredInput(route)
    ? getInputTypeName(route)
    : `${getInputTypeName(route)} | undefined`;
}

function getReactQueryFactoryParameters(route: GeneratedClientRoute): string {
  const parameters = [
    ...(needsInput(route) ? [getInputParameter(route)] : []),
    ...(hasReactQueryCacheScope(route) ? ["cacheScope?: unknown"] : []),
  ];

  return parameters.join(", ");
}

function getReactQueryFactoryCallArguments(route: GeneratedClientRoute): string {
  const parameters = [
    ...(needsInput(route) ? ["input"] : []),
    ...(hasReactQueryCacheScope(route) ? ["cacheScope"] : []),
  ];

  return parameters.join(", ");
}

function getReactQueryCacheScopeOptionsType(route: GeneratedClientRoute): string {
  return hasReactQueryCacheScope(route) ? " & { readonly cacheScope?: unknown }" : "";
}

function hasReactQueryCacheScope(route: GeneratedClientRoute): boolean {
  return isReactQueryQueryRoute(route) && hasReactQueryUnsafeKeyInput(route);
}

function hasReactQueryUnsafeKeyInput(route: GeneratedClientRoute): boolean {
  return Boolean(route.inputSchemas.body || route.inputSchemas.headers);
}

function getReactQueryCacheSafeInputFieldNames(route: GeneratedClientRoute): readonly string[] {
  return [
    ...(route.inputSchemas.path ? ["path"] : []),
    ...(route.inputSchemas.query ? ["query"] : []),
  ];
}

function getQueryKeyFactoryParameters(route: GeneratedClientRoute): string {
  const parameters = [
    ...(hasQueryKeyFactoryInput(route) ? [getInputParameter(route)] : []),
    ...(hasReactQueryCacheScope(route) ? ["cacheScope?: unknown"] : []),
  ];

  return parameters.join(", ");
}

function getQueryKeyFactoryCallArguments(route: GeneratedClientRoute): string {
  const parameters = [
    ...(hasQueryKeyFactoryInput(route) ? ["input"] : []),
    ...(hasReactQueryCacheScope(route) ? ["cacheScope"] : []),
  ];

  return parameters.join(", ");
}

function hasQueryKeyFactoryInput(route: GeneratedClientRoute): boolean {
  return getQueryKeyInputExpression(route) !== null;
}

function getQueryKeyInputExpression(route: GeneratedClientRoute): string | null {
  if (!isReactQueryQueryRoute(route) || !hasReactQueryUnsafeKeyInput(route)) {
    return needsInput(route) ? "input" : null;
  }

  const fieldNames = getReactQueryCacheSafeInputFieldNames(route);

  if (fieldNames.length === 0) {
    return null;
  }

  return `{ ${fieldNames.map((fieldName) => `${fieldName}: input.${fieldName}`).join(", ")} }`;
}

function getReactQueryKeyType(route: GeneratedClientRoute, result: boolean): string {
  const keyType = `ReturnType<typeof ${getDomainName(route)}Keys${getQueryKeyFactoryAccessor(route)}>`;

  return result ? `readonly [...${keyType}, 'result']` : keyType;
}

function getReactQueryKeyExpression(
  domain: string,
  route: GeneratedClientRoute,
  result: boolean,
): string {
  const keyExpression = `${domain}Keys${getQueryKeyFactoryAccessor(route)}(${getQueryKeyFactoryCallArguments(route)})`;

  return result ? `[...${keyExpression}, 'result'] as const` : keyExpression;
}

function zodTypeToTypeScript(schema: unknown): string {
  return zodTypeToTypeScriptWithOptions(schema);
}

function zodInputTypeToTypeScript(name: string, schema: unknown): string {
  if (name === "headers") {
    return zodTypeToTypeScriptWithOptions(schema, {
      readonlyArrays: true,
      lifecycle: "input",
    });
  }

  return zodTypeToTypeScriptWithOptions(schema, { lifecycle: "input" });
}

function zodTypeToTypeScriptWithOptions(
  schema: unknown,
  options: TypeScriptTypeOptions = {},
): string {
  const descriptor = describeZodSchema(schema as never);

  if (!descriptor) {
    throw new RpcCodegenContractProblem(
      "Cannot generate RPC client type for missing schema. Use a JSON-safe Zod schema supported by @croco/protocols-core or remove the schema from generated contracts.",
    );
  }

  const unsafeDiagnostic = getSchemaDescriptorDiagnostics(descriptor).find(
    (diagnostic) => diagnostic.severity === "error",
  );

  if (unsafeDiagnostic) {
    throw new RpcCodegenContractProblem(formatSchemaDiagnostic(unsafeDiagnostic));
  }

  return schemaDescriptorToTypeScript(descriptor, options);
}

type TypeScriptTypeOptions = {
  readonly readonlyArrays?: boolean;
  readonly lifecycle?: "input" | "output";
};

function schemaDescriptorToTypeScript(
  descriptor: ContractSchemaDescriptor,
  options: TypeScriptTypeOptions = {},
): string {
  if (descriptor.kind === "string") {
    return "string";
  }

  if (descriptor.kind === "number") {
    return "number";
  }

  if (descriptor.kind === "boolean") {
    return "boolean";
  }

  if (descriptor.kind === "unknown" || descriptor.kind === "any") {
    return "unknown";
  }

  if (descriptor.kind === "never") {
    return "never";
  }

  if (descriptor.kind === "null") {
    return "null";
  }

  if (descriptor.kind === "undefined" || descriptor.kind === "void") {
    return "undefined";
  }

  if (descriptor.kind === "literal") {
    return literalValueToTypeScript(descriptor.value);
  }

  if (descriptor.kind === "enum") {
    return unionTypes((descriptor.values ?? []).map(literalValueToTypeScript));
  }

  if (descriptor.kind === "union") {
    return unionTypes(
      (descriptor.options ?? []).map((option) => schemaDescriptorToTypeScript(option, options)),
    );
  }

  if (descriptor.kind === "optional") {
    return `${schemaDescriptorToTypeScript(getRequiredChildDescriptor(descriptor, "inner"), options)} | undefined`;
  }

  if (descriptor.kind === "nullable") {
    return `${schemaDescriptorToTypeScript(getRequiredChildDescriptor(descriptor, "inner"), options)} | null`;
  }

  if (descriptor.kind === "default") {
    const inner = schemaDescriptorToTypeScript(
      getRequiredChildDescriptor(descriptor, "inner"),
      options,
    );

    return options.lifecycle === "input"
      ? includeUndefinedType(inner)
      : excludeUndefinedType(inner);
  }

  if (descriptor.kind === "catch") {
    return options.lifecycle === "input"
      ? "unknown"
      : schemaDescriptorToTypeScript(getRequiredChildDescriptor(descriptor, "inner"), options);
  }

  if (
    descriptor.kind === "effects" ||
    descriptor.kind === "branded" ||
    descriptor.kind === "readonly"
  ) {
    return schemaDescriptorToTypeScript(getRequiredChildDescriptor(descriptor, "inner"), options);
  }

  if (descriptor.kind === "array") {
    const element = getArrayElementTypeScript(
      schemaDescriptorToTypeScript(getRequiredChildDescriptor(descriptor, "element"), options),
    );

    return options.readonlyArrays ? `readonly ${element}[]` : `${element}[]`;
  }

  if (descriptor.kind === "record") {
    return `Record<string, ${descriptor.element ? schemaDescriptorToTypeScript(descriptor.element, options) : "unknown"}>`;
  }

  if (descriptor.kind === "object") {
    return getObjectTypeScript(descriptor, options);
  }

  throw new RpcCodegenContractProblem(
    `Cannot generate RPC client type for unsupported schema ${descriptor.typeName}. Use a JSON-safe Zod schema supported by @croco/protocols-core or remove the schema from generated contracts.`,
  );
}

function getArrayElementTypeScript(type: string): string {
  return type.includes(" | ") ? `(${type})` : type;
}

function getRequiredChildDescriptor(
  descriptor: ContractSchemaDescriptor,
  key: "element" | "inner",
): ContractSchemaDescriptor {
  const child = descriptor[key];

  if (!child) {
    throw new RpcCodegenContractProblem(
      `Cannot generate RPC client type for malformed schema ${descriptor.typeName}: missing ${key} schema descriptor.`,
    );
  }

  return child;
}

function getSchemaName(schema: unknown): string {
  return getZodSchemaTypeName(schema);
}

function unionTypes(types: readonly string[]): string {
  const uniqueTypes = [...new Set(types)];

  return uniqueTypes.length === 0 ? "never" : uniqueTypes.join(" | ");
}

function includeUndefinedType(type: string): string {
  return type.split(" | ").includes("undefined") ? type : `${type} | undefined`;
}

function excludeUndefinedType(type: string): string {
  return unionTypes(type.split(" | ").filter((member) => member !== "undefined"));
}

function escapeTypeScriptString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function literalValueToTypeScript(value: unknown): string {
  if (typeof value === "string") {
    return `'${escapeTypeScriptString(value)}'`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  throw new RpcCodegenContractProblem(
    `Cannot generate RPC client type for unsupported literal value ${String(value)}.`,
  );
}

function getObjectTypeScript(
  descriptor: ContractSchemaDescriptor,
  options: TypeScriptTypeOptions = {},
): string {
  const fields = (descriptor.fields ?? []).map(
    (field) =>
      `${formatObjectKey(field.name)}${isOptionalObjectField(field, options.lifecycle ?? "output") ? "?" : ""}: ${schemaDescriptorToTypeScript(field.schema, options)};`,
  );

  return `{ ${fields.join(" ")} }`;
}

function isOptionalObjectField(
  field: NonNullable<ContractSchemaDescriptor["fields"]>[number],
  lifecycle: "input" | "output",
): boolean {
  return lifecycle === "input"
    ? !field.required || schemaAllowsUndefined(field.schema, lifecycle)
    : schemaAllowsUndefined(field.schema, lifecycle);
}

function schemaAllowsUndefined(
  descriptor: ContractSchemaDescriptor,
  lifecycle: "input" | "output",
): boolean {
  if (
    descriptor.kind === "undefined" ||
    descriptor.kind === "void" ||
    descriptor.kind === "optional" ||
    descriptor.kind === "unknown" ||
    descriptor.kind === "any"
  ) {
    return true;
  }

  if (lifecycle === "input" && (descriptor.kind === "default" || descriptor.kind === "catch")) {
    return true;
  }

  if (descriptor.kind === "union") {
    return (descriptor.options ?? []).some((option) => schemaAllowsUndefined(option, lifecycle));
  }

  if (
    descriptor.kind === "effects" ||
    descriptor.kind === "branded" ||
    descriptor.kind === "nullable" ||
    descriptor.kind === "readonly" ||
    (lifecycle === "output" && descriptor.kind === "catch")
  ) {
    return descriptor.inner ? schemaAllowsUndefined(descriptor.inner, lifecycle) : false;
  }

  return false;
}

function getObjectFieldNames(schema: unknown): string[] {
  const descriptor = describeZodSchema(schema as never);

  return descriptor?.kind === "object" ? (descriptor.fields ?? []).map((field) => field.name) : [];
}

function formatObjectKey(key: string): string {
  if (isJavaScriptIdentifier(key)) {
    return key;
  }

  return `'${escapeTypeScriptString(key)}'`;
}

function isJavaScriptIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function getPathExpression(route: GeneratedClientRoute): string {
  const pathParams = getContractPathParams(route.path);

  if (pathParams.length === 0) {
    return literalValueToTypeScript(route.path);
  }

  const paramsByToken = new Map(pathParams.map((param) => [param.token, param.name]));
  const pathExpression = route.path
    .split(/(:[^/]+)/g)
    .map((part) => {
      if (part.startsWith(":")) {
        const name = paramsByToken.get(part.slice(1));

        if (name) {
          return `\${encodeURIComponent(String(${getPathInputAccessor(name)}))}`;
        }
      }

      return escapeTypeScriptString(part);
    })
    .join("");

  return `\`${pathExpression}\``;
}

function getPathInputAccessor(name: string): string {
  return isJavaScriptIdentifier(name)
    ? `input.path.${name}`
    : `input.path[${formatObjectKey(name)}]`;
}

function getQueryStatements(route: GeneratedClientRoute): string {
  if (!route.inputSchemas.query) {
    return "";
  }

  return `    const query = serializeQueryParams(input.query);
    const url = query ? \`${"${path}"}?${"${query}"}\` : path;
`;
}

function getUrlExpression(route: GeneratedClientRoute): string {
  return route.inputSchemas.query ? "url" : "path";
}

function getInputSchemaEntries(route: GeneratedClientRoute): [string, unknown][] {
  const entries: [string, unknown | null][] = [
    ["body", route.inputSchemas.body],
    ["path", route.inputSchemas.path],
    ["query", route.inputSchemas.query],
    ["headers", route.inputSchemas.headers],
  ];

  return entries.filter(
    (entry): entry is [string, unknown] => entry[1] !== null && entry[1] !== undefined,
  );
}

function needsInput(route: GeneratedClientRoute): boolean {
  return getInputSchemaEntries(route).length > 0;
}

function hasRequiredInput(route: GeneratedClientRoute): boolean {
  return needsInput(route);
}

function hasBody(route: GeneratedClientRoute): boolean {
  return route.inputSchemas.body !== null && route.inputSchemas.body !== undefined;
}

function hasStructuredInput(route: GeneratedClientRoute): boolean {
  return Boolean(route.inputSchemas.path || route.inputSchemas.query || route.inputSchemas.headers);
}

function hasLegacyBodyInput(route: GeneratedClientRoute): boolean {
  return Boolean(
    route.inputSchemas.body &&
    !route.inputSchemas.path &&
    !route.inputSchemas.query &&
    !route.inputSchemas.headers,
  );
}

function isMutationRoute(route: GeneratedClientRoute): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(route.httpMethod.toUpperCase());
}

function getDomainName(route: GeneratedClientRoute): string {
  const rawName = route.domain ?? route.controllerName.replace(/Controller$/, "");

  return toCamelCase(rawName);
}

function getInputTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}Input`;
}

function getFormFieldNameTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}FormFieldName`;
}

function getFormValuesTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}FormValues`;
}

function getSubmitPayloadTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}SubmitPayload`;
}

function getValidationProblemTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}ValidationProblem`;
}

function getDomainProblemTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}DomainProblem`;
}

function getFormProblemTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}FormProblem`;
}

function getFormModelName(route: GeneratedClientRoute): string {
  return `${route.methodName}FormModel`;
}

function getBuildFormPayloadName(route: GeneratedClientRoute): string {
  return `build${toPascalCase(route.methodName)}FormPayload`;
}

function getMapFormProblemName(route: GeneratedClientRoute): string {
  return `map${toPascalCase(route.methodName)}FormProblem`;
}

function getOutputTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}Output`;
}

function getProblemTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}Problem`;
}

function getProblemDetailsTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}ProblemDetails`;
}

function getResultTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}Result`;
}

function getQueryKeyTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}QueryKey`;
}

function getResultQueryKeyTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}ResultQueryKey`;
}

function getQueryFactoryTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}QueryFactory`;
}

function getResultQueryFactoryTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}ResultQueryFactory`;
}

function getQueryOptionsTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}QueryOptions`;
}

function getResultQueryOptionsTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}ResultQueryOptions`;
}

function getMutationVariablesTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}MutationVariables`;
}

function getMutationFactoryTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}MutationFactory`;
}

function getResultMutationFactoryTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}ResultMutationFactory`;
}

function getMutationOptionsTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}MutationOptions`;
}

function getResultMutationOptionsTypeName(route: GeneratedClientRoute): string {
  return `${toPascalCase(route.methodName)}ResultMutationOptions`;
}

function getProblemDeclarationsName(route: GeneratedClientRoute): string {
  return `${route.methodName}ProblemDeclarations`;
}

function getResultMethodName(route: GeneratedClientRoute): string {
  return `${route.methodName}Result`;
}

function getQueryKeysName(domainRoutes: DomainRoutes): string {
  return `${domainRoutes.domain}Keys`;
}

function getQueryKeyFactoryProperty(route: GeneratedClientRoute): string {
  const name = route.methodName === "all" ? "allRoute" : route.methodName;

  return isJavaScriptIdentifier(name) ? name : formatObjectKey(name);
}

function getQueryKeyFactoryAccessor(route: GeneratedClientRoute): string {
  const name = route.methodName === "all" ? "allRoute" : route.methodName;

  return isJavaScriptIdentifier(name) ? `.${name}` : `[${formatObjectKey(name)}]`;
}

function formatRoute(route: GeneratedClientRoute): string {
  return `${route.controllerName}.${route.methodName} (${route.path})`;
}

function getRouteId(route: GeneratedClientRoute): string {
  return route.routeId ?? `${route.controllerName}.${route.methodName}`;
}

function getOperationId(route: GeneratedClientRoute): string {
  return route.operationId ?? getRouteId(route).replace(/[^A-Za-z0-9_]+/g, "_");
}

function assertNoZodImport(content: string): void {
  if (
    content.includes("from 'zod'") ||
    content.includes("import { z }") ||
    content.includes("zod")
  ) {
    throw new RpcCodegenContractProblem("Generated client must not import zod.");
  }
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);

  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

function toPascalCase(value: string): string {
  return value
    .replace(/Controller$/, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

export function checkClientFilesFromContractGraph(
  graph: ContractGraph,
  outDir: string,
  options: GenerateClientOptions = {},
): readonly GeneratedClientDrift[] {
  assertContractGraphHasNoErrors(graph);

  const files = emitClientFiles([...graph.routes], outDir, options);
  const generatedContents = new Map(files.map((file) => [file.filePath, file.content]));

  assertContractGraphConsumerRouteCoverage(
    graph,
    "rpc-client",
    collectGeneratedRpcConsumerRoutes([...generatedContents.keys()], generatedContents),
  );

  return compareClientFiles(files, outDir);
}

export function checkGeneratedClientFiles(
  routes: GeneratedClientRoute[],
  outDir: string,
  options: GenerateClientOptions = {},
): readonly GeneratedClientDrift[] {
  return compareClientFiles(emitClientFiles(routes, outDir, options), outDir);
}

function compareClientFiles(
  expectedFiles: readonly GeneratedClientFile[],
  outDir: string,
): readonly GeneratedClientDrift[] {
  const expectedPaths = new Set(expectedFiles.map((file) => path.resolve(file.filePath)));
  const ownership = readGeneratedClientOwnershipManifest(outDir);
  const drifts: GeneratedClientDrift[] = [];

  for (const file of expectedFiles) {
    if (!fs.existsSync(file.filePath)) {
      drifts.push({ filePath: file.filePath, status: "missing" });
      continue;
    }

    const actual = normalizeGeneratedContent(fs.readFileSync(file.filePath, "utf8"));
    const expected = normalizeGeneratedContent(file.content);

    if (actual !== expected) {
      drifts.push({ filePath: file.filePath, status: "changed" });
    }
  }

  for (const ownedPath of ownership.files) {
    const filePath = resolveOwnedOutputPath(outDir, ownedPath);

    if (fs.existsSync(filePath) && !expectedPaths.has(path.resolve(filePath))) {
      drifts.push({ filePath, status: "unexpected" });
    }
  }

  return drifts.sort((left, right) =>
    left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0,
  );
}

function collectOwnedOutputPaths(
  files: readonly GeneratedClientFile[],
  outDir: string,
): ReadonlySet<string> {
  const outputRoot = path.resolve(outDir);
  const portablePaths = new Map<string, string>();
  const ownedPaths: string[] = [];

  for (const file of files) {
    const ownedPath = getOwnedOutputPath(file.filePath, outputRoot);

    if (!ownedPath) {
      continue;
    }

    if (ownedPath.toLowerCase() === GENERATED_CLIENT_OWNERSHIP_MANIFEST_NAME) {
      throw new RpcCodegenContractProblem(
        `Generated output path '${file.filePath}' conflicts with the reserved ownership manifest. Choose a different frontend action manifest path.`,
      );
    }

    const portablePath = ownedPath.toLowerCase();
    const existingPath = portablePaths.get(portablePath);

    if (existingPath && existingPath !== ownedPath) {
      throw new RpcCodegenContractProblem(
        `Generated output paths '${existingPath}' and '${ownedPath}' differ only by case and cannot be emitted portably. Rename one route domain.`,
      );
    }

    portablePaths.set(portablePath, ownedPath);
    ownedPaths.push(ownedPath);
  }

  return new Set(ownedPaths.sort());
}

function readGeneratedClientOwnershipManifest(outDir: string): GeneratedClientOwnership {
  const manifestPath = getGeneratedClientOwnershipManifestPath(outDir);
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });

  if (!manifestStat) {
    return { files: collectLegacyGeneratedClientPaths(outDir), directories: [] };
  }

  if (manifestStat.isSymbolicLink()) {
    throw new RpcCodegenContractProblem(
      `Generated output ownership manifest '${manifestPath}' must not be a symbolic link. Replace it with a regular file before regenerating the RPC client.`,
    );
  }

  let manifest: unknown;

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new RpcCodegenContractProblem(
      `Cannot read generated output ownership manifest '${manifestPath}'. Remove the invalid manifest and regenerate the RPC client.`,
    );
  }

  if (!isGeneratedClientOwnershipManifest(manifest)) {
    throw new RpcCodegenContractProblem(
      `Generated output ownership manifest '${manifestPath}' is invalid. Remove the invalid manifest and regenerate the RPC client.`,
    );
  }

  return {
    files: collectValidatedOwnedManifestEntries(manifest.files, "path", manifestPath),
    directories: collectValidatedOwnedManifestEntries(
      manifest.directories,
      "directory",
      manifestPath,
    ),
  };
}

function collectValidatedOwnedManifestEntries(
  entries: readonly string[],
  entryKind: "path" | "directory",
  manifestPath: string,
): readonly string[] {
  const uniqueEntries = new Set<string>();

  for (const entry of entries) {
    assertSafeOwnedOutputPath(entry, manifestPath);

    if (uniqueEntries.has(entry)) {
      throw new RpcCodegenContractProblem(
        `Generated output ownership manifest '${manifestPath}' contains duplicate ${entryKind} '${entry}'. Remove the invalid manifest and regenerate the RPC client.`,
      );
    }

    uniqueEntries.add(entry);
  }

  return [...uniqueEntries].sort();
}

function assertNoUnownedOutputCollisions(
  files: readonly GeneratedClientFile[],
  outDir: string,
  previousOwnedPaths: readonly string[],
): void {
  for (const file of files) {
    const ownedPath = getOwnedOutputPath(file.filePath, outDir);

    if (!ownedPath) {
      continue;
    }

    assertOwnedFilePathDoesNotTraverseSymlink(outDir, ownedPath);

    const existingStat = fs.lstatSync(file.filePath, { throwIfNoEntry: false });

    if (
      !existingStat ||
      isPreviouslyOwnedFile(file.filePath, ownedPath, outDir, previousOwnedPaths)
    ) {
      continue;
    }

    const actual = normalizeGeneratedContent(fs.readFileSync(file.filePath, "utf8"));
    const expected = normalizeGeneratedContent(file.content);

    if (actual === expected) {
      continue;
    }

    throw new RpcCodegenContractProblem(
      `Generated output path '${file.filePath}' already contains an unrelated file. Move that file or choose a different RPC client output directory before regenerating.`,
    );
  }
}

function isPreviouslyOwnedFile(
  filePath: string,
  ownedPath: string,
  outDir: string,
  previousOwnedPaths: readonly string[],
): boolean {
  if (previousOwnedPaths.includes(ownedPath)) {
    return true;
  }

  const currentStat = fs.statSync(filePath);

  return previousOwnedPaths.some((previousOwnedPath) => {
    const previousPath = resolveOwnedOutputPath(outDir, previousOwnedPath);
    const previousStat = fs.statSync(previousPath, { throwIfNoEntry: false });

    return previousStat?.dev === currentStat.dev && previousStat.ino === currentStat.ino;
  });
}

function getOwnedOutputPath(filePath: string, outDir: string): string | null {
  const relativePath = path.relative(path.resolve(outDir), path.resolve(filePath));

  if (
    relativePath === "" ||
    path.isAbsolute(relativePath) ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return null;
  }

  return relativePath.split(path.sep).join("/");
}

function collectLegacyGeneratedClientPaths(outDir: string): readonly string[] {
  const rpcPath = path.join(outDir, "rpc.ts");
  const indexPath = path.join(outDir, "index.ts");
  const rpcContent = readLegacyGeneratedCandidate(rpcPath);
  const indexContent = readLegacyGeneratedCandidate(indexPath);

  if (!rpcContent && !indexContent) {
    return [];
  }

  if (!rpcContent || !indexContent || !isLegacyRpcSupport(rpcContent)) {
    throw new RpcCodegenContractProblem(
      `Cannot recover generated output ownership in '${outDir}' because the legacy rpc.ts and index.ts topology is incomplete. Restore both generated files or remove the legacy generated outputs before regenerating.`,
    );
  }

  const exportedModules = parseLegacyGeneratedIndex(indexContent);

  if (!exportedModules) {
    throw new RpcCodegenContractProblem(
      `Cannot recover generated output ownership in '${outDir}' because the legacy index.ts is not a complete generated RPC client barrel. Restore the generated index or remove the legacy generated outputs before regenerating.`,
    );
  }

  const ownedPaths = new Set(["index.ts", "rpc.ts"]);

  for (const moduleName of exportedModules) {
    const fileName = `${moduleName}.ts`;
    const content = readLegacyGeneratedCandidate(path.join(outDir, fileName));

    if (!content || !isLegacyGeneratedModule(fileName, content)) {
      throw new RpcCodegenContractProblem(
        `Cannot recover generated output ownership in '${outDir}' because index.ts references incomplete generated module '${fileName}'. Restore that generated file or remove the legacy generated outputs before regenerating.`,
      );
    }

    ownedPaths.add(fileName);
  }

  return [...ownedPaths].sort();
}

function readLegacyGeneratedCandidate(filePath: string): string | null {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });

  if (!stats?.isFile() || stats.size > MAX_LEGACY_GENERATED_FILE_BYTES) {
    return null;
  }

  return fs.readFileSync(filePath, "utf8");
}

function isLegacyRpcSupport(content: string): boolean {
  return (
    content.includes("export type RpcClientRequestOptions =") &&
    content.includes("export function createRpcClientRequest(") &&
    hasLegacyRpcProblemRuntime(content)
  );
}

function hasLegacyRpcProblemRuntime(content: string): boolean {
  const hasInlineProblemRuntime = content.includes(
    "export class RpcClientProblemError extends Error",
  );
  const hasFrontendProblemRuntime =
    content.includes("ProblemClientError as RpcClientProblemError,") &&
    content.includes("from '@croco/frontend-problems';");

  return hasInlineProblemRuntime || hasFrontendProblemRuntime;
}

function parseLegacyGeneratedIndex(content: string): readonly string[] | null {
  const lines = content.split("\n").filter((line) => line.length > 0);

  if (lines[0] !== "export * from './rpc';") {
    return null;
  }

  const modules = new Set<string>();

  for (const line of lines.slice(1)) {
    const match =
      /^export (?:type )?(?:\{[^}]+\}|\* as [A-Za-z_$][\w$]*) from '\.\/([A-Za-z0-9_$-]+)';$/.exec(
        line,
      );

    if (!match?.[1]) {
      return null;
    }

    modules.add(match[1]);
  }

  return [...modules].filter((moduleName) => moduleName !== "rpc").sort();
}

function isLegacyGeneratedModule(fileName: string, content: string): boolean {
  if (fileName === "manifest-source.ts") {
    return (
      content.includes("export const crocoManifestBundleSource = {") &&
      content.includes("schemaVersion: 'croco.rpc.manifest-source.v1'")
    );
  }

  return (
    content.includes("from './rpc';") &&
    /export const [A-Za-z_$][\w$]*ContractRoutes = \[/.test(content) &&
    (/export const [A-Za-z_$][\w$]*Client = \{/.test(content) ||
      (/export function create[A-Za-z_$][\w$]*Client\(config: RpcClientConfig = \{\}\)/.test(
        content,
      ) &&
        /export const [A-Za-z_$][\w$]*Client = create[A-Za-z_$][\w$]*Client\(\);/.test(content)))
  );
}

function isGeneratedClientOwnershipManifest(
  manifest: unknown,
): manifest is GeneratedClientOwnershipManifest {
  if (typeof manifest !== "object" || manifest === null) {
    return false;
  }

  const candidate = manifest as Record<string, unknown>;
  const files = candidate["files"];
  const directories = candidate["directories"];

  return (
    candidate["schemaVersion"] === GENERATED_CLIENT_OWNERSHIP_SCHEMA_VERSION &&
    Array.isArray(files) &&
    files.every((filePath) => typeof filePath === "string") &&
    Array.isArray(directories) &&
    directories.every((directory) => typeof directory === "string")
  );
}

function collectOwnedOutputDirectories(
  ownedPaths: ReadonlySet<string>,
  previousOwnedDirectories: readonly string[],
  outDir: string,
): ReadonlySet<string> {
  const previousDirectories = new Set(previousOwnedDirectories);
  const ownedDirectories = new Set<string>();

  for (const ownedPath of ownedPaths) {
    let directory = path.posix.dirname(ownedPath);

    while (directory !== ".") {
      const directoryPath = resolveOwnedOutputPath(outDir, directory);

      if (
        previousDirectories.has(directory) ||
        !fs.lstatSync(directoryPath, { throwIfNoEntry: false })
      ) {
        ownedDirectories.add(directory);
      }

      directory = path.posix.dirname(directory);
    }
  }

  return ownedDirectories;
}

function assertSafeOwnedOutputPath(filePath: string, manifestPath: string): void {
  if (
    filePath.length === 0 ||
    filePath.includes("\\") ||
    path.posix.isAbsolute(filePath) ||
    filePath === ".." ||
    filePath.startsWith("../") ||
    path.posix.normalize(filePath) !== filePath ||
    filePath === GENERATED_CLIENT_OWNERSHIP_MANIFEST_NAME
  ) {
    throw new RpcCodegenContractProblem(
      `Generated output ownership manifest '${manifestPath}' contains unsafe path '${filePath}'. Remove the invalid manifest and regenerate the RPC client.`,
    );
  }
}

function assertOwnedFilePathDoesNotTraverseSymlink(outDir: string, filePath: string): void {
  let currentPath = path.resolve(outDir);
  const manifestPath = getGeneratedClientOwnershipManifestPath(outDir);
  const segments = filePath.split("/");

  for (const segment of segments.slice(0, -1)) {
    currentPath = path.join(currentPath, segment);
    const currentStat = fs.lstatSync(currentPath, { throwIfNoEntry: false });

    if (currentStat?.isSymbolicLink()) {
      throw new RpcCodegenContractProblem(
        `Generated output ownership manifest '${manifestPath}' path '${filePath}' traverses symbolic link '${currentPath}'. Replace the symbolic link with an output directory before regenerating the RPC client.`,
      );
    }

    if (currentStat && !currentStat.isDirectory()) {
      throw new RpcCodegenContractProblem(
        `Generated output ownership manifest '${manifestPath}' path '${filePath}' traverses non-directory '${currentPath}'. Replace it with an output directory before regenerating the RPC client.`,
      );
    }
  }

  const ownedPath = resolveOwnedOutputPath(outDir, filePath);
  const ownedPathStat = fs.lstatSync(ownedPath, { throwIfNoEntry: false });

  if (ownedPathStat?.isSymbolicLink()) {
    throw new RpcCodegenContractProblem(
      `Generated output ownership manifest '${manifestPath}' path '${filePath}' must not be a symbolic link. Replace it with a regular output file before regenerating the RPC client.`,
    );
  }

  if (ownedPathStat?.isDirectory()) {
    throw new RpcCodegenContractProblem(
      `Generated output ownership manifest '${manifestPath}' path '${filePath}' refers to a directory. Remove the invalid manifest and regenerate the RPC client.`,
    );
  }
}

function removeOwnedOutputFile(outDir: string, filePath: string): void {
  const absolutePath = resolveOwnedOutputPath(outDir, filePath);

  fs.rmSync(absolutePath, { force: true });
}

function removeOwnedOutputDirectories(outDir: string, directories: readonly string[]): void {
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    const directoryPath = resolveOwnedOutputPath(outDir, directory);

    if (fs.existsSync(directoryPath) && fs.readdirSync(directoryPath).length === 0) {
      fs.rmdirSync(directoryPath);
    }
  }
}

function assertOwnedOutputDirectoriesCanBeRemoved(
  outDir: string,
  directories: readonly string[],
): void {
  const manifestPath = getGeneratedClientOwnershipManifestPath(outDir);

  for (const directory of directories) {
    assertSafeOwnedOutputPath(directory, manifestPath);
    assertOwnedFilePathDoesNotTraverseSymlink(outDir, `${directory}/.croco-owned-directory`);
  }
}

function resolveOwnedOutputPath(outDir: string, filePath: string): string {
  return path.join(path.resolve(outDir), ...filePath.split("/"));
}

function getGeneratedClientOwnershipManifestPath(outDir: string): string {
  return path.join(outDir, GENERATED_CLIENT_OWNERSHIP_MANIFEST_NAME);
}

function serializeGeneratedClientOwnershipManifest(
  ownedPaths: ReadonlySet<string>,
  ownedDirectories: ReadonlySet<string>,
): string {
  const manifest: GeneratedClientOwnershipManifest = {
    schemaVersion: GENERATED_CLIENT_OWNERSHIP_SCHEMA_VERSION,
    files: [...ownedPaths].sort(),
    directories: [...ownedDirectories].sort(),
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function normalizeGeneratedContent(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}
