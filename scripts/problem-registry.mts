#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { argv, env, exit, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { VERSIONS } from "../packages/create-croco-app/src/consts.ts";
import { getProblemCodeDeprecationValidationErrors } from "../packages/problems-core/src/libs/ProblemCodeRegistryValidation.mts";

export type ProblemRegistryMode = "check" | "write";
export type ProblemRegistryRunOptions = {
  readonly baseRef?: string;
  readonly baseRegistry?: ProblemCodeRegistry | null;
};
export type ProblemCategory = (typeof ProblemCategory)[keyof typeof ProblemCategory];
export type ProblemCodeRegistryVersion = "croco.problem-code-registry.v1";
export type ProblemCodeSourceKind =
  | "problem-class"
  | "problem-constructor"
  | "problem-factory"
  | "problem-metadata";
export type ProblemRetryability = "retryable" | "conditional" | "not-retryable";
export type ProblemRedactionPolicy = "public" | "safe-message" | "operator-only";
export type ProblemTelemetrySeverity = "info" | "warning" | "error";
export type ProblemLifecycleStatus = "active" | "deprecated";

export type ProblemStatusPolicy = {
  readonly kind: "runtime-configurable";
  readonly defaultStatus: number;
  readonly configuration: string;
};

export type ProblemDeprecationMetadata =
  | {
      readonly reason: string;
      readonly migrationNote: string;
      readonly replacementCode: string;
      readonly noReplacementReason?: never;
      readonly since?: string;
    }
  | {
      readonly reason: string;
      readonly migrationNote: string;
      readonly replacementCode?: never;
      readonly noReplacementReason: string;
      readonly since?: string;
    };

export type ProblemLifecycle = {
  readonly status: ProblemLifecycleStatus;
  readonly deprecation?: ProblemDeprecationMetadata;
};

export type ProblemCodeSource = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: ProblemCodeSourceKind;
};

export type ProblemCodeDiscovery = {
  readonly code: string;
  readonly category: ProblemCategory;
  readonly sources: readonly ProblemCodeSource[];
};

export type ProblemRecoveryMetadata = {
  readonly cause: string;
  readonly userAction: string;
  readonly operatorAction: string;
  readonly retryability: ProblemRetryability;
  readonly redactionPolicy: ProblemRedactionPolicy;
  readonly telemetry: {
    readonly eventName: string;
    readonly severity: ProblemTelemetrySeverity;
    readonly attributes: readonly string[];
  };
};

export type ProblemCodeRegistryEntry = {
  readonly code: string;
  readonly category: ProblemCategory;
  readonly status: number;
  readonly statusPolicy?: ProblemStatusPolicy;
  readonly title: string;
  readonly cookbookPath: string;
  readonly recovery: ProblemRecoveryMetadata;
  readonly lifecycle: ProblemLifecycle;
  readonly sources: readonly ProblemCodeSource[];
};

export type ProblemCodeRegistry = {
  readonly version: ProblemCodeRegistryVersion;
  readonly problemCount: number;
  readonly problems: readonly ProblemCodeRegistryEntry[];
};

export type ProblemRegistryRunResult = {
  readonly status: "pass" | "fail";
  readonly diagnostics: readonly string[];
  readonly discoveryCount: number;
  readonly problemCount: number;
  readonly registryPath: string;
  readonly cookbookPath: string;
};

type ProblemCodeDiscoveryCandidate = {
  readonly code: string;
  readonly category: ProblemCategory;
  readonly kind: ProblemCodeSourceKind;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly routeProblemProjection?: boolean;
};

type StringConstants = {
  readonly identifiers: ReadonlyMap<string, string>;
  readonly propertyAccesses: ReadonlyMap<string, string>;
};

type ProblemConstructorForwarder = {
  readonly code?: string;
  readonly codeArgumentIndex?: number;
  readonly category?: ProblemCategory;
  readonly categoryArgumentIndex?: number;
};

const registryPath = join("docs", "problem-code-registry.json");
const generatedRegistrySourcePath = join(
  "packages",
  "problems-core",
  "src",
  "generated",
  "problem-code-registry.ts",
);
const repoRootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cookbookPath = join(
  "packages",
  "docs",
  "src",
  "content",
  "docs",
  "en",
  "reference",
  "problem-recovery-cookbook.md",
);

export const ProblemCategory = {
  BadRequest: "BadRequest",
  Unauthorized: "Unauthorized",
  Forbidden: "Forbidden",
  NotFound: "NotFound",
  Conflict: "Conflict",
  Gone: "Gone",
  PayloadTooLarge: "PayloadTooLarge",
  ValidationError: "ValidationError",
  BusinessRuleViolation: "BusinessRuleViolation",
  TooManyRequests: "TooManyRequests",
  InternalServerError: "InternalServerError",
  NotImplemented: "NotImplemented",
} as const;

class ProblemRegistryValidationProblem extends Error {
  public readonly errors: readonly string[];

  public constructor(errors: readonly string[]) {
    super(errors.join("\n"));
    this.name = "ProblemRegistryValidationProblem";
    this.errors = errors;
  }
}

const factoryMethodCategory = {
  badRequest: ProblemCategory.BadRequest,
  invalidArgument: ProblemCategory.BadRequest,
  unauthorized: ProblemCategory.Unauthorized,
  forbidden: ProblemCategory.Forbidden,
  notFound: ProblemCategory.NotFound,
  conflict: ProblemCategory.Conflict,
  gone: ProblemCategory.Gone,
  payloadTooLarge: ProblemCategory.PayloadTooLarge,
  validationError: ProblemCategory.ValidationError,
  businessRuleViolation: ProblemCategory.BusinessRuleViolation,
  tooManyRequests: ProblemCategory.TooManyRequests,
  internalServerError: ProblemCategory.InternalServerError,
  notImplemented: ProblemCategory.NotImplemented,
} as const satisfies Record<string, ProblemCategory>;

export function runProblemRegistryCheck(
  rootDir = process.cwd(),
  mode: ProblemRegistryMode = "check",
  options: ProblemRegistryRunOptions = {},
): ProblemRegistryRunResult {
  const absoluteRootDir = resolve(rootDir);

  try {
    const discoveries = discoverProblemCodes(absoluteRootDir);
    const existingRegistry = readExistingProblemCodeRegistry(absoluteRootDir);
    const baseRegistry = readBaseProblemCodeRegistry(absoluteRootDir, options);
    const implementationBaselineRegistry = mergeProblemRegistryBaselines(
      baseRegistry,
      existingRegistry,
    );
    const generatedRegistry = createProblemCodeRegistry(
      discoveries,
      getApplicableStatusPolicies(absoluteRootDir),
    );
    const registry = mergeDeprecatedProblemEntries(generatedRegistry, existingRegistry);
    const artifacts = formatProblemRegistryArtifacts(createProblemRegistryArtifacts(registry));
    const preflightDiagnostics = [
      ...getProblemCodeRegistryValidationErrors(registry),
      ...getRegistryImplementationDiagnostics(implementationBaselineRegistry, registry),
      ...getProblemContractChangeDiagnostics(
        absoluteRootDir,
        baseRegistry ?? existingRegistry,
        registry,
      ),
      ...getProblemRedactionDiagnostics(absoluteRootDir),
    ];
    const syncDiagnostics =
      preflightDiagnostics.length === 0
        ? syncProblemRegistryArtifacts(absoluteRootDir, artifacts, mode)
        : [];
    const diagnostics = [...preflightDiagnostics, ...syncDiagnostics];

    return {
      status: diagnostics.length === 0 ? "pass" : "fail",
      diagnostics,
      discoveryCount: discoveries.reduce((count, discovery) => count + discovery.sources.length, 0),
      problemCount: registry.problemCount,
      registryPath,
      cookbookPath,
    };
  } catch (error) {
    return {
      status: "fail",
      diagnostics: formatProblemRegistryError(error),
      discoveryCount: 0,
      problemCount: 0,
      registryPath,
      cookbookPath,
    };
  }
}

export function discoverProblemCodes(rootDir = process.cwd()): readonly ProblemCodeDiscovery[] {
  const candidates = getSourceFiles(rootDir).flatMap((file) =>
    discoverProblemCodeCandidates(rootDir, file),
  );
  const implementedProblemKeys = new Set(
    candidates
      .filter((candidate) => !candidate.routeProblemProjection)
      .map((candidate) => getProblemDiscoveryKey(candidate)),
  );
  const effectiveCandidates = candidates.filter(
    (candidate) =>
      !candidate.routeProblemProjection ||
      !implementedProblemKeys.has(getProblemDiscoveryKey(candidate)),
  );
  const candidatesByCodeAndCategory = new Map<string, ProblemCodeDiscoveryCandidate[]>();

  for (const candidate of effectiveCandidates) {
    const key = getProblemDiscoveryKey(candidate);
    const existing = candidatesByCodeAndCategory.get(key) ?? [];
    candidatesByCodeAndCategory.set(key, [...existing, candidate]);
  }

  return [...candidatesByCodeAndCategory.entries()]
    .map(([, groupedCandidates]) => {
      const [first] = groupedCandidates;

      if (!first) {
        throw new Error("Problem code discovery grouping produced an empty group.");
      }

      return {
        code: first.code,
        category: first.category,
        sources: groupedCandidates
          .map((candidate) => ({
            file: candidate.file,
            line: candidate.line,
            column: candidate.column,
            kind: candidate.kind,
          }))
          .sort(compareSources),
      };
    })
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) || left.category.localeCompare(right.category),
    );
}

function getProblemDiscoveryKey(
  candidate: Pick<ProblemCodeDiscoveryCandidate, "category" | "code">,
): string {
  return `${candidate.code}\0${candidate.category}`;
}

export function createProblemCodeRegistry(
  discoveries: readonly ProblemCodeDiscovery[],
  statusPolicies: Readonly<Record<string, ProblemStatusPolicy>> = {},
): ProblemCodeRegistry {
  const errors: string[] = [];
  const discoveriesByCode = new Map<string, ProblemCodeDiscovery[]>();

  for (const discovery of discoveries) {
    const existing = discoveriesByCode.get(discovery.code) ?? [];
    discoveriesByCode.set(discovery.code, [...existing, discovery]);
  }

  const problems: ProblemCodeRegistryEntry[] = [];

  for (const code of Object.keys(statusPolicies).sort()) {
    if (!discoveriesByCode.has(code)) {
      errors.push(`Status policy references unknown Problem code '${code}'.`);
    }
  }

  for (const [code, codeDiscoveries] of discoveriesByCode) {
    const categories = new Set(codeDiscoveries.map((discovery) => discovery.category));
    const sources = codeDiscoveries.flatMap((discovery) => discovery.sources).sort(compareSources);

    if (categories.size !== 1) {
      errors.push(
        `Problem code '${code}' has multiple categories: ${[...categories].sort().join(", ")}.`,
      );
      continue;
    }

    const [category] = categories;

    if (!category) {
      errors.push(`Problem code '${code}' did not resolve to a category.`);
      continue;
    }

    if (sources.length > 1) {
      errors.push(
        `Problem code '${code}' is declared ${sources.length} times: ${sources.map(formatSource).join(", ")}.`,
      );
      continue;
    }

    problems.push({
      code,
      category,
      status: toHttpStatus(category),
      ...(statusPolicies[code] ? { statusPolicy: statusPolicies[code] } : {}),
      title: toTitle(category),
      cookbookPath: `/reference/problem-recovery-cookbook/#${slugifyProblemCode(code)}`,
      recovery: recoveryMetadataByCode[code] ?? recoveryMetadataByCategory[category],
      lifecycle: createActiveProblemLifecycle(),
      sources,
    });
  }

  const registry = {
    version: "croco.problem-code-registry.v1",
    problemCount: problems.length,
    problems: problems.sort((left, right) => left.code.localeCompare(right.code)),
  } as const satisfies ProblemCodeRegistry;

  errors.push(...getProblemCodeRegistryValidationErrors(registry));

  if (errors.length > 0) {
    throw new ProblemRegistryValidationProblem(errors);
  }

  return registry;
}

