#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";

import {
  type PackageInfo,
  readPackages,
  readTurboRunSummaries,
} from "./package-quality-report.mts";
import {
  createReleaseSpineEvidenceManifest,
  type EvidenceArtifactReference,
  type EvidenceCheckResult,
  type ReleaseSpineEvidenceReport,
} from "./release-spine-evidence.mts";
import { assertLaneReport, type LaneReport } from "./test-evidence-reconcile.mts";
import { inventoryDigest, readTestInventory } from "./test-inventory.mts";
import { createTestLanePlan } from "./test-lane-runner.mts";

const reportDirectory = join("ci-reports", "package-quality");
const reportFileName = "spine-promotion.md";
const catalogMetadataPath = join("docs", "package-catalog.json");
const fastTestLaneReportPath = join("ci-reports", "package-quality", "fast-test-lane.json");
const maturityOrder = ["production", "beta", "alpha", "deprecated"] as const;

type MaturityKey = (typeof maturityOrder)[number];

type Options = {
  readonly ciRunFile: string | null;
  readonly contextFile: string | null;
  readonly rootDir: string;
  readonly outputDir: string;
  readonly packageNames: readonly string[];
};

export type PromotionEvidenceRole = "behavior" | "compatibility" | "failure-recovery";

export type PromotionEvidenceReference = {
  readonly description: string;
  readonly role: PromotionEvidenceRole;
  readonly commandId: string;
  readonly testPath?: string;
  readonly artifactPath?: string;
};

type PromotionMetadata = {
  readonly owner: string;
  readonly targetEvidence: readonly PromotionEvidenceReference[];
  readonly recoveryAction: string;
};

export type PromotionCommandResult = {
  readonly artifacts: readonly {
    readonly exists: boolean;
    readonly fresh: boolean;
    readonly path: string;
    readonly semanticStatus: "passed" | "failed" | "unknown";
  }[];
  readonly blocking: boolean;
  readonly commandId: string;
  readonly completedAt: string | null;
  readonly outcome: "passed" | "failed" | "pending" | "skipped" | "timed_out" | "interrupted";
  readonly runAttempt: string;
  readonly runId: string;
  readonly startedAt: string | null;
  readonly testTasks: readonly {
    readonly packageName: string;
    readonly status: "passed" | "failed" | "missing";
    readonly taskId: string;
  }[];
};

export type PromotionEvidenceContext = {
  readonly schemaVersion: 1;
  readonly source: "ci" | "release" | "local";
  readonly commitSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly commands: readonly PromotionCommandResult[];
};

export type BetaSpinePromotionRow = {
  readonly packageName: string;
  readonly shortName: string;
  readonly relativeDir: string;
  readonly group: string;
  readonly maturity: "beta";
  readonly owner: string | null;
  readonly targetEvidence: readonly PromotionEvidenceReference[];
  readonly recoveryAction: string | null;
  readonly status: "promotion-ready" | "blocked";
  readonly missingFields: readonly string[];
  readonly evidenceFailures: readonly string[];
};

export type SpinePromotionReport = {
  readonly generatedAt: string;
  readonly rootDir: string;
  readonly catalogErrors: readonly string[];
  readonly catalogWarnings: readonly string[];
  readonly betaSpineRows: readonly BetaSpinePromotionRow[];
  readonly ignoredNonSpineNonProductionCount: number;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
}

