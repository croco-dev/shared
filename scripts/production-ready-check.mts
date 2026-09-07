#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import {
  createPackageQualityReport,
  type PackageQualityRow,
  type QualityTask,
  readPackages,
} from "./package-quality-report.mts";
import { assertLaneReport, type LaneReport } from "./test-evidence-reconcile.mts";
import {
  inventoryDigest,
  readTestInventory,
  type TestInventoryEntry,
  type TestLane,
} from "./test-inventory.mts";
import { createTestLanePlan } from "./test-lane-runner.mts";

type CheckStatus = "pass" | "fail" | "not-applicable" | "not-collected";
type MaturityKey = (typeof maturityOrder)[number];

type Options = {
  readonly rootDir: string;
  readonly outputDir: string;
  readonly summaryDir: string;
  readonly requireTaskSummaries: boolean;
  readonly fastTestLaneReportPath: string | null;
};

type WorkspacePackage = {
  readonly name: string;
  readonly shortName: string;
  readonly relativeDir: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly group: string;
  readonly maturity: MaturityKey;
  readonly hasApiDocs: boolean;
  readonly hasEntrypoint: boolean;
  readonly hasReadme: boolean;
  readonly hasTests: boolean;
};

type CatalogEvidence = {
  readonly errors: readonly string[];
  readonly extensionGroups: ReadonlySet<string>;
  readonly extensionPackages: ReadonlySet<string>;
  readonly groupByPackage: ReadonlyMap<string, string>;
  readonly maturityByPackage: ReadonlyMap<string, MaturityKey>;
  readonly productionPackages: readonly string[];
  readonly spinePackages: ReadonlySet<string>;
  readonly behavioralEvidenceByPackage: ReadonlyMap<string, BehavioralEvidence>;
};

type BehavioralEvidenceReference = {
  readonly testFile: string;
  readonly testName: string;
};

type BehavioralEvidence = {
  readonly runtime: "node";
  readonly positive: BehavioralEvidenceReference;
  readonly negative: BehavioralEvidenceReference;
};

type BaselineEvidence = {
  readonly errors: readonly string[];
  readonly temporaryProductionApiDocExceptions: ReadonlyMap<string, string>;
};

type PublicApiSnapshotEvidence = {
  readonly errors: readonly string[];
  readonly missingSnapshot: boolean;
  readonly packageNames: ReadonlySet<string>;
};

type FastTestLaneEvidence = {
  readonly commandsByOwner: ReadonlyMap<string, LaneReport["commands"][number]>;
  readonly errors: readonly string[];
};

export type ProductionReadyCheck = {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly evidence: string;
  readonly recovery: string | null;
};

export type ProductionReadyPackageRow = {
  readonly packageName: string;
  readonly relativeDir: string;
  readonly group: string;
  readonly checks: readonly ProductionReadyCheck[];
};

export type NonProductionSummary = {
  readonly maturity: MaturityKey;
  readonly packageCount: number;
  readonly missingApiDocs: number;
  readonly missingReadme: number;
  readonly missingTests: number;
};

export type ProductionReadyReport = {
  readonly generatedAt: string;
  readonly rootDir: string;
  readonly summaryDir: string;
  readonly requireTaskSummaries: boolean;
  readonly catalogErrors: readonly string[];
  readonly productionRows: readonly ProductionReadyPackageRow[];
  readonly nonProduction: readonly NonProductionSummary[];
};