export function createProblemRegistryArtifacts(
  registry: ProblemCodeRegistry,
): ReadonlyMap<string, string> {
  return new Map([
    [registryPath, `${JSON.stringify(registry, null, 2)}\n`],
    [cookbookPath, formatProblemRecoveryCookbook(registry)],
    [generatedRegistrySourcePath, formatGeneratedProblemRegistrySource(registry)],
  ]);
}

export function formatProblemRegistryArtifacts(
  artifacts: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const tempRoot = mkdtempSync(join(tmpdir(), "croco-problem-registry-format-"));

  try {
    const tempFiles: string[] = [];

    for (const [relativePath, content] of artifacts) {
      const tempFile = join(tempRoot, relativePath);
      mkdirSync(dirname(tempFile), { recursive: true });
      writeFileSync(tempFile, content);
      tempFiles.push(tempFile);
    }

    const result = spawnSync("pnpm", ["exec", "oxfmt", "--write", ...tempFiles], {
      cwd: repoRootDir,
      encoding: "utf-8",
    });

    if (result.status !== 0) {
      throw new Error(
        [
          "Failed to format generated Problem registry artifacts with oxfmt.",
          result.stdout.trim(),
          result.stderr.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    return new Map(
      [...artifacts.keys()].map((relativePath) => [
        relativePath,
        readFileSync(join(tempRoot, relativePath), "utf-8"),
      ]),
    );
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function syncProblemRegistryArtifacts(
  rootDir: string,
  artifacts: ReadonlyMap<string, string>,
  mode: ProblemRegistryMode,
): readonly string[] {
  const diagnostics: string[] = [];

  for (const [relativePath, content] of artifacts) {
    const absolutePath = join(rootDir, relativePath);

    if (mode === "write") {
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content);
      continue;
    }

    if (!existsSync(absolutePath)) {
      diagnostics.push(`${relativePath} is missing; run pnpm problem-registry:write.`);
      continue;
    }

    const current = readFileSync(absolutePath, "utf-8");

    if (current !== content) {
      diagnostics.push(`${relativePath} drift detected; run pnpm problem-registry:write.`);
    }
  }

  return diagnostics;
}

function readExistingProblemCodeRegistry(rootDir: string): ProblemCodeRegistry | null {
  const absolutePath = join(rootDir, registryPath);

  if (!existsSync(absolutePath)) {
    return null;
  }

  try {
    const value = JSON.parse(readFileSync(absolutePath, "utf-8")) as unknown;

    return isProblemCodeRegistryLike(value) ? value : null;
  } catch {
    return null;
  }
}

function readBaseProblemCodeRegistry(
  rootDir: string,
  options: ProblemRegistryRunOptions,
): ProblemCodeRegistry | null {
  if ("baseRegistry" in options) {
    return options.baseRegistry ?? null;
  }

  const baseRef = options.baseRef ?? getDefaultProblemRegistryBaseRef(rootDir);

  if (!baseRef) {
    return null;
  }

  const content = readGitFile(rootDir, baseRef, registryPath);

  if (!content) {
    return null;
  }

  try {
    const value = JSON.parse(content) as unknown;

    return isProblemCodeRegistryLike(value) ? value : null;
  } catch {
    return null;
  }
}

function getDefaultProblemRegistryBaseRef(rootDir: string): string | null {
  const candidates = env.GITHUB_BASE_REF
    ? [`origin/${env.GITHUB_BASE_REF}`]
    : ["origin/trunk", "trunk"];

  return candidates.find((candidate) => isGitCommitRef(rootDir, candidate)) ?? null;
}

function isGitCommitRef(rootDir: string, ref: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: rootDir,
    encoding: "utf-8",
  });

  return result.status === 0;
}

function readGitFile(rootDir: string, ref: string, path: string): string | null {
  const result = spawnSync("git", ["show", `${ref}:${toPosixPath(path)}`], {
    cwd: rootDir,
    encoding: "utf-8",
  });

  return result.status === 0 ? result.stdout : null;
}

function isProblemCodeRegistryLike(value: unknown): value is ProblemCodeRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly version?: unknown }).version === "croco.problem-code-registry.v1" &&
    Array.isArray((value as { readonly problems?: unknown }).problems)
  );
}

function mergeProblemRegistryBaselines(
  ...registries: readonly (ProblemCodeRegistry | null)[]
): ProblemCodeRegistry | null {
  const problemsByCode = new Map<string, ProblemCodeRegistryEntry>();
  const [firstRegistry] = registries.filter((registry): registry is ProblemCodeRegistry =>
    Boolean(registry),
  );

  if (!firstRegistry) {
    return null;
  }

  for (const registry of registries) {
    for (const problem of registry?.problems ?? []) {
      problemsByCode.set(problem.code, problem);
    }
  }

  const problems = [...problemsByCode.values()].sort((left, right) =>
    left.code.localeCompare(right.code),
  );

  return {
    ...firstRegistry,
    problemCount: problems.length,
    problems,
  };
}

function mergeDeprecatedProblemEntries(
  generatedRegistry: ProblemCodeRegistry,
  existingRegistry: ProblemCodeRegistry | null,
): ProblemCodeRegistry {
  if (!existingRegistry) {
    return generatedRegistry;
  }

  const generatedByCode = new Map(
    generatedRegistry.problems.map((problem) => [problem.code, problem]),
  );
  const mergedByCode = new Map(generatedByCode);

  for (const existingProblem of existingRegistry.problems) {
    if (getProblemLifecycleStatus(existingProblem) !== "deprecated") {
      continue;
    }

    const generatedProblem = generatedByCode.get(existingProblem.code);
    const deprecatedLifecycle = getProblemLifecycle(existingProblem);

    mergedByCode.set(
      existingProblem.code,
      generatedProblem
        ? { ...generatedProblem, lifecycle: deprecatedLifecycle }
        : {
            ...existingProblem,
            lifecycle: deprecatedLifecycle,
            sources: [],
          },
    );
  }

  const problems = [...mergedByCode.values()].sort((left, right) =>
    left.code.localeCompare(right.code),
  );

  return {
    ...generatedRegistry,
    problemCount: problems.length,
    problems,
  };
}

function getRegistryImplementationDiagnostics(
  baselineRegistry: ProblemCodeRegistry | null,
  registry: ProblemCodeRegistry,
): readonly string[] {
  if (!baselineRegistry) {
    return [];
  }

  const registryByCode = new Map(registry.problems.map((problem) => [problem.code, problem]));
  const diagnostics: string[] = [];

  for (const baselineProblem of baselineRegistry.problems) {
    const registryProblem = registryByCode.get(baselineProblem.code);

    if (
      getProblemLifecycleStatus(baselineProblem) === "deprecated" ||
      (registryProblem &&
        (registryProblem.sources.length > 0 ||
          getProblemLifecycleStatus(registryProblem) === "deprecated"))
    ) {
      continue;
    }

    diagnostics.push(
      `Problem code '${baselineProblem.code}' is registered but has no corresponding implementation; mark it deprecated with migration metadata before removing the source.`,
    );
  }

  return diagnostics;
}

function getProblemContractChangeDiagnostics(
  rootDir: string,
  existingRegistry: ProblemCodeRegistry | null,
  currentRegistry: ProblemCodeRegistry,
): readonly string[] {
  if (!existingRegistry) {
    return [];
  }

  const generatedByCode = new Map(
    currentRegistry.problems.map((problem) => [problem.code, problem]),
  );
  const diagnostics: string[] = [];

  for (const existingProblem of existingRegistry.problems) {
    const generatedProblem = generatedByCode.get(existingProblem.code);

    if (!generatedProblem) {
      continue;
    }

    const existingRetryability = existingProblem.recovery.retryability;
    const generatedRetryability = generatedProblem.recovery.retryability;
    const changedFields = [
      existingProblem.category === generatedProblem.category
        ? null
        : `category ${existingProblem.category} -> ${generatedProblem.category}`,
      existingProblem.status === generatedProblem.status
        ? null
        : `status ${existingProblem.status} -> ${generatedProblem.status}`,
      formatOptionalContractFieldChange(
        "statusPolicy",
        formatProblemStatusPolicy(existingProblem.statusPolicy),
        formatProblemStatusPolicy(generatedProblem.statusPolicy),
      ),
      existingRetryability === generatedRetryability
        ? null
        : `retryability ${existingRetryability} -> ${generatedRetryability}`,
      ...getProblemLifecycleChangeFields(existingProblem, generatedProblem),
    ].filter((field): field is string => field !== null);

    if (
      changedFields.length === 0 ||
      hasProblemContractChangeEvidence(rootDir, existingProblem.code)
    ) {
      continue;
    }

    diagnostics.push(
      `Problem code '${existingProblem.code}' changed ${changedFields.join(", ")} without an explicit changeset or migration note mentioning that code.`,
    );
  }

  return diagnostics;
}

function getProblemLifecycleChangeFields(
  existingProblem: ProblemCodeRegistryEntry,
  generatedProblem: ProblemCodeRegistryEntry,
): readonly string[] {
  const existingLifecycle = getProblemLifecycle(existingProblem);
  const generatedLifecycle = getProblemLifecycle(generatedProblem);
  const existingDeprecation = existingLifecycle.deprecation;
  const generatedDeprecation = generatedLifecycle.deprecation;

  return [
    existingLifecycle.status === generatedLifecycle.status
      ? null
      : `lifecycle ${existingLifecycle.status} -> ${generatedLifecycle.status}`,
    formatOptionalContractFieldChange(
      "deprecation.reason",
      existingDeprecation?.reason,
      generatedDeprecation?.reason,
    ),
    formatOptionalContractFieldChange(
      "deprecation.migrationNote",
      existingDeprecation?.migrationNote,
      generatedDeprecation?.migrationNote,
    ),
    formatOptionalContractFieldChange(
      "deprecation.replacementCode",
      existingDeprecation?.replacementCode,
      generatedDeprecation?.replacementCode,
    ),
    formatOptionalContractFieldChange(
      "deprecation.noReplacementReason",
      existingDeprecation?.noReplacementReason,
      generatedDeprecation?.noReplacementReason,
    ),
    formatOptionalContractFieldChange(
      "deprecation.since",
      existingDeprecation?.since,
      generatedDeprecation?.since,
    ),
  ].filter((field): field is string => field !== null);
}

function formatOptionalContractFieldChange(
  field: string,
  existingValue: string | undefined,
  generatedValue: string | undefined,
): string | null {
  if ((existingValue ?? "") === (generatedValue ?? "")) {
    return null;
  }

  return `${field} ${formatOptionalContractValue(existingValue)} -> ${formatOptionalContractValue(generatedValue)}`;
}

