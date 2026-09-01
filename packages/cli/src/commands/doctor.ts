import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { defineCommand } from "citty";
import { Node, Project, SyntaxKind } from "ts-morph";
import type * as Morph from "ts-morph";
import {
  isKnownRuntimePlatform,
  validateApplicationIntentManifest,
} from "@croco/framework-context";
import type {
  ApplicationIntentManifestIssueKind,
  KnownRuntimePlatform,
} from "@croco/framework-context";
import { PROJECT_MANIFEST_BUNDLE_ARTIFACTS } from "@croco/protocols-core";
import {
  getApplicationIntentProviderPackage,
  getApplicationIntentQualityGateEvidence,
  getApplicationIntentRuntimePackage,
} from "../libs/applicationIntentEvidence.js";
import { WORKSPACE_MAX_DEPTH } from "../libs/constants.js";
import { parseCoreCoveragePackageFilters } from "../libs/coreCoverageFilters.js";
import { CLI_DIAGNOSTIC_CODES, CLI_LEGACY_DIAGNOSTIC_CODES } from "../libs/diagnosticCodes.js";
import { getCrocoCommandRuntime } from "../libs/cliRuntime.js";
import type { CliDiagnosticCode } from "../libs/diagnosticCodes.js";
import { GLOBAL_OPTIONS } from "./options.js";
import { PROJECT_MANIFEST_BUNDLE_SCHEMA_VERSIONS } from "./projectMap.js";

export type DoctorSeverity = "error" | "warning";
export type DoctorSummary = "healthy" | "issues_detected";
export type DoctorCheckStatus = "pass" | "fail" | "skipped";

export type DoctorLocation = {
  readonly file?: string;
  readonly line?: number;
  readonly packageName?: string;
};

export type DoctorDiagnostic = {
  readonly code: CliDiagnosticCode;
  readonly legacyCode?: string;
  readonly severity: DoctorSeverity;
  readonly checkId: string;
  readonly cause: string;
  readonly location: DoctorLocation | null;
  readonly action: string;
};

export type DoctorCheckResult = {
  readonly id: string;
  readonly title: string;
  readonly status: DoctorCheckStatus;
  readonly diagnostics: readonly DoctorDiagnostic[];
  readonly note?: string;
};

export type DoctorPackage = {
  readonly name: string;
  readonly version: string | null;
  readonly private: boolean;
  readonly relativeDir: string;
  readonly absoluteDir: string;
  readonly dependencies: readonly DoctorPackageDependency[];
};

export type DoctorReport = {
  readonly version: "croco.doctor.v1";
  readonly rootDir: string | null;
  readonly packageCount: number;
  readonly summary: DoctorSummary;
  readonly checks: readonly DoctorCheckResult[];
  readonly diagnostics: readonly DoctorDiagnostic[];
};

export type RunDoctorOptions = {
  readonly cwd?: string;
};

export type DoctorPackageDependency = {
  readonly name: string;
  readonly range: string;
  readonly field: PackageDependencyField;
  readonly importerDir: string;
  readonly importerName: string;
};

type PackageDependencyField =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

type WorkspacePattern = {
  readonly pattern: string;
  readonly excluded: boolean;
};

type WorkspacePackageReadResult =
  | { readonly kind: "valid"; readonly package: DoctorPackage }
  | { readonly kind: "invalid"; readonly diagnostic: DoctorDiagnostic };

type BenchmarkVarianceGateFailureCounts = {
  runnerFailures: number;
  moduleFailures: number;
  emptyReports: number;
  missingReports: number;
  thresholdFailures: number;
  thresholdSkips: number;
  baselineFailures: number;
  baselineSkips: number;
  otherFailures: number;
};

type WorkspaceDiscoveryResult = {
  readonly packages: readonly DoctorPackage[];
  readonly patterns: readonly WorkspacePattern[];
  readonly diagnostics: readonly DoctorDiagnostic[];
};

type SourceSlice = {
  readonly source: string;
  readonly maskedSource: string;
};

type AdvisoryGateReadinessSection = {
  readonly label: string;
  readonly diagnostics: readonly DoctorDiagnostic[];
};

type ProviderProfileManifestRecord = Record<string, unknown> & {
  readonly profile: Record<string, unknown> & {
    readonly name: string;
    readonly runtimeTarget: KnownRuntimePlatform;
  };
  readonly packages: readonly unknown[];
  readonly capabilities: readonly unknown[];
};

const sourceFileExtensions = [".ts", ".tsx", ".mts", ".cts", ".ts.hbs", ".tsx.hbs"];
const packageDependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const satisfies readonly PackageDependencyField[];
const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "tests",
  "__tests__",
]);
const bundleArtifactIgnoredDirectories = new Set(["coverage", "dist", "node_modules"]);
const requiredHttpSecurityMiddleware = [
  "securityHeadersMiddleware",
  "corsMiddleware",
  "bodyLimitMiddleware",
  "rateLimitHttpMiddleware",
] as const;
const requiredSaasProviderCapabilities = [
  "runtime",
  "auth",
  "billing",
  "metering",
  "storage",
  "tasks",
  "telemetry",
  "webhookVerification",
] as const;
const defaultContractGraphSnapshotPath = "contract-graph.snapshot.json";
const DEFAULT_APPLICATION_INTENT_MANIFEST_PATH = "croco.app.json";
const defaultProjectManifestBundlePath = ".croco/manifest";
const defaultProblemRegistryPath = "docs/problem-code-registry.json";
const defaultProblemCookbookPath =
  "packages/docs/src/content/docs/en/reference/problem-recovery-cookbook.md";
const defaultRuntimeCapabilityManifestPath = "croco-runtime-capability.manifest.json";
const legacyRuntimePolicyManifestPath = "croco-runtime-policy.manifest.json";
const defaultDiGraphManifestPath = ".croco/build/di-graph.manifest.json";
const defaultProviderProfileManifestPath = "croco-saas-profile.manifest.json";
const providerProfileManifestSchemaVersion = "croco.saas-provider-profile/v1";
const defaultTenantModelManifestPath = "croco-tenant-model.manifest.json";
const tenantModelManifestSchemaVersion = "croco.tenant-model/v1";
const defaultPackageCatalogPath = "docs/package-catalog.json";
const defaultCoreCoverageWarningCheckPath = "scripts/core-coverage-warning-check.mts";
const defaultCoreCoverageConfigPath = "scripts/core-coverage-config.mts";
const defaultVitestConfigPath = "vitest.config.ts";
const defaultCoreCoverageBaselinePath = "ci-reports/coverage/core-baseline.txt";
const defaultBundleSizeBaselinePath = "ci-reports/bundle-size/baseline.json";
const defaultBenchmarkResultPath = "benchmark-result.json";
const defaultBenchmarkVarianceEvidencePath = "ci-reports/benchmark/latest-five-green-runs.md";
const bundleSizeArtifactSuffixes = [
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".wasm",
  ".map",
  ".json",
  ".d.ts",
] as const;
const hashedChunkArtifactPattern = /(^|\/)chunk-[A-Z0-9]{8}(\.(?:cjs|mjs|js)(?:\.map)?)$/i;

type MeasuredBundleArtifact = {
  readonly path: string;
  readonly sizeBytes: number;
};

type BundleBaselineMatch = {
  readonly key: string;
  readonly bytes: number;
};

const benchmarkVarianceEvidenceMarker = "<!-- croco-benchmark-variance-evidence:v1 -->";
const benchmarkVarianceEvidenceRunCount = 5;
const benchmarkVarianceSpreadTolerance = 0.15;
const benchmarkPromotedBaselineTolerance = 0.2;
const benchmarkEmptyReportFailure = "No benchmark reports were collected.";
const benchmarkMissingReportSuffix = ": benchmark report was not collected.";
const benchmarkRunnerErrorPrefix = "benchmark runner error:";
const benchmarkModuleFailedPrefix = "benchmark module failed:";
const isoTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const benchmarkGitHubActionsRunPathPrefix = "/croco-dev/framework/actions/runs";
const defaultStaticMisuseAllowlistPath = "scripts/static-misuse-raw-error-allowlist.json";
const defaultStaticMisuseEmptyCatchAllowlistPath =
  "scripts/static-misuse-empty-catch-allowlist.json";
const staticMisuseAllowlistPaths = [
  defaultStaticMisuseAllowlistPath,
  defaultStaticMisuseEmptyCatchAllowlistPath,
] as const;
const coreCoverageFrameworkGroups = new Set(["Core", "Integration", "Protocol", "Transport"]);
const coreCoverageBaselineMetrics = ["statements", "branches", "functions", "lines"] as const;
const coreCoverageReleaseCriticalRules = [
  { signal: "framework-level contract", pattern: /^framework-/ },
  { signal: "request/context contract", pattern: /context/ },
  { signal: "retry/reliability contract", pattern: /^retry-/ },
  { signal: "events contract", pattern: /^events-/ },
  { signal: "auth contract", pattern: /^auth-/ },
  { signal: "telemetry contract", pattern: /^telemetry-/ },
  { signal: "transport runtime contract", pattern: /^transports-/ },
  { signal: "health/readiness contract", pattern: /^health-/ },
  { signal: "failure/problem contract", pattern: /^problems-/ },
] as const;
const projectManifestBundleFiles = [
  {
    path: PROJECT_MANIFEST_BUNDLE_ARTIFACTS.contractGraph,
    schemaVersion: PROJECT_MANIFEST_BUNDLE_SCHEMA_VERSIONS.contractGraph,
  },
  {
    path: PROJECT_MANIFEST_BUNDLE_ARTIFACTS.problems,
    schemaVersion: PROJECT_MANIFEST_BUNDLE_SCHEMA_VERSIONS.problems,
  },
  {
    path: PROJECT_MANIFEST_BUNDLE_ARTIFACTS.diGraph,
    schemaVersion: PROJECT_MANIFEST_BUNDLE_SCHEMA_VERSIONS.diGraph,
  },
  {
    path: PROJECT_MANIFEST_BUNDLE_ARTIFACTS.runtime,
    schemaVersion: PROJECT_MANIFEST_BUNDLE_SCHEMA_VERSIONS.runtime,
  },
  {
    path: PROJECT_MANIFEST_BUNDLE_ARTIFACTS.policies,
    schemaVersion: PROJECT_MANIFEST_BUNDLE_SCHEMA_VERSIONS.policies,
  },
  {
    path: PROJECT_MANIFEST_BUNDLE_ARTIFACTS.providers,
    schemaVersion: PROJECT_MANIFEST_BUNDLE_SCHEMA_VERSIONS.providers,
  },
] as const;
const problemRegistryCheckTimeoutMs = 30_000;
const commandOutputMaxLength = 500;

export function runDoctor(options: RunDoctorOptions = {}): DoctorReport {
  const startDir = resolve(options.cwd ?? getCrocoCommandRuntime().cwd);
  const rootDir = findWorkspaceRoot(startDir);
  if (!rootDir) {
    const diagnostic: DoctorDiagnostic = {
      code: CLI_DIAGNOSTIC_CODES.doctorWorkspaceNotFound,
      legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorWorkspaceNotFound,
      severity: "error",
      checkId: "workspace-discovery",
      cause:
        "croco doctor could not find pnpm-workspace.yaml by walking up from the execution directory.",
      location: { file: startDir },
      action:
        "Run croco doctor from inside a Croco monorepo, or pass --cwd to a directory under the workspace root.",
    };
    return {
      version: "croco.doctor.v1",
      rootDir: null,
      packageCount: 0,
      summary: "issues_detected",
      checks: [
        {
          id: "workspace-discovery",
          title: "Workspace discovery",
          status: "fail",
          diagnostics: [diagnostic],
        },
      ],
      diagnostics: [diagnostic],
    };
  }

  const workspace = readWorkspacePackages(rootDir);
  const checks = [
    workspaceDiscoveryCheck(rootDir, workspace),
    workspaceVersionConsistencyCheck(rootDir, workspace.packages),
    spinePackageStateCheck(rootDir, workspace.packages),
    contractGraphReadinessCheck(rootDir),
    projectManifestBundleReadinessCheck(rootDir),
    advisoryGateReadinessCheck(rootDir, workspace.packages),
    problemRegistryReadinessCheck(rootDir),
    runtimeCapabilityManifestCheck(rootDir),
    httpSecurityMiddlewareContractCheck(rootDir, workspace.packages),
    diGraphBootstrapCheck(rootDir),
    providerCertificationCheck(rootDir, workspace.packages),
    repositoryCoreBoundaryCheck(rootDir),
    lambdaTelemetryFlushCheck(rootDir, workspace.packages),
    applicationIntentManifestCheck(rootDir, workspace.packages),
  ];
  const diagnostics = checks.flatMap((check) => check.diagnostics);

  return {
    version: "croco.doctor.v1",
    rootDir,
    packageCount: workspace.packages.length,
    summary: diagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? "issues_detected"
      : "healthy",
    checks,
    diagnostics,
  };
}

export function getDoctorExitCode(report: DoctorReport): number {
  return report.summary === "healthy" ? 0 : 1;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`Croco doctor: ${report.summary}`];

  if (report.rootDir) {
    lines.push(`Workspace: ${report.rootDir}`);
    lines.push(`Packages: ${report.packageCount}`);
  }

  lines.push("Checks:");
  for (const check of report.checks) {
    const suffix = check.note ? ` - ${check.note}` : "";
    lines.push(`- ${check.id}: ${check.status}${suffix}`);
  }

  if (report.diagnostics.length === 0) {
    lines.push("Diagnostics: none");
    return lines.join("\n");
  }

  lines.push("Diagnostics:");
  for (const diagnostic of report.diagnostics) {
    lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}`);
    if (diagnostic.legacyCode) {
      lines.push(`  Legacy code: ${diagnostic.legacyCode}`);
    }
    lines.push(`  Cause: ${diagnostic.cause}`);
    lines.push(`  Location: ${formatLocation(diagnostic.location)}`);
    lines.push(`  Action: ${diagnostic.action}`);
  }

  return lines.join("\n");
}

function workspaceDiscoveryCheck(
  rootDir: string,
  workspace: WorkspaceDiscoveryResult,
): DoctorCheckResult {
  const includeCount = workspace.patterns.filter((pattern) => !pattern.excluded).length;
  const diagnostics = [...workspace.diagnostics];

  if (includeCount > 0 && workspace.packages.length === 0 && workspace.diagnostics.length === 0) {
    diagnostics.push({
      code: CLI_DIAGNOSTIC_CODES.doctorWorkspacePackagesEmpty,
      legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorWorkspacePackagesEmpty,
      severity: "error",
      checkId: "workspace-discovery",
      cause:
        "pnpm-workspace.yaml defines package globs, but croco doctor did not discover any package.json files.",
      location: { file: toPosixPath(relative(rootDir, join(rootDir, "pnpm-workspace.yaml"))) },
      action:
        "Check the packages entries in pnpm-workspace.yaml or run croco doctor from the repository root so configured package globs resolve to workspace packages.",
    });
  }

  return {
    id: "workspace-discovery",
    title: "Workspace discovery",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note: `${workspace.packages.length} package(s) discovered from ${relative(rootDir, join(rootDir, "pnpm-workspace.yaml"))}`,
  };
}

function applicationIntentManifestCheck(
  rootDir: string,
  packages: readonly DoctorPackage[],
): DoctorCheckResult {
  const checkId = "application-intent-manifest";
  const manifestPath = join(rootDir, DEFAULT_APPLICATION_INTENT_MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    return {
      id: checkId,
      title: "Application intent manifest",
      status: "skipped",
      diagnostics: [],
      note: `${DEFAULT_APPLICATION_INTENT_MANIFEST_PATH} was not found; custom workspaces do not require it.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;
  } catch (error) {
    return applicationIntentManifestFailure(
      checkId,
      CLI_DIAGNOSTIC_CODES.doctorAppManifestJsonInvalid,
      `${DEFAULT_APPLICATION_INTENT_MANIFEST_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "Restore valid JSON or regenerate the workspace with create-croco-app, then rerun croco doctor.",
    );
  }

  const validation = validateApplicationIntentManifest(parsed);
  if (!validation.ok) {
    const diagnostics = validation.issues.map((issue) => ({
      code: applicationIntentManifestIssueCode(issue.kind),
      severity: "error" as const,
      checkId,
      cause:
        issue.kind === "goal-contract-mismatch"
          ? `${DEFAULT_APPLICATION_INTENT_MANIFEST_PATH}.${issue.field} is ${formatDiagnosticValue(issue.actual)}, but goal ${formatDiagnosticValue(parsed && typeof parsed === "object" && "goal" in parsed ? parsed.goal : undefined)} requires ${formatDiagnosticValue(issue.expected)}.`
          : `${DEFAULT_APPLICATION_INTENT_MANIFEST_PATH}.${issue.field} has unsupported or invalid value ${formatDiagnosticValue(issue.actual)}.`,
      location: { file: DEFAULT_APPLICATION_INTENT_MANIFEST_PATH },
      action:
        issue.kind === "version-unsupported"
          ? "Upgrade croco doctor to a version that supports this manifest, or regenerate the workspace with the current create-croco-app version."
          : "Restore a supported generated manifest value or regenerate the workspace with create-croco-app, then rerun croco doctor.",
    }));

    return {
      id: checkId,
      title: "Application intent manifest",
      status: "fail",
      diagnostics,
      note: `${diagnostics.length} application intent manifest issue(s) found.`,
    };
  }

  const manifest = validation.manifest;
  const declaredPackages = new Set([
    ...packages.map((workspacePackage) => workspacePackage.name),
    ...collectDeclaredDependencies(rootDir, packages).map((dependency) => dependency.name),
  ]);
  const diagnostics: DoctorDiagnostic[] = [];
  const requiredRuntimePackage = getApplicationIntentRuntimePackage(manifest.runtimeTarget);
  if (!declaredPackages.has(requiredRuntimePackage)) {
    diagnostics.push(
      applicationIntentWorkspaceDrift(
        checkId,
        "runtimeTarget",
        manifest.runtimeTarget,
        `package ${requiredRuntimePackage} in workspace package names or package.json dependency fields`,
      ),
    );
  }

  manifest.providers.forEach((provider, index) => {
    const requiredPackage = getApplicationIntentProviderPackage(
      provider,
      manifest.scope,
      manifest.goal,
    );
    if (!declaredPackages.has(requiredPackage)) {
      diagnostics.push(
        applicationIntentWorkspaceDrift(
          checkId,
          `providers[${index}]`,
          provider,
          `package ${requiredPackage} in workspace package names or package.json dependency fields`,
        ),
      );
    }
  });

  const rootPackage = readJsonObject(join(rootDir, "package.json"));
  const rootManifest = rootPackage.kind === "valid" ? rootPackage.value : {};
  const scripts = readRootScripts(rootDir);
  manifest.qualityGates.forEach((qualityGate, index) => {
    const evidence = getApplicationIntentQualityGateEvidence(qualityGate);
    const workspacePackageName =
      evidence.kind === "workspace-script"
        ? `${manifest.scope}${evidence.packageNameSuffix}`
        : undefined;

    const workspacePackage = packages.find((pkg) => pkg.name === workspacePackageName);
    const workspaceScripts = workspacePackage
      ? readPackageScriptsAt(join(workspacePackage.absoluteDir, "package.json"))
      : {};
    const evidencePath =
      evidence.kind === "package-manager"
        ? "package.json#packageManager"
        : evidence.kind === "root-script"
          ? `package.json#scripts.${evidence.script}`
          : `${workspacePackage?.relativeDir ?? `*${evidence.packageNameSuffix}`}/package.json#scripts.${evidence.script}`;
    const evidencePresent =
      evidence.kind === "package-manager"
        ? readOptionalString(rootManifest["packageManager"]) !== null
        : evidence.kind === "root-script"
          ? scripts[evidence.script] !== undefined
          : workspaceScripts[evidence.script] !== undefined;
    if (!evidencePresent) {
      diagnostics.push(
        applicationIntentWorkspaceDrift(
          checkId,
          `qualityGates[${index}]`,
          qualityGate,
          evidencePath,
        ),
      );
    }
  });

  return {
    id: checkId,
    title: "Application intent manifest",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} workspace drift issue(s) found for declared application intent.`
        : `Goal '${manifest.goal}' manifest and workspace evidence are aligned.`,
  };
}

function applicationIntentManifestFailure(
  checkId: string,
  code: CliDiagnosticCode,
  cause: string,
  action: string,
): DoctorCheckResult {
  const diagnostic: DoctorDiagnostic = {
    code,
    severity: "error",
    checkId,
    cause,
    location: { file: DEFAULT_APPLICATION_INTENT_MANIFEST_PATH },
    action,
  };
  return {
    id: checkId,
    title: "Application intent manifest",
    status: "fail",
    diagnostics: [diagnostic],
    note: "The application intent manifest could not be validated.",
  };
}

function applicationIntentManifestIssueCode(
  kind: ApplicationIntentManifestIssueKind,
): CliDiagnosticCode {
  switch (kind) {
    case "shape-invalid":
      return CLI_DIAGNOSTIC_CODES.doctorAppManifestShapeInvalid;
    case "version-unsupported":
      return CLI_DIAGNOSTIC_CODES.doctorAppManifestVersionUnsupported;
    case "goal-unsupported":
      return CLI_DIAGNOSTIC_CODES.doctorAppManifestGoalUnsupported;
    case "goal-contract-mismatch":
      return CLI_DIAGNOSTIC_CODES.doctorAppManifestGoalContractMismatch;
    case "runtime-unsupported":
      return CLI_DIAGNOSTIC_CODES.doctorAppManifestRuntimeUnsupported;
    case "provider-unsupported":
      return CLI_DIAGNOSTIC_CODES.doctorAppManifestProviderUnsupported;
    case "value-unsupported":
      return CLI_DIAGNOSTIC_CODES.doctorAppManifestValueUnsupported;
  }
}

function applicationIntentWorkspaceDrift(
  checkId: string,
  manifestField: string,
  declaredValue: string,
  evidence: string,
): DoctorDiagnostic {
  return {
    code: CLI_DIAGNOSTIC_CODES.doctorAppManifestWorkspaceDrift,
    severity: "error",
    checkId,
    cause: `${DEFAULT_APPLICATION_INTENT_MANIFEST_PATH}.${manifestField} declares '${declaredValue}', but required workspace evidence is missing: ${evidence}.`,
    location: { file: DEFAULT_APPLICATION_INTENT_MANIFEST_PATH },
    action:
      "Restore the generated package selection or root quality-gate script, or regenerate the workspace from croco.app.json intent, then rerun croco doctor.",
  };
}

function formatDiagnosticValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function workspaceVersionConsistencyCheck(
  rootDir: string,
  packages: readonly DoctorPackage[],
): DoctorCheckResult {
  const checkId = "workspace-version-consistency";
  const workspacePackages = new Map(
    packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  );
  const diagnostics = collectDeclaredDependencies(rootDir, packages)
    .filter((dependency) => workspacePackages.has(dependency.name))
    .filter((dependency) => !isWorkspaceConsistentRange(dependency, workspacePackages))
    .map((dependency) => ({
      code: CLI_DIAGNOSTIC_CODES.doctorWorkspaceVersionConflict,
      severity: "error" as const,
      checkId,
      cause: `${dependency.importerName} references workspace package ${dependency.name} with range '${dependency.range}'.`,
      location: {
        file: toPosixPath(relative(rootDir, join(dependency.importerDir, "package.json"))),
        packageName: dependency.importerName,
      },
      action:
        "Use a workspace: range for local workspace package dependencies, or align the dependency range with the referenced package version.",
    }));

  return {
    id: checkId,
    title: "Workspace package version consistency",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} inconsistent workspace dependency range(s) found.`
        : `${packages.length} workspace package manifest(s) use consistent local dependency ranges.`,
  };
}

