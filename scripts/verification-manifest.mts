import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  selectGeneratedSmokeCasesForChangedFiles,
  selectGeneratedTestPathsForSmokeCases,
} from "./create-croco-app-generated-smoke-dependencies.mts";
import {
  CORE_COVERAGE_PACKAGE_DIRECTORIES,
  CORE_COVERAGE_PACKAGES,
} from "./core-coverage-config.mts";
import { GENERATED_SMOKE_MATRIX_CASES } from "./create-croco-app-generated-smoke-matrix.mts";
import {
  isReleaseGateMaintenancePath,
  RELEASE_GATE_TEST_PATHS,
} from "./release-gate-maintenance.mts";
import { readTestInventory } from "./test-inventory.mts";
import { VerificationProblem } from "./verification-problem.mts";
import type { EvidenceCommand } from "./release-spine-evidence.mts";
import type { TestLane } from "./test-inventory.mts";

export type VerificationProfile = "repo" | "spine" | "publish";

const VERIFICATION_LANES = [
  "core-verification",
  "generated-apps",
  "package-artifacts",
  "coverage-security",
  "split-validation-shadow",
] as const;

export type VerificationLane = (typeof VERIFICATION_LANES)[number];

const VERIFICATION_COMMAND_IDS = [
  "verification-policy",
  "test-inventory",
  "turbo-cache-contract",
  "verification-contract-tests",
  "changeset-required",
  "package-manifests",
  "release-version-sync",
  "docs-catalog",
  "docs-api-triggers",
  "problem-registry",
  "docs-examples",
  "release-docs",
  "ci-executables",
  "ci-performance-budget",
  "architecture-policy-runtime",
  "architecture-policy",
  "architecture-circular-allowlist",
  "dependency-boundaries",
  "security-allowlists",
  "generated-secret-placeholders",
  "compiler-baseline",
  "decorator-signature-spike",
  "strict-contract-typecheck",
  "static-misuse",
  "lint",
  "format",
  "architecture-circular",
  "benchmark-thresholds",
  "build",
  "quick-start-lambda-smoke",
  "first-success",
  "package-entrypoints-smoke",
  "packed-decorator-consumers",
  "package-bins-smoke",
  "generated-app-smoke",
  "alpha-release-smoke",
  "typecheck",
  "test",
  "integration-test-lane",
  "published-test-lane",
  "test-evidence-reconcile",
  "cli-packed-e2e",
  "provider-certification",
  "production-ready",
  "spine-promotion",
  "core-coverage",
  "core-coverage-warning",
  "public-api",
  "release-gate-tests",
  "release-metadata",
  "spine-bundle-size",
  "dependency-audit-policy",
  "provenance-config",
  "publish-dry-run",
] as const;

type VerificationCommandId = (typeof VERIFICATION_COMMAND_IDS)[number];

export const VERIFICATION_LANE_OWNERSHIP = {
  "verification-policy": "core-verification",
  "test-inventory": "core-verification",
  "turbo-cache-contract": "core-verification",
  "verification-contract-tests": "core-verification",
  "changeset-required": "core-verification",
  "package-manifests": "core-verification",
  "release-version-sync": "core-verification",
  "docs-catalog": "core-verification",
  "docs-api-triggers": "core-verification",
  "problem-registry": "core-verification",
  "docs-examples": "core-verification",
  "release-docs": "core-verification",
  "ci-executables": "core-verification",
  "ci-performance-budget": "core-verification",
  "architecture-policy-runtime": "core-verification",
  "architecture-policy": "core-verification",
  "architecture-circular-allowlist": "core-verification",
  "dependency-boundaries": "core-verification",
  "security-allowlists": "coverage-security",
  "generated-secret-placeholders": "coverage-security",
  "compiler-baseline": "core-verification",
  "decorator-signature-spike": "core-verification",
  "strict-contract-typecheck": "core-verification",
  "static-misuse": "core-verification",
  lint: "core-verification",
  format: "core-verification",
  "architecture-circular": "core-verification",
  "benchmark-thresholds": "core-verification",
  build: "core-verification",
  "quick-start-lambda-smoke": "core-verification",
  "first-success": "core-verification",
  "package-entrypoints-smoke": "package-artifacts",
  "packed-decorator-consumers": "package-artifacts",
  "package-bins-smoke": "package-artifacts",
  "generated-app-smoke": "generated-apps",
  "alpha-release-smoke": "package-artifacts",
  typecheck: "core-verification",
  test: "core-verification",
  "integration-test-lane": "core-verification",
  "cli-packed-e2e": "core-verification",
  "published-test-lane": "package-artifacts",
  "test-evidence-reconcile": "split-validation-shadow",
  "provider-certification": "package-artifacts",
  "production-ready": "split-validation-shadow",
  "spine-promotion": "split-validation-shadow",
  "core-coverage": "coverage-security",
  "core-coverage-warning": "coverage-security",
  "public-api": "package-artifacts",
  "release-gate-tests": "core-verification",
  "release-metadata": "package-artifacts",
  "spine-bundle-size": "split-validation-shadow",
  "dependency-audit-policy": "coverage-security",
  "provenance-config": "coverage-security",
  "publish-dry-run": "package-artifacts",
} as const satisfies Readonly<Record<VerificationCommandId, VerificationLane>>;

export type VerificationContext = {
  readonly allowPendingReleaseMetadata?: boolean;
  readonly base?: string;
  readonly changedFiles?: readonly string[];
  readonly head?: string;
};

const minutes = (value: number): number => value * 60 * 1000;
const nodeScript = (script: string, ...args: string[]): readonly string[] => [
  "node",
  "--experimental-strip-types",
  script,
  ...args,
];
const guarded = (recovery: string, command: readonly string[]): readonly string[] =>
  nodeScript("scripts/tracked-file-mutation-guard.mts", "--recovery", recovery, "--", ...command);
const guardedNodeScript = (
  recovery: string,
  script: string,
  ...args: string[]
): readonly string[] => guarded(recovery, nodeScript(script, ...args));

const PACKAGE_BIN_BUILD_FILTERS = [
  "@croco/cli",
  "create-croco-app",
  "@croco/openapi-spec",
  "@croco/migration-runner",
  "@croco/rpc-codegen",
] as const;

const PACKED_DECORATOR_CONSUMER_BUILD_FILTERS = [
  "@croco/problems-core",
  "@croco/diagnostics-core",
  "@croco/framework-context",
  "@croco/protocols-core",
  "@croco/protocols-rest",
] as const;

export const PUBLISH_REQUIRED_GENERATED_SMOKE_CASES = [
  ...GENERATED_SMOKE_MATRIX_CASES.filter(({ tier }) => tier === "spine-blocking").map(
    ({ name }) => name,
  ),
  "admin-console-starter",
  "ai-saas-golden-path",
] as const;

function isApplicableToChangedFiles(
  context: VerificationContext,
  predicate: (path: string) => boolean,
): boolean {
  if (!context.base || !context.head || !context.changedFiles) return true;
  return context.changedFiles.some((path) => path === "test-inventory.json" || predicate(path));
}

function isChangeScopedVerification(context: VerificationContext): boolean {
  return Boolean(context.base && context.head && context.changedFiles);
}

function affectsScaffold(path: string): boolean {
  return (
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|\.nvmrc)$/.test(path) ||
    path.startsWith("packages/create-croco-app/") ||
    /^scripts\/(?:alpha-release-smoke|create-croco-app-[^/]+|first-success-verify|quick-start-lambda-smoke)\.mts$/.test(
      path,
    )
  );
}

function affectsPackageEntrypoints(path: string): boolean {
  return (
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|\.nvmrc)$/.test(path) ||
    /^packages\/(?!create-croco-app\/)[^/]+\/(?:package\.json|src\/index\.ts)$/.test(path) ||
    path === "scripts/package-entrypoint-smoke.mts"
  );
}