function formatOptionalContractValue(value: string | undefined): string {
  return value ? value : "(none)";
}

function hasProblemContractChangeEvidence(rootDir: string, code: string): boolean {
  return getProblemContractEvidencePaths(rootDir).some((relativePath) => {
    const absolutePath = join(rootDir, relativePath);

    return existsSync(absolutePath) && readFileSync(absolutePath, "utf-8").includes(code);
  });
}

function getProblemContractEvidencePaths(rootDir: string): readonly string[] {
  const paths = [join("docs", "release", "problem-code-migrations.md")];
  const changesetDir = join(rootDir, ".changeset");

  if (!existsSync(changesetDir)) {
    return paths;
  }

  for (const entry of readdirSync(changesetDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") {
      continue;
    }

    paths.push(join(".changeset", entry.name));
  }

  return paths.sort();
}

function getProblemRedactionDiagnostics(rootDir: string): readonly string[] {
  return getSourceFiles(rootDir).flatMap((file) =>
    getProblemRedactionDiagnosticsForFile(rootDir, file),
  );
}

function getProblemRedactionDiagnosticsForFile(rootDir: string, file: string): readonly string[] {
  const source = readFileSync(file, "utf-8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const diagnostics: string[] = [];
  const stringConstants = collectStringConstants(rootDir, sourceFile);

  function visit(node: ts.Node): void {
    if (
      ts.isObjectLiteralExpression(node) &&
      isProblemExtensionOptionsObject(sourceFile, node, stringConstants)
    ) {
      collectUnsafeExtensionDiagnostics(rootDir, sourceFile, node, diagnostics);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return diagnostics;
}

function isProblemExtensionOptionsObject(
  sourceFile: ts.SourceFile,
  node: ts.ObjectLiteralExpression,
  stringConstants: StringConstants,
): boolean {
  if (!hasObjectLiteralProperty(node, "extensions")) {
    return false;
  }

  if (getProblemMetadataObject(sourceFile, node, stringConstants)) {
    return true;
  }

  return isProblemConstructionArgument(sourceFile, node);
}

function hasObjectLiteralProperty(node: ts.ObjectLiteralExpression, propertyName: string): boolean {
  return node.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) && getPropertyName(property.name) === propertyName,
  );
}

function isProblemConstructionArgument(
  sourceFile: ts.SourceFile,
  node: ts.ObjectLiteralExpression,
): boolean {
  const expression = getExpressionArgumentContainer(node);
  const parent = expression.parent;

  if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === expression)) {
    if (parent.expression.kind === ts.SyntaxKind.SuperKeyword) {
      return true;
    }

    if (
      ts.isPropertyAccessExpression(parent.expression) &&
      parent.expression.expression.getText(sourceFile) === "ProblemFactory"
    ) {
      return true;
    }

    return getExpressionTerminalName(parent.expression)?.endsWith("Problem") ?? false;
  }

  return (
    ts.isNewExpression(parent) &&
    parent.arguments?.some((argument) => argument === expression) === true &&
    (getExpressionTerminalName(parent.expression)?.endsWith("Problem") ?? false)
  );
}

function getExpressionArgumentContainer(node: ts.Expression): ts.Expression {
  let expression = node;

  while (
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isAsExpression(expression.parent) ||
    ts.isSatisfiesExpression(expression.parent) ||
    (ts.isConditionalExpression(expression.parent) &&
      (expression.parent.whenTrue === expression || expression.parent.whenFalse === expression))
  ) {
    expression = expression.parent;
  }

  return expression;
}

function getExpressionTerminalName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  return null;
}

function collectUnsafeExtensionDiagnostics(
  rootDir: string,
  sourceFile: ts.SourceFile,
  node: ts.ObjectLiteralExpression,
  diagnostics: string[],
): void {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || getPropertyName(property.name) !== "extensions") {
      continue;
    }

    const initializer = unwrapExpression(property.initializer);

    if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
      continue;
    }

    collectUnsafeExtensionObjectDiagnostics(rootDir, sourceFile, initializer, diagnostics);
  }
}

function collectUnsafeExtensionObjectDiagnostics(
  rootDir: string,
  sourceFile: ts.SourceFile,
  node: ts.ObjectLiteralExpression,
  diagnostics: string[],
): void {
  for (const property of node.properties) {
    const key =
      ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
        ? getPropertyName(property.name)
        : null;

    if (!key) {
      continue;
    }

    const keyReason = getUnsafeExtensionKeyReason(key);
    if (keyReason) {
      diagnostics.push(
        formatUnsafeExtensionDiagnostic(rootDir, sourceFile, property.name, key, keyReason),
      );
    }

    if (ts.isPropertyAssignment(property)) {
      const initializer = unwrapExpression(property.initializer);
      const valueReason = initializer ? getUnsafeExtensionValueReason(initializer) : null;

      if (valueReason) {
        diagnostics.push(
          formatUnsafeExtensionDiagnostic(rootDir, sourceFile, initializer, key, valueReason),
        );
      }

      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        collectUnsafeExtensionObjectDiagnostics(rootDir, sourceFile, initializer, diagnostics);
      }
    }
  }
}

function getUnsafeExtensionKeyReason(key: string): string | null {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");

  if (
    [
      "raw",
      "rawbody",
      "rawrequest",
      "rawrequestbody",
      "requestbody",
      "request",
      "rawresponse",
      "responsebody",
      "providerresponse",
      "rawproviderresponse",
      "providerrequest",
      "upstreamresponse",
      "rawupstreamresponse",
      "upstreamrequest",
      "headers",
    ].includes(normalized)
  ) {
    return "raw request/provider payloads must be summarized and redacted before they enter Problem extensions";
  }

  if (
    [
      "authorization",
      "cookie",
      "credential",
      "password",
      "secret",
      "apikey",
      "privatekey",
      "accesskey",
      "accesstoken",
      "refreshtoken",
      "connectionstring",
      "databaseurl",
      "redisurl",
      "mongodburl",
      "postgresurl",
      "postgresqlurl",
      "dsn",
    ].includes(normalized)
  ) {
    return "secret-bearing values must not enter Problem extensions";
  }

  return null;
}

function getUnsafeExtensionValueReason(node: ts.Expression): string | null {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) {
    return null;
  }

  if (
    /\b(?:Bearer|Basic)\s+\S+/iu.test(node.text) ||
    /\b(?:password|secret|token|api[-_]?key|access[-_]?token)\s*[:=]\s*\S+/iu.test(node.text) ||
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/\S+/iu.test(node.text)
  ) {
    return "literal secret-looking values must be redacted before they enter Problem extensions";
  }

  return null;
}

function formatUnsafeExtensionDiagnostic(
  rootDir: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  key: string,
  reason: string,
): string {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

  return `Unsafe Problem extension '${key}' at ${toPosixPath(relative(rootDir, sourceFile.fileName))}:${location.line + 1}:${location.character + 1}: ${reason}.`;
}

function discoverProblemCodeCandidates(
  rootDir: string,
  file: string,
): readonly ProblemCodeDiscoveryCandidate[] {
  const source = readFileSync(file, "utf-8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const stringConstants = collectStringConstants(rootDir, sourceFile);
  const problemConstructors = collectProblemConstructorForwarders(sourceFile, stringConstants);
  const discoveries: ProblemCodeDiscoveryCandidate[] = [];
  const classProblemFieldStack: boolean[] = [];

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const classFieldProblem = getProblemClassFields(sourceFile, node, stringConstants);

      if (classFieldProblem) {
        discoveries.push(
          createCandidate(rootDir, sourceFile, classFieldProblem.node, classFieldProblem),
        );
      }

      classProblemFieldStack.push(Boolean(classFieldProblem));
      ts.forEachChild(node, visit);
      classProblemFieldStack.pop();
      return;
    }

    if (ts.isCallExpression(node)) {
      const superCall = classProblemFieldStack.at(-1)
        ? null
        : getProblemConstructorCall(sourceFile, node, stringConstants);

      if (superCall) {
        discoveries.push(createCandidate(rootDir, sourceFile, node, superCall));
      }

      const factoryCall = getProblemFactoryCall(sourceFile, node, stringConstants);

      if (factoryCall) {
        discoveries.push(createCandidate(rootDir, sourceFile, node, factoryCall));
      }
    }

    if (ts.isNewExpression(node)) {
      const constructorCall = getForwardedProblemConstructorCall(
        sourceFile,
        node,
        stringConstants,
        problemConstructors,
      );

      if (constructorCall) {
        discoveries.push(createCandidate(rootDir, sourceFile, node, constructorCall));
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const routeProblemProjection = isRouteProblemProjectionObject(node);
      const metadata = getProblemMetadataObject(sourceFile, node, stringConstants);

      if (metadata) {
        discoveries.push(
          createCandidate(rootDir, sourceFile, node, {
            ...metadata,
            ...(routeProblemProjection ? { routeProblemProjection } : {}),
          }),
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return discoveries;
}

function isRouteProblemProjectionObject(node: ts.ObjectLiteralExpression): boolean {
  const expression = getExpressionArgumentContainer(node);
  const parent = expression.parent;

  return (
    ts.isCallExpression(parent) &&
    parent.arguments[1] === expression &&
    getExpressionTerminalName(parent.expression) === "defineRouteProblem"
  );
}

function getProblemConstructorCall(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  stringConstants: StringConstants,
): Pick<ProblemCodeDiscoveryCandidate, "category" | "code" | "kind"> | null {
  if (node.expression.kind !== ts.SyntaxKind.SuperKeyword) {
    return null;
  }

  const code = getStringValue(sourceFile, node.arguments[0], stringConstants);
  const category = getProblemCategory(sourceFile, node.arguments[1]);

  return code && category ? { code, category, kind: "problem-constructor" } : null;
}

function getProblemFactoryCall(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  stringConstants: StringConstants,
): Pick<ProblemCodeDiscoveryCandidate, "category" | "code" | "kind"> | null {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }

  if (node.expression.expression.getText(sourceFile) !== "ProblemFactory") {
    return null;
  }

  const code = getStringValue(sourceFile, node.arguments[0], stringConstants);
  const category = factoryMethodCategory[node.expression.name.text];

  return code && category ? { code, category, kind: "problem-factory" } : null;
}

function getForwardedProblemConstructorCall(
  sourceFile: ts.SourceFile,
  node: ts.NewExpression,
  stringConstants: StringConstants,
  problemConstructors: ReadonlyMap<string, ProblemConstructorForwarder>,
): Pick<ProblemCodeDiscoveryCandidate, "category" | "code" | "kind"> | null {
  if (!ts.isIdentifier(node.expression)) {
    return null;
  }

  const constructor = problemConstructors.get(node.expression.text);

  if (!constructor) {
    return null;
  }

  const args = node.arguments ?? [];
  const code =
    constructor.code ??
    (constructor.codeArgumentIndex === undefined
      ? null
      : getStringValue(sourceFile, args[constructor.codeArgumentIndex], stringConstants));
  const category =
    constructor.category ??
    (constructor.categoryArgumentIndex === undefined
      ? null
      : getProblemCategory(sourceFile, args[constructor.categoryArgumentIndex]));

  return code && category ? { code, category, kind: "problem-constructor" } : null;
}

function getProblemMetadataObject(
  sourceFile: ts.SourceFile,
  node: ts.ObjectLiteralExpression,
  stringConstants: StringConstants,
): Pick<ProblemCodeDiscoveryCandidate, "category" | "code" | "kind"> | null {
  let code: string | null = null;
  let category: ProblemCategory | null = null;

  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const name = getPropertyName(property.name);

    if (name === "code") {
      code = getStringValue(sourceFile, property.initializer, stringConstants);
    }

    if (name === "category") {
      category = getProblemCategory(sourceFile, property.initializer);
    }
  }

  return code && category ? { code, category, kind: "problem-metadata" } : null;
}

function getProblemClassFields(
  sourceFile: ts.SourceFile,
  node: ts.ClassDeclaration | ts.ClassExpression,
  stringConstants: StringConstants,
):
  | (Pick<ProblemCodeDiscoveryCandidate, "category" | "code" | "kind"> & { readonly node: ts.Node })
  | null {
  let code: string | null = null;
  let category: ProblemCategory | null = null;

  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member)) {
      continue;
    }

    const name = getPropertyName(member.name);

    if (name === "code") {
      code = getStringValue(sourceFile, member.initializer, stringConstants);
    }

    if (name === "category") {
      category = getProblemCategory(sourceFile, member.initializer);
    }
  }

  return code && category
    ? {
        code,
        category,
        kind: "problem-class",
        node,
      }
    : null;
}