function spinePackageStateCheck(
  rootDir: string,
  packages: readonly DoctorPackage[],
): DoctorCheckResult {
  const checkId = "spine-package-state";
  const workspacePackageNames = new Set(packages.map((workspacePackage) => workspacePackage.name));
  const spineDependencies = collectDeclaredDependencies(rootDir, packages)
    .filter((dependency) => dependency.name.startsWith("@croco/"))
    .filter((dependency) => !workspacePackageNames.has(dependency.name))
    .filter(uniqueDependencyByName);

  if (spineDependencies.length === 0) {
    return {
      id: checkId,
      title: "Spine package install and build state",
      status: "skipped",
      diagnostics: [],
      note: "No external @croco spine package dependencies were declared.",
    };
  }

  const diagnostics = spineDependencies.flatMap((dependency): DoctorDiagnostic[] => {
    const installedPackage = findInstalledPackage(dependency, rootDir);

    if (!installedPackage) {
      return [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorSpinePackageNotInstalled,
          severity: "error" as const,
          checkId,
          cause: `${dependency.name} is declared with range '${dependency.range}', but it is not installed under node_modules.`,
          location: { file: "node_modules", packageName: dependency.name },
          action: "Run pnpm install, then rerun croco doctor.",
        },
      ];
    }

    const manifest = readJsonObject(installedPackage.packageJsonPath);
    if (manifest.kind === "invalid") {
      return [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorSpinePackageManifestInvalid,
          severity: "error" as const,
          checkId,
          cause: `${dependency.name} package.json could not be parsed: ${manifest.message}`,
          location: {
            file: toPosixPath(relative(rootDir, installedPackage.packageJsonPath)),
            packageName: dependency.name,
          },
          action: "Reinstall dependencies so the package manifest is restored.",
        },
      ];
    }

    const missingTargets = readPackageBuildTargets(manifest.value)
      .filter((target) => target.startsWith("./dist/") || target === "./dist")
      .filter((target) => !existsSync(join(installedPackage.packageDir, target)));

    return missingTargets.map((target) => ({
      code: CLI_DIAGNOSTIC_CODES.doctorSpinePackageNotBuilt,
      severity: "error" as const,
      checkId,
      cause: `${dependency.name} declares build output ${target}, but that file is missing.`,
      location: {
        file: toPosixPath(relative(rootDir, join(installedPackage.packageDir, target))),
        packageName: dependency.name,
      },
      action:
        "Rebuild the source package or reinstall from a packed/published package that includes its dist artifacts.",
    }));
  });

  return {
    id: checkId,
    title: "Spine package install and build state",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} spine package install/build issue(s) found.`
        : `${spineDependencies.length} external @croco spine package(s) are installed with declared build artifacts.`,
  };
}

function contractGraphReadinessCheck(rootDir: string): DoctorCheckResult {
  const checkId = "contract-graph-readiness";
  const snapshotPath = join(rootDir, defaultContractGraphSnapshotPath);
  const rootScripts = readRootScripts(rootDir);
  const expectsContractGraph =
    existsSync(snapshotPath) ||
    hasAnyScript(rootScripts, ["contract:check", "contract:snapshot", "contract:verify"]);

  if (!expectsContractGraph) {
    return {
      id: checkId,
      title: "ContractGraph artifact",
      status: "skipped",
      diagnostics: [],
      note: "No contract graph script or snapshot artifact was found.",
    };
  }

  if (!existsSync(snapshotPath)) {
    return {
      id: checkId,
      title: "ContractGraph artifact",
      status: "fail",
      diagnostics: [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorContractGraphMissing,
          severity: "error",
          checkId,
          cause: `${defaultContractGraphSnapshotPath} is required by the declared contract scripts but is missing.`,
          location: { file: defaultContractGraphSnapshotPath },
          action: "Run pnpm contract:snapshot, commit the snapshot, then rerun croco doctor.",
        },
      ],
    };
  }

  const snapshot = readJsonObject(snapshotPath);
  if (snapshot.kind === "invalid" || !isContractGraphSnapshotRecord(snapshot.value)) {
    return {
      id: checkId,
      title: "ContractGraph artifact",
      status: "fail",
      diagnostics: [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorContractGraphInvalid,
          severity: "error",
          checkId,
          cause:
            snapshot.kind === "invalid"
              ? `${defaultContractGraphSnapshotPath} could not be parsed: ${snapshot.message}`
              : `${defaultContractGraphSnapshotPath} is not a croco.contract-graph.snapshot.v1 artifact.`,
          location: { file: defaultContractGraphSnapshotPath },
          action: "Regenerate the snapshot with pnpm contract:snapshot.",
        },
      ],
    };
  }

  const graphDiagnostics = readDiagnosticRecords(snapshot.value.diagnostics);
  const graphErrors = graphDiagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const diagnostics: DoctorDiagnostic[] = graphErrors.map((diagnostic) => ({
    code: CLI_DIAGNOSTIC_CODES.doctorContractGraphErrors,
    severity: "error" as const,
    checkId,
    cause: `ContractGraph reports ${diagnostic.code}: ${diagnostic.message}`,
    location: { file: defaultContractGraphSnapshotPath },
    action: "Fix the controller contract diagnostic, then rerun pnpm contract:snapshot.",
  }));

  return {
    id: checkId,
    title: "ContractGraph artifact",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} ContractGraph error diagnostic(s) found.`
        : `${readNumber(snapshot.value, "routeCount", 0)} route(s) captured with ${graphDiagnostics.length} diagnostic(s).`,
  };
}

function projectManifestBundleReadinessCheck(rootDir: string): DoctorCheckResult {
  const checkId = "project-manifest-bundle";
  const bundleDir = join(rootDir, defaultProjectManifestBundlePath);
  const rootScripts = readRootScripts(rootDir);
  const expectsBundle =
    existsSync(bundleDir) ||
    Object.values(rootScripts).some((script) => script.includes("--manifest-bundle"));

  if (!expectsBundle) {
    return {
      id: checkId,
      title: "Project manifest bundle",
      status: "skipped",
      diagnostics: [],
      note: `${defaultProjectManifestBundlePath} was not found.`,
    };
  }

  if (!existsSync(bundleDir)) {
    return {
      id: checkId,
      title: "Project manifest bundle",
      status: "fail",
      diagnostics: [
        {
          code: CLI_DIAGNOSTIC_CODES.projectMapManifestMissing,
          legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.projectMapManifestMissing,
          severity: "error",
          checkId,
          cause: `${defaultProjectManifestBundlePath} is required by project-map scripts but is missing.`,
          location: { file: defaultProjectManifestBundlePath },
          action:
            "Run croco project map --manifest-bundle .croco/manifest and commit the generated bundle when it is part of the drift gate.",
        },
      ],
    };
  }

  const diagnostics = projectManifestBundleFiles.flatMap((artifact): DoctorDiagnostic[] => {
    const artifactPath = join(bundleDir, artifact.path);
    const artifactRelativePath = toPosixPath(join(defaultProjectManifestBundlePath, artifact.path));

    if (!existsSync(artifactPath)) {
      return [
        {
          code: CLI_DIAGNOSTIC_CODES.projectMapManifestMissing,
          legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.projectMapManifestMissing,
          severity: "error",
          checkId,
          cause: `Project manifest bundle artifact ${artifactRelativePath} is missing.`,
          location: { file: artifactRelativePath },
          action: "Regenerate the bundle with croco project map --manifest-bundle .croco/manifest.",
        },
      ];
    }

    const manifest = readJsonObject(artifactPath);
    if (manifest.kind === "valid" && manifest.value.schemaVersion === artifact.schemaVersion) {
      return [];
    }

    return [
      {
        code: CLI_DIAGNOSTIC_CODES.projectMapManifestDrift,
        legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.projectMapManifestDrift,
        severity: "error",
        checkId,
        cause:
          manifest.kind === "invalid"
            ? `${artifactRelativePath} could not be parsed: ${manifest.message}`
            : `${artifactRelativePath} must be ${artifact.schemaVersion}.`,
        location: { file: artifactRelativePath },
        action: "Regenerate the bundle with croco project map --manifest-bundle .croco/manifest.",
      },
    ];
  });

  return {
    id: checkId,
    title: "Project manifest bundle",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} Project manifest bundle issue(s) found.`
        : `${projectManifestBundleFiles.length} schema-versioned manifest bundle artifact(s) are readable.`,
  };
}

function advisoryGateReadinessCheck(
  rootDir: string,
  packages: readonly DoctorPackage[],
): DoctorCheckResult {
  const checkId = "advisory-gate-readiness";
  const sections = [
    coreCoverageCandidateReadiness(rootDir, packages, checkId),
    bundleSizeBaselineReadiness(rootDir, packages, checkId),
    benchmarkVarianceEvidenceReadiness(rootDir, checkId),
    securityAllowlistMetadataReadiness(rootDir, checkId),
  ].filter((section): section is AdvisoryGateReadinessSection => section !== null);

  if (sections.length === 0) {
    return {
      id: checkId,
      title: "Advisory release-hardening readiness",
      status: "skipped",
      diagnostics: [],
      note: "No advisory release-hardening scripts or artifacts were found.",
    };
  }

  const diagnostics = sections.flatMap((section) => section.diagnostics);

  return {
    id: checkId,
    title: "Advisory release-hardening readiness",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} advisory release-hardening readiness warning(s) found.`
        : `${sections.map((section) => section.label).join(", ")} readiness evidence is present.`,
  };
}

function coreCoverageCandidateReadiness(
  rootDir: string,
  packages: readonly DoctorPackage[],
  checkId: string,
): AdvisoryGateReadinessSection | null {
  const rootScripts = readRootScripts(rootDir);
  const coreCoverageScript = rootScripts["test:coverage:core"];
  const catalogPath = join(rootDir, defaultPackageCatalogPath);

  if (!coreCoverageScript) {
    return null;
  }

  if (!existsSync(catalogPath)) {
    return {
      label: "core coverage selection",
      diagnostics: [
        advisoryDiagnostic({
          code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
          checkId,
          cause: `${defaultPackageCatalogPath} is missing.`,
          location: { file: defaultPackageCatalogPath },
          action:
            "Restore docs/package-catalog.json, rerun pnpm test:coverage:core:warning, and commit the refreshed coverage evidence.",
        }),
      ],
    };
  }

  const catalog = readJsonObject(catalogPath);
  if (catalog.kind === "invalid") {
    return {
      label: "core coverage selection",
      diagnostics: [
        advisoryDiagnostic({
          code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
          checkId,
          cause: `${defaultPackageCatalogPath} could not be parsed: ${catalog.message}`,
          location: { file: defaultPackageCatalogPath },
          action:
            "Fix docs/package-catalog.json, rerun pnpm test:coverage:core:warning, and commit the refreshed coverage evidence.",
        }),
      ],
    };
  }

  const directCoveragePackages = parseCoreCoveragePackageFilters(coreCoverageScript);
  const usesCoverageDispatcher = coreCoverageScript.includes(
    "verification-command.mts --id core-coverage",
  );
  const warningScriptPath = join(rootDir, defaultCoreCoverageWarningCheckPath);
  const warningScriptDiagnostics = existsSync(warningScriptPath)
    ? []
    : [
        advisoryDiagnostic({
          code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
          checkId,
          cause: `${defaultCoreCoverageWarningCheckPath} is missing while test:coverage:core is configured.`,
          location: { file: defaultCoreCoverageWarningCheckPath },
          action:
            "Restore scripts/core-coverage-warning-check.mts, rerun pnpm test:coverage:core:warning, and commit the refreshed coverage evidence.",
        }),
      ];
  const thresholdPackagesResult = readCoreCoverageThresholdPackages(rootDir);
  const configuredPackages = thresholdPackagesResult.packages;
  const selectedPackages = new Set(configuredPackages ?? []);
  const temporarilyExcludedPackages = readTemporaryCoreCoverageSelectionExclusions(rootDir);
  const intentionalZeroBaselinePackages = readIntentionalCoreCoverageZeroBaselineReasons(rootDir);
  const candidates = collectCoreCoverageCandidates(catalog.value, packages);
  const selectionDiagnostics = configuredPackages
    ? candidates
        .filter(
          (candidate) =>
            !selectedPackages.has(candidate.packageName) &&
            (usesCoverageDispatcher || !directCoveragePackages.includes(candidate.packageName)) &&
            (!temporarilyExcludedPackages.has(candidate.packageName) ||
              candidate.signals.includes("1.0 spine package")),
        )
        .map((candidate) =>
          advisoryDiagnostic({
            code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
            checkId,
            cause: `${candidate.packageName} has advisory core coverage signals [${candidate.signals.join(", ")}] but is not selected by the shared core coverage config.`,
            location: {
              file: defaultCoreCoverageConfigPath,
              packageName: candidate.packageName,
            },
            action:
              `Add ${candidate.packageName} to CORE_COVERAGE_PACKAGES in scripts/core-coverage-config.mts, run pnpm test:coverage:core, ` +
              "update ci-reports/coverage/core-baseline.txt, then rerun pnpm test:coverage:core:warning. " +
              "If it is intentionally deferred, record a reason in TEMPORARY_CORE_COVERAGE_SELECTION_EXCLUSIONS.",
          }),
        )
    : [];
  const directSelectionDiagnostics =
    configuredPackages && !usesCoverageDispatcher
      ? collectCoreCoverageConfigurationDiagnostics(
          directCoveragePackages,
          configuredPackages,
          checkId,
        )
      : [];
  const thresholdDiagnostics =
    thresholdPackagesResult.kind === "missing"
      ? [
          advisoryDiagnostic({
            code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
            checkId,
            cause: `${thresholdPackagesResult.path} is missing ${thresholdPackagesResult.exportName}.`,
            location: { file: thresholdPackagesResult.path },
            action: `Restore ${thresholdPackagesResult.exportName} in ${thresholdPackagesResult.path}, then rerun pnpm test:coverage:core:warning.`,
          }),
        ]
      : [];
  const baselineDiagnostics = collectCoreCoverageBaselineDiagnostics(
    rootDir,
    [...selectedPackages],
    checkId,
    intentionalZeroBaselinePackages,
  );
  const diagnostics = [
    ...warningScriptDiagnostics,
    ...selectionDiagnostics,
    ...directSelectionDiagnostics,
    ...thresholdDiagnostics,
    ...baselineDiagnostics,
  ];

  return { label: "core coverage selection", diagnostics };
}

