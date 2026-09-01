#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  checkArchitecturePolicy,
  formatArchitecturePolicyDiagnostic,
  readArchitecturePolicyManifest,
} from "../packages/architecture-policy/src/index.ts";
import type { ArchitecturePolicyManifest } from "../packages/architecture-policy/src/index.ts";

type Options = {
  readonly manifest: string;
  readonly rootDir: string;
  readonly json: boolean;
};

type PackageJson = {
  readonly name?: unknown;
  readonly private?: unknown;
};

type WorkspacePackage = {
  readonly name: string;
  readonly relativeDir: string;
  readonly shortName: string;
};

type PackageCatalogGroupOverride = {
  readonly catalogGroup: string;
  readonly packageName: string;
  readonly policyGroup: string;
  readonly reason: string;
};

type PackageCatalogGroupViolation = {
  readonly message: string;
  readonly recovery: string;
  readonly evidence: string;
};

type PackageCatalogGroupConsistencyReport = {
  readonly status: "pass" | "fail";
  readonly packageCount: number;
  readonly violationCount: number;
  readonly violations: readonly PackageCatalogGroupViolation[];
};

type CatalogMetadata = {
  readonly groups?: unknown;
};

const packageCatalogPath = join("docs", "package-catalog.json");
const packageCatalogGroupToPolicyGroup = new Map<string, string>([
  ["Core", "framework"],
  ["Domain", "framework"],
  ["Provider", "integrations"],
  ["Integration", "integrations"],
  ["Protocol", "protocols"],
  ["Transport", "transports"],
  ["Host", "hosts"],
  ["Build Target", "build-targets"],
  ["Presentation", "presentation"],
  ["Tooling", "app"],
]);