function createCandidate(
  rootDir: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  discovery: Pick<
    ProblemCodeDiscoveryCandidate,
    "category" | "code" | "kind" | "routeProblemProjection"
  >,
): ProblemCodeDiscoveryCandidate {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

  return {
    ...discovery,
    file: toPosixPath(relative(rootDir, sourceFile.fileName)),
    line: location.line + 1,
    column: location.character + 1,
  };
}

function getSourceFiles(rootDir: string): readonly string[] {
  const packagesDir = join(rootDir, "packages");

  if (!existsSync(packagesDir)) {
    return [];
  }

  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (shouldSkipPath(entry.name)) {
        continue;
      }

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (isProductionTypeScriptFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  walk(packagesDir);

  return files.sort();
}

function isProductionTypeScriptFile(file: string): boolean {
  const normalizedFile = toPosixPath(file);
  const isTypeScript = [".ts", ".tsx", ".mts", ".cts"].some((extension) =>
    file.endsWith(extension),
  );
  const isDeclarationFile = [".d.ts", ".d.mts", ".d.cts"].some((extension) =>
    file.endsWith(extension),
  );
  const isTestFile =
    file.endsWith(".spec.ts") ||
    file.endsWith(".spec.tsx") ||
    file.endsWith(".spec.mts") ||
    file.endsWith(".spec.cts") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.endsWith(".test.mts") ||
    file.endsWith(".test.cts");

  return (
    isTypeScript &&
    !isDeclarationFile &&
    !isTestFile &&
    !normalizedFile.split("/").includes("tests") &&
    !normalizedFile.split("/").includes("__fixtures__") &&
    !normalizedFile.includes("/src/generated/")
  );
}

function shouldSkipPath(name: string): boolean {
  return name === "node_modules" || name === "dist" || name === ".turbo" || name === "coverage";
}

function collectStringConstants(rootDir: string, sourceFile: ts.SourceFile): StringConstants {
  return mergeStringConstants(
    collectImportedStringConstants(rootDir, sourceFile),
    collectLocalStringConstants(sourceFile),
  );
}

function collectLocalStringConstants(sourceFile: ts.SourceFile): StringConstants {
  const identifiers = new Map<string, string>();
  const propertyAccesses = new Map<string, string>();

  function collect(node: ts.Node): void {
    if (ts.isEnumDeclaration(node)) {
      for (const member of node.members) {
        const name = getPropertyName(member.name);
        const initializer = unwrapExpression(member.initializer);

        if (
          name &&
          initializer &&
          (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
        ) {
          propertyAccesses.set(`${node.name.text}.${name}`, initializer.text);
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = unwrapExpression(node.initializer);

      if (
        initializer &&
        (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
      ) {
        identifiers.set(node.name.text, initializer.text);
      }

      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        collectObjectLiteralStringProperties(node.name.text, initializer, propertyAccesses);
      }
    }

    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member) || !hasStaticModifier(member)) {
          continue;
        }

        const name = getPropertyName(member.name);
        const initializer = unwrapExpression(member.initializer);

        if (
          name &&
          initializer &&
          (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
        ) {
          propertyAccesses.set(`${node.name.text}.${name}`, initializer.text);
        }
      }
    }

    ts.forEachChild(node, collect);
  }

  collect(sourceFile);

  return { identifiers, propertyAccesses };
}

function collectImportedStringConstants(
  rootDir: string,
  sourceFile: ts.SourceFile,
): StringConstants {
  const identifiers = new Map<string, string>();
  const propertyAccesses = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }

    const namedBindings = statement.importClause.namedBindings;

    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    const importedSourceFile = resolveImportedSourceFile(
      rootDir,
      sourceFile,
      statement.moduleSpecifier,
    );

    if (!importedSourceFile) {
      continue;
    }

    const importedConstants = collectLocalStringConstants(importedSourceFile);

    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const localName = element.name.text;
      const importedValue = importedConstants.identifiers.get(importedName);

      if (importedValue) {
        identifiers.set(localName, importedValue);
      }

      for (const [key, value] of importedConstants.propertyAccesses) {
        if (key === importedName || key.startsWith(`${importedName}.`)) {
          propertyAccesses.set(`${localName}${key.slice(importedName.length)}`, value);
        }
      }
    }
  }

  return { identifiers, propertyAccesses };
}

function mergeStringConstants(...sources: readonly StringConstants[]): StringConstants {
  const identifiers = new Map<string, string>();
  const propertyAccesses = new Map<string, string>();

  for (const source of sources) {
    for (const [key, value] of source.identifiers) {
      identifiers.set(key, value);
    }

    for (const [key, value] of source.propertyAccesses) {
      propertyAccesses.set(key, value);
    }
  }

  return { identifiers, propertyAccesses };
}

const IMPORTED_SOURCE_FILE_CACHE = new Map<string, ts.SourceFile>();

function resolveImportedSourceFile(
  rootDir: string,
  sourceFile: ts.SourceFile,
  moduleSpecifier: ts.Expression,
): ts.SourceFile | null {
  if (!ts.isStringLiteral(moduleSpecifier) || !moduleSpecifier.text.startsWith(".")) {
    return null;
  }

  const importedPath = resolve(dirname(sourceFile.fileName), moduleSpecifier.text);
  const sourcePath = importedPath.replace(/\.(cjs|js|jsx|mjs)$/u, "");
  const candidates = [
    importedPath,
    `${sourcePath}.ts`,
    `${sourcePath}.tsx`,
    `${sourcePath}.mts`,
    `${sourcePath}.cts`,
    join(sourcePath, "index.ts"),
    join(sourcePath, "index.tsx"),
    join(sourcePath, "index.mts"),
    join(sourcePath, "index.cts"),
  ];
  const sourceFilePath = candidates.find((candidate) => {
    const normalizedCandidate = resolve(candidate);

    return isPathInsideRoot(rootDir, normalizedCandidate) && isFile(normalizedCandidate);
  });

  if (!sourceFilePath) {
    return null;
  }

  const cached = IMPORTED_SOURCE_FILE_CACHE.get(sourceFilePath);
  if (cached) {
    return cached;
  }

  const source = readFileSync(sourceFilePath, "utf-8");

  const parsed = ts.createSourceFile(
    sourceFilePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourceFilePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  IMPORTED_SOURCE_FILE_CACHE.set(sourceFilePath, parsed);

  return parsed;
}

function isPathInsideRoot(rootDir: string, candidate: string): boolean {
  const relativePath = relative(rootDir, candidate);

  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function collectProblemConstructorForwarders(
  sourceFile: ts.SourceFile,
  stringConstants: StringConstants,
): ReadonlyMap<string, ProblemConstructorForwarder> {
  const problemConstructors = new Map<string, ProblemConstructorForwarder>();

  function collect(node: ts.Node): void {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
      const constructor = node.members.find(ts.isConstructorDeclaration);
      const forwarder = constructor
        ? getProblemConstructorForwarder(sourceFile, constructor, stringConstants)
        : null;

      if (forwarder) {
        problemConstructors.set(node.name.text, forwarder);
      }
    }

    ts.forEachChild(node, collect);
  }

  collect(sourceFile);

  return problemConstructors;
}

function getProblemConstructorForwarder(
  sourceFile: ts.SourceFile,
  constructor: ts.ConstructorDeclaration,
  stringConstants: StringConstants,
): ProblemConstructorForwarder | null {
  let forwarder: ProblemConstructorForwarder | null = null;

  function visit(node: ts.Node): void {
    if (forwarder) {
      return;
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      const code = getStringValue(sourceFile, node.arguments[0], stringConstants);
      const category = getProblemCategory(sourceFile, node.arguments[1]);
      const codeArgumentIndex = getConstructorParameterIndex(constructor, node.arguments[0]);
      const categoryArgumentIndex = getConstructorParameterIndex(constructor, node.arguments[1]);

      if (code && category) {
        return;
      }

      if (
        (!code && codeArgumentIndex === undefined) ||
        (!category && categoryArgumentIndex === undefined)
      ) {
        return;
      }

      forwarder = {
        ...(code ? { code } : {}),
        ...(codeArgumentIndex === undefined ? {} : { codeArgumentIndex }),
        ...(category ? { category } : {}),
        ...(categoryArgumentIndex === undefined ? {} : { categoryArgumentIndex }),
      };
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(constructor);

  return forwarder;
}

function getConstructorParameterIndex(
  constructor: ts.ConstructorDeclaration,
  node: ts.Node | undefined,
): number | undefined {
  const expression = unwrapExpression(node);

  if (!expression || !ts.isIdentifier(expression)) {
    return undefined;
  }

  const parameterIndex = constructor.parameters.findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === expression.text,
  );

  return parameterIndex === -1 ? undefined : parameterIndex;
}

function collectObjectLiteralStringProperties(
  baseName: string,
  object: ts.ObjectLiteralExpression,
  propertyAccesses: Map<string, string>,
): void {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const name = getPropertyName(property.name);
    const initializer = unwrapExpression(property.initializer);

    if (
      name &&
      initializer &&
      (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
    ) {
      propertyAccesses.set(`${baseName}.${name}`, initializer.text);
    }
  }
}

function getStringValue(
  sourceFile: ts.SourceFile,
  node: ts.Node | undefined,
  stringConstants: StringConstants,
): string | null {
  const expression = unwrapExpression(node);

  if (!expression) {
    return null;
  }

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }

  if (ts.isIdentifier(expression)) {
    return (
      stringConstants.identifiers.get(expression.text) ??
      getConstructorParameterDefaultString(sourceFile, expression, stringConstants)
    );
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return stringConstants.propertyAccesses.get(expression.getText(sourceFile)) ?? null;
  }

  return null;
}

function getConstructorParameterDefaultString(
  sourceFile: ts.SourceFile,
  identifier: ts.Identifier,
  stringConstants: StringConstants,
): string | null {
  let current: ts.Node | undefined = identifier.parent;

  while (current) {
    if (ts.isConstructorDeclaration(current)) {
      const parameter = current.parameters.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text,
      );

      return parameter?.initializer
        ? getStringValue(sourceFile, parameter.initializer, stringConstants)
        : null;
    }

    current = current.parent;
  }

  return null;
}