function collectCoreCoverageCandidates(
  catalog: Record<string, unknown>,
  packages: readonly DoctorPackage[],
): Array<{ readonly packageName: string; readonly signals: readonly string[] }> {
  const packageGroups = readCatalogPackageMembership(catalog.groups);
  const packageMaturity = readCatalogPackageMembership(catalog.maturity);
  const spinePackages = new Set(readStringArray(asRecord(catalog.spine)?.packages));
  const workspacePackageBySlug = new Map(
    packages
      .filter((workspacePackage) => !workspacePackage.private)
      .map((workspacePackage) => [toPackageSlug(workspacePackage.name), workspacePackage.name]),
  );
  const packageSlugs = new Set([
    ...packageGroups.keys(),
    ...packageMaturity.keys(),
    ...spinePackages,
    ...workspacePackageBySlug.keys(),
  ]);

  return [...packageSlugs]
    .flatMap((packageSlug) => {
      const packageName = workspacePackageBySlug.get(packageSlug);
      if (!packageName) {
        return [];
      }

      const groupSignals = (packageGroups.get(packageSlug) ?? [])
        .filter((groupName) => coreCoverageFrameworkGroups.has(groupName))
        .map((groupName) => `catalog group: ${groupName}`);
      const maturitySignals = (packageMaturity.get(packageSlug) ?? []).includes("production")
        ? ["production-ready maturity"]
        : [];
      const spineSignals = spinePackages.has(packageSlug) ? ["1.0 spine package"] : [];
      const releaseCriticalSignals = coreCoverageReleaseCriticalRules
        .filter((rule) => rule.pattern.test(packageSlug))
        .map((rule) => rule.signal);
      const signals = uniqueStrings([
        ...groupSignals,
        ...maturitySignals,
        ...spineSignals,
        ...releaseCriticalSignals,
      ]).sort(compareStrings);

      return signals.length > 0 ? [{ packageName, signals }] : [];
    })
    .sort((left, right) => compareStrings(left.packageName, right.packageName));
}

function collectCoreCoverageBaselineDiagnostics(
  rootDir: string,
  selectedPackages: readonly string[],
  checkId: string,
  intentionalZeroBaselinePackages: ReadonlySet<string>,
): DoctorDiagnostic[] {
  const baselinePath = join(rootDir, defaultCoreCoverageBaselinePath);
  const baselineEntries = existsSync(baselinePath)
    ? readCoreCoverageBaselineEntries(rootDir)
    : new Map<string, CoreCoverageBaselineEntry>();
  const thresholdValues = readCoreCoverageThresholdValues(rootDir);

  return uniqueStrings(selectedPackages).flatMap((packageName) => {
    const coverageSummaryPath = join(
      rootDir,
      "packages",
      toPackageSlug(packageName),
      "coverage",
      "coverage-summary.json",
    );
    if (!existsSync(coverageSummaryPath)) {
      return [
        advisoryDiagnostic({
          code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
          checkId,
          cause: `${packageName}: coverage summary not found.`,
          location: {
            file: toPosixPath(relative(rootDir, coverageSummaryPath)),
            packageName,
          },
          action:
            "Run pnpm test:coverage:core so coverage/coverage-summary.json exists, then rerun pnpm test:coverage:core:warning.",
        }),
      ];
    }

    const coverageSummary = readCoreCoverageSummaryTotals(coverageSummaryPath);
    if (coverageSummary.kind === "invalid") {
      return [
        advisoryDiagnostic({
          code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
          checkId,
          cause: `${packageName}: ${coverageSummary.message}.`,
          location: {
            file: toPosixPath(relative(rootDir, coverageSummaryPath)),
            packageName,
          },
          action:
            "Run pnpm test:coverage:core so coverage/coverage-summary.json contains total statement, branch, function, and line percentages.",
        }),
      ];
    }

    const baseline = baselineEntries.get(packageName);
    if (!baseline) {
      return [
        advisoryDiagnostic({
          code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
          checkId,
          cause: `${packageName}: baseline entry is missing when coverage summary exists.`,
          location: { file: defaultCoreCoverageBaselinePath, packageName },
          action:
            "Run pnpm test:coverage:core, update ci-reports/coverage/core-baseline.txt from measured totals, then rerun pnpm test:coverage:core:warning.",
        }),
      ];
    }

    const nonNumericMetrics = coreCoverageBaselineMetrics.filter(
      (metric) => !Number.isFinite(baseline[metric]),
    );
    const zeroMetrics = intentionalZeroBaselinePackages.has(packageName)
      ? []
      : coreCoverageBaselineMetrics.filter((metric) => baseline[metric] === 0);
    const thresholdWarnings =
      thresholdValues === null
        ? []
        : coreCoverageBaselineMetrics
            .filter(
              (metric) =>
                Number.isFinite(thresholdValues[metric]) &&
                coverageSummary.totals[metric] < thresholdValues[metric],
            )
            .map(
              (metric) =>
                `${metric} ${coverageSummary.totals[metric].toFixed(2)}% < ${thresholdValues[metric]}%`,
            );
    const baselineWarnings = coreCoverageBaselineMetrics
      .filter(
        (metric) =>
          Number.isFinite(baseline[metric]) && coverageSummary.totals[metric] < baseline[metric],
      )
      .map(
        (metric) =>
          `${metric} ${coverageSummary.totals[metric].toFixed(2)}% < baseline ${baseline[metric].toFixed(2)}%`,
      );
    const failures = [
      ...(nonNumericMetrics.length > 0
        ? [`baseline ${nonNumericMetrics.join(", ")} must be numeric`]
        : []),
      ...(zeroMetrics.length > 0 ? [`baseline ${zeroMetrics.join(", ")} cannot be 0`] : []),
      ...(thresholdWarnings.length > 0
        ? [`threshold warning(s): ${thresholdWarnings.join(", ")}`]
        : []),
      ...(baselineWarnings.length > 0
        ? [`baseline warning(s): ${baselineWarnings.join(", ")}`]
        : []),
    ];

    if (failures.length === 0) {
      return [];
    }

    return [
      advisoryDiagnostic({
        code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
        checkId,
        cause: `${packageName}: ${failures.join("; ")} when coverage summary exists.`,
        location: { file: defaultCoreCoverageBaselinePath, packageName },
        action:
          "Run pnpm test:coverage:core, update ci-reports/coverage/core-baseline.txt from measured totals, then rerun pnpm test:coverage:core:warning.",
      }),
    ];
  });
}

type CoreCoverageMetric = (typeof coreCoverageBaselineMetrics)[number];
type CoreCoverageMetricValues = Record<CoreCoverageMetric, number>;
type CoreCoverageBaselineEntry = CoreCoverageMetricValues;

type CoreCoverageSummaryTotalsResult =
  | { readonly kind: "valid"; readonly totals: CoreCoverageMetricValues }
  | { readonly kind: "invalid"; readonly message: string };

function readCoreCoverageBaselineEntries(rootDir: string): Map<string, CoreCoverageBaselineEntry> {
  const entries = new Map<string, CoreCoverageBaselineEntry>();
  const content = readFileSync(join(rootDir, defaultCoreCoverageBaselinePath), "utf-8");

  for (const line of content.split(/\r?\n/)) {
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    const packageCell = cells[0];

    if (cells.length !== 5 || !packageCell?.startsWith("`") || !packageCell.endsWith("`")) {
      continue;
    }

    const packageName = packageCell.slice(1, -1);
    entries.set(packageName, {
      statements: Number(cells[1]),
      branches: Number(cells[2]),
      functions: Number(cells[3]),
      lines: Number(cells[4]),
    });
  }

  return entries;
}

function readCoreCoverageSummaryTotals(summaryPath: string): CoreCoverageSummaryTotalsResult {
  const summary = readJsonObject(summaryPath);
  if (summary.kind === "invalid") {
    return { kind: "invalid", message: `coverage-summary.json is unreadable: ${summary.message}` };
  }

  const totals = asRecord(summary.value.total);
  if (!totals) {
    return { kind: "invalid", message: "coverage-summary.json is missing total metrics" };
  }

  const summaryTotals = Object.fromEntries(
    coreCoverageBaselineMetrics.map((metric) => {
      const metricTotals = asRecord(totals[metric]);
      return [metric, Number(metricTotals?.pct)];
    }),
  ) as CoreCoverageMetricValues;
  const invalidMetrics = coreCoverageBaselineMetrics.filter((metric) => {
    return !Number.isFinite(summaryTotals[metric]);
  });

  return invalidMetrics.length > 0
    ? {
        kind: "invalid",
        message: `coverage-summary.json total ${invalidMetrics.join(", ")} pct must be numeric`,
      }
    : { kind: "valid", totals: summaryTotals };
}

function readCatalogPackageMembership(value: unknown): Map<string, string[]> {
  const membership = new Map<string, string[]>();
  if (!isRecord(value)) {
    return membership;
  }

  for (const [label, section] of Object.entries(value)) {
    const packageSlugs = readStringArray(asRecord(section)?.packages);
    for (const packageSlug of packageSlugs) {
      membership.set(packageSlug, [...(membership.get(packageSlug) ?? []), label]);
    }
  }

  return membership;
}

function readTemporaryCoreCoverageSelectionExclusions(rootDir: string): ReadonlySet<string> {
  return readCoreCoverageWarningCheckStringMap(
    rootDir,
    "TEMPORARY_CORE_COVERAGE_SELECTION_EXCLUSIONS",
  );
}

function readIntentionalCoreCoverageZeroBaselineReasons(rootDir: string): ReadonlySet<string> {
  return readCoreCoverageWarningCheckStringMap(rootDir, "INTENTIONAL_ZERO_BASELINE_REASONS");
}

function readCoreCoverageWarningCheckStringMap(
  rootDir: string,
  declarationName: string,
): ReadonlySet<string> {
  const scriptPath = join(rootDir, defaultCoreCoverageWarningCheckPath);
  if (!existsSync(scriptPath)) {
    return new Set();
  }

  const source = stripTypeScriptComments(readFileSync(scriptPath, "utf-8"));
  const declaration = source.match(
    new RegExp(
      `const\\s+${escapeRegExp(declarationName)}(?:\\s*:\\s*Record<[^=]+>)?\\s*=\\s*\\{([\\s\\S]*?)\\};`,
    ),
  );
  const declarationBody = declaration?.[1];
  if (!declarationBody) {
    return new Set();
  }

  const packages = [...declarationBody.matchAll(/["']([^"']+)["']\s*:\s*["']([\s\S]*?)["']/g)]
    .filter(([, , reason]) => reason.trim().length > 0)
    .map(([, packageName]) => packageName);

  return new Set(uniqueStrings(packages));
}

type CoreCoverageThresholdPackagesResult =
  | { readonly kind: "present"; readonly packages: string[] }
  | {
      readonly kind: "missing";
      readonly path: string;
      readonly exportName: "CORE_COVERAGE_PACKAGES" | "CORE_COVERAGE_THRESHOLDS";
      readonly packages?: string[];
    };

function readCoreCoverageThresholdPackages(rootDir: string): CoreCoverageThresholdPackagesResult {
  const coreCoverageConfigPath = join(rootDir, defaultCoreCoverageConfigPath);
  if (!existsSync(coreCoverageConfigPath)) {
    return {
      kind: "missing",
      path: defaultCoreCoverageConfigPath,
      exportName: "CORE_COVERAGE_PACKAGES",
    };
  }

  const coreCoverageConfigSource = readFileSync(coreCoverageConfigPath, "utf-8");
  const packages = parseStringArrayExport(coreCoverageConfigSource, "CORE_COVERAGE_PACKAGES");
  if (packages === null) {
    return {
      kind: "missing",
      path: defaultCoreCoverageConfigPath,
      exportName: "CORE_COVERAGE_PACKAGES",
    };
  }

  const vitestConfigPath = join(rootDir, defaultVitestConfigPath);
  if (!existsSync(vitestConfigPath)) {
    return {
      kind: "missing",
      path: defaultVitestConfigPath,
      exportName: "CORE_COVERAGE_THRESHOLDS",
      packages,
    };
  }

  const vitestConfigSource = readFileSync(vitestConfigPath, "utf-8");
  if (!hasObjectExport(vitestConfigSource, "CORE_COVERAGE_THRESHOLDS")) {
    return {
      kind: "missing",
      path: defaultVitestConfigPath,
      exportName: "CORE_COVERAGE_THRESHOLDS",
      packages,
    };
  }

  return { kind: "present", packages };
}

function readCoreCoverageThresholdValues(rootDir: string): CoreCoverageMetricValues | null {
  const configPath = join(rootDir, defaultVitestConfigPath);
  if (!existsSync(configPath)) {
    return null;
  }

  return parseCoreCoverageThresholdValues(readFileSync(configPath, "utf-8"));
}

function parseCoreCoverageThresholdValues(source: string): CoreCoverageMetricValues | null {
  const declaration = source.match(
    /export\s+const\s+CORE_COVERAGE_THRESHOLDS\s*=\s*\{([\s\S]*?)\}\s*;?/,
  );
  const declarationBody = declaration?.[1];
  if (!declarationBody) {
    return null;
  }

  return declarationBody
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<CoreCoverageMetricValues>(
      (thresholds, line) => {
        const [metric, value] = line
          .replace(",", "")
          .split(":")
          .map((part) => part.trim());

        if (isCoreCoverageMetric(metric)) {
          thresholds[metric] = Number.parseFloat(value ?? "");
        }

        return thresholds;
      },
      {
        branches: 0,
        functions: 0,
        lines: 0,
        statements: 0,
      },
    );
}

function isCoreCoverageMetric(value: unknown): value is CoreCoverageMetric {
  return (
    value === "branches" || value === "functions" || value === "lines" || value === "statements"
  );
}

function parseStringArrayExport(source: string, exportName: string): string[] | null {
  const declaration = source.match(
    new RegExp(
      `export\\s+const\\s+${escapeRegExp(exportName)}\\s*=\\s*(?:defineCoreCoveragePackages\\s*\\(\\s*)?\\[([\\s\\S]*?)\\](?:\\s+as\\s+const)?\\s*\\)?\\s*;`,
    ),
  );
  const declarationBody = declaration?.[1];
  if (!declarationBody) {
    return null;
  }

  return uniqueStrings(
    [...declarationBody.matchAll(/["']([^"']+)["']/g)].map(([, packageName]) => packageName),
  );
}

function hasObjectExport(source: string, exportName: string): boolean {
  const declaration = source.match(
    new RegExp(`export\\s+const\\s+${escapeRegExp(exportName)}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*;?`),
  );
  return Boolean(declaration?.[1]?.trim());
}

function collectCoreCoverageConfigurationDiagnostics(
  coreCoveragePackages: readonly string[],
  configuredPackages: readonly string[],
  checkId: string,
): DoctorDiagnostic[] {
  const coreCoverageSet = new Set(coreCoveragePackages);
  const configuredSet = new Set(configuredPackages);
  const missingThresholdPackages = coreCoveragePackages.filter(
    (packageName) => !configuredSet.has(packageName),
  );
  const missingFilterPackages = configuredPackages.filter(
    (packageName) => !coreCoverageSet.has(packageName),
  );

  return [
    ...missingThresholdPackages.map((packageName) =>
      advisoryDiagnostic({
        code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
        checkId,
        cause: `${packageName} is selected by test:coverage:core but is missing from the shared core coverage config.`,
        location: { file: defaultCoreCoverageConfigPath, packageName },
        action:
          "Add the package to CORE_COVERAGE_PACKAGES in scripts/core-coverage-config.mts or remove the stale test:coverage:core filter, then rerun pnpm test:coverage:core:warning.",
      }),
    ),
    ...missingFilterPackages.map((packageName) =>
      advisoryDiagnostic({
        code: CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
        checkId,
        cause: `${packageName} is listed in the shared core coverage config but is missing from test:coverage:core filters.`,
        location: { file: "package.json", packageName },
        action:
          "Add the package to the direct test:coverage:core filters or remove the stale CORE_COVERAGE_PACKAGES entry from scripts/core-coverage-config.mts, then rerun pnpm test:coverage:core:warning.",
      }),
    ),
  ];
}

function bundleSizeBaselineReadiness(
  rootDir: string,
  packages: readonly DoctorPackage[],
  checkId: string,
): AdvisoryGateReadinessSection | null {
  const publicBuildPackages = packages.filter((workspacePackage) =>
    packageHasPublicBuildScript(rootDir, workspacePackage),
  );

  if (publicBuildPackages.length === 0) {
    return null;
  }

  const baselinePath = join(rootDir, defaultBundleSizeBaselinePath);
  const diagnostics = !existsSync(baselinePath)
    ? [
        advisoryDiagnostic({
          code: CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
          checkId,
          cause: `${defaultBundleSizeBaselinePath} is missing for ${publicBuildPackages.length} public build package(s).`,
          location: { file: defaultBundleSizeBaselinePath },
          action:
            "Run pnpm build && pnpm package-quality:report, then commit ci-reports/bundle-size/baseline.json.",
        }),
      ]
    : invalidBundleBaselineDiagnostic(rootDir, publicBuildPackages, checkId);

  return { label: "bundle-size baseline", diagnostics };
}

function invalidBundleBaselineDiagnostic(
  rootDir: string,
  publicBuildPackages: readonly DoctorPackage[],
  checkId: string,
): DoctorDiagnostic[] {
  const baseline = readJsonObject(join(rootDir, defaultBundleSizeBaselinePath));
  const failure =
    baseline.kind === "valid"
      ? validateBundleSizeBaselineEntries(rootDir, baseline.value, publicBuildPackages)
      : `could not be parsed: ${baseline.message}`;

  if (!failure) {
    return [];
  }

  return [
    advisoryDiagnostic({
      code: CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
      checkId,
      cause: `${defaultBundleSizeBaselinePath} ${failure}`,
      location: { file: defaultBundleSizeBaselinePath },
      action: "Regenerate the bundle-size baseline with pnpm build && pnpm package-quality:report.",
    }),
  ];
}

function validateBundleSizeBaselineEntries(
  rootDir: string,
  baseline: Record<string, unknown>,
  publicBuildPackages: readonly DoctorPackage[],
): string | null {
  const artifactEntries = isRecord(baseline.artifacts) ? baseline.artifacts : baseline;
  const entries = Object.entries(artifactEntries);

  if (entries.length === 0) {
    return "does not contain any baseline entries.";
  }

  const baselineEntries = new Map<string, number>();
  for (const [key, value] of entries) {
    const bytes = readBundleSizeBaselineEntryBytes(value);
    if (bytes === null) {
      return `entry ${key} must be a non-negative byte number or an object with a non-negative bytes number.`;
    }

    baselineEntries.set(key, bytes);
  }

  return validateBundleSizeBaselineKeys(rootDir, publicBuildPackages, baselineEntries);
}

function readBundleSizeBaselineEntryBytes(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  return isRecord(value) &&
    typeof value.bytes === "number" &&
    Number.isFinite(value.bytes) &&
    value.bytes >= 0
    ? value.bytes
    : null;
}

function validateBundleSizeBaselineKeys(
  rootDir: string,
  publicBuildPackages: readonly DoctorPackage[],
  baselineEntries: ReadonlyMap<string, number>,
): string | null {
  const measuredArtifacts = publicBuildPackages.map((workspacePackage) => ({
    workspacePackage,
    artifacts: collectMeasuredBundleArtifacts(rootDir, workspacePackage),
  }));
  const packagesWithoutArtifacts = measuredArtifacts
    .filter(({ artifacts }) => artifacts.length === 0)
    .map(({ workspacePackage }) => workspacePackage.name);
  const matchedBaselineKeys = new Set<string>();
  const missingArtifactBaselines: string[] = [];
  const overBaselineArtifacts: string[] = [];

  for (const { workspacePackage, artifacts } of measuredArtifacts) {
    for (const artifact of artifacts) {
      const packageArtifactKey = `${workspacePackage.name}:${artifact.path}`;
      const baselineMatch = getBundleSizeBaselineMatch(
        baselineEntries,
        workspacePackage.name,
        artifact.path,
      );

      if (baselineMatch === null) {
        missingArtifactBaselines.push(packageArtifactKey);
        continue;
      }

      matchedBaselineKeys.add(baselineMatch.key);

      if (artifact.sizeBytes > baselineMatch.bytes) {
        overBaselineArtifacts.push(
          `${packageArtifactKey} (${artifact.sizeBytes} B > ${baselineMatch.bytes} B)`,
        );
      }
    }
  }

  const unmatchedBaselineKeys = [...baselineEntries.keys()]
    .filter((baselineKey) => !matchedBaselineKeys.has(baselineKey))
    .sort(compareStrings);
  const failures = [
    ...(packagesWithoutArtifacts.length > 0
      ? [`has no measured bundle artifact for ${formatSampleList(packagesWithoutArtifacts)}`]
      : []),
    ...(missingArtifactBaselines.length > 0
      ? [`is missing current artifact baseline(s): ${formatSampleList(missingArtifactBaselines)}`]
      : []),
    ...(overBaselineArtifacts.length > 0
      ? [`contains artifact(s) over baseline: ${formatSampleList(overBaselineArtifacts)}`]
      : []),
    ...(unmatchedBaselineKeys.length > 0
      ? [`contains stale baseline key(s): ${formatSampleList(unmatchedBaselineKeys)}`]
      : []),
  ];

  return failures.length > 0 ? `${failures.join("; ")}.` : null;
}

function getBundleSizeBaselineMatch(
  baselineEntries: ReadonlyMap<string, number>,
  packageName: string,
  artifactPath: string,
): BundleBaselineMatch | null {
  const packageArtifactKey = `${packageName}:${artifactPath}`;
  const packageArtifactBytes = baselineEntries.get(packageArtifactKey);
  if (packageArtifactBytes !== undefined) {
    return { key: packageArtifactKey, bytes: packageArtifactBytes };
  }

  const artifactBytes = baselineEntries.get(artifactPath);
  return artifactBytes === undefined ? null : { key: artifactPath, bytes: artifactBytes };
}

function collectMeasuredBundleArtifacts(
  rootDir: string,
  workspacePackage: DoctorPackage,
): MeasuredBundleArtifact[] {
  const distDir = join(rootDir, workspacePackage.relativeDir, "dist");
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    return [];
  }

  const artifactSizes = new Map<string, number>();
  for (const artifactPath of listBundleArtifactFiles(rootDir, distDir)) {
    const normalizedArtifactPath = normalizeBundleArtifactPath(artifactPath);
    artifactSizes.set(
      normalizedArtifactPath,
      (artifactSizes.get(normalizedArtifactPath) ?? 0) + statSync(join(rootDir, artifactPath)).size,
    );
  }

  return [...artifactSizes.entries()]
    .sort(([leftPath], [rightPath]) => compareStrings(leftPath, rightPath))
    .map(([path, sizeBytes]) => ({ path, sizeBytes }));
}

function listBundleArtifactFiles(rootDir: string, dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (bundleArtifactIgnoredDirectories.has(entry.name)) {
        continue;
      }
      listBundleArtifactFiles(rootDir, fullPath, results);
      continue;
    }

    const relativePath = toPosixPath(relative(rootDir, fullPath));
    if (entry.isFile() && isMeasuredBundleArtifact(relativePath)) {
      results.push(relativePath);
    }
  }

  return results;
}