function toShortPackageName(packageName: string): string {
  return packageName.replace(/^@croco\//, "");
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function readStringArrayField(
  record: Readonly<Record<string, unknown>>,
  fieldPath: string,
  errors: string[],
): readonly string[] {
  const value = record.packages;
  if (!isStringArray(value)) {
    errors.push(`${catalogMetadataPath}: ${fieldPath}.packages must be a string array`);
    return [];
  }

  return value;
}

function parseCatalogGroups(groupsValue: unknown, errors: string[]): ReadonlyMap<string, string> {
  const groupByPackage = new Map<string, string>();

  if (!isRecord(groupsValue)) {
    errors.push(`${catalogMetadataPath}: groups must be an object`);
    return groupByPackage;
  }

  for (const [groupName, groupValue] of Object.entries(groupsValue)) {
    if (!isRecord(groupValue)) {
      errors.push(`${catalogMetadataPath}: groups.${groupName} must be an object`);
      continue;
    }

    const packageNames = readStringArrayField(groupValue, `groups.${groupName}`, errors);
    for (const packageName of packageNames) {
      const previousGroup = groupByPackage.get(packageName);
      if (previousGroup) {
        errors.push(
          `${catalogMetadataPath}: package ${packageName} appears in multiple groups (${previousGroup}, ${groupName})`,
        );
        continue;
      }
      groupByPackage.set(packageName, groupName);
    }
  }

  return groupByPackage;
}

function parseCatalogMaturity(
  maturityRoot: unknown,
  errors: string[],
): ReadonlyMap<string, MaturityKey> {
  const maturityByPackage = new Map<string, MaturityKey>();

  if (!isRecord(maturityRoot)) {
    errors.push(`${catalogMetadataPath}: maturity must be an object`);
    return maturityByPackage;
  }

  for (const maturity of maturityOrder) {
    const maturityValue = maturityRoot[maturity];
    if (!isRecord(maturityValue)) {
      errors.push(`${catalogMetadataPath}: maturity.${maturity} must be an object`);
      continue;
    }

    const packageNames = readStringArrayField(maturityValue, `maturity.${maturity}`, errors);
    for (const packageName of packageNames) {
      const previousMaturity = maturityByPackage.get(packageName);
      if (previousMaturity) {
        errors.push(
          `${catalogMetadataPath}: package ${packageName} appears in multiple maturity buckets (${previousMaturity}, ${maturity})`,
        );
        continue;
      }
      maturityByPackage.set(packageName, maturity);
    }
  }

  return maturityByPackage;
}

function parseCatalogSpine(
  catalog: Readonly<Record<string, unknown>>,
  errors: string[],
): readonly string[] {
  if (!isRecord(catalog.spine)) {
    errors.push(`${catalogMetadataPath}: spine must be an object`);
    return [];
  }

  return readStringArrayField(catalog.spine, "spine", errors);
}

function parsePromotionPackages(
  catalog: Readonly<Record<string, unknown>>,
  errors: string[],
): ReadonlyMap<string, PromotionMetadata | null> {
  const spine = isRecord(catalog.spine) ? catalog.spine : {};
  const promotion = isRecord(spine.promotion) ? spine.promotion : {};

  if (spine.promotion !== undefined && !isRecord(spine.promotion)) {
    errors.push(`${catalogMetadataPath}: spine.promotion must be an object`);
    return new Map();
  }

  if (promotion.packages !== undefined && !isRecord(promotion.packages)) {
    errors.push(`${catalogMetadataPath}: spine.promotion.packages must be an object`);
    return new Map();
  }

  const promotionPackages = isRecord(promotion.packages) ? promotion.packages : {};
  return new Map(
    Object.entries(promotionPackages).map(([packageName, metadata]) => [
      packageName,
      parsePromotionMetadata(metadata, packageName, errors),
    ]),
  );
}

function parsePromotionMetadata(
  value: unknown,
  packageName: string,
  errors: string[],
): PromotionMetadata | null {
  if (!isRecord(value)) {
    errors.push(
      `${catalogMetadataPath}: spine.promotion.packages.${packageName} must be an object`,
    );
    return null;
  }

  const evidencePath = `spine.promotion.packages.${packageName}.targetEvidence`;
  if (!Array.isArray(value.targetEvidence)) {
    errors.push(
      `${catalogMetadataPath}: ${evidencePath} must be an array of structured references`,
    );
  }

  return {
    owner: typeof value.owner === "string" ? value.owner : "",
    targetEvidence: Array.isArray(value.targetEvidence)
      ? value.targetEvidence.flatMap((entry) => {
          if (!isRecord(entry)) {
            errors.push(`${catalogMetadataPath}: ${evidencePath} entries must be objects`);
            return [];
          }
          if (
            typeof entry.description !== "string" ||
            entry.description.trim().length === 0 ||
            typeof entry.commandId !== "string" ||
            entry.commandId.trim().length === 0 ||
            (entry.role !== "behavior" &&
              entry.role !== "compatibility" &&
              entry.role !== "failure-recovery") ||
            (entry.testPath !== undefined &&
              (typeof entry.testPath !== "string" || entry.testPath.trim().length === 0)) ||
            (entry.artifactPath !== undefined &&
              (typeof entry.artifactPath !== "string" || entry.artifactPath.trim().length === 0)) ||
            (entry.testPath !== undefined && entry.artifactPath !== undefined)
          ) {
            errors.push(
              `${catalogMetadataPath}: ${evidencePath} entries require non-empty description, role, commandId, and at most one testPath or artifactPath`,
            );
            return [];
          }
          return [
            {
              description: entry.description,
              role: entry.role,
              commandId: entry.commandId,
              ...(entry.testPath ? { testPath: entry.testPath } : {}),
              ...(entry.artifactPath ? { artifactPath: entry.artifactPath } : {}),
            },
          ];
        })
      : [],
    recoveryAction: typeof value.recoveryAction === "string" ? value.recoveryAction : "",
  };
}

function getMissingPromotionFields(metadata: PromotionMetadata | null | undefined): string[] {
  if (!metadata) {
    return ["owner", "targetEvidence", "recoveryAction"];
  }

  const missingFields: string[] = [];
  if (metadata.owner.trim().length === 0) {
    missingFields.push("owner");
  }
  if (metadata.targetEvidence.length === 0) {
    missingFields.push("targetEvidence");
  }
  if (metadata.recoveryAction.trim().length === 0) {
    missingFields.push("recoveryAction");
  }

  return missingFields;
}

function indexWorkspacePackages(
  packages: readonly PackageInfo[],
  errors: string[],
): ReadonlyMap<string, PackageInfo> {
  const byShortName = new Map<string, PackageInfo>();

  for (const pkg of packages) {
    if (pkg.private) {
      continue;
    }

    const shortName = toShortPackageName(pkg.name);
    const existing = byShortName.get(shortName);
    if (existing) {
      errors.push(
        `${catalogMetadataPath}: workspace contains duplicate package short name ${shortName} (${existing.name}, ${pkg.name})`,
      );
      continue;
    }
    byShortName.set(shortName, pkg);
  }

  return byShortName;
}

const requiredEvidenceRoles: readonly PromotionEvidenceRole[] = [
  "behavior",
  "compatibility",
  "failure-recovery",
];

function readHeadCommit(rootDir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf-8",
  }).trim();
}

function isPathInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent.length > 0 && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent)
  );
}