function affectsPackedDecoratorConsumers(path: string): boolean {
  return (
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|\.nvmrc)$/.test(path) ||
    path.startsWith("tsconfig/") ||
    /^packages\/(?:diagnostics-core|framework-context|problems-core|protocols-core|protocols-rest)\//.test(
      path,
    ) ||
    path === "scripts/packed-decorator-consumers.mts" ||
    path.startsWith("scripts/fixtures/packed-decorator-consumers/")
  );
}

function affectsPackageBins(path: string): boolean {
  return (
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|\.nvmrc)$/.test(path) ||
    /^packages\/(?:cli|create-croco-app|migration-runner|openapi-spec|rpc-codegen)\/(?:package\.json|src\/)/.test(
      path,
    ) ||
    path === "scripts/package-bin-smoke.mts"
  );
}

function affectsCreateCrocoApp(path: string): boolean {
  return path.startsWith("packages/create-croco-app/");
}

function affectsPackageGraph(path: string): boolean {
  return (
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|\.nvmrc)$/.test(path) ||
    /^(?:apps|examples|packages)\//.test(path) ||
    path === "docs/package-catalog.json"
  );
}

function packageAccountabilitySelection(context: VerificationContext): {
  readonly applicable: boolean;
  readonly fullEvidence: boolean;
  readonly packages: readonly string[];
  readonly reason: string;
} {
  if (!isChangeScopedVerification(context) || !context.changedFiles) {
    return {
      applicable: true,
      fullEvidence: true,
      packages: [],
      reason: "Selected because this is a full verification run.",
    };
  }

  const relevantFiles = context.changedFiles.filter(affectsPackageGraph);
  if (relevantFiles.length > 0) {
    const packages = [
      ...new Set(
        relevantFiles.flatMap((path) => {
          const match = /^packages\/([^/]+)\//.exec(path);
          return match?.[1] ? [match[1]] : [];
        }),
      ),
    ].sort();
    return {
      applicable: true,
      fullEvidence: relevantFiles.some((path) => !/^(?:apps|examples|packages)\//.test(path)),
      packages,
      reason: `Selected because package accountability inputs changed: ${relevantFiles.join(", ")}.`,
    };
  }

  return {
    applicable: false,
    fullEvidence: false,
    packages: [],
    reason: "Skipped because no package graph or package catalog input changed.",
  };
}

function affectsCoreCoverage(path: string): boolean {
  return CORE_COVERAGE_PACKAGE_DIRECTORIES.some((directory) =>
    path.startsWith(`packages/${directory}/`),
  );
}

function affectedTurboArguments(context: VerificationContext): readonly string[] {
  // Docs is verified by its dedicated gates instead of the affected package build/typecheck tasks.
  return isChangeScopedVerification(context) && context.base
    ? [`--filter=...[${context.base}]`, "--filter=!@croco/docs"]
    : [];
}

const TEST_INVENTORY = readTestInventory().inventory;

type WorkspacePackage = {
  readonly dependencies: ReadonlySet<string>;
  readonly directory: string;
  readonly name: string;
};

function readWorkspacePackages(): readonly WorkspacePackage[] {
  const root = resolve(import.meta.dirname, "..");
  return ["apps", "examples", "packages"]
    .flatMap((workspaceRoot) => {
      const absoluteRoot = resolve(root, workspaceRoot);
      if (!existsSync(absoluteRoot)) return [];
      return readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory()) return [];
        const directory = `${workspaceRoot}/${entry.name}`;
        const manifestPath = resolve(root, directory, "package.json");
        if (!existsSync(manifestPath)) return [];
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          readonly name?: string;
          readonly dependencies?: Readonly<Record<string, string>>;
          readonly devDependencies?: Readonly<Record<string, string>>;
          readonly optionalDependencies?: Readonly<Record<string, string>>;
          readonly peerDependencies?: Readonly<Record<string, string>>;
        };
        if (!manifest.name) return [];
        return [
          {
            dependencies: new Set([
              ...Object.keys(manifest.dependencies ?? {}),
              ...Object.keys(manifest.devDependencies ?? {}),
              ...Object.keys(manifest.optionalDependencies ?? {}),
              ...Object.keys(manifest.peerDependencies ?? {}),
            ]),
            directory,
            name: manifest.name,
          },
        ];
      });
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

const WORKSPACE_PACKAGES = readWorkspacePackages();
const WORKSPACE_PACKAGE_BY_DIRECTORY = new Map(
  WORKSPACE_PACKAGES.map((workspacePackage) => [workspacePackage.directory, workspacePackage]),
);

function transitivelyAffectedPackages(changedPackages: ReadonlySet<string>): ReadonlySet<string> {
  const affected = new Set(changedPackages);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const workspacePackage of WORKSPACE_PACKAGES) {
      // Docs has dedicated verification commands and is intentionally outside package test propagation.
      if (workspacePackage.name === "@croco/docs" || affected.has(workspacePackage.name)) continue;
      if ([...workspacePackage.dependencies].some((dependency) => affected.has(dependency))) {
        affected.add(workspacePackage.name);
        expanded = true;
      }
    }
  }
  return affected;
}

function inventoryEntryWorkspace(path: string): string | undefined {
  const match = /^(packages|apps|examples)\/([^/]+)\//.exec(path);
  if (match?.[1] && match[2]) return `${match[1]}/${match[2]}/`;
  if (path.startsWith("scripts/tests/")) return "scripts/";
  if (path.startsWith("tests/")) return "tests/";
  return undefined;
}

function laneSelection(
  context: VerificationContext,
  profile: VerificationProfile,
  lane: TestLane,
): { readonly applicable: boolean; readonly owners: readonly string[]; readonly full: boolean } {
  if (!isChangeScopedVerification(context) || profile === "publish") {
    return { applicable: true, owners: [], full: true };
  }
  const changedFiles = context.changedFiles ?? [];
  const full = changedFiles.some(
    (path) =>
      path === "test-inventory.json" ||
      /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|vitest(?:\.[^/]+)?\.ts)$/.test(
        path,
      ),
  );
  if (full) return { applicable: true, owners: [], full: true };
  const directlyChangedPackages = new Set(
    changedFiles.flatMap((path) => {
      const workspace = inventoryEntryWorkspace(path);
      if (!workspace || workspace === "scripts/" || workspace === "tests/") return [];
      const workspacePackage = WORKSPACE_PACKAGE_BY_DIRECTORY.get(workspace.slice(0, -1));
      return workspacePackage ? [workspacePackage.name] : [];
    }),
  );
  const affectedPackages = transitivelyAffectedPackages(directlyChangedPackages);
  const repositoryOwners =
    lane === "fast"
      ? changedFiles.flatMap((path) => {
          if (path.startsWith("scripts/")) return ["repo:ci"];
          if (path.startsWith("examples/")) return ["repo:examples"];
          if (path.startsWith("tests/")) return ["repo:tests"];
          return [];
        })
      : [];
  const owners = [
    ...new Set([
      ...repositoryOwners,
      ...TEST_INVENTORY.tests
        .filter((entry) => entry.lane === lane)
        .filter((entry) => affectedPackages.has(entry.owner))
        .map(({ owner }) => owner),
    ]),
  ].sort();
  return { applicable: owners.length > 0, owners, full: false };
}

export function generatedTestMaterializationArguments(
  requiredGeneratedPaths: readonly string[],
): readonly string[] {
  if (requiredGeneratedPaths.length === 0) return [];
  return [
    "--materialization-evidence",
    "ci-reports/generated-apps/materialization-evidence.json",
    "--generated-root",
    "ci-reports/generated-apps/materialized-tests",
    ...requiredGeneratedPaths.flatMap((path) => ["--required-generated-path", path]),
  ];
}