function isMeasuredBundleArtifact(path: string): boolean {
  return bundleSizeArtifactSuffixes.some((suffix) => path.endsWith(suffix));
}

function normalizeBundleArtifactPath(path: string): string {
  return path.replace(hashedChunkArtifactPattern, "$1chunk-*$2");
}

function formatSampleList(values: readonly string[]): string {
  const sorted = [...values].sort(compareStrings);
  const sample = sorted.slice(0, 5).join(", ");
  const remainingCount = sorted.length - 5;

  return remainingCount > 0 ? `${sample}, and ${remainingCount} more` : sample;
}

function packageHasPublicBuildScript(rootDir: string, workspacePackage: DoctorPackage): boolean {
  const manifest = readJsonObject(join(rootDir, workspacePackage.relativeDir, "package.json"));
  if (manifest.kind === "invalid") {
    return false;
  }

  const scripts = asRecord(manifest.value.scripts);
  return manifest.value.private !== true && typeof scripts?.build === "string";
}

function benchmarkVarianceEvidenceReadiness(
  rootDir: string,
  checkId: string,
): AdvisoryGateReadinessSection | null {
  const rootScripts = readRootScripts(rootDir);
  const expectsBenchmarkEvidence =
    Boolean(rootScripts["bench:readiness"]) ||
    Boolean(rootScripts["bench:check"]) ||
    existsSync(join(rootDir, "benchmarks", "thresholds.json")) ||
    existsSync(join(rootDir, "benchmarks", "baseline.json"));

  if (!expectsBenchmarkEvidence) {
    return null;
  }

  const evidencePath = join(rootDir, defaultBenchmarkVarianceEvidencePath);
  const failure = existsSync(evidencePath)
    ? validateBenchmarkVarianceEvidence(rootDir, readFileSync(evidencePath, "utf-8"))
    : `${defaultBenchmarkVarianceEvidencePath} is missing.`;
  const diagnostics = failure
    ? [
        advisoryDiagnostic({
          code: CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
          checkId,
          cause: `Benchmark variance evidence is not ready: ${failure}`,
          location: { file: defaultBenchmarkVarianceEvidencePath },
          action:
            "Run pnpm bench:check and pnpm bench:readiness, then commit the structured latest-five-green-runs evidence.",
        }),
      ]
    : [];

  return { label: "benchmark variance evidence", diagnostics };
}