function unwrapExpression(node: ts.Node | undefined): ts.Expression | undefined {
  if (!node || !ts.isExpression(node)) {
    return undefined;
  }

  let expression: ts.Expression = node;

  while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    expression = expression.expression;
  }

  return expression;
}

function hasStaticModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword),
  );
}

function getProblemCategory(
  sourceFile: ts.SourceFile,
  node: ts.Node | undefined,
): ProblemCategory | null {
  if (!node || !ts.isPropertyAccessExpression(node)) {
    return null;
  }

  if (node.expression.getText(sourceFile) !== "ProblemCategory") {
    return null;
  }

  const category = ProblemCategory[node.name.text as keyof typeof ProblemCategory];

  return category ?? null;
}

function getPropertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

const telemetryAttributes = ["problem.code", "problem.category", "problem.status"] as const;

const statusPolicyByCode: Partial<Record<string, ProblemStatusPolicy>> = {
  "transports-http/request-body-too-large": {
    kind: "runtime-configurable",
    defaultStatus: 413,
    configuration: "bodyLimitMiddleware.statusCode",
  },
};

function getApplicableStatusPolicies(
  rootDir: string,
): Readonly<Record<string, ProblemStatusPolicy>> {
  const policies: Record<string, ProblemStatusPolicy> = {};

  for (const [code, policy] of Object.entries(statusPolicyByCode)) {
    const [packageName] = code.split("/");

    if (policy && packageName && existsSync(join(rootDir, "packages", packageName))) {
      policies[code] = policy;
    }
  }

  return policies;
}