const reportDirectory = join("ci-reports", "package-quality");
const reportFileName = "production-ready.md";
const turboRunsDirectory = join(".turbo", "runs");
const catalogMetadataPath = join("docs", "package-catalog.json");
const docsBaselinePath = join("docs", "package-docs-baseline.json");
const publicApiSnapshotPath = "public-api-surface.snapshot.json";
const testInventoryPath = "test-inventory.json";
const apiDocsRoot = join("packages", "docs", "src", "content", "docs", "api");
const referenceDocsRoot = join("packages", "docs", "src", "content", "docs", "en", "reference");
const maturityOrder = ["production", "beta", "alpha", "deprecated"] as const;
const qualityTasks = ["build", "typecheck", "test"] as const satisfies readonly QualityTask[];
const extensionEvidenceDocsByGroup: Readonly<Record<string, readonly string[]>> = {
  Integration: [
    join(referenceDocsRoot, "adapter-ecosystem.md"),
    join(referenceDocsRoot, "extension-matrix.md"),
  ],
  Presentation: [
    join(referenceDocsRoot, "presentation-runtime-support.md"),
    join(referenceDocsRoot, "extension-matrix.md"),
  ],
  Provider: [
    join(referenceDocsRoot, "adapter-ecosystem.md"),
    join(referenceDocsRoot, "provider-maturity.md"),
    join(referenceDocsRoot, "extension-matrix.md"),
  ],
  Transport: [
    join(referenceDocsRoot, "adapter-ecosystem.md"),
    join(referenceDocsRoot, "extension-matrix.md"),
  ],
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function toShortPackageName(packageName: string): string {
  return packageName.replace(/^@croco\//, "");
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
}

function loadFastTestLaneEvidenceFromValue(
  report: unknown,
  label: string,
  inventory: ReturnType<typeof readTestInventory>["inventory"],
): FastTestLaneEvidence {
  try {
    assertLaneReport(report);
    if (report.lane !== "fast") {
      throw new Error(`expected fast lane, received ${report.lane}`);
    }
    if (report.inventoryDigest !== inventoryDigest(inventory)) {
      throw new Error("inventory digest does not match the current test inventory");
    }

    const commandsByOwner = new Map<string, LaneReport["commands"][number]>();
    for (const command of report.commands) {
      if (commandsByOwner.has(command.owner)) {
        throw new Error(`owner ${command.owner} appears more than once`);
      }
      commandsByOwner.set(command.owner, command);
    }
    if (report.selectedOwners.length !== 0) {
      throw new Error("expected a full repository fast-lane report without owner filtering");
    }
    if (report.diagnostics.length !== 0) {
      throw new Error("expected a passed fast-lane report without diagnostics");
    }
    const expectedPlan = createTestLanePlan(inventory, "fast");
    if (report.commands.length !== expectedPlan.length) {
      throw new Error("completed commands do not cover the full fast-lane plan");
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
          `completed command for ${expected.owner} does not match the fast-lane plan`,
        );
      }
    }

    return { commandsByOwner, errors: [] };
  } catch (error) {
    return {
      commandsByOwner: new Map(),
      errors: [
        `Fast test lane evidence ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function loadFastTestLaneEvidence(
  reportPath: string,
  inventory: ReturnType<typeof readTestInventory>["inventory"],
): FastTestLaneEvidence {
  return loadFastTestLaneEvidenceFromValue(readJsonFile(reportPath), reportPath, inventory);
}

function resolveFastTestLaneEvidence(
  options: {
    readonly fastTestLaneReportPath?: string | null;
    readonly fastTestLaneReport?: LaneReport | null;
  },
  inventory: ReturnType<typeof readTestInventory>["inventory"],
): FastTestLaneEvidence | null {
  if (options.fastTestLaneReport) {
    return loadFastTestLaneEvidenceFromValue(
      options.fastTestLaneReport,
      "normalized synthesis input",
      inventory,
    );
  }
  if (options.fastTestLaneReportPath) {
    return loadFastTestLaneEvidence(options.fastTestLaneReportPath, inventory);
  }
  return null;
}

function applyFastTestLaneEvidence(
  rows: readonly PackageQualityRow[],
  evidence: FastTestLaneEvidence | null,
): readonly PackageQualityRow[] {
  if (!evidence) {
    return rows;
  }

  return rows.map((row) => {
    const command = evidence.commandsByOwner.get(row.packageName);
    return {
      ...row,
      tasks: {
        ...row.tasks,
        test: command
          ? {
              task: "test" as const,
              status: "pass" as const,
              taskId: `${row.packageName}#test`,
              logFile: null,
              cacheStatus: command.cacheStatus?.toUpperCase() ?? null,
            }
          : {
              task: "test" as const,
              status: "not-run" as const,
              taskId: null,
              logFile: null,
              cacheStatus: null,
            },
      },
    };
  });
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

    if (!isStringArray(groupValue.packages)) {
      errors.push(`${catalogMetadataPath}: groups.${groupName}.packages must be a string array`);
      continue;
    }

    for (const packageName of groupValue.packages) {
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

function readMaturityPackages(
  maturityValue: unknown,
  maturity: MaturityKey,
  errors: string[],
): readonly string[] {
  if (!isRecord(maturityValue)) {
    errors.push(`${catalogMetadataPath}: maturity.${maturity} must be an object`);
    return [];
  }

  if (!isStringArray(maturityValue.packages)) {
    errors.push(`${catalogMetadataPath}: maturity.${maturity}.packages must be a string array`);
    return [];
  }

  return maturityValue.packages;
}

function parseCatalogMaturity(
  maturityRoot: unknown,
  errors: string[],
): {
  readonly maturityByPackage: ReadonlyMap<string, MaturityKey>;
  readonly productionPackages: readonly string[];
} {
  const maturityByPackage = new Map<string, MaturityKey>();
  let productionPackages: readonly string[] = [];

  if (!isRecord(maturityRoot)) {
    errors.push(`${catalogMetadataPath}: maturity must be an object`);
    return { maturityByPackage, productionPackages };
  }

  for (const maturity of maturityOrder) {
    const packageNames = readMaturityPackages(maturityRoot[maturity], maturity, errors);
    if (maturity === "production") {
      productionPackages = packageNames;
    }

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

  return { maturityByPackage, productionPackages };
}

function parseExtensionEvidence(extensionMatrix: unknown): {
  readonly extensionGroups: ReadonlySet<string>;
  readonly extensionPackages: ReadonlySet<string>;
} {
  if (!isRecord(extensionMatrix)) {
    return {
      extensionGroups: new Set(),
      extensionPackages: new Set(),
    };
  }

  const extensionGroups = isStringArray(extensionMatrix.groups)
    ? new Set(extensionMatrix.groups)
    : new Set<string>();
  const extensionPackages = isRecord(extensionMatrix.packages)
    ? new Set(Object.keys(extensionMatrix.packages))
    : new Set<string>();

  return {
    extensionGroups,
    extensionPackages,
  };
}

function parseBehavioralEvidenceReference(
  value: unknown,
  metadataPath: string,
  errors: string[],
): BehavioralEvidenceReference | null {
  if (!isRecord(value)) {
    errors.push(`${metadataPath} must be an object`);
    return null;
  }

  const keys = Object.keys(value);
  if (keys.some((key) => key !== "testFile" && key !== "testName")) {
    errors.push(`${metadataPath} only supports testFile and testName`);
  }

  if (typeof value.testFile !== "string" || value.testFile.trim().length === 0) {
    errors.push(`${metadataPath}.testFile must be a non-empty string`);
    return null;
  }

  if (typeof value.testName !== "string" || value.testName.trim().length === 0) {
    errors.push(`${metadataPath}.testName must be a non-empty string`);
    return null;
  }

  return {
    testFile: value.testFile,
    testName: value.testName,
  };
}

function parseBehavioralEvidence(
  spineValue: unknown,
  actualPackageNames: ReadonlySet<string>,
  productionPackageNames: ReadonlySet<string>,
  errors: string[],
): {
  readonly spinePackages: ReadonlySet<string>;
  readonly behavioralEvidenceByPackage: ReadonlyMap<string, BehavioralEvidence>;
} {
  const spinePackages = new Set<string>();
  const behavioralEvidenceByPackage = new Map<string, BehavioralEvidence>();
  if (!isRecord(spineValue)) {
    errors.push(`${catalogMetadataPath}: spine must be an object`);
    return { spinePackages, behavioralEvidenceByPackage };
  }

  if (!isStringArray(spineValue.packages)) {
    errors.push(`${catalogMetadataPath}: spine.packages must be a string array`);
  } else {
    for (const packageName of spineValue.packages) {
      spinePackages.add(packageName);
    }
  }

  const behavioralEvidence = spineValue.behavioralEvidence;
  if (!isRecord(behavioralEvidence) || !isRecord(behavioralEvidence.packages)) {
    return { spinePackages, behavioralEvidenceByPackage };
  }

  if (Object.keys(behavioralEvidence).some((key) => key !== "packages")) {
    errors.push(`${catalogMetadataPath}: spine.behavioralEvidence only supports packages`);
  }

  for (const [packageName, value] of Object.entries(behavioralEvidence.packages)) {
    const metadataPath = `${catalogMetadataPath}: spine.behavioralEvidence.packages.${packageName}`;
    if (!actualPackageNames.has(packageName)) {
      errors.push(`${metadataPath} references a missing package`);
      continue;
    }
    if (!spinePackages.has(packageName)) {
      errors.push(`${metadataPath} is stale because ${packageName} is not a spine package`);
      continue;
    }
    if (!productionPackageNames.has(packageName)) {
      errors.push(`${metadataPath} is stale because ${packageName} is not production-ready`);
      continue;
    }
    if (!isRecord(value)) {
      errors.push(`${metadataPath} must be an object`);
      continue;
    }
    if (
      Object.keys(value).some(
        (key) => key !== "runtime" && key !== "positive" && key !== "negative",
      )
    ) {
      errors.push(`${metadataPath} only supports runtime, positive, and negative`);
    }
    if (value.runtime !== "node") {
      errors.push(`${metadataPath}.runtime must be the literal "node"`);
      continue;
    }

    const positive = parseBehavioralEvidenceReference(
      value.positive,
      `${metadataPath}.positive`,
      errors,
    );
    const negative = parseBehavioralEvidenceReference(
      value.negative,
      `${metadataPath}.negative`,
      errors,
    );
    if (positive && negative) {
      behavioralEvidenceByPackage.set(packageName, {
        runtime: "node",
        positive,
        negative,
      });
    }
  }

  return { spinePackages, behavioralEvidenceByPackage };
}

function loadCatalogEvidence(rootDir: string): CatalogEvidence {
  const errors: string[] = [];
  const catalog = readJsonFile(join(rootDir, catalogMetadataPath));

  if (!isRecord(catalog)) {
    return {
      errors: [`${catalogMetadataPath}: must contain an object`],
      extensionGroups: new Set(),
      extensionPackages: new Set(),
      groupByPackage: new Map(),
      maturityByPackage: new Map(),
      productionPackages: [],
      spinePackages: new Set(),
      behavioralEvidenceByPackage: new Map(),
    };
  }

  const groupByPackage = parseCatalogGroups(catalog.groups, errors);
  const maturity = parseCatalogMaturity(catalog.maturity, errors);
  const extension = parseExtensionEvidence(catalog.extensionMatrix);
  const actualPackageNames = new Set(groupByPackage.keys());
  const behavioral = parseBehavioralEvidence(
    catalog.spine,
    actualPackageNames,
    new Set(maturity.productionPackages),
    errors,
  );

  return {
    errors,
    extensionGroups: extension.extensionGroups,
    extensionPackages: extension.extensionPackages,
    groupByPackage,
    maturityByPackage: maturity.maturityByPackage,
    productionPackages: maturity.productionPackages,
    spinePackages: behavioral.spinePackages,
    behavioralEvidenceByPackage: behavioral.behavioralEvidenceByPackage,
  };
}

function loadBaselineEvidence(
  rootDir: string,
  productionPackageNames: ReadonlySet<string>,
  actualPackageNames: ReadonlySet<string>,
): BaselineEvidence {
  const errors: string[] = [];
  const baseline = readJsonFile(join(rootDir, docsBaselinePath));
  const value = isRecord(baseline) ? baseline.temporaryProductionApiDocExceptions : undefined;

  if (value === undefined) {
    return {
      errors,
      temporaryProductionApiDocExceptions: new Map(),
    };
  }

  if (!isRecord(value)) {
    return {
      errors: [
        `${docsBaselinePath}: temporaryProductionApiDocExceptions must be an object mapping production package names to non-empty justification strings`,
      ],
      temporaryProductionApiDocExceptions: new Map(),
    };
  }

  const exceptions = new Map<string, string>();
  for (const [packageName, reason] of Object.entries(value)) {
    if (!actualPackageNames.has(packageName)) {
      errors.push(
        `${docsBaselinePath}: temporaryProductionApiDocExceptions references missing package ${packageName}`,
      );
      continue;
    }

    if (!productionPackageNames.has(packageName)) {
      errors.push(
        `${docsBaselinePath}: temporaryProductionApiDocExceptions.${packageName} is only valid for production-ready packages`,
      );
      continue;
    }

    if (typeof reason !== "string" || reason.trim().length === 0) {
      errors.push(
        `${docsBaselinePath}: temporaryProductionApiDocExceptions.${packageName} must include a non-empty justification`,
      );
      continue;
    }

    exceptions.set(packageName, reason.trim());
  }

  return {
    errors,
    temporaryProductionApiDocExceptions: exceptions,
  };
}

function loadPublicApiSnapshotEvidence(rootDir: string): PublicApiSnapshotEvidence {
  const snapshotPath = join(rootDir, publicApiSnapshotPath);
  if (!existsSync(snapshotPath)) {
    return {
      errors: [],
      missingSnapshot: true,
      packageNames: new Set(),
    };
  }

  const snapshot = readJsonFile(snapshotPath);
  if (!isRecord(snapshot) || snapshot.schemaVersion !== 2 || !Array.isArray(snapshot.packages)) {
    return {
      errors: [`${publicApiSnapshotPath}: schemaVersion must be 2 and packages must be an array`],
      missingSnapshot: false,
      packageNames: new Set(),
    };
  }

  const errors: string[] = [];
  const packageNames = new Set<string>();
  for (const [index, value] of snapshot.packages.entries()) {
    if (!isRecord(value) || typeof value.packageName !== "string") {
      errors.push(`${publicApiSnapshotPath}: packages[${index}].packageName must be a string`);
      continue;
    }
    packageNames.add(value.packageName);
  }

  return {
    errors,
    missingSnapshot: false,
    packageNames,
  };
}

function toWorkspacePackage(
  rootDir: string,
  groupByPackage: ReadonlyMap<string, string>,
  maturityByPackage: ReadonlyMap<string, MaturityKey>,
  packageInfo: ReturnType<typeof readPackages>[number],
): WorkspacePackage {
  const shortName = toShortPackageName(packageInfo.name);
  const packageRoot = join(rootDir, packageInfo.relativeDir);

  return {
    name: packageInfo.name,
    shortName,
    relativeDir: packageInfo.relativeDir,
    scripts: packageInfo.scripts,
    group: groupByPackage.get(shortName) ?? "Unassigned",
    maturity: maturityByPackage.get(shortName) ?? "alpha",
    hasApiDocs: existsSync(join(rootDir, apiDocsRoot, shortName)),
    hasEntrypoint: existsSync(join(packageRoot, "src", "index.ts")),
    hasReadme: existsSync(join(packageRoot, "README.md")),
    hasTests:
      existsSync(join(packageRoot, "src", "tests")) ||
      existsSync(join(packageRoot, "src", "__tests__")),
  };
}

function pass(id: string, label: string, evidence: string): ProductionReadyCheck {
  return { id, label, status: "pass", evidence, recovery: null };
}

function fail(id: string, label: string, evidence: string, recovery: string): ProductionReadyCheck {
  return { id, label, status: "fail", evidence, recovery };
}

function notApplicable(id: string, label: string, evidence: string): ProductionReadyCheck {
  return { id, label, status: "not-applicable", evidence, recovery: null };
}

function notCollected(
  id: string,
  label: string,
  evidence: string,
  recovery: string,
): ProductionReadyCheck {
  return { id, label, status: "not-collected", evidence, recovery };
}

function createReadmeCheck(pkg: WorkspacePackage): ProductionReadyCheck {
  if (pkg.hasReadme) {
    return pass("readme", "README", `${pkg.relativeDir}/README.md exists`);
  }

  return fail(
    "readme",
    "README",
    `${pkg.relativeDir}/README.md is missing`,
    `Add ${pkg.relativeDir}/README.md before marking the package production-ready.`,
  );
}

function createApiDocsCheck(
  pkg: WorkspacePackage,
  temporaryExceptions: ReadonlyMap<string, string>,
): ProductionReadyCheck {
  const temporaryReason = temporaryExceptions.get(pkg.shortName);
  if (pkg.hasApiDocs && temporaryReason) {
    return fail(
      "api-docs",
      "API docs",
      `${apiDocsRoot}/${pkg.shortName} exists but temporaryProductionApiDocExceptions still contains ${pkg.shortName}`,
      `Remove ${pkg.shortName} from docs/package-docs-baseline.json temporaryProductionApiDocExceptions.`,
    );
  }

  if (pkg.hasApiDocs) {
    return pass("api-docs", "API docs", `${apiDocsRoot}/${pkg.shortName} exists`);
  }

  if (temporaryReason) {
    return pass(
      "api-docs",
      "API docs",
      `temporary production API-docs exception: ${temporaryReason}`,
    );
  }

  return fail(
    "api-docs",
    "API docs",
    `${apiDocsRoot}/${pkg.shortName} is missing`,
    `Generate ${apiDocsRoot}/${pkg.shortName} or add a short-lived justified temporaryProductionApiDocExceptions entry.`,
  );
}

function createTestsCheck(pkg: WorkspacePackage): ProductionReadyCheck {
  if (pkg.hasTests) {
    return pass("tests", "Tests", `${pkg.relativeDir}/src/tests or src/__tests__ exists`);
  }

  return fail(
    "tests",
    "Tests",
    `${pkg.relativeDir}/src/tests and src/__tests__ are missing`,
    `Add focused package tests under ${pkg.relativeDir}/src/tests before production-ready promotion.`,
  );
}

function createTaskCheck(
  pkg: WorkspacePackage,
  row: PackageQualityRow | undefined,
  task: QualityTask,
  requireTaskSummaries: boolean,
): ProductionReadyCheck {
  const id = `${task}-report`;
  const label = `${task} report`;

  if (!pkg.scripts[task]) {
    return fail(
      id,
      label,
      `${pkg.relativeDir}/package.json has no ${task} script`,
      `Add a ${task} script or keep the package out of production-ready maturity.`,
    );
  }

  const result = row?.tasks[task];
  if (!result) {
    return fail(
      id,
      label,
      "package quality row is missing",
      "Run the package quality report after workspace package discovery succeeds.",
    );
  }

  if (result.status === "pass") {
    return pass(id, label, result.taskId ? `${result.taskId} passed` : `${task} passed`);
  }

  if (result.status === "fail") {
    const log = result.logFile ? `; log: ${result.logFile}` : "";
    return fail(id, label, `${task} failed${log}`, `Fix the ${task} failure for ${pkg.name}.`);
  }

  if (requireTaskSummaries) {
    return fail(
      id,
      label,
      `${task} status is ${result.status}`,
      `Run pnpm turbo run ${task} --summarize before the production-ready gate.`,
    );
  }

  return notCollected(
    id,
    label,
    `${task} status is ${result.status}; local report does not require Turbo summaries`,
    `Run pnpm turbo run ${task} --summarize for CI-level package task evidence.`,
  );
}

function createPublicApiCheck(
  pkg: WorkspacePackage,
  snapshot: PublicApiSnapshotEvidence,
): ProductionReadyCheck {
  if (!pkg.hasEntrypoint) {
    return notApplicable(
      "public-api-snapshot",
      "Public API snapshot",
      `${pkg.relativeDir}/src/index.ts is absent`,
    );
  }

  if (snapshot.missingSnapshot) {
    return fail(
      "public-api-snapshot",
      "Public API snapshot",
      `${publicApiSnapshotPath} is missing`,
      "Run pnpm public-api:write and commit the generated snapshot.",
    );
  }

  if (snapshot.packageNames.has(pkg.name)) {
    return pass("public-api-snapshot", "Public API snapshot", `${pkg.name} is listed`);
  }

  return fail(
    "public-api-snapshot",
    "Public API snapshot",
    `${pkg.name} is missing from ${publicApiSnapshotPath}`,
    "Run pnpm public-api:write and review the generated snapshot before promotion.",
  );
}

function docsMentionPackage(rootDir: string, docsPath: string, pkg: WorkspacePackage): boolean {
  const absolutePath = join(rootDir, docsPath);
  if (!existsSync(absolutePath)) {
    return false;
  }

  const content = readFileSync(absolutePath, "utf-8");
  return content.includes(pkg.name) || content.includes(pkg.shortName);
}

function requiredEvidenceDocs(pkg: WorkspacePackage, catalog: CatalogEvidence): readonly string[] {
  const docsForGroup = extensionEvidenceDocsByGroup[pkg.group] ?? [];
  if (docsForGroup.length > 0) {
    return docsForGroup;
  }

  if (catalog.extensionGroups.has(pkg.group) || catalog.extensionPackages.has(pkg.shortName)) {
    return [join(referenceDocsRoot, "extension-matrix.md")];
  }

  return [];
}

function createMaturityEvidenceCheck(
  rootDir: string,
  pkg: WorkspacePackage,
  catalog: CatalogEvidence,
): ProductionReadyCheck {
  const docsPaths = requiredEvidenceDocs(pkg, catalog);
  if (docsPaths.length === 0) {
    return notApplicable(
      "maturity-evidence",
      "Maturity evidence",
      `${pkg.group} packages do not require adapter/presentation/provider reference evidence`,
    );
  }

  const missingDocs = docsPaths.filter((docsPath) => !docsMentionPackage(rootDir, docsPath, pkg));
  if (missingDocs.length === 0) {
    return pass(
      "maturity-evidence",
      "Maturity evidence",
      `linked from ${docsPaths.map((docsPath) => `\`${docsPath}\``).join(", ")}`,
    );
  }

  return fail(
    "maturity-evidence",
    "Maturity evidence",
    `missing ${pkg.name} reference in ${missingDocs.join(", ")}`,
    "Link the production-ready evidence from the relevant reference docs before promotion.",
  );
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function findObjectProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && staticPropertyName(property.name) === propertyName,
  );
}

function readStaticStringArray(expression: ts.Expression): readonly string[] | null {
  if (!ts.isArrayLiteralExpression(expression)) {
    return null;
  }

  const values: string[] = [];
  for (const element of expression.elements) {
    if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) {
      return null;
    }
    values.push(element.text);
  }
  return values;
}

type VitestTestConfig = {
  readonly root: ts.ObjectLiteralExpression;
  readonly test: ts.ObjectLiteralExpression;
};

function findVitestTestConfig(sourceFile: ts.SourceFile): VitestTestConfig | null {
  const exports = sourceFile.statements.filter(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (exports.length !== 1) return null;
  const expression = exports[0]?.expression;
  if (
    !expression ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "defineConfig"
  ) {
    return null;
  }
  const root = expression.arguments[0];
  if (!root || !ts.isObjectLiteralExpression(root)) return null;
  const test = findObjectProperty(root, "test");
  if (!test || !ts.isObjectLiteralExpression(test.initializer)) return null;
  return { root, test: test.initializer };
}

function packageInventoryEntries(
  pkg: WorkspacePackage,
  inventoryEntries: readonly TestInventoryEntry[],
): readonly TestInventoryEntry[] {
  const packagePrefix = `${toPosixPath(pkg.relativeDir)}/`;
  return inventoryEntries.filter((entry) => entry.path.startsWith(packagePrefix));
}

function packageRelativeTestPath(pkg: WorkspacePackage, entry: TestInventoryEntry): string {
  return entry.path.slice(`${toPosixPath(pkg.relativeDir)}/`.length);
}

function expectedDefaultTestScript(
  pkg: WorkspacePackage,
  entries: readonly TestInventoryEntry[],
): string {
  const excludedPaths = entries
    .filter((entry) => entry.lane !== "fast")
    .map((entry) => packageRelativeTestPath(pkg, entry))
    .sort();
  return ["vitest run", ...excludedPaths.flatMap((path) => ["--exclude", path])].join(" ");
}

function validateLaneScript(
  pkg: WorkspacePackage,
  lane: Exclude<TestLane, "fast" | "generated-app">,
  entries: readonly TestInventoryEntry[],
): string | null {
  const paths = entries
    .filter((entry) => entry.lane === lane)
    .map((entry) => packageRelativeTestPath(pkg, entry))
    .sort();
  if (paths.length === 0) return null;

  const scriptName = `test:${lane}`;
  const script = pkg.scripts[scriptName]?.trim();
  const expectedCommand = `vitest run ${paths.join(" ")}`;
  if (!script) {
    return `${pkg.relativeDir}/package.json has no ${scriptName} script for ${paths.join(", ")}`;
  }
  if (script === expectedCommand) return null;

  const suffix = ` ${expectedCommand}`;
  if (!script.endsWith(suffix)) {
    return `${pkg.relativeDir}/package.json ${scriptName} script must execute exactly: ${expectedCommand}`;
  }
  const environmentPrefix = script.slice(0, -suffix.length);
  if (!/^(?:[A-Z_][A-Z0-9_]*=[^\s]+)(?:\s+[A-Z_][A-Z0-9_]*=[^\s]+)*$/.test(environmentPrefix)) {
    return `${pkg.relativeDir}/package.json ${scriptName} script has an unsupported command prefix`;
  }
  return null;
}

function createTestLaneCheck(
  pkg: WorkspacePackage,
  inventoryEntries: readonly TestInventoryEntry[],
): ProductionReadyCheck {
  const entries = packageInventoryEntries(pkg, inventoryEntries);
  const fastEntries = entries.filter((entry) => entry.lane === "fast");
  const errors: string[] = [];
  if (fastEntries.length === 0) {
    errors.push(`${testInventoryPath} has no deterministic fast test for ${pkg.name}`);
  }

  const expectedTest = expectedDefaultTestScript(pkg, entries);
  if (pkg.scripts.test?.trim() !== expectedTest) {
    errors.push(
      `${pkg.relativeDir}/package.json test script must be exactly ${JSON.stringify(expectedTest)}`,
    );
  }

  for (const lane of ["integration", "published", "live"] as const) {
    const error = validateLaneScript(pkg, lane, entries);
    if (error) errors.push(error);
  }

  if (errors.length > 0) {
    return fail(
      "test-lanes",
      "Test lanes",
      errors.join("; "),
      `Keep deterministic fast tests in ${pkg.relativeDir}/package.json test and route every special inventory lane through its test:<lane> script.`,
    );
  }
  const specialLaneCount = entries.length - fastEntries.length;
  return pass(
    "test-lanes",
    "Test lanes",
    `${fastEntries.length} deterministic fast test(s); ${specialLaneCount} special-lane test(s) isolated`,
  );
}

function validateVitestInclusion(rootDir: string, pkg: WorkspacePackage): readonly string[] {
  const errors: string[] = [];
  const configNames = [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
    "vitest.config.mjs",
  ];
  for (const configName of configNames) {
    const configPath = join(rootDir, pkg.relativeDir, configName);
    if (!existsSync(configPath)) {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      configPath,
      readFileSync(configPath, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const config = findVitestTestConfig(sourceFile);
    if (!config) {
      errors.push(
        `${pkg.relativeDir}/${configName} must expose a static defineConfig({ test: { ... } }) block`,
      );
      continue;
    }
    const { root: rootConfig, test: testConfig } = config;

    const unsafeRootProperties = rootConfig.properties.filter(
      (property) =>
        !ts.isPropertyAssignment(property) ||
        !new Set(["resolve", "test"]).has(staticPropertyName(property.name) ?? ""),
    );
    const testProperties = rootConfig.properties.filter(
      (property) =>
        ts.isPropertyAssignment(property) && staticPropertyName(property.name) === "test",
    );
    if (unsafeRootProperties.length > 0 || testProperties.length !== 1) {
      errors.push(
        `${pkg.relativeDir}/${configName} root config must expose one static test property without spreads or computed properties`,
      );
    }

    const unsafeProperties = testConfig.properties.filter(
      (property) =>
        !ts.isPropertyAssignment(property) ||
        !new Set([
          "globals",
          "environment",
          "include",
          "exclude",
          "testTimeout",
          "env",
          "fileParallelism",
          "setupFiles",
        ]).has(staticPropertyName(property.name) ?? ""),
    );
    if (unsafeProperties.length > 0) {
      errors.push(
        `${pkg.relativeDir}/${configName} test config contains unsupported execution or selection properties`,
      );
    }
    for (const propertyName of [
      "globals",
      "environment",
      "include",
      "exclude",
      "testTimeout",
      "env",
      "fileParallelism",
      "setupFiles",
    ] as const) {
      const matches = testConfig.properties.filter(
        (property) =>
          ts.isPropertyAssignment(property) && staticPropertyName(property.name) === propertyName,
      );
      if (matches.length > 1) {
        errors.push(
          `${pkg.relativeDir}/${configName} has duplicate test.${propertyName} properties`,
        );
      }
    }

    const include = findObjectProperty(testConfig, "include");
    if (include) {
      const patterns = readStaticStringArray(include.initializer);
      const supportedIncludes = new Set(["src/**/*.spec.ts", "src/tests/**/*.spec.ts"]);
      if (
        !patterns ||
        patterns.some((pattern) => pattern.startsWith("!")) ||
        !patterns.some((pattern) => supportedIncludes.has(pattern))
      ) {
        errors.push(
          `${pkg.relativeDir}/${configName} does not statically include package spec tests`,
        );
      }
    }

    const environment = findObjectProperty(testConfig, "environment");
    if (
      !environment ||
      !ts.isStringLiteral(environment.initializer) ||
      environment.initializer.text !== "node"
    ) {
      errors.push(`${pkg.relativeDir}/${configName} must use the static Node test environment`);
    }

    const exclude = findObjectProperty(testConfig, "exclude");
    if (exclude) {
      const patterns = readStaticStringArray(exclude.initializer);
      const supported = new Set(["**/node_modules/**", "**/dist/**"]);
      if (!patterns || patterns.some((pattern) => !supported.has(pattern))) {
        errors.push(`${pkg.relativeDir}/${configName} has an unsupported test exclusion`);
      }
    }
  }
  return errors;
}

function validateEvidencePath(
  rootDir: string,
  pkg: WorkspacePackage,
  testFile: string,
): string | null {
  if (
    isAbsolute(testFile) ||
    testFile.includes("\\") ||
    testFile.split("/").some((segment) => segment === "." || segment === "..") ||
    !/^src\/tests\/(?:[^/]+\/)*[^/]+\.spec\.ts$/.test(testFile)
  ) {
    return null;
  }

  const packageRoot = resolve(rootDir, pkg.relativeDir);
  const absoluteTestFile = resolve(packageRoot, testFile);
  const packageRelativePath = relative(packageRoot, absoluteTestFile);
  if (packageRelativePath.startsWith("..") || isAbsolute(packageRelativePath)) {
    return null;
  }
  return absoluteTestFile;
}

type TestDeclaration = {
  readonly name: string;
  readonly runnable: boolean;
  readonly skippedParent: boolean;
};

function expressionSegments(expression: ts.Expression): readonly string[] | null {
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionSegments(expression.expression);
    return parent ? [...parent, expression.name.text] : null;
  }
  if (ts.isElementAccessExpression(expression)) {
    const parent = expressionSegments(expression.expression);
    const argument = expression.argumentExpression;
    if (
      parent &&
      argument &&
      (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ) {
      return [...parent, argument.text];
    }
  }
  return null;
}

function staticTestTitle(argument: ts.Expression | undefined): string | null {
  return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : null;
}

function isInsideSkippedSuite(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isCallExpression(parent)) {
      continue;
    }
    const segments = expressionSegments(parent.expression);
    if (!segments) {
      continue;
    }
    const [base, ...modifiers] = segments;
    if (
      (base === "describe" || base === "suite") &&
      modifiers.some((modifier) => modifier === "skip" || modifier === "todo")
    ) {
      return true;
    }
    if (base === "xdescribe" || base === "xsuite") {
      return true;
    }
  }
  return false;
}

function isStaticallyRegisteredTest(node: ts.Node, suiteBindings: ReadonlySet<string>): boolean {
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (
      ts.isIfStatement(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isSwitchStatement(parent) ||
      ts.isForStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isTryStatement(parent)
    ) {
      return false;
    }
    if (ts.isFunctionLike(parent)) {
      const call = parent.parent;
      if (!ts.isCallExpression(call) || call.arguments[1] !== parent) {
        return false;
      }
      const segments = expressionSegments(call.expression);
      if (
        !segments ||
        !segments[0] ||
        !suiteBindings.has(segments[0]) ||
        segments.slice(1).some((modifier) => modifier !== "concurrent")
      ) {
        return false;
      }
    }
  }
  return true;
}

function hasFocusedTestDeclaration(sourceFile: ts.SourceFile): boolean {
  let focused = false;
  const visit = (node: ts.Node): void => {
    if (focused) return;
    if (ts.isCallExpression(node)) {
      const segments = expressionSegments(node.expression);
      const options = node.arguments[1];
      const onlyOption =
        options && ts.isObjectLiteralExpression(options)
          ? findObjectProperty(options, "only")
          : undefined;
      if (
        segments &&
        (segments[0] === "fit" ||
          segments[0] === "fdescribe" ||
          (["it", "test", "describe", "suite"].includes(segments[0] ?? "") &&
            (segments.slice(1).includes("only") ||
              (onlyOption !== undefined &&
                onlyOption.initializer.kind === ts.SyntaxKind.TrueKeyword))))
      ) {
        focused = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return focused;
}

function vitestBindings(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "vitest" ||
      !statement.importClause ||
      statement.importClause.isTypeOnly ||
      !statement.importClause.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (
        !element.isTypeOnly &&
        element.name.text === importedName &&
        ["it", "test", "describe", "suite"].includes(importedName)
      ) {
        bindings.add(element.name.text);
      }
    }
  }
  return bindings;
}

function hasUnsupportedTestOptions(sourceFile: ts.SourceFile): boolean {
  const testBindings = vitestBindings(sourceFile);
  let unsupported = false;
  const visit = (node: ts.Node): void => {
    if (unsupported) return;
    if (ts.isCallExpression(node)) {
      const segments = expressionSegments(node.expression);
      const base = segments?.[0];
      const secondArgument = node.arguments[1];
      if (
        base &&
        testBindings.has(base) &&
        secondArgument !== undefined &&
        !ts.isArrowFunction(secondArgument) &&
        !ts.isFunctionExpression(secondArgument)
      ) {
        unsupported = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return unsupported;
}

function hasShadowedVitestBinding(sourceFile: ts.SourceFile): boolean {
  const bindings = vitestBindings(sourceFile);
  let shadowed = false;
  const visit = (node: ts.Node): void => {
    if (shadowed) return;
    if (ts.isIdentifier(node) && bindings.has(node.text)) {
      const parent = node.parent;
      const declaration =
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.name === node) ||
        ((ts.isFunctionDeclaration(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isClassExpression(parent)) &&
          parent.name === node);
      const assignment =
        (ts.isBinaryExpression(parent) &&
          parent.left === node &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
          (parent.operator === ts.SyntaxKind.PlusPlusToken ||
            parent.operator === ts.SyntaxKind.MinusMinusToken));
      if (declaration || assignment) {
        shadowed = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return shadowed;
}

function collectTestDeclarations(sourceFile: ts.SourceFile): readonly TestDeclaration[] {
  const declarations: TestDeclaration[] = [];
  const testBindings = vitestBindings(sourceFile);
  const suiteBindings = new Set(
    [...testBindings].filter((binding) => binding === "describe" || binding === "suite"),
  );
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const segments = expressionSegments(node.expression);
      if (segments) {
        const [base, ...modifiers] = segments;
        if (base === "it" || base === "test" || base === "xit" || base === "xtest") {
          const name = staticTestTitle(node.arguments[0]);
          if (name) {
            const supportedModifiers = new Set(["concurrent"]);
            const handler = node.arguments[1];
            const hasStaticHandler =
              handler !== undefined &&
              (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler));
            declarations.push({
              name,
              runnable:
                testBindings.has(base) &&
                modifiers.every((modifier) => supportedModifiers.has(modifier)) &&
                hasStaticHandler &&
                isStaticallyRegisteredTest(node, suiteBindings),
              skippedParent: isInsideSkippedSuite(node),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function validatePublicPackageImports(
  sourceFile: ts.SourceFile,
  pkg: WorkspacePackage,
): readonly string[] {
  const errors: string[] = [];
  let hasPublicImport = false;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text;
    if (moduleName === "../index" || moduleName === pkg.name) {
      const clause = statement.importClause;
      const hasValueBinding =
        clause !== undefined &&
        !clause.isTypeOnly &&
        (clause.name !== undefined ||
          (clause.namedBindings !== undefined &&
            (ts.isNamespaceImport(clause.namedBindings) ||
              clause.namedBindings.elements.some((element) => !element.isTypeOnly))));
      hasPublicImport ||= hasValueBinding;
      continue;
    }
    if (moduleName.startsWith(".") || moduleName.startsWith(`${pkg.name}/`)) {
      errors.push(`imports same-package private module ${moduleName}`);
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const moduleName = node.arguments[0].text;
      if (moduleName.startsWith(".") || moduleName.startsWith(`${pkg.name}/`)) {
        errors.push(`imports same-package private module ${moduleName}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!hasPublicImport) {
    errors.push(`does not import ${pkg.name} through ../index or its published package name`);
  }
  return errors;
}

function validateEvidenceReference(
  rootDir: string,
  pkg: WorkspacePackage,
  kind: "positive" | "negative",
  reference: BehavioralEvidenceReference,
): readonly string[] {
  const absolutePath = validateEvidencePath(rootDir, pkg, reference.testFile);
  if (!absolutePath) {
    return [`${kind}.testFile must be a package-scoped src/tests/**/*.spec.ts path`];
  }
  if (!existsSync(absolutePath)) {
    return [`${kind}.testFile ${reference.testFile} does not exist`];
  }
  const packageRoot = realpathSync(resolve(rootDir, pkg.relativeDir));
  const realTestPath = realpathSync(absolutePath);
  const realRelativePath = relative(packageRoot, realTestPath);
  if (
    lstatSync(absolutePath).isSymbolicLink() ||
    realRelativePath.startsWith("..") ||
    isAbsolute(realRelativePath) ||
    !/^src\/tests\/(?:[^/]+\/)*[^/]+\.spec\.ts$/.test(realRelativePath)
  ) {
    return [`${kind}.testFile ${reference.testFile} must not escape the package through a symlink`];
  }

  const sourceFile = ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const errors = validatePublicPackageImports(sourceFile, pkg).map(
    (error) => `${kind}.testFile ${reference.testFile} ${error}`,
  );
  if (hasFocusedTestDeclaration(sourceFile)) {
    errors.push(
      `${kind}.testFile ${reference.testFile} must not contain focused Vitest declarations`,
    );
  }
  if (hasUnsupportedTestOptions(sourceFile)) {
    errors.push(
      `${kind}.testFile ${reference.testFile} must not use Vitest test options overloads`,
    );
  }
  if (hasShadowedVitestBinding(sourceFile)) {
    errors.push(`${kind}.testFile ${reference.testFile} must not shadow imported Vitest bindings`);
  }
  const matches = collectTestDeclarations(sourceFile).filter(
    (declaration) => declaration.name === reference.testName,
  );
  if (matches.length !== 1) {
    errors.push(
      `${kind}.testName ${JSON.stringify(reference.testName)} must identify exactly one static test declaration`,
    );
  } else if (!matches[0]?.runnable || matches[0].skippedParent) {
    errors.push(
      `${kind}.testName ${JSON.stringify(reference.testName)} must identify a runnable, non-skipped test`,
    );
  }
  return errors;
}

function createBehavioralEvidenceCheck(
  rootDir: string,
  pkg: WorkspacePackage,
  qualityRow: PackageQualityRow | undefined,
  catalog: CatalogEvidence,
  requireTaskSummaries: boolean,
): ProductionReadyCheck {
  if (!catalog.spinePackages.has(pkg.shortName)) {
    return notApplicable(
      "behavioral-evidence",
      "Behavioral evidence",
      `${pkg.name} is not in the Croco spine`,
    );
  }

  const evidence = catalog.behavioralEvidenceByPackage.get(pkg.shortName);
  const recovery = `Add public positive/negative evidence for ${pkg.shortName} and run pnpm --filter ${pkg.name} test.`;
  if (!evidence) {
    return fail(
      "behavioral-evidence",
      "Behavioral evidence",
      `spine.behavioralEvidence.packages.${pkg.shortName} is missing or invalid`,
      recovery,
    );
  }

  const errors = [
    ...validateVitestInclusion(rootDir, pkg),
    ...validateEvidenceReference(rootDir, pkg, "positive", evidence.positive),
    ...validateEvidenceReference(rootDir, pkg, "negative", evidence.negative),
  ];
  if (
    evidence.positive.testFile === evidence.negative.testFile &&
    evidence.positive.testName === evidence.negative.testName
  ) {
    errors.push("positive and negative evidence must identify different tests");
  }

  if (requireTaskSummaries && qualityRow?.tasks.test.status !== "pass") {
    errors.push(`${pkg.name}#test must pass in the current Turbo summary`);
  }

  if (errors.length > 0) {
    return fail("behavioral-evidence", "Behavioral evidence", errors.join("; "), recovery);
  }
  return pass(
    "behavioral-evidence",
    "Behavioral evidence",
    `node: ${evidence.positive.testFile} (${evidence.positive.testName}; ${evidence.negative.testName})`,
  );
}

function createProductionRow(
  rootDir: string,
  pkg: WorkspacePackage,
  qualityRow: PackageQualityRow | undefined,
  catalog: CatalogEvidence,
  baseline: BaselineEvidence,
  snapshot: PublicApiSnapshotEvidence,
  inventoryEntries: readonly TestInventoryEntry[],
  requireTaskSummaries: boolean,
): ProductionReadyPackageRow {
  return {
    packageName: pkg.name,
    relativeDir: pkg.relativeDir,
    group: pkg.group,
    checks: [
      createReadmeCheck(pkg),
      createApiDocsCheck(pkg, baseline.temporaryProductionApiDocExceptions),
      createTestsCheck(pkg),
      createTestLaneCheck(pkg, inventoryEntries),
      ...qualityTasks.map((task) => createTaskCheck(pkg, qualityRow, task, requireTaskSummaries)),
      createPublicApiCheck(pkg, snapshot),
      createMaturityEvidenceCheck(rootDir, pkg, catalog),
      createBehavioralEvidenceCheck(rootDir, pkg, qualityRow, catalog, requireTaskSummaries),
    ],
  };
}

function createNonProductionSummary(
  packages: readonly WorkspacePackage[],
): readonly NonProductionSummary[] {
  return maturityOrder
    .filter((maturity) => maturity !== "production")
    .map((maturity) => {
      const matchingPackages = packages.filter((pkg) => pkg.maturity === maturity);

      return {
        maturity,
        packageCount: matchingPackages.length,
        missingApiDocs: matchingPackages.filter((pkg) => !pkg.hasApiDocs).length,
        missingReadme: matchingPackages.filter((pkg) => !pkg.hasReadme).length,
        missingTests: matchingPackages.filter((pkg) => !pkg.hasTests).length,
      };
    });
}

export function createProductionReadyReport(
  options: Pick<Options, "rootDir" | "summaryDir" | "requireTaskSummaries"> & {
    readonly generatedAt?: string;
    readonly fastTestLaneReportPath?: string | null;
    readonly fastTestLaneReport?: LaneReport | null;
    readonly inventory?: ReturnType<typeof readTestInventory>["inventory"];
    readonly qualityRows?: readonly PackageQualityRow[];
  },
): ProductionReadyReport {
  const catalog = loadCatalogEvidence(options.rootDir);
  const packages = readPackages(options.rootDir)
    .filter((pkg) => !pkg.private && pkg.name.startsWith("@croco/"))
    .map((pkg) =>
      toWorkspacePackage(options.rootDir, catalog.groupByPackage, catalog.maturityByPackage, pkg),
    );
  const packageByShortName = new Map(packages.map((pkg) => [pkg.shortName, pkg]));
  const actualPackageNames = new Set(packages.map((pkg) => pkg.shortName));
  const productionPackageNames = new Set(catalog.productionPackages);
  const baseline = loadBaselineEvidence(
    options.rootDir,
    productionPackageNames,
    actualPackageNames,
  );
  const snapshot = loadPublicApiSnapshotEvidence(options.rootDir);
  const inventoryEvidence = options.inventory
    ? { inventory: options.inventory, diagnostics: [] }
    : readTestInventory(join(options.rootDir, testInventoryPath));
  const fastTestLaneEvidence = resolveFastTestLaneEvidence(options, inventoryEvidence.inventory);
  const qualityRows =
    options.qualityRows ??
    createPackageQualityReport({
      rootDir: options.rootDir,
      summaryDir: options.summaryDir,
    }).rows;
  const qualityRowsByPackage = new Map(
    applyFastTestLaneEvidence(qualityRows, fastTestLaneEvidence).map(
      (row) => [row.packageName, row] as const,
    ),
  );
  const missingProductionPackages = catalog.productionPackages.filter(
    (packageName) => !packageByShortName.has(packageName),
  );
  const catalogErrors = [
    ...catalog.errors,
    ...baseline.errors,
    ...snapshot.errors,
    ...inventoryEvidence.diagnostics.map(
      (diagnostic) => `${testInventoryPath}: ${diagnostic.code}: ${diagnostic.message}`,
    ),
    ...(fastTestLaneEvidence?.errors ?? []),
    ...missingProductionPackages.map(
      (packageName) =>
        `${catalogMetadataPath}: maturity.production references missing package ${packageName}`,
    ),
  ];

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    rootDir: options.rootDir,
    summaryDir: options.summaryDir,
    requireTaskSummaries: options.requireTaskSummaries,
    catalogErrors,
    productionRows: catalog.productionPackages.flatMap((packageName) => {
      const pkg = packageByShortName.get(packageName);
      if (!pkg) {
        return [];
      }

      return [
        createProductionRow(
          options.rootDir,
          pkg,
          qualityRowsByPackage.get(pkg.name),
          catalog,
          baseline,
          snapshot,
          inventoryEvidence.inventory.tests,
          options.requireTaskSummaries,
        ),
      ];
    }),
    nonProduction: createNonProductionSummary(
      packages.filter((pkg) => pkg.maturity !== "production"),
    ),
  };
}

function formatTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function formatCheckCell(check: ProductionReadyCheck): string {
  const recovery = check.recovery ? `<br>Recovery: ${check.recovery}` : "";
  return formatTableCell(`${check.status}: ${check.evidence}${recovery}`);
}

function formatSummaryCheck(row: ProductionReadyPackageRow, id: string): string {
  const check = row.checks.find((candidate) => candidate.id === id);
  return check ? formatCheckCell(check) : "missing check";
}

export function countProductionReadyFailures(report: ProductionReadyReport): number {
  const packageFailures = report.productionRows.reduce(
    (count, row) => count + row.checks.filter((check) => check.status === "fail").length,
    0,
  );

  return report.catalogErrors.length + packageFailures;
}

export function hasProductionReadyFailures(report: ProductionReadyReport): boolean {
  return countProductionReadyFailures(report) > 0;
}

export function buildProductionReadyMarkdown(report: ProductionReadyReport): string {
  const failureCount = countProductionReadyFailures(report);
  const lines = [
    "# Production-Ready Package Gate",
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Root: \`${toPosixPath(report.rootDir)}\``,
    `- Turbo summary directory: \`${toPosixPath(relative(report.rootDir, report.summaryDir))}\``,
    `- Task summaries required: ${report.requireTaskSummaries ? "yes" : "no"}`,
    `- Production-ready packages: ${report.productionRows.length}`,
    `- Blocking failures: ${failureCount}`,
    "",
    "## Catalog and baseline errors",
    "",
    ...(report.catalogErrors.length > 0
      ? report.catalogErrors.map((error) => `- ${error}`)
      : ["- none"]),
    "",
    "## Production package evidence",
    "",
    "| Package | Group | README | API docs | Tests | Test lanes | Build | Typecheck | Test | Public API | Maturity evidence | Behavioral evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.productionRows.map(
      (row) =>
        `| \`${row.packageName}\` | ${formatTableCell(row.group)} | ${formatSummaryCheck(row, "readme")} | ${formatSummaryCheck(row, "api-docs")} | ${formatSummaryCheck(row, "tests")} | ${formatSummaryCheck(row, "test-lanes")} | ${formatSummaryCheck(row, "build-report")} | ${formatSummaryCheck(row, "typecheck-report")} | ${formatSummaryCheck(row, "test-report")} | ${formatSummaryCheck(row, "public-api-snapshot")} | ${formatSummaryCheck(row, "maturity-evidence")} | ${formatSummaryCheck(row, "behavioral-evidence")} |`,
    ),
    "",
    "## Non-production package summary",
    "",
    "Non-production packages are reported for visibility but do not fail this production-ready gate.",
    "",
    "| Maturity | Packages | Missing README | Missing API docs | Missing tests |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...report.nonProduction.map(
      (row) =>
        `| ${row.maturity} | ${row.packageCount} | ${row.missingReadme} | ${row.missingApiDocs} | ${row.missingTests} |`,
    ),
    "",
    "## Recovery",
    "",
    "- Add `packages/<name>/README.md` for production packages missing README evidence.",
    "- Generate `packages/docs/src/content/docs/api/<name>/` for production packages missing API docs.",
    "- Use `docs/package-docs-baseline.json` `temporaryProductionApiDocExceptions` only for a production package that currently lacks generated API docs, and include a short-lived justification. Stale entries fail this gate.",
    "- Add focused tests under `src/tests` or `src/__tests__` for production packages missing package test evidence.",
    "- Keep deterministic fast tests in the default `test` script and route integration, published-package, and live tests through explicit lane scripts.",
    "- Keep production package `build`, `typecheck`, and `test` scripts wired into Turbo summaries before CI runs this gate with required task summaries.",
    "- Run `pnpm public-api:write` when a publishable package entrypoint is intentionally added to the public API snapshot.",
    "- Link adapter, provider, integration, transport, host, or presentation production evidence from the relevant reference docs before promotion.",
    "- Map one public positive and one public negative test for every production-ready spine package under `spine.behavioralEvidence.packages`.",
  ];

  return `${lines.join("\n")}\n`;
}