function validateBenchmarkVarianceEvidence(rootDir: string, content: string): string | null {
  const markerIndex = content.indexOf(benchmarkVarianceEvidenceMarker);
  if (markerIndex < 0) {
    return `structured evidence marker ${benchmarkVarianceEvidenceMarker} was not found`;
  }

  const evidenceBlock = content.slice(markerIndex + benchmarkVarianceEvidenceMarker.length);
  const jsonBlock = /```json\s*([\s\S]*?)```/.exec(evidenceBlock);
  if (!jsonBlock) {
    return "structured evidence JSON block was not found after the evidence marker";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock[1]);
  } catch (error) {
    return `structured evidence JSON could not be parsed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  if (!isRecord(parsed)) {
    return "structured evidence JSON must be an object";
  }

  if (parsed.version !== 1) {
    return "structured evidence version must be 1";
  }

  if (!Array.isArray(parsed.runs)) {
    return "structured evidence runs must be an array";
  }

  if (!isRecord(parsed.checks)) {
    return "structured evidence checks must be an object";
  }

  if (!Array.isArray(parsed.rows)) {
    return "structured evidence rows must be an array";
  }

  const benchmarkResult = readBenchmarkResultReports(rootDir);
  if (benchmarkResult.kind === "invalid") {
    return benchmarkResult.message;
  }

  const failures = getBenchmarkVarianceEvidenceFailures(parsed, benchmarkResult.result);
  return failures.length > 0 ? failures.join("; ") : null;
}

type BenchmarkCurrentReport = {
  readonly name: string;
  readonly threshold: number;
  readonly baseline: number | null;
};

type BenchmarkCurrentResult = {
  readonly allPassed: boolean | undefined;
  readonly gateFailures: readonly string[];
  readonly reports: readonly BenchmarkCurrentReport[];
};

function readBenchmarkResultReports(
  rootDir: string,
):
  | { readonly kind: "valid"; readonly result: BenchmarkCurrentResult }
  | { readonly kind: "invalid"; readonly message: string } {
  const resultPath = join(rootDir, defaultBenchmarkResultPath);
  if (!existsSync(resultPath)) {
    return { kind: "invalid", message: `${defaultBenchmarkResultPath} is missing.` };
  }

  const result = readJsonObject(resultPath);
  if (result.kind === "invalid") {
    return {
      kind: "invalid",
      message: `${defaultBenchmarkResultPath} could not be parsed: ${result.message}`,
    };
  }

  if (!Array.isArray(result.value.reports)) {
    return {
      kind: "invalid",
      message: `${defaultBenchmarkResultPath} must contain a reports array.`,
    };
  }

  const gateFailures = Array.isArray(result.value.gateFailures)
    ? result.value.gateFailures.filter((failure): failure is string => typeof failure === "string")
    : [];
  const reports: BenchmarkCurrentReport[] = [];
  for (const [index, entry] of result.value.reports.entries()) {
    const report = asRecord(entry);
    const name = readBenchmarkContractString(report?.name);
    if (!report || !name) {
      return {
        kind: "invalid",
        message: `${defaultBenchmarkResultPath} report ${index + 1} must include a benchmark name.`,
      };
    }

    if (report.thresholdStatus === "skip" || !isFiniteNumber(report.threshold)) {
      return {
        kind: "invalid",
        message: `${defaultBenchmarkResultPath} ${name} threshold entry missing.`,
      };
    }

    if (!isFiniteNumber(report.p75)) {
      return {
        kind: "invalid",
        message: `${defaultBenchmarkResultPath} ${name} p75 entry missing.`,
      };
    }

    if (report.baselineStatus === "skip" || !isFiniteNumber(report.baseline)) {
      return {
        kind: "invalid",
        message: `${defaultBenchmarkResultPath} ${name} baseline entry missing.`,
      };
    }

    reports.push({
      name,
      threshold: report.threshold,
      baseline: report.baseline,
    });
  }

  if (reports.length === 0) {
    return {
      kind: "invalid",
      message: `${defaultBenchmarkResultPath} does not contain any benchmark reports.`,
    };
  }

  return {
    kind: "valid",
    result: {
      allPassed: typeof result.value.allPassed === "boolean" ? result.value.allPassed : undefined,
      gateFailures,
      reports,
    },
  };
}

function getBenchmarkVarianceEvidenceFailures(
  contract: Record<string, unknown>,
  currentResult: BenchmarkCurrentResult,
): string[] {
  const failures: string[] = [];
  const currentReports = currentResult.reports;

  if (contract.source !== "github-actions") {
    failures.push("structured evidence source must be github-actions");
  }
  if (!isIsoTimestamp(contract.reviewedAt)) {
    failures.push("structured evidence reviewedAt must be an ISO timestamp");
  }
  if (
    !isFiniteNumber(contract.tolerance) ||
    !numbersNearlyEqual(contract.tolerance, benchmarkVarianceSpreadTolerance)
  ) {
    failures.push(
      `structured evidence tolerance must be ${benchmarkVarianceSpreadTolerance.toFixed(2)}`,
    );
  }

  const rows = contract.rows as unknown[];
  if (rows.length === 0) {
    failures.push("structured evidence rows must include at least one benchmark row");
  }

  const { orderedRunIds, artifactFailureCounts } = validateBenchmarkEvidenceRuns(
    contract.runs as unknown[],
    rows.length,
    failures,
  );
  validateBenchmarkEvidenceSelection(contract.selection, orderedRunIds, failures);
  validateBenchmarkEvidenceChecks(
    contract.checks as Record<string, unknown>,
    artifactFailureCounts,
    failures,
  );
  validateBenchmarkEvidenceRows(
    rows,
    orderedRunIds,
    currentReports,
    contract.checks as Record<string, unknown>,
    failures,
  );
  validateCurrentBenchmarkResultState(currentResult, failures);

  return failures;
}

function validateCurrentBenchmarkResultState(
  currentResult: BenchmarkCurrentResult,
  failures: string[],
): void {
  for (const failure of currentResult.gateFailures) {
    failures.push(`${defaultBenchmarkResultPath} gateFailures includes: ${failure}`);
  }

  if (currentResult.allPassed === false && currentResult.gateFailures.length === 0) {
    failures.push(`${defaultBenchmarkResultPath} reports allPassed=false without gateFailures`);
  }
  if (currentResult.allPassed === true && currentResult.gateFailures.length > 0) {
    failures.push(`${defaultBenchmarkResultPath} reports allPassed=true with gateFailures`);
  }
}

function createBenchmarkGateFailureCounts(): BenchmarkVarianceGateFailureCounts {
  return {
    runnerFailures: 0,
    moduleFailures: 0,
    emptyReports: 0,
    missingReports: 0,
    thresholdFailures: 0,
    thresholdSkips: 0,
    baselineFailures: 0,
    baselineSkips: 0,
    otherFailures: 0,
  };
}

function addBenchmarkGateFailureCounts(
  target: Record<keyof BenchmarkVarianceGateFailureCounts, number>,
  source: BenchmarkVarianceGateFailureCounts,
): void {
  for (const key of Object.keys(target) as Array<keyof BenchmarkVarianceGateFailureCounts>) {
    target[key] += source[key];
  }
}

function countBenchmarkGateFailures(
  gateFailures: readonly string[],
): BenchmarkVarianceGateFailureCounts {
  const counts = createBenchmarkGateFailureCounts();

  for (const failure of gateFailures) {
    if (failure.startsWith(benchmarkRunnerErrorPrefix)) {
      counts.runnerFailures += 1;
    } else if (failure.startsWith(benchmarkModuleFailedPrefix)) {
      counts.moduleFailures += 1;
    } else if (failure === benchmarkEmptyReportFailure) {
      counts.emptyReports += 1;
    } else if (failure.endsWith(benchmarkMissingReportSuffix)) {
      counts.missingReports += 1;
    } else if (failure.includes("threshold skipped")) {
      counts.thresholdSkips += 1;
    } else if (failure.includes("baseline skipped")) {
      counts.baselineSkips += 1;
    } else if (failure.includes("exceeds threshold")) {
      counts.thresholdFailures += 1;
    } else if (failure.includes("exceeds baseline")) {
      counts.baselineFailures += 1;
    } else {
      counts.otherFailures += 1;
    }
  }

  return counts;
}

function validateBenchmarkEvidenceRuns(
  runs: readonly unknown[],
  rowCount: number,
  failures: string[],
): {
  readonly orderedRunIds: number[];
  readonly artifactFailureCounts: BenchmarkVarianceGateFailureCounts;
} {
  const orderedRunIds: number[] = [];
  const runIds = new Set<number>();
  const createdAtValues: number[] = [];
  const artifactFailureCounts = createBenchmarkGateFailureCounts();

  if (runs.length !== benchmarkVarianceEvidenceRunCount) {
    failures.push(
      `structured evidence runs must contain exactly ${benchmarkVarianceEvidenceRunCount} GitHub Actions runs`,
    );
  }

  for (const run of runs) {
    const runRecord = asRecord(run);
    if (!runRecord) {
      failures.push("each structured evidence run must be an object");
      continue;
    }

    const runId = readPositiveSafeInteger(runRecord.id);
    if (runId === null) {
      failures.push("each structured evidence run must include a positive safe integer id");
      continue;
    }

    orderedRunIds.push(runId);
    if (runIds.has(runId)) {
      failures.push(`structured evidence run id ${runId} is duplicated`);
    }
    runIds.add(runId);

    if (!matchesGitHubActionsRunUrl(runRecord.url, runId)) {
      failures.push(`structured evidence run ${runId} must include its GitHub Actions run URL`);
    }
    if (!isCommitSha(runRecord.headSha)) {
      failures.push(`structured evidence run ${runId} must include a 40-character head SHA`);
    }
    if (!readOptionalString(runRecord.headBranch)) {
      failures.push(`structured evidence run ${runId} must include a head branch`);
    }
    if (runRecord.baseBranch !== "trunk") {
      failures.push(`structured evidence run ${runId} must target trunk`);
    }

    const createdAt = parseIsoTimestamp(runRecord.createdAt);
    if (createdAt === null) {
      failures.push(`structured evidence run ${runId} must include an ISO createdAt timestamp`);
    } else {
      createdAtValues.push(createdAt);
    }

    if (runRecord.workflowStatus !== "completed") {
      failures.push(`structured evidence run ${runId} workflowStatus must be completed`);
    }
    if (runRecord.workflowConclusion !== "success") {
      failures.push(`structured evidence run ${runId} workflowConclusion must be success`);
    }

    const runFailureCounts = validateBenchmarkEvidenceRunArtifact(
      runRecord.artifact,
      runId,
      rowCount,
      failures,
    );
    if (runFailureCounts) {
      addBenchmarkGateFailureCounts(artifactFailureCounts, runFailureCounts);
    }
  }

  if (
    createdAtValues.length === benchmarkVarianceEvidenceRunCount &&
    createdAtValues.some((createdAt, index, values) => index > 0 && createdAt >= values[index - 1])
  ) {
    failures.push("structured evidence runs must be ordered newest-to-oldest by createdAt");
  }

  return { orderedRunIds, artifactFailureCounts };
}

function validateBenchmarkEvidenceRunArtifact(
  artifact: unknown,
  runId: number,
  rowCount: number,
  failures: string[],
): BenchmarkVarianceGateFailureCounts | null {
  const artifactRecord = asRecord(artifact);
  if (!artifactRecord) {
    failures.push(`structured evidence run ${runId} must include benchmark artifact evidence`);
    return null;
  }

  if (typeof artifactRecord.allPassed !== "boolean") {
    failures.push(`structured evidence run ${runId} artifact.allPassed must be boolean`);
  }
  if (!isFiniteNumber(artifactRecord.reportCount) || artifactRecord.reportCount !== rowCount) {
    failures.push(
      `structured evidence run ${runId} artifact.reportCount must match evidence row count`,
    );
  }
  if (
    !Array.isArray(artifactRecord.gateFailures) ||
    artifactRecord.gateFailures.some((failure) => typeof failure !== "string")
  ) {
    failures.push(`structured evidence run ${runId} artifact.gateFailures must be a string array`);
    return null;
  }

  const gateFailures = artifactRecord.gateFailures;
  const runFailureCounts = countBenchmarkGateFailures(gateFailures);

  if (artifactRecord.allPassed === true && gateFailures.length > 0) {
    failures.push(
      `structured evidence run ${runId} artifact cannot be allPassed=true with gate failures`,
    );
  }
  if (artifactRecord.allPassed === false && gateFailures.length === 0) {
    failures.push(
      `structured evidence run ${runId} artifact cannot be allPassed=false without gate failures`,
    );
  }
  if (runFailureCounts.otherFailures > 0) {
    failures.push(`structured evidence run ${runId} artifact contains unclassified gate failures`);
  }

  return runFailureCounts;
}

function validateBenchmarkEvidenceSelection(
  selection: unknown,
  orderedRunIds: readonly number[],
  failures: string[],
): void {
  const selectionRecord = asRecord(selection);
  if (!selectionRecord) {
    failures.push("structured evidence selection must describe the latest green trunk run window");
    return;
  }

  const expectedFields: ReadonlyArray<readonly [string, string]> = [
    ["workflowName", "Performance Benchmark"],
    ["qualifyingBaseBranch", "trunk"],
    ["qualifyingWorkflowStatus", "completed"],
    ["qualifyingWorkflowConclusion", "success"],
    ["orderedBy", "createdAt-desc"],
  ];
  for (const [field, expectedValue] of expectedFields) {
    if (selectionRecord[field] !== expectedValue) {
      failures.push(`structured evidence selection.${field} must be ${expectedValue}`);
    }
  }

  const latestRunIds = selectionRecord.latestGreenTrunkRunIds;
  if (!Array.isArray(latestRunIds) || latestRunIds.length !== benchmarkVarianceEvidenceRunCount) {
    failures.push(
      `structured evidence selection.latestGreenTrunkRunIds must contain exactly ${benchmarkVarianceEvidenceRunCount} run ids`,
    );
    return;
  }

  const normalizedRunIds = latestRunIds.map(readPositiveSafeInteger);
  if (normalizedRunIds.some((runId) => runId === null)) {
    failures.push(
      "structured evidence selection.latestGreenTrunkRunIds must be positive safe integers",
    );
    return;
  }

  if (new Set(normalizedRunIds).size !== normalizedRunIds.length) {
    failures.push(
      "structured evidence selection.latestGreenTrunkRunIds must not contain duplicates",
    );
  }
  if (JSON.stringify(normalizedRunIds) !== JSON.stringify(orderedRunIds)) {
    failures.push(
      "structured evidence selection.latestGreenTrunkRunIds must match runs in newest-to-oldest order",
    );
  }
}

function validateBenchmarkEvidenceChecks(
  checks: Record<string, unknown>,
  artifactFailureCounts: BenchmarkVarianceGateFailureCounts,
  failures: string[],
): void {
  if (checks.sameRowSet !== true) {
    failures.push("structured evidence checks.sameRowSet must be true");
  }

  const expectedArtifactFailureCounts = {
    runnerFailures: artifactFailureCounts.runnerFailures,
    moduleFailures: artifactFailureCounts.moduleFailures,
    emptyReports: artifactFailureCounts.emptyReports,
    missingReports: artifactFailureCounts.missingReports,
    thresholdFailures: artifactFailureCounts.thresholdFailures,
    thresholdSkips: artifactFailureCounts.thresholdSkips,
    baselineSkips: artifactFailureCounts.baselineSkips,
    prePromotionBaselineFailures: artifactFailureCounts.baselineFailures,
  };

  for (const [key, expectedCount] of Object.entries(expectedArtifactFailureCounts)) {
    if (checks[key] !== expectedCount) {
      failures.push(`structured evidence checks.${key} must match reviewed artifact gate failures`);
    }
  }

  for (const key of [
    "runnerFailures",
    "moduleFailures",
    "emptyReports",
    "missingReports",
    "thresholdFailures",
    "thresholdSkips",
    "baselineSkips",
  ] as const) {
    if (checks[key] !== 0) {
      failures.push(`structured evidence checks.${key} must be 0`);
    }
  }

  if (
    !isFiniteNumber(checks.prePromotionBaselineFailures) ||
    checks.prePromotionBaselineFailures < 0
  ) {
    failures.push("structured evidence checks.prePromotionBaselineFailures must be non-negative");
  }
  if (!isFiniteNumber(checks.promotedBaselineFailures) || checks.promotedBaselineFailures < 0) {
    failures.push("structured evidence checks.promotedBaselineFailures must be non-negative");
  }
}

function validateBenchmarkEvidenceRows(
  rows: readonly unknown[],
  orderedRunIds: readonly number[],
  currentReports: readonly BenchmarkCurrentReport[],
  checks: Record<string, unknown>,
  failures: string[],
): void {
  const rowNames = new Set<string>();
  const rowsByName = new Map<string, Record<string, unknown>>();
  for (const [index, row] of rows.entries()) {
    const rowRecord = asRecord(row);
    const rowLabel = `structured evidence row ${index + 1}`;
    if (!rowRecord) {
      failures.push(`${rowLabel} must be an object`);
      continue;
    }

    const rowName = readBenchmarkContractString(rowRecord.name);
    if (!rowName) {
      failures.push(`${rowLabel} must include a name`);
    } else if (rowNames.has(rowName)) {
      failures.push(
        `structured evidence rows must not contain duplicate benchmark name ${rowName}`,
      );
    } else {
      rowNames.add(rowName);
      rowsByName.set(rowName, rowRecord);
    }
  }

  const expectedNames = currentReports.map((report) => report.name).sort(compareStrings);
  const evidenceNames = [...rowsByName.keys()].sort(compareStrings);
  if (rows.length !== currentReports.length) {
    failures.push(
      `structured evidence rows must contain exactly ${currentReports.length} current benchmark row(s)`,
    );
  }
  if (JSON.stringify(evidenceNames) !== JSON.stringify(expectedNames)) {
    failures.push(
      `structured evidence row set must match ${defaultBenchmarkResultPath} (${evidenceNames.length} evidence row(s), ${expectedNames.length} result row(s))`,
    );
  }

  let promotedBaselineFailures = 0;

  for (const currentReport of currentReports) {
    const rowRecord = rowsByName.get(currentReport.name);
    if (!rowRecord) {
      continue;
    }

    const rowLabel = `${currentReport.name}`;

    if (rowRecord.status !== "pass") {
      failures.push(`${rowLabel} status must be pass`);
    }
    for (const field of ["min", "median", "max", "spread"] as const) {
      if (!isFiniteNumber(rowRecord[field])) {
        failures.push(`${rowLabel}.${field} must be numeric`);
      }
    }

    const p75ByRun = asRecord(rowRecord.p75ByRun);
    if (!p75ByRun) {
      failures.push(`${rowLabel}.p75ByRun must map run ids to p75 values`);
      continue;
    }

    const p75Values = orderedRunIds.map((runId) => p75ByRun[String(runId)]);
    if (
      p75Values.length !== benchmarkVarianceEvidenceRunCount ||
      p75Values.some((value) => !isFiniteNumber(value))
    ) {
      failures.push(`${rowLabel}.p75ByRun must contain finite p75 values for every reviewed run`);
      continue;
    }

    const numericP75Values = p75Values as number[];
    const sortedValues = [...numericP75Values].sort((left, right) => left - right);
    const min = Math.min(...numericP75Values);
    const median = sortedValues[Math.floor(sortedValues.length / 2)];
    const max = Math.max(...numericP75Values);
    const spread = (max - min) / median;

    if (!numbersNearlyEqual(rowRecord.min, min)) {
      failures.push(`${rowLabel}.min must match p75ByRun values`);
    }
    if (!numbersNearlyEqual(rowRecord.median, median)) {
      failures.push(`${rowLabel}.median must match p75ByRun values`);
    }
    if (!numbersNearlyEqual(rowRecord.max, max)) {
      failures.push(`${rowLabel}.max must match p75ByRun values`);
    }
    if (!numbersNearlyEqual(rowRecord.spread, spread)) {
      failures.push(`${rowLabel}.spread must match p75ByRun values`);
    }
    if (spread > benchmarkVarianceSpreadTolerance) {
      failures.push(
        `${rowLabel}.spread ${(spread * 100).toFixed(2)}% exceeds ${(benchmarkVarianceSpreadTolerance * 100).toFixed(0)}% tolerance`,
      );
    }
    const rowPromotedBaselineFailures =
      currentReport.baseline === null
        ? benchmarkVarianceEvidenceRunCount
        : numericP75Values.filter(
            (value) =>
              currentReport.baseline !== null &&
              value - currentReport.baseline >
                currentReport.baseline * benchmarkPromotedBaselineTolerance,
          ).length;
    promotedBaselineFailures += rowPromotedBaselineFailures;
    if (rowPromotedBaselineFailures > 0) {
      failures.push(
        `${currentReport.name}: ${rowPromotedBaselineFailures} reviewed run(s) fail the promoted baseline tolerance`,
      );
    }
    if (currentReport.baseline === null || !numbersNearlyEqual(currentReport.baseline, median)) {
      failures.push(`${currentReport.name}: committed baseline must match the reviewed median p75`);
    }
  }

  if (checks.promotedBaselineFailures !== promotedBaselineFailures) {
    failures.push(
      "structured evidence checks.promotedBaselineFailures must match promoted baseline validation",
    );
  }
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = isoTimestampPattern.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7]);
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const date = new Date(timestamp);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }

  return timestamp;
}

function isIsoTimestamp(value: unknown): value is string {
  return parseIsoTimestamp(value) !== null;
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function matchesGitHubActionsRunUrl(value: unknown, runId: number): boolean {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    const expectedPath = `${benchmarkGitHubActionsRunPathPrefix}/${runId}`;
    return (
      url.origin === "https://github.com" &&
      (url.pathname === expectedPath || url.pathname.startsWith(`${expectedPath}/`))
    );
  } catch {
    return false;
  }
}

function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numbersNearlyEqual(left: unknown, right: number): boolean {
  return isFiniteNumber(left) && Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-6);
}

function securityAllowlistMetadataReadiness(
  rootDir: string,
  checkId: string,
): AdvisoryGateReadinessSection | null {
  const existingAllowlistPaths = staticMisuseAllowlistPaths.filter((allowlistPath) =>
    existsSync(join(rootDir, allowlistPath)),
  );
  if (existingAllowlistPaths.length === 0) {
    return null;
  }

  const diagnostics = existingAllowlistPaths.flatMap((allowlistPath) =>
    validateSecurityAllowlistFile(rootDir, allowlistPath, checkId),
  );

  return { label: "security allowlist metadata", diagnostics };
}

function validateSecurityAllowlistFile(
  rootDir: string,
  allowlistPath: string,
  checkId: string,
): DoctorDiagnostic[] {
  const allowlist = readJsonObject(join(rootDir, allowlistPath));
  if (allowlist.kind === "invalid") {
    return [
      advisoryDiagnostic({
        code: CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
        checkId,
        cause: `${allowlistPath} could not be parsed: ${allowlist.message}`,
        location: { file: allowlistPath },
        action:
          "Fix the static misuse allowlist JSON, then rerun the static misuse check and croco doctor.",
      }),
    ];
  }

  const entries = allowlist.value.entries;
  if (allowlist.value.schemaVersion !== 1 || !Array.isArray(entries)) {
    return [
      advisoryDiagnostic({
        code: CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
        checkId,
        cause: `${allowlistPath} must declare schemaVersion 1 and an entries array.`,
        location: { file: allowlistPath },
        action: "Regenerate or repair the static misuse allowlist metadata.",
      }),
    ];
  }

  return entries.flatMap((entry, index) =>
    validateSecurityAllowlistEntry(rootDir, allowlistPath, entry, index, checkId),
  );
}

function validateSecurityAllowlistEntry(
  rootDir: string,
  allowlistPath: string,
  entry: unknown,
  index: number,
  checkId: string,
): DoctorDiagnostic[] {
  const entryRecord = asRecord(entry);
  const entryLabel = `entry ${index + 1}`;
  const missingFields = entryRecord
    ? ["package", "file", "excerpt", "reason"].filter(
        (field) => !readOptionalString(entryRecord[field]),
      )
    : ["package", "file", "excerpt", "reason"];
  const line = entryRecord?.line;
  const validLine = typeof line === "number" && Number.isInteger(line) && line >= 1 ? line : null;
  const lineInvalid = validLine === null;
  const owner = readOptionalString(entryRecord?.owner);
  const rawExpiresOn = entryRecord?.expiresOn;
  const expiresOn = readOptionalString(rawExpiresOn);
  const expiresOnTimestamp = expiresOn ? parseDateOnlyUtcTimestamp(expiresOn) : null;
  const expiresOnInvalid = Boolean(
    entryRecord && rawExpiresOn !== undefined && expiresOnTimestamp === null,
  );
  const expiresOnExpired =
    expiresOnTimestamp !== null && expiresOnTimestamp < getTodayUtcDateOnlyTimestamp();
  const metadataMissing = !owner && !expiresOn;
  const failures = [
    ...(missingFields.length > 0 ? [`missing ${missingFields.join(", ")}`] : []),
    ...(lineInvalid ? ["line must be a positive integer"] : []),
    ...(metadataMissing ? ["owner or expiresOn metadata is required"] : []),
    ...(expiresOnInvalid ? ["expiresOn must use YYYY-MM-DD"] : []),
    ...(expiresOnExpired ? ["expiresOn must not be in the past"] : []),
  ];

  const packageName = readRawString(entryRecord?.package);
  const file = readRawString(entryRecord?.file);
  const excerpt = readRawString(entryRecord?.excerpt);
  if (
    failures.length === 0 &&
    packageName &&
    packageName.trim() &&
    file &&
    file.trim() &&
    excerpt &&
    excerpt.trim() &&
    validLine !== null
  ) {
    const relativeFile = toPosixPath(file);
    if (!isProductionPackageSourceFile(relativeFile)) {
      failures.push("file must point at production packages/*/src source");
    }

    const sourcePackageName = readSourcePackageName(rootDir, relativeFile);
    if (sourcePackageName !== packageName) {
      failures.push(`package must match ${sourcePackageName ?? "the source package name"}`);
    }

    const fullPath = join(rootDir, relativeFile);
    if (!existsSync(fullPath)) {
      failures.push("file does not exist");
    } else {
      const sourceLine = readFileSync(fullPath, "utf-8").split(/\r?\n/)[validLine - 1]?.trim();
      if (sourceLine !== excerpt) {
        failures.push("excerpt does not match the current source line");
      }
    }
  }

  if (failures.length === 0) {
    return [];
  }

  return [
    advisoryDiagnostic({
      code: CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
      checkId,
      cause: `${allowlistPath} ${entryLabel} is invalid: ${failures.join("; ")}.`,
      location: {
        file: allowlistPath,
        packageName: packageName ?? undefined,
      },
      action:
        "Add package, file, line, excerpt, reason, and owner or expiresOn metadata, or remove the stale allowlist entry after fixing the misuse.",
    }),
  ];
}

function parseDateOnlyUtcTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? timestamp
    : null;
}

function getTodayUtcDateOnlyTimestamp(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function isProductionPackageSourceFile(relativeFile: string): boolean {
  const normalizedFile = toPosixPath(relativeFile);
  const parts = normalizedFile.split("/");

  return (
    parts[0] === "packages" &&
    parts.length >= 4 &&
    parts[2] === "src" &&
    !parts.includes("tests") &&
    !normalizedFile.endsWith(".spec.js") &&
    !normalizedFile.endsWith(".test.js") &&
    !normalizedFile.endsWith(".spec.jsx") &&
    !normalizedFile.endsWith(".test.jsx") &&
    !normalizedFile.endsWith(".spec.ts") &&
    !normalizedFile.endsWith(".test.ts") &&
    !normalizedFile.endsWith(".spec.tsx") &&
    !normalizedFile.endsWith(".test.tsx")
  );
}

function readSourcePackageName(rootDir: string, relativeFile: string): string | null {
  const parts = toPosixPath(relativeFile).split("/");
  if (parts[0] !== "packages" || !parts[1]) {
    return null;
  }

  const packageJsonPath = join(rootDir, "packages", parts[1], "package.json");
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  const manifest = readJsonObject(packageJsonPath);
  return manifest.kind === "valid" ? readPackageName(manifest.value) : null;
}

function advisoryDiagnostic(input: {
  readonly code: CliDiagnosticCode;
  readonly checkId: string;
  readonly cause: string;
  readonly location: DoctorLocation | null;
  readonly action: string;
}): DoctorDiagnostic {
  return {
    code: input.code,
    severity: "warning",
    checkId: input.checkId,
    cause: input.cause,
    location: input.location,
    action: input.action,
  };
}

function problemRegistryReadinessCheck(rootDir: string): DoctorCheckResult {
  const checkId = "problem-registry-readiness";
  const registryPath = join(rootDir, defaultProblemRegistryPath);
  const cookbookPath = join(rootDir, defaultProblemCookbookPath);
  const rootScripts = readRootScripts(rootDir);
  const expectsProblemRegistry =
    existsSync(registryPath) ||
    existsSync(cookbookPath) ||
    Boolean(rootScripts["problem-registry:check"]) ||
    existsSync(join(rootDir, "packages", "problems-core"));

  if (!expectsProblemRegistry) {
    return {
      id: checkId,
      title: "ProblemRegistry artifact drift gate",
      status: "skipped",
      diagnostics: [],
      note: "No ProblemRegistry artifact or drift-check script was found.",
    };
  }

  const missingArtifacts = [defaultProblemRegistryPath, defaultProblemCookbookPath].filter(
    (artifactPath) => !existsSync(join(rootDir, artifactPath)),
  );
  const missingDiagnostics = missingArtifacts.map((artifactPath) => ({
    code: CLI_DIAGNOSTIC_CODES.doctorProblemRegistryMissing,
    severity: "error" as const,
    checkId,
    cause: `ProblemRegistry artifact ${artifactPath} is missing.`,
    location: { file: artifactPath },
    action: "Run pnpm problem-registry:write, then commit the generated registry artifacts.",
  }));

  if (missingDiagnostics.length > 0) {
    return {
      id: checkId,
      title: "ProblemRegistry artifact drift gate",
      status: "fail",
      diagnostics: missingDiagnostics,
    };
  }

  const registry = readJsonObject(registryPath);
  if (registry.kind === "invalid" || !isProblemCodeRegistryRecord(registry.value)) {
    return {
      id: checkId,
      title: "ProblemRegistry artifact drift gate",
      status: "fail",
      diagnostics: [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorProblemRegistryInvalid,
          severity: "error",
          checkId,
          cause:
            registry.kind === "invalid"
              ? `${defaultProblemRegistryPath} could not be parsed: ${registry.message}`
              : `${defaultProblemRegistryPath} is not a croco.problem-code-registry.v1 artifact.`,
          location: { file: defaultProblemRegistryPath },
          action: "Run pnpm problem-registry:write, then rerun croco doctor.",
        },
      ],
      note: "ProblemRegistry artifact is invalid.",
    };
  }

  const driftDiagnostic = rootScripts["problem-registry:check"]
    ? runProblemRegistryDriftCheck(rootDir, checkId)
    : null;
  if (driftDiagnostic) {
    return {
      id: checkId,
      title: "ProblemRegistry artifact drift gate",
      status: "fail",
      diagnostics: [driftDiagnostic],
      note: "ProblemRegistry drift check failed.",
    };
  }

  return {
    id: checkId,
    title: "ProblemRegistry artifact drift gate",
    status: "pass",
    diagnostics: [],
    note: `ProblemRegistry has ${readNumber(registry.value, "problemCount", 0)} code(s); drift gate script ${rootScripts["problem-registry:check"] ? "passed" : "is not declared"}.`,
  };
}

function runtimeCapabilityManifestCheck(rootDir: string): DoctorCheckResult {
  const checkId = "runtime-capability-manifest";
  const defaultManifestPath = join(rootDir, defaultRuntimeCapabilityManifestPath);
  const legacyManifestPath = join(rootDir, legacyRuntimePolicyManifestPath);
  const manifestPath = existsSync(defaultManifestPath) ? defaultManifestPath : legacyManifestPath;
  const manifestArtifact = existsSync(defaultManifestPath)
    ? defaultRuntimeCapabilityManifestPath
    : legacyRuntimePolicyManifestPath;
  const rootScripts = readRootScripts(rootDir);
  const expectsManifest =
    existsSync(defaultManifestPath) ||
    existsSync(legacyManifestPath) ||
    Boolean(rootScripts["runtime-policy:check"]);

  if (!expectsManifest) {
    return {
      id: checkId,
      title: "RuntimeCapabilityManifest presence",
      status: "skipped",
      diagnostics: [],
      note: "No runtime capability manifest or runtime-policy check script was found.",
    };
  }

  if (!existsSync(manifestPath)) {
    return {
      id: checkId,
      title: "RuntimeCapabilityManifest presence",
      status: "fail",
      diagnostics: [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorRuntimeCapabilityManifestMissing,
          severity: "error",
          checkId,
          cause:
            `${defaultRuntimeCapabilityManifestPath} is required by runtime-policy:check but is missing. ` +
            `${legacyRuntimePolicyManifestPath} is accepted only for compatibility with older generated apps.`,
          location: { file: defaultRuntimeCapabilityManifestPath },
          action:
            "Regenerate the runtime capability manifest or remove the stale runtime-policy check script.",
        },
      ],
    };
  }

  const manifest = readJsonObject(manifestPath);
  if (manifest.kind === "invalid" || !isRuntimeCapabilityManifestRecord(manifest.value)) {
    return {
      id: checkId,
      title: "RuntimeCapabilityManifest presence",
      status: "fail",
      diagnostics: [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorRuntimeCapabilityManifestInvalid,
          severity: "error",
          checkId,
          cause:
            manifest.kind === "invalid"
              ? `${manifestArtifact} could not be parsed: ${manifest.message}`
              : `${manifestArtifact} must declare RuntimeCapabilityManifest v1 or legacy runtime policy fields.`,
          location: { file: manifestArtifact },
          action: "Regenerate croco-runtime-capability.manifest.json and rerun croco doctor.",
        },
      ],
      note: "Runtime capability manifest is invalid.",
    };
  }

  const profileMismatchDiagnostic = runtimeProfileMismatchDiagnostic(
    rootDir,
    manifest.value,
    manifestArtifact,
    checkId,
  );
  if (profileMismatchDiagnostic) {
    return {
      id: checkId,
      title: "Runtime and provider profile consistency",
      status: "fail",
      diagnostics: [profileMismatchDiagnostic],
      note: "Runtime and provider profile artifacts disagree.",
    };
  }

  return {
    id: checkId,
    title: "RuntimeCapabilityManifest presence",
    status: "pass",
    diagnostics: [],
    note: `Runtime target ${readRuntimePlatform(manifest.value)} from ${manifestArtifact}.`,
  };
}

function runtimeProfileMismatchDiagnostic(
  rootDir: string,
  runtimeManifest: Record<string, unknown>,
  runtimeManifestArtifact: string,
  checkId: string,
): DoctorDiagnostic | null {
  const providerManifestPath = join(rootDir, defaultProviderProfileManifestPath);
  if (!existsSync(providerManifestPath)) {
    return null;
  }

  const providerManifest = readJsonObject(providerManifestPath);
  if (providerManifest.kind === "invalid") {
    return null;
  }

  if (!isProviderProfileManifestRecord(providerManifest.value)) {
    return null;
  }

  const providerRuntimeTarget = providerManifest.value.profile.runtimeTarget;
  const runtimePlatform = readRuntimePlatform(runtimeManifest);
  if (providerRuntimeTarget === runtimePlatform) {
    return null;
  }

  return {
    code: CLI_DIAGNOSTIC_CODES.doctorRuntimeProfileMismatch,
    severity: "error",
    checkId,
    cause:
      `Runtime target '${runtimePlatform}' from ${runtimeManifestArtifact} does not match ` +
      `provider runtimeTarget '${providerRuntimeTarget}' from ${defaultProviderProfileManifestPath}.`,
    location: { file: defaultProviderProfileManifestPath },
    action:
      "Regenerate the runtime capability and provider profile artifacts from the same application profile, then rerun croco doctor.",
  };
}

function httpSecurityMiddlewareContractCheck(
  rootDir: string,
  packages: readonly DoctorPackage[],
): DoctorCheckResult {
  const checkId = "http-security-middleware-contract";
  const httpPackages = packages.filter((workspacePackage) =>
    workspacePackage.dependencies.some(
      (dependency) => dependency.name === "@croco/transports-http",
    ),
  );
  const appSourceFiles = httpPackages.flatMap((workspacePackage) =>
    listSourceFiles(workspacePackage.absoluteDir)
      .map((file) => {
        const source = stripTypeScriptComments(readFileSync(file, "utf-8"));
        return {
          file,
          packageName: workspacePackage.name,
          source,
          maskedSource: maskTypeScriptStringLiterals(source),
        };
      })
      .filter(({ maskedSource }) => /\bcreateApp\s*\(/.test(maskedSource)),
  );

  if (appSourceFiles.length === 0) {
    return {
      id: checkId,
      title: "HTTP security middleware contract",
      status: "skipped",
      diagnostics: [],
      note: "No @croco/transports-http createApp source was discovered.",
    };
  }

  const diagnostics = appSourceFiles.flatMap(({ file, packageName, source, maskedSource }) =>
    extractCreateAppOptionSources(source, maskedSource).flatMap((optionsSlice) => {
      const middlewareSource = extractPropertyValueSource(
        optionsSlice.maskedSource,
        "middlewares",
        "[",
        "]",
      );
      const disabledDiagnostics =
        /securityValidation\s*:\s*["']off["']/.test(optionsSlice.source) ||
        /unsafeSkipSecurityValidation\s*:\s*true/.test(optionsSlice.source)
          ? [
              {
                code: CLI_DIAGNOSTIC_CODES.doctorHttpSecurityValidationDisabled,
                severity: "error" as const,
                checkId,
                cause: "The HTTP app disables security middleware validation.",
                location: {
                  file: toPosixPath(relative(rootDir, file)),
                  packageName,
                },
                action:
                  "Remove the securityValidation escape hatch and configure Croco security headers, CORS, body limit, and rate-limit middleware.",
              },
            ]
          : [];
      const missingMiddlewares = requiredHttpSecurityMiddleware.filter(
        (middlewareName) =>
          middlewareSource === null ||
          !hasRequiredHttpMiddlewareCall(middlewareName, middlewareSource, maskedSource),
      );
      const missingMiddlewareDiagnostics =
        missingMiddlewares.length > 0
          ? [
              {
                code: CLI_DIAGNOSTIC_CODES.doctorHttpSecurityMiddlewareMissing,
                severity: "error" as const,
                checkId,
                cause: `The HTTP app is missing required middleware: ${missingMiddlewares.join(", ")}.`,
                location: {
                  file: toPosixPath(relative(rootDir, file)),
                  packageName,
                },
                action:
                  "Add the missing middleware to createApp({ middlewares: [...] }) before deployment.",
              },
            ]
          : [];

      return [...disabledDiagnostics, ...missingMiddlewareDiagnostics];
    }),
  );

  return {
    id: checkId,
    title: "HTTP security middleware contract",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} HTTP security contract issue(s) found.`
        : `${appSourceFiles.length} HTTP app factory file(s) include the required security middleware.`,
  };
}

