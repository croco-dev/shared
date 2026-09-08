#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  checkArchitecturePolicy,
  formatArchitecturePolicyDiagnostic,
  readArchitecturePolicyManifest,
} from "../packages/architecture-policy/src/index.ts";
import type { ArchitecturePolicyManifest } from "../packages/architecture-policy/src/index.ts";

import { loadPackageRoles } from "./package-roles.mts";

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

const packageCatalogPath = join("docs", "package-catalog.json");

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
  if (!existsSync(join(rootDir, packageCatalogPath))) {
    violations.push({
      message: "docs/package-catalog.json is missing",
      recovery: "Restore docs/package-catalog.json before running architecture policy checks.",
      evidence: packageCatalogPath,
    });
  } else {
    const { roles, errors } = loadPackageRoles(
      rootDir,
      packages.map((pkg) => pkg.shortName),
    );
    for (const message of errors) {
      violations.push({
        message,
        recovery: "Correct docs/package-catalog.json packageRoles metadata.",
        evidence: packageCatalogPath,
      });
    }
    for (const pkg of packages) {
      const role = roles[pkg.shortName];
      if (!role) continue;
      const groups = findMatchingArchitecturePackageGroups(options.manifest, pkg).filter(
        (group) => group !== "desktop-contracts" || pkg.name !== "@croco/protocols-desktop",
      );
      const expected = role.role.toLowerCase();
      if (groups.length !== 1 || groups[0] !== expected) {
        violations.push({
          message: `public package ${pkg.name} has canonical role ${role.role} but croco.arch.json assigns ${groups.length ? groups.join(", ") : "no group"}`,
          recovery: `Assign ${pkg.name} to exactly packageGroups.${expected}; role overrides are not supported.`,
          evidence: relative(rootDir, options.manifestPath),
        });
      }
    }
  }
  if (options.manifest.packageCatalogGroupOverrides !== undefined) {
    violations.push({
      message: "packageCatalogGroupOverrides is obsolete",
      recovery: "Remove packageCatalogGroupOverrides and align packageGroups with packageRoles.",
      evidence: relative(rootDir, options.manifestPath),
    });
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