export function writeProductionReadyReport(
  report: ProductionReadyReport,
  outputDir: string,
): string {
  mkdirSync(outputDir, { recursive: true });
  const markdownPath = join(outputDir, reportFileName);
  writeFileSync(markdownPath, buildProductionReadyMarkdown(report));
  return markdownPath;
}

export function parseArgs(args: readonly string[]): Options {
  let rootDir = process.cwd();
  let outputDir = join(rootDir, reportDirectory);
  let summaryDir = join(rootDir, turboRunsDirectory);
  let requireTaskSummaries = false;
  let fastTestLaneReportPath: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--root") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--root requires a path");
      }
      rootDir = resolve(value);
      outputDir = join(rootDir, reportDirectory);
      summaryDir = join(rootDir, turboRunsDirectory);
      index++;
      continue;
    }

    if (arg === "--output-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--output-dir requires a path");
      }
      outputDir = resolve(value);
      index++;
      continue;
    }

    if (arg === "--summary-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--summary-dir requires a path");
      }
      summaryDir = resolve(value);
      index++;
      continue;
    }

    if (arg === "--require-task-summaries") {
      requireTaskSummaries = true;
      continue;
    }

    if (arg === "--fast-test-lane-report") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--fast-test-lane-report requires a path");
      }
      fastTestLaneReportPath = resolve(value);
      index++;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    rootDir,
    outputDir,
    summaryDir,
    requireTaskSummaries,
    fastTestLaneReportPath,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(argv.slice(2));
  const report = createProductionReadyReport(options);
  const markdownPath = writeProductionReadyReport(report, options.outputDir);
  const failureCount = countProductionReadyFailures(report);

  console.log(`production-ready-check: wrote ${markdownPath}`);
  console.log(`production-ready-check: production packages=${report.productionRows.length}`);
  console.log(`production-ready-check: blocking failures=${failureCount}`);

  if (failureCount > 0) {
    exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`production-ready-check: failed: ${message}`);
    exit(1);
  });
}