function diGraphBootstrapCheck(rootDir: string): DoctorCheckResult {
  const checkId = "di-graph-bootstrap";
  const manifestPath = join(rootDir, defaultDiGraphManifestPath);

  if (!existsSync(manifestPath)) {
    return {
      id: checkId,
      title: "DI graph bootstrap errors",
      status: "skipped",
      diagnostics: [],
      note: `${defaultDiGraphManifestPath} was not found.`,
    };
  }

  const manifest = readJsonObject(manifestPath);
  if (manifest.kind === "invalid" || !isRecord(manifest.value)) {
    return {
      id: checkId,
      title: "DI graph bootstrap errors",
      status: "fail",
      diagnostics: [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorDiGraphManifestInvalid,
          severity: "error",
          checkId,
          cause:
            manifest.kind === "invalid"
              ? `${defaultDiGraphManifestPath} could not be parsed: ${manifest.message}`
              : `${defaultDiGraphManifestPath} must be a JSON object.`,
          location: { file: defaultDiGraphManifestPath },
          action: "Regenerate the DI graph manifest and rerun croco doctor.",
        },
      ],
    };
  }

  const manifestDiagnostics = readDiagnosticRecords(manifest.value.diagnostics);
  const manifestErrors = manifestDiagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  const failedWithoutDiagnostics =
    manifest.value.status === "failed" && manifestDiagnostics.length === 0;
  const diagnostics = [
    ...manifestErrors.map((diagnostic) => ({
      code: CLI_DIAGNOSTIC_CODES.doctorDiBootstrapErrors,
      severity: "error" as const,
      checkId,
      cause: `DI graph reports ${diagnostic.code}: ${diagnostic.message}`,
      location: { file: defaultDiGraphManifestPath },
      action:
        "Register the missing provider, fix the DI cycle/scope mismatch, then regenerate the DI graph manifest.",
    })),
    ...(failedWithoutDiagnostics
      ? [
          {
            code: CLI_DIAGNOSTIC_CODES.doctorDiBootstrapErrors,
            severity: "error" as const,
            checkId,
            cause: "DI graph manifest status is failed but it does not include diagnostics.",
            location: { file: defaultDiGraphManifestPath },
            action: "Regenerate the DI graph manifest so bootstrap diagnostics are inspectable.",
          },
        ]
      : []),
  ];

  return {
    id: checkId,
    title: "DI graph bootstrap errors",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} DI bootstrap error(s) found.`
        : `${manifestDiagnostics.length} DI diagnostic(s) recorded with no errors.`,
  };
}

function providerCertificationCheck(
  rootDir: string,
  packages: readonly DoctorPackage[],
): DoctorCheckResult {
  const checkId = "provider-certification";
  const manifestPath = join(rootDir, defaultProviderProfileManifestPath);

  if (!existsSync(manifestPath)) {
    return {
      id: checkId,
      title: "Provider certification gaps",
      status: "skipped",
      diagnostics: [],
      note: `${defaultProviderProfileManifestPath} was not found.`,
    };
  }

  const manifest = readJsonObject(manifestPath);
  if (manifest.kind === "invalid") {
    return {
      id: checkId,
      title: "Provider certification gaps",
      status: "fail",
      diagnostics: [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorProviderProfileInvalid,
          severity: "error",
          checkId,
          cause: `${defaultProviderProfileManifestPath} could not be parsed: ${manifest.message}`,
          location: { file: defaultProviderProfileManifestPath },
          action: "Regenerate the provider profile artifacts and rerun croco doctor.",
        },
      ],
    };
  }

  const providerManifestVersion = readOptionalString(manifest.value.schemaVersion);
  if (
    providerManifestVersion !== null &&
    !isProviderProfileManifestVersionSupported(providerManifestVersion)
  ) {
    return {
      id: checkId,
      title: "Provider certification gaps",
      status: "fail",
      diagnostics: [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorProviderProfileVersionUnsupported,
          severity: "error",
          checkId,
          cause: `${defaultProviderProfileManifestPath} uses unsupported schemaVersion '${providerManifestVersion}'. Supported versions: ${providerProfileManifestSchemaVersion}.`,
          location: { file: defaultProviderProfileManifestPath },
          action:
            "Regenerate the provider profile artifacts with a supported schemaVersion or apply the provider profile migration guidance.",
        },
      ],
    };
  }

  if (!isProviderProfileManifestRecord(manifest.value)) {
    return {
      id: checkId,
      title: "Provider certification gaps",
      status: "fail",
      diagnostics: [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorProviderProfileInvalid,
          severity: "error",
          checkId,
          cause: `${defaultProviderProfileManifestPath} is not a ${providerProfileManifestSchemaVersion} artifact.`,
          location: { file: defaultProviderProfileManifestPath },
          action: "Regenerate the provider profile artifacts and rerun croco doctor.",
        },
      ],
    };
  }

  const declaredPackages = new Set(
    collectDeclaredDependencies(rootDir, packages).map((dependency) => dependency.name),
  );
  const requiredPackages = [...readStringArray(manifest.value.packages)].sort(compareStrings);
  const missingPackages = requiredPackages.filter(
    (packageName) => !declaredPackages.has(packageName),
  );
  const capabilities = readCapabilityRecords(manifest.value.capabilities);
  const capabilityNames = new Set(capabilities.map((capability) => capability.capability));
  const missingCapabilities = requiredSaasProviderCapabilities.filter(
    (capability) => !capabilityNames.has(capability),
  );
  const documentedCapabilities = capabilities.filter(
    (capability) => capability.status === "documented",
  );

  const diagnostics: DoctorDiagnostic[] = [
    ...missingPackages.map((packageName) => ({
      code: CLI_DIAGNOSTIC_CODES.doctorProviderPackageMissing,
      severity: "error" as const,
      checkId,
      cause: `Provider profile requires ${packageName}, but no package manifest declares it.`,
      location: { file: defaultProviderProfileManifestPath, packageName },
      action: "Add the required provider package dependency or regenerate the provider profile.",
    })),
    ...missingCapabilities.map((capability) => ({
      code: CLI_DIAGNOSTIC_CODES.doctorProviderCertificationGap,
      severity: "error" as const,
      checkId,
      cause: `Provider profile is missing required capability '${capability}'.`,
      location: { file: defaultProviderProfileManifestPath },
      action: "Regenerate the provider profile from a certified profile definition.",
    })),
    ...documentedCapabilities.map((capability) => ({
      code: CLI_DIAGNOSTIC_CODES.doctorProviderCertificationDocumented,
      severity: "warning" as const,
      checkId,
      cause: `Provider capability '${capability.capability}' is documented for ${capability.provider}, not zero-credential configured.`,
      location: { file: defaultProviderProfileManifestPath },
      action:
        "Run the documented real-provider smoke only after provider credentials are configured.",
    })),
    ...providerProfileTenantModelDiagnostics(rootDir, manifest.value, checkId),
  ];
  const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");

  return {
    id: checkId,
    title: "Provider certification gaps",
    status: hasErrors ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} provider certification diagnostic(s) found.`
        : `${capabilities.length} provider capability declaration(s) are complete.`,
  };
}

