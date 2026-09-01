import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  readGeneratedTemplateSecretAllowlistsFromMetadata,
  scanGeneratedTemplateSecretText,
} from "../packages/create-croco-app/src/secret-placeholder-policy.ts";
import { SUPPORTED_CREATE_CROCO_APP_CHOICES } from "../packages/create-croco-app/src/supported-options.ts";
import { VERSIONS } from "../packages/create-croco-app/src/consts.ts";
import {
  classifySmokeCommandFailure,
  classifySmokeFailure,
  collectSmokeFailureArtifactFiles,
  copyGeneratedSmokeArtifacts,
  createSmokeRecoverySummary,
  extractSmokeCommandDiagnosticCodes,
  type GeneratedSmokeArtifact,
  type SmokeCaseArtifactBundle,
  type SmokeCaseRecoverySummary,
  type SmokeFailureClassification,
  toPosixPath,
} from "./create-croco-app-generated-smoke-report.mts";
import {
  createGeneratedSmokeMatrixAggregateReport,
  createGeneratedSmokeMatrixTierReport,
  renderGeneratedSmokeMatrixReport,
  REST_SPA_CONTRACT_SMOKE_CASE_NAME,
  selectGeneratedSmokeMatrixCases,
  withGeneratedSmokeMatrixMetadata,
  type AdvisorySmokeMetadata,
  type SmokeMatrixCaseFailureEvidence,
  type SmokeMatrixFailure,
  type SmokeMatrixTier,
} from "./create-croco-app-generated-smoke-matrix.mts";
import {
  createGeneratedSmokeJourneyReport,
  writeCanonicalGeneratedSmokeJourneyBundle,
} from "./create-croco-app-generated-smoke-journey-report.mts";
import {
  assertGeneratedTemplateLintContracts,
  createWorkspacePackageIndex,
  type DependencyField,
  type ExternalCrocoRangeException,
  type PackageJson,
  resolveLocalCrocoPackagesForGeneratedProject,
  rewriteExternalCrocoRanges,
  type WorkspacePackage,
  writePnpmWorkspaceOverrides,
} from "./create-croco-app-generated-smoke-support.mts";
import { assertGeneratedSmokeCaseDependencyMapping } from "./create-croco-app-generated-smoke-dependencies.mts";
import { inventoryDigest, readTestInventory } from "./test-inventory.mts";
import { readCompletedPlaywrightPaths, readCompletedVitestPaths } from "./test-lane-runner.mts";
import type { AppGoal } from "../packages/create-croco-app/src/types.ts";
import type { MaterializationEvidence, TestInventoryEntry } from "./test-inventory.mts";

const DEFAULT_TENANT_MODEL = "org";
const GENERATED_NODE_VERSION = VERSIONS.node;
const GENERATED_NODE_ENGINE_RANGE = `>=${GENERATED_NODE_VERSION}`;
const SAAS_GENERATED_NODE_VERSION = "22.5";
const SAAS_GENERATED_NODE_ENGINE_RANGE = ">=22.5";
const GRAPHQL_CONTRACT_CHECK_LABEL = "GraphQL contract check";
const GRAPHQL_CONTRACT_SNAPSHOT_LABEL = "GraphQL contract snapshot";
const GRAPHQL_CONTRACT_SNAPSHOT_PATH = "graphql-contract.snapshot.json";
const GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH = ["apps", "graphql-api"] as const;
const GRAPHQL_NEXTJS_CONTRACT_PACKAGE_PATH = ["apps", "web"] as const;
const GRAPHQL_RESOLVER_METADATA_DRIFT_CODES = [
  "graphql-resolver-guards-changed",
  "graphql-resolver-roles-changed",
  "graphql-resolver-interceptors-changed",
  "graphql-resolver-di-scope-changed",
  "graphql-resolver-problems-changed",
] as const;
const GENERATED_SMOKE_WORKSPACE_BUILD_ROOTS = [
  "@croco/auth-better-auth",
  "@croco/auth-clerk",
  "@croco/auth-drizzle",
  "@croco/billing-polar",
  "@croco/cli",
  "@croco/events-core",
  "@croco/events-inmemory",
  "create-croco-app",
  "@croco/framework-context",
  "@croco/frontend-cloudflare",
  "@croco/frontend-problems",
  "@croco/frontend-react",
  "@croco/frontend-vite",
  "@croco/llm-core",
  "@croco/llm-metering",
  "@croco/meta-vite",
  "@croco/lifecycle-core",
  "@croco/metering-drizzle",
  "@croco/metering-upstash",
  "@croco/openapi-spec",
  "@croco/problems-core",
  "@croco/preset-cloudflare",
  "@croco/preset-lambda",
  "@croco/preset-node",
  "@croco/repository-core",
  "@croco/retry-core",
  "@croco/rpc-codegen",
  "@croco/storage-cloudinary",
  "@croco/storage-r2",
  "@croco/tasks-qstash",
  "@croco/telemetry-api",
  "@croco/telemetry-sdk-node",
  "@croco/tenant-core",
  "@croco/transports-http",
  "@croco/triggers-qstash",
  "@croco/tx-drizzle",
] as const;

type GraphQLContractSnapshotJson = {
  readonly snapshotVersion: "croco.graphql-contract.snapshot.v2";
  readonly sdl: string;
  readonly operationCount: number;
  readonly resolverCount: number;
  readonly operations: readonly GraphQLContractOperationJson[];
  readonly resolvers: readonly GraphQLContractResolverJson[];
  readonly diagnostics: readonly unknown[];
};

type GraphQLContractOperationJson = {
  readonly kind: "query" | "mutation" | "subscription";
  readonly name: string;
  readonly type: string;
  readonly args: readonly unknown[];
};

type GraphQLContractResolverJson = {
  readonly resolverName: string;
  readonly diScope: string | null;
  readonly methods: readonly GraphQLContractResolverMethodJson[];
};

type GraphQLContractResolverMethodJson = {
  readonly methodName: string;
  readonly guards: readonly string[];
  readonly interceptors: readonly string[];
  readonly roles: readonly string[];
  readonly problems: readonly GraphQLContractProblemJson[];
};

type GraphQLContractProblemJson = {
  readonly code: string;
  readonly category: string;
  readonly status: number;
};

type SmokeValidation = {
  readonly label: string;
  readonly readOnly?: boolean;
  readonly recovery?: string;
  readonly packagePath?: readonly string[];
  readonly args?: readonly string[];
  readonly paths?: readonly string[];
  readonly browserWorkflowPolicy?: string;
  readonly json?: {
    readonly path: string;
    readonly matches: Record<string, unknown>;
    readonly arrayMinLengths?: Readonly<Record<string, number>>;
  };
  readonly presentationProfile?: {
    readonly appPath: string;
    readonly runtimeProfileName: string;
  };
  readonly artifacts?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly expectFailure?: {
    readonly outputIncludes: readonly string[];
  };
};

type SmokeStepStatus = "pending" | "passed" | "failed";

type SmokeStepResult = {
  readonly label: string;
  readonly command?: string;
  readonly packagePath?: readonly string[];
  readonly paths?: readonly string[];
  readonly jsonPath?: string;
  artifacts: readonly GeneratedSmokeArtifact[];
  readonly expectFailure?: boolean;
  status: SmokeStepStatus;
  diagnosticCodes: readonly string[];
  executedTestPaths: readonly string[];
  error?: string;
};

type SmokeCase = {
  readonly name: string;
  readonly tier: SmokeMatrixTier;
  readonly advisory?: AdvisorySmokeMetadata;
  readonly args: readonly string[];
  readonly runtimeTarget: string;
  readonly matrixTargets: readonly string[];
  readonly validations: readonly SmokeValidation[];
};

type SmokeCaseResult = {
  readonly name: string;
  readonly tier: SmokeMatrixTier;
  readonly advisory?: AdvisorySmokeMetadata;
  readonly preset: string;
  readonly runtimeTarget: string;
  readonly matrixTargets: readonly string[];
  readonly args: readonly string[];
  readonly recovery: SmokeCaseRecoverySummary;
  status: SmokeStepStatus;
  steps: SmokeStepResult[];
  error?: string;
  artifactBundle?: SmokeCaseArtifactBundle;
  failureClassification?: SmokeFailureClassification;
};

type SmokeGateResult = {
  readonly label: string;
  readonly command: string;
  readonly tier: SmokeMatrixTier;
  status: SmokeStepStatus;
  error?: string;
};

type GeneratedSmokeReport = {
  readonly schemaVersion: "croco.generated-app-smoke/v2";
  readonly generatedAt: string;
  readonly filteredRun: boolean;
  readonly requestedCaseNames: readonly string[];
  readonly selectedTier?: SmokeMatrixTier;
  readonly release: {
    readonly blockingTier: "spine-blocking";
    status: SmokeStepStatus;
  };
  readonly tiers: readonly {
    readonly tier: SmokeMatrixTier;
    status: SmokeStepStatus;
  }[];
  status: SmokeStepStatus;
  failure?: string;
  failureTier?: SmokeMatrixTier;
  readonly matrix: {
    readonly coverage: ReturnType<typeof readSmokeCoverage>;
    readonly templateTargets: readonly TemplateMatrixTarget[];
    readonly templateExclusions: readonly TemplateMatrixExclusion[];
  };
  gates: SmokeGateResult[];
  cases: SmokeCaseResult[];
};

type TemplateMatrixTarget = {
  readonly template: string;
  readonly cases: readonly string[];
};

type TemplateMatrixExclusion = {
  readonly template: string;
  readonly reason: string;
};

type CommandRunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: string | null;
  readonly outputTruncated: boolean;
  readonly diagnosticCodes: readonly string[];
};

type SmokeCommandOutputObserver = (label: string, result: CommandRunResult) => void;

class CommandExecutionError extends Error {
  readonly commandResult: CommandRunResult;

  constructor(message: string, commandResult: CommandRunResult, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.commandResult = commandResult;
  }
}

type RuntimeCapabilitySmokePlatform = "node" | "lambda" | "cloudflare-workers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");
const cliPath = join(rootDir, "packages", "create-croco-app", "dist", "bin.js");
const generatedAppTemplatesDir = join(rootDir, "packages", "create-croco-app", "templates");
const generatedSmokeReportDir = resolve(
  process.env.CROCO_GENERATED_SMOKE_REPORT_DIR ?? join(rootDir, "ci-reports", "generated-apps"),
);
export const RESOLVED_PLAYWRIGHT_BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  (process.platform === "win32"
    ? join(process.env.USERPROFILE ?? tmpdir(), "AppData", "Local", "ms-playwright")
    : process.platform === "darwin"
      ? join(process.env.HOME ?? homedir(), "Library", "Caches", "ms-playwright")
      : join(process.env.HOME ?? homedir(), ".cache", "ms-playwright"));
process.env.PLAYWRIGHT_BROWSERS_PATH = RESOLVED_PLAYWRIGHT_BROWSERS_PATH;
const testInventory = readTestInventory().inventory;
const testInventoryDigest = inventoryDigest(testInventory);
const generatedMaterializationEvidence = new Map<string, MaterializationEvidence>();

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function selectCompletedGeneratedTestEntries(
  projectDir: string,
  entries: readonly TestInventoryEntry[],
  executedPaths: ReadonlySet<string>,
): readonly TestInventoryEntry[] {
  return entries.filter((entry) => {
    if (!entry.generated || !existsSync(join(projectDir, entry.generated.generatedPath))) {
      return false;
    }
    return executedPaths.has(entry.generated.generatedPath);
  });
}

function recordGeneratedTestMaterialization(
  projectDir: string,
  executedPaths: ReadonlySet<string>,
): void {
  const materializedRoot = join(generatedSmokeReportDir, "materialized-tests");
  const generatedEntries = testInventory.tests.filter(({ lane }) => lane === "generated-app");
  for (const entry of selectCompletedGeneratedTestEntries(
    projectDir,
    generatedEntries,
    executedPaths,
  )) {
    if (!entry.generated || generatedMaterializationEvidence.has(entry.path)) continue;
    const generatedPath = join(projectDir, entry.generated.generatedPath);
    if (!existsSync(generatedPath)) continue;
    const reportPath = join(materializedRoot, entry.generated.generatedPath);
    mkdirSync(dirname(reportPath), { recursive: true });
    copyFileSync(generatedPath, reportPath);
    generatedMaterializationEvidence.set(entry.path, {
      sourcePath: entry.path,
      sourceDigest: fileSha256(join(rootDir, entry.path)),
      generatedPath: entry.generated.generatedPath,
      generatedDigest: fileSha256(reportPath),
      inventoryDigest: testInventoryDigest,
      commandId: entry.generated.commandId,
    });
  }
}

export function hasCompleteTapTestEvidence(output: string): boolean {
  const value = (name: string): number | undefined => {
    const match = new RegExp(`^# ${name} (\\d+)$`, "m").exec(output);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  };
  const tests = value("tests");
  const pass = value("pass");
  return (
    tests !== undefined &&
    tests > 0 &&
    pass === tests &&
    value("fail") === 0 &&
    (value("skipped") ?? 0) === 0 &&
    (value("todo") ?? 0) === 0
  );
}

function findGeneratedTestPackageDirectory(projectDir: string, generatedPath: string): string {
  const resolvedProjectDir = resolve(projectDir);
  const generatedTestPath = resolve(resolvedProjectDir, generatedPath);
  const projectRelativePath = relative(resolvedProjectDir, generatedTestPath);
  if (
    projectRelativePath === ".." ||
    projectRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(projectRelativePath)
  ) {
    throw new Error(`Generated test has no package.json boundary: ${generatedPath}`);
  }

  let directory = dirname(generatedTestPath);
  while (directory !== resolvedProjectDir) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) break;
    directory = parentDirectory;
  }
  if (existsSync(join(resolvedProjectDir, "package.json"))) return resolvedProjectDir;
  throw new Error(`Generated test has no package.json boundary: ${generatedPath}`);
}

type GeneratedUnitEvidenceCapture = {
  readonly projectDir: string;
  readonly reports: readonly {
    readonly kind: "vitest" | "tap";
    readonly path: string;
    readonly packageDir: string;
    readonly generatedPaths: readonly string[];
    readonly selectedGeneratedPaths?: readonly string[];
  }[];
  readonly restore: () => void;
};

function normalizedPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((path) => path.split(sep).join("/")))].sort();
}

export function reconcileGeneratedTestPaths(
  reportedPaths: readonly string[],
  expectedPaths: readonly string[],
): readonly string[] {
  const expected = normalizedPaths(expectedPaths);
  return normalizedPaths(
    normalizedPaths(reportedPaths).flatMap((reportedPath) => {
      if (expected.includes(reportedPath)) return [reportedPath];
      const suffixMatches = expected.filter((expectedPath) =>
        expectedPath.endsWith(`/${reportedPath}`),
      );
      return suffixMatches.length === 1 ? suffixMatches : [];
    }),
  );
}

export function resolveTapSelectedGeneratedPaths(
  script: string,
  packageDir: string,
  projectDir: string,
): readonly string[] {
  const tokens = script.trim().split(/\s+/);
  const testIndex = tokens.indexOf("--test");
  if (testIndex < 0) throw new Error(`TAP generated test script has no --test selector: ${script}`);
  const selectors = tokens
    .slice(testIndex + 1)
    .filter((token) => !token.startsWith("--"))
    .map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
  if (selectors.length === 0) {
    throw new Error(`TAP generated test script has no explicit file selector: ${script}`);
  }
  return normalizedPaths(
    selectors.flatMap((selector) =>
      globSync(selector, { cwd: packageDir, withFileTypes: true })
        .filter((entry) => !entry.isDirectory())
        .map((entry) => relative(projectDir, join(entry.parentPath, entry.name))),
    ),
  );
}

function resolveGeneratedTestScriptName(scripts: Readonly<Record<string, string>>): string {
  let name = "test";
  for (let depth = 0; depth < 4; depth += 1) {
    const script = scripts[name];
    const delegated = script && /^pnpm (?:run )?(test(?::[^\s]+))$/.exec(script)?.[1];
    if (!delegated) return name;
    name = delegated;
  }
  throw new Error("Generated test script delegation is too deep");
}