const repoOnly = (
  context: VerificationContext,
  profile: VerificationProfile,
  suppressVerificationContractTests = false,
): readonly EvidenceCommand[] => [
  {
    id: "verification-policy",
    label: "Read-only verification policy",
    category: "quality",
    command: guardedNodeScript(
      "Guard or classify the reported verification path",
      "scripts/verification-policy.mts",
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "test-inventory",
    label: "Authoritative test inventory",
    category: "quality",
    command: guardedNodeScript(
      "node --experimental-strip-types scripts/test-inventory.mts --write",
      "scripts/test-inventory.mts",
      "--check",
      "--profile",
      profile === "publish" ? "publish" : "ordinary",
      "--output",
      "ci-reports/package-quality/test-inventory.json",
    ),
    timeoutMs: minutes(5),
    artifacts: [
      {
        label: "Resolved test inventory",
        path: "ci-reports/package-quality/test-inventory.json",
        required: true,
      },
    ],
  },
  {
    id: "turbo-cache-contract",
    label: "Turbo cache reuse and invalidation contract",
    category: "quality",
    command: nodeScript("scripts/turbo-cache-contract.mts"),
    timeoutMs: minutes(5),
  },
  {
    id: "verification-contract-tests",
    label: "Verification profile contracts",
    category: "quality",
    command: [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "scripts/tests/verification-command.spec.ts",
      "scripts/tests/verification-change-classifier.spec.ts",
      "scripts/tests/verification-manifest.spec.ts",
      "scripts/tests/release-spine-evidence.spec.ts",
      "scripts/tests/ci-workflow.spec.ts",
      "scripts/tests/ci-performance-budget.spec.ts",
      "scripts/tests/release-workflow.spec.ts",
      "scripts/tests/turbo-task-contract.spec.ts",
      "scripts/tests/branch-protection-policy.spec.ts",
      "scripts/tests/repository-policy-audit-workflow.spec.ts",
      "scripts/tests/verification-policy.spec.ts",
      "scripts/tests/test-inventory.spec.ts",
      "scripts/tests/test-lane-runner.spec.ts",
      "scripts/tests/turbo-cache-contract.spec.ts",
    ],
    timeoutMs: minutes(10),
    applicable: !suppressVerificationContractTests,
  },
  {
    id: "changeset-required",
    label: "Changeset requirement",
    category: "metadata",
    command: guardedNodeScript(
      "pnpm changeset or revert the publishable change",
      "scripts/changeset-required-check.mts",
      ...(context.base && context.head ? ["--base", context.base, "--head", context.head] : []),
    ),
    timeoutMs: minutes(5),
    applicable: Boolean(context.base && context.head),
  },
  {
    id: "package-manifests",
    label: "Package manifests",
    category: "metadata",
    command: guarded("pnpm package-manifests:write", [
      "node",
      "scripts/normalize-packages.mjs",
      "--check",
    ]),
    timeoutMs: minutes(5),
  },
  {
    id: "release-version-sync",
    label: "Release version-derived metadata",
    category: "metadata",
    command: guardedNodeScript(
      "pnpm release-version-sync:write && pnpm docs:catalog:write",
      "scripts/release-version-sync.mts",
      "--check",
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "docs-catalog",
    label: "Package documentation catalog",
    category: "quality",
    command: guardedNodeScript(
      "pnpm docs:catalog:write",
      "scripts/package-docs-check.mts",
      "--check",
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "docs-api-triggers",
    label: "API documentation triggers",
    category: "quality",
    command: guardedNodeScript(
      "pnpm docs:api-triggers:write",
      "scripts/api-docs-trigger-check.mts",
      "--check",
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "problem-registry",
    label: "Problem registry",
    category: "quality",
    command: guardedNodeScript(
      "pnpm problem-registry:write",
      "scripts/problem-registry.mts",
      "--check",
      ...(context.base ? ["--base", context.base] : []),
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "docs-examples",
    label: "Documentation examples",
    category: "quality",
    command: guardedNodeScript(
      "pnpm docs:examples:write",
      "scripts/doc-examples-check.mts",
      "--check",
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "release-docs",
    label: "Release documentation",
    category: "quality",
    command: guardedNodeScript(
      "Fix the reported release documentation contract",
      "scripts/release-docs-check.mts",
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "ci-executables",
    label: "CI executable supply chain",
    category: "security",
    command: guardedNodeScript(
      "Pin the reported CI executable to an immutable source",
      "scripts/ci-executable-policy.mts",
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "ci-performance-budget",
    label: "Pull-request CI performance budget",
    category: "quality",
    command: nodeScript("scripts/ci-performance-budget.mts"),
    timeoutMs: minutes(5),
  },
  {
    id: "architecture-policy-runtime",
    label: "Verification runtime prerequisites",
    category: "build",
    command: guarded("Fix the verification runtime build prerequisites", [
      "pnpm",
      "--filter",
      "@croco/architecture-policy...",
      "--filter",
      "@croco/tenant-core...",
      "build",
    ]),
    timeoutMs: minutes(10),
  },
  {
    id: "architecture-policy",
    label: "Architecture policy",
    category: "quality",
    command: guardedNodeScript(
      "Fix the reported architecture violation",
      "scripts/architecture-policy-check.mts",
      "--manifest",
      "croco.arch.json",
    ),
    timeoutMs: minutes(10),
  },
  {
    id: "architecture-circular-allowlist",
    label: "Architecture circular allowlist",
    category: "quality",
    command: guardedNodeScript(
      "Update code or intentionally update the circular dependency allowlist",
      "scripts/verify-circular-allowlist.mts",
    ),
    timeoutMs: minutes(10),
  },
  {
    id: "dependency-boundaries",
    label: "Dependency boundaries",
    category: "quality",
    command: guardedNodeScript(
      "Fix the reported package boundary",
      "scripts/package-quality-report.mts",
      "--boundary-check-only",
    ),
    timeoutMs: minutes(10),
  },
  {
    id: "security-allowlists",
    label: "Security allowlists",
    category: "quality",
    command: guardedNodeScript(
      "Fix the reported security allowlist metadata",
      "scripts/security-allowlist-metadata-check.mts",
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "generated-secret-placeholders",
    label: "Generated secret placeholders",
    category: "quality",
    command: guardedNodeScript(
      "Fix the reported template placeholder",
      "scripts/generated-secret-placeholder-policy.mts",
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "compiler-baseline",
    label: "TypeScript compiler baseline",
    category: "typecheck",
    command: guardedNodeScript(
      "Restore the documented TypeScript compiler and tsconfig contract",
      "scripts/compiler-baseline-check.mts",
    ),
    timeoutMs: minutes(5),
  },
  {
    id: "decorator-signature-spike",
    label: "Legacy decorator signature spike",
    category: "typecheck",
    command: guardedNodeScript(
      "Restore the reviewed TypeScript 6 decorator signature fixtures and policy",
      "scripts/decorator-signature-spike.mts",
    ),
    timeoutMs: minutes(10),
  },
  {
    id: "strict-contract-typecheck",
    label: "Strict contract typecheck",
    category: "typecheck",
    command: guardedNodeScript(
      "Fix the reported strict contract diagnostic",
      "scripts/strict-contract-typecheck.mts",
    ),
    timeoutMs: minutes(10),
  },
  {
    id: "static-misuse",
    label: "Static misuse",
    category: "quality",
    command: guardedNodeScript("Fix the reported source misuse", "scripts/static-misuse-check.mts"),
    timeoutMs: minutes(10),
  },
  {
    id: "lint",
    label: "Lint",
    category: "quality",
    command: ["pnpm", "exec", "oxlint", "."],
    timeoutMs: minutes(15),
  },
  {
    id: "format",
    label: "Format",
    category: "quality",
    command: [
      "pnpm",
      "exec",
      "oxfmt",
      "--check",
      ".",
      "--ignore-path=.gitignore",
      "--ignore-path=.prettierignore",
      "--ignore-path=.oxfmtignore",
    ],
    timeoutMs: minutes(15),
  },
  {
    id: "architecture-circular",
    label: "Architecture circular dependencies",
    category: "quality",
    command: guarded("Fix the reported circular dependency", [
      "pnpm",
      "exec",
      "madge",
      "--circular",
      "--extensions",
      "ts",
      "packages",
    ]),
    timeoutMs: minutes(10),
  },
  {
    id: "benchmark-thresholds",
    label: "Benchmark thresholds",
    category: "quality",
    command: guardedNodeScript("pnpm bench:update", "scripts/bench-threshold-check.mts"),
    timeoutMs: minutes(10),
  },
];

const spineOnly = (
  context: VerificationContext,
  profile: VerificationProfile,
): readonly EvidenceCommand[] => {
  const changeScoped = isChangeScopedVerification(context);
  const packageAccountability = packageAccountabilitySelection(context);
  const affectedArguments =
    profile === "publish" || packageAccountability.fullEvidence
      ? []
      : affectedTurboArguments(context);
  const scaffoldApplicable = isApplicableToChangedFiles(context, affectsScaffold);
  const affectedGeneratedSmokeCases = context.changedFiles
    ? selectGeneratedSmokeCasesForChangedFiles(context.changedFiles)
    : [];
  const generatedAppSmokeFullTier = scaffoldApplicable || packageAccountability.fullEvidence;
  const generatedAppSmokeApplicable =
    generatedAppSmokeFullTier || affectedGeneratedSmokeCases.length > 0;
  const selectedGeneratedSmokeCases =
    profile === "publish"
      ? PUBLISH_REQUIRED_GENERATED_SMOKE_CASES
      : generatedAppSmokeFullTier
        ? GENERATED_SMOKE_MATRIX_CASES.filter(({ tier }) => tier === "spine-blocking").map(
            ({ name }) => name,
          )
        : affectedGeneratedSmokeCases;
  const generatedTestPaths = TEST_INVENTORY.tests
    .filter(({ lane }) => lane === "generated-app")
    .map(({ path }) => path);
  const requiredGeneratedPaths = selectGeneratedTestPathsForSmokeCases(
    selectedGeneratedSmokeCases,
    generatedTestPaths,
  );
  const scaffoldBuildArguments =
    changeScoped && scaffoldApplicable && !packageAccountability.fullEvidence
      ? ["--filter=create-croco-app"]
      : [];
  const entrypointsApplicable = isApplicableToChangedFiles(context, affectsPackageEntrypoints);
  const packedDecoratorConsumersApplicable = isApplicableToChangedFiles(
    context,
    affectsPackedDecoratorConsumers,
  );
  const packedDecoratorConsumerBuildArguments =
    changeScoped && packedDecoratorConsumersApplicable && !packageAccountability.fullEvidence
      ? PACKED_DECORATOR_CONSUMER_BUILD_FILTERS.map((packageName) => `--filter=${packageName}`)
      : [];
  const binsApplicable = isApplicableToChangedFiles(context, affectsPackageBins);
  const packageBinBuildArguments =
    changeScoped && binsApplicable && !packageAccountability.fullEvidence
      ? PACKAGE_BIN_BUILD_FILTERS.map((packageName) => `--filter=${packageName}`)
      : [];
  const packedCliApplicable = isApplicableToChangedFiles(context, affectsCreateCrocoApp);
  const coreCoverageApplicable = isApplicableToChangedFiles(context, affectsCoreCoverage);
  const selectedFastLane = laneSelection(context, profile, "fast");
  const fastSelection = packageAccountability.fullEvidence
    ? { applicable: true, owners: [], full: true }
    : selectedFastLane;
  const integrationSelection = laneSelection(context, profile, "integration");
  const publishedSelection = laneSelection(context, profile, "published");

  return [
    {
      id: "build",
      label:
        changeScoped && !packageAccountability.fullEvidence ? "Affected build" : "Summarized build",
      category: "build",
      command: [
        "pnpm",
        "turbo",
        "run",
        "build",
        ...affectedArguments,
        ...scaffoldBuildArguments,
        ...packedDecoratorConsumerBuildArguments,
        ...packageBinBuildArguments,
        "--summarize",
        "--continue=always",
      ],
      timeoutMs: minutes(30),
    },
    {
      id: "quick-start-lambda-smoke",
      label: "Quick-start Lambda smoke",
      category: "runtime-smoke",
      command: nodeScript("scripts/quick-start-lambda-smoke.mts"),
      timeoutMs: minutes(10),
      applicable: scaffoldApplicable,
    },
    {
      id: "first-success",
      label: "First-success contract",
      category: "generated-app",
      command: guardedNodeScript(
        "Follow the reported scaffold or documentation recovery command",
        "scripts/first-success-verify.mts",
      ),
      timeoutMs: minutes(10),
      applicable: scaffoldApplicable,
    },
    {
      id: "package-entrypoints-smoke",
      label: "Package entrypoint smoke",
      category: "package-smoke",
      command: nodeScript(
        "scripts/package-entrypoint-smoke.mts",
        ...(changeScoped ? ["--build-missing"] : []),
      ),
      timeoutMs: minutes(15),
      applicable: entrypointsApplicable,
    },
    {
      id: "package-bins-smoke",
      label: "Package binary smoke",
      category: "package-smoke",
      command: nodeScript("scripts/package-bin-smoke.mts"),
      timeoutMs: minutes(20),
      applicable: binsApplicable,
    },
    {
      id: "generated-app-smoke",
      label: "create-croco-app spine smoke",
      category: "generated-app",
      command: nodeScript(
        "scripts/create-croco-app-generated-smoke.mts",
        ...(profile === "publish"
          ? PUBLISH_REQUIRED_GENERATED_SMOKE_CASES
          : generatedAppSmokeFullTier
            ? ["--tier", "spine-blocking"]
            : affectedGeneratedSmokeCases),
      ),
      timeoutMs: minutes(45),
      applicable: generatedAppSmokeApplicable,
      artifacts: [
        {
          label: "Spine-blocking generated app smoke matrix markdown",
          path: "ci-reports/generated-apps/spine-blocking-matrix.md",
          required: true,
        },
        {
          label: "Spine-blocking generated app smoke matrix JSON",
          path: "ci-reports/generated-apps/spine-blocking-matrix.json",
          required: true,
        },
        {
          label: "Generated app smoke journey bundle",
          path: "ci-reports/generated-apps/spine-blocking-journeys",
          required: generatedAppSmokeFullTier && profile !== "publish",
          copyRelativePath: "spine-blocking-journeys",
        },
        {
          label: "Generated test materialization evidence",
          path: "ci-reports/generated-apps/materialization-evidence.json",
          required: true,
        },
        {
          label: "Generated test materializations",
          path: "ci-reports/generated-apps/materialized-tests",
          required: true,
        },
      ],
    },
    {
      id: "packed-decorator-consumers",
      label: "Packed decorator consumers",
      category: "package-smoke",
      command: nodeScript("scripts/packed-decorator-consumers.mts"),
      timeoutMs: minutes(15),
      applicable: packedDecoratorConsumersApplicable,
    },
    {
      id: "alpha-release-smoke",
      label: "Packed generated app release smoke",
      category: "generated-app",
      command: nodeScript("scripts/alpha-release-smoke.mts"),
      timeoutMs: minutes(45),
      applicable: !changeScoped,
      artifacts: [
        {
          label: "Packed generated app smoke report",
          path: "ci-reports/release/alpha-release-smoke.md",
          required: true,
        },
      ],
    },
    {
      id: "typecheck",
      label: "Summarized TypeScript check",
      category: "typecheck",
      command: guarded("Fix the reported TypeScript diagnostics", [
        "pnpm",
        "turbo",
        "run",
        "typecheck",
        ...affectedArguments,
        "--summarize",
        "--continue=always",
      ]),
      timeoutMs: minutes(30),
    },
    {
      id: "test",
      label: "Summarized tests",
      category: "quality",
      command: nodeScript(
        "scripts/test-lane-runner.mts",
        "--lane",
        "fast",
        ...fastSelection.owners.flatMap((owner) => ["--owner", owner]),
        "--output",
        "ci-reports/package-quality/fast-test-lane.json",
      ),
      timeoutMs: minutes(45),
      applicable: fastSelection.applicable,
      artifacts: [
        {
          label: "Fast test lane evidence",
          path: "ci-reports/package-quality/fast-test-lane.json",
          required: true,
        },
      ],
    },
    {
      id: "integration-test-lane",
      label: "Inventory integration test lane",
      category: "quality",
      command: nodeScript(
        "scripts/test-lane-runner.mts",
        "--lane",
        "integration",
        ...integrationSelection.owners.flatMap((owner) => ["--owner", owner]),
        "--output",
        "ci-reports/package-quality/integration-test-lane.json",
      ),
      timeoutMs: minutes(30),
      applicable: integrationSelection.applicable,
      selectionReason: integrationSelection.full
        ? "Selected for the full integration inventory."
        : `Selected affected integration owners: ${integrationSelection.owners.join(", ")}.`,
      artifacts: [
        {
          label: "Integration test lane evidence",
          path: "ci-reports/package-quality/integration-test-lane.json",
          required: true,
        },
      ],
    },
    {
      id: "published-test-lane",
      label: "Inventory published-consumer test lane",
      category: "package-smoke",
      command: nodeScript(
        "scripts/test-lane-runner.mts",
        "--lane",
        "published",
        ...publishedSelection.owners.flatMap((owner) => ["--owner", owner]),
        "--output",
        "ci-reports/package-quality/published-test-lane.json",
      ),
      timeoutMs: minutes(45),
      applicable: publishedSelection.applicable,
      selectionReason: publishedSelection.full
        ? "Selected for the full published-consumer inventory."
        : `Selected affected published owners: ${publishedSelection.owners.join(", ")}.`,
      artifacts: [
        {
          label: "Published-consumer test lane evidence",
          path: "ci-reports/package-quality/published-test-lane.json",
          required: true,
        },
      ],
    },
    {
      id: "test-evidence-reconcile",
      label: "Enforced test execution evidence",
      category: "quality",
      command: nodeScript(
        "scripts/test-evidence-reconcile.mts",
        "--profile",
        profile === "publish" ? "publish" : "ordinary",
        ...[...new Set([...fastSelection.owners, ...integrationSelection.owners])].flatMap(
          (owner) => ["--affected-owner", owner],
        ),
        ...publishedSelection.owners.flatMap((owner) => ["--packaging-owner", owner]),
        ...(fastSelection.applicable
          ? ["--lane-report", "ci-reports/package-quality/fast-test-lane.json"]
          : []),
        ...(integrationSelection.applicable
          ? ["--lane-report", "ci-reports/package-quality/integration-test-lane.json"]
          : []),
        ...(publishedSelection.applicable
          ? ["--lane-report", "ci-reports/package-quality/published-test-lane.json"]
          : []),
        ...(generatedAppSmokeApplicable
          ? generatedTestMaterializationArguments(requiredGeneratedPaths)
          : []),
        "--output",
        "ci-reports/package-quality/test-evidence.json",
      ),
      timeoutMs: minutes(5),
      artifacts: [
        {
          label: "Enforced test evidence",
          path: "ci-reports/package-quality/test-evidence.json",
          required: true,
        },
      ],
    },
    {
      id: "cli-packed-e2e",
      label: integrationSelection.full
        ? "Packed installed CLI integration evidence"
        : "Packed installed CLI integration tests",
      category: "quality",
      command: integrationSelection.full
        ? nodeScript(
            "scripts/test-lane-evidence-check.mts",
            "--report",
            "ci-reports/package-quality/integration-test-lane.json",
            "--lane",
            "integration",
            "--path",
            "packages/cli/src/tests/integration/CliCommandIntegration.spec.ts",
          )
        : [
            "pnpm",
            "--dir=packages/cli",
            "exec",
            "vitest",
            "run",
            "src/tests/integration/CliCommandIntegration.spec.ts",
          ],
      timeoutMs: minutes(integrationSelection.full ? 2 : 15),
      applicable: packedCliApplicable,
    },
    {
      id: "provider-certification",
      label: "Provider certification",
      category: "quality",
      command: guardedNodeScript(
        "Fix the reported provider certification metadata",
        "scripts/provider-certification-check.mts",
      ),
      timeoutMs: minutes(10),
      artifacts: [
        {
          label: "Provider certification markdown",
          path: "ci-reports/package-quality/provider-certification.md",
          required: true,
        },
        {
          label: "Provider certification JSON",
          path: "ci-reports/package-quality/provider-certification.json",
          required: true,
        },
      ],
    },
    {
      id: "production-ready",
      label: "Production-ready package evidence",
      category: "quality",
      command: guardedNodeScript(
        "Fix the reported production-ready package violations",
        "scripts/production-ready-check.mts",
        ...(packageAccountability.fullEvidence
          ? [
              "--require-task-summaries",
              "--fast-test-lane-report",
              "ci-reports/package-quality/fast-test-lane.json",
            ]
          : []),
      ),
      timeoutMs: minutes(10),
      applicable: packageAccountability.applicable,
      selectionReason: packageAccountability.reason,
      artifacts: [
        {
          label: "Production-ready package markdown",
          path: "ci-reports/package-quality/production-ready.md",
          required: true,
        },
      ],
    },
    {
      id: "spine-promotion",
      label: "Beta spine promotion accountability",
      category: "quality",
      command: guardedNodeScript(
        "Fix the reported beta spine promotion violations",
        "scripts/spine-promotion-check.mts",
        ...(packageAccountability.fullEvidence
          ? []
          : packageAccountability.packages.flatMap((packageName) => ["--package", packageName])),
      ),
      timeoutMs: minutes(10),
      applicable: packageAccountability.applicable,
      selectionReason: packageAccountability.reason,
      artifacts: [
        {
          label: "Beta spine promotion markdown",
          path: "ci-reports/package-quality/spine-promotion.md",
          required: true,
        },
      ],
    },
    {
      id: "core-coverage",
      label: "Core coverage gate",
      category: "coverage",
      command: [
        "pnpm",
        ...CORE_COVERAGE_PACKAGES.flatMap((packageName) => ["--filter", packageName]),
        "exec",
        "vitest",
        "run",
        "--coverage",
        "--config",
        "../../vitest.config.ts",
      ],
      timeoutMs: minutes(45),
      applicable: coreCoverageApplicable,
    },
    {
      id: "core-coverage-warning",
      label: "Core coverage warning report",
      category: "coverage",
      command: nodeScript("scripts/core-coverage-warning-check.mts"),
      timeoutMs: minutes(10),
      artifacts: [
        {
          label: "Core coverage warning markdown",
          path: "ci-reports/coverage/core-warning/report.md",
          required: true,
        },
      ],
    },
    {
      id: "public-api",
      label: "Public API snapshot",
      category: "public-api",
      command: guardedNodeScript(
        "pnpm public-api:write",
        "scripts/public-api-surface.mts",
        "--check",
      ),
      timeoutMs: minutes(10),
      artifacts: [
        {
          label: "Public API diff markdown",
          path: "ci-reports/package-quality/public-api-diff.md",
          required: true,
        },
        {
          label: "Public API summary JSON",
          path: "ci-reports/package-quality/public-api-summary.json",
          required: true,
        },
      ],
    },
  ];
};

const publishOnly = (context: VerificationContext): readonly EvidenceCommand[] => [
  {
    id: "release-gate-tests",
    label: "Release-gate maintenance test evidence",
    category: "quality",
    command: nodeScript(
      "scripts/test-lane-evidence-check.mts",
      "--report",
      "ci-reports/package-quality/fast-test-lane.json",
      "--lane",
      "fast",
      ...RELEASE_GATE_TEST_PATHS.flatMap((path) => ["--path", path]),
    ),
    timeoutMs: minutes(2),
    applicable: isApplicableToChangedFiles(context, isReleaseGateMaintenancePath),
  },
  {
    id: "release-metadata",
    label: "Release metadata",
    category: "metadata",
    command: nodeScript(
      "scripts/release-metadata-check.mts",
      ...(context.allowPendingReleaseMetadata ? ["--allow-pending-changesets"] : []),
    ),
    timeoutMs: minutes(10),
    applicable: isApplicableToChangedFiles(
      context,
      (path) =>
        path === "scripts/release-metadata-check.mts" ||
        /^\.changeset\/(?:pre\.json|(?!README\.md$)[^/]+\.md)$/.test(path) ||
        /^packages\/[^/]+\/(?:package\.json|CHANGELOG\.md)$/.test(path),
    ),
  },
  {
    id: "spine-bundle-size",
    label: "Spine bundle-size warning report",
    category: "quality",
    command: nodeScript("scripts/package-quality-report.mts"),
    timeoutMs: minutes(10),
    applicable: isApplicableToChangedFiles(
      context,
      (path) =>
        path === "scripts/package-quality-report.mts" ||
        path === ".changeset/config.json" ||
        path === "ci-reports/bundle-size/baseline.json" ||
        path === "docs/package-catalog.json" ||
        /^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig(?:\.[^/]+)?\.json)$/.test(
          path,
        ) ||
        /^packages\/[^/]+\/(?:src|config)\//.test(path) ||
        /^packages\/[^/]+\/(?:package\.json|tsconfig[^/]*\.json)$/.test(path),
    ),
    artifacts: [
      {
        label: "Package quality dashboard markdown",
        path: "ci-reports/package-quality/report.md",
        required: true,
      },
      {
        label: "Package quality dashboard JSON",
        path: "ci-reports/package-quality/summary.json",
        required: true,
      },
      {
        label: "Bundle-size enforcement markdown",
        path: "ci-reports/package-quality/bundle-size.md",
        required: true,
      },
    ],
  },
  {
    id: "dependency-audit-policy",
    label: "Production dependency audit policy",
    category: "quality",
    command: nodeScript("scripts/dependency-audit-policy.mts"),
    timeoutMs: minutes(10),
  },
  {
    id: "provenance-config",
    label: "npm provenance configuration",
    category: "metadata",
    command: nodeScript("scripts/provenance-config-check.mts"),
    timeoutMs: minutes(5),
  },
  {
    id: "publish-dry-run",
    label: "Publish dry run",
    category: "metadata",
    command: ["pnpm", "-r", "publish", "--dry-run", "--no-git-checks"],
    timeoutMs: minutes(30),
  },
];

const PROHIBITED_ROOT_ALIASES = new Set([
  "check",
  "build",
  "test",
  "typecheck",
  "release:spine-evidence",
]);

const PACKAGE_QUALITY_STATUS_PREREQUISITES = [
  "changeset-required",
  "lint",
  "format",
  "build",
  "typecheck",
  "test",
  "provider-certification",
  "production-ready",
  "spine-promotion",
] as const;

const VERIFICATION_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  "architecture-policy": ["architecture-policy-runtime"],
  "benchmark-thresholds": ["verification-contract-tests"],
  build: ["architecture-policy-runtime"],
  "quick-start-lambda-smoke": ["build"],
  "first-success": ["build"],
  "package-entrypoints-smoke": ["build", "typecheck", "generated-app-smoke"],
  "packed-decorator-consumers": ["build"],
  "package-bins-smoke": ["build"],
  "generated-app-smoke": ["build"],
  "alpha-release-smoke": ["build"],
  typecheck: ["build"],
  test: ["build", "typecheck"],
  "integration-test-lane": ["build"],
  "published-test-lane": ["build"],
  "test-evidence-reconcile": [
    "test",
    "integration-test-lane",
    "published-test-lane",
    "generated-app-smoke",
  ],
  "cli-packed-e2e": ["integration-test-lane"],
  "production-ready": ["build", "typecheck", "test", "test-evidence-reconcile"],
  "spine-promotion": ["test", "generated-app-smoke", "provider-certification", "production-ready"],
  "core-coverage": ["build"],
  "core-coverage-warning": ["core-coverage"],
  "spine-bundle-size": PACKAGE_QUALITY_STATUS_PREREQUISITES,
  "release-gate-tests": ["test"],
  "publish-dry-run": ["build"],
};

export type VerificationDependencyClassification = "physical-local" | "logical-synthesis";

type VerificationDependencyEdge =
  | "architecture-policy->architecture-policy-runtime"
  | "benchmark-thresholds->verification-contract-tests"
  | "build->architecture-policy-runtime"
  | "build->release-metadata"
  | "quick-start-lambda-smoke->build"
  | "first-success->build"
  | "package-entrypoints-smoke->build"
  | "package-entrypoints-smoke->typecheck"
  | "package-entrypoints-smoke->generated-app-smoke"
  | "packed-decorator-consumers->build"
  | "package-bins-smoke->build"
  | "generated-app-smoke->build"
  | "alpha-release-smoke->build"
  | "typecheck->build"
  | "test->build"
  | "test->typecheck"
  | "integration-test-lane->build"
  | "published-test-lane->build"
  | "test-evidence-reconcile->test"
  | "test-evidence-reconcile->integration-test-lane"
  | "test-evidence-reconcile->published-test-lane"
  | "test-evidence-reconcile->generated-app-smoke"
  | "cli-packed-e2e->integration-test-lane"
  | "production-ready->build"
  | "production-ready->typecheck"
  | "production-ready->test"
  | "production-ready->test-evidence-reconcile"
  | "spine-promotion->test"
  | "spine-promotion->generated-app-smoke"
  | "spine-promotion->provider-certification"
  | "spine-promotion->production-ready"
  | "core-coverage->build"
  | "core-coverage-warning->core-coverage"
  | "release-gate-tests->test"
  | "spine-bundle-size->changeset-required"
  | "spine-bundle-size->lint"
  | "spine-bundle-size->format"
  | "spine-bundle-size->build"
  | "spine-bundle-size->typecheck"
  | "spine-bundle-size->test"
  | "spine-bundle-size->provider-certification"
  | "spine-bundle-size->production-ready"
  | "spine-bundle-size->spine-promotion"
  | "publish-dry-run->build";

export const VERIFICATION_DEPENDENCY_CLASSIFICATION = {
  "architecture-policy->architecture-policy-runtime": ["physical-local"],
  "benchmark-thresholds->verification-contract-tests": ["physical-local"],
  "build->architecture-policy-runtime": ["physical-local"],
  "build->release-metadata": ["physical-local", "logical-synthesis"],
  "quick-start-lambda-smoke->build": ["physical-local"],
  "first-success->build": ["physical-local"],
  "package-entrypoints-smoke->build": ["physical-local", "logical-synthesis"],
  "package-entrypoints-smoke->typecheck": ["logical-synthesis"],
  "package-entrypoints-smoke->generated-app-smoke": ["logical-synthesis"],
  "packed-decorator-consumers->build": ["physical-local", "logical-synthesis"],
  "package-bins-smoke->build": ["physical-local", "logical-synthesis"],
  "generated-app-smoke->build": ["physical-local", "logical-synthesis"],
  "alpha-release-smoke->build": ["physical-local", "logical-synthesis"],
  "typecheck->build": ["physical-local"],
  "test->build": ["physical-local"],
  "test->typecheck": ["physical-local"],
  "integration-test-lane->build": ["physical-local"],
  "published-test-lane->build": ["physical-local", "logical-synthesis"],
  "test-evidence-reconcile->test": ["logical-synthesis"],
  "test-evidence-reconcile->integration-test-lane": ["logical-synthesis"],
  "test-evidence-reconcile->published-test-lane": ["logical-synthesis"],
  "test-evidence-reconcile->generated-app-smoke": ["logical-synthesis"],
  "cli-packed-e2e->integration-test-lane": ["physical-local"],
  "production-ready->build": ["logical-synthesis"],
  "production-ready->typecheck": ["logical-synthesis"],
  "production-ready->test": ["logical-synthesis"],
  "production-ready->test-evidence-reconcile": ["physical-local"],
  "spine-promotion->test": ["logical-synthesis"],
  "spine-promotion->generated-app-smoke": ["logical-synthesis"],
  "spine-promotion->provider-certification": ["logical-synthesis"],
  "spine-promotion->production-ready": ["physical-local"],
  "core-coverage->build": ["physical-local", "logical-synthesis"],
  "core-coverage-warning->core-coverage": ["physical-local"],
  "release-gate-tests->test": ["physical-local"],
  "spine-bundle-size->changeset-required": ["logical-synthesis"],
  "spine-bundle-size->lint": ["logical-synthesis"],
  "spine-bundle-size->format": ["logical-synthesis"],
  "spine-bundle-size->build": ["logical-synthesis"],
  "spine-bundle-size->typecheck": ["logical-synthesis"],
  "spine-bundle-size->test": ["logical-synthesis"],
  "spine-bundle-size->provider-certification": ["logical-synthesis"],
  "spine-bundle-size->production-ready": ["physical-local"],
  "spine-bundle-size->spine-promotion": ["physical-local"],
  "publish-dry-run->build": ["physical-local", "logical-synthesis"],
} as const satisfies Readonly<
  Record<VerificationDependencyEdge, readonly VerificationDependencyClassification[]>
>;

const WORKSPACE_ARTIFACT_CONCURRENCY_GROUP = new Set([
  "typecheck",
  "test",
  "package-bins-smoke",
  "generated-app-smoke",
  "alpha-release-smoke",
  "integration-test-lane",
  "published-test-lane",
  "cli-packed-e2e",
  "core-coverage",
  "publish-dry-run",
]);

const PACKAGE_ENTRYPOINT_CONCURRENCY_GROUP = new Set([
  "package-entrypoints-smoke",
  "integration-test-lane",
  "published-test-lane",
]);

function withSchedulingContract(
  command: EvidenceCommand,
  profile: VerificationProfile,
): EvidenceCommand {
  const dependencies = VERIFICATION_DEPENDENCIES[command.id];
  const dependsOn =
    profile === "publish" && command.id === "build"
      ? [...(dependencies ?? []), "release-metadata"]
      : dependencies;
  const writesWorkspaceArtifacts =
    WORKSPACE_ARTIFACT_CONCURRENCY_GROUP.has(command.id) ||
    (command.id === "package-entrypoints-smoke" && command.command.includes("--build-missing"));
  const concurrencyGroups = [
    ...(writesWorkspaceArtifacts ? ["workspace-artifacts"] : []),
    ...(PACKAGE_ENTRYPOINT_CONCURRENCY_GROUP.has(command.id) ? ["package-entrypoints"] : []),
    ...(["test", "integration-test-lane", "published-test-lane", "core-coverage"].includes(
      command.id,
    )
      ? ["test-integration"]
      : []),
  ];
  return {
    ...command,
    ...(dependsOn ? { dependsOn } : {}),
    ...(concurrencyGroups.length > 0 ? { concurrencyGroups } : {}),
  };
}

export function assertVerificationManifest(commands: readonly EvidenceCommand[]): void {
  const seen = new Set<string>();
  const indexes = new Map<string, number>();
  for (const [index, command] of commands.entries()) {
    indexes.set(command.id, index);
  }
  for (const command of commands) {
    if (seen.has(command.id)) {
      throw new VerificationProblem(
        "DUPLICATE_VERIFICATION_COMMAND_ID",
        "contract",
        `Duplicate verification command ID: ${command.id}`,
      );
    }
    seen.add(command.id);
    if (command.command[0] === "pnpm") {
      const invoked = command.command[1];
      if (invoked && (PROHIBITED_ROOT_ALIASES.has(invoked) || invoked.startsWith("verify:"))) {
        throw new VerificationProblem(
          "COMPOSITE_VERIFICATION_ALIAS",
          "contract",
          `Composite root alias is not allowed in verification manifest: ${invoked}`,
        );
      }
    }
    const concurrencyGroups = command.concurrencyGroups ?? [];
    if (concurrencyGroups.some((group) => group.trim().length === 0)) {
      throw new VerificationProblem(
        "EMPTY_VERIFICATION_CONCURRENCY_GROUP",
        "contract",
        `Verification command ${command.id} has an empty concurrency group.`,
      );
    }
    if (new Set(concurrencyGroups).size !== concurrencyGroups.length) {
      throw new VerificationProblem(
        "DUPLICATE_VERIFICATION_CONCURRENCY_GROUP",
        "contract",
        `Verification command ${command.id} declares a duplicate concurrency group.`,
      );
    }
    for (const dependency of command.dependsOn ?? []) {
      if (dependency === command.id) {
        throw new VerificationProblem(
          "SELF_VERIFICATION_DEPENDENCY",
          "contract",
          `Verification command ${command.id} cannot depend on itself.`,
        );
      }
      if (!indexes.has(dependency)) {
        throw new VerificationProblem(
          "UNKNOWN_VERIFICATION_DEPENDENCY",
          "contract",
          `Verification command ${command.id} depends on unknown command ${dependency}.`,
        );
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(commands.map((command) => [command.id, command]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new VerificationProblem(
        "CYCLIC_VERIFICATION_DEPENDENCY",
        "contract",
        `Verification command dependency graph contains a cycle involving ${id}.`,
      );
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const command of commands) visit(command.id);

  const spineBundleIndex = indexes.get("spine-bundle-size");
  if (spineBundleIndex !== undefined) {
    const spineBundle = byId.get("spine-bundle-size");
    for (const prerequisiteId of PACKAGE_QUALITY_STATUS_PREREQUISITES) {
      if (!spineBundle?.dependsOn?.includes(prerequisiteId)) {
        throw new VerificationProblem(
          "PACKAGE_QUALITY_STATUS_DEPENDENCY",
          "contract",
          `${prerequisiteId} must be a prerequisite of spine-bundle-size so package quality dashboard status values are already known.`,
        );
      }
    }
  }
}

export function createVerificationManifest(
  profile: VerificationProfile,
  context: VerificationContext = {},
): readonly EvidenceCommand[] {
  const spine = spineOnly(context, profile);
  const fastTest = spine.find(({ id }) => id === "test");
  const fastTestCoversRepositoryContracts =
    profile !== "repo" &&
    fastTest?.applicable === true &&
    (!fastTest.command.includes("--owner") || fastTest.command.includes("repo:ci"));
  const repo = repoOnly(
    context,
    profile,
    profile === "publish" || fastTestCoversRepositoryContracts,
  );
  const publish = profile === "publish" ? publishOnly(context) : [];
  const commands = (
    profile === "repo"
      ? repo
      : profile === "spine"
        ? [...repo, ...spine]
        : [
            ...publish.filter(({ id }) => id === "release-metadata"),
            ...repo,
            ...spine,
            ...publish.filter(({ id }) => id !== "release-metadata"),
          ]
  ).map((command) => withSchedulingContract(command, profile));
  assertVerificationManifest(commands);
  return commands;
}

export type VerificationLaneDependency = {
  readonly classifications: readonly VerificationDependencyClassification[];
  readonly dependentId: string;
  readonly dependentLane: VerificationLane;
  readonly prerequisiteId: string;
  readonly prerequisiteLane: VerificationLane;
};

export type VerificationLaneManifest = {
  readonly commands: readonly EvidenceCommand[];
  readonly dependencies: readonly VerificationLaneDependency[];
  readonly lane: VerificationLane;
  readonly physicalLocalPrerequisites: readonly EvidenceCommand[];
};

function verificationDependencyEdge(dependentId: string, prerequisiteId: string): string {
  return `${dependentId}->${prerequisiteId}`;
}

function verificationDependencyClassifications(
  dependentId: string,
  prerequisiteId: string,
): readonly VerificationDependencyClassification[] {
  const edge = verificationDependencyEdge(dependentId, prerequisiteId);
  const classifications =
    VERIFICATION_DEPENDENCY_CLASSIFICATION[edge as VerificationDependencyEdge];
  if (!classifications || classifications.length === 0) {
    throw new VerificationProblem(
      "UNCLASSIFIED_VERIFICATION_DEPENDENCY",
      "contract",
      `Verification dependency ${edge} is unknown or unclassified.`,
    );
  }
  return classifications;
}

function assertVerificationLaneContract(commands: readonly EvidenceCommand[]): void {
  const commandIds = commands.map(({ id }) => id);
  const commandIdSet = new Set(commandIds);
  const declaredIds = Object.keys(VERIFICATION_LANE_OWNERSHIP);
  if (
    commandIds.length !== VERIFICATION_COMMAND_IDS.length ||
    commandIdSet.size !== VERIFICATION_COMMAND_IDS.length ||
    VERIFICATION_COMMAND_IDS.some((id) => !commandIdSet.has(id)) ||
    declaredIds.length !== VERIFICATION_COMMAND_IDS.length ||
    declaredIds.some((id) => !commandIdSet.has(id))
  ) {
    throw new VerificationProblem(
      "VERIFICATION_LANE_OWNERSHIP_COVERAGE",
      "contract",
      "Verification lane ownership must cover every publish verification command exactly once.",
    );
  }

  const expectedEdges = new Set(
    commands.flatMap((command) =>
      (command.dependsOn ?? []).map((prerequisiteId) =>
        verificationDependencyEdge(command.id, prerequisiteId),
      ),
    ),
  );
  const classifiedEdges = Object.keys(VERIFICATION_DEPENDENCY_CLASSIFICATION);
  if (
    expectedEdges.size !== classifiedEdges.length ||
    classifiedEdges.some((edge) => !expectedEdges.has(edge))
  ) {
    throw new VerificationProblem(
      "VERIFICATION_DEPENDENCY_CLASSIFICATION_COVERAGE",
      "contract",
      "Every verification dependency edge must have exactly one declared classification record.",
    );
  }

  for (const command of commands) {
    const dependentLane = VERIFICATION_LANE_OWNERSHIP[command.id as VerificationCommandId];
    if (!dependentLane) {
      throw new VerificationProblem(
        "UNKNOWN_VERIFICATION_LANE_OWNER",
        "contract",
        `Verification command ${command.id} has no lane owner.`,
      );
    }
    for (const prerequisiteId of command.dependsOn ?? []) {
      const prerequisiteLane = VERIFICATION_LANE_OWNERSHIP[prerequisiteId as VerificationCommandId];
      if (!prerequisiteLane) {
        throw new VerificationProblem(
          "UNCLASSIFIED_VERIFICATION_DEPENDENCY",
          "contract",
          `Verification dependency ${command.id}->${prerequisiteId} is unknown or unclassified.`,
        );
      }
      const classifications = verificationDependencyClassifications(command.id, prerequisiteId);
      if (new Set(classifications).size !== classifications.length) {
        throw new VerificationProblem(
          "AMBIGUOUS_VERIFICATION_DEPENDENCY_CLASSIFICATION",
          "contract",
          `Verification dependency ${command.id}->${prerequisiteId} repeats a classification.`,
        );
      }
      if (dependentLane !== prerequisiteLane && !classifications.includes("logical-synthesis")) {
        throw new VerificationProblem(
          "CROSS_LANE_DEPENDENCY_WITHOUT_SYNTHESIS",
          "contract",
          `Cross-lane dependency ${command.id}->${prerequisiteId} must be enforced by synthesis.`,
        );
      }
    }
  }
}

export function createVerificationLaneManifest(
  profile: VerificationProfile,
  lane: VerificationLane,
  context: VerificationContext = {},
): VerificationLaneManifest {
  if (!VERIFICATION_LANES.includes(lane)) {
    throw new VerificationProblem(
      "UNKNOWN_VERIFICATION_LANE",
      "input",
      `Unknown verification lane: ${lane}`,
    );
  }
  const manifest = createVerificationManifest(profile, context);
  assertVerificationLaneContract(
    profile === "publish" ? manifest : createVerificationManifest("publish", context),
  );
  const byId = new Map(manifest.map((command) => [command.id, command]));
  const commands = manifest.filter(
    ({ id }) => VERIFICATION_LANE_OWNERSHIP[id as VerificationCommandId] === lane,
  );
  const dependencies = commands.flatMap((command) =>
    (command.dependsOn ?? []).map(
      (prerequisiteId): VerificationLaneDependency => ({
        classifications: verificationDependencyClassifications(command.id, prerequisiteId),
        dependentId: command.id,
        dependentLane: lane,
        prerequisiteId,
        prerequisiteLane: VERIFICATION_LANE_OWNERSHIP[prerequisiteId as VerificationCommandId],
      }),
    ),
  );

  const physicalPrerequisiteIds = new Set<string>();
  const visited = new Set<string>();
  const visitPhysicalPrerequisites = (command: EvidenceCommand): void => {
    if (visited.has(command.id)) return;
    visited.add(command.id);
    for (const prerequisiteId of command.dependsOn ?? []) {
      const classifications = verificationDependencyClassifications(command.id, prerequisiteId);
      if (!classifications.includes("physical-local")) continue;
      const prerequisite = byId.get(prerequisiteId);
      if (!prerequisite) {
        throw new VerificationProblem(
          "MISSING_PHYSICAL_LOCAL_PREREQUISITE",
          "contract",
          `Physical-local prerequisite ${prerequisiteId} is absent from the ${profile} manifest.`,
        );
      }
      if (VERIFICATION_LANE_OWNERSHIP[prerequisiteId as VerificationCommandId] !== lane) {
        physicalPrerequisiteIds.add(prerequisiteId);
      }
      visitPhysicalPrerequisites(prerequisite);
    }
  };
  for (const command of commands) {
    if (command.applicable !== false) visitPhysicalPrerequisites(command);
  }

  return {
    commands,
    dependencies,
    lane,
    physicalLocalPrerequisites: manifest.filter(({ id }) => physicalPrerequisiteIds.has(id)),
  };
}

export function getVerificationCommand(
  id: string,
  context: VerificationContext = {},
): EvidenceCommand {
  const command = createVerificationManifest("publish", context).find(
    (candidate) => candidate.id === id,
  );
  if (!command) {
    throw new VerificationProblem(
      "UNKNOWN_VERIFICATION_COMMAND_ID",
      "input",
      `Unknown verification command ID: ${id}`,
    );
  }
  return command;
}

export function verificationImplementationPaths(): readonly string[] {
  const paths = new Set<string>();
  for (const definition of createVerificationManifest("publish")) {
    for (const argument of definition.command) {
      if (/^scripts\/[^/]+\.(?:mts|mjs|ts)$/.test(argument)) paths.add(argument);
    }
  }
  return [...paths].sort();
}