function repositoryCoreBoundaryCheck(rootDir: string): DoctorCheckResult {
  const checkId = "repository-core-boundary";
  const sourceDir = join(rootDir, "packages", "repository-core", "src");

  if (!existsSync(sourceDir)) {
    return {
      id: checkId,
      title: "repository-core dependency boundary",
      status: "skipped",
      diagnostics: [],
      note: "packages/repository-core/src was not found.",
    };
  }

  const diagnostics = listSourceFiles(sourceDir).flatMap((file) =>
    findForbiddenLines(file, /drizzle/i).map((line) => ({
      code: CLI_DIAGNOSTIC_CODES.doctorRepositoryCoreDrizzleBoundary,
      legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorRepositoryCoreDrizzleBoundary,
      severity: "error" as const,
      checkId,
      cause:
        "@croco/repository-core is an interface layer but references Drizzle implementation details.",
      location: {
        file: toPosixPath(relative(rootDir, file)),
        line: line.line,
        packageName: "@croco/repository-core",
      },
      action:
        "Move Drizzle-specific types and implementation code to @croco/tx-drizzle or another Drizzle adapter package.",
    })),
  );

  return {
    id: checkId,
    title: "repository-core dependency boundary",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} boundary violation(s) found.`
        : "No Drizzle references found in packages/repository-core/src.",
  };
}

function lambdaTelemetryFlushCheck(
  rootDir: string,
  packages: readonly DoctorPackage[],
): DoctorCheckResult {
  const checkId = "lambda-telemetry-flush";
  const diagnostics = packages.flatMap((workspacePackage) =>
    listSourceFiles(workspacePackage.absoluteDir).flatMap((file) => {
      const source = readFileSync(file, "utf-8");
      const sourceWithoutComments = stripTypeScriptComments(source);

      if (
        !isLambdaTelemetryEntrypoint(file, sourceWithoutComments) ||
        hasHandlerForceFlush(sourceWithoutComments)
      ) {
        return [];
      }

      const line = findFirstMatchingLine(sourceWithoutComments, /TelemetryRuntime|lambdaPreset/);

      return [
        {
          code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
          legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
          severity: "error" as const,
          checkId,
          cause:
            "A Lambda entrypoint initializes @croco/telemetry-sdk-node but does not flush telemetry before the invocation returns.",
          location: {
            file: toPosixPath(relative(rootDir, file)),
            line,
            packageName: workspacePackage.name,
          },
          action:
            "Await telemetry readiness before handler work and call telemetry.forceFlush() in a finally block before returning.",
        },
      ];
    }),
  );

  return {
    id: checkId,
    title: "Lambda telemetry flush boundary",
    status: diagnostics.length > 0 ? "fail" : "pass",
    diagnostics,
    note:
      diagnostics.length > 0
        ? `${diagnostics.length} Lambda telemetry entrypoint(s) missing forceFlush().`
        : "No Lambda telemetry entrypoints are missing forceFlush().",
  };
}

function findWorkspaceRoot(cwd: string): string | null {
  let current = cwd;
  for (let depth = 0; depth < WORKSPACE_MAX_DEPTH; depth += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

function readWorkspacePackages(rootDir: string): WorkspaceDiscoveryResult {
  const workspacePath = join(rootDir, "pnpm-workspace.yaml");
  const patterns = parseWorkspacePackagePatterns(readFileSync(workspacePath, "utf-8"));
  const packageJsonFiles = readWorkspacePackageJsonFiles(rootDir, patterns);
  const packageResults = packageJsonFiles
    .sort()
    .map((packageJsonPath) => readPackage(rootDir, packageJsonPath));

  return {
    packages: packageResults.flatMap((result) => (result.kind === "valid" ? [result.package] : [])),
    patterns,
    diagnostics: packageResults.flatMap((result) =>
      result.kind === "invalid" ? [result.diagnostic] : [],
    ),
  };
}

function parseWorkspacePackagePatterns(source: string): WorkspacePattern[] {
  const inlinePatterns = parseInlineWorkspacePackagePatterns(source);
  if (inlinePatterns.length > 0) {
    return inlinePatterns;
  }

  const patterns: WorkspacePattern[] = [];
  let inPackagesSection = false;

  for (const line of source.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackagesSection = true;
      continue;
    }

    if (inPackagesSection && /^[^\s#][^:]*:/.test(line)) {
      break;
    }

    if (!inPackagesSection) {
      continue;
    }

    const match = line.match(/^\s*-\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }

    const pattern = normalizeWorkspacePattern(match[1]);
    if (pattern) {
      patterns.push(pattern);
    }
  }

  return patterns;
}

function parseInlineWorkspacePackagePatterns(source: string): WorkspacePattern[] {
  const match = source.match(/^packages:\s*\[(.*)\]\s*$/m);
  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((item) => normalizeWorkspacePattern(item))
    .filter((pattern): pattern is WorkspacePattern => pattern !== null);
}

function normalizeWorkspacePattern(value: string): WorkspacePattern | null {
  const commentIndex = value.indexOf(" #");
  const withoutComment = commentIndex === -1 ? value : value.slice(0, commentIndex);
  const rawPattern = withoutComment.trim().replace(/^['"]|['"]$/g, "");
  const excluded = rawPattern.startsWith("!");
  const pattern = excluded ? rawPattern.slice(1) : rawPattern;

  if (!pattern) {
    return null;
  }

  return {
    pattern: toPosixPath(pattern).replace(/\/+$/, ""),
    excluded,
  };
}

function readWorkspacePackageJsonFiles(
  rootDir: string,
  patterns: readonly WorkspacePattern[],
): string[] {
  if (patterns.length === 0) {
    return findPackageJsonFiles(join(rootDir, "packages"));
  }

  const packageJsonFiles = findPackageJsonFiles(rootDir);
  const includePatterns = patterns.filter((pattern) => !pattern.excluded);
  const excludePatterns = patterns.filter((pattern) => pattern.excluded);

  return packageJsonFiles.filter((packageJsonPath) => {
    const relativeDir = toPosixPath(relative(rootDir, dirname(packageJsonPath)));
    return (
      includePatterns.some((pattern) => matchesWorkspacePattern(relativeDir, pattern.pattern)) &&
      !excludePatterns.some((pattern) => matchesWorkspacePattern(relativeDir, pattern.pattern))
    );
  });
}

function findPackageJsonFiles(dir: string, results: string[] = []): string[] {
  if (!existsSync(dir)) {
    return results;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      findPackageJsonFiles(fullPath, results);
      continue;
    }

    if (entry.isFile() && entry.name === "package.json") {
      results.push(fullPath);
    }
  }

  return results;
}

function listSourceFiles(dir: string, results: string[] = []): string[] {
  if (!existsSync(dir)) {
    return results;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      listSourceFiles(fullPath, results);
      continue;
    }

    if (entry.isFile() && isDoctorSourceFile(entry.name)) {
      results.push(fullPath);
    }
  }

  return results;
}

function isDoctorSourceFile(fileName: string): boolean {
  if (fileName.endsWith(".d.ts")) {
    return false;
  }

  return sourceFileExtensions.some((extension) => fileName.endsWith(extension));
}

function findForbiddenLines(
  file: string,
  forbiddenPattern: RegExp,
): Array<{ readonly line: number }> {
  return readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .flatMap((line, index) => (forbiddenPattern.test(line) ? [{ line: index + 1 }] : []));
}

function isLambdaTelemetryEntrypoint(file: string, source: string): boolean {
  const normalizedFile = toPosixPath(file);
  const usesTelemetryRuntime = /TelemetryRuntime/.test(source);
  const looksLikeHandler =
    /startServerAndCreateLambdaHandler/.test(source) ||
    /export\s+(const|async function)\s+handler\b/.test(source) ||
    /AWS_LAMBDA_FUNCTION_NAME/.test(source) ||
    normalizedFile.endsWith("/handler.ts") ||
    normalizedFile.endsWith("/handler.ts.hbs");

  return usesTelemetryRuntime && looksLikeHandler;
}

function hasHandlerForceFlush(source: string): boolean {
  const handlerSource = extractExportedHandlerSource(source);
  const sourceToCheck = handlerSource ?? source;

  return /\.forceFlush\s*\(/.test(sourceToCheck) || hasCrocoLambdaFlush(source);
}

function hasRequiredHttpMiddlewareCall(
  middlewareName: string,
  middlewareSource: string,
  fileSource: string,
): boolean {
  if (new RegExp(`\\b${escapeRegExp(middlewareName)}\\s*\\(`).test(middlewareSource)) {
    return true;
  }

  return extractFunctionCallNames(middlewareSource).some((functionName) => {
    const functionBody = extractNamedFunctionBody(fileSource, functionName);
    return Boolean(
      functionBody && new RegExp(`\\b${escapeRegExp(middlewareName)}\\s*\\(`).test(functionBody),
    );
  });
}

function extractFunctionCallNames(source: string): string[] {
  const names: string[] = [];
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match = pattern.exec(source);

  while (match !== null) {
    names.push(match[1]);
    match = pattern.exec(source);
  }

  return uniqueStrings(names);
}

function extractNamedFunctionBody(source: string, functionName: string): string | null {
  const pattern = new RegExp(`\\bfunction\\s+${escapeRegExp(functionName)}\\s*\\(`, "g");
  let match = pattern.exec(source);

  while (match !== null) {
    const bodyStart = source.indexOf("{", match.index);
    if (bodyStart === -1) {
      match = pattern.exec(source);
      continue;
    }

    const bodyEnd = findBalancedDelimitedEnd(source, bodyStart, "{", "}");
    return bodyEnd === null ? source.slice(bodyStart) : source.slice(bodyStart, bodyEnd + 1);
  }

  return null;
}

function extractCreateAppOptionSources(
  source: string,
  maskedSource: string = source,
): SourceSlice[] {
  const optionSources: SourceSlice[] = [];
  const createAppPattern = /\bcreateApp\s*\(/g;
  let match = createAppPattern.exec(maskedSource);

  while (match !== null) {
    const callStart = maskedSource.indexOf("(", match.index);
    const callEnd = findBalancedDelimitedEnd(maskedSource, callStart, "(", ")");
    if (callEnd === null) {
      match = createAppPattern.exec(maskedSource);
      continue;
    }

    const callArguments = source.slice(callStart + 1, callEnd);
    const maskedCallArguments = maskedSource.slice(callStart + 1, callEnd);
    const objectStart = maskedCallArguments.indexOf("{");
    if (objectStart === -1) {
      optionSources.push({ source: "", maskedSource: "" });
      match = createAppPattern.exec(maskedSource);
      continue;
    }

    const objectEnd = findBalancedDelimitedEnd(maskedCallArguments, objectStart, "{", "}");
    if (objectEnd === null) {
      optionSources.push({
        source: callArguments.slice(objectStart),
        maskedSource: maskedCallArguments.slice(objectStart),
      });
      match = createAppPattern.exec(maskedSource);
      continue;
    }

    optionSources.push({
      source: callArguments.slice(objectStart, objectEnd + 1),
      maskedSource: maskedCallArguments.slice(objectStart, objectEnd + 1),
    });
    match = createAppPattern.exec(maskedSource);
  }

  return optionSources;
}

function extractPropertyValueSource(
  source: string,
  propertyName: string,
  openDelimiter: string,
  closeDelimiter: string,
): string | null {
  const propertyMatch = new RegExp(`\\b${propertyName}\\s*:`).exec(source);
  if (!propertyMatch || propertyMatch.index === undefined) {
    return null;
  }

  const valueStart = skipWhitespace(source, propertyMatch.index + propertyMatch[0].length);
  if (source[valueStart] !== openDelimiter) {
    return null;
  }

  const valueEnd = findBalancedDelimitedEnd(source, valueStart, openDelimiter, closeDelimiter);
  return valueEnd === null ? null : source.slice(valueStart, valueEnd + 1);
}

function skipWhitespace(source: string, startIndex: number): number {
  let index = startIndex;
  while (index < source.length && /\s/.test(source[index])) {
    index += 1;
  }

  return index;
}

function extractExportedHandlerSource(source: string): string | null {
  const handlerMatch = source.match(/export\s+(?:const|async function)\s+handler\b/);
  if (!handlerMatch || handlerMatch.index === undefined) {
    return null;
  }

  const bodyStart = source.indexOf("{", handlerMatch.index);
  if (bodyStart === -1) {
    const statementEnd = source.indexOf(";", handlerMatch.index);
    return statementEnd === -1
      ? source.slice(handlerMatch.index)
      : source.slice(handlerMatch.index, statementEnd + 1);
  }

  const bodyEnd = findBalancedBlockEnd(source, bodyStart);
  return bodyEnd === null
    ? source.slice(handlerMatch.index)
    : source.slice(handlerMatch.index, bodyEnd + 1);
}

function findBalancedBlockEnd(source: string, startIndex: number): number | null {
  return findBalancedDelimitedEnd(source, startIndex, "{", "}");
}

function findBalancedDelimitedEnd(
  source: string,
  startIndex: number,
  openDelimiter: string,
  closeDelimiter: string,
): number | null {
  let depth = 0;
  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === openDelimiter) {
      depth += 1;
      continue;
    }

    if (character === closeDelimiter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return null;
}

function stripTypeScriptComments(source: string): string {
  let result = "";
  let quote: '"' | "'" | "`" | null = null;
  let isEscaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const nextChar = source[index + 1];

    if (quote !== null) {
      result += char;

      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      result += char;
      continue;
    }

    if (char === "/" && nextChar === "/") {
      result += " ";
      index += 2;

      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        index += 1;
      }

      index -= 1;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      result += " ";
      index += 2;

      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n" || source[index] === "\r") {
          result += source[index];
        }

        index += 1;
      }

      index += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function maskTypeScriptStringLiterals(source: string): string {
  let masked = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaping = false;

  for (const character of source) {
    if (quote === null) {
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        masked += character;
        continue;
      }

      masked += character;
      continue;
    }

    if (escaping) {
      escaping = false;
      masked += " ";
      continue;
    }

    if (character === "\\") {
      escaping = true;
      masked += " ";
      continue;
    }

    if (character === quote) {
      quote = null;
      masked += character;
      continue;
    }

    masked += character === "\n" || character === "\r" ? character : " ";
  }

  return masked;
}

function findFirstMatchingLine(source: string, pattern: RegExp): number {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      return index + 1;
    }
  }
  return 1;
}