export function prepareGeneratedUnitEvidenceCapture(
  projectDir: string,
  inventoryEntries: readonly TestInventoryEntry[] = testInventory.tests,
): GeneratedUnitEvidenceCapture {
  const grouped = new Map<string, string[]>();
  for (const entry of inventoryEntries.filter(({ lane }) => lane === "generated-app")) {
    const generatedPath = entry.generated?.generatedPath;
    if (
      !generatedPath ||
      generatedPath.startsWith("tests/journeys/") ||
      !existsSync(resolve(projectDir, generatedPath))
    ) {
      continue;
    }
    const packageDir = findGeneratedTestPackageDirectory(projectDir, generatedPath);
    grouped.set(packageDir, [...(grouped.get(packageDir) ?? []), generatedPath]);
  }

  const originals = new Map<string, string>();
  const reports: GeneratedUnitEvidenceCapture["reports"][number][] = [];
  const restore = (): void => {
    for (const [manifestPath, original] of originals) writeFileSync(manifestPath, original);
    for (const report of reports) rmSync(report.path, { force: true });
  };

  try {
    const rootManifestPath = join(projectDir, "package.json");
    if (existsSync(rootManifestPath)) {
      const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8")) as {
        readonly scripts?: Readonly<Record<string, string>>;
      };
      const rootTestScript =
        rootManifest.scripts?.[resolveGeneratedTestScriptName(rootManifest.scripts)];
      const turboConfigPath = join(projectDir, "turbo.json");
      if (rootTestScript?.includes("turbo") && existsSync(turboConfigPath)) {
        const original = readFileSync(turboConfigPath, "utf8");
        const turboConfig = JSON.parse(original) as {
          tasks?: Record<string, { outputs?: string[] }>;
        };
        const testTask = turboConfig.tasks?.test;
        if (testTask) {
          testTask.outputs = [
            ...new Set([...(testTask.outputs ?? []), ".croco-generated-test-evidence.json"]),
          ];
          originals.set(turboConfigPath, original);
          writeFileSync(turboConfigPath, `${JSON.stringify(turboConfig, null, 2)}\n`);
        }
      }
    }

    for (const [packageDir, generatedPaths] of grouped) {
      const manifestPath = join(packageDir, "package.json");
      const original = readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(original) as {
        readonly [key: string]: unknown;
        scripts?: Record<string, string>;
      };
      const scripts = manifest.scripts;
      if (!scripts)
        throw new Error(`${relative(projectDir, packageDir)}/package.json has no scripts`);
      const scriptName = resolveGeneratedTestScriptName(scripts);
      const script = scripts[scriptName];
      const reportFile = ".croco-generated-test-evidence.json";
      const reportPath = join(packageDir, reportFile);
      rmSync(reportPath, { force: true });
      if (script?.includes("vitest")) {
        scripts[scriptName] =
          `${script} --reporter=default --reporter=json --outputFile=${reportFile}`;
        reports.push({ kind: "vitest", path: reportPath, packageDir, generatedPaths });
      } else if (script?.includes("tsx --test")) {
        if (generatedPaths.length !== 1) {
          throw new Error(`TAP generated package must own exactly one mapped test: ${packageDir}`);
        }
        const selectedGeneratedPaths = resolveTapSelectedGeneratedPaths(
          script,
          packageDir,
          projectDir,
        );
        const expectedGeneratedPaths = normalizedPaths(generatedPaths);
        if (
          selectedGeneratedPaths.length !== expectedGeneratedPaths.length ||
          selectedGeneratedPaths.some((path, index) => path !== expectedGeneratedPaths[index])
        ) {
          throw new Error(
            `TAP generated test selectors do not exactly match mapped tests: ${relative(projectDir, packageDir)}`,
          );
        }
        scripts[scriptName] = script.replace(
          "tsx --test",
          `tsx --test --test-reporter=tap --test-reporter-destination=${reportFile}`,
        );
        reports.push({
          kind: "tap",
          path: reportPath,
          packageDir,
          generatedPaths,
          selectedGeneratedPaths,
        });
      } else {
        throw new Error(
          `Generated test package uses an unsupported evidence runner: ${packageDir}`,
        );
      }
      originals.set(manifestPath, original);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    return { projectDir, reports, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

function readGeneratedUnitEvidence(capture: GeneratedUnitEvidenceCapture): readonly string[] {
  return capture.reports.flatMap((report) => {
    if (!existsSync(report.path)) return [];
    if (report.kind === "tap") {
      const exactSelectors =
        JSON.stringify(normalizedPaths(report.selectedGeneratedPaths ?? [])) ===
        JSON.stringify(normalizedPaths(report.generatedPaths));
      return exactSelectors && hasCompleteTapTestEvidence(readFileSync(report.path, "utf8"))
        ? report.generatedPaths
        : [];
    }
    const completed = new Set(readCompletedVitestPaths(report.path, report.packageDir));
    return report.generatedPaths.filter((generatedPath) =>
      completed.has(
        relative(report.packageDir, join(capture.projectDir, generatedPath)).split(sep).join("/"),
      ),
    );
  });
}

function writeGeneratedTestMaterializationEvidence(): void {
  mkdirSync(generatedSmokeReportDir, { recursive: true });
  writeFileSync(
    join(generatedSmokeReportDir, "materialization-evidence.json"),
    `${JSON.stringify([...generatedMaterializationEvidence.values()], null, 2)}\n`,
  );
}
const turboPath = join(rootDir, "node_modules", "turbo", "bin", "turbo");
const corepackCommand = process.platform === "win32" ? "corepack.cmd" : "corepack";
let smokeRoot: string | undefined;
const commandTimeoutMs = 600_000;
const commandCaptureMaxBytes = 64 * 1024 * 1024;
const commandCaptureHeadBytes = 1024 * 1024;
const smokeCaseOutputBuffers = new Map<
  string,
  { stdout: string[]; stderr: string[]; outputTruncated: boolean }
>();
const sourceFileExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const securityValidationScanFileExtensions = new Set([
  ...sourceFileExtensions,
  ".json",
  ".toml",
  ".yaml",
  ".yml",
]);
const securityValidationScanIgnoredDirectories = new Set([
  ".git",
  ".output",
  ".turbo",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);
const unsafeSecurityValidationPatterns = [
  /securityValidation\s*:\s*["']off["']/,
  /unsafeSkipSecurityValidation\s*:\s*true/,
  /\bCROCO_HTTP_SECURITY_VALIDATION\s*=\s*["']?off\b/,
  /\bprocess\.env\.CROCO_HTTP_SECURITY_VALIDATION\b/,
];
const loadViteConfigScript = [
  'import { join } from "node:path";',
  'import { loadConfigFromFile } from "vite";',
  'const result = await loadConfigFromFile({ command: "build", mode: "production" }, join(process.cwd(), "vite.config.ts"));',
  'if (!result) throw new Error("vite.config.ts did not load");',
].join(" ");
const apiWorkerFetchSmokeScript = [
  "void (async () => {",
  'const workerModule = await import("../api-worker/src/index.ts");',
  "let worker = workerModule.default;",
  'while (worker && typeof worker === "object" && "default" in worker && !("fetch" in worker)) worker = worker.default;',
  "const fetchHandler = typeof worker === 'function' ? worker : worker && typeof worker.fetch === 'function' " +
    "? worker.fetch.bind(worker) : undefined;",
  'if (typeof fetchHandler !== "function") throw new Error("API worker default export must be a fetch handler or Worker object");',
  "const executionContext = { waitUntil: () => {}, passThroughOnException: () => {}, props: undefined };",
  'const response = await fetchHandler(new Request("http://localhost/health", { headers: { origin: "http://localhost:5173", "cf-connecting-ip": "203.0.113.10" } }), { WEB_ORIGIN: "http://localhost:5173" }, executionContext);',
  "const body = await response.json();",
  "if (response.status !== 200) throw new Error(`Expected /health status 200, received ${response.status}`);",
  'if (body.status !== "up" || !Array.isArray(body.results) || body.results.length !== 0) throw new Error(`Expected empty aggregate /health body, received ${JSON.stringify(body)}`);',
  "})();",
].join(" ");
const graphqlProtectedRouteSmokeBaseScriptLines = [
  "void (async () => {",
  'await import("reflect-metadata");',
  'const { graphql } = await import("graphql");',
  "const previousGraphqlAuthToken = process.env.GRAPHQL_AUTH_TOKEN;",
  "const previousTelemetryEnabled = process.env.TELEMETRY_ENABLED;",
  'process.env.GRAPHQL_AUTH_TOKEN = "generated-smoke-token";',
  'process.env.TELEMETRY_ENABLED = "false";',
  "try {",
  'let schemaModule = await import("./src/schema.ts");',
  'while (schemaModule && typeof schemaModule === "object" && "default" in schemaModule && !("createSchema" in schemaModule)) {',
  "  schemaModule = schemaModule.default;",
  "}",
  'const schemaModuleKeys = schemaModule && typeof schemaModule === "object" ? Object.keys(schemaModule).join(",") : typeof schemaModule;',
  'const createSchema = schemaModule && typeof schemaModule === "object" ? schemaModule.createSchema : undefined;',
  'const createGraphQLContext = schemaModule && typeof schemaModule === "object" ? schemaModule.createGraphQLContext : undefined;',
  'if (typeof createSchema !== "function") {',
  "  throw new Error(`GraphQL schema module must export createSchema; keys=${schemaModuleKeys}`);",
  "}",
  'if (typeof createGraphQLContext !== "function") {',
  "  throw new Error(`GraphQL schema module must export createGraphQLContext; keys=${schemaModuleKeys}`);",
  "}",
  "const schema = await createSchema();",
  'const query = "{ protectedHealth }";',
  'const expectedAuthFailureCode = "protocols-graphql/auth-missing-header";',
  "const denied = await graphql({ schema, source: query, contextValue: createGraphQLContext() });",
  'if (!denied.errors?.length) throw new Error("Expected protectedHealth to reject missing credentials");',
  "const deniedAuthCode = denied.errors[0]?.extensions?.code ?? denied.errors[0]?.originalError?.code;",
  'if (deniedAuthCode !== expectedAuthFailureCode) throw new Error(`Expected protectedHealth to reject with ${expectedAuthFailureCode}, received ${deniedAuthCode}: ${denied.errors.map((error) => error.message).join("; ")}`);',
  "const allowed = await graphql({",
  "  schema,",
  "  source: query,",
  '  contextValue: createGraphQLContext({ authorization: "Bearer generated-smoke-token" }),',
  "});",
  'if (allowed.errors?.length) throw new Error(`Expected protectedHealth to allow valid credentials: ${allowed.errors.map((error) => error.message).join("; ")}`);',
  'if (allowed.data?.protectedHealth !== "authenticated") throw new Error(`Unexpected protectedHealth response: ${JSON.stringify(allowed.data)}`);',
];
const graphqlProtectedRouteSmokeCleanupScriptLines = [
  "} finally {",
  "  if (previousGraphqlAuthToken === undefined) {",
  "    delete process.env.GRAPHQL_AUTH_TOKEN;",
  "  } else {",
  "    process.env.GRAPHQL_AUTH_TOKEN = previousGraphqlAuthToken;",
  "  }",
  "  if (previousTelemetryEnabled === undefined) {",
  "    delete process.env.TELEMETRY_ENABLED;",
  "  } else {",
  "    process.env.TELEMETRY_ENABLED = previousTelemetryEnabled;",
  "  }",
  "}",
  "})();",
];
const graphqlStandaloneProtectedRouteSmokeScript = [
  ...graphqlProtectedRouteSmokeBaseScriptLines,
  ...graphqlProtectedRouteSmokeCleanupScriptLines,
].join(" ");
const graphqlLambdaProtectedRouteSmokeScript = [
  ...graphqlProtectedRouteSmokeBaseScriptLines,
  'let handlerModule = await import("./src/handler.ts");',
  'while (handlerModule && typeof handlerModule === "object" && "default" in handlerModule && !("handler" in handlerModule)) {',
  "  handlerModule = handlerModule.default;",
  "}",
  'const handlerModuleKeys = handlerModule && typeof handlerModule === "object" ? Object.keys(handlerModule).join(",") : typeof handlerModule;',
  'const handler = handlerModule && typeof handlerModule === "object" ? handlerModule.handler : undefined;',
  'if (typeof handler !== "function") throw new Error(`GraphQL Lambda handler module must export handler; keys=${handlerModuleKeys}`);',
  "function createLambdaEvent(headers) {",
  "  return {",
  '    version: "2.0",',
  '    routeKey: "POST /graphql",',
  '    rawPath: "/graphql",',
  '    rawQueryString: "",',
  "    headers,",
  "    requestContext: {",
  '      accountId: "smoke",',
  '      apiId: "smoke",',
  '      domainName: "localhost",',
  '      domainPrefix: "localhost",',
  '      http: { method: "POST", path: "/graphql", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "smoke" },',
  '      requestId: "smoke-request",',
  '      routeKey: "POST /graphql",',
  '      stage: "$default",',
  '      time: "01/Jan/1970:00:00:00 +0000",',
  "      timeEpoch: 0,",
  "    },",
  "    body: JSON.stringify({ query }),",
  "    isBase64Encoded: false,",
  "  };",
  "}",
  "const lambdaContext = {",
  "  callbackWaitsForEmptyEventLoop: false,",
  '  functionName: "graphql-api-smoke",',
  '  functionVersion: "$LATEST",',
  '  invokedFunctionArn: "arn:aws:lambda:local:000000000000:function:graphql-api-smoke",',
  '  memoryLimitInMB: "128",',
  '  awsRequestId: "smoke-request",',
  '  logGroupName: "/aws/lambda/graphql-api-smoke",',
  '  logStreamName: "smoke",',
  "  getRemainingTimeInMillis: () => 30_000,",
  "  done: () => undefined,",
  "  fail: (error) => { throw error; },",
  "  succeed: () => undefined,",
  "};",
  "function parseLambdaResult(result) {",
  '  if (!result || typeof result !== "object") throw new Error(`Unexpected Lambda result: ${String(result)}`);',
  '  const body = typeof result.body === "string" ? JSON.parse(result.body) : result.body;',
  "  return { statusCode: result.statusCode ?? 200, body };",
  "}",
  'const lambdaDenied = parseLambdaResult(await handler(createLambdaEvent({ "content-type": "application/json" }), lambdaContext, () => undefined));',
  "if (lambdaDenied.statusCode !== 200) throw new Error(`Expected Lambda protectedHealth denial to use GraphQL error status 200, received ${lambdaDenied.statusCode}`);",
  "if (!lambdaDenied.body?.errors?.length) throw new Error(`Expected Lambda protectedHealth to reject missing credentials: ${JSON.stringify(lambdaDenied.body)}`);",
  "const lambdaDeniedAuthCode = lambdaDenied.body.errors[0]?.extensions?.code;",
  "if (lambdaDeniedAuthCode !== expectedAuthFailureCode) throw new Error(`Expected Lambda protectedHealth to reject with ${expectedAuthFailureCode}, received ${lambdaDeniedAuthCode}: ${JSON.stringify(lambdaDenied.body)}`);",
  'const lambdaAllowed = parseLambdaResult(await handler(createLambdaEvent({ "content-type": "application/json", authorization: "Bearer generated-smoke-token" }), lambdaContext, () => undefined));',
  "if (lambdaAllowed.statusCode !== 200) throw new Error(`Expected Lambda protectedHealth status 200, received ${lambdaAllowed.statusCode}`);",
  'if (lambdaAllowed.body?.errors?.length) throw new Error(`Expected Lambda protectedHealth to allow valid credentials: ${lambdaAllowed.body.errors.map((error) => error.message).join("; ")}`);',
  'if (lambdaAllowed.body?.data?.protectedHealth !== "authenticated") throw new Error(`Unexpected Lambda protectedHealth response: ${JSON.stringify(lambdaAllowed.body)}`);',
  ...graphqlProtectedRouteSmokeCleanupScriptLines,
].join(" ");
const generatedSmokeExternalCrocoRangeExceptions = {} satisfies Record<
  string,
  ExternalCrocoRangeException
>;
const runtimeCapabilitySmokePlatforms = [
  "node",
  "lambda",
  "cloudflare-workers",
] as const satisfies readonly RuntimeCapabilitySmokePlatform[];
const runtimeCapabilitySmokeSupport = {
  node: {
    env: true,
    filesystem: true,
    logger: true,
    nodeApi: true,
    requestLifecycle: true,
    trace: true,
    waitUntil: false,
    flush: false,
    streamingResponse: true,
    deadline: false,
    abortSignal: true,
    shutdown: false,
  },
  lambda: {
    env: true,
    filesystem: true,
    logger: true,
    nodeApi: true,
    requestLifecycle: true,
    trace: true,
    waitUntil: true,
    flush: true,
    streamingResponse: false,
    deadline: true,
    abortSignal: false,
    shutdown: false,
  },
  "cloudflare-workers": {
    env: true,
    filesystem: false,
    logger: true,
    nodeApi: false,
    requestLifecycle: true,
    trace: true,
    waitUntil: true,
    flush: false,
    streamingResponse: true,
    deadline: false,
    abortSignal: true,
    shutdown: false,
  },
} as const satisfies Record<RuntimeCapabilitySmokePlatform, Record<string, boolean>>;
const smokeCaseDefinitionsWithoutLint: readonly Omit<SmokeCase, "tier" | "advisory">[] = [
  {
    name: "blank-basic",
    args: ["--preset", "blank", "--scope", "@smoke", "--no-install", "--no-git"],
    runtimeTarget: "node",
    matrixTargets: ["blank"],
    validations: [{ label: "typecheck", args: ["typecheck"] }],
  },
  {
    name: "goal-saas-api",
    args: ["--goal", "saas-api", "--scope", "@smoke", "--no-install", "--no-git"],
    runtimeTarget: "node",
    matrixTargets: ["saas"],
    validations: [
      {
        label: "manifest",
        json: {
          path: "croco.app.json",
          matches: {
            schemaVersion: 1,
            projectName: "goal-saas-api",
            scope: "@smoke",
            goal: "saas-api",
            preset: "saas",
            runtimeTarget: "node",
            protocol: "rest",
            providers: [
              "in-memory-tenant",
              "in-memory-metering",
              "in-memory-events",
              "better-auth",
              "drizzle-transaction",
              "polar-billing",
              "qstash-tasks",
              "cloudinary-storage",
              "node-telemetry",
            ],
            storage: ["cloudinary"],
            auth: "better-auth",
            billing: "polar",
            tenantModel: "org",
            telemetry: "opentelemetry-otlp",
            deploymentPreset: "node-api",
            qualityGates: [
              "install",
              "typecheck",
              "build",
              "test",
              "contract:verify",
              "demo:smoke",
              "failure-drill:smoke",
            ],
          },
        },
      },
      runtimeCapabilityManifestValidation("saas-node"),
      { label: "contract:snapshot", args: ["contract:snapshot"] },
      {
        label: "codegen",
        args: ["codegen"],
        paths: ["croco.project-map.json", "openapi.json", "libs/shared/provider-rpc/src/saas.ts"],
      },
      {
        label: "contract:verify",
        readOnly: true,
        recovery: "pnpm codegen",
        args: ["contract:verify"],
      },
      { label: "doctor", args: ["doctor"] },
      { label: "typecheck", args: ["typecheck"] },
      {
        label: "build",
        args: ["build"],
        paths: ["apps/api-server/dist/index.js", "apps/api-server/dist/index.mjs"],
      },
      { label: "test", args: ["test"] },
      { label: "demo:smoke", args: ["demo:smoke"] },
      {
        label: "failure-drill:smoke",
        args: ["failure-drill:smoke"],
        paths: [
          "ci-reports/failure-drills/operational.json",
          "ci-reports/failure-drills/operational.md",
        ],
        json: {
          path: "ci-reports/failure-drills/operational.json",
          matches: {
            schemaVersion: "croco.operational-failure-drills/v1",
            status: "passed",
            scenarioIds: [
              "provider-environment-missing",
              "telemetry-exporter-unavailable",
              "di-provider-missing",
              "di-scope-mismatch",
              "route-validation-failure",
              "rate-limit-exhausted",
              "auth-verifier-unavailable",
              "webhook-signature-invalid",
            ],
            outcomeKinds: [
              "diagnostic",
              "problem",
              "problem",
              "problem",
              "problem",
              "problem",
              "problem",
              "problem",
            ],
          },
        },
      },
    ],
  },
  {
    name: "goal-spa-backend-split",
    args: ["--goal", "spa-backend-split", "--scope", "@smoke", "--no-install", "--no-git"],
    runtimeTarget: "node",
    matrixTargets: ["spa-be-split"],
    validations: [
      {
        label: "manifest",
        json: {
          path: "croco.app.json",
          matches: {
            schemaVersion: 1,
            projectName: "goal-spa-backend-split",
            scope: "@smoke",
            goal: "spa-backend-split",
            preset: "production-app",
            runtimeTarget: "node",
            protocol: "rest-rpc-client",
            providers: ["in-memory-repository", "in-memory-events", "generated-rpc-client"],
            storage: ["in-memory-demo"],
            auth: "none",
            billing: "none",
            telemetry: "opentelemetry-otlp",
            deploymentPreset: "lambda-spa",
            qualityGates: [
              "install",
              "dev:smoke",
              "lint",
              "test",
              "typecheck",
              "build",
              "contract:verify",
            ],
          },
        },
      },
      runtimeCapabilityManifestValidation("node-application"),
      { label: "dev:smoke", args: ["dev:smoke"] },
      { label: "Chromium install", args: ["test:browser:install"] },
      { label: "test", args: ["test"] },
      { label: "typecheck", args: ["typecheck"] },
      { label: "build", args: ["build"], paths: ["apps/api-server/dist/index.js"] },
      { label: "contract:snapshot", args: ["contract:snapshot"] },
      {
        label: "codegen",
        args: ["codegen"],
        paths: ["croco.project-map.json", "openapi.json", "libs/shared/provider-rpc/src/user.ts"],
      },
      {
        label: "contract:verify",
        readOnly: true,
        recovery: "pnpm codegen",
        args: ["contract:verify"],
      },
    ],
  },
  {
    name: "goal-worker",
    args: ["--goal", "worker", "--scope", "@smoke", "--no-install", "--no-git"],
    runtimeTarget: "cloudflare-workers",
    matrixTargets: ["base-ddd"],
    validations: [
      {
        label: "manifest",
        json: {
          path: "croco.app.json",
          matches: {
            schemaVersion: 1,
            projectName: "goal-worker",
            scope: "@smoke",
            goal: "worker",
            preset: "ddd-vike-fullstack",
            runtimeTarget: "cloudflare-workers",
            protocol: "rest",
            providers: ["cloudflare-workers", "meta-vite"],
            storage: [],
            auth: "none",
            billing: "none",
            telemetry: "none",
            deploymentPreset: "cloudflare-workers",
            qualityGates: ["install", "typecheck", "build", "ssr-worker:presentation:smoke"],
          },
        },
      },
      runtimeCapabilityManifestValidation("cloudflare-workers-workspace"),
      { label: "typecheck", args: ["typecheck"] },
      { label: "build", args: ["build"] },
      {
        label: "ssr-worker:presentation:smoke",
        packagePath: ["ssr-worker"],
        args: ["presentation:smoke"],
      },
    ],
  },
  {
    name: "goal-internal-tool",
    args: ["--goal", "internal-tool", "--scope", "@smoke", "--no-install", "--no-git"],
    runtimeTarget: "node",
    matrixTargets: ["admin-console", "spa-be-split"],
    validations: [
      {
        label: "manifest",
        json: {
          path: "croco.app.json",
          matches: {
            schemaVersion: 1,
            projectName: "goal-internal-tool",
            scope: "@smoke",
            goal: "internal-tool",
            preset: "admin-console",
            runtimeTarget: "node",
            protocol: "rest-rpc-client",
            providers: ["in-memory-admin-data", "generated-rpc-client"],
            storage: ["in-memory-demo"],
            auth: "admin-demo",
            billing: "none",
            telemetry: "opentelemetry-otlp",
            deploymentPreset: "lambda-spa",
            qualityGates: [
              "install",
              "admin:smoke",
              "lint",
              "test",
              "typecheck",
              "build",
              "contract:verify",
            ],
          },
        },
      },
      runtimeCapabilityManifestValidation("node-application"),
      { label: "admin:smoke", args: ["admin:smoke"] },
      { label: "Chromium install", args: ["test:browser:install"] },
      { label: "test", args: ["test"] },
      { label: "typecheck", args: ["typecheck"] },
      { label: "build", args: ["build"], paths: ["apps/api-server/dist/index.js"] },
      { label: "contract:snapshot", args: ["contract:snapshot"] },
      {
        label: "codegen",
        args: ["codegen"],
        paths: ["croco.project-map.json", "openapi.json", "libs/shared/provider-rpc/src/admin.ts"],
      },
      {
        label: "contract:verify",
        readOnly: true,
        recovery: "pnpm codegen",
        args: ["contract:verify"],
      },
    ],
  },
  {
    name: "graphql-standalone-api",
    args: [
      "--preset",
      "ddd-api",
      "--scope",
      "@smoke",
      "--api",
      "graphql",
      "--api-hosting",
      "standalone",
      "--db",
      "postgres,mongodb,redis",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "node",
    matrixTargets: ["base-ddd"],
    validations: [
      runtimeCapabilityManifestValidation("graphql-node-application"),
      {
        label: GRAPHQL_CONTRACT_CHECK_LABEL,
        packagePath: GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH,
        args: ["contract:check"],
      },
      {
        label: GRAPHQL_CONTRACT_SNAPSHOT_LABEL,
        packagePath: GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH,
        args: ["contract:snapshot"],
        paths: [GRAPHQL_CONTRACT_SNAPSHOT_PATH],
      },
      { label: "typecheck", args: ["typecheck"] },
      {
        label: "protected GraphQL route smoke",
        packagePath: ["apps", "graphql-api"],
        args: ["exec", "tsx", "--eval", graphqlStandaloneProtectedRouteSmokeScript],
      },
      { label: "build", args: ["build"], paths: ["apps/graphql-api/dist/index.js"] },
    ],
  },
  {
    name: "graphql-lambda-api",
    args: [
      "--preset",
      "ddd-api",
      "--scope",
      "@smoke",
      "--api",
      "graphql",
      "--api-hosting",
      "standalone",
      "--backend-deploy",
      "lambda",
      "--db",
      "postgres,mongodb,redis",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "lambda",
    matrixTargets: ["base-ddd"],
    validations: [
      runtimeCapabilityManifestValidation("graphql-lambda"),
      {
        label: GRAPHQL_CONTRACT_CHECK_LABEL,
        packagePath: GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH,
        args: ["contract:check"],
      },
      {
        label: GRAPHQL_CONTRACT_SNAPSHOT_LABEL,
        packagePath: GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH,
        args: ["contract:snapshot"],
        paths: [GRAPHQL_CONTRACT_SNAPSHOT_PATH],
      },
      { label: "typecheck", args: ["typecheck"] },
      {
        label: "protected GraphQL route smoke",
        packagePath: ["apps", "graphql-api"],
        args: ["exec", "tsx", "--eval", graphqlLambdaProtectedRouteSmokeScript],
      },
      { label: "build", args: ["build"], paths: ["apps/graphql-api/dist/handler.js"] },
      { label: "test", args: ["test"] },
    ],
  },
  {
    name: "trpc-nextjs-vercel-fullstack",
    args: [
      "--preset",
      "ddd-fullstack",
      "--scope",
      "@smoke",
      "--api",
      "trpc",
      "--api-hosting",
      "nextjs",
      "--web-apps",
      "web",
      "--frontend-deploy",
      "vercel",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "node+browser",
    matrixTargets: ["base-ddd"],
    validations: [{ label: "build", args: ["build"] }],
  },
  {
    name: "graphql-nextjs-opennext",
    args: [
      "--preset",
      "ddd-fullstack",
      "--scope",
      "@smoke",
      "--api",
      "graphql",
      "--api-hosting",
      "nextjs",
      "--web-apps",
      "web",
      "--frontend-deploy",
      "opennext",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "opennext",
    matrixTargets: ["base-ddd"],
    validations: [
      {
        label: GRAPHQL_CONTRACT_CHECK_LABEL,
        packagePath: GRAPHQL_NEXTJS_CONTRACT_PACKAGE_PATH,
        args: ["contract:check"],
      },
      {
        label: GRAPHQL_CONTRACT_SNAPSHOT_LABEL,
        packagePath: GRAPHQL_NEXTJS_CONTRACT_PACKAGE_PATH,
        args: ["contract:snapshot"],
        paths: [GRAPHQL_CONTRACT_SNAPSHOT_PATH],
      },
      { label: "typecheck", packagePath: ["apps", "web"], args: ["typecheck"] },
      {
        label: "OpenNext deployment files",
        packagePath: ["apps", "web"],
        paths: ["open-next.config.ts", "wrangler.toml"],
      },
    ],
  },
  {
    name: "trpc-nextjs-docker-frontend",
    args: [
      "--preset",
      "ddd-fullstack",
      "--scope",
      "@smoke",
      "--api",
      "trpc",
      "--api-hosting",
      "nextjs",
      "--web-apps",
      "web",
      "--frontend-deploy",
      "docker",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "container+browser",
    matrixTargets: ["base-ddd"],
    validations: [{ label: "frontend Dockerfile", paths: ["web/Dockerfile"] }],
  },
  {
    name: "graphql-vite-spa-docker",
    args: [
      "--preset",
      "ddd-fullstack",
      "--scope",
      "@smoke",
      "--api",
      "graphql",
      "--api-hosting",
      "standalone",
      "--web-apps",
      "web",
      "--backend-deploy",
      "docker",
      "--frontend-deploy",
      "vite-spa",
      "--ui",
      "none",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "container+browser",
    matrixTargets: ["base-ddd"],
    validations: [
      {
        label: GRAPHQL_CONTRACT_CHECK_LABEL,
        packagePath: GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH,
        args: ["contract:check"],
      },
      {
        label: GRAPHQL_CONTRACT_SNAPSHOT_LABEL,
        packagePath: GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH,
        args: ["contract:snapshot"],
        paths: [GRAPHQL_CONTRACT_SNAPSHOT_PATH],
      },
      {
        label: "apps/web vite config load",
        packagePath: ["apps", "web"],
        args: ["exec", "node", "--input-type=module", "--eval", loadViteConfigScript],
      },
      {
        label: "apps/web browser build output",
        packagePath: ["apps", "web"],
        args: ["build"],
        paths: ["dist/index.html", "src/vite-env.d.ts"],
      },
      { label: "vite SPA Dockerfile", paths: ["web/Dockerfile.vite-spa"] },
    ],
  },
  {
    name: "graphql-vite-spa-astryx",
    args: [
      "--preset",
      "ddd-fullstack",
      "--scope",
      "@smoke",
      "--api",
      "graphql",
      "--api-hosting",
      "standalone",
      "--web-apps",
      "web",
      "--frontend-deploy",
      "vite-spa",
      "--ui",
      "astryx",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "browser",
    matrixTargets: ["base-ddd"],
    validations: [
      {
        label: GRAPHQL_CONTRACT_CHECK_LABEL,
        packagePath: GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH,
        args: ["contract:check"],
      },
      {
        label: GRAPHQL_CONTRACT_SNAPSHOT_LABEL,
        packagePath: GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH,
        args: ["contract:snapshot"],
        paths: [GRAPHQL_CONTRACT_SNAPSHOT_PATH],
      },
      {
        label: "Astryx presentation profile metadata",
        presentationProfile: {
          appPath: "apps/web/croco.presentation-profile.json",
          runtimeProfileName: "browser-vite-spa-astryx",
        },
      },
      { label: "Astryx Vite SPA typecheck", packagePath: ["apps", "web"], args: ["typecheck"] },
      {
        label: "Astryx Vite SPA browser build",
        packagePath: ["apps", "web"],
        args: ["build"],
        paths: ["dist/index.html"],
      },
      {
        label: "Astryx Croco-aware render smoke",
        packagePath: ["apps", "web"],
        args: ["presentation:smoke"],
      },
    ],
  },
  {
    name: "meta-vite-web",
    args: [
      "--preset",
      "ddd-fullstack",
      "--scope",
      "@smoke",
      "--api",
      "graphql",
      "--api-hosting",
      "standalone",
      "--web-apps",
      "web",
      "--frontend-deploy",
      "cloudflare-meta-vite",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "cloudflare-workers+browser",
    matrixTargets: ["base-ddd"],
    validations: [
      runtimeCapabilityManifestValidation("graphql-node-application"),
      {
        label: GRAPHQL_CONTRACT_CHECK_LABEL,
        packagePath: GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH,
        args: ["contract:check"],
      },
      {
        label: GRAPHQL_CONTRACT_SNAPSHOT_LABEL,
        packagePath: GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH,
        args: ["contract:snapshot"],
        paths: [GRAPHQL_CONTRACT_SNAPSHOT_PATH],
      },
      {
        label: "apps/graphql-api host build",
        packagePath: ["apps", "graphql-api"],
        args: ["build"],
        paths: ["dist/index.js"],
      },
      {
        label: "apps/web vite config load",
        packagePath: ["apps", "web"],
        args: ["exec", "node", "--input-type=module", "--eval", loadViteConfigScript],
      },
      {
        label: "apps/web meta-vite build output",
        packagePath: ["apps", "web"],
        args: ["build"],
        paths: ["dist/client", "dist/client/manifest.json"],
      },
      {
        label: "apps/web presentation smoke",
        packagePath: ["apps", "web"],
        args: ["presentation:smoke"],
      },
      { label: "test", packagePath: ["libs", "shared", "utils-env"], args: ["test"] },
    ],
  },
  {
    name: "meta-vite-fullstack-workers",
    args: [
      "--preset",
      "ddd-vike-fullstack",
      "--scope",
      "@smoke",
      "--api-hosting",
      "standalone",
      "--frontend-deploy",
      "cloudflare-meta-vite",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "cloudflare-workers",
    matrixTargets: ["base-ddd"],
    validations: [
      {
        label: "api-worker typecheck",
        packagePath: ["api-worker"],
        args: ["typecheck"],
      },
      {
        label: "api-worker wrangler build",
        packagePath: ["api-worker"],
        args: ["build"],
      },
      {
        label: "api-worker secure fetch smoke",
        packagePath: ["ssr-worker"],
        args: ["exec", "tsx", "--input-type=module", "--eval", apiWorkerFetchSmokeScript],
      },
      {
        label: "ssr-worker vite config load",
        packagePath: ["ssr-worker"],
        args: ["exec", "node", "--input-type=module", "--eval", loadViteConfigScript],
      },
      {
        label: "ssr-worker meta-vite build output",
        packagePath: ["ssr-worker"],
        args: ["build"],
        paths: ["dist/client", "dist/client/manifest.json"],
      },
      {
        label: "ssr-worker presentation smoke",
        packagePath: ["ssr-worker"],
        args: ["presentation:smoke"],
      },
      { label: "test", packagePath: ["libs", "shared", "utils-env"], args: ["test"] },
    ],
  },
  {
    name: "production-app-starter",
    args: ["--preset", "production-app", "--scope", "@smoke", "--no-install", "--no-git"],
    runtimeTarget: "node+browser",
    matrixTargets: ["spa-be-split"],
    validations: [
      { label: "dev smoke", args: ["dev:smoke"] },
      {
        label: "browser testing contract",
        paths: [
          "apps/console-web/vitest.config.ts",
          "apps/console-web/public/mockServiceWorker.js",
          "apps/console-web/src/tests/ProblemNotice.spec.tsx",
          "apps/console-web/src/test/browser.ts",
          "apps/console-web/src/test/server.ts",
          "playwright.config.ts",
          "tests/journeys/create-user.spec.ts",
          "tests/journeys/problem-rendering.spec.ts",
          ".github/workflows/browser-tests.yml",
        ],
        browserWorkflowPolicy: ".github/workflows/browser-tests.yml",
      },
      { label: "Chromium install", args: ["test:browser:install"] },
      { label: "test", args: ["test"] },
      { label: "typecheck", args: ["typecheck"] },
      { label: "build", args: ["build"] },
      {
        label: "browser journeys",
        args: ["test:journey"],
      },
      {
        label: "Contract snapshot",
        args: ["contract:snapshot"],
        paths: ["contract-graph.snapshot.json"],
        artifacts: ["contract-graph.snapshot.json"],
      },
      {
        label: "Contract coverage",
        args: ["contract:coverage"],
        paths: ["contract-graph.coverage.json"],
        artifacts: ["contract-graph.coverage.json"],
      },
      { label: "Contract diff", args: ["contract:diff"] },
      { label: "OpenAPI contract", args: ["contract:openapi"], artifacts: ["openapi.json"] },
      {
        label: "RPC client",
        args: ["contract:client"],
        paths: ["libs/shared/provider-rpc/src/user.ts"],
        artifacts: ["libs/shared/provider-rpc/src/user.ts"],
      },
      {
        label: "Project Map generation",
        args: ["project-map:write"],
        paths: ["croco.project-map.json"],
      },
      {
        label: "Contract verify",
        readOnly: true,
        recovery: "pnpm codegen",
        args: ["contract:verify"],
      },
      {
        label: "DI graph generation",
        args: ["di:graph"],
        paths: [".croco/build/di-graph.manifest.json"],
      },
      {
        label: "DI graph verify",
        readOnly: true,
        recovery: "pnpm di:graph && pnpm project-map:write",
        args: ["di:verify"],
        paths: [".croco/build/di-graph.manifest.json"],
        artifacts: [".croco/build/di-graph.manifest.json"],
        json: {
          path: ".croco/build/di-graph.manifest.json",
          matches: {
            version: "croco.di-graph.manifest.v1",
            status: "ready",
            roots: ["UserController"],
          },
          arrayMinLengths: { providers: 1 },
        },
      },
    ],
  },
  {
    name: "admin-console-starter",
    args: ["--preset", "admin-console", "--scope", "@smoke", "--no-install", "--no-git"],
    runtimeTarget: "node+browser",
    matrixTargets: ["admin-console", "spa-be-split"],
    validations: [
      { label: "admin smoke", args: ["admin:smoke"] },
      {
        label: "browser testing contract",
        paths: [
          "apps/console-web/vitest.config.ts",
          "apps/console-web/public/mockServiceWorker.js",
          "apps/console-web/src/tests/ProblemNotice.spec.tsx",
          "apps/console-web/src/test/browser.ts",
          "apps/console-web/src/test/server.ts",
          "playwright.config.ts",
          "tests/journeys/create-user.spec.ts",
          "tests/journeys/problem-rendering.spec.ts",
          ".github/workflows/browser-tests.yml",
        ],
        browserWorkflowPolicy: ".github/workflows/browser-tests.yml",
      },
      { label: "Chromium install", args: ["test:browser:install"] },
      { label: "test", args: ["test"] },
      { label: "typecheck", args: ["typecheck"] },
      { label: "build", args: ["build"] },
      {
        label: "browser journeys",
        args: ["test:journey", "tests/journeys/plan-release.spec.ts"],
        paths: ["tests/journeys/plan-release.spec.ts"],
      },
      {
        label: "Contract snapshot",
        args: ["contract:snapshot"],
        paths: ["contract-graph.snapshot.json"],
      },
      {
        label: "Contract codegen",
        args: ["codegen"],
        paths: ["croco.project-map.json", "openapi.json", "libs/shared/provider-rpc/src/admin.ts"],
      },
      {
        label: "Contract verify",
        readOnly: true,
        recovery: "pnpm codegen",
        args: ["contract:verify"],
      },
      {
        label: "Admin RPC client",
        args: ["contract:client"],
        paths: ["libs/shared/provider-rpc/src/admin.ts"],
      },
      {
        label: "DI graph generation",
        args: ["di:graph"],
        paths: [".croco/build/di-graph.manifest.json"],
      },
      {
        label: "DI graph verify",
        readOnly: true,
        recovery: "pnpm di:graph && pnpm project-map:write",
        args: ["di:verify"],
        paths: [".croco/build/di-graph.manifest.json"],
        json: {
          path: ".croco/build/di-graph.manifest.json",
          matches: {
            version: "croco.di-graph.manifest.v1",
            status: "ready",
            roots: ["AdminController", "UserController"],
          },
          arrayMinLengths: { providers: 2 },
        },
      },
    ],
  },
  {
    name: "saas-golden-path",
    args: [
      "--preset",
      "saas",
      "--scope",
      "@smoke",
      "--saas-profile",
      "saas-node-postgres",
      "--tenant-model",
      "rls-backed",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "node",
    matrixTargets: ["saas"],
    validations: [
      {
        label: "provider profile manifest",
        readOnly: true,
        recovery: "Regenerate the application from its create-croco-app preset",
        args: ["profile:check"],
        paths: [
          "croco-saas-profile.manifest.json",
          "croco-tenant-model.manifest.json",
          "croco-tenant-model.schema.json",
          ".env.example",
          "docs/provider-profile.md",
          "docs/tenant-model-playbook.md",
          "docs/secrets-checklist.md",
          "apps/api-server/src/generatedSaasProviderProfile.ts",
          "apps/api-server/src/generatedTenantModel.ts",
        ],
      },
      {
        label: "real-provider missing env diagnostic",
        args: ["profile:smoke:real"],
        env: {
          SAAS_PROVIDER_PROFILE: "saas-node-postgres",
          DATABASE_URL: "",
          BETTER_AUTH_SECRET: "",
          BETTER_AUTH_URL: "",
          POLAR_ACCESS_TOKEN: "",
          POLAR_WEBHOOK_SECRET: "",
          POLAR_PRODUCT_ID_TEAM: "",
          UPSTASH_QSTASH_TOKEN: "",
          UPSTASH_QSTASH_DESTINATION_URL: "",
          UPSTASH_QSTASH_CURRENT_SIGNING_KEY: "",
          UPSTASH_QSTASH_NEXT_SIGNING_KEY: "",
          CLOUDINARY_URL: "",
        },
        expectFailure: {
          outputIncludes: [
            "CROCO_SAAS_PROFILE_ENV_MISSING",
            "DATABASE_URL",
            "POLAR_ACCESS_TOKEN",
            "CLOUDINARY_URL",
          ],
        },
      },
      {
        label: "real-provider constructor bootstrap",
        args: ["profile:smoke:real"],
        env: {
          SAAS_PROVIDER_PROFILE: "saas-node-postgres",
          DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/croco_profile_smoke",
          BETTER_AUTH_SECRET: "generated-smoke-better-auth-secret-32",
          BETTER_AUTH_URL: "http://localhost:3000",
          POLAR_ACCESS_TOKEN: "polar_generated_smoke_token",
          POLAR_WEBHOOK_SECRET: "polar_generated_smoke_webhook_secret",
          POLAR_PRODUCT_ID_TEAM: "polar_generated_smoke_team_product",
          UPSTASH_QSTASH_TOKEN: "qstash_generated_smoke_token",
          UPSTASH_QSTASH_DESTINATION_URL: "https://example.test/tasks",
          UPSTASH_QSTASH_CURRENT_SIGNING_KEY: "qstash_generated_smoke_current_key",
          UPSTASH_QSTASH_NEXT_SIGNING_KEY: "qstash_generated_smoke_next_key",
          CLOUDINARY_URL: "cloudinary://generated-key:generated-secret@generated-cloud",
          TELEMETRY_ENABLED: "false",
        },
      },
      {
        label: "usage dashboard generator",
        args: ["exec", "croco", "generate", "usage-dashboard", "--no-page"],
        paths: [
          "apps/api-server/src/controllers/UsageDashboardController.ts",
          "apps/api-server/src/usage-dashboard/UsageDashboardService.ts",
        ],
      },
      { label: "typecheck", args: ["typecheck"] },
      { label: "build", args: ["build"] },
      {
        label: "Contract snapshot",
        args: ["contract:snapshot"],
        paths: ["contract-graph.snapshot.json"],
      },
      {
        label: "Contract codegen",
        args: ["codegen"],
        paths: ["croco.project-map.json", "openapi.json", "libs/shared/provider-rpc/src/saas.ts"],
      },
      { label: "test", args: ["test"] },
      {
        label: "Contract verify",
        readOnly: true,
        recovery: "pnpm codegen",
        args: ["contract:verify"],
      },
      {
        label: "DI graph generation",
        args: ["di:graph"],
        paths: [".croco/build/di-graph.manifest.json"],
      },
      {
        label: "DI graph verify",
        readOnly: true,
        recovery: "pnpm di:graph && pnpm project-map:write",
        args: ["di:verify"],
        paths: [".croco/build/di-graph.manifest.json"],
        json: {
          path: ".croco/build/di-graph.manifest.json",
          matches: {
            version: "croco.di-graph.manifest.v1",
            status: "ready",
            roots: [
              "JobsController",
              "OperationsController",
              "SaasController",
              "UsageDashboardController",
            ],
          },
          arrayMinLengths: { providers: 4 },
        },
      },
      { label: "demo seed", args: ["demo:seed"] },
      { label: "demo flow", args: ["demo:smoke"] },
      {
        label: "failure drill smoke",
        args: ["failure-drill:smoke"],
        paths: [
          "ci-reports/failure-drills/operational.json",
          "ci-reports/failure-drills/operational.md",
        ],
        json: {
          path: "ci-reports/failure-drills/operational.json",
          matches: {
            schemaVersion: "croco.operational-failure-drills/v1",
            status: "passed",
            scenarioIds: [
              "provider-environment-missing",
              "telemetry-exporter-unavailable",
              "di-provider-missing",
              "di-scope-mismatch",
              "route-validation-failure",
              "rate-limit-exhausted",
              "auth-verifier-unavailable",
              "webhook-signature-invalid",
            ],
            outcomeKinds: [
              "diagnostic",
              "problem",
              "problem",
              "problem",
              "problem",
              "problem",
              "problem",
              "problem",
            ],
          },
        },
        artifacts: [
          "ci-reports/failure-drills/operational.json",
          "ci-reports/failure-drills/operational.md",
        ],
      },
      {
        label: "scenario output",
        args: ["demo:scenario"],
        paths: [
          "ci-reports/saas-golden-path/scenario.json",
          "ci-reports/saas-golden-path/scenario.md",
        ],
        json: {
          path: "ci-reports/saas-golden-path/scenario.json",
          matches: {
            schemaVersion: "croco.saas-golden-path.scenario/v1",
            generatedAt: "deterministic",
            tenantId: "tenant_acme",
            billingSubscriptionStatus: "active",
            dashboardTenantId: "tenant_acme",
            dashboardPlanId: "team",
            dashboardPlanVersionRef: "team@v1",
            billingDeliveryBacklogCount: 0,
            billingUsageDrift: 0,
            aiQuotaFailureCode: "llm-metering/quota-exceeded",
            operationsHealthStatus: "up",
            jobsStatus: "completed",
            lifecycleDuplicateRunStatus: "skipped",
          },
        },
        artifacts: [
          "ci-reports/saas-golden-path/scenario.json",
          "ci-reports/saas-golden-path/scenario.md",
        ],
      },
    ],
  },
  {
    name: "saas-cloudflare-profile",
    args: [
      "--preset",
      "saas",
      "--scope",
      "@smoke",
      "--saas-profile",
      "saas-cloudflare",
      "--tenant-model",
      "workspace",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "cloudflare-workers",
    matrixTargets: ["saas"],
    validations: [
      {
        label: "provider profile manifest",
        readOnly: true,
        recovery: "Regenerate the application from its create-croco-app preset",
        args: ["profile:check"],
        paths: [
          "croco-saas-profile.manifest.json",
          "croco-tenant-model.manifest.json",
          "croco-tenant-model.schema.json",
          ".env.example",
          "docs/provider-profile.md",
          "docs/tenant-model-playbook.md",
          "docs/secrets-checklist.md",
          "apps/api-server/src/generatedSaasProviderProfile.ts",
          "apps/api-server/src/generatedTenantModel.ts",
        ],
      },
      runtimeCapabilityManifestValidation("saas-cloudflare"),
      { label: "typecheck", args: ["typecheck"] },
      { label: "build", args: ["build"], paths: ["apps/api-server/dist/worker.mjs"] },
      {
        label: "Contract snapshot",
        args: ["contract:snapshot"],
        paths: ["contract-graph.snapshot.json"],
      },
      {
        label: "Contract codegen",
        args: ["codegen"],
        paths: ["croco.project-map.json", "openapi.json", "libs/shared/provider-rpc/src/saas.ts"],
      },
      { label: "test", args: ["test"] },
      {
        label: "documentation-only runtime diagnostic",
        args: ["profile:smoke:real"],
        expectFailure: {
          outputIncludes: ["CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE", "saas-cloudflare"],
        },
      },
    ],
  },
  {
    name: "saas-lambda-profile",
    args: [
      "--preset",
      "saas",
      "--scope",
      "@smoke",
      "--saas-profile",
      "saas-lambda",
      "--tenant-model",
      "shared-schema",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "lambda",
    matrixTargets: ["saas"],
    validations: [
      {
        label: "provider profile manifest",
        readOnly: true,
        recovery: "Regenerate the application from its create-croco-app preset",
        args: ["profile:check"],
        paths: [
          "croco-saas-profile.manifest.json",
          "croco-tenant-model.manifest.json",
          "croco-tenant-model.schema.json",
          ".env.example",
          "docs/provider-profile.md",
          "docs/tenant-model-playbook.md",
          "docs/secrets-checklist.md",
          "apps/api-server/src/generatedSaasProviderProfile.ts",
          "apps/api-server/src/generatedTenantModel.ts",
        ],
      },
      runtimeCapabilityManifestValidation("saas-lambda"),
      { label: "typecheck", args: ["typecheck"] },
      { label: "build", args: ["build"], paths: ["apps/api-server/dist/lambda.js"] },
      {
        label: "Contract snapshot",
        args: ["contract:snapshot"],
        paths: ["contract-graph.snapshot.json"],
      },
      {
        label: "Contract codegen",
        args: ["codegen"],
        paths: ["croco.project-map.json", "openapi.json", "libs/shared/provider-rpc/src/saas.ts"],
      },
      { label: "test", args: ["test"] },
      {
        label: "documentation-only runtime diagnostic",
        args: ["profile:smoke:real"],
        expectFailure: {
          outputIncludes: ["CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE", "saas-lambda"],
        },
      },
    ],
  },
  {
    name: "ai-saas-golden-path",
    args: [
      "--preset",
      "ai-saas",
      "--scope",
      "@smoke",
      "--tenant-model",
      "single",
      "--no-install",
      "--no-git",
    ],
    runtimeTarget: "node",
    matrixTargets: ["ai-saas", "saas"],
    validations: [
      { label: "typecheck", args: ["typecheck"] },
      { label: "build", args: ["build"] },
      {
        label: "Contract snapshot",
        args: ["contract:snapshot"],
        paths: ["contract-graph.snapshot.json"],
      },
      {
        label: "Contract codegen",
        args: ["codegen"],
        paths: ["croco.project-map.json", "openapi.json", "libs/shared/provider-rpc/src/ai.ts"],
      },
      { label: "test", args: ["test"] },
      {
        label: "Contract verify",
        readOnly: true,
        recovery: "pnpm codegen",
        args: ["contract:verify"],
      },
      {
        label: "DI graph generation",
        args: ["di:graph"],
        paths: [".croco/build/di-graph.manifest.json"],
      },
      {
        label: "DI graph verify",
        readOnly: true,
        recovery: "pnpm di:graph && pnpm project-map:write",
        args: ["di:verify"],
        paths: [".croco/build/di-graph.manifest.json"],
        json: {
          path: ".croco/build/di-graph.manifest.json",
          matches: {
            version: "croco.di-graph.manifest.v1",
            status: "ready",
            roots: ["AiController", "JobsController", "OperationsController", "SaasController"],
          },
          arrayMinLengths: { providers: 4 },
        },
      },
      { label: "AI demo flow", args: ["ai:smoke"] },
      { label: "full demo flow", args: ["demo:smoke"] },
      { label: "failure drill smoke", args: ["failure-drill:smoke"] },
    ],
  },
];

const generatedLintValidation = {
  label: "lint",
  args: ["lint"],
} as const satisfies SmokeValidation;
const smokeCaseDefinitions: readonly Omit<SmokeCase, "tier" | "advisory">[] =
  smokeCaseDefinitionsWithoutLint.map((smokeCase) => ({
    ...smokeCase,
    validations: [generatedLintValidation, ...smokeCase.validations],
  }));

const restSpaContractSmokeCase = {
  name: REST_SPA_CONTRACT_SMOKE_CASE_NAME,
  tier: "spine-blocking",
  args: [],
  runtimeTarget: "node",
  matrixTargets: ["spa-be-split"],
  validations: [],
} as const satisfies SmokeCase;
const selectableSmokeCases = withGeneratedSmokeMatrixMetadata([
  ...smokeCaseDefinitions,
  restSpaContractSmokeCase,
]);
const spineSmokeCaseNames = selectableSmokeCases
  .filter(({ tier }) => tier === "spine-blocking")
  .map(({ name }) => name);
const smokeCases = selectableSmokeCases.filter(
  (smokeCase) => smokeCase.name !== REST_SPA_CONTRACT_SMOKE_CASE_NAME,
);

export function getGeneratedSmokeDependencyCaseInputs(): readonly {
  readonly name: string;
  readonly args: readonly string[];
  readonly validations: readonly Pick<
    SmokeValidation,
    "args" | "label" | "packagePath" | "paths"
  >[];
}[] {
  return smokeCases.map(({ name, args, validations }) => ({
    name,
    args,
    validations: validations.map(({ args: validationArgs, label, packagePath, paths }) => ({
      args: validationArgs,
      label,
      packagePath,
      paths,
    })),
  }));
}

export function getGeneratedGoalSmokeCaseInputs(): readonly {
  readonly goal: AppGoal;
  readonly name: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly executedQualityGates: readonly string[];
}[] {
  return smokeCases.flatMap((smokeCase) => {
    const goal = readFlagValue(smokeCase.args, "--goal");
    if (!isSupportedGoal(goal)) return [];

    const manifest = smokeCase.validations.find(
      (validation) => validation.json?.path === "croco.app.json",
    )?.json?.matches;
    if (!manifest) {
      throw new Error(`Generated goal smoke case ${smokeCase.name} has no manifest validation`);
    }

    const executedQualityGates = [
      "install",
      ...smokeCase.validations.flatMap((validation) => {
        const command = validation.args?.[0];
        if (!command) return [];
        return validation.packagePath?.length
          ? [`${validation.packagePath.join("/")}:${command}`]
          : [command];
      }),
    ];

    return [{ goal, name: smokeCase.name, manifest, executedQualityGates }];
  });
}

if (isMainModule()) {
  let smokeReport: GeneratedSmokeReport | undefined;
  const activeSmokeRoot = getSmokeRoot();

  try {
    assertGeneratedTemplateLintContracts(generatedAppTemplatesDir);

    const smokeSelection = selectGeneratedSmokeMatrixCases(selectableSmokeCases, {
      args: process.argv.slice(2).filter((argument) => argument !== "--full-matrix"),
      env: process.env,
    });
    const selectedSmokeCases = smokeSelection.cases.filter(
      (smokeCase) => smokeCase.name !== REST_SPA_CONTRACT_SMOKE_CASE_NAME,
    );
    const shouldRunRestSpaContracts = smokeSelection.cases.some(
      (smokeCase) => smokeCase.name === REST_SPA_CONTRACT_SMOKE_CASE_NAME,
    );
    const isFilteredRun = smokeSelection.filteredRun;

    assertGeneratedVerificationValidationsAreReadOnly(
      smokeSelection.cases.flatMap(({ validations }) => validations),
    );

    assertGraphQLSmokeContractCoverage(selectedSmokeCases);

    if (isFilteredRun) {
      console.log(
        `create-croco-app-generated-smoke: selected cases ${smokeSelection.cases.map(({ name }) => name).join(", ")}`,
      );
    } else {
      assertSmokeCoverage(smokeCases);
      assertTemplateMatrixAccountability(smokeCases);
      printSmokeCoverageSummary(smokeCases);
    }

    smokeReport = createGeneratedSmokeReport(
      smokeSelection.cases,
      isFilteredRun,
      smokeSelection.selectedTier,
      smokeSelection.requestedCaseNames,
    );
    writeGeneratedSmokeReport(smokeReport);

    runGateCommand(
      smokeReport,
      "create-croco-app CLI bootstrap",
      process.execPath,
      [turboPath, "build", "--filter=create-croco-app..."],
      rootDir,
      "spine-blocking",
    );
    assertExists(cliPath, "create-croco-app dist CLI is missing after build");

    const workspacePackageIndex = createWorkspacePackageIndex(rootDir);
    const packedWorkspacePackages = new Map<string, string>();
    const builtWorkspacePackageNames = new Set<string>();

    if (smokeSelection.selectedTier !== "spine-blocking") {
      runGeneratedAppContractGates(smokeReport);
      const workspaceBuildPassed = runContinuingGateCommand(
        smokeReport,
        "workspace package build",
        process.execPath,
        [
          turboPath,
          "build",
          ...turboConcurrencyArguments(),
          ...GENERATED_SMOKE_WORKSPACE_BUILD_ROOTS.map(
            (packageName) => `--filter=${packageName}...`,
          ),
        ],
        rootDir,
        "ecosystem-advisory",
      );
      if (workspaceBuildPassed) {
        markWorkspacePackageClosureBuilt(
          GENERATED_SMOKE_WORKSPACE_BUILD_ROOTS.filter(
            (packageName) => packageName !== "create-croco-app",
          ),
          workspacePackageIndex,
          builtWorkspacePackageNames,
        );
        builtWorkspacePackageNames.add("create-croco-app");
      }
    }

    const smokeCaseFailures: Error[] = [];

    for (const smokeCase of selectedSmokeCases) {
      const projectDir = join(activeSmokeRoot, smokeCase.name);
      const caseResult = getSmokeCaseResult(smokeReport, smokeCase.name);

      try {
        runSmokeCaseCommand(
          smokeReport,
          caseResult,
          projectDir,
          "generate",
          "node",
          [cliPath, projectDir, ...smokeCase.args],
          rootDir,
        );
        assertGeneratedSmokeCaseDependencyMapping(smokeCase.name, projectDir, rootDir);
        const generatedSmokeRangeOverrides = getGeneratedSmokeRangeOverrides(
          projectDir,
          join(activeSmokeRoot, "generated-package-packs"),
          workspacePackageIndex,
          packedWorkspacePackages,
          builtWorkspacePackageNames,
          (label, result) => appendSmokeCaseOutput(caseResult, label, result),
        );
        rewriteExternalCrocoRanges(
          projectDir,
          generatedSmokeRangeOverrides,
          generatedSmokeExternalCrocoRangeExceptions,
        );
        assertGeneratedReadme(projectDir, smokeCase);
        assertGeneratedNodeRuntimeContract(projectDir, smokeCase);
        assertGeneratedEnvironmentTemplate(projectDir, smokeCase);
        assertNoGeneratedSecurityValidationOptOut(projectDir, smokeCase);
        assertNoGeneratedCredentialLookingValues(projectDir, smokeCase);
        writePnpmWorkspaceOverrides(projectDir, generatedSmokeRangeOverrides);
        runSmokeCaseCommand(
          smokeReport,
          caseResult,
          projectDir,
          "install",
          corepackCommand,
          ["pnpm", "install"],
          projectDir,
        );
        const lockfilePath = join(projectDir, "pnpm-lock.yaml");
        assertExists(lockfilePath, `${smokeCase.name} did not create a pnpm lockfile`);
        assertPnpmLockfileUsesLocalTarballOverrides(
          lockfilePath,
          smokeCase.name,
          generatedSmokeRangeOverrides,
        );
        assertExists(
          join(projectDir, "node_modules"),
          `${smokeCase.name} did not install dependencies with pnpm`,
        );
        runSmokeCaseCommand(
          smokeReport,
          caseResult,
          projectDir,
          "frozen install",
          corepackCommand,
          ["pnpm", "install", "--frozen-lockfile"],
          projectDir,
        );
        for (const validation of smokeCase.validations) {
          runValidation(projectDir, smokeCase, validation, smokeReport, caseResult);
        }
        runSaasMonetizationContractCanaries(projectDir, smokeCase, smokeReport, caseResult);
        runGeneratedBrowserContractDriftCanaries(projectDir, smokeCase, smokeReport, caseResult);
        runGraphQLContractDriftCanaries(projectDir, smokeCase, smokeReport, caseResult);
        const executedGeneratedPaths = new Set(
          caseResult.steps.flatMap(({ executedTestPaths }) => executedTestPaths),
        );
        caseResult.status = "passed";
        recordGeneratedTestMaterialization(projectDir, executedGeneratedPaths);
        writeGeneratedSmokeReport(smokeReport);
      } catch (error) {
        recordUnhandledSmokeCaseFailure(smokeReport, caseResult, projectDir, error);
        smokeCaseFailures.push(error instanceof Error ? error : new Error(toErrorMessage(error)));
        writeGeneratedSmokeReport(smokeReport);
        console.error(
          `create-croco-app-generated-smoke: ${smokeCase.name} failed: ${toErrorMessage(error)}`,
        );
      }
    }

    if (shouldRunRestSpaContracts) {
      try {
        runSpaBeSplitContractSmoke(
          workspacePackageIndex,
          packedWorkspacePackages,
          builtWorkspacePackageNames,
          smokeReport,
          getSmokeCaseResult(smokeReport, REST_SPA_CONTRACT_SMOKE_CASE_NAME),
        );
      } catch (error) {
        smokeCaseFailures.push(error instanceof Error ? error : new Error(toErrorMessage(error)));
        console.error(
          `create-croco-app-generated-smoke: ${REST_SPA_CONTRACT_SMOKE_CASE_NAME} failed: ${toErrorMessage(error)}`,
        );
      }
    }

    const failedGates = smokeReport.gates.filter((gate) => gate.status === "failed");
    if (smokeCaseFailures.length > 0 || failedGates.length > 0) {
      throw new Error(
        `Generated app smoke completed with ${smokeCaseFailures.length} case failure(s) and ${failedGates.length} gate failure(s)`,
      );
    }

    smokeReport.status = "passed";
    writeGeneratedTestMaterializationEvidence();
    writeGeneratedSmokeReport(smokeReport);
    console.log("create-croco-app-generated-smoke: all generated app smoke cases passed");
  } catch (error) {
    if (smokeReport) {
      smokeReport.status = "failed";
      smokeReport.failure = toErrorMessage(error);
      smokeReport.failureTier ??= smokeReport.selectedTier ?? "spine-blocking";
      writeGeneratedSmokeReport(smokeReport);
    }
    throw error;
  } finally {
    rmSync(activeSmokeRoot, { force: true, recursive: true });
    smokeRoot = undefined;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

function getSmokeRoot(): string {
  smokeRoot ??= mkdtempSync(join(tmpdir(), "croco-generated-app-smoke-"));
  return smokeRoot;
}

function runGeneratedAppContractGates(report: GeneratedSmokeReport): void {
  runGate("strict contract typecheck", ["strict-contract-typecheck"], report);
  runGate("static misuse check", ["static-misuse:check"], report);
  runGate(
    "generated template oxlint",
    ["exec", "oxlint", "packages/create-croco-app/templates"],
    report,
  );
  runGate("generated secret placeholder policy", ["generated-secret-placeholders:check"], report);
}

function runGate(label: string, args: readonly string[], report: GeneratedSmokeReport): void {
  runContinuingGateCommand(
    report,
    label,
    corepackCommand,
    ["pnpm", ...args],
    rootDir,
    "ecosystem-advisory",
  );
}

function createGeneratedSmokeReport(
  cases: readonly SmokeCase[],
  isFilteredRun: boolean,
  selectedTier: SmokeMatrixTier | undefined,
  requestedCaseNames: readonly string[],
): GeneratedSmokeReport {
  const tiers = ["spine-blocking", "ecosystem-advisory"] as const;
  return {
    schemaVersion: "croco.generated-app-smoke/v2",
    generatedAt: new Date().toISOString(),
    filteredRun: isFilteredRun,
    requestedCaseNames,
    selectedTier,
    status: "pending",
    release: { blockingTier: "spine-blocking", status: "pending" },
    tiers: tiers.map((tier) => ({ tier, status: "pending" })),
    matrix: {
      coverage: readSmokeCoverage(cases),
      templateTargets: readTemplateMatrixTargets(cases),
      templateExclusions: readTemplateMatrixExclusions(),
    },
    gates: [],
    cases: cases.map((smokeCase) => ({
      name: smokeCase.name,
      tier: smokeCase.tier,
      advisory: smokeCase.advisory,
      preset: readSmokeCasePreset(smokeCase),
      runtimeTarget: smokeCase.runtimeTarget,
      matrixTargets: smokeCase.matrixTargets,
      args: smokeCase.args,
      recovery: createSmokeRecoverySummary(smokeCase.name),
      status: "pending",
      steps: [],
    })),
  };
}

function writeGeneratedSmokeReport(report: GeneratedSmokeReport): void {
  mkdirSync(generatedSmokeReportDir, { recursive: true });
  refreshGeneratedSmokeReportStatus(report);

  const tiersToWrite = report.selectedTier
    ? [report.selectedTier]
    : (["spine-blocking", "ecosystem-advisory"] as const);
  for (const tier of tiersToWrite) {
    const tierReport = createGeneratedSmokeMatrixTierReport(
      tier,
      report.cases
        .filter((smokeCase) => smokeCase.tier === tier)
        .map((smokeCase) => ({
          name: smokeCase.name,
          status: smokeCase.status,
          failureEvidence: createSmokeMatrixCaseFailureEvidence(smokeCase),
        })),
      {
        filteredRun: report.filteredRun,
        previousReport: readGeneratedSmokeMatrixReport(
          join(generatedSmokeReportDir, `${tier}-matrix.json`),
        ),
        generatedAt: report.generatedAt,
        failure: createGeneratedSmokeMatrixFailure(tier, report.failure, report.failureTier),
      },
    );
    writeFileSync(
      join(generatedSmokeReportDir, `${tier}-matrix.json`),
      `${JSON.stringify(tierReport, null, 2)}\n`,
    );
    writeFileSync(
      join(generatedSmokeReportDir, `${tier}-matrix.md`),
      renderGeneratedSmokeMatrixReport(tierReport),
    );
  }

  const aggregate = createGeneratedSmokeMatrixAggregateReport(
    {
      "spine-blocking": readGeneratedSmokeMatrixReport(
        join(generatedSmokeReportDir, "spine-blocking-matrix.json"),
      ),
      "ecosystem-advisory": readGeneratedSmokeMatrixReport(
        join(generatedSmokeReportDir, "ecosystem-advisory-matrix.json"),
      ),
    },
    report.generatedAt,
  );
  writeFileSync(
    join(generatedSmokeReportDir, "matrix.json"),
    `${JSON.stringify(aggregate, null, 2)}\n`,
  );
  writeFileSync(
    join(generatedSmokeReportDir, "matrix.md"),
    renderGeneratedSmokeMatrixReport(aggregate),
  );

  writeCanonicalGeneratedSmokeJourneyBundle({
    selection: {
      selectedCaseNames: report.cases.map(({ name }) => name),
      spineCaseNames: spineSmokeCaseNames,
      selectedTier: report.selectedTier,
      requestedCaseNames: report.requestedCaseNames,
    },
    outputDir: join(generatedSmokeReportDir, "spine-blocking-journeys"),
    createReport: () =>
      createGeneratedSmokeJourneyReport(
        report,
        selectableSmokeCases.map(({ name }) => name),
        undefined,
        toPosixPath(relative(rootDir, generatedSmokeReportDir)),
      ),
    sourceRootDir: generatedSmokeReportDir,
  });
}

function readGeneratedSmokeMatrixReport(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function createGeneratedSmokeMatrixFailure(
  tier: SmokeMatrixTier,
  message: string | undefined,
  failureTier: SmokeMatrixTier | undefined,
): SmokeMatrixFailure | undefined {
  if (!message || failureTier !== tier) {
    return undefined;
  }

  if (tier === "spine-blocking") {
    return {
      message,
      owner: "create-croco-app release spine owner",
      recoveryAction:
        "pnpm create-croco-app:smoke -- --tier spine-blocking; repair the reported bootstrap or spine smoke failure.",
    };
  }

  return {
    message,
    owner: "create-croco-app ecosystem smoke owner",
    recoveryAction:
      "pnpm create-croco-app:smoke -- --tier ecosystem-advisory; repair the reported advisory gate or smoke failure.",
  };
}

function createSmokeMatrixCaseFailureEvidence(
  smokeCase: SmokeCaseResult,
): SmokeMatrixCaseFailureEvidence | undefined {
  if (!smokeCase.error || !smokeCase.failureClassification) {
    return undefined;
  }

  return {
    error: smokeCase.error,
    diagnosticCodes: [
      ...new Set(
        smokeCase.steps
          .filter((step) => step.status === "failed")
          .flatMap((step) => step.diagnosticCodes),
      ),
    ].sort(),
    recovery: smokeCase.recovery,
    classification: smokeCase.failureClassification,
    artifactBundle: smokeCase.artifactBundle,
  };
}

function refreshGeneratedSmokeReportStatus(report: GeneratedSmokeReport): void {
  for (const tier of report.tiers) {
    const statuses = report.cases
      .filter((smokeCase) => smokeCase.tier === tier.tier)
      .map(({ status }) => status);
    tier.status = summarizeSmokeStatuses(statuses);
  }
  report.release.status =
    report.tiers.find(({ tier }) => tier === "spine-blocking")?.status ?? "pending";
  report.status = summarizeSmokeStatuses([
    ...report.tiers.map(({ status }) => status),
    ...report.gates.map(({ status }) => status),
  ]);
}

function summarizeSmokeStatuses(statuses: readonly SmokeStepStatus[]): SmokeStepStatus {
  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }
  if (statuses.length === 0 || statuses.some((status) => status === "pending")) {
    return "pending";
  }
  return "passed";
}

function readTemplateMatrixTargets(cases: readonly SmokeCase[]): readonly TemplateMatrixTarget[] {
  const targetCases = new Map<string, string[]>();

  for (const smokeCase of cases) {
    for (const target of smokeCase.matrixTargets) {
      const caseNames = targetCases.get(target) ?? [];
      caseNames.push(smokeCase.name);
      targetCases.set(target, caseNames);
    }
  }

  return [...targetCases.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([template, caseNames]) => ({
      template,
      cases: caseNames.sort((left, right) => left.localeCompare(right)),
    }));
}

function readTemplateMatrixExclusions(): readonly TemplateMatrixExclusion[] {
  return [];
}

function assertTemplateMatrixAccountability(cases: readonly SmokeCase[]): void {
  const coveredTemplates = new Set(cases.flatMap(({ matrixTargets }) => matrixTargets));
  const topLevelTemplateDirectories = readdirSync(generatedAppTemplatesDir, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory() && entry.name !== "addons")
    .map((entry) => entry.name)
    .sort();

  const missingTemplates = topLevelTemplateDirectories.filter(
    (template) => !coveredTemplates.has(template),
  );
  if (missingTemplates.length > 0) {
    throw new Error(
      `create-croco-app generated smoke matrix is missing template accountability entries: ${missingTemplates.join(", ")}`,
    );
  }

  const knownTemplates = new Set(topLevelTemplateDirectories);
  const unknownTargets = [...coveredTemplates].filter((template) => !knownTemplates.has(template));
  if (unknownTargets.length > 0) {
    throw new Error(
      `create-croco-app generated smoke matrix references unknown template directories: ${unknownTargets.join(", ")}`,
    );
  }
}

function assertGraphQLSmokeContractCoverage(cases: readonly SmokeCase[]): void {
  const missingCoverage: string[] = [];

  for (const smokeCase of cases) {
    const packagePath = readGraphQLContractPackagePath(smokeCase);
    if (!packagePath) continue;

    const checkIndex = smokeCase.validations.findIndex((validation) =>
      isPackageValidation(validation, packagePath, GRAPHQL_CONTRACT_CHECK_LABEL, [
        "contract:check",
      ]),
    );
    const snapshotIndex = smokeCase.validations.findIndex(
      (validation) =>
        isPackageValidation(validation, packagePath, GRAPHQL_CONTRACT_SNAPSHOT_LABEL, [
          "contract:snapshot",
        ]) && validation.paths?.includes(GRAPHQL_CONTRACT_SNAPSHOT_PATH),
    );

    if (checkIndex === -1 || snapshotIndex === -1 || checkIndex > snapshotIndex) {
      missingCoverage.push(
        `${smokeCase.name} (${packagePath.join("/")} requires ${GRAPHQL_CONTRACT_CHECK_LABEL} before ${GRAPHQL_CONTRACT_SNAPSHOT_LABEL})`,
      );
    }
  }

  if (missingCoverage.length > 0) {
    throw new Error(
      `create-croco-app generated GraphQL smoke cases are missing contract coverage: ${missingCoverage.join(", ")}`,
    );
  }
}

function isPackageValidation(
  validation: SmokeValidation,
  packagePath: readonly string[],
  label: string,
  args: readonly string[],
): boolean {
  return (
    validation.label === label &&
    samePath(validation.packagePath, packagePath) &&
    sameArgs(validation.args, args)
  );
}

function samePath(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return Boolean(
    left && left.length === right.length && left.every((part, index) => part === right[index]),
  );
}

function sameArgs(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return Boolean(
    left && left.length === right.length && left.every((part, index) => part === right[index]),
  );
}

function getSmokeCaseResult(report: GeneratedSmokeReport, caseName: string): SmokeCaseResult {
  const result = report.cases.find(({ name }) => name === caseName);
  if (!result) {
    throw new Error(`Missing generated smoke report entry for ${caseName}`);
  }
  return result;
}

function runGateCommand(
  report: GeneratedSmokeReport,
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
  tier: SmokeMatrixTier,
): void {
  const result: SmokeGateResult = {
    label,
    command: formatCommand(command, args, cwd),
    tier,
    status: "pending",
  };
  report.gates.push(result);
  writeGeneratedSmokeReport(report);

  try {
    run(command, args, cwd);
    result.status = "passed";
    writeGeneratedSmokeReport(report);
  } catch (error) {
    result.status = "failed";
    result.error = toErrorMessage(error);
    report.status = "failed";
    report.failure = result.error;
    report.failureTier ??= tier;
    writeGeneratedSmokeReport(report);
    throw error;
  }
}

function runContinuingGateCommand(
  report: GeneratedSmokeReport,
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
  tier: SmokeMatrixTier,
): boolean {
  try {
    runGateCommand(report, label, command, args, cwd, tier);
    console.log(`create-croco-app-generated-smoke: ${label} passed`);
    return true;
  } catch (error) {
    console.error(`create-croco-app-generated-smoke: ${label} failed: ${toErrorMessage(error)}`);
    return false;
  }
}

function runSmokeCaseCommand(
  report: GeneratedSmokeReport,
  caseResult: SmokeCaseResult,
  projectDir: string,
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): void {
  const step = createSmokeStep(label, {
    command: formatCommand(command, args, cwd),
  });
  caseResult.steps.push(step);
  writeGeneratedSmokeReport(report);

  try {
    const commandEnv: Record<string, string> = {
      PLAYWRIGHT_BROWSERS_PATH: RESOLVED_PLAYWRIGHT_BROWSERS_PATH,
      ...env,
    };
    appendSmokeCaseOutput(caseResult, label, run(command, args, cwd, commandEnv));
    step.status = "passed";
    writeGeneratedSmokeReport(report);
  } catch (error) {
    const commandResult = getCommandResultFromError(error);
    if (commandResult) {
      appendSmokeCaseOutput(caseResult, label, commandResult);
    }
    recordSmokeCaseFailure(report, caseResult, step, error, projectDir);
    throw createSmokeFailureError(caseResult, step, error);
  }
}

function runExpectedSmokeCaseCommand(
  report: GeneratedSmokeReport,
  caseResult: SmokeCaseResult,
  projectDir: string,
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
  expectedOutput: readonly string[],
): void {
  const step = createSmokeStep(label, {
    command: formatCommand(command, args, cwd),
    expectFailure: true,
  });
  caseResult.steps.push(step);
  writeGeneratedSmokeReport(report);

  try {
    const commandResult = runExpectFailure(command, args, cwd, expectedOutput);
    appendSmokeCaseOutput(caseResult, label, commandResult);
    step.diagnosticCodes = commandResult.diagnosticCodes;
    step.status = "passed";
    writeGeneratedSmokeReport(report);
  } catch (error) {
    const commandResult = getCommandResultFromError(error);
    if (commandResult) {
      appendSmokeCaseOutput(caseResult, label, commandResult);
    }
    recordSmokeCaseFailure(report, caseResult, step, error, projectDir);
    throw createSmokeFailureError(caseResult, step, error);
  }
}

function createSmokeStep(
  label: string,
  options: {
    readonly command?: string;
    readonly packagePath?: readonly string[];
    readonly paths?: readonly string[];
    readonly jsonPath?: string;
    readonly expectFailure?: boolean;
  } = {},
): SmokeStepResult {
  return {
    label,
    command: options.command,
    packagePath: options.packagePath,
    paths: options.paths,
    jsonPath: options.jsonPath,
    artifacts: [],
    expectFailure: options.expectFailure,
    status: "pending",
    diagnosticCodes: [],
    executedTestPaths: [],
  };
}

function recordSmokeCaseFailure(
  report: GeneratedSmokeReport,
  caseResult: SmokeCaseResult,
  step: SmokeStepResult,
  error: unknown,
  projectDir: string,
): void {
  step.status = "failed";
  step.error = toErrorMessage(error);
  const commandResult = getCommandResultFromError(error);
  step.diagnosticCodes = commandResult
    ? extractSmokeCommandDiagnosticCodes({
        message: step.error,
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
        signal: commandResult.signal,
      })
    : extractDiagnosticCodes(step.error);
  caseResult.status = "failed";
  caseResult.error = step.error;
  report.status = "failed";
  report.failure = createSmokeFailureMessage(caseResult, step, error);
  report.failureTier ??= caseResult.tier;
  caseResult.artifactBundle = persistSmokeCaseFailureArtifacts(caseResult, projectDir);
  caseResult.failureClassification = commandResult
    ? classifySmokeCommandFailure({
        message: step.error,
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
        signal: commandResult.signal,
      })
    : classifySmokeFailure({ message: step.error });
  writeGeneratedSmokeReport(report);
}

function appendSmokeCaseOutput(
  caseResult: SmokeCaseResult,
  label: string,
  result: CommandRunResult,
): void {
  const output = smokeCaseOutputBuffers.get(caseResult.name) ?? {
    stdout: [],
    stderr: [],
    outputTruncated: false,
  };
  const prefix = `[${label}]\n`;
  let remainingBytes = commandCaptureMaxBytes - getSmokeCaseOutputSize(output);
  const stdoutTruncated = result.stdout
    ? appendCappedSmokeCaseOutput(output.stdout, `${prefix}${result.stdout}`, remainingBytes)
    : false;
  remainingBytes = commandCaptureMaxBytes - getSmokeCaseOutputSize(output);
  const stderrTruncated = result.stderr
    ? appendCappedSmokeCaseOutput(output.stderr, `${prefix}${result.stderr}`, remainingBytes)
    : false;
  output.outputTruncated ||= result.outputTruncated || stdoutTruncated || stderrTruncated;
  smokeCaseOutputBuffers.set(caseResult.name, output);
}

function getSmokeCaseOutputSize(output: {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}): number {
  return [...output.stdout, ...output.stderr].reduce(
    (size, value) => size + Buffer.byteLength(value),
    0,
  );
}

function appendCappedSmokeCaseOutput(output: string[], value: string, maxBytes: number): boolean {
  if (value.length === 0) {
    return false;
  }

  const cappedValue = takeUtf8Prefix(value, Math.max(maxBytes, 0));
  if (cappedValue.value.length > 0) {
    output.push(cappedValue.value);
  }
  return cappedValue.truncated;
}

function takeUtf8Prefix(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) {
    return { value, truncated: false };
  }

  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    end += character.length;
  }
  return { value: value.slice(0, end), truncated: true };
}

function persistSmokeCaseFailureArtifacts(
  caseResult: SmokeCaseResult,
  projectDir: string,
): SmokeCaseArtifactBundle {
  const artifactDir = join(generatedSmokeReportDir, "cases", caseResult.name);
  const filesDir = join(artifactDir, "files");
  const output = smokeCaseOutputBuffers.get(caseResult.name) ?? {
    stdout: [],
    stderr: [],
    outputTruncated: false,
  };
  rmSync(artifactDir, { force: true, recursive: true });
  mkdirSync(filesDir, { recursive: true });
  const stdoutPath = join(artifactDir, "stdout.log");
  const stderrPath = join(artifactDir, "stderr.log");
  writeFileSync(stdoutPath, output.stdout.join(""));
  writeFileSync(stderrPath, output.stderr.join(""));

  const files = existsSync(projectDir)
    ? collectSmokeFailureArtifactFiles(projectDir, caseResult.name).map((sourcePath) => {
        const relativePath = relative(projectDir, sourcePath);
        const targetPath = join(filesDir, relativePath);
        mkdirSync(dirname(targetPath), { recursive: true });
        copyFileSync(sourcePath, targetPath);
        return toReportArtifactPath(targetPath);
      })
    : [];

  return {
    path: toReportArtifactPath(artifactDir),
    stdoutPath: toReportArtifactPath(stdoutPath),
    stderrPath: toReportArtifactPath(stderrPath),
    files,
    outputTruncated: output.outputTruncated,
  };
}

function toReportArtifactPath(path: string): string {
  const relativePath = relative(rootDir, path);
  return relativePath.startsWith("..") ? toPosixPath(path) : toPosixPath(relativePath);
}

function createSmokeFailureError(
  caseResult: SmokeCaseResult,
  step: SmokeStepResult,
  error: unknown,
): Error {
  return new Error(createSmokeFailureMessage(caseResult, step, error), {
    cause: error,
  });
}

function recordUnhandledSmokeCaseFailure(
  report: GeneratedSmokeReport,
  caseResult: SmokeCaseResult,
  projectDir: string,
  error: unknown,
): void {
  if (caseResult.status === "failed") {
    return;
  }

  const commandResult = getCommandResultFromError(error);
  if (commandResult) {
    appendSmokeCaseOutput(caseResult, "case setup or assertion", commandResult);
  }
  const step = createSmokeStep("case setup or assertion");
  caseResult.steps.push(step);
  recordSmokeCaseFailure(report, caseResult, step, error, projectDir);
}

function createSmokeFailureMessage(
  caseResult: SmokeCaseResult,
  step: SmokeStepResult,
  error: unknown,
): string {
  const diagnosticCodes =
    step.diagnosticCodes.length > 0 ? step.diagnosticCodes.join(", ") : "none";
  return [
    `Generated app smoke failed for ${caseResult.name}.`,
    `preset=${caseResult.preset}`,
    `runtimeTarget=${caseResult.runtimeTarget}`,
    `step=${step.label}`,
    `command=${step.command ?? "n/a"}`,
    `diagnosticCodes=${diagnosticCodes}`,
    `error=${toErrorMessage(error)}`,
  ].join(" ");
}

function formatCommand(command: string, args: readonly string[], cwd: string): string {
  const relativeCwd = cwd.startsWith(rootDir) ? cwd.slice(rootDir.length + 1) || "." : cwd;
  return `(cd ${relativeCwd} && ${[command, ...args].join(" ")})`;
}

function readSmokeCasePreset(smokeCase: SmokeCase): string {
  if (smokeCase.name === REST_SPA_CONTRACT_SMOKE_CASE_NAME) {
    return "contract:spa-be-split";
  }

  const preset = readFlagValue(smokeCase.args, "--preset");
  if (preset) {
    return preset;
  }

  const goal = readFlagValue(smokeCase.args, "--goal");
  return goal ? `goal:${goal}` : "unknown";
}

type RuntimeCompositionSmokeProfile =
  | "saas-node"
  | "saas-lambda"
  | "saas-cloudflare"
  | "node-application"
  | "cloudflare-workers-workspace"
  | "graphql-node-application"
  | "graphql-lambda";

function runtimeCapabilityManifestValidation(
  profile: RuntimeCompositionSmokeProfile,
): SmokeValidation {
  const compositionByProfile = {
    "saas-node": {
      platform: "node",
      host: { platform: "node", lifecycle: "process", packageName: "@croco/preset-node" },
      transports: [{ protocol: "http", packageName: "@croco/transports-http" }],
      buildTarget: {
        name: "node-application",
        format: "dual",
        outputDirectory: "apps/api-server/dist",
      },
    },
    "saas-lambda": {
      platform: "lambda",
      host: { platform: "lambda", lifecycle: "invocation", packageName: "@croco/preset-lambda" },
      transports: [{ protocol: "http", packageName: "@croco/transports-http" }],
      buildTarget: {
        name: "lambda-function",
        format: "cjs",
        outputDirectory: "apps/api-server/dist",
      },
    },
    "saas-cloudflare": {
      platform: "cloudflare-workers",
      host: {
        platform: "cloudflare-workers",
        lifecycle: "fetch",
        packageName: "@croco/preset-cloudflare",
      },
      transports: [{ protocol: "http", packageName: "@croco/transports-http" }],
      buildTarget: {
        name: "cloudflare-worker",
        format: "esm",
        outputDirectory: "apps/api-server/dist",
        constraints: ["no-node-builtins", "web-standard-apis"],
      },
    },
    "node-application": {
      platform: "node",
      host: { platform: "node", lifecycle: "process" },
      transports: [{ protocol: "http", packageName: "@croco/transports-http" }],
      buildTarget: {
        name: "node-application",
        format: "cjs",
        outputDirectory: "apps/api-server/dist",
      },
    },
    "cloudflare-workers-workspace": {
      platform: "cloudflare-workers",
      host: {
        platform: "cloudflare-workers",
        lifecycle: "fetch",
        packageName: "@croco/preset-cloudflare",
      },
      transports: [{ protocol: "http", packageName: "@croco/transports-http" }],
      buildTarget: {
        name: "cloudflare-workers-workspace",
        format: "esm",
        constraints: ["no-node-builtins", "web-standard-apis"],
      },
    },
    "graphql-node-application": {
      platform: "node",
      host: { platform: "node", lifecycle: "process", packageName: "@apollo/server" },
      transports: [{ protocol: "graphql", packageName: "@apollo/server" }],
      buildTarget: {
        name: "node-application",
        format: "cjs",
        outputDirectory: "apps/graphql-api/dist",
      },
    },
    "graphql-lambda": {
      platform: "lambda",
      host: {
        platform: "lambda",
        lifecycle: "invocation",
        packageName: "@as-integrations/aws-lambda",
      },
      transports: [{ protocol: "graphql", packageName: "@apollo/server" }],
      buildTarget: {
        name: "lambda-function",
        format: "cjs",
        outputDirectory: "apps/graphql-api/dist",
      },
    },
  } as const satisfies Record<
    RuntimeCompositionSmokeProfile,
    {
      platform: RuntimeCapabilitySmokePlatform;
      host: Record<string, string>;
      transports: readonly Record<string, string>[];
      buildTarget: Record<string, string | readonly string[]>;
    }
  >;
  const composition = compositionByProfile[profile];

  return {
    label: "runtime capability manifest",
    json: {
      path: "croco-runtime-capability.manifest.json",
      matches: {
        version: "croco.runtime-capability.manifest.v1",
        platform: composition.platform,
        composition: {
          host: composition.host,
          transports: composition.transports,
          buildTarget: composition.buildTarget,
        },
        capabilities: runtimeCapabilitySmokeSupport[composition.platform],
        diagnostics: [],
      },
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractDiagnosticCodes(output: string): readonly string[] {
  return [
    ...new Set(output.match(/\b(?:CROCO_[A-Z0-9_]+|[a-z0-9-]+\/[a-z0-9-]+)\b/g) ?? []),
  ].sort();
}

function assertExists(path: string, message: string): void {
  if (!existsSync(path)) {
    throw new Error(message);
  }
}

function assertMissing(path: string, message: string): void {
  if (existsSync(path)) {
    throw new Error(message);
  }
}

function assertGeneratedReadme(projectDir: string, smokeCase: SmokeCase): void {
  const readmePath = join(projectDir, "README.md");
  assertExists(readmePath, `${smokeCase.name} did not generate README.md`);

  const readme = readFileSync(readmePath, "utf8");
  if (readme.includes("{{") || readme.includes("}}")) {
    throw new Error(`${smokeCase.name} generated README.md with unresolved template placeholders`);
  }

  console.log(`create-croco-app-generated-smoke: ${smokeCase.name} README.md exists`);
}

function assertGeneratedNodeRuntimeContract(projectDir: string, smokeCase: SmokeCase): void {
  const packageJson = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as {
    engines?: { node?: unknown };
  };
  const nvmrc = readFileSync(join(projectDir, ".nvmrc"), "utf8");
  const readme = readFileSync(join(projectDir, "README.md"), "utf8");
  const expectedEngineRange = smokeCase.matrixTargets.includes("saas")
    ? SAAS_GENERATED_NODE_ENGINE_RANGE
    : GENERATED_NODE_ENGINE_RANGE;
  const expectedNodeVersion = smokeCase.matrixTargets.includes("saas")
    ? SAAS_GENERATED_NODE_VERSION
    : GENERATED_NODE_VERSION;

  if (packageJson.engines?.node !== expectedEngineRange) {
    throw new Error(
      `${smokeCase.name} generated package.json engines.node=${String(packageJson.engines?.node)}; expected ${expectedEngineRange}`,
    );
  }
  if (nvmrc !== `${expectedNodeVersion}\n`) {
    throw new Error(
      `${smokeCase.name} generated .nvmrc=${JSON.stringify(nvmrc)}; expected ${expectedNodeVersion}`,
    );
  }
  if (!readme.includes(`Node.js ${expectedEngineRange}`) || !readme.includes("nvm use")) {
    throw new Error(
      `${smokeCase.name} generated README.md is missing Node version recovery guidance`,
    );
  }
  if (
    smokeCase.runtimeTarget.includes("browser") ||
    smokeCase.runtimeTarget.includes("cloudflare-workers")
  ) {
    if (!readme.includes("does not change the deployment runtime")) {
      throw new Error(
        `${smokeCase.name} generated README.md falsely conflates Node build tooling with its ${smokeCase.runtimeTarget} deployment runtime`,
      );
    }
  }

  console.log(
    `create-croco-app-generated-smoke: ${smokeCase.name} Node runtime contract matches ${expectedEngineRange}`,
  );
}

function assertNoGeneratedSecurityValidationOptOut(projectDir: string, smokeCase: SmokeCase): void {
  const unsafeFiles = collectGeneratedSecurityValidationScanFiles(projectDir)
    .filter((filePath) =>
      unsafeSecurityValidationPatterns.some((pattern) =>
        pattern.test(readFileSync(filePath, "utf8")),
      ),
    )
    .map((filePath) => relative(projectDir, filePath));

  if (unsafeFiles.length > 0) {
    throw new Error(
      `${smokeCase.name} generated files disable HTTP security validation: ${unsafeFiles.join(", ")}`,
    );
  }

  console.log(
    `create-croco-app-generated-smoke: ${smokeCase.name} keeps HTTP security validation enabled`,
  );
}

function assertGeneratedEnvironmentTemplate(projectDir: string, smokeCase: SmokeCase): void {
  const envExamplePath = join(projectDir, ".env.example");

  assertExists(envExamplePath, `${smokeCase.name} did not generate .env.example`);

  const generatedEnvironmentFiles = collectDisallowedGeneratedDotenvFiles(projectDir);

  if (generatedEnvironmentFiles.length > 0) {
    throw new Error(
      `${smokeCase.name} generated dotenv files other than .env.example: ${generatedEnvironmentFiles.join(", ")}`,
    );
  }

  const activeAssignments = readFileSync(envExamplePath, "utf8")
    .split(/\r?\n/)
    .filter(isActiveDotenvAssignment);

  if (activeAssignments.length > 0) {
    throw new Error(
      `${smokeCase.name} generated active .env.example assignments: ${activeAssignments.join(", ")}`,
    );
  }

  console.log(
    `create-croco-app-generated-smoke: ${smokeCase.name} generated a commented .env.example only`,
  );
}

export function isDotenvFileName(fileName: string): boolean {
  return fileName === ".env" || fileName.startsWith(".env.");
}

export function isActiveDotenvAssignment(line: string): boolean {
  return /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line);
}

export function collectDisallowedGeneratedDotenvFiles(projectDir: string): string[] {
  return collectGeneratedSecurityValidationScanFiles(projectDir)
    .filter((filePath) => {
      const fileName = basename(filePath);
      return fileName !== ".env.example" && isDotenvFileName(fileName);
    })
    .map((filePath) => toPosixPath(relative(projectDir, filePath)))
    .sort();
}

function assertNoGeneratedCredentialLookingValues(projectDir: string, smokeCase: SmokeCase): void {
  const metadata = readGeneratedSmokeAllowlistMetadata(
    join(rootDir, "scripts", "security-allowlist-metadata.json"),
    smokeCase.name,
  );
  const allowlistRead = readGeneratedTemplateSecretAllowlistsFromMetadata(
    metadata,
    new Date().toISOString().slice(0, 10),
  );

  if (allowlistRead.violations.length > 0) {
    throw new Error(
      [
        `${smokeCase.name} generated secret allowlist metadata is invalid`,
        ...allowlistRead.violations.map(
          (violation) => `- ${violation.message} Recovery: ${violation.recovery}`,
        ),
      ].join("\n"),
    );
  }

  const findings = collectGeneratedSecurityValidationScanFiles(projectDir).flatMap((filePath) =>
    scanGeneratedTemplateSecretText(
      relative(projectDir, filePath).replace(/\\/g, "/"),
      readFileSync(filePath, "utf8"),
      allowlistRead.allowlists,
    ),
  );

  if (findings.length > 0) {
    throw new Error(
      [
        `${smokeCase.name} generated files contain credential-shaped values`,
        ...findings.map(
          (finding) =>
            `- ${finding.filePath}:${finding.line} ${finding.patternId} ${finding.match}`,
        ),
      ].join("\n"),
    );
  }

  console.log(
    `create-croco-app-generated-smoke: ${smokeCase.name} generated secret placeholders are safe`,
  );
}

export function readGeneratedSmokeAllowlistMetadata(
  metadataPath: string,
  smokeCaseName: string,
): unknown {
  try {
    return JSON.parse(readFileSync(metadataPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `${smokeCaseName} generated secret allowlist metadata is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function collectGeneratedSecurityValidationScanFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      return securityValidationScanIgnoredDirectories.has(entry.name)
        ? []
        : collectGeneratedSecurityValidationScanFiles(entryPath);
    }

    return securityValidationScanFileExtensions.has(extname(entry.name)) ||
      isDotenvFileName(entry.name)
      ? [entryPath]
      : [];
  });
}

function runValidation(
  projectDir: string,
  smokeCase: SmokeCase,
  validation: SmokeValidation,
  report: GeneratedSmokeReport,
  caseResult: SmokeCaseResult,
): void {
  const validationDir = validation.packagePath
    ? join(projectDir, ...validation.packagePath)
    : projectDir;
  const step = createSmokeStep(validation.label, {
    command: validation.args
      ? formatCommand(
          corepackCommand,
          ["pnpm", "--dir", validationDir, ...validation.args],
          rootDir,
        )
      : undefined,
    packagePath: validation.packagePath,
    paths: validation.paths,
    jsonPath: validation.json?.path,
    expectFailure: validation.expectFailure !== undefined,
  });
  caseResult.steps.push(step);
  writeGeneratedSmokeReport(report);
  let unitCapture: GeneratedUnitEvidenceCapture | undefined;
  const journeyReportDirectory =
    validation.label === "browser journeys"
      ? mkdtempSync(join(tmpdir(), "croco-generated-journey-evidence-"))
      : undefined;
  const journeyReportPath = journeyReportDirectory
    ? join(journeyReportDirectory, "playwright.json")
    : undefined;

  try {
    unitCapture =
      validation.label === "test" ? prepareGeneratedUnitEvidenceCapture(projectDir) : undefined;
    if (validation.args) {
      if (validation.expectFailure) {
        const commandResult = runExpectFailure(
          corepackCommand,
          ["pnpm", "--dir", validationDir, ...validation.args],
          rootDir,
          validation.expectFailure.outputIncludes,
          validation.env,
        );
        appendSmokeCaseOutput(caseResult, validation.label, commandResult);
        step.diagnosticCodes = commandResult.diagnosticCodes;
      } else {
        if (validation.readOnly) ensureGeneratedVerificationBaseline(validationDir);
        const commandArgs = [
          "pnpm",
          "--dir",
          validationDir,
          ...validation.args,
          ...(journeyReportPath ? ["--reporter=json"] : []),
        ];
        const commandEnv: Record<string, string> = {
          PLAYWRIGHT_BROWSERS_PATH: RESOLVED_PLAYWRIGHT_BROWSERS_PATH,
          ...validation.env,
          ...(journeyReportPath ? { PLAYWRIGHT_JSON_OUTPUT_FILE: journeyReportPath } : {}),
        };
        appendSmokeCaseOutput(
          caseResult,
          validation.label,
          validation.readOnly
            ? run(
                process.execPath,
                [
                  "--experimental-strip-types",
                  join(rootDir, "scripts", "tracked-file-mutation-guard.mts"),
                  "--recovery",
                  validation.recovery ?? `Run the explicit writer for ${validation.label}`,
                  "--",
                  corepackCommand,
                  ...commandArgs,
                ],
                validationDir,
                commandEnv,
              )
            : run(corepackCommand, commandArgs, rootDir, commandEnv),
        );
        if (unitCapture) {
          const expected = unitCapture.reports
            .flatMap(({ generatedPaths }) => generatedPaths)
            .sort();
          const executed = [...new Set(readGeneratedUnitEvidence(unitCapture))].sort();
          if (JSON.stringify(executed) !== JSON.stringify(expected)) {
            throw new Error(
              `${smokeCase.name} generated unit tests did not complete exactly: expected ${expected.join(", ")}; executed ${executed.join(", ")}`,
            );
          }
          step.executedTestPaths = executed;
        }
        if (journeyReportPath) {
          const expected = (
            validation.paths
              ? [...validation.paths]
              : testInventory.tests
                  .filter(
                    (entry) =>
                      entry.lane === "generated-app" &&
                      entry.generated?.generatedPath.startsWith("tests/journeys/") &&
                      existsSync(join(projectDir, entry.generated.generatedPath)),
                  )
                  .flatMap((entry) => (entry.generated ? [entry.generated.generatedPath] : []))
          ).sort();
          const executed = existsSync(journeyReportPath)
            ? reconcileGeneratedTestPaths(
                readCompletedPlaywrightPaths(journeyReportPath, projectDir),
                expected,
              )
            : [];
          if (JSON.stringify(executed) !== JSON.stringify(expected)) {
            throw new Error(
              `${smokeCase.name} generated journeys did not complete exactly: expected ${expected.join(", ")}; executed ${executed.join(", ")}`,
            );
          }
          step.executedTestPaths = executed;
        }
      }
    }

    for (const relativePath of validation.paths ?? []) {
      assertExists(
        join(validationDir, relativePath),
        `${smokeCase.name} ${validation.label} did not create ${relativePath}`,
      );
    }

    if (validation.json) {
      assertJsonMatches(
        join(validationDir, validation.json.path),
        validation.json.matches,
        `${smokeCase.name} ${validation.label}`,
        validation.json.arrayMinLengths,
      );
    }

    if (validation.browserWorkflowPolicy) {
      assertGeneratedBrowserWorkflowLeastPrivilege(
        join(validationDir, validation.browserWorkflowPolicy),
      );
    }

    if (validation.presentationProfile) {
      assertGeneratedPresentationProfileMatchesCatalog(
        projectDir,
        validation.presentationProfile.appPath,
        validation.presentationProfile.runtimeProfileName,
        smokeCase.name,
      );
    }

    if (validation.artifacts) {
      step.artifacts = copyGeneratedSmokeArtifacts({
        generatedSmokeReportDir,
        smokeCaseName: smokeCase.name,
        validationDir,
        artifactPaths: validation.artifacts,
      });
    }

    if (
      !validation.args &&
      !validation.paths &&
      !validation.json &&
      !validation.browserWorkflowPolicy &&
      !validation.presentationProfile &&
      !validation.artifacts
    ) {
      throw new Error(`${smokeCase.name} ${validation.label} has no validation action`);
    }

    step.status = "passed";
    writeGeneratedSmokeReport(report);
  } catch (error) {
    const commandResult = getCommandResultFromError(error);
    if (commandResult) {
      appendSmokeCaseOutput(caseResult, validation.label, commandResult);
    }
    recordSmokeCaseFailure(report, caseResult, step, error, projectDir);
    throw createSmokeFailureError(caseResult, step, error);
  } finally {
    unitCapture?.restore();
    if (journeyReportDirectory) {
      rmSync(journeyReportDirectory, { recursive: true, force: true });
    }
  }

  console.log(`create-croco-app-generated-smoke: ${smokeCase.name} ${validation.label} passed`);
}

export function assertGeneratedVerificationValidationsAreReadOnly(
  validations: readonly Pick<SmokeValidation, "args" | "readOnly" | "recovery">[],
): void {
  const violations = validations.filter((validation) => {
    const name = validation.args?.[0];
    return (
      name !== undefined &&
      (name === "contract:verify" || !name.startsWith("contract:")) &&
      /:(?:check|verify)$/.test(name) &&
      (!validation.readOnly || !validation.recovery)
    );
  });
  if (violations.length === 0) return;
  throw new Error(
    `Generated verification validations must be guarded with recovery guidance: ${violations
      .map(({ args }) => args?.[0])
      .join(", ")}`,
  );
}

function ensureGeneratedVerificationBaseline(validationDir: string): void {
  if (existsSync(join(validationDir, ".git"))) return;
  run("git", ["init", "--quiet"], validationDir);
  run("git", ["config", "user.email", "generated-smoke@croco.local"], validationDir);
  run("git", ["config", "user.name", "Croco Generated Smoke"], validationDir);
  run("git", ["add", "-A", "--", ".", ":(exclude)**/node_modules/**"], validationDir);
  run("git", ["commit", "--quiet", "-m", "generated verification baseline"], validationDir);
}

function runGeneratedBrowserContractDriftCanaries(
  projectDir: string,
  smokeCase: SmokeCase,
  report: GeneratedSmokeReport,
  caseResult: SmokeCaseResult,
): void {
  const preset = readFlagValue(smokeCase.args, "--preset");
  if (preset !== "production-app" && preset !== "admin-console") return;

  const clientFile = preset === "admin-console" ? "admin.ts" : "user.ts";
  const canaries = [
    {
      label: "stale Project Map canary",
      path: "croco.project-map.json",
      expectedOutput: ["CROCO_CLI_PROJECT_MAP_009", "Regenerate it with croco project map"],
      mutate: (content: string) => content.replace('"version":', '"staleVersion":'),
    },
    {
      label: "stale OpenAPI canary",
      path: "openapi.json",
      expectedOutput: ["CROCO_OPENAPI_OUTPUT_CHANGED", "OpenAPI output drift detected"],
      mutate: (content: string) => `${content}\n`,
    },
    {
      label: "stale RPC client canary",
      path: `libs/shared/provider-rpc/src/${clientFile}`,
      expectedOutput: ["CROCO_RPC_OUTPUT_CHANGED", "RPC output drift detected"],
      mutate: (content: string) => `${content}\n`,
    },
  ] as const;

  for (const canary of canaries) {
    const artifactPath = join(projectDir, canary.path);
    const original = readFileSync(artifactPath, "utf8");
    const stale = canary.mutate(original);
    if (stale === original) {
      throw new Error(`${smokeCase.name} ${canary.label} could not mutate ${canary.path}`);
    }
    writeFileSync(artifactPath, stale);
    try {
      runExpectedSmokeCaseCommand(
        report,
        caseResult,
        projectDir,
        canary.label,
        corepackCommand,
        ["pnpm", "contract:verify"],
        projectDir,
        canary.expectedOutput,
      );
    } finally {
      writeFileSync(artifactPath, original);
    }
  }
}

type SaasMonetizationCanary = "checkout-only-provider" | "unbound-meter";

export function createSaasMonetizationCanarySource(
  source: string,
  canary: SaasMonetizationCanary,
): string {
  if (canary === "unbound-meter") {
    return source.replace(
      'meterBindings: [{ meterKey: "api_requests", meterId: "polar-api-requests" }]',
      "meterBindings: []",
    );
  }

  return source.replace(
    "usage: { supported: true }",
    'usage: { supported: false, reason: "checkout only" }',
  );
}

function runSaasMonetizationContractCanaries(
  projectDir: string,
  smokeCase: SmokeCase,
  report: GeneratedSmokeReport,
  caseResult: SmokeCaseResult,
): void {
  if (smokeCase.name !== "saas-golden-path") return;

  const contractPath = join(
    projectDir,
    "apps",
    "api-server",
    "src",
    "controllers",
    "monetization.ts",
  );
  const original = readFileSync(contractPath, "utf8");
  const canaries = [
    {
      kind: "unbound-meter" as const,
      label: "unbound billable meter contract canary",
      expectedOutput: ["CROCO_BILLING_METER_UNBOUND"],
    },
    {
      kind: "checkout-only-provider" as const,
      label: "checkout-only usage plan contract canary",
      expectedOutput: ["CROCO_BILLING_PROVIDER_CAPABILITY_MISSING"],
    },
  ];

  for (const canary of canaries) {
    const invalid = createSaasMonetizationCanarySource(original, canary.kind);
    if (invalid === original) {
      throw new Error(`${smokeCase.name} ${canary.label} could not mutate monetization.ts`);
    }
    writeFileSync(contractPath, invalid);
    try {
      runExpectedSmokeCaseCommand(
        report,
        caseResult,
        projectDir,
        canary.label,
        corepackCommand,
        ["pnpm", "contract:verify"],
        projectDir,
        canary.expectedOutput,
      );
    } finally {
      writeFileSync(contractPath, original);
    }
  }
}

function runGraphQLContractDriftCanaries(
  projectDir: string,
  smokeCase: SmokeCase,
  report: GeneratedSmokeReport,
  caseResult: SmokeCaseResult,
): void {
  const packagePath = readGraphQLContractPackagePath(smokeCase);
  if (!packagePath) {
    return;
  }

  const packageDir = join(projectDir, ...packagePath);
  const snapshotPath = join(packageDir, GRAPHQL_CONTRACT_SNAPSHOT_PATH);
  const step = createSmokeStep("GraphQL contract drift canaries", {
    command: formatCommand(
      corepackCommand,
      ["pnpm", "--dir", packageDir, "contract:check"],
      rootDir,
    ),
    packagePath,
    paths: [GRAPHQL_CONTRACT_SNAPSHOT_PATH],
    expectFailure: true,
  });
  caseResult.steps.push(step);
  writeGeneratedSmokeReport(report);

  try {
    assertExists(
      snapshotPath,
      `${smokeCase.name} GraphQL drift canaries require ${GRAPHQL_CONTRACT_SNAPSHOT_PATH}`,
    );
    const originalSnapshot = readFileSync(snapshotPath, "utf8");
    const commandResults: CommandRunResult[] = [];
    for (const canary of [
      {
        mutate: withStaleGraphQLOperationBaseline,
        expectedDiagnosticCodes: ["graphql-operation-removed"],
      },
      {
        mutate: withChangedGraphQLFieldTypeBaseline,
        expectedDiagnosticCodes: ["graphql-schema-breaking-change"],
      },
      {
        mutate: withGraphQLResolverMetadataDriftBaseline,
        expectedDiagnosticCodes: GRAPHQL_RESOLVER_METADATA_DRIFT_CODES,
      },
    ]) {
      const result = runGraphQLSnapshotCanary(
        packageDir,
        snapshotPath,
        originalSnapshot,
        canary.mutate,
        canary.expectedDiagnosticCodes,
      );
      appendSmokeCaseOutput(caseResult, step.label, result);
      commandResults.push(result);
    }
    step.diagnosticCodes = [
      ...new Set(commandResults.flatMap(({ diagnosticCodes }) => diagnosticCodes)),
    ].sort();
    step.status = "passed";
    writeGeneratedSmokeReport(report);
  } catch (error) {
    const commandResult = getCommandResultFromError(error);
    if (commandResult) {
      appendSmokeCaseOutput(caseResult, step.label, commandResult);
    }
    recordSmokeCaseFailure(report, caseResult, step, error, projectDir);
    throw createSmokeFailureError(caseResult, step, error);
  }

  console.log(`create-croco-app-generated-smoke: ${smokeCase.name} GraphQL drift canaries passed`);
}

function runGraphQLSnapshotCanary(
  packageDir: string,
  snapshotPath: string,
  originalSnapshot: string,
  mutate: (snapshot: GraphQLContractSnapshotJson) => GraphQLContractSnapshotJson,
  expectedDiagnosticCodes: readonly string[],
): CommandRunResult {
  const snapshot = parseGraphQLContractSnapshot(originalSnapshot, snapshotPath);
  writeFileSync(snapshotPath, stringifyGraphQLContractSnapshotJson(mutate(snapshot)));

  try {
    const commandResult = runExpectFailure(
      corepackCommand,
      ["pnpm", "--dir", packageDir, "contract:check"],
      rootDir,
      expectedDiagnosticCodes,
    );
    return {
      ...commandResult,
      diagnosticCodes: [...new Set([...commandResult.diagnosticCodes, ...expectedDiagnosticCodes])],
    };
  } finally {
    writeFileSync(snapshotPath, originalSnapshot);
  }
}

function parseGraphQLContractSnapshot(
  content: string,
  snapshotPath: string,
): GraphQLContractSnapshotJson {
  const snapshot = JSON.parse(content) as unknown;

  if (!isGraphQLContractSnapshotJson(snapshot)) {
    throw new Error(`${snapshotPath} is not a Croco GraphQL contract snapshot.`);
  }

  return snapshot;
}

function isGraphQLContractSnapshotJson(value: unknown): value is GraphQLContractSnapshotJson {
  if (!isRecord(value)) {
    return false;
  }
  const snapshot = value as {
    readonly snapshotVersion?: unknown;
    readonly sdl?: unknown;
    readonly operations?: unknown;
    readonly resolvers?: unknown;
    readonly diagnostics?: unknown;
  };

  return (
    snapshot.snapshotVersion === "croco.graphql-contract.snapshot.v2" &&
    typeof snapshot.sdl === "string" &&
    Array.isArray(snapshot.operations) &&
    Array.isArray(snapshot.resolvers) &&
    Array.isArray(snapshot.diagnostics)
  );
}

function stringifyGraphQLContractSnapshotJson(snapshot: GraphQLContractSnapshotJson): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function withStaleGraphQLOperationBaseline(
  snapshot: GraphQLContractSnapshotJson,
): GraphQLContractSnapshotJson {
  const staleOperation: GraphQLContractOperationJson = {
    kind: "query",
    name: "removedHealth",
    type: "String!",
    args: [],
  };

  return {
    ...snapshot,
    operationCount: snapshot.operations.length + 1,
    operations: [...snapshot.operations, staleOperation].sort(compareGraphQLOperations),
  };
}

function withChangedGraphQLFieldTypeBaseline(
  snapshot: GraphQLContractSnapshotJson,
): GraphQLContractSnapshotJson {
  return {
    ...snapshot,
    sdl: snapshot.sdl.replace("health: String!", "health: Int!"),
    operations: snapshot.operations.map((operation) =>
      operation.kind === "query" && operation.name === "health"
        ? { ...operation, type: "Int!" }
        : operation,
    ),
  };
}

function withGraphQLResolverMetadataDriftBaseline(
  snapshot: GraphQLContractSnapshotJson,
): GraphQLContractSnapshotJson {
  const [resolver] = snapshot.resolvers;
  const [method] = resolver?.methods ?? [];
  if (!resolver || !method) {
    throw new Error("GraphQL resolver metadata canary requires at least one resolver method.");
  }

  return {
    ...snapshot,
    resolvers: [
      {
        ...resolver,
        diScope: "request",
        methods: [
          {
            ...method,
            guards: ["CanaryGuard"],
            interceptors: ["CanaryInterceptor"],
            roles: ["admin"],
            problems: [
              {
                code: "GRAPHQL_HEALTH_UNAVAILABLE",
                category: "InternalServerError",
                status: 500,
              },
            ],
          },
          ...resolver.methods.slice(1),
        ],
      },
      ...snapshot.resolvers.slice(1),
    ],
  };
}

function compareGraphQLOperations(
  left: GraphQLContractOperationJson,
  right: GraphQLContractOperationJson,
): number {
  return `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`);
}

function assertSmokeCoverage(cases: readonly SmokeCase[]): void {
  const coverage = readSmokeCoverage(cases);

  assertCovers("goals", SUPPORTED_CREATE_CROCO_APP_CHOICES.goals, coverage.goals);
  assertCovers("presets", SUPPORTED_CREATE_CROCO_APP_CHOICES.presets, coverage.presets);
  assertCovers("apis", SUPPORTED_CREATE_CROCO_APP_CHOICES.apis, coverage.apis);
  assertCovers("api-hosting", SUPPORTED_CREATE_CROCO_APP_CHOICES.apiHosting, coverage.apiHosting);
  assertCovers(
    "backend-deploy",
    SUPPORTED_CREATE_CROCO_APP_CHOICES.backendDeploys,
    coverage.backendDeploys,
  );
  assertCovers(
    "frontend-deploy",
    SUPPORTED_CREATE_CROCO_APP_CHOICES.frontendDeploys,
    coverage.frontendDeploys,
  );
  assertCovers("ui", SUPPORTED_CREATE_CROCO_APP_CHOICES.uiProfiles, coverage.uiProfiles);
  assertCovers("db", SUPPORTED_CREATE_CROCO_APP_CHOICES.databases, coverage.databases);
  assertCovers(
    "saas-profile",
    SUPPORTED_CREATE_CROCO_APP_CHOICES.saasProviderProfiles,
    coverage.saasProviderProfiles,
  );
  assertCovers(
    "tenant-model",
    SUPPORTED_CREATE_CROCO_APP_CHOICES.tenantModels,
    coverage.tenantModels,
  );
  assertCovers(
    "runtime capability manifest",
    runtimeCapabilitySmokePlatforms,
    coverage.runtimeCapabilityManifests,
  );
}

function printSmokeCoverageSummary(cases: readonly SmokeCase[]): void {
  const coverage = readSmokeCoverage(cases);
  const templateTargets = readTemplateMatrixTargets(cases);
  const templateExclusions = readTemplateMatrixExclusions();

  console.log(
    `create-croco-app-generated-smoke: matrix cases ${cases.map(({ name }) => name).join(", ")}`,
  );
  console.log(
    `create-croco-app-generated-smoke: matrix covers goals=${coverage.goals.join(", ")}; presets=${coverage.presets.join(", ")}; apis=${coverage.apis.join(", ")}; api-hosting=${coverage.apiHosting.join(", ")}; backend-deploy=${coverage.backendDeploys.join(", ")}; frontend-deploy=${coverage.frontendDeploys.join(", ")}; ui=${coverage.uiProfiles.join(", ")}; db=${coverage.databases.join(", ")}; saas-profile=${coverage.saasProviderProfiles.join(", ")}; tenant-model=${coverage.tenantModels.join(", ")}`,
  );
  console.log(
    `create-croco-app-generated-smoke: runtime capability manifests ${coverage.runtimeCapabilityManifests.join(", ")}`,
  );
  console.log(
    `create-croco-app-generated-smoke: template targets ${templateTargets.map(({ template }) => template).join(", ")}`,
  );
  console.log(
    `create-croco-app-generated-smoke: template exclusions ${templateExclusions.map(({ template }) => template).join(", ")}`,
  );
}

function readSmokeCoverage(cases: readonly SmokeCase[]): {
  readonly goals: readonly string[];
  readonly presets: readonly string[];
  readonly apis: readonly string[];
  readonly apiHosting: readonly string[];
  readonly backendDeploys: readonly string[];
  readonly frontendDeploys: readonly string[];
  readonly uiProfiles: readonly string[];
  readonly databases: readonly string[];
  readonly saasProviderProfiles: readonly string[];
  readonly tenantModels: readonly string[];
  readonly runtimeCapabilityManifests: readonly RuntimeCapabilitySmokePlatform[];
} {
  return {
    goals: readCoveredValues(cases, "--goal", SUPPORTED_CREATE_CROCO_APP_CHOICES.goals),
    presets: readCoveredValues(cases, "--preset", SUPPORTED_CREATE_CROCO_APP_CHOICES.presets),
    apis: readCoveredValues(cases, "--api", SUPPORTED_CREATE_CROCO_APP_CHOICES.apis),
    apiHosting: readCoveredValues(
      cases,
      "--api-hosting",
      SUPPORTED_CREATE_CROCO_APP_CHOICES.apiHosting,
    ),
    backendDeploys: readCoveredValues(
      cases,
      "--backend-deploy",
      SUPPORTED_CREATE_CROCO_APP_CHOICES.backendDeploys,
    ),
    frontendDeploys: readCoveredValues(
      cases,
      "--frontend-deploy",
      SUPPORTED_CREATE_CROCO_APP_CHOICES.frontendDeploys,
    ),
    uiProfiles: readCoveredValues(cases, "--ui", SUPPORTED_CREATE_CROCO_APP_CHOICES.uiProfiles),
    databases: readCoveredValues(cases, "--db", SUPPORTED_CREATE_CROCO_APP_CHOICES.databases, {
      splitCommaValues: true,
    }),
    saasProviderProfiles: readCoveredValues(
      cases,
      "--saas-profile",
      SUPPORTED_CREATE_CROCO_APP_CHOICES.saasProviderProfiles,
    ),
    tenantModels: readCoveredTenantModels(cases),
    runtimeCapabilityManifests: readRuntimeCapabilityManifestCoverage(cases),
  };
}

function isSupportedGoal(value: string | undefined): value is AppGoal {
  return SUPPORTED_CREATE_CROCO_APP_CHOICES.goals.some((goal) => goal === value);
}

function readCoveredTenantModels(cases: readonly SmokeCase[]): readonly string[] {
  const coveredTenantModels = new Set(
    readCoveredValues(cases, "--tenant-model", SUPPORTED_CREATE_CROCO_APP_CHOICES.tenantModels),
  );

  for (const smokeCase of cases) {
    const preset = readFlagValue(smokeCase.args, "--preset");
    const goal = readFlagValue(smokeCase.args, "--goal");
    const hasTenantModel = readFlagValue(smokeCase.args, "--tenant-model") !== undefined;

    if (!hasTenantModel && (preset === "saas" || preset === "ai-saas" || goal === "saas-api")) {
      coveredTenantModels.add(DEFAULT_TENANT_MODEL);
    }
  }

  return SUPPORTED_CREATE_CROCO_APP_CHOICES.tenantModels.filter((tenantModel) =>
    coveredTenantModels.has(tenantModel),
  );
}

function readRuntimeCapabilityManifestCoverage(
  cases: readonly SmokeCase[],
): readonly RuntimeCapabilitySmokePlatform[] {
  const coveredPlatforms = new Set<RuntimeCapabilitySmokePlatform>();

  for (const smokeCase of cases) {
    for (const validation of smokeCase.validations) {
      const platform = validation.json?.matches.platform;
      if (isRuntimeCapabilitySmokePlatform(platform)) {
        coveredPlatforms.add(platform);
      }
    }
  }

  return runtimeCapabilitySmokePlatforms.filter((platform) => coveredPlatforms.has(platform));
}

function isRuntimeCapabilitySmokePlatform(value: unknown): value is RuntimeCapabilitySmokePlatform {
  return runtimeCapabilitySmokePlatforms.includes(value as RuntimeCapabilitySmokePlatform);
}

function readGraphQLContractPackagePath(smokeCase: SmokeCase): readonly string[] | undefined {
  if (readFlagValue(smokeCase.args, "--api") !== "graphql") {
    return undefined;
  }

  return readFlagValue(smokeCase.args, "--api-hosting") === "nextjs"
    ? GRAPHQL_NEXTJS_CONTRACT_PACKAGE_PATH
    : GRAPHQL_STANDALONE_CONTRACT_PACKAGE_PATH;
}

function readFlagValue(args: readonly string[], flag: string): string | undefined {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) return undefined;

  const value = args[flagIndex + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readCoveredValues(
  cases: readonly SmokeCase[],
  flag: string,
  supportedValues: readonly string[],
  options: { readonly splitCommaValues?: boolean } = {},
): readonly string[] {
  const coveredValues = new Set<string>();

  for (const smokeCase of cases) {
    for (let index = 0; index < smokeCase.args.length; index += 1) {
      if (smokeCase.args[index] !== flag) continue;

      const value = smokeCase.args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${smokeCase.name} is missing a value after ${flag}`);
      }

      const values = options.splitCommaValues
        ? value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : [value];

      for (const coveredValue of values) {
        coveredValues.add(coveredValue);
      }
    }
  }

  const unsupportedValues = [...coveredValues].filter(
    (coveredValue) => !supportedValues.includes(coveredValue),
  );
  if (unsupportedValues.length > 0) {
    throw new Error(
      `${flag} smoke coverage includes unsupported values: ${unsupportedValues.join(", ")}`,
    );
  }

  return supportedValues.filter((supportedValue) => coveredValues.has(supportedValue));
}

function assertCovers(
  label: string,
  supportedValues: readonly string[],
  coveredValues: readonly string[],
): void {
  const missingValues = supportedValues.filter(
    (supportedValue) => !coveredValues.includes(supportedValue),
  );

  if (missingValues.length > 0) {
    throw new Error(
      `create-croco-app generated smoke matrix is missing ${label}: ${missingValues.join(", ")}`,
    );
  }
}

function runSpaBeSplitContractSmoke(
  workspacePackageIndex: ReadonlyMap<string, WorkspacePackage>,
  packedWorkspacePackages: Map<string, string>,
  builtWorkspacePackageNames: Set<string>,
  report: GeneratedSmokeReport,
  caseResult: SmokeCaseResult,
): void {
  const contractSmokeRoot = getSmokeRoot();
  const projectDir = join(contractSmokeRoot, "rest-spa-contracts");
  const templateDir = join(rootDir, "packages", "create-croco-app", "templates", "spa-be-split");

  try {
    renderTemplate(templateDir, projectDir, {
      projectName: "rest-spa-contracts",
      scope: "@smoke",
    });
    assertGeneratedSmokeCaseDependencyMapping(
      REST_SPA_CONTRACT_SMOKE_CASE_NAME,
      projectDir,
      rootDir,
    );
    removeDependency(
      join(projectDir, "apps", "api-server", "package.json"),
      "devDependencies",
      "@croco/testing",
    );
    const contractSmokeRangeOverrides = getGeneratedSmokeRangeOverrides(
      projectDir,
      join(contractSmokeRoot, "contract-package-packs"),
      workspacePackageIndex,
      packedWorkspacePackages,
      builtWorkspacePackageNames,
      (label, result) => appendSmokeCaseOutput(caseResult, label, result),
    );
    rewriteExternalCrocoRanges(
      projectDir,
      contractSmokeRangeOverrides,
      generatedSmokeExternalCrocoRangeExceptions,
    );
    writePnpmWorkspaceOverrides(projectDir, contractSmokeRangeOverrides);

    runSmokeCaseCommand(
      report,
      caseResult,
      projectDir,
      "install",
      corepackCommand,
      ["pnpm", "install"],
      projectDir,
    );
    assertPnpmLockfileUsesLocalTarballOverrides(
      join(projectDir, "pnpm-lock.yaml"),
      REST_SPA_CONTRACT_SMOKE_CASE_NAME,
      contractSmokeRangeOverrides,
    );
    runSmokeCaseCommand(
      report,
      caseResult,
      projectDir,
      "contract check",
      corepackCommand,
      ["pnpm", "contract:check"],
      projectDir,
    );
    runSmokeCaseCommand(
      report,
      caseResult,
      projectDir,
      "contract snapshot",
      corepackCommand,
      ["pnpm", "contract:snapshot"],
      projectDir,
    );
    assertExists(
      join(projectDir, "contract-graph.snapshot.json"),
      "REST SPA contract smoke did not create contract-graph.snapshot.json",
    );
    runSmokeCaseCommand(
      report,
      caseResult,
      projectDir,
      "contract codegen",
      corepackCommand,
      ["pnpm", "codegen"],
      projectDir,
    );
    ensureGeneratedVerificationBaseline(projectDir);
    runSmokeCaseCommand(
      report,
      caseResult,
      projectDir,
      "contract verify",
      process.execPath,
      [
        "--experimental-strip-types",
        join(rootDir, "scripts", "tracked-file-mutation-guard.mts"),
        "--recovery",
        "pnpm codegen",
        "--",
        "corepack",
        "pnpm",
        "contract:verify",
      ],
      projectDir,
    );
    assertExists(
      join(projectDir, "openapi.json"),
      "REST SPA contract smoke did not create openapi.json",
    );

    const generatedClientPath = join(
      projectDir,
      "libs",
      "shared",
      "provider-rpc",
      "src",
      "user.ts",
    );
    assertExists(
      generatedClientPath,
      "REST SPA contract smoke did not create provider-rpc user client",
    );
    assertFileContains(
      generatedClientPath,
      "export function useList<TData = ListOutput>(options?: ListQueryOptions<TData>)",
    );
    assertFileContains(
      generatedClientPath,
      "export type CreateInput = { email: string; name: string; };",
    );
    const problemDeclarationCanary = removeRestSpaListProblemDeclaration(projectDir);
    runExpectedSmokeCaseCommand(
      report,
      caseResult,
      projectDir,
      "strict Problem declaration canary",
      corepackCommand,
      [
        "pnpm",
        "exec",
        "croco-rpc-codegen",
        "--controllers",
        "apps/api-server/src/{controllers/**/*.ts,users.ts,problems.ts}",
        "--check",
        "--fail-on-diagnostics",
      ],
      projectDir,
      [
        "contract-route-missing-problem-response-contract",
        "Strict Problem contract mode could not find declared route failures.",
        "Contract graph check failed with 1 diagnostic(s).",
      ],
    );
    writeFileSync(problemDeclarationCanary.path, problemDeclarationCanary.original);
    removeRestSpaListResponseSchema(projectDir);
    runExpectedSmokeCaseCommand(
      report,
      caseResult,
      projectDir,
      "strict OpenAPI schema canary",
      corepackCommand,
      [
        "pnpm",
        "exec",
        "croco-openapi-spec",
        "--controllers",
        "apps/api-server/src/{controllers/**/*.ts,users.ts,problems.ts}",
        "--out",
        "strict-openapi-canary.json",
        "--fail-on-diagnostics",
        "--manifest-bundle",
        ".croco/manifest",
      ],
      projectDir,
      [
        "contract-route-missing-response-schema",
        "Strict schema mode requires a success response schema before RPC/OpenAPI generation.",
        "fix them before generating OpenAPI",
      ],
    );
    assertMissing(
      join(projectDir, "strict-openapi-canary.json"),
      "REST SPA strict OpenAPI canary wrote an artifact despite ContractGraph errors",
    );
    runExpectedSmokeCaseCommand(
      report,
      caseResult,
      projectDir,
      "strict RPC schema canary",
      corepackCommand,
      [
        "pnpm",
        "exec",
        "croco-rpc-codegen",
        "--controllers",
        "apps/api-server/src/{controllers/**/*.ts,users.ts,problems.ts}",
        "--out",
        ".strict-rpc-canary",
        "--react-query",
        "--problem-runtime",
        "frontend-problems",
        "--fail-on-diagnostics",
        "--manifest-bundle",
        ".croco/manifest",
      ],
      projectDir,
      [
        "contract-route-missing-response-schema",
        "Strict schema mode requires a success response schema before RPC/OpenAPI generation.",
        "fix them before generating clients",
      ],
    );
    assertMissing(
      join(projectDir, ".strict-rpc-canary"),
      "REST SPA strict RPC canary wrote artifacts despite ContractGraph errors",
    );
    caseResult.status = "passed";
    writeGeneratedSmokeReport(report);
    console.log("create-croco-app-generated-smoke: rest-spa-contracts contract commands passed");
  } catch (error) {
    recordUnhandledSmokeCaseFailure(report, caseResult, projectDir, error);
    throw error;
  }
}

function removeRestSpaListProblemDeclaration(projectDir: string): {
  readonly path: string;
  readonly original: string;
} {
  const schemaPath = join(projectDir, "apps", "api-server", "src", "controllers", "userSchemas.ts");
  const original = readFileSync(schemaPath, "utf8");
  const updated = original.replace("  problems: [],\n", "");

  if (updated === original) {
    throw new Error("REST SPA strict Problem smoke could not remove the list Problem declaration");
  }

  writeFileSync(schemaPath, updated);

  return { path: schemaPath, original };
}

function removeRestSpaListResponseSchema(projectDir: string): void {
  const schemaPath = join(projectDir, "apps", "api-server", "src", "controllers", "userSchemas.ts");
  const original = readFileSync(schemaPath, "utf8");
  const updated = original.replace("  response: z.array(userSchema),\n", "");

  if (updated === original) {
    throw new Error("REST SPA strict schema smoke could not remove the list response schema");
  }

  writeFileSync(schemaPath, updated);
}

function getGeneratedSmokeRangeOverrides(
  projectDir: string,
  packDir: string,
  workspacePackageIndex: ReadonlyMap<string, WorkspacePackage>,
  packedWorkspacePackages: Map<string, string>,
  builtWorkspacePackageNames: Set<string>,
  onCommandResult?: SmokeCommandOutputObserver,
): Record<string, string> {
  const workspacePackages = resolveLocalCrocoPackagesForGeneratedProject(
    projectDir,
    workspacePackageIndex,
    generatedSmokeExternalCrocoRangeExceptions,
  );

  buildWorkspacePackages(
    workspacePackages.map(({ name }) => name),
    builtWorkspacePackageNames,
    onCommandResult,
  );

  return Object.fromEntries(
    workspacePackages.map((workspacePackage) => [
      workspacePackage.name,
      `file:${packWorkspacePackage(workspacePackage, packDir, packedWorkspacePackages, onCommandResult)}`,
    ]),
  );
}

function buildWorkspacePackages(
  packageNames: readonly string[],
  builtWorkspacePackageNames: Set<string>,
  onCommandResult?: SmokeCommandOutputObserver,
): void {
  const packageNamesToBuild = [...new Set(packageNames)]
    .filter((packageName) => !builtWorkspacePackageNames.has(packageName))
    .sort();

  if (packageNamesToBuild.length === 0) {
    return;
  }

  const commandResult = run(
    process.execPath,
    [turboPath, ...turboBuildArguments(packageNamesToBuild)],
    rootDir,
  );
  onCommandResult?.("build local dependencies", commandResult);

  for (const packageName of packageNamesToBuild) {
    builtWorkspacePackageNames.add(packageName);
  }
}

export function markWorkspacePackageClosureBuilt(
  packageNames: readonly string[],
  workspacePackageIndex: ReadonlyMap<string, WorkspacePackage>,
  builtWorkspacePackageNames: Set<string>,
): void {
  const pending = [...packageNames];

  while (pending.length > 0) {
    const packageName = pending.pop();
    if (!packageName || builtWorkspacePackageNames.has(packageName)) continue;

    const workspacePackage = workspacePackageIndex.get(packageName);
    if (!workspacePackage) {
      throw new Error(`Workspace build references unknown package ${packageName}`);
    }

    builtWorkspacePackageNames.add(packageName);
    pending.push(...workspacePackage.dependencyNames);
  }
}

export function turboBuildArguments(
  packageNames: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    "build",
    ...turboConcurrencyArguments(platform),
    ...packageNames.map((packageName) => `--filter=${packageName}...`),
  ];
}

export function turboConcurrencyArguments(platform: NodeJS.Platform = process.platform): string[] {
  // TypeScript 6 declaration bundling is substantially more memory-intensive on the hosted Windows runner.
  // Leave process-initialization headroom so a large generated-app dependency graph remains deterministic.
  return [`--concurrency=${platform === "win32" ? 1 : 4}`];
}

function packWorkspacePackage(
  workspacePackage: WorkspacePackage,
  packDir: string,
  packedWorkspacePackages: Map<string, string>,
  onCommandResult?: SmokeCommandOutputObserver,
): string {
  const cachedTarballPath = packedWorkspacePackages.get(workspacePackage.name);
  if (cachedTarballPath) {
    return cachedTarballPath;
  }

  mkdirSync(packDir, { recursive: true });
  const commandResult = run(
    corepackCommand,
    ["pnpm", "--filter", workspacePackage.name, "pack", "--pack-destination", packDir],
    rootDir,
  );
  onCommandResult?.(`pack local dependency ${workspacePackage.name}`, commandResult);

  const tarballPath = join(
    packDir,
    `${workspacePackage.name.replace(/^@/, "").replace("/", "-")}-${workspacePackage.version}.tgz`,
  );
  packedWorkspacePackages.set(workspacePackage.name, tarballPath);

  return tarballPath;
}

function assertPnpmLockfileUsesLocalTarballOverrides(
  lockfilePath: string,
  label: string,
  rangeOverrides: Record<string, string>,
): void {
  const lockfile = readFileSync(lockfilePath, "utf8");
  const missingLocalTarballPackages = Object.entries(rangeOverrides)
    .filter(([, range]) => !lockfile.includes(range))
    .map(([packageName]) => packageName);

  if (missingLocalTarballPackages.length > 0) {
    throw new Error(
      `${label} pnpm lockfile is missing local tarball references for ${missingLocalTarballPackages.join(", ")}`,
    );
  }
}

function renderTemplate(sourceDir: string, targetDir: string, vars: Record<string, string>): void {
  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetName = entry.name.endsWith(".hbs") ? entry.name.slice(0, -4) : entry.name;
    const targetPath = join(targetDir, targetName);

    if (entry.isDirectory()) {
      renderTemplate(sourcePath, targetPath, vars);
      continue;
    }

    if (isTextFile(sourcePath)) {
      const rendered = renderText(readFileSync(sourcePath, "utf8"), vars);
      writeFileSync(targetPath, rendered);
      continue;
    }

    copyFileSync(sourcePath, targetPath);
  }
}

function isTextFile(path: string): boolean {
  return !readFileSync(path).includes(0);
}

function renderText(content: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (rendered, [key, value]) => rendered.split(`{{${key}}}`).join(value),
    content,
  );
}

function removeDependency(path: string, field: DependencyField, packageName: string): void {
  const packageJson = JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  const dependencies = packageJson[field];

  if (!isDependencyMap(dependencies) || !(packageName in dependencies)) {
    return;
  }

  delete dependencies[packageName];
  writeFileSync(path, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function isDependencyMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((dependencyRange) => typeof dependencyRange === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertFileContains(path: string, expected: string): void {
  const content = readFileSync(path, "utf8");

  if (!content.includes(expected)) {
    throw new Error(`${path} did not include expected text: ${expected}`);
  }
}

export function assertGeneratedBrowserWorkflowLeastPrivilege(path: string): void {
  const workflow = parseYaml(readFileSync(path, "utf8")) as unknown;

  if (!isRecord(workflow)) {
    throw new Error(`${path} must contain a YAML workflow object`);
  }

  const permissions = workflow.permissions;
  if (
    !isRecord(permissions) ||
    permissions.contents !== "read" ||
    Object.keys(permissions).length !== 1
  ) {
    throw new Error(`${path} permissions must grant only contents: read`);
  }

  const jobs = workflow.jobs;
  if (!isRecord(jobs)) {
    throw new Error(`${path} must define workflow jobs`);
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!isRecord(job)) continue;

    const jobPermissions = job.permissions;
    if (
      jobPermissions !== undefined &&
      (!isRecord(jobPermissions) ||
        jobPermissions.contents !== "read" ||
        Object.keys(jobPermissions).length !== 1)
    ) {
      throw new Error(`${path} job ${jobName} permissions must grant only contents: read`);
    }
  }

  const checkoutSteps = Object.values(jobs).flatMap((job) => {
    if (!isRecord(job) || !Array.isArray(job.steps)) return [];

    return job.steps.filter(
      (step): step is Record<string, unknown> =>
        isRecord(step) &&
        typeof step.uses === "string" &&
        step.uses.toLowerCase().startsWith("actions/checkout@"),
    );
  });

  if (checkoutSteps.length === 0) {
    throw new Error(`${path} must contain at least one actions/checkout step`);
  }

  for (const checkoutStep of checkoutSteps) {
    if (
      typeof checkoutStep.uses !== "string" ||
      !checkoutStep.uses.startsWith("actions/checkout@")
    ) {
      throw new Error(`${path} checkout steps must use canonical actions/checkout@ casing`);
    }
    if (!isRecord(checkoutStep.with) || checkoutStep.with["persist-credentials"] !== false) {
      throw new Error(`${path} checkout steps must set persist-credentials: false`);
    }
  }
}

function assertJsonMatches(
  path: string,
  expected: Record<string, unknown>,
  label: string,
  arrayMinLengths: Readonly<Record<string, number>> = {},
): void {
  assertExists(path, `${label} did not create ${path}`);
  const actual = JSON.parse(readFileSync(path, "utf8")) as unknown;

  if (!isRecord(actual)) {
    throw new Error(`${label} JSON ${path} is not an object`);
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];

    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      throw new Error(
        `${label} JSON ${path} expected ${key}=${JSON.stringify(expectedValue)} but got ${JSON.stringify(actualValue)}`,
      );
    }
  }

  for (const [key, minLength] of Object.entries(arrayMinLengths)) {
    const actualValue = actual[key];
    if (!Array.isArray(actualValue) || actualValue.length < minLength) {
      throw new Error(
        `${label} JSON ${path} expected ${key} to contain at least ${minLength} item(s) but got ${JSON.stringify(actualValue)}`,
      );
    }
  }
}

export function assertGeneratedPresentationProfileMatchesCatalog(
  projectDir: string,
  appProfilePath: string,
  runtimeProfileName: string,
  smokeCaseName: string,
  catalogPath = join(rootDir, "packages", "presentation-preset", "runtime-profiles.json"),
): void {
  const catalog = readJsonObject(catalogPath, "presentation runtime profile catalog");
  if (!Array.isArray(catalog.profiles)) {
    throw new Error(`Presentation runtime profile catalog ${catalogPath} has no profiles array`);
  }

  const runtimeProfile = catalog.profiles.find(
    (profile): profile is Record<string, unknown> =>
      isRecord(profile) && profile.name === runtimeProfileName,
  );
  if (!runtimeProfile) {
    throw new Error(
      `Presentation runtime profile catalog ${catalogPath} does not define ${runtimeProfileName}`,
    );
  }
  if (runtimeProfile.generatedAppSmokeCase !== smokeCaseName) {
    throw new Error(
      `Presentation runtime profile ${runtimeProfileName} references ${String(runtimeProfile.generatedAppSmokeCase)} instead of ${smokeCaseName}`,
    );
  }
  if (!isRecord(runtimeProfile.ui)) {
    throw new Error(`Presentation runtime profile ${runtimeProfileName} has no UI metadata`);
  }
  if (runtimeProfile.ui.generatedAppSmokeCase !== smokeCaseName) {
    throw new Error(
      `Presentation runtime profile ${runtimeProfileName} UI metadata references ${String(runtimeProfile.ui.generatedAppSmokeCase)} instead of ${smokeCaseName}`,
    );
  }

  const generatedAppProfilePath = join(projectDir, appProfilePath);
  const generatedAppProfile = readJsonObject(
    generatedAppProfilePath,
    `${smokeCaseName} generated app presentation profile`,
  );
  const webApp = basename(dirname(generatedAppProfilePath));
  const expectedProfile = {
    webApp,
    runtimeProfile: runtimeProfileName,
    ui: runtimeProfile.ui,
  };
  if (JSON.stringify(generatedAppProfile) !== JSON.stringify(expectedProfile)) {
    throw new Error(
      `${smokeCaseName} generated presentation profile does not match ${runtimeProfileName} in ${catalogPath}`,
    );
  }

  const manifestPath = join(projectDir, "croco-presentation-profile.manifest.json");
  const manifest = readJsonObject(manifestPath, `${smokeCaseName} presentation profile manifest`);
  if (
    manifest.schemaVersion !== "croco.generated-presentation-profile/v1" ||
    JSON.stringify(manifest.profiles) !== JSON.stringify([expectedProfile])
  ) {
    throw new Error(
      `${smokeCaseName} presentation profile manifest does not match the canonical generated profile`,
    );
  }
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
  assertExists(path, `${label} did not create ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(value)) {
    throw new Error(`${label} JSON ${path} is not an object`);
  }

  return value;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): CommandRunResult {
  const { result, commandResult } = executeCommand(command, args, cwd, env);

  if (result.error) {
    replayCommandOutput(commandResult);
    throw new CommandExecutionError(
      createCommandExecutionErrorMessage(command, args, result.error),
      commandResult,
      result.error,
    );
  }

  if (result.status !== 0) {
    replayCommandOutput(commandResult);
    throw new CommandExecutionError(
      `${command} ${args.join(" ")} failed with ${formatCommandExit(commandResult)}`,
      commandResult,
    );
  }

  return commandResult;
}

function runExpectFailure(
  command: string,
  args: readonly string[],
  cwd: string,
  expectedOutput: readonly string[],
  env?: Readonly<Record<string, string>>,
): CommandRunResult {
  const { result, commandResult } = executeCommand(command, args, cwd, env);
  const output = `${commandResult.stdout}${commandResult.stderr}`;

  if (result.error) {
    replayCommandOutput(commandResult);
    throw new CommandExecutionError(
      createCommandExecutionErrorMessage(command, args, result.error),
      commandResult,
      result.error,
    );
  }

  if (result.status === 0) {
    replayCommandOutput(commandResult);
    throw new CommandExecutionError(
      `${command} ${args.join(" ")} was expected to fail but exited 0`,
      commandResult,
    );
  }

  for (const expectedText of expectedOutput) {
    if (!output.includes(expectedText)) {
      replayCommandOutput(commandResult);
      throw new CommandExecutionError(
        `${command} ${args.join(" ")} failed without expected output: ${expectedText}`,
        commandResult,
      );
    }
  }

  return commandResult;
}

function executeCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): {
  readonly result: ReturnType<typeof spawnSync>;
  readonly commandResult: CommandRunResult;
} {
  const outputDir = mkdtempSync(join(tmpdir(), "croco-generated-smoke-command-"));
  const stdoutPath = join(outputDir, "stdout.log");
  const stderrPath = join(outputDir, "stderr.log");
  const stdoutFileDescriptor = openSync(stdoutPath, "w");
  const stderrFileDescriptor = openSync(stderrPath, "w");

  const result = (() => {
    try {
      return spawnSync(command, [...args], {
        cwd,
        env: env ? { ...process.env, ...env } : undefined,
        shell: requiresCommandShell(command),
        stdio: ["ignore", stdoutFileDescriptor, stderrFileDescriptor],
        timeout: commandTimeoutMs,
      });
    } finally {
      closeSync(stdoutFileDescriptor);
      closeSync(stderrFileDescriptor);
    }
  })();

  try {
    const stdout = readCappedCommandOutput(stdoutPath);
    const stderr = readCappedCommandOutput(stderrPath);

    return {
      result,
      commandResult: toCommandRunResult(result, stdout, stderr),
    };
  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
}

export function requiresCommandShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && command.toLowerCase().endsWith(".cmd");
}

function readCappedCommandOutput(path: string): {
  readonly value: string;
  readonly truncated: boolean;
} {
  const size = statSync(path).size;
  const fileDescriptor = openSync(path, "r");

  try {
    if (size <= commandCaptureMaxBytes) {
      return {
        value: readCommandOutputSegment(fileDescriptor, size, 0),
        truncated: false,
      };
    }

    const headLength = Math.min(commandCaptureHeadBytes, commandCaptureMaxBytes);
    const tailLength = commandCaptureMaxBytes - headLength;
    return {
      value: [
        readCommandOutputSegment(fileDescriptor, headLength, 0),
        `[croco generated smoke output truncated; showing the first ${headLength} bytes and final ${tailLength} bytes]`,
        readCommandOutputSegment(fileDescriptor, tailLength, size - tailLength),
      ].join("\n"),
      truncated: true,
    };
  } finally {
    closeSync(fileDescriptor);
  }
}

export function readCommandOutputSegment(
  fileDescriptor: number,
  length: number,
  position: number,
): string {
  const buffer = Buffer.alloc(length);
  const decoder = new TextDecoder("utf-8");
  let bytesRead = 0;
  let value = "";

  while (bytesRead < length) {
    const readLength = readSync(
      fileDescriptor,
      buffer,
      bytesRead,
      length - bytesRead,
      position + bytesRead,
    );
    if (readLength === 0) {
      break;
    }
    value += decoder.decode(buffer.subarray(bytesRead, bytesRead + readLength), { stream: true });
    bytesRead += readLength;
  }

  return `${value}${decoder.decode()}`;
}

function toCommandRunResult(
  result: ReturnType<typeof spawnSync>,
  stdout: { readonly value: string; readonly truncated: boolean },
  stderr: { readonly value: string; readonly truncated: boolean },
): CommandRunResult {
  const output = [stdout.value, stderr.value].join("\n");

  return {
    stdout: stdout.value,
    stderr: stderr.value,
    status: result.status,
    signal: result.signal,
    outputTruncated: stdout.truncated || stderr.truncated,
    diagnosticCodes: extractDiagnosticCodes(output),
  };
}

function replayCommandOutput(result: CommandRunResult): void {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function createCommandExecutionErrorMessage(
  command: string,
  args: readonly string[],
  error: Error,
): string {
  return `${command} ${args.join(" ")} failed to start: ${error.message}`;
}

function formatCommandExit(result: CommandRunResult): string {
  return result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
}

function getCommandResultFromError(error: unknown): CommandRunResult | undefined {
  return error instanceof CommandExecutionError ? error.commandResult : undefined;
}