const recoveryMetadataByCategory = {
  [ProblemCategory.BadRequest]: recovery({
    cause: "The caller sent malformed input or unsupported request options.",
    userAction: "Correct the request input and retry after validation passes.",
    operatorAction: "Inspect validation details and request logs; do not retry unchanged input.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
  [ProblemCategory.Unauthorized]: recovery({
    cause: "The request did not include valid authentication credentials.",
    userAction: "Sign in again or provide a valid credential.",
    operatorAction: "Check authentication configuration, token issuer, and clock skew.",
    retryability: "not-retryable",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  [ProblemCategory.Forbidden]: recovery({
    cause: "The authenticated caller is not allowed to perform the requested action.",
    userAction: "Request the required permission or choose an allowed action.",
    operatorAction: "Review policy, role, tenant, entitlement, and impersonation context.",
    retryability: "not-retryable",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  [ProblemCategory.NotFound]: recovery({
    cause: "The requested resource or route-visible record does not exist.",
    userAction: "Verify the identifier and refresh the resource list before retrying.",
    operatorAction: "Confirm tenant scoping, data retention, and backing-store lookup behavior.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
  [ProblemCategory.Conflict]: recovery({
    cause: "The request conflicts with current state or an idempotency constraint.",
    userAction: "Refresh state, resolve the conflict, and retry with the updated intent.",
    operatorAction: "Inspect concurrent writes, idempotency keys, and uniqueness constraints.",
    retryability: "conditional",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  [ProblemCategory.Gone]: recovery({
    cause: "The requested resource is no longer available through this API surface.",
    userAction: "Stop using the stale reference and follow the replacement flow when available.",
    operatorAction: "Verify lifecycle, migration, deprecation, and retention state.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
  [ProblemCategory.PayloadTooLarge]: recovery({
    cause: "The request body exceeded the configured byte limit.",
    userAction: "Reduce the request body and retry.",
    operatorAction:
      "Confirm route body limits and upstream proxy limits match the intended upload policy.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
  [ProblemCategory.ValidationError]: recovery({
    cause: "The request or generated contract failed schema or semantic validation.",
    userAction: "Fix the invalid fields and retry with schema-conformant input.",
    operatorAction: "Inspect schema diagnostics, generated contracts, and validation metadata.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
  [ProblemCategory.BusinessRuleViolation]: recovery({
    cause: "The request is syntactically valid but violates a domain rule.",
    userAction: "Change the workflow state or request values so the business rule is satisfied.",
    operatorAction: "Review domain policy, entitlement, quota, and lifecycle rule evidence.",
    retryability: "conditional",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  [ProblemCategory.TooManyRequests]: recovery({
    cause: "The caller exceeded a rate, quota, or concurrency limit.",
    userAction: "Wait for the retry window or reduce request volume.",
    operatorAction: "Check limiter state, quota configuration, and abuse signals.",
    retryability: "retryable",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  [ProblemCategory.InternalServerError]: recovery({
    cause: "Croco or an upstream dependency failed after accepting the request.",
    userAction:
      "Retry later only when the operation is idempotent or the caller owns retry safety.",
    operatorAction: "Use traces, logs, and upstream diagnostics to isolate the failing boundary.",
    retryability: "conditional",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  [ProblemCategory.NotImplemented]: recovery({
    cause: "The requested capability is not supported by this runtime or adapter.",
    userAction: "Use a supported capability or choose an adapter/runtime that provides it.",
    operatorAction: "Check runtime capability declarations and provider maturity documentation.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
} as const satisfies Record<ProblemCategory, ProblemRecoveryMetadata>;

const recoveryMetadataByCode = {
  "workflow-core/workflow-execution-in-progress": recovery({
    cause: "Another invocation owns a pending or running workflow with the same idempotency key.",
    userAction: "Retry the same request after the owning execution finishes.",
    operatorAction:
      "Inspect the execution status and reconcile abandoned executions before retrying.",
    retryability: "retryable",
    redactionPolicy: "operator-only",
    severity: "warning",
  }),
  "workflow-core/workflow-execution-failed": recovery({
    cause: "The workflow matched a previously failed or timed-out execution.",
    userAction: "Inspect the original failure before requesting an explicit replay.",
    operatorAction:
      "Resolve the persisted failure and reconcile possible side effects before replaying.",
    retryability: "conditional",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  CROCO_SAAS_PROFILE_MISMATCH: recovery({
    cause: "The generated profile and requested profile do not match.",
    userAction: "Select the generated profile or correct the explicit profile override.",
    operatorAction: "Compare the generated manifest with the requested profile override.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
  "idempotency-core/execution-indeterminate": recovery({
    cause:
      "The idempotent handler completed its side effects but the coordinator could not persist the result.",
    userAction:
      "Do not retry with the same idempotency key; check the external system for the completed outcome.",
    operatorAction:
      "Inspect the idempotency store failure and reconcile the completed side effects before clearing the record.",
    retryability: "not-retryable",
    redactionPolicy: "safe-message",
    severity: "error",
  }),
  "access-core/invalid-provider-result": recovery({
    cause: "AccessProvider.check() returned a result without a supported authoritative decision.",
    userAction:
      "Do not retry the unchanged operation; report the access provider and version to the service operator.",
    operatorAction:
      "Fix or upgrade the AccessProvider implementation so check() returns allow, deny, or abstain with the matching compatibility boolean.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "testing-resources/missing-live-dependency": recovery({
    cause:
      "A PostgreSQL or Redis test resource was started without its required optional live driver.",
    userAction:
      "Run the exact command in extensions.installCommand, then retry the live-resource test.",
    operatorAction:
      "Inspect extensions.dependency and extensions.resourceKind, install the matching optional peer dependencies, and confirm Docker is available before retrying.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "error",
  }),
  "audit-core/client-ip-policy-invalid": recovery({
    cause:
      "AuditInterceptor received trustedProxyHops outside the nonnegative safe-integer domain.",
    userAction:
      "Ask the operator to correct the audit client IP policy before the application is started again.",
    operatorAction:
      "Set trustedProxyHops to a nonnegative safe integer, then reconstruct AuditInterceptor and restart the service.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "batch-core/invalid-chunk-size": recovery({
    cause:
      "The batch Step or QStash execution configured chunkSize outside the positive safe-integer domain.",
    userAction: "Set chunkSize to a positive safe integer, then restart the batch execution.",
    operatorAction:
      "Inspect receivedChunkSize and the Step or QStash execution configuration before restarting execution.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
  "create-croco-app/generated-dependency-range-missing": recovery({
    cause:
      "The create-croco-app package metadata does not declare the generated dependency range required for application scaffolding.",
    userAction:
      "Reinstall create-croco-app after its package metadata has been corrected; do not retry with the unchanged package.",
    operatorAction:
      "Set the workspace catalog range, run pnpm package-manifests:write, rebuild or publish create-croco-app, and verify crocoGeneratedAppDependencies before retrying.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "auth-clerk/unexpected-tenant-mapping-claim": recovery({
    cause: "TenantMappingStore.claim() returned a result outside the supported claim contract.",
    userAction:
      "Do not retry the unchanged operation; report the tenant mapping store and version to the service operator.",
    operatorAction:
      "Fix or upgrade the TenantMappingStore implementation so claim() returns created or existing with the authoritative tenant ID.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "framework-context/shutdown-hook-registration-closed": recovery({
    cause:
      "Shutdown hook registration was attempted after the current manager started shutting down.",
    userAction:
      "Reset ShutdownManager, acquire the new manager, and register hooks before its shutdown starts.",
    operatorAction:
      "Register services and decorators during bootstrap, and do not reuse a manager reference after reset.",
    retryability: "not-retryable",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  "framework-config/runtime-env-preset-boundary": recovery({
    cause:
      "A selected runtime env preset exposed a client variable without the `NEXT_PUBLIC_` prefix or exposed a server variable with that prefix.",
    userAction:
      "Correct the `NEXT_PUBLIC_` prefix or remove the incompatible preset from defineRuntimeEnv, then retry configuration validation.",
    operatorAction:
      "Inspect the reported preset section and variable name, then keep public `NEXT_PUBLIC_` variables in client and private variables in server.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
  "framework-module/lifecycle-cancelled": recovery({
    cause: "A parent AbortSignal cancelled the module lifecycle hook before it completed.",
    userAction:
      "Retry only when the cancellation reason permits it and the lifecycle operation is safe to repeat.",
    operatorAction:
      "Inspect the parent cancellation reason and propagate AbortSignal support through cancellable lifecycle work.",
    retryability: "conditional",
    redactionPolicy: "operator-only",
    severity: "warning",
  }),
  "framework-module/lifecycle-deadline-exceeded": recovery({
    cause: "The module lifecycle hook did not complete before its absolute deadline.",
    userAction:
      "Retry only when the lifecycle operation is safe to repeat and the service has enough time to complete it.",
    operatorAction:
      "Inspect the slow lifecycle hook, reduce its work or increase the deadline, and preserve cancellation propagation.",
    retryability: "conditional",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "framework-module/registration-lifecycle-conflict": recovery({
    cause:
      "Module registration was attempted while the registry was initializing, initialized, or shutting down.",
    userAction:
      "Call CrocoModule.shutdown() or CrocoModule.reset(), then register and initialize the new module graph.",
    operatorAction:
      "Inspect module lifecycle ownership and ensure graph registration occurs only while the registry is idle.",
    retryability: "not-retryable",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  "auth-clerk/webhook-delivery-failed": recovery({
    cause:
      "The idempotency store contains a terminal failure for this Clerk deliveryId and eventType.",
    userAction:
      "Do not replay the delivery until the stored failure cause has been verified and corrected.",
    operatorAction:
      "Inspect the stored delivery result and preserved cause for the reported deliveryId and eventType, correct the mutation failure, then decide whether to clear or replay the record after idempotencyTtlMs expires.",
    retryability: "not-retryable",
    redactionPolicy: "safe-message",
    severity: "error",
  }),
  "auth-clerk/webhook-delivery-in-flight": recovery({
    cause:
      "Another worker currently owns the Clerk delivery reservation for this deliveryId and eventType.",
    userAction:
      "Retry the same delivery after the active worker completes or after the configured idempotencyTtlMs expires.",
    operatorAction:
      "Inspect concurrent worker state for the reported deliveryId and eventType; if the owner was abandoned, wait for idempotencyTtlMs expiry before retrying.",
    retryability: "retryable",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  "llm-core/completion-event-publication-failed": recovery({
    cause:
      "The model completed billable work, but its completion event was not durably confirmed afterward.",
    userAction:
      "Hand the opaque failure reference to an operator; do not invoke the model again or manually publish the completion event.",
    operatorAction:
      "Use retryCompletionEvent with the in-process Problem or saved intent: published_unconfirmed confirms storage without republishing, delivery_in_progress waits for the active claim, and not_published atomically claims delivery before publishing. Never publish the event manually.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  IMPERSONATION_LIFECYCLE_PUBLICATION_PENDING: recovery({
    cause:
      "The impersonation session mutation committed, but its lifecycle event remains pending at the reported publish, acknowledge, or predecessor stage.",
    userAction:
      "Do not repeat the original session mutation; ask the service operator to reconcile the pending lifecycle event.",
    operatorAction:
      "Inspect the Problem reconciliationState and stage, call getLifecycleDiagnostics() to confirm reconciliation_required, then call publishPendingEvents() to replay and acknowledge the stored intent.",
    retryability: "conditional",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "llm-metering/service-required": recovery({
    cause:
      "@AiMetered required usage recording, but no scoped or global LlmMeteringService was configured.",
    userAction:
      "Do not retry the unchanged operation; ask the service operator to configure LLM metering or explicitly disable it for an intentionally unmetered method.",
    operatorAction:
      'Bind LlmMeteringService at bootstrap with setLlmMeteringService(), bind it per execution with runWithLlmMeteringService(), or set @AiMetered({ metering: "disabled" }) only when skipping usage recording is intentional.',
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "billing/checkout-idempotency-drift": recovery({
    cause:
      "The generated billing drill detected more than one committed checkout after response-loss retries completed.",
    userAction:
      "Do not retry checkout again; report the affected checkout intent for investigation and reconciliation.",
    operatorAction:
      "Inspect the checkout idempotency key, provider attempts, and committed records, then reconcile duplicate checkout state before resuming the flow.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "preset-node/lifecycle-conflict": recovery({
    cause: "start() was called on a Node entry that is closing or already closed.",
    userAction: "Wait for closure to finish, then create a new entry to start another server.",
    operatorAction: "Inspect Node entry ownership and the ordering of start() and close() calls.",
    retryability: "not-retryable",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  "preset-node/lifecycle-io-failed": recovery({
    cause: "The Node server failed while starting or closing an entry.",
    userAction: "Retry only after the server or socket failure has been investigated.",
    operatorAction: "Inspect the preserved cause and the reported lifecycle operation.",
    retryability: "conditional",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "auth-core/invalid-route-metadata-target": recovery({
    cause:
      "An authentication guard received a route metadata target that was neither an object nor a function.",
    userAction:
      "Do not retry the unchanged request; ask the service operator to correct the route metadata configuration.",
    operatorAction:
      "Inspect the route adapter metadata target and ensure it returns the controller object or constructor before handling requests.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "create-croco-app/unsupported-node-version": recovery({
    cause: "The detected Node.js version is outside the supported generated-app toolchain train.",
    userAction: `Install and activate Node.js ${VERSIONS.node} with \`nvm install ${VERSIONS.node} && nvm use ${VERSIONS.node}\`, then rerun the command.`,
    operatorAction: `Compare the reported actual Node.js version with the supported Node.js ${VERSIONS.node} train and verify the active version-manager configuration.`,
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "error",
  }),
  "frontend-react/page-data-unavailable": recovery({
    cause:
      "A component required page data, but PageDataProvider was missing or its data value was undefined.",
    userAction:
      "Do not retry the unchanged render; ensure the component is inside PageDataProvider with a defined data value.",
    operatorAction:
      "Inspect the SSR and hydration entrypoint, then wire PageDataProvider with the route page data before rendering the component.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "error",
  }),
  "testing/contract-generation-unsupported": recovery({
    cause:
      "Automatic contract-case generation encountered a schema shape outside its deterministic supported subset.",
    userAction:
      "Use supported Zod constructs or provide a caller-owned arbitrary for the unsupported schema.",
    operatorAction:
      "Inspect the reported schema path and shape, then replace it with a supported contract or supply an explicit arbitrary.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
  "testing/contract-invariant-failed": recovery({
    cause:
      "A generated or replayed case violated its route classification, response contract, shrink reproduction, or serialization invariant.",
    userAction:
      "Reproduce the saved counterexample with its seed and path after the contract runner or route behavior is corrected.",
    operatorAction:
      "Inspect the failure artifact, route classification, executor observation, and shrink path to locate the violated invariant.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "testing/contract-runtime-mismatch": recovery({
    cause:
      "Runtime observations disagree with each other or with the declared capability and trace-propagation contracts.",
    userAction:
      "Use a runtime build whose observed behavior matches the route and capability manifests before retrying the comparison.",
    operatorAction:
      "Compare the reported runtime observations, lifecycle capability manifests, stable headers, and trace propagation evidence.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "testing/contract-execution-failed": recovery({
    cause: "The contract executor threw an unexpected non-Problem failure while exercising a case.",
    userAction:
      "Reproduce the saved counterexample only after the executor or underlying runtime failure is diagnosed.",
    operatorAction:
      "Inspect the failure artifact and runtime logs, then convert expected failures into declared Problems or repair the executor boundary.",
    retryability: "conditional",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "metering/billable-usage-journal-required": recovery({
    cause:
      "A meter declares billing as required, but MeterRegistry validation cannot find a persistent BillableUsageJournal.",
    userAction:
      "Do not retry with the same configuration; connect a persistent journal or change the meter billing contract first.",
    operatorAction:
      "Configure a persistent BillableUsageJournal before loadAll, lazy meter lookup, or registration validates a billing-required meter.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "retry-core/success-hook-failed": recovery({
    cause:
      "The business callback completed successfully, but its onSuccess observation hook failed afterward.",
    userAction:
      "Do not repeat the business operation from this failure; report the hook failure while preserving the successful callback outcome.",
    operatorAction:
      "Inspect the original cause and repair the named onSuccess listener or telemetry path without replaying the completed callback.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "migration-runner/history-drift": recovery({
    cause:
      "Recorded migration history no longer matches the available migration files by stable id and name.",
    userAction:
      "Restore the original migration file identity or ask an operator to perform an explicitly verified history repair.",
    operatorAction:
      "Compare the checkpoint rows with version-controlled migration files, restore missing or renamed files when possible, and repair history only after verifying the deployed schema.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "error",
  }),
  "tx-drizzle/rls-configuration-invalid": recovery({
    cause:
      "A PostgreSQL RLS helper received malformed static identifier or setting-key configuration.",
    userAction: "Ask the operator to correct the RLS configuration before retrying.",
    operatorAction:
      "Use the reported field name and the @croco/tx-drizzle RLS contract to correct the configuration, then restart the service.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "tx-drizzle/rls-debug-logging-failed": recovery({
    cause: "Requested RLS debug logging could not initialize or write its diagnostic event.",
    userAction: "Ask the operator to restore the configured logger before retrying.",
    operatorAction:
      "Provide an RlsLogger or register the framework Logger, then verify its info() output path before retrying the transaction.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "transports-http/graceful-shutdown-configuration": recovery({
    cause: "Graceful shutdown was configured with a non-finite total or event-bus drain timeout.",
    userAction:
      "Ask the operator to correct the graceful shutdown timeout configuration before reconstructing the HTTP application.",
    operatorAction:
      "Set timeoutMs and eventBusDrainTimeoutMs to finite numbers, then reconstruct the middleware or controller before retrying shutdown.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "transports-http/graceful-shutdown-timeout": recovery({
    cause:
      "Graceful shutdown did not finish a phase before that phase's configured deadline elapsed.",
    userAction:
      "Wait for the stalled shutdown phase to be investigated before retrying; active requests or cleanup work may still be settling.",
    operatorAction:
      "Inspect the reported phase, timeoutMs, and elapsedMs extensions, then investigate slow request handlers, event-bus draining, or shutdown hooks.",
    retryability: "conditional",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "transports-http/diagnostics-invalid-configuration": recovery({
    cause:
      "The operational diagnostics endpoint was configured with an invalid response-size limit.",
    userAction: "Ask the operator to correct the service configuration before retrying.",
    operatorAction:
      "Set recentErrorLimit to a finite nonnegative safe integer and messageLimit to a finite positive safe integer, then restart the service.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "transports-http/body-limit-invalid-configuration": recovery({
    cause: "The HTTP body-limit middleware was configured with an invalid byte boundary.",
    userAction: "Ask the operator to correct the service configuration before retrying.",
    operatorAction:
      "Set the body-limit value to a finite, nonnegative safe integer and restart the service.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "telemetry-sdk-node/batch-configuration-invalid": recovery({
    cause:
      "BatchSpanProcessor tuning violates the telemetry timeout, queue-size, or export-batch contract.",
    userAction:
      "Ask the operator to correct the telemetry batch configuration before restarting the service.",
    operatorAction:
      "Use the reported field and constraint to set batchTimeout within 0..2147483647, batchCount and batchSize within 1..2147483647, and batchSize no greater than batchCount.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "telemetry-sdk-node/shutdown-timeout": recovery({
    cause:
      "The OpenTelemetry SDK did not complete exporter teardown within the configured shutdown deadline.",
    userAction:
      "Do not reinitialize telemetry yet; retry shutdown after the stalled exporter or SDK teardown has been investigated.",
    operatorAction:
      "Inspect exporter and SDK shutdown diagnostics for the reported timeoutMillis, then retry shutdown() to rejoin the same pending teardown before reinitializing.",
    retryability: "conditional",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "telemetry-sdk-node/shutdown-timeout-invalid": recovery({
    cause: "Telemetry shutdown received a timeout outside the supported integer millisecond range.",
    userAction: "Retry shutdown with an integer timeout from 1 through 2147483647 milliseconds.",
    operatorAction:
      "Correct the shutdown timeout at the lifecycle owner before invoking TelemetryRuntime.shutdown().",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "info",
  }),
  "transports-graphql/body-limit-invalid-configuration": recovery({
    cause: "The GraphQL server was configured with an invalid request body byte boundary.",
    userAction: "Ask the operator to correct the service configuration before retrying.",
    operatorAction:
      "Set maxBodySizeBytes to a finite positive safe integer and restart the service.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  CROCO_HTTP_SECURITY_001: recovery({
    cause:
      "HTTP bootstrap validation found a generated or application app without the required security middleware set.",
    userAction:
      "Use an app build that registers security headers, CORS, body limit, and rate-limit middleware before first run.",
    operatorAction:
      "Add the missing @croco/transports-http middleware or keep securityValidation disabled only in an explicit local migration/testing fixture.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "error",
  }),
  CROCO_HTTP_MIDDLEWARE_001: recovery({
    cause:
      "HTTP middleware returned without a Response, without shortCircuit(reason), and without calling next() exactly once.",
    userAction: "Retry only after the service owner ships a middleware contract fix.",
    operatorAction:
      "Update the named @croco/transports-http middleware to return next(), await next() once, return a Response, or return shortCircuit(reason) for intentional termination.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  CROCO_HTTP_MIDDLEWARE_002: recovery({
    cause: "HTTP middleware attempted to resume the downstream pipeline more than once.",
    userAction: "Retry only after the service owner ships a middleware contract fix.",
    operatorAction:
      "Store the Response from a single next() call and reuse or transform it instead of calling next() again.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "transports-http/security-middleware-validation": recovery({
    cause:
      "Compatibility metadata for the previous HTTP security middleware validation code. New runtime failures use CROCO_HTTP_SECURITY_001 and preserve this value as extensions.legacyCode.",
    userAction:
      "Migrate Problem.code matchers to CROCO_HTTP_SECURITY_001; use extensions.legacyCode only while rolling out compatibility changes.",
    operatorAction:
      "Update dashboards, alerts, and runbooks from transports-http/security-middleware-validation to CROCO_HTTP_SECURITY_001 before removing legacy-code matching.",
    retryability: "not-retryable",
    redactionPolicy: "public",
    severity: "error",
  }),
  "transports-http/middleware-next-called-multiple-times": recovery({
    cause:
      "Compatibility metadata for the previous HTTP middleware multiple-next code. New runtime failures use CROCO_HTTP_MIDDLEWARE_002 and preserve this value as extensions.legacyCode.",
    userAction:
      "Migrate Problem.code matchers to CROCO_HTTP_MIDDLEWARE_002; use extensions.legacyCode only while rolling out compatibility changes.",
    operatorAction:
      "Update dashboards, alerts, and runbooks from transports-http/middleware-next-called-multiple-times to CROCO_HTTP_MIDDLEWARE_002 before removing legacy-code matching.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "transports-http/duplicate-route-definition": recovery({
    cause: "Two REST controller methods compile to the same HTTP method and runtime path.",
    userAction:
      "Use an application build where every route decorator has a unique HTTP method and path combination.",
    operatorAction:
      "Inspect the duplicate-route diagnostic for the existing and conflicting controller methods and their route decorator source locations, then rename one route path or change one HTTP method.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "protocols-trpc/duplicate-procedure-name": recovery({
    cause: "Two controller routes resolve to the same tRPC domain and procedure name.",
    userAction:
      "Use an application build where every tRPC procedure has a unique domain and controller method name combination.",
    operatorAction:
      "Inspect the duplicate-procedure diagnostic for the existing and conflicting controller routes and their decorator source locations, then change one domain or controller method name.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "metrics-billing/metric-dropped": recovery({
    cause:
      "Billing metrics could not be recorded because the referenced account, subscription, or plan evidence was missing.",
    userAction:
      "Restore the missing billing state identified by reason/resourceId, then replay the same billing event with the same event key.",
    operatorAction:
      "Use extensions.reason, tenantId, resourceId, and eventKey to rebuild the missing account, subscription, or plan before replay.",
    retryability: "conditional",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "metrics-billing/invalid-order-payment-reason": recovery({
    cause:
      "A paid-order event omitted its authoritative payment reason or supplied an unsupported value.",
    userAction:
      "Enrich the event from authoritative provider data before replaying it; never default an unknown payment reason to a new subscription.",
    operatorAction:
      "Pause consumption, migrate queued or outbox paid-order events with authoritative payment reasons, deploy compatible producers and consumers together, then resume.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "notifications-resend/idempotency-conflict": recovery({
    cause: "Resend rejected reuse of an idempotency key for a different send request.",
    userAction:
      "Replay the original payload with the same key or use a new key for a changed send intent.",
    operatorAction: "Audit callers so each business send intent has one stable idempotency key.",
    retryability: "not-retryable",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  "notifications-react-email/render-failed": recovery({
    cause:
      "A React Email component failed while producing deterministic HTML or plain text output.",
    userAction:
      "Do not retry unchanged message data; report the unavailable message so its email component can be corrected.",
    operatorAction:
      "Inspect the component implementation with redacted fixture data, correct the render failure, and redeploy before retrying.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "notifications-resend/missing-config": recovery({
    cause:
      "Required Resend configuration is absent or blank before provider readiness can be proven.",
    userAction: "Configure RESEND_API_KEY and a verified default sender, then rerun diagnostics.",
    operatorAction:
      "Check deployment env/config injection and verify diagnostics do not expose the raw key.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "notifications-resend/retryable-upstream": recovery({
    cause: "Resend returned a transient status, rate limit, or network timeout.",
    userAction: "Retry with the same idempotency key when the send intent is unchanged.",
    operatorAction:
      "Check Resend status, rate limits, and retry-after/upstream status in telemetry.",
    retryability: "retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "notifications-resend/terminal-upstream": recovery({
    cause: "Resend rejected the request with a non-retryable upstream failure.",
    userAction:
      "Do not retry unchanged input; correct the API key, domain, sender verification, or request content.",
    operatorAction:
      "Inspect redacted upstream code/status and fix provider configuration before retrying.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "events-tx/inbox-claim-conflict": recovery({
    cause: "An inbox completion request no longer owns the processing attempt it started.",
    userAction:
      "Acquire a new inbox claim before retrying processing; discard the stale completion when a new claim cannot be acquired.",
    operatorAction:
      "Inspect concurrent writes, idempotency keys, and uniqueness constraints, then verify workers complete only the attempt they claimed.",
    retryability: "conditional",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  "search-core/sync-identity-conflict": recovery({
    cause:
      "The event envelope tenant or document identity conflicts with context.tenantId, payload.id, or payload.tenantId.",
    userAction: "Correct the conflicting event or execution context, then replay the event.",
    operatorAction:
      "Use extensions.source to identify the conflicting field and verify envelope-authoritative tenant and document identity propagation.",
    retryability: "conditional",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  "search-core/operation-aborted": recovery({
    cause:
      "The caller's AbortSignal was already aborted or became aborted while the search operation was in flight.",
    userAction:
      "Handle the cancellation and retry only when the operation is still needed, using a new non-aborted AbortSignal.",
    operatorAction:
      "Inspect the caller cancellation source and extensions.operation; do not treat the cancellation as an input-validation failure.",
    retryability: "conditional",
    redactionPolicy: "public",
    severity: "info",
  }),
  "search-meilisearch/task-canceled": recovery({
    cause: "Meilisearch canceled the provider task before the requested mutation completed.",
    userAction:
      "Do not retry automatically; submit a new mutation only after the cancellation cause is understood and repeating the operation is safe.",
    operatorAction:
      "Inspect the Meilisearch task and provider diagnostics using extensions.operation, extensions.indexName, and extensions.documentId, then correct the cancellation cause before reissuing the mutation.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "search-core/searchable-index-conflict": recovery({
    cause: "More than one searchable metadata declaration owns the same index name.",
    userAction: "Give every searchable declaration a unique index name, then restart registration.",
    operatorAction:
      "Use extensions.declarations to find both conflicting source locations and remove or rename one declaration.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "search-core/transform-registration-conflict": recovery({
    cause: "More than one search transform adapter claims the same runtime ID.",
    userAction: "Remove or rename the conflicting adapter registration, then restart registration.",
    operatorAction:
      "Use extensions.id and the registered and attempted suffixes to locate the conflicting adapters and keep one owner for the ID.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "tasks-core/task-reference-invalid": recovery({
    cause:
      "A typed task reference is missing its factory contract or no longer matches the registered handler metadata.",
    userAction:
      "Do not retry the unchanged reference; create it again with taskRef() after correcting the task declaration or registration.",
    operatorAction:
      "Verify that the task name, target, and method match the current @Task metadata and registry entry.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "outbox-core/failure-metadata-missing": recovery({
    cause:
      "A dispatcher attempted to mark an outbox record failed without the required retry metadata extensions.",
    userAction:
      "Abort the dispatch attempt and pass an OutboxDispatchProblem or equivalent Problem with outbox retry metadata.",
    operatorAction:
      "Audit dispatcher error mapping so every failure path preserves attempt, retryability, terminal state, and failedAt metadata.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "outbox-core/claim-configuration-invalid": recovery({
    cause:
      "An outbox dispatcher requested a visibility lease that is not a positive safe-integer duration with a representable expiry.",
    userAction: "Ask the operator to correct visibilityTimeoutMs before retrying outbox dispatch.",
    operatorAction:
      "Correct dispatcher lease configuration and verify every store validates claim options before reading or mutating claim state.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
  "outbox-core/record-id-conflict": recovery({
    cause:
      "A caller tried to create an outbox record with an explicit id that already belongs to another idempotency scope.",
    userAction:
      "Reuse the original idempotency key for the same intent or choose a new record id for a different intent.",
    operatorAction:
      "Inspect the producer id/idempotency assignment path and remove any shared id generator or manual id reuse.",
    retryability: "not-retryable",
    redactionPolicy: "safe-message",
    severity: "warning",
  }),
  "outbox-core/unit-of-work-context-invalid": recovery({
    cause:
      "An outbox write received a Unit of Work context that was missing, malformed, or created by another store instance.",
    userAction:
      "Abort the write and use the context supplied by the active TransactionalOutboxStore.runInUnitOfWork callback.",
    operatorAction:
      "Check transaction boundary wiring so repository and outbox writes share the same store-owned Unit of Work client.",
    retryability: "not-retryable",
    redactionPolicy: "operator-only",
    severity: "error",
  }),
} as const satisfies Partial<Record<string, ProblemRecoveryMetadata>>;

function recovery(options: {
  readonly cause: string;
  readonly userAction: string;
  readonly operatorAction: string;
  readonly retryability: ProblemRetryability;
  readonly redactionPolicy: ProblemRedactionPolicy;
  readonly severity: ProblemTelemetrySeverity;
}): ProblemRecoveryMetadata {
  return {
    cause: options.cause,
    userAction: options.userAction,
    operatorAction: options.operatorAction,
    retryability: options.retryability,
    redactionPolicy: options.redactionPolicy,
    telemetry: {
      eventName: `croco.problem.${options.severity}`,
      severity: options.severity,
      attributes: telemetryAttributes,
    },
  };
}

function createActiveProblemLifecycle(): ProblemLifecycle {
  return { status: "active" };
}

function getProblemCodeRegistryValidationErrors(registry: ProblemCodeRegistry): readonly string[] {
  const errors: string[] = [];
  const seenCodes = new Set<string>();
  const registryByCode = new Map(registry.problems.map((problem) => [problem.code, problem]));

  if (registry.problemCount !== registry.problems.length) {
    errors.push(
      `Problem registry count ${registry.problemCount} does not match ${registry.problems.length} entries.`,
    );
  }

  for (const problem of registry.problems) {
    if (seenCodes.has(problem.code)) {
      errors.push(`Problem registry contains duplicate code '${problem.code}'.`);
      continue;
    }

    seenCodes.add(problem.code);
    const lifecycle = getProblemLifecycle(problem);

    if (problem.status !== toHttpStatus(problem.category)) {
      errors.push(`Problem code '${problem.code}' has a status/category mismatch.`);
    }

    errors.push(...getProblemStatusPolicyValidationErrors(problem));

    if (!isCompleteRecoveryMetadata(problem.recovery)) {
      errors.push(`Problem code '${problem.code}' is missing recovery cookbook metadata.`);
    }

    if (lifecycle.status === "deprecated") {
      errors.push(...getProblemCodeDeprecationValidationErrors(problem, registryByCode));
    }

    if (problem.sources.length === 0 && lifecycle.status !== "deprecated") {
      errors.push(`Problem code '${problem.code}' has no source locations.`);
    } else if (problem.sources.length > 1) {
      errors.push(
        `Problem code '${problem.code}' is declared ${problem.sources.length} times: ${problem.sources.map(formatSource).join(", ")}.`,
      );
    }
  }

  return errors;
}

function getProblemLifecycle(problem: ProblemCodeRegistryEntry): ProblemLifecycle {
  return problem.lifecycle ?? createActiveProblemLifecycle();
}

function getProblemLifecycleStatus(problem: ProblemCodeRegistryEntry): ProblemLifecycleStatus {
  return getProblemLifecycle(problem).status;
}

function getProblemStatusPolicyValidationErrors(
  problem: Pick<ProblemCodeRegistryEntry, "code" | "status" | "statusPolicy">,
): readonly string[] {
  const policy = problem.statusPolicy;

  if (!policy) {
    return [];
  }

  const errors: string[] = [];

  if (policy.kind !== "runtime-configurable") {
    errors.push(`Problem code '${problem.code}' has an unsupported status policy.`);
  }

  if (policy.defaultStatus !== problem.status) {
    errors.push(
      `Problem code '${problem.code}' has status policy default ${policy.defaultStatus}, expected ${problem.status}.`,
    );
  }

  if (policy.configuration.trim().length === 0) {
    errors.push(`Problem code '${problem.code}' has an empty status policy configuration.`);
  }

  return errors;
}

function formatProblemStatusPolicy(policy: ProblemStatusPolicy | undefined): string | undefined {
  return policy ? `${policy.kind}:${policy.defaultStatus}:${policy.configuration}` : undefined;
}

function toHttpStatus(category: ProblemCategory): number {
  switch (category) {
    case ProblemCategory.BadRequest:
      return 400;
    case ProblemCategory.Unauthorized:
      return 401;
    case ProblemCategory.Forbidden:
      return 403;
    case ProblemCategory.NotFound:
      return 404;
    case ProblemCategory.Conflict:
      return 409;
    case ProblemCategory.Gone:
      return 410;
    case ProblemCategory.PayloadTooLarge:
      return 413;
    case ProblemCategory.ValidationError:
    case ProblemCategory.BusinessRuleViolation:
      return 422;
    case ProblemCategory.TooManyRequests:
      return 429;
    case ProblemCategory.InternalServerError:
      return 500;
    case ProblemCategory.NotImplemented:
      return 501;
  }
}

function toTitle(category: ProblemCategory): string {
  switch (category) {
    case ProblemCategory.BadRequest:
      return "Bad Request";
    case ProblemCategory.Unauthorized:
      return "Unauthorized";
    case ProblemCategory.Forbidden:
      return "Forbidden";
    case ProblemCategory.NotFound:
      return "Not Found";
    case ProblemCategory.Conflict:
      return "Conflict";
    case ProblemCategory.Gone:
      return "Gone";
    case ProblemCategory.PayloadTooLarge:
      return "Payload Too Large";
    case ProblemCategory.ValidationError:
      return "Validation Error";
    case ProblemCategory.BusinessRuleViolation:
      return "Business Rule Violation";
    case ProblemCategory.TooManyRequests:
      return "Too Many Requests";
    case ProblemCategory.InternalServerError:
      return "Internal Server Error";
    case ProblemCategory.NotImplemented:
      return "Not Implemented";
  }
}

function slugifyProblemCode(code: string): string {
  return (
    code
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "problem"
  );
}

function formatSource(source: ProblemCodeSource): string {
  return `${source.file}:${source.line}:${source.column}`;
}

function isCompleteRecoveryMetadata(metadata: ProblemRecoveryMetadata): boolean {
  return (
    metadata.cause.length > 0 &&
    metadata.userAction.length > 0 &&
    metadata.operatorAction.length > 0 &&
    metadata.retryability.length > 0 &&
    metadata.redactionPolicy.length > 0 &&
    metadata.telemetry.eventName.length > 0 &&
    metadata.telemetry.severity.length > 0 &&
    metadata.telemetry.attributes.length > 0
  );
}

function formatGeneratedProblemRegistrySource(registry: ProblemCodeRegistry): string {
  return `${[
    'import type { TypedProblemDetails } from "../libs/Problem";',
    'import type { ProblemCodeRegistry } from "../libs/ProblemRegistry";',
    "",
    "export const CROCO_PROBLEM_CODE_REGISTRY = ",
    `${JSON.stringify(registry, null, 2)} as const satisfies ProblemCodeRegistry;`,
    "",
    "export type CrocoProblemRegistry = typeof CROCO_PROBLEM_CODE_REGISTRY;",
    "export type CrocoProblemRegistryEntry = CrocoProblemRegistry['problems'][number];",
    "export type CrocoProblemCode = CrocoProblemRegistryEntry['code'];",
    "",
    "type CrocoProblemEntryStatus<Entry extends CrocoProblemRegistryEntry> = Entry extends { readonly statusPolicy: { readonly kind: 'runtime-configurable' } } ? number : Entry['status'];",
    "",
    "export type CrocoProblemStatus<Code extends CrocoProblemCode = CrocoProblemCode> = CrocoProblemEntryStatus<Extract<CrocoProblemRegistryEntry, { readonly code: Code }>>;",
    "",
    "export type CrocoProblemDetails<Code extends CrocoProblemCode = CrocoProblemCode> = Code extends CrocoProblemCode ? TypedProblemDetails<Code, CrocoProblemStatus<Code>> : never;",
  ].join("\n")}\n`;
}

function formatProblemRecoveryCookbook(registry: ProblemCodeRegistry): string {
  const lines = [
    "---",
    "title: Problem Recovery Cookbook",
    "description: Generated Croco Problem code registry with recovery and telemetry metadata.",
    "---",
    "",
    "# Problem Recovery Cookbook",
    "",
    "> Generated by `pnpm problem-registry:write`. Do not edit this file by hand.",
    "",
    `This cookbook documents ${registry.problemCount} public Croco Problem codes. The deterministic JSON registry is generated at \`${registryPath}\`, and generated client union types are emitted at \`${generatedRegistrySourcePath}\`.`,
    "",
    "## Index",
    "",
    "| Code | Category | Status | Retryability | Redaction | Lifecycle | Sources |",
    "| --- | --- | ---: | --- | --- | --- | ---: |",
    ...registry.problems.map(
      (problem) =>
        `| [\`${escapeMarkdownTable(problem.code)}\`](#${slugifyProblemCode(problem.code)}) | ${problem.category} | ${formatProblemStatus(problem)} | ${problem.recovery.retryability} | ${problem.recovery.redactionPolicy} | ${getProblemLifecycleStatus(problem)} | ${problem.sources.length} |`,
    ),
    "",
    "\\* Runtime-configurable statuses show their canonical default; see the entry details for the configuration surface.",
    "",
  ];

  for (const problem of registry.problems) {
    const lifecycle = getProblemLifecycle(problem);

    lines.push(
      `<a id="${slugifyProblemCode(problem.code)}"></a>`,
      "",
      `## \`${problem.code}\``,
      "",
      `- Category: \`${problem.category}\``,
      `- HTTP status: ${formatProblemStatusDetails(problem)}`,
      `- Retryability: \`${problem.recovery.retryability}\``,
      `- Redaction policy: \`${problem.recovery.redactionPolicy}\``,
      `- Lifecycle: \`${lifecycle.status}\``,
      `- Cause: ${problem.recovery.cause}`,
      `- User action: ${problem.recovery.userAction}`,
      `- Operator action: ${problem.recovery.operatorAction}`,
      `- Telemetry: \`${problem.recovery.telemetry.eventName}\` (${problem.recovery.telemetry.severity}) with ${problem.recovery.telemetry.attributes.map((attribute) => `\`${attribute}\``).join(", ")}`,
      "",
    );

    if (lifecycle.status === "deprecated" && lifecycle.deprecation) {
      lines.push(
        "Deprecation:",
        "",
        `- Reason: ${lifecycle.deprecation.reason}`,
        `- Migration note: ${lifecycle.deprecation.migrationNote}`,
        ...(lifecycle.deprecation.replacementCode
          ? [`- Replacement code: \`${lifecycle.deprecation.replacementCode}\``]
          : []),
        ...(lifecycle.deprecation.noReplacementReason
          ? [`- No replacement reason: ${lifecycle.deprecation.noReplacementReason}`]
          : []),
        ...(lifecycle.deprecation.since ? [`- Since: \`${lifecycle.deprecation.since}\``] : []),
        "",
      );
    }

    lines.push(
      "Sources:",
      "",
      ...(problem.sources.length > 0
        ? problem.sources.map(
            (source) => `- \`${source.file}:${source.line}:${source.column}\` (${source.kind})`,
          )
        : ["- Deprecated registry entry; implementation intentionally removed."]),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatProblemStatus(problem: ProblemCodeRegistryEntry): string {
  return problem.statusPolicy ? `${problem.status}*` : String(problem.status);
}

function formatProblemStatusDetails(problem: ProblemCodeRegistryEntry): string {
  const fixed = `\`${problem.status}\` ${problem.title}`;

  return problem.statusPolicy
    ? `${fixed} by default; runtime-configurable via \`${problem.statusPolicy.configuration}\``
    : fixed;
}

function compareSources(
  left: ProblemCodeDiscovery["sources"][number],
  right: ProblemCodeDiscovery["sources"][number],
): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.kind.localeCompare(right.kind)
  );
}

function formatProblemRegistryError(error: unknown): readonly string[] {
  if (error instanceof ProblemRegistryValidationProblem) {
    return error.errors;
  }

  if (error instanceof Error) {
    return [error.message];
  }

  return ["Unknown Problem registry generation failure."];
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function parseArgs(args: readonly string[]): {
  readonly mode: ProblemRegistryMode;
  readonly options: ProblemRegistryRunOptions;
} {
  let mode: ProblemRegistryMode = "check";
  let baseRef: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--write") {
      mode = "write";
      continue;
    }

    if (arg === "--check") {
      mode = "check";
      continue;
    }

    if (arg === "--base") {
      const value = args[index + 1];
      if (!value) {
        throw new ProblemRegistryValidationProblem(["--base requires a git ref"]);
      }
      baseRef = value;
      index++;
      continue;
    }

    throw new ProblemRegistryValidationProblem([`Unknown option: ${arg}`]);
  }

  return { mode, options: { baseRef } };
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  const { mode, options } = parseArgs(argv.slice(2));
  const result = runProblemRegistryCheck(process.cwd(), mode, options);

  if (result.status === "pass") {
    stdout.write(
      `Problem registry ${mode} passed: ${result.problemCount} codes from ${result.discoveryCount} discoveries.\n`,
    );
  } else {
    stdout.write(`Problem registry ${mode} failed:\n`);

    for (const diagnostic of result.diagnostics) {
      stdout.write(`- ${diagnostic}\n`);
    }
  }

  exit(result.status === "pass" ? 0 : 1);
}