function readPackage(rootDir: string, packageJsonPath: string): WorkspacePackageReadResult {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.name !== "string") {
      return invalidPackageDiagnostic(
        rootDir,
        packageJsonPath,
        "package.json is missing a string name field.",
      );
    }

    const absoluteDir = dirname(packageJsonPath);

    return {
      kind: "valid",
      package: {
        name: parsed.name,
        version: typeof parsed.version === "string" ? parsed.version : null,
        private: parsed.private === true,
        absoluteDir,
        relativeDir: toPosixPath(relative(rootDir, absoluteDir)),
        dependencies: readPackageDependencies(parsed, absoluteDir, parsed.name),
      },
    };
  } catch (error) {
    return invalidPackageDiagnostic(
      rootDir,
      packageJsonPath,
      `package.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function invalidPackageDiagnostic(
  rootDir: string,
  packageJsonPath: string,
  cause: string,
): WorkspacePackageReadResult {
  return {
    kind: "invalid",
    diagnostic: {
      code: CLI_DIAGNOSTIC_CODES.doctorWorkspacePackageInvalid,
      legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorWorkspacePackageInvalid,
      severity: "error",
      checkId: "workspace-discovery",
      cause,
      location: { file: toPosixPath(relative(rootDir, packageJsonPath)) },
      action: "Fix the package.json so it contains valid JSON and a string package name.",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readPackageDependencies(
  manifest: Record<string, unknown>,
  importerDir: string,
  importerName: string,
): DoctorPackageDependency[] {
  return packageDependencyFields.flatMap((field) => {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) {
      return [];
    }

    return Object.entries(dependencies).flatMap(([name, range]) =>
      typeof range === "string" ? [{ name, range, field, importerDir, importerName }] : [],
    );
  });
}

function collectDeclaredDependencies(
  rootDir: string,
  packages: readonly DoctorPackage[],
): DoctorPackageDependency[] {
  const rootPackage = readJsonObject(join(rootDir, "package.json"));
  const rootDependencies =
    rootPackage.kind === "valid" && isRecord(rootPackage.value)
      ? readPackageDependencies(rootPackage.value, rootDir, readPackageName(rootPackage.value))
      : [];

  return [
    ...rootDependencies,
    ...packages.flatMap((workspacePackage) => workspacePackage.dependencies),
  ];
}

function readPackageName(manifest: Record<string, unknown>): string {
  return typeof manifest.name === "string" ? manifest.name : "<workspace-root>";
}

function findInstalledPackage(
  dependency: DoctorPackageDependency,
  rootDir: string,
): { readonly packageDir: string; readonly packageJsonPath: string } | null {
  for (const baseDir of uniqueStrings([dependency.importerDir, rootDir])) {
    const packageDir = join(baseDir, "node_modules", ...dependency.name.split("/"));
    const packageJsonPath = join(packageDir, "package.json");

    if (existsSync(packageJsonPath)) {
      return { packageDir, packageJsonPath };
    }
  }

  return null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function uniqueDependencyByName(
  dependency: DoctorPackageDependency,
  index: number,
  dependencies: readonly DoctorPackageDependency[],
): boolean {
  return dependencies.findIndex((candidate) => candidate.name === dependency.name) === index;
}

function isWorkspaceConsistentRange(
  dependency: DoctorPackageDependency,
  workspacePackages: ReadonlyMap<string, DoctorPackage>,
): boolean {
  if (dependency.range.startsWith("workspace:")) {
    return true;
  }

  const workspacePackage = workspacePackages.get(dependency.name);
  return Boolean(workspacePackage?.version && dependency.range === workspacePackage.version);
}

function readPackageBuildTargets(manifest: Record<string, unknown>): string[] {
  const publishConfig = isRecord(manifest.publishConfig) ? manifest.publishConfig : {};
  return uniqueStrings([
    ...readManifestBuildTargets(manifest),
    ...readManifestBuildTargets(publishConfig),
  ]);
}

function readManifestBuildTargets(manifest: Record<string, unknown>): string[] {
  return [
    readOptionalString(manifest.main),
    readOptionalString(manifest.module),
    readOptionalString(manifest.types),
    ...readExportTargets(manifest.exports),
  ].filter((target): target is string => target !== null);
}

function readExportTargets(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(readExportTargets);
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.values(value).flatMap(readExportTargets);
}

function runProblemRegistryDriftCheck(rootDir: string, checkId: string): DoctorDiagnostic | null {
  const command = resolvePackageManagerCommand();
  const result = spawnSync(command.command, command.args, {
    cwd: rootDir,
    encoding: "utf-8",
    env: getCrocoCommandRuntime().env,
    timeout: problemRegistryCheckTimeoutMs,
  });
  const commandText = [command.command, ...command.args].join(" ");

  if (result.error) {
    const errorCode = readNodeErrorCode(result.error);
    const timedOut = errorCode === "ETIMEDOUT";
    return {
      code: timedOut
        ? CLI_DIAGNOSTIC_CODES.doctorProblemRegistryCheckTimeout
        : CLI_DIAGNOSTIC_CODES.doctorProblemRegistryCheckFailed,
      severity: "error",
      checkId,
      cause: `${commandText} could not complete: ${result.error.message}`,
      location: { file: "package.json" },
      action: timedOut
        ? "Run pnpm problem-registry:check manually, fix the timeout, then rerun croco doctor."
        : "Ensure pnpm is available, run pnpm problem-registry:check manually, then rerun croco doctor.",
    };
  }

  if (result.status !== 0) {
    const output = formatCommandOutput(result.stdout, result.stderr);
    const status =
      result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
    return {
      code: CLI_DIAGNOSTIC_CODES.doctorProblemRegistryDrift,
      severity: "error",
      checkId,
      cause: `${commandText} failed with ${status}${output ? `: ${output}` : "."}`,
      location: { file: defaultProblemRegistryPath },
      action:
        "Run pnpm problem-registry:write, commit the generated artifacts, then rerun croco doctor.",
    };
  }

  return null;
}

function resolvePackageManagerCommand(): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const npmExecPath = getCrocoCommandRuntime().env.npm_execpath;
  if (npmExecPath?.includes("pnpm")) {
    return {
      command: process.execPath,
      args: [npmExecPath, "run", "problem-registry:check"],
    };
  }

  return {
    command: "pnpm",
    args: ["run", "problem-registry:check"],
  };
}

function readNodeErrorCode(error: Error): string | null {
  const nodeError = error as Error & { readonly code?: unknown };
  return typeof nodeError.code === "string" ? nodeError.code : null;
}

function formatCommandOutput(stdout: string | null, stderr: string | null): string {
  const output = [stdout, stderr]
    .filter((chunk): chunk is string => Boolean(chunk))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

  return output.length > commandOutputMaxLength
    ? `${output.slice(0, commandOutputMaxLength)}...`
    : output;
}

function readRootScripts(rootDir: string): Record<string, string> {
  return readPackageScriptsAt(join(rootDir, "package.json"));
}

function readPackageScriptsAt(packageJsonPath: string): Record<string, string> {
  const rootPackage = readJsonObject(packageJsonPath);
  if (rootPackage.kind === "invalid" || !isRecord(rootPackage.value)) {
    return {};
  }

  const scripts = rootPackage.value.scripts;
  if (!isRecord(scripts)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function hasAnyScript(
  scripts: Readonly<Record<string, string>>,
  scriptNames: readonly string[],
): boolean {
  return scriptNames.some((scriptName) => Boolean(scripts[scriptName]));
}

function readJsonObject(
  path: string,
):
  | { readonly kind: "valid"; readonly value: Record<string, unknown> }
  | { readonly kind: "invalid"; readonly message: string } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed)) {
      return { kind: "invalid", message: "JSON value must be an object." };
    }

    return { kind: "valid", value: parsed };
  } catch (error) {
    return {
      kind: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function isContractGraphSnapshotRecord(value: Record<string, unknown>): boolean {
  return (
    value.snapshotVersion === "croco.contract-graph.snapshot.v1" &&
    value.graphVersion === "croco.contract-graph.v1" &&
    Array.isArray(value.controllers) &&
    Array.isArray(value.routes) &&
    Array.isArray(value.diagnostics)
  );
}

function isProblemCodeRegistryRecord(value: Record<string, unknown>): boolean {
  if (value.version !== "croco.problem-code-registry.v1" || !Array.isArray(value.problems)) {
    return false;
  }

  return typeof value.problemCount !== "number" || value.problemCount === value.problems.length;
}

function isRuntimeCapabilityManifestRecord(value: Record<string, unknown>): boolean {
  if (value.version === "croco.runtime-capability.manifest.v1") {
    return (
      typeof value.platform === "string" &&
      hasRuntimeCapabilitiesAndComposition(value) &&
      Array.isArray(value.diagnostics)
    );
  }

  const runtime = isRecord(value.runtime) ? value.runtime : null;
  const table = isRecord(value.table) ? value.table : null;

  return (
    (value.schemaVersion === "croco.runtime-policy/v1" ||
      value.version === "croco.runtime-policy/v1") &&
    typeof runtime?.platform === "string" &&
    Array.isArray(table?.plans)
  );
}

function readRuntimePlatform(value: Record<string, unknown>): string {
  if (typeof value.platform === "string") {
    return value.platform;
  }

  const runtime = isRecord(value.runtime) ? value.runtime : null;
  return readOptionalString(runtime?.platform) ?? "unknown";
}

function providerProfileTenantModelDiagnostics(
  rootDir: string,
  manifest: Record<string, unknown>,
  checkId: string,
): DoctorDiagnostic[] {
  const tenantModel = asRecord(manifest.tenantModel);
  if (tenantModel === null) {
    return [];
  }

  const linkedManifest = readOptionalString(tenantModel.manifest);
  if (linkedManifest === null) {
    return [];
  }

  const location = { file: linkedManifest };
  const tenantManifestPath = join(rootDir, linkedManifest);
  if (!existsSync(tenantManifestPath)) {
    return [
      {
        code: CLI_DIAGNOSTIC_CODES.doctorTenantModelManifestInvalid,
        severity: "error",
        checkId,
        cause: `Provider profile links ${linkedManifest}, but the tenant model manifest was not found.`,
        location,
        action: `Regenerate ${defaultTenantModelManifestPath} and provider profile artifacts so tenant metadata is in sync.`,
      },
    ];
  }

  const tenantManifest = readJsonObject(tenantManifestPath);
  if (tenantManifest.kind === "invalid") {
    return [
      {
        code: CLI_DIAGNOSTIC_CODES.doctorTenantModelManifestInvalid,
        severity: "error",
        checkId,
        cause: `${linkedManifest} could not be parsed: ${tenantManifest.message}`,
        location,
        action: "Regenerate tenant model artifacts and rerun croco doctor.",
      },
    ];
  }

  const tenantManifestVersion = readOptionalString(tenantManifest.value.schemaVersion);
  if (
    tenantManifestVersion !== null &&
    !isTenantModelManifestVersionSupported(tenantManifestVersion)
  ) {
    return [
      {
        code: CLI_DIAGNOSTIC_CODES.doctorTenantModelVersionUnsupported,
        severity: "error",
        checkId,
        cause: `${linkedManifest} uses unsupported schemaVersion '${tenantManifestVersion}'. Supported versions: ${tenantModelManifestSchemaVersion}.`,
        location,
        action:
          "Regenerate tenant model artifacts with a supported schemaVersion or apply the tenant model migration guidance.",
      },
    ];
  }

  if (!isTenantModelManifestRecord(tenantManifest.value)) {
    return [
      {
        code: CLI_DIAGNOSTIC_CODES.doctorTenantModelManifestInvalid,
        severity: "error",
        checkId,
        cause: `${linkedManifest} is not a ${tenantModelManifestSchemaVersion} artifact.`,
        location,
        action: "Regenerate tenant model artifacts and rerun croco doctor.",
      },
    ];
  }

  return [];
}

function isProviderProfileManifestVersionSupported(version: string): boolean {
  return version === providerProfileManifestSchemaVersion;
}

function isTenantModelManifestVersionSupported(version: string): boolean {
  return version === tenantModelManifestSchemaVersion;
}

function isProviderProfileManifestRecord(
  value: Record<string, unknown>,
): value is ProviderProfileManifestRecord {
  const profile = asRecord(value.profile);

  return (
    value.schemaVersion === providerProfileManifestSchemaVersion &&
    profile !== null &&
    typeof profile["name"] === "string" &&
    typeof profile["runtimeTarget"] === "string" &&
    isKnownRuntimePlatform(profile["runtimeTarget"]) &&
    Array.isArray(value.packages) &&
    Array.isArray(value.capabilities)
  );
}

function isTenantModelManifestRecord(value: Record<string, unknown>): boolean {
  const selected = asRecord(value.selected);

  return (
    value.schemaVersion === tenantModelManifestSchemaVersion &&
    typeof value.currentModel === "string" &&
    typeof value.defaultModel === "string" &&
    selected !== null &&
    typeof selected.name === "string" &&
    Array.isArray(value.models) &&
    isRecord(value.schema) &&
    isRecord(value.migration)
  );
}

function readDiagnosticRecords(value: unknown): Array<{
  readonly code: string;
  readonly severity: DoctorSeverity;
  readonly message: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        code: readOptionalString(entry.code) ?? "unknown",
        severity: entry.severity === "warning" ? "warning" : "error",
        message: readOptionalString(entry.message) ?? "No diagnostic message was provided.",
      },
    ];
  });
}

function readCapabilityRecords(value: unknown): Array<{
  readonly capability: string;
  readonly provider: string;
  readonly status: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const capability = readOptionalString(entry.capability);
    const provider = readOptionalString(entry.provider);
    const status = readOptionalString(entry.status);

    return capability && provider && status ? [{ capability, provider, status }] : [];
  });
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readNumber(value: Record<string, unknown>, key: string, fallback: number): number {
  const result = value[key];
  return typeof result === "number" ? result : fallback;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBenchmarkContractString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRawString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toPackageSlug(packageName: string): string {
  return packageName.startsWith("@croco/") ? packageName.slice("@croco/".length) : packageName;
}

function formatLocation(location: DoctorLocation | null): string {
  if (!location) {
    return "unknown";
  }

  const line = typeof location.line === "number" ? `:${location.line}` : "";
  const packageName = location.packageName ? ` (${location.packageName})` : "";
  return `${location.file ?? "unknown"}${line}${packageName}`;
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesWorkspacePattern(relativeDir: string, pattern: string): boolean {
  return matchGlobSegments(toPosixPath(relativeDir).split("/"), toPosixPath(pattern).split("/"));
}

function matchGlobSegments(
  pathSegments: readonly string[],
  patternSegments: readonly string[],
): boolean {
  if (patternSegments.length === 0) {
    return pathSegments.length === 0;
  }

  const [patternHead, ...patternTail] = patternSegments;
  if (patternHead === "**") {
    return (
      matchGlobSegments(pathSegments, patternTail) ||
      (pathSegments.length > 0 && matchGlobSegments(pathSegments.slice(1), patternSegments))
    );
  }

  if (pathSegments.length === 0 || !matchGlobSegment(pathSegments[0], patternHead)) {
    return false;
  }

  return matchGlobSegments(pathSegments.slice(1), patternTail);
}

function matchGlobSegment(pathSegment: string, patternSegment: string): boolean {
  if (patternSegment === "*") {
    return true;
  }

  if (!patternSegment.includes("*")) {
    return pathSegment === patternSegment;
  }

  const escaped = patternSegment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(pathSegment);
}

export const doctor = defineCommand({
  meta: {
    name: "doctor",
    description: "Diagnose Croco workspace configuration and framework boundaries",
  },
  args: {
    ...GLOBAL_OPTIONS,
    path: {
      type: "positional",
      required: false,
      description: "Workspace path to diagnose",
    },
    json: {
      type: "boolean",
      description: "Print the machine-readable doctor report",
    },
  },
  run({ args }) {
    const cwd =
      typeof args.cwd === "string"
        ? args.cwd
        : typeof args.path === "string"
          ? args.path
          : getCrocoCommandRuntime().cwd;
    const report = runDoctor({ cwd });

    getCrocoCommandRuntime().stdout(
      args.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report),
    );
    getCrocoCommandRuntime().setExitCode(getDoctorExitCode(report));
  },
});

const doctorSourceProject = new Project({
  skipAddingFilesFromTsConfig: true,
  useInMemoryFileSystem: true,
});

function hasCrocoLambdaFlush(source: string): boolean {
  let sourceFile: Morph.SourceFile | undefined;
  try {
    sourceFile = doctorSourceProject.createSourceFile("/doctor/lambda.ts", source, {
      overwrite: true,
    });
    const configuredHandlers = new Set(
      sourceFile.getVariableDeclarations().filter(isConfiguredCrocoLambdaHandler),
    );

    return (
      configuredHandlers.size > 0 &&
      (exportedHandlerDelegatesTo(sourceFile, configuredHandlers) ||
        exportsConfiguredHandlerAlias(sourceFile, configuredHandlers))
    );
  } catch {
    return false;
  } finally {
    if (sourceFile) {
      doctorSourceProject.removeSourceFile(sourceFile);
    }
  }
}

function isConfiguredCrocoLambdaHandler(declaration: Morph.VariableDeclaration): boolean {
  const initializer = declaration.getInitializer();
  if (!Node.isCallExpression(initializer)) {
    return false;
  }

  const options = getCrocoLambdaHandlerOptions(initializer);
  return (
    Node.isObjectLiteralExpression(options) &&
    flushPropertyCallsForceFlush(options, declaration.getSourceFile())
  );
}

function getCrocoLambdaHandlerOptions(initializer: Morph.CallExpression): Morph.Node | undefined {
  const handlerFactory = initializer.getExpression();
  if (isPresetLambdaHandlerFactory(handlerFactory, initializer.getSourceFile())) {
    return initializer.getArguments()[1];
  }

  if (
    !Node.isPropertyAccessExpression(handlerFactory) ||
    handlerFactory.getName() !== "lambdaHandler"
  ) {
    return undefined;
  }

  const createAppCall = handlerFactory.getExpression();
  if (
    !Node.isCallExpression(createAppCall) ||
    !Node.isIdentifier(createAppCall.getExpression()) ||
    createAppCall.getExpression().getText() !== "createCrocoApp"
  ) {
    return undefined;
  }

  return initializer.getArguments()[0];
}

function isPresetLambdaHandlerFactory(
  factory: Morph.Expression,
  sourceFile: Morph.SourceFile,
): boolean {
  return sourceFile.getImportDeclarations().some((declaration) => {
    const moduleSpecifier = declaration.getModuleSpecifierValue();
    if (
      moduleSpecifier !== "@croco/preset-lambda" &&
      moduleSpecifier !== "@croco/preset-lambda/entry" &&
      moduleSpecifier !== "@croco/preset-lambda/handler"
    ) {
      return false;
    }

    if (Node.isIdentifier(factory)) {
      return declaration.getNamedImports().some((namedImport) => {
        const localName = namedImport.getAliasNode()?.getText() ?? namedImport.getName();
        return (
          ["createLambdaHandler", "createLambdaHost"].includes(namedImport.getName()) &&
          localName === factory.getText()
        );
      });
    }

    if (
      !Node.isPropertyAccessExpression(factory) ||
      !["createLambdaHandler", "createLambdaHost"].includes(factory.getName())
    ) {
      return false;
    }
    const namespace = declaration.getNamespaceImport();
    return (
      namespace !== undefined &&
      Node.isIdentifier(factory.getExpression()) &&
      namespace.getText() === factory.getExpression().getText()
    );
  });
}

function flushPropertyCallsForceFlush(
  options: Morph.ObjectLiteralExpression,
  sourceFile: Morph.SourceFile,
): boolean {
  const runtimeBindings = getTelemetryRuntimeBindings(sourceFile);
  const flushProperty = options.getProperty("flush");
  if (Node.isMethodDeclaration(flushProperty)) {
    return nodeCallsTelemetryForceFlush(flushProperty, runtimeBindings);
  }
  if (Node.isPropertyAssignment(flushProperty)) {
    const initializer = flushProperty.getInitializer();
    return Boolean(
      initializer &&
      (nodeCallsTelemetryForceFlush(initializer, runtimeBindings) ||
        (Node.isIdentifier(initializer) &&
          referencedFunctionCallsTelemetryForceFlush(initializer.getSymbol(), runtimeBindings))),
    );
  }
  if (Node.isShorthandPropertyAssignment(flushProperty)) {
    return referencedFunctionCallsTelemetryForceFlush(
      sourceFile.getProject().getTypeChecker().getShorthandAssignmentValueSymbol(flushProperty),
      runtimeBindings,
    );
  }
  return false;
}

function referencedFunctionCallsTelemetryForceFlush(
  symbol: Morph.Symbol | undefined,
  runtimeBindings: ReadonlySet<Morph.VariableDeclaration>,
): boolean {
  return Boolean(
    symbol?.getDeclarations().some((declaration) => {
      if (Node.isVariableDeclaration(declaration)) {
        const initializer = declaration.getInitializer();
        return Boolean(initializer && nodeCallsTelemetryForceFlush(initializer, runtimeBindings));
      }
      return (
        Node.isFunctionDeclaration(declaration) &&
        nodeCallsTelemetryForceFlush(declaration, runtimeBindings)
      );
    }),
  );
}

function getTelemetryRuntimeBindings(
  sourceFile: Morph.SourceFile,
): ReadonlySet<Morph.VariableDeclaration> {
  return new Set(
    sourceFile.getVariableDeclarations().filter((declaration) => {
      const initializer = declaration.getInitializer();
      if (!Node.isCallExpression(initializer)) {
        return false;
      }
      const getInstanceAccess = initializer.getExpression();
      return (
        Node.isPropertyAccessExpression(getInstanceAccess) &&
        getInstanceAccess.getName() === "getInstance" &&
        Node.isIdentifier(getInstanceAccess.getExpression()) &&
        getInstanceAccess.getExpression().getText() === "TelemetryRuntime"
      );
    }),
  );
}

function nodeCallsTelemetryForceFlush(
  node: Node,
  runtimeBindings: ReadonlySet<Morph.VariableDeclaration>,
): boolean {
  return node.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    if (hasNestedFunctionScope(call, node)) {
      return false;
    }
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== "forceFlush") {
      return false;
    }
    const receiver = expression.getExpression();
    return Node.isIdentifier(receiver) && identifierResolvesTo(receiver, runtimeBindings);
  });
}

function identifierResolvesTo(
  identifier: Morph.Identifier,
  declarations: ReadonlySet<Morph.VariableDeclaration>,
): boolean {
  return Boolean(
    identifier
      .getSymbol()
      ?.getDeclarations()
      .some(
        (declaration) => Node.isVariableDeclaration(declaration) && declarations.has(declaration),
      ),
  );
}

function isFunctionScope(node: Node): boolean {
  return (
    Node.isArrowFunction(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isMethodDeclaration(node)
  );
}

function hasNestedFunctionScope(call: Morph.CallExpression, target: Node): boolean {
  for (const ancestor of call.getAncestors()) {
    if (ancestor === target) {
      return false;
    }
    if (isFunctionScope(ancestor)) {
      return true;
    }
  }
  return false;
}

function exportedHandlerDelegatesTo(
  sourceFile: Morph.SourceFile,
  configuredHandlers: ReadonlySet<Morph.VariableDeclaration>,
): boolean {
  const handlerVariable = sourceFile.getVariableDeclaration("handler");
  const handlerFunction = sourceFile.getFunction("handler");
  const handlerNodes: Node[] = [];
  const handlerInitializer = handlerVariable?.getVariableStatement()?.isExported()
    ? handlerVariable.getInitializer()
    : undefined;
  if (handlerVariable && handlerInitializer && configuredHandlers.has(handlerVariable)) {
    return true;
  }
  if (
    handlerInitializer &&
    Node.isIdentifier(handlerInitializer) &&
    identifierResolvesTo(handlerInitializer, configuredHandlers)
  ) {
    return true;
  }
  if (handlerInitializer) {
    handlerNodes.push(handlerInitializer);
  }
  if (handlerFunction?.isExported()) {
    handlerNodes.push(handlerFunction);
  }

  return handlerNodes.some((handlerNode) => {
    const calls = [
      ...(Node.isCallExpression(handlerNode) ? [handlerNode] : []),
      ...handlerNode.getDescendantsOfKind(SyntaxKind.CallExpression),
    ];

    return calls.some((call) => {
      if (hasNestedFunctionScope(call, handlerNode)) {
        return false;
      }
      const expression = call.getExpression();
      return (
        (Node.isIdentifier(expression) && identifierResolvesTo(expression, configuredHandlers)) ||
        boundHostCallbackDelegatesTo(call, configuredHandlers)
      );
    });
  });
}

function boundHostCallbackDelegatesTo(
  call: Morph.CallExpression,
  configuredHandlers: ReadonlySet<Morph.VariableDeclaration>,
): boolean {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== "bindHostCallback") {
    return false;
  }

  const callback = call.getArguments()[0];
  if (!Node.isIdentifier(callback)) {
    return false;
  }

  return Boolean(
    callback
      .getSymbol()
      ?.getDeclarations()
      .some((declaration) => declarationInvokesConfiguredHandler(declaration, configuredHandlers)),
  );
}

function declarationInvokesConfiguredHandler(
  declaration: Node,
  configuredHandlers: ReadonlySet<Morph.VariableDeclaration>,
): boolean {
  const callable = Node.isVariableDeclaration(declaration)
    ? declaration.getInitializer()
    : Node.isFunctionDeclaration(declaration)
      ? declaration
      : undefined;
  if (!callable) {
    return false;
  }

  return callable.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    if (hasNestedFunctionScope(call, callable)) {
      return false;
    }

    const expression = call.getExpression();
    return Node.isIdentifier(expression) && identifierResolvesTo(expression, configuredHandlers);
  });
}

function exportsConfiguredHandlerAlias(
  sourceFile: Morph.SourceFile,
  configuredHandlers: ReadonlySet<Morph.VariableDeclaration>,
): boolean {
  const exportsNamedHandler = sourceFile.getExportDeclarations().some((declaration) =>
    declaration.getNamedExports().some(
      (namedExport) =>
        namedExport.getAliasNode()?.getText() === "handler" &&
        namedExport
          .getLocalTargetSymbol()
          ?.getDeclarations()
          .some(
            (declaration) =>
              Node.isVariableDeclaration(declaration) && configuredHandlers.has(declaration),
          ),
    ),
  );
  if (exportsNamedHandler) {
    return true;
  }

  return sourceFile.getExportAssignments().some((assignment) => {
    if (assignment.isExportEquals()) {
      return false;
    }
    const expression = assignment.getExpression();
    return Node.isIdentifier(expression) && identifierResolvesTo(expression, configuredHandlers);
  });
}

function hasRuntimeCapabilitiesAndComposition(value: Record<string, unknown>): boolean {
  if (!isRecord(value["capabilities"])) {
    return false;
  }

  const composition = value["composition"];
  if (composition === undefined) {
    return true;
  }
  if (!isRecord(composition)) {
    return false;
  }

  const host = isRecord(composition["host"]) ? composition["host"] : null;
  const buildTarget = isRecord(composition["buildTarget"]) ? composition["buildTarget"] : null;
  const transports = composition["transports"];
  if (
    typeof host?.["platform"] !== "string" ||
    host["platform"].length === 0 ||
    host["platform"] !== value["platform"] ||
    typeof host["lifecycle"] !== "string" ||
    !["process", "invocation", "fetch"].includes(host["lifecycle"]) ||
    !hasOptionalNonEmptyString(host, "packageName") ||
    !Array.isArray(transports) ||
    typeof buildTarget?.["name"] !== "string" ||
    buildTarget["name"].length === 0 ||
    !hasOptionalNonEmptyString(buildTarget, "outputDirectory") ||
    !hasOptionalNonEmptyString(buildTarget, "packageName")
  ) {
    return false;
  }

  if (
    transports.some(
      (transport) =>
        !isRecord(transport) ||
        typeof transport["protocol"] !== "string" ||
        transport["protocol"].length === 0 ||
        !hasOptionalNonEmptyString(transport, "packageName"),
    )
  ) {
    return false;
  }

  const format = buildTarget["format"];
  if (
    format !== undefined &&
    (typeof format !== "string" || !["esm", "cjs", "dual"].includes(format))
  ) {
    return false;
  }

  const constraints = buildTarget["constraints"];
  return (
    constraints === undefined ||
    (Array.isArray(constraints) &&
      constraints.every((constraint) => typeof constraint === "string" && constraint.length > 0))
  );
}

function hasOptionalNonEmptyString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || (typeof value === "string" && value.length > 0);
}