function parseArgs(args: readonly string[]): Options {
  let manifest = "croco.arch.json";
  let rootDir = process.cwd();
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--manifest") {
      const value = readFlagValue(args, index, "--manifest");
      manifest = value;
      index += 1;
      continue;
    }

    if (arg === "--root") {
      const value = readFlagValue(args, index, "--root");
      rootDir = value;
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    manifest,
    rootDir,
    json,
  };
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a path`);
  }

  return value;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = resolveManifestPath(options.rootDir, options.manifest);
  const manifest = readArchitecturePolicyManifest(manifestPath);
  const report = checkArchitecturePolicy({
    rootDir: options.rootDir,
    manifest,
  });
  const packageCatalogGroupConsistency = checkPackageCatalogGroupConsistency({
    rootDir: options.rootDir,
    manifest,
    manifestPath,
  });
  const status =
    report.status === "fail" || packageCatalogGroupConsistency.status === "fail" ? "fail" : "pass";

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...report,
          status,
          packageCatalogGroupConsistency,
        },
        null,
        2,
      ),
    );
  } else {
    for (const diagnostic of report.diagnostics) {
      console.error(formatArchitecturePolicyDiagnostic(diagnostic));
      if (diagnostic.recovery) {
        console.error(`  action: ${diagnostic.recovery}`);
      }
      console.error(`  evidence: ${diagnostic.excerpt}`);
    }

    for (const violation of packageCatalogGroupConsistency.violations) {
      console.error(formatPackageCatalogGroupViolation(violation));
      console.error(`  action: ${violation.recovery}`);
      console.error(`  evidence: ${violation.evidence}`);
    }
  }

  if (status === "fail") {
    const diagnosticCount =
      report.diagnostics.length + packageCatalogGroupConsistency.violationCount;
    console.error(`architecture-policy: ${diagnosticCount} diagnostic(s)`);
    process.exit(1);
  }

  console.log(
    `architecture-policy: passed for ${report.importCount} import(s) across ${report.packageCount} package(s)`,
  );
  console.log(
    `architecture-policy: package catalog group consistency passed for ${packageCatalogGroupConsistency.packageCount} public package(s)`,
  );
}

function resolveManifestPath(rootDir: string, manifestPath: string): string {
  return resolve(rootDir, manifestPath);
}

function checkPackageCatalogGroupConsistency(options: {
  readonly rootDir: string;
  readonly manifest: ArchitecturePolicyManifest;
  readonly manifestPath: string;
}): PackageCatalogGroupConsistencyReport {
  const rootDir = resolve(options.rootDir);
  const violations: PackageCatalogGroupViolation[] = [];
  const packages = readPublicWorkspacePackages(
    rootDir,
    options.manifest.packageRoots ?? ["packages"],
  );
  const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const packageByShortName = new Map(packages.map((pkg) => [pkg.shortName, pkg]));
  const catalogGroups = readPackageCatalogGroups(rootDir, packageByShortName, violations);
  const overrides = readPackageCatalogGroupOverrides(
    options.manifest.packageCatalogGroupOverrides,
    packageByName,
    violations,
  );
  const overridesByPackage = new Map(overrides.map((override) => [override.packageName, override]));

  for (const pkg of packages) {
    const catalogGroupMatches = catalogGroups.get(pkg.shortName) ?? [];
    const architectureGroupMatches = findMatchingArchitecturePackageGroups(options.manifest, pkg);

    if (catalogGroupMatches.length === 0) {
      violations.push({
        message: `public package ${pkg.shortName} is missing package catalog group metadata`,
        recovery: `Add ${pkg.shortName} to exactly one docs/package-catalog.json groups.*.packages array.`,
        evidence: packageCatalogPath,
      });
      continue;
    }

    if (catalogGroupMatches.length > 1) {
      violations.push({
        message: `package ${pkg.shortName} appears in multiple package catalog groups (${catalogGroupMatches.join(", ")})`,
        recovery: `Keep ${pkg.shortName} in one catalog group before comparing architecture policy group membership.`,
        evidence: packageCatalogPath,
      });
      continue;
    }

    if (architectureGroupMatches.length === 0) {
      violations.push({
        message: `public package ${pkg.name} is not classified by croco.arch.json packageGroups`,
        recovery: `Add ${pkg.name} to exactly one croco.arch.json packageGroups entry or add a matching package pattern.`,
        evidence: relative(rootDir, options.manifestPath),
      });
      continue;
    }

    if (architectureGroupMatches.length > 1) {
      violations.push({
        message: `public package ${pkg.name} matches multiple croco.arch.json packageGroups (${architectureGroupMatches.join(", ")})`,
        recovery: `Make ${pkg.name} match exactly one architecture policy package group.`,
        evidence: relative(rootDir, options.manifestPath),
      });
      continue;
    }

    const catalogGroup = catalogGroupMatches[0];
    const policyGroup = architectureGroupMatches[0];
    const expectedPolicyGroup = packageCatalogGroupToPolicyGroup.get(catalogGroup);
    if (!expectedPolicyGroup) {
      violations.push({
        message: `package ${pkg.shortName} uses unsupported package catalog group ${catalogGroup}`,
        recovery: `Add an architecture-policy mapping for catalog group ${catalogGroup} before using it.`,
        evidence: packageCatalogPath,
      });
      continue;
    }

    const override = overridesByPackage.get(pkg.name);
    const overrideMatchesActual =
      override?.catalogGroup === catalogGroup && override.policyGroup === policyGroup;
    const groupMismatch = policyGroup !== expectedPolicyGroup;

    if (override && !overrideMatchesActual) {
      violations.push({
        message: `packageCatalogGroupOverrides entry for ${pkg.name} expects catalog=${override.catalogGroup} policy=${override.policyGroup} but actual catalog=${catalogGroup} policy=${policyGroup}`,
        recovery: `Update or remove the stale override for ${pkg.name}.`,
        evidence: relative(rootDir, options.manifestPath),
      });
      continue;
    }

    if (override && !groupMismatch) {
      violations.push({
        message: `packageCatalogGroupOverrides entry for ${pkg.name} is no longer needed`,
        recovery: `Remove the override now that ${pkg.name} has matching catalog and architecture policy groups.`,
        evidence: relative(rootDir, options.manifestPath),
      });
      continue;
    }

    if (groupMismatch && !overrideMatchesActual) {
      violations.push({
        message: `package ${pkg.name} catalog group ${catalogGroup} maps to policy group ${expectedPolicyGroup} but croco.arch.json assigns ${policyGroup}`,
        recovery: `Move ${pkg.name} to packageGroups.${expectedPolicyGroup} or add a packageCatalogGroupOverrides entry with package, catalogGroup, policyGroup, and reason.`,
        evidence: relative(rootDir, options.manifestPath),
      });
      continue;
    }
  }

  return {
    status: violations.length > 0 ? "fail" : "pass",
    packageCount: packages.length,
    violationCount: violations.length,
    violations,
  };
}

function readPublicWorkspacePackages(
  rootDir: string,
  packageRoots: readonly string[],
): readonly WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];

  for (const packageJsonPath of packageRoots.flatMap((packageRoot) =>
    findPackageJsonFiles(join(rootDir, packageRoot)),
  )) {
    const packageJson = readJsonFile<PackageJson>(packageJsonPath);
    if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
      throw new Error(`${relative(rootDir, packageJsonPath)} is missing a string name`);
    }

    if (packageJson.private === true) {
      continue;
    }

    packages.push({
      name: packageJson.name,
      relativeDir: toPosixPath(relative(rootDir, dirname(packageJsonPath))),
      shortName: toShortPackageName(packageJson.name),
    });
  }

  return packages.sort((left, right) => {
    const byShortName = left.shortName.localeCompare(right.shortName);
    return byShortName === 0 ? left.relativeDir.localeCompare(right.relativeDir) : byShortName;
  });
}

function readPackageCatalogGroups(
  rootDir: string,
  packageByShortName: ReadonlyMap<string, WorkspacePackage>,
  violations: PackageCatalogGroupViolation[],
): ReadonlyMap<string, readonly string[]> {
  const catalogPath = join(rootDir, packageCatalogPath);
  if (!existsSync(catalogPath)) {
    violations.push({
      message: "docs/package-catalog.json is missing",
      recovery: "Restore docs/package-catalog.json before running architecture policy checks.",
      evidence: packageCatalogPath,
    });
    return new Map();
  }

  const metadata = readJsonFile<CatalogMetadata>(catalogPath);
  if (!isRecord(metadata.groups)) {
    violations.push({
      message: "docs/package-catalog.json groups must be an object",
      recovery: "Restore package catalog group metadata before running architecture policy checks.",
      evidence: packageCatalogPath,
    });
    return new Map();
  }

  const assignments = new Map<string, string[]>();
  for (const [groupName, groupConfig] of Object.entries(metadata.groups)) {
    if (!isRecord(groupConfig)) {
      violations.push({
        message: `docs/package-catalog.json groups.${groupName} must be an object`,
        recovery: `Make groups.${groupName} contain a packages string array.`,
        evidence: packageCatalogPath,
      });
      continue;
    }

    const packageNames = readStringArray(groupConfig.packages);
    if (!packageNames) {
      violations.push({
        message: `docs/package-catalog.json groups.${groupName}.packages must be a string array`,
        recovery: `Set groups.${groupName}.packages to the package short names assigned to ${groupName}.`,
        evidence: packageCatalogPath,
      });
      continue;
    }

    for (const packageName of packageNames) {
      if (!packageByShortName.has(packageName)) {
        violations.push({
          message: `package catalog group ${groupName} references missing public package ${packageName}`,
          recovery: `Remove ${packageName} from docs/package-catalog.json or restore packages/${packageName}.`,
          evidence: packageCatalogPath,
        });
        continue;
      }

      const current = assignments.get(packageName) ?? [];
      current.push(groupName);
      assignments.set(packageName, current);
    }
  }

  return assignments;
}

function readPackageCatalogGroupOverrides(
  value: unknown,
  packageByName: ReadonlyMap<string, WorkspacePackage>,
  violations: PackageCatalogGroupViolation[],
): PackageCatalogGroupOverride[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    violations.push({
      message: "croco.arch.json packageCatalogGroupOverrides must be an array",
      recovery:
        "Set packageCatalogGroupOverrides to an array of explicit package override objects.",
      evidence: "croco.arch.json",
    });
    return [];
  }

  const overrides: PackageCatalogGroupOverride[] = [];
  const seenPackages = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const location = `croco.arch.json packageCatalogGroupOverrides[${index}]`;
    if (!isRecord(entry)) {
      violations.push({
        message: `${location} must be an object`,
        recovery: "Each override must include package, catalogGroup, policyGroup, and reason.",
        evidence: "croco.arch.json",
      });
      continue;
    }

    const packageName = readNonEmptyString(entry.package);
    const catalogGroup = readNonEmptyString(entry.catalogGroup);
    const policyGroup = readNonEmptyString(entry.policyGroup);
    const reason = readNonEmptyString(entry.reason);
    if (!packageName || !catalogGroup || !policyGroup || !reason) {
      violations.push({
        message: `${location} must include non-empty package, catalogGroup, policyGroup, and reason fields`,
        recovery:
          "Make the override explicit enough to review why catalog and policy group membership differ.",
        evidence: "croco.arch.json",
      });
      continue;
    }

    if (!packageByName.has(packageName)) {
      violations.push({
        message: `${location} references missing public package ${packageName}`,
        recovery: `Remove the override or restore the public workspace package named ${packageName}.`,
        evidence: "croco.arch.json",
      });
      continue;
    }

    if (seenPackages.has(packageName)) {
      violations.push({
        message: `${location} duplicates an override for ${packageName}`,
        recovery: `Keep one packageCatalogGroupOverrides entry for ${packageName}.`,
        evidence: "croco.arch.json",
      });
      continue;
    }

    seenPackages.add(packageName);
    overrides.push({
      packageName,
      catalogGroup,
      policyGroup,
      reason,
    });
  }

  return overrides;
}

function findMatchingArchitecturePackageGroups(
  manifest: ArchitecturePolicyManifest,
  pkg: WorkspacePackage,
): readonly string[] {
  const matches = new Set<string>();
  const groups = Object.entries(manifest.packageGroups ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  for (const [groupName, group] of groups) {
    if (matchesAnyPattern(pkg.name, group.packages ?? [])) {
      matches.add(groupName);
    }

    if (matchesAnyPattern(pkg.relativeDir, group.paths ?? [])) {
      matches.add(groupName);
    }
  }

  return [...matches].sort((left, right) => left.localeCompare(right));
}

function formatPackageCatalogGroupViolation(violation: PackageCatalogGroupViolation): string {
  return `ERROR architecture-policy/package-catalog-group: ${violation.message}`;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }

  return value;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toShortPackageName(packageName: string): string {
  return packageName.startsWith("@croco/") ? packageName.slice("@croco/".length) : packageName;
}

function findPackageJsonFiles(dir: string, results: string[] = []): string[] {
  if (!existsSync(dir)) {
    return results;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }
      findPackageJsonFiles(fullPath, results);
      continue;
    }

    if (entry.isFile() && entry.name === "package.json") {
      results.push(fullPath);
    }
  }

  return results.sort();
}

function shouldSkipDirectory(name: string): boolean {
  return name === "node_modules" || name === "dist" || name === "build" || name === ".turbo";
}

function toPosixPath(value: string): string {
  return value.split("\\").join("/");
}

function matchesAnyPattern(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function matchesPattern(value: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(value);
}

function patternToRegExp(pattern: string): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
        continue;
      }
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`architecture-policy: failed: ${message}`);
  process.exit(1);
}