function readVitestTestInventory(rootDir: string, pkg: PackageInfo): readonly string[] {
  const packageDir = resolve(rootDir, pkg.relativeDir);
  try {
    return execFileSync("pnpm", ["exec", "vitest", "list", "--filesOnly"], {
      cwd: packageDir,
      encoding: "utf-8",
    })
      .split(/\r?\n/)
      .map((entry) => toPosixPath(entry.trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isPackageTestIncluded(
  rootDir: string,
  pkg: PackageInfo,
  testPath: string,
  testInventory: readonly string[],
): string | null {
  const packageDir = resolve(rootDir, pkg.relativeDir);
  const absoluteTestPath = resolve(packageDir, testPath);
  if (!isPathInside(packageDir, absoluteTestPath)) {
    return `test path ${testPath} is outside ${pkg.relativeDir}`;
  }
  if (!existsSync(absoluteTestPath)) {
    return `test path ${pkg.relativeDir}/${testPath} does not exist`;
  }
  const realPackageDir = realpathSync(packageDir);
  const realTestPath = realpathSync(absoluteTestPath);
  if (!isPathInside(realPackageDir, realTestPath)) {
    return `test path ${pkg.relativeDir}/${testPath} resolves outside the package`;
  }
  if (!/^src\/(?:__tests__|tests)\/.+\.spec\.[cm]?[jt]sx?$/.test(testPath)) {
    return `test path ${pkg.relativeDir}/${testPath} is not a package-owned Vitest spec`;
  }

  const packageJson = readJsonFile(join(packageDir, "package.json"));
  const scripts = isRecord(packageJson) && isRecord(packageJson.scripts) ? packageJson.scripts : {};
  const testScript = typeof scripts.test === "string" ? scripts.test : "";
  if (!/^vitest run(?:\s|$)/.test(testScript)) {
    return `${pkg.relativeDir}/package.json test script does not expose a Vitest run contract`;
  }

  const excludedPaths = [...testScript.matchAll(/--exclude\s+([^\s]+)/g)].map((match) => match[1]);
  if (
    excludedPaths.some((excluded) => {
      const prefix = excluded.replace(/\*\*.*$/, "").replace(/\*.*$/, "");
      return prefix.length > 0 && testPath.startsWith(prefix);
    })
  ) {
    return `test path ${pkg.relativeDir}/${testPath} is excluded by the package test task`;
  }

  const explicitSelectors = testScript
    .replace(/^vitest run(?:\s|$)/, "")
    .split(/\s+/)
    .filter((token, index, tokens) => {
      if (!token || token.startsWith("-")) {
        return false;
      }
      const previous = tokens[index - 1];
      if (previous === "--exclude" || previous === "--config" || previous === "--reporter") {
        return false;
      }
      return token.includes("/") || token.includes(".spec.");
    });
  const selected = explicitSelectors.some((selector) => {
    const wildcardIndex = selector.search(/[?*[\]{}]/);
    if (wildcardIndex >= 0) {
      return testPath.startsWith(selector.slice(0, wildcardIndex));
    }
    return selector.includes(".spec.")
      ? testPath === selector
      : testPath.startsWith(`${selector}/`);
  });
  if (explicitSelectors.length > 0 && !selected) {
    return `test path ${pkg.relativeDir}/${testPath} is not selected by the package test task`;
  }
  if (!testInventory.includes(testPath)) {
    return `test path ${pkg.relativeDir}/${testPath} is absent from the effective Vitest test inventory`;
  }

  return null;
}

function parseIsoTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function resolvePromotionEvidence(input: {
  readonly context: PromotionEvidenceContext | null;
  readonly currentCommit?: string;
  readonly metadata: PromotionMetadata | null | undefined;
  readonly pkg: PackageInfo;
  readonly rootDir: string;
  readonly testInventory: readonly string[];
}): string[] {
  if (!input.metadata) {
    return [];
  }

  const failures: string[] = [];
  const manifest = createReleaseSpineEvidenceManifest();
  const promotionIndex = manifest.findIndex((command) => command.id === "spine-promotion");
  const blockingCommands = new Map(
    manifest.map((command, index) => [command.id, { command, index }]),
  );
  const roles = new Set(input.metadata.targetEvidence.map((reference) => reference.role));
  for (const role of requiredEvidenceRoles) {
    if (!roles.has(role)) {
      failures.push(`missing required ${role} evidence`);
    }
  }

  if (!input.context) {
    failures.push("current-run promotion evidence context is required");
    return failures;
  }

  let headCommit = "";
  try {
    headCommit = input.currentCommit ?? readHeadCommit(input.rootDir);
  } catch {
    failures.push("cannot resolve the current git commit");
  }
  if (headCommit && input.context.commitSha !== headCommit) {
    failures.push(`evidence commit ${input.context.commitSha} does not match HEAD ${headCommit}`);
  }
  if (!input.context.runId.trim() || !input.context.runAttempt.trim()) {
    failures.push("evidence run identity and attempt are required");
  }
  const contextStartedAt = parseIsoTimestamp(input.context.startedAt);
  const contextCompletedAt = parseIsoTimestamp(input.context.completedAt);
  if (
    contextStartedAt === null ||
    contextCompletedAt === null ||
    contextCompletedAt < contextStartedAt
  ) {
    failures.push("evidence context timestamps must define a completed current-run interval");
  }

  const results = new Map(input.context.commands.map((result) => [result.commandId, result]));
  for (const reference of input.metadata.targetEvidence) {
    const definition = blockingCommands.get(reference.commandId);
    if (!definition) {
      failures.push(`${reference.description}: unknown blocking command ${reference.commandId}`);
      continue;
    }
    if (reference.commandId === "spine-promotion") {
      failures.push(`${reference.description}: spine-promotion cannot reference itself`);
      continue;
    }
    if (input.context.source === "release" && definition.index >= promotionIndex) {
      failures.push(
        `${reference.description}: release command ${reference.commandId} does not precede spine-promotion`,
      );
      continue;
    }

    const result = results.get(reference.commandId);
    if (!result) {
      failures.push(
        `${reference.description}: current run has no result for ${reference.commandId}`,
      );
      continue;
    }
    if (!result.blocking) {
      failures.push(`${reference.description}: ${reference.commandId} is advisory-only`);
    }
    if (result.runId !== input.context.runId || result.runAttempt !== input.context.runAttempt) {
      failures.push(
        `${reference.description}: ${reference.commandId} belongs to another run or attempt`,
      );
    }
    if (result.outcome !== "passed" || !result.startedAt || !result.completedAt) {
      failures.push(
        `${reference.description}: ${reference.commandId} current-run outcome is ${result.outcome}`,
      );
    } else {
      const commandStartedAt = parseIsoTimestamp(result.startedAt);
      const commandCompletedAt = parseIsoTimestamp(result.completedAt);
      if (
        commandStartedAt === null ||
        commandCompletedAt === null ||
        commandCompletedAt < commandStartedAt ||
        (contextStartedAt !== null && commandStartedAt < contextStartedAt) ||
        (contextCompletedAt !== null && commandCompletedAt > contextCompletedAt)
      ) {
        failures.push(
          `${reference.description}: ${reference.commandId} timestamps are outside the current-run interval`,
        );
      }
    }

    if (reference.testPath) {
      if (reference.commandId !== "test") {
        failures.push(`${reference.description}: testPath requires the authoritative test command`);
      }
      const inclusionFailure = isPackageTestIncluded(
        input.rootDir,
        input.pkg,
        reference.testPath,
        input.testInventory,
      );
      if (inclusionFailure) {
        failures.push(`${reference.description}: ${inclusionFailure}`);
      }
      const task = result.testTasks.find((entry) => entry.packageName === input.pkg.name);
      if (!task || task.status !== "passed") {
        failures.push(
          `${reference.description}: ${input.pkg.name} test task did not pass in the current run`,
        );
      }
    }

    if (reference.artifactPath) {
      if (
        !definition.command.artifacts?.some((artifact) => artifact.path === reference.artifactPath)
      ) {
        failures.push(
          `${reference.description}: report ${reference.artifactPath} is not declared by ${reference.commandId}`,
        );
        continue;
      }
      const artifact = result.artifacts.find((entry) => entry.path === reference.artifactPath);
      if (!artifact) {
        failures.push(
          `${reference.description}: unknown report artifact ${reference.artifactPath}`,
        );
      } else if (!artifact.exists || !artifact.fresh || artifact.semanticStatus !== "passed") {
        failures.push(
          `${reference.description}: report ${reference.artifactPath} must exist, be fresh, and report passed`,
        );
      }
    }
  }

  return failures;
}

function createBetaSpineRow(input: {
  readonly currentCommit?: string;
  readonly evidenceContext: PromotionEvidenceContext | null;
  readonly group: string;
  readonly metadata: PromotionMetadata | null | undefined;
  readonly pkg: PackageInfo;
  readonly rootDir: string;
  readonly shortName: string;
  readonly testInventory: readonly string[];
}): BetaSpinePromotionRow {
  const missingFields = getMissingPromotionFields(input.metadata);
  const targetEvidence = input.metadata?.targetEvidence ?? [];
  const evidenceFailures = resolvePromotionEvidence({
    context: input.evidenceContext,
    currentCommit: input.currentCommit,
    metadata: input.metadata,
    pkg: input.pkg,
    rootDir: input.rootDir,
    testInventory: input.testInventory,
  });

  return {
    packageName: input.pkg.name,
    shortName: input.shortName,
    relativeDir: input.pkg.relativeDir,
    group: input.group,
    maturity: "beta",
    owner: input.metadata?.owner.trim() ? input.metadata.owner.trim() : null,
    targetEvidence,
    recoveryAction: input.metadata?.recoveryAction.trim()
      ? input.metadata.recoveryAction.trim()
      : null,
    status:
      missingFields.length === 0 && evidenceFailures.length === 0 ? "promotion-ready" : "blocked",
    missingFields,
    evidenceFailures,
  };
}

export function createSpinePromotionReport(options: {
  readonly currentCommit?: string;
  readonly evidenceContext?: PromotionEvidenceContext | null;
  readonly generatedAt?: string;
  readonly rootDir: string;
  readonly packageNames?: readonly string[];
  readonly testInventory?: (pkg: PackageInfo) => readonly string[];
}): SpinePromotionReport {
  const catalogErrors: string[] = [];
  const catalog = readJsonFile(join(options.rootDir, catalogMetadataPath));

  if (!isRecord(catalog)) {
    return {
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      rootDir: options.rootDir,
      catalogErrors: [`${catalogMetadataPath}: must contain an object`],
      catalogWarnings: [],
      betaSpineRows: [],
      ignoredNonSpineNonProductionCount: 0,
    };
  }

  const groupByPackage = parseCatalogGroups(catalog.groups, catalogErrors);
  const maturityByPackage = parseCatalogMaturity(catalog.maturity, catalogErrors);
  const spinePackages = parseCatalogSpine(catalog, catalogErrors);
  const promotionPackages = parsePromotionPackages(catalog, catalogErrors);
  const workspaceByShortName = indexWorkspacePackages(readPackages(options.rootDir), catalogErrors);
  const spinePackageSet = new Set(spinePackages);
  const catalogWarnings: string[] = [];
  const allBetaSpinePackageSet = new Set(
    spinePackages.filter((packageName) => maturityByPackage.get(packageName) === "beta"),
  );
  const requestedPackageSet = new Set(options.packageNames ?? []);
  const betaSpinePackageSet =
    requestedPackageSet.size === 0
      ? allBetaSpinePackageSet
      : new Set(
          [...allBetaSpinePackageSet].filter((packageName) => requestedPackageSet.has(packageName)),
        );

  for (const packageName of spinePackages) {
    const maturity = maturityByPackage.get(packageName);
    if (maturity === undefined) {
      catalogErrors.push(
        `${catalogMetadataPath}: spine package ${packageName} must appear in a maturity bucket before promotion accountability can be evaluated`,
      );
      continue;
    }

    if (maturity === "alpha") {
      catalogErrors.push(
        `${catalogMetadataPath}: spine package ${packageName} is alpha; move it to maturity.beta.packages with spine.promotion.packages.${packageName} metadata before 1.0 promotion, or remove it from spine.packages`,
      );
      continue;
    }

    if (maturity === "deprecated") {
      catalogErrors.push(
        `${catalogMetadataPath}: spine package ${packageName} is deprecated; move it to maturity.beta.packages with spine.promotion.packages.${packageName} metadata before 1.0 promotion, or remove it from spine.packages`,
      );
    }
  }

  for (const packageName of allBetaSpinePackageSet) {
    if (!workspaceByShortName.has(packageName)) {
      catalogErrors.push(
        `${catalogMetadataPath}: spine package ${packageName} is beta but has no public workspace package`,
      );
    }
  }

  for (const packageName of promotionPackages.keys()) {
    if (!allBetaSpinePackageSet.has(packageName)) {
      catalogErrors.push(
        `${catalogMetadataPath}: spine.promotion.packages.${packageName} is outside the current beta spine and must be removed when promotion is complete or out of scope`,
      );
    }
  }

  const betaSpineRows = [...betaSpinePackageSet].sort().flatMap((shortName) => {
    const pkg = workspaceByShortName.get(shortName);
    if (!pkg) {
      return [];
    }

    return [
      createBetaSpineRow({
        currentCommit: options.currentCommit,
        evidenceContext: options.evidenceContext ?? null,
        group: groupByPackage.get(shortName) ?? "Unassigned",
        metadata: promotionPackages.get(shortName),
        pkg,
        rootDir: options.rootDir,
        shortName,
        testInventory:
          options.testInventory?.(pkg) ?? readVitestTestInventory(options.rootDir, pkg),
      }),
    ];
  });

  const ignoredNonSpineNonProductionCount = [...workspaceByShortName.keys()].filter((shortName) => {
    if (spinePackageSet.has(shortName)) {
      return false;
    }

    const maturity = maturityByPackage.get(shortName);
    return maturity === "beta" || maturity === "alpha" || maturity === "deprecated";
  }).length;

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    rootDir: options.rootDir,
    catalogErrors,
    catalogWarnings,
    betaSpineRows,
    ignoredNonSpineNonProductionCount,
  };
}

function formatCatalogErrors(errors: readonly string[]): string[] {
  return errors.length === 0 ? ["- none"] : errors.map((error) => `- ${error}`);
}

function formatCatalogWarnings(warnings: readonly string[]): string[] {
  return warnings.length === 0 ? ["- none"] : warnings.map((warning) => `- ${warning}`);
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function formatCell(value: string | null): string {
  return value ? escapeTableCell(value) : "_missing_";
}

function formatEvidenceCell(targetEvidence: readonly PromotionEvidenceReference[]): string {
  return targetEvidence.length === 0
    ? "_missing_"
    : targetEvidence
        .map((entry) =>
          escapeTableCell(
            `${entry.role}: ${entry.description} (${entry.commandId}${entry.testPath ? `, ${entry.testPath}` : ""}${entry.artifactPath ? `, ${entry.artifactPath}` : ""})`,
          ),
        )
        .join("<br>");
}

function formatStatusCell(row: BetaSpinePromotionRow): string {
  if (row.status === "promotion-ready") {
    return "promotion-ready";
  }
  const failures = [
    ...(row.missingFields.length > 0 ? [`missing ${row.missingFields.join(", ")}`] : []),
    ...row.evidenceFailures,
  ];
  return `blocked: ${failures.join("; ")}`;
}

function formatBetaSpineRows(rows: readonly BetaSpinePromotionRow[]): string[] {
  if (rows.length === 0) {
    return ["| _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ |"];
  }

  return rows.map(
    (row) =>
      `| \`${row.packageName}\` | ${row.group} | \`${toPosixPath(row.relativeDir)}\` | ${formatCell(row.owner)} | ${formatEvidenceCell(row.targetEvidence)} | ${formatCell(row.recoveryAction)} | ${formatStatusCell(row)} |`,
  );
}

export function countSpinePromotionFailures(report: SpinePromotionReport): number {
  return (
    report.catalogErrors.length +
    report.betaSpineRows.filter((row) => row.status === "blocked").length
  );
}

export function hasSpinePromotionFailures(report: SpinePromotionReport): boolean {
  return countSpinePromotionFailures(report) > 0;
}

export function buildSpinePromotionMarkdown(report: SpinePromotionReport): string {
  const failureCount = countSpinePromotionFailures(report);
  const lines = [
    "# Beta Spine Promotion Gate",
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Root: \`${toPosixPath(report.rootDir)}\``,
    `- Beta spine packages: ${report.betaSpineRows.length}`,
    `- Blocking failures: ${failureCount}`,
    "",
    "## Catalog errors",
    ...formatCatalogErrors(report.catalogErrors),
    "",
    "## Catalog warnings",
    ...formatCatalogWarnings(report.catalogWarnings),
    "",
    "## Beta spine promotion accountability",
    "| Package | Group | Directory | Owner | Target evidence | Recovery action | Status |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...formatBetaSpineRows(report.betaSpineRows),
    "",
    "## Non-spine non-production scope",
    `- Non-spine beta, alpha, or deprecated packages ignored by this blocking gate: ${report.ignoredNonSpineNonProductionCount}`,
    "- Non-spine non-production packages stay outside this gate unless another release path explicitly pulls them into scope.",
    "",
    "## Recovery",
    `1. Add or fix \`docs/package-catalog.json\` \`spine.promotion.packages.<name>\` with non-empty \`owner\`, \`targetEvidence\`, and \`recoveryAction\`.`,
    "2. Rerun `pnpm spine-promotion:check -- --context <current-run-context.json>` and review this report.",
    "3. When the target evidence is complete, move the package from `maturity.beta.packages` to `maturity.production.packages` and rerun `pnpm production-ready:check`.",
  ];

  return `${lines.join("\n")}\n`;
}

export function writeSpinePromotionReport(report: SpinePromotionReport, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const markdownPath = join(outputDir, reportFileName);
  writeFileSync(markdownPath, buildSpinePromotionMarkdown(report));
  return markdownPath;
}

function parseOutcome(value: string | undefined): PromotionCommandResult["outcome"] {
  if (value === "success") {
    return "passed";
  }
  if (value === "failure" || value === "cancelled") {
    return "failed";
  }
  return "skipped";
}

function readArtifact(rootDir: string, path: string, startedAt: string) {
  const absolutePath = resolve(rootDir, path);
  if (!isPathInside(resolve(rootDir), absolutePath) || !existsSync(absolutePath)) {
    return {
      exists: false,
      fresh: false,
      path,
      semanticStatus: "unknown" as const,
    };
  }
  if (!isPathInside(realpathSync(rootDir), realpathSync(absolutePath))) {
    return {
      exists: false,
      fresh: false,
      path,
      semanticStatus: "unknown" as const,
    };
  }
  const modifiedAt = statSync(absolutePath).mtimeMs;
  let semanticStatus: "passed" | "failed" | "unknown" = "unknown";
  if (path.endsWith(".json")) {
    const value = readJsonFile(absolutePath);
    if (isRecord(value)) {
      const status =
        value.status === "passed" ? "passed" : value.status === "failed" ? "failed" : null;
      const releaseStatus = isRecord(value.release) ? value.release.status : null;
      semanticStatus =
        status === "passed" && (releaseStatus === undefined || releaseStatus === "passed")
          ? "passed"
          : status === "failed" || releaseStatus === "failed"
            ? "failed"
            : "unknown";
    }
  }
  return {
    exists: true,
    fresh: modifiedAt >= Date.parse(startedAt),
    path,
    semanticStatus,
  };
}

function readTurboTestRun(
  rootDir: string,
  startedAt: string,
  completedAt?: string | null,
): {
  readonly outcome: PromotionCommandResult["outcome"];
  readonly tasks: PromotionCommandResult["testTasks"];
} {
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = completedAt ? Date.parse(completedAt) : Number.POSITIVE_INFINITY;
  const summary = readTurboRunSummaries(join(rootDir, ".turbo", "runs"))
    .filter(
      (candidate) =>
        /(?:^|\s)turbo\s+(?:run\s+)?test(?::evidence)?(?:\s|$)/.test(candidate.command) &&
        statSync(candidate.filePath).mtimeMs >= startedAtMs &&
        candidate.endTime >= startedAtMs &&
        candidate.endTime <= completedAtMs,
    )
    .at(-1);
  if (!summary) {
    return { outcome: "failed", tasks: [] };
  }
  const tasks = summary.tasks.flatMap((entry) => {
    if (entry.task !== "test") {
      return [];
    }
    return [
      {
        packageName: entry.package,
        status: entry.exitCode === 0 ? ("passed" as const) : ("failed" as const),
        taskId: entry.taskId,
      },
    ];
  });
  return { outcome: summary.exitCode === 0 ? "passed" : "failed", tasks };
}

function readTurboTestTasks(
  rootDir: string,
  startedAt: string,
  completedAt?: string | null,
): PromotionCommandResult["testTasks"] {
  return readTurboTestRun(rootDir, startedAt, completedAt).tasks;
}

function readReleaseFastTestTasks(
  report: ReleaseSpineEvidenceReport,
  check: EvidenceCheckResult,
): PromotionCommandResult["testTasks"] {
  const artifact = check.artifacts.find(
    (candidate) =>
      candidate.required && toPosixPath(candidate.path) === toPosixPath(fastTestLaneReportPath),
  );
  if (!artifact) {
    throw new Error(`Release test check must own required artifact ${fastTestLaneReportPath}`);
  }
  if (!artifact.exists || !artifact.fresh) {
    throw new Error(`Release test check artifact ${fastTestLaneReportPath} is missing or stale`);
  }
  if (toPosixPath(artifact.sourcePath) !== toPosixPath(fastTestLaneReportPath)) {
    throw new Error(`Release test check artifact source does not match ${fastTestLaneReportPath}`);
  }

  const laneReport = readJsonFile(resolve(report.rootDir, artifact.sourcePath));
  assertLaneReport(laneReport);
  if (laneReport.lane !== "fast") {
    throw new Error(`Release test lane evidence must be fast, received ${laneReport.lane}`);
  }
  if (laneReport.diagnostics.length !== 0) {
    throw new Error("Release test lane evidence must not contain diagnostics");
  }

  const { diagnostics, inventory } = readTestInventory(join(report.rootDir, "test-inventory.json"));
  if (diagnostics.length > 0) {
    throw new Error(`Current test inventory is invalid: ${JSON.stringify(diagnostics)}`);
  }
  if (laneReport.inventoryDigest !== inventoryDigest(inventory)) {
    throw new Error("Release test lane evidence uses a stale test inventory digest");
  }
  if (new Set(laneReport.selectedOwners).size !== laneReport.selectedOwners.length) {
    throw new Error("Release test lane evidence contains duplicate selected owners");
  }

  const commandsByOwner = new Map<string, LaneReport["commands"][number]>();
  for (const command of laneReport.commands) {
    if (commandsByOwner.has(command.owner)) {
      throw new Error(`Release test lane evidence contains duplicate owner ${command.owner}`);
    }
    commandsByOwner.set(command.owner, command);
  }
  const expectedPlan = createTestLanePlan(inventory, "fast", laneReport.selectedOwners);
  if (expectedPlan.length !== laneReport.commands.length) {
    throw new Error("Release test lane evidence does not cover the exact selected fast-lane plan");
  }
  for (const expected of expectedPlan) {
    const actual = commandsByOwner.get(expected.owner);
    if (
      !actual ||
      actual.cwd !== expected.cwd ||
      JSON.stringify(actual.paths) !== JSON.stringify(expected.paths) ||
      JSON.stringify(actual.command) !== JSON.stringify(expected.command)
    ) {
      throw new Error(
        `Release test lane evidence for ${expected.owner} does not match the selected fast-lane plan`,
      );
    }
  }

  return laneReport.commands.map((command) => ({
    packageName: command.owner,
    status: "passed",
    taskId: `${command.owner}#test`,
  }));
}

export function createCiPromotionEvidenceContext(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly rootDir: string;
  readonly runFile: string;
}): PromotionEvidenceContext {
  const run = readJsonFile(options.runFile);
  if (
    !isRecord(run) ||
    typeof run.commitSha !== "string" ||
    typeof run.runId !== "string" ||
    typeof run.runAttempt !== "string" ||
    typeof run.startedAt !== "string"
  ) {
    throw new Error(
      "CI promotion run file must define commitSha, runId, runAttempt, and startedAt",
    );
  }
  const commitSha = run.commitSha;
  const runAttempt = run.runAttempt;
  const runId = run.runId;
  const runStartedAt = run.startedAt;
  const completedAt = new Date().toISOString();
  const command = (
    commandId: string,
    outcome: PromotionCommandResult["outcome"],
    artifacts: PromotionCommandResult["artifacts"] = [],
    testTasks: PromotionCommandResult["testTasks"] = [],
  ): PromotionCommandResult => ({
    artifacts,
    blocking: true,
    commandId,
    completedAt,
    outcome,
    runAttempt,
    runId,
    startedAt: runStartedAt,
    testTasks,
  });

  return {
    schemaVersion: 1,
    source: "ci",
    commitSha,
    runId,
    runAttempt,
    startedAt: runStartedAt,
    completedAt,
    commands: [
      command(
        "test",
        parseOutcome(options.env.SPINE_PROMOTION_TEST_OUTCOME),
        [],
        readTurboTestTasks(options.rootDir, runStartedAt),
      ),
      command(
        "generated-app-smoke",
        parseOutcome(options.env.SPINE_PROMOTION_GENERATED_APP_OUTCOME),
        [
          readArtifact(
            options.rootDir,
            "ci-reports/generated-apps/spine-blocking-matrix.json",
            runStartedAt,
          ),
        ],
      ),
    ],
  };
}

export function createReleasePromotionEvidenceContext(options: {
  readonly checkpointPath: string;
  readonly commitSha: string;
  readonly runId: string;
  readonly runAttempt: string;
}): PromotionEvidenceContext {
  const report = readJsonFile(options.checkpointPath) as ReleaseSpineEvidenceReport;
  if (
    report.schemaVersion !== 1 ||
    !Array.isArray(report.checks) ||
    !isRecord(report.provenance) ||
    typeof report.provenance.commitSha !== "string" ||
    typeof report.provenance.runId !== "string" ||
    typeof report.provenance.runAttempt !== "string"
  ) {
    throw new Error("Release promotion checkpoint is not a release spine evidence report");
  }
  if (
    report.provenance.commitSha !== options.commitSha ||
    report.provenance.runId !== options.runId ||
    report.provenance.runAttempt !== options.runAttempt
  ) {
    throw new Error("Release promotion checkpoint provenance does not match the current run");
  }
  const testChecks = report.checks.filter((check) => check.id === "test");
  if (testChecks.length !== 1) {
    throw new Error("Release promotion checkpoint must contain exactly one test check");
  }
  const releaseTestTasks = readReleaseFastTestTasks(report, testChecks[0]);
  return {
    schemaVersion: 1,
    source: "release",
    commitSha: options.commitSha,
    runId: options.runId,
    runAttempt: options.runAttempt,
    startedAt: report.generatedAt,
    completedAt: new Date().toISOString(),
    commands: report.checks.map((check) => ({
      artifacts: check.artifacts.map((artifact: EvidenceArtifactReference) => ({
        exists: artifact.exists,
        fresh: artifact.fresh,
        path: relative(report.rootDir, artifact.sourcePath).split("\\").join("/"),
        semanticStatus:
          artifact.sourcePath.endsWith(".json") && artifact.exists
            ? readArtifact(
                report.rootDir,
                relative(report.rootDir, artifact.sourcePath),
                check.startedAt ?? report.generatedAt,
              ).semanticStatus
            : "unknown",
      })),
      blocking: true,
      commandId: check.id,
      completedAt: check.completedAt,
      outcome:
        check.status === "passed"
          ? "passed"
          : check.status === "failed"
            ? "failed"
            : check.status === "timed_out"
              ? "timed_out"
              : check.status === "interrupted"
                ? "interrupted"
                : check.status === "skipped_after_timeout"
                  ? "skipped"
                  : check.status === "skipped_prerequisite"
                    ? "skipped"
                    : "pending",
      runAttempt: options.runAttempt,
      runId: options.runId,
      startedAt: check.startedAt,
      testTasks: check.id === "test" ? releaseTestTasks : [],
    })),
  };
}

export function readExplicitPromotionEvidenceContext(
  contextFile: string,
  rootDir: string,
): PromotionEvidenceContext {
  const context = readJsonFile(contextFile);
  if (
    !isRecord(context) ||
    context.schemaVersion !== 1 ||
    context.source !== "local" ||
    typeof context.commitSha !== "string" ||
    typeof context.runId !== "string" ||
    typeof context.runAttempt !== "string" ||
    typeof context.startedAt !== "string" ||
    typeof context.completedAt !== "string" ||
    !Array.isArray(context.commands)
  ) {
    throw new Error("Local promotion evidence context does not match schemaVersion 1");
  }

  const commandRecords = context.commands.map((command) => {
    if (
      !isRecord(command) ||
      typeof command.commandId !== "string" ||
      !Array.isArray(command.artifacts)
    ) {
      throw new Error("Local promotion evidence commands require commandId and artifacts");
    }
    const artifactPaths = command.artifacts.map((artifact) => {
      if (!isRecord(artifact) || typeof artifact.path !== "string" || !artifact.path.trim()) {
        throw new Error("Local promotion evidence artifacts require a non-empty path");
      }
      return artifact.path;
    });
    return { artifactPaths, commandId: command.commandId };
  });
  if (new Set(commandRecords.map(({ commandId }) => commandId)).size !== commandRecords.length) {
    throw new Error("Local promotion evidence command IDs must be unique");
  }

  const testRun = readTurboTestRun(rootDir, context.startedAt);
  const manifestById = new Map(
    createReleaseSpineEvidenceManifest().map((command) => [command.id, command]),
  );
  const commands = commandRecords.map(({ artifactPaths, commandId }): PromotionCommandResult => {
    if (commandId === "test") {
      return {
        artifacts: [],
        blocking: true,
        commandId,
        completedAt: context.completedAt,
        outcome: testRun.outcome,
        runAttempt: context.runAttempt,
        runId: context.runId,
        startedAt: context.startedAt,
        testTasks: testRun.tasks,
      };
    }
    if (commandId === "generated-app-smoke") {
      const allowedArtifacts = new Set(
        (manifestById.get(commandId)?.artifacts ?? []).map((artifact) => artifact.path),
      );
      const unknownArtifact = artifactPaths.find((path) => !allowedArtifacts.has(path));
      if (unknownArtifact) {
        throw new Error(
          `Local promotion evidence artifact ${unknownArtifact} is not declared by ${commandId}`,
        );
      }
      const artifacts = artifactPaths.map((path) => readArtifact(rootDir, path, context.startedAt));
      return {
        artifacts,
        blocking: true,
        commandId,
        completedAt: context.completedAt,
        outcome:
          artifacts.length > 0 &&
          artifacts.every(
            (artifact) => artifact.exists && artifact.fresh && artifact.semanticStatus === "passed",
          )
            ? "passed"
            : "failed",
        runAttempt: context.runAttempt,
        runId: context.runId,
        startedAt: context.startedAt,
        testTasks: [],
      };
    }
    throw new Error(`Local promotion evidence does not support command ${commandId}`);
  });

  return {
    schemaVersion: 1,
    source: "local",
    commitSha: context.commitSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    startedAt: context.startedAt,
    completedAt: context.completedAt,
    commands,
  };
}

export function parseArgs(args: readonly string[] = argv.slice(2)): Options {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  let ciRunFile: string | null = null;
  let contextFile: string | null = null;
  let rootDir = process.cwd();
  let outputDir = reportDirectory;
  const packageNames: string[] = [];

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (arg === "--root") {
      const value = normalizedArgs[index + 1];
      if (!value) {
        throw new Error("--root requires a path");
      }
      rootDir = resolve(value);
      index += 1;
      continue;
    }

    if (arg === "--output-dir") {
      const value = normalizedArgs[index + 1];
      if (!value) {
        throw new Error("--output-dir requires a path");
      }
      outputDir = value;
      index += 1;
      continue;
    }

    if (arg === "--context") {
      const value = normalizedArgs[index + 1];
      if (!value) {
        throw new Error("--context requires a path");
      }
      contextFile = value;
      index += 1;
      continue;
    }

    if (arg === "--ci-run") {
      const value = normalizedArgs[index + 1];
      if (!value) {
        throw new Error("--ci-run requires a path");
      }
      ciRunFile = value;
      index += 1;
      continue;
    }

    if (arg === "--package") {
      const value = normalizedArgs[index + 1];
      if (!value) {
        throw new Error("--package requires a package name");
      }
      packageNames.push(value.replace(/^@croco\//, ""));
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    ciRunFile: ciRunFile ? resolve(rootDir, ciRunFile) : null,
    contextFile: contextFile ? resolve(rootDir, contextFile) : null,
    rootDir,
    outputDir: resolve(rootDir, outputDir),
    packageNames: [...new Set(packageNames)].sort(),
  };
}

function loadPromotionEvidenceContext(options: Options): PromotionEvidenceContext {
  if (options.contextFile) {
    return readExplicitPromotionEvidenceContext(options.contextFile, options.rootDir);
  }
  if (options.ciRunFile) {
    return createCiPromotionEvidenceContext({
      env: process.env,
      rootDir: options.rootDir,
      runFile: options.ciRunFile,
    });
  }
  const checkpointPath = process.env.SPINE_PROMOTION_RELEASE_CHECKPOINT;
  const commitSha = process.env.SPINE_PROMOTION_COMMIT_SHA;
  const runId = process.env.SPINE_PROMOTION_RUN_ID;
  const runAttempt = process.env.SPINE_PROMOTION_RUN_ATTEMPT;
  if (checkpointPath && commitSha && runId && runAttempt) {
    return createReleasePromotionEvidenceContext({
      checkpointPath,
      commitSha,
      runId,
      runAttempt,
    });
  }
  throw new Error(
    "current-run evidence is required; pass --context, --ci-run, or use release:spine-evidence",
  );
}

function main(): void {
  const options = parseArgs();
  const report = createSpinePromotionReport({
    evidenceContext: loadPromotionEvidenceContext(options),
    packageNames: options.packageNames,
    rootDir: options.rootDir,
  });
  const markdownPath = writeSpinePromotionReport(report, options.outputDir);
  const failureCount = countSpinePromotionFailures(report);

  console.log(`spine-promotion-check: wrote ${markdownPath}`);
  console.log(`spine-promotion-check: beta spine packages=${report.betaSpineRows.length}`);
  console.log(`spine-promotion-check: blocking failures=${failureCount}`);

  if (failureCount > 0) {
    exit(1);
  }
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`spine-promotion-check: failed: ${message}`);
    exit(1);
  }
}
