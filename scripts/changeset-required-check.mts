#!/usr/bin/env node

/**
 * Enforce release metadata for publishable package behavior changes.
 *
 * Narrow exemptions:
 * - package docs and tests do not require a changeset;
 * - adding the canonical CI-only API model script does not change published behavior;
 * - private packages do not require a changeset;
 * - root-only lockfile/package-manager changes do not require a changeset here;
 * - public API snapshot-only changes may instead carry an explicit no-release reason;
 * - .changeset/README.md is documentation and never counts as a release changeset.
 */

import parseChangesetFile from "@changesets/parse";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { env, exit, stdout } from "node:process";

import { isCiScriptOnlyManifestChange } from "./package-manifest-contracts.mjs";

type CheckOptions = {
  readonly baseRef: string;
  readonly headRef: string;
  readonly rootDir: string;
};

type PackageInfo = {
  readonly name: string;
  readonly private: boolean;
  readonly relativeDir: string;
};

type ReleaseSignificantChange = {
  readonly files: string[];
  readonly surface: string;
  readonly changedExportPaths?: string[];
};

type PublicApiSnapshotPackage = {
  readonly packageName: string;
  readonly entrypoints: ReadonlyMap<string, string>;
  readonly metadataKey: string;
  readonly migrationRootKey: string | null;
};

type PublicApiSnapshotData = {
  readonly schemaVersion: number;
  readonly packages: readonly PublicApiSnapshotPackage[];
};

type PublicApiSnapshotChange = {
  readonly packageName: string;
  readonly changedExportPaths: readonly string[];
};

type NoReleaseJustification = {
  readonly reason: string;
  readonly source: string;
};

type ChangedChangesetMetadata = {
  readonly activePackageNames: ReadonlySet<string>;
  readonly consumedPackageNames: ReadonlySet<string>;
  readonly referencedPackageNames: ReadonlySet<string>;
  readonly invalidFiles: readonly InvalidChangesetFile[];
};

type InvalidChangesetFile = {
  readonly file: string;
  readonly state: "active" | "consumed";
};

type ChangesetCoverage = {
  readonly privateNames: readonly string[];
  readonly unknownNames: readonly string[];
  readonly uncoveredPackages: ReadonlyMap<string, ReleaseSignificantChange>;
};

const realChangesetPattern = /^\.changeset\/[^/]+\.md$/;
const noReleaseReasonLinePattern = /^Changeset-required no-release reason:\s*(.+)$/im;
const publicApiSnapshotPath = "public-api-surface.snapshot.json";
const createCrocoAppRangeMetadataPath = "packages/create-croco-app/src/helpers/croco-ranges.ts";
const testFilePattern = /(?:^|[.-])(spec|test)\.[cm]?[jt]sx?$/;
const dependencyVersionFields = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const supportedChangesetBumpTypes: ReadonlySet<string> = new Set([
  "major",
  "minor",
  "patch",
  "none",
]);
const gitMaxBufferBytes = 16 * 1024 * 1024;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const internalVersionRangePattern =
  /^(?:workspace:)?(?:[\^~])?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$|^workspace:\*$/;

function log(message: string): void {
  stdout.write(`${message}\n`);
}

function runGit(rootDir: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: rootDir,
    encoding: "utf-8",
    maxBuffer: gitMaxBufferBytes,
  });

  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }

  if (result.status !== 0) {
    const details = [
      result.stderr?.trim(),
      result.signal ? `terminated by ${result.signal}` : undefined,
    ].filter((detail): detail is string => Boolean(detail));
    const suffix = details.length > 0 ? `: ${details.join("; ")}` : "";
    throw new Error(`git ${args.join(" ")} failed${suffix}`);
  }

  return result.stdout.trim();
}

function parseArgs(args: readonly string[]): CheckOptions {
  let rootDir = process.cwd();
  let baseRef = env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : "trunk";
  let headRef = "HEAD";

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
      index++;
      continue;
    }

    if (arg === "--base") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--base requires a git ref");
      }
      baseRef = value;
      index++;
      continue;
    }

    if (arg === "--head") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--head requires a git ref");
      }
      headRef = value;
      index++;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    baseRef,
    headRef,
    rootDir,
  };
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function getChangedFiles(options: CheckOptions): string[] {
  runGit(options.rootDir, ["rev-parse", "--verify", `${options.baseRef}^{commit}`]);
  runGit(options.rootDir, ["rev-parse", "--verify", `${options.headRef}^{commit}`]);

  const output = runGit(options.rootDir, [
    "diff",
    "--name-only",
    "--diff-filter=ACMRD",
    `${options.baseRef}...${options.headRef}`,
  ]);

  return output
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean)
    .map(toPosixPath);
}

function findPackageJsonFiles(dir: string, results: string[] = []): string[] {
  if (!existsSync(dir)) {
    return results;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
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

function readPackages(rootDir: string): PackageInfo[] {
  return findPackageJsonFiles(join(rootDir, "packages"))
    .map((packageJsonPath) => {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      const relativeDir = toPosixPath(
        relative(rootDir, packageJsonPath).replace(/\/package\.json$/, ""),
      );

      if (typeof pkg.name !== "string") {
        throw new Error(`${relativeDir}/package.json is missing a string name`);
      }

      return {
        name: pkg.name,
        private: pkg.private === true,
        relativeDir,
      };
    })
    .sort((left, right) => right.relativeDir.length - left.relativeDir.length);
}

function getOwningPackage(file: string, packages: readonly PackageInfo[]): PackageInfo | null {
  return (
    packages.find((pkg) => file === pkg.relativeDir || file.startsWith(`${pkg.relativeDir}/`)) ??
    null
  );
}

function isRealChangesetPath(file: string): boolean {
  return realChangesetPattern.test(file) && basename(file) !== "README.md";
}

type ParsedChangesetPackageNames = {
  readonly referencedPackageNames: ReadonlySet<string>;
  readonly releasePackageNames: ReadonlySet<string>;
};

function parseChangesetPackageNames(content: string): ParsedChangesetPackageNames {
  const parsed = parseChangesetFile(content);
  const referencedPackageNames = new Set<string>();
  const releasePackageNames = new Set<string>();

  for (const release of parsed.releases) {
    if (!supportedChangesetBumpTypes.has(release.type)) {
      throw new Error(`changeset release type '${release.type}' is not supported`);
    }
    referencedPackageNames.add(release.name);
    if (release.type !== "none") {
      releasePackageNames.add(release.name);
    }
  }

  return {
    referencedPackageNames,
    releasePackageNames,
  };
}

function getChangedChangesetMetadata(
  options: CheckOptions,
  changedFiles: readonly string[],
): ChangedChangesetMetadata {
  const activePackageNames = new Set<string>();
  const consumedPackageNames = new Set<string>();
  const referencedPackageNames = new Set<string>();
  const invalidFiles: InvalidChangesetFile[] = [];

  for (const file of changedFiles) {
    if (!isRealChangesetPath(file)) {
      continue;
    }

    let content: string;
    let state: InvalidChangesetFile["state"];
    try {
      content = runGit(options.rootDir, ["show", `${options.headRef}:${file}`]);
      state = "active";
    } catch {
      // Changed changesets absent at HEAD were consumed; the base lookup fails closed if unavailable.
      content = runGit(options.rootDir, ["show", `${options.baseRef}:${file}`]);
      state = "consumed";
    }

    try {
      const parsed = parseChangesetPackageNames(content);
      for (const packageName of parsed.referencedPackageNames) {
        referencedPackageNames.add(packageName);
      }
      for (const packageName of parsed.releasePackageNames) {
        (state === "active" ? activePackageNames : consumedPackageNames).add(packageName);
      }
    } catch {
      invalidFiles.push({ file, state });
    }
  }

  return {
    activePackageNames,
    consumedPackageNames,
    referencedPackageNames,
    invalidFiles,
  };
}

function getChangesetCoverage(
  changesets: ChangedChangesetMetadata,
  packages: readonly PackageInfo[],
  significantChanges: ReadonlyMap<string, ReleaseSignificantChange>,
): ChangesetCoverage {
  const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg] as const));
  const validPublishableNames = new Set<string>();
  const privateNames: string[] = [];
  const unknownNames: string[] = [];

  for (const packageName of [...changesets.referencedPackageNames].sort()) {
    const pkg = packageByName.get(packageName);
    if (!pkg) {
      unknownNames.push(packageName);
    } else if (pkg.private) {
      privateNames.push(packageName);
    } else if (changesets.activePackageNames.has(packageName)) {
      validPublishableNames.add(packageName);
    }
  }

  const uncoveredPackages = new Map(
    [...significantChanges]
      .filter(([packageName]) => !validPublishableNames.has(packageName))
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    privateNames,
    unknownNames,
    uncoveredPackages,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObjectAtRef(
  options: CheckOptions,
  ref: string,
  file: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(runGit(options.rootDir, ["show", `${ref}:${file}`])) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`${file} at ${ref} must contain a JSON object`);
    }

    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw error;
    }

    return null;
  }
}

function isEqualJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseSemver(value: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isSemverIncrease(baseVersion: string, headVersion: string): boolean {
  const base = parseSemver(baseVersion);
  const head = parseSemver(headVersion);
  if (!base || !head) {
    return false;
  }

  for (let index = 0; index < base.length; index++) {
    if (head[index] > base[index]) {
      return true;
    }

    if (head[index] < base[index]) {
      return false;
    }
  }

  return false;
}

function normalizeInternalDependencyRange(range: string): string | null {
  const match =
    /^workspace:([\^~]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(range) ??
    /^([\^~]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(range);

  if (!match?.[2]) {
    return null;
  }

  return `${match[1] ?? ""}${match[2]}`;
}

function internalDependencyRangeMatchesVersion(range: string, version: string): boolean {
  const normalizedRange = normalizeInternalDependencyRange(range);
  return (
    normalizedRange === version ||
    normalizedRange === `^${version}` ||
    normalizedRange === `~${version}`
  );
}

function isDependencyVersionMetadataChange(
  baseValue: unknown,
  headValue: unknown,
  packageVersions: ReadonlyMap<string, string>,
  versionedPackageNames: ReadonlySet<string>,
): boolean {
  if (!isRecord(baseValue) || !isRecord(headValue)) {
    return false;
  }

  const dependencyNames = new Set([...Object.keys(baseValue), ...Object.keys(headValue)]);
  for (const dependencyName of dependencyNames) {
    const baseRange = baseValue[dependencyName];
    const headRange = headValue[dependencyName];

    if (isEqualJson(baseRange, headRange)) {
      continue;
    }

    if (
      !packageVersions.has(dependencyName) ||
      !versionedPackageNames.has(dependencyName) ||
      typeof baseRange !== "string" ||
      typeof headRange !== "string" ||
      !internalVersionRangePattern.test(baseRange) ||
      !internalVersionRangePattern.test(headRange) ||
      !internalDependencyRangeMatchesVersion(headRange, packageVersions.get(dependencyName) ?? "")
    ) {
      return false;
    }
  }

  return true;
}

function isGeneratedVersionManifestChange(
  options: CheckOptions,
  file: string,
  packageVersions: ReadonlyMap<string, string>,
  versionedPackageNames: ReadonlySet<string>,
): boolean {
  const baseManifest = readJsonObjectAtRef(options, options.baseRef, file);
  const headManifest = readJsonObjectAtRef(options, options.headRef, file);

  if (!baseManifest || !headManifest) {
    return false;
  }

  let sawGeneratedVersionMetadata = false;
  const manifestKeys = new Set([...Object.keys(baseManifest), ...Object.keys(headManifest)]);

  for (const key of manifestKeys) {
    const baseValue = baseManifest[key];
    const headValue = headManifest[key];

    if (isEqualJson(baseValue, headValue)) {
      continue;
    }

    if (key === "version") {
      if (
        typeof baseValue !== "string" ||
        typeof headValue !== "string" ||
        !semverPattern.test(baseValue) ||
        !semverPattern.test(headValue) ||
        !isSemverIncrease(baseValue, headValue)
      ) {
        return false;
      }

      sawGeneratedVersionMetadata = true;
      continue;
    }

    if (dependencyVersionFields.has(key)) {
      if (
        !isDependencyVersionMetadataChange(
          baseValue,
          headValue,
          packageVersions,
          versionedPackageNames,
        )
      ) {
        return false;
      }

      sawGeneratedVersionMetadata = true;
      continue;
    }

    return false;
  }

  return sawGeneratedVersionMetadata;
}

function getChangedDependencyNamesForManifest(
  options: CheckOptions,
  file: string,
): Set<string> | null {
  const baseManifest = readJsonObjectAtRef(options, options.baseRef, file);
  const headManifest = readJsonObjectAtRef(options, options.headRef, file);

  if (!baseManifest || !headManifest) {
    return null;
  }

  const dependencyNames = new Set<string>();
  const manifestKeys = new Set([...Object.keys(baseManifest), ...Object.keys(headManifest)]);

  for (const key of manifestKeys) {
    const baseValue = baseManifest[key];
    const headValue = headManifest[key];

    if (isEqualJson(baseValue, headValue) || key === "version") {
      continue;
    }

    if (!dependencyVersionFields.has(key)) {
      return null;
    }

    if (!isRecord(baseValue) || !isRecord(headValue)) {
      return null;
    }

    for (const dependencyName of new Set([...Object.keys(baseValue), ...Object.keys(headValue)])) {
      if (!isEqualJson(baseValue[dependencyName], headValue[dependencyName])) {
        dependencyNames.add(dependencyName);
      }
    }
  }

  return dependencyNames;
}

function getStableWorkspaceDependencyNamesForManifest(
  options: CheckOptions,
  file: string,
  packageVersions: ReadonlyMap<string, string>,
): Set<string> | null {
  const baseManifest = readJsonObjectAtRef(options, options.baseRef, file);
  const headManifest = readJsonObjectAtRef(options, options.headRef, file);

  if (!baseManifest || !headManifest) {
    return null;
  }

  const dependencyNames = new Set<string>();

  for (const field of dependencyVersionFields) {
    const baseValue = baseManifest[field];
    const headValue = headManifest[field];

    if (!isRecord(baseValue) || !isRecord(headValue)) {
      continue;
    }

    for (const dependencyName of new Set([...Object.keys(baseValue), ...Object.keys(headValue)])) {
      if (
        packageVersions.has(dependencyName) &&
        baseValue[dependencyName] === "workspace:*" &&
        headValue[dependencyName] === "workspace:*"
      ) {
        dependencyNames.add(dependencyName);
      }
    }
  }

  return dependencyNames;
}

function getReleaseSignificantManifestFiles(
  significantChanges: ReadonlyMap<string, ReleaseSignificantChange>,
): string[] | null {
  const files: string[] = [];

  for (const change of significantChanges.values()) {
    for (const file of change.files) {
      if (isGeneratedReleaseMetadataFile(file)) {
        continue;
      }

      if (!file.endsWith("/package.json")) {
        return null;
      }

      files.push(file);
    }
  }

  return files;
}

function getGeneratedReleaseMetadataFiles(
  significantChanges: ReadonlyMap<string, ReleaseSignificantChange>,
): string[] {
  const files: string[] = [];

  for (const change of significantChanges.values()) {
    for (const file of change.files) {
      if (isGeneratedReleaseMetadataFile(file)) {
        files.push(file);
      }
    }
  }

  return files;
}

function isGeneratedReleaseMetadataFile(file: string): boolean {
  return file === createCrocoAppRangeMetadataPath;
}

function parseCreateCrocoAppRangeMetadata(content: string): Map<string, string> | null {
  const match =
    /const EXTERNAL_CROCO_PACKAGE_RANGES = \{(?<body>[\s\S]*?)\} as const satisfies Record<string, string>;/.exec(
      content,
    );
  const body = match?.groups?.body;
  if (!body) {
    return null;
  }

  const ranges = new Map<string, string>();
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const rangeMatch = /^"(@croco\/[^"]+)": "(\^\d+\.\d+\.\d+)",$/.exec(line);
    if (!rangeMatch?.[1] || !rangeMatch[2]) {
      return null;
    }

    ranges.set(rangeMatch[1], rangeMatch[2]);
  }

  return ranges;
}

function normalizeCreateCrocoAppRangeMetadata(content: string): string | null {
  const normalized = content.replace(
    /const EXTERNAL_CROCO_PACKAGE_RANGES = \{[\s\S]*?\} as const satisfies Record<string, string>;/,
    "const EXTERNAL_CROCO_PACKAGE_RANGES = {__CROCO_RANGES__} as const satisfies Record<string, string>;",
  );

  return normalized === content ? null : normalized;
}

function isCreateCrocoAppRangeMetadataChange(
  options: CheckOptions,
  file: string,
  packageVersions: ReadonlyMap<string, string>,
  versionedPackageNames: ReadonlySet<string>,
): boolean {
  let baseContent: string;
  let headContent: string;
  try {
    baseContent = runGit(options.rootDir, ["show", `${options.baseRef}:${file}`]);
    headContent = runGit(options.rootDir, ["show", `${options.headRef}:${file}`]);
  } catch {
    return false;
  }

  if (
    normalizeCreateCrocoAppRangeMetadata(baseContent) !==
    normalizeCreateCrocoAppRangeMetadata(headContent)
  ) {
    return false;
  }

  const baseRanges = parseCreateCrocoAppRangeMetadata(baseContent);
  const headRanges = parseCreateCrocoAppRangeMetadata(headContent);
  if (!baseRanges || !headRanges) {
    return false;
  }

  let sawGeneratedVersionMetadata = false;
  const packageNames = new Set([...baseRanges.keys(), ...headRanges.keys()]);
  for (const packageName of packageNames) {
    const baseRange = baseRanges.get(packageName);
    const headRange = headRanges.get(packageName);
    if (baseRange === headRange) {
      continue;
    }

    const version = packageVersions.get(packageName);
    if (!version || !versionedPackageNames.has(packageName) || headRange !== `^${version}`) {
      return false;
    }

    sawGeneratedVersionMetadata = true;
  }

  return sawGeneratedVersionMetadata;
}

function isGeneratedReleaseMetadataFileChange(
  options: CheckOptions,
  file: string,
  packageVersions: ReadonlyMap<string, string>,
  versionedPackageNames: ReadonlySet<string>,
): boolean {
  if (file === createCrocoAppRangeMetadataPath) {
    return isCreateCrocoAppRangeMetadataChange(
      options,
      file,
      packageVersions,
      versionedPackageNames,
    );
  }

  return false;
}

function readPackageVersions(
  options: CheckOptions,
  packages: readonly PackageInfo[],
): ReadonlyMap<string, string> {
  const packageVersions = new Map<string, string>();

  for (const pkg of packages) {
    const manifest = readJsonObjectAtRef(
      options,
      options.headRef,
      `${pkg.relativeDir}/package.json`,
    );
    const version = manifest?.version;
    if (typeof version === "string") {
      packageVersions.set(pkg.name, version);
    }
  }

  return packageVersions;
}

function getManifestPackageNames(
  manifestFiles: readonly string[],
  packages: readonly PackageInfo[],
): Set<string> {
  const packageNames = new Set<string>();

  for (const file of manifestFiles) {
    const pkg = getOwningPackage(file, packages);
    if (pkg) {
      packageNames.add(pkg.name);
    }
  }

  return packageNames;
}

function changelogContainsVersion(options: CheckOptions, file: string, version: string): boolean {
  try {
    const changelog = runGit(options.rootDir, ["show", `${options.headRef}:${file}`]);
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^#{2,3}\\s+${escapedVersion}(?:\\s|$)`, "m").test(changelog);
  } catch {
    return false;
  }
}

function isGeneratedDependentVersionUpdate(
  changedDependencyNames: ReadonlySet<string>,
  stableWorkspaceDependencyNames: ReadonlySet<string>,
  consumedPackageNames: ReadonlySet<string>,
  versionedPackageNames: ReadonlySet<string>,
): boolean {
  const isChangedDependencyUpdate =
    changedDependencyNames.size > 0 &&
    [...changedDependencyNames].every(
      (dependencyName) =>
        consumedPackageNames.has(dependencyName) && versionedPackageNames.has(dependencyName),
    );

  const isWorkspaceDependentUpdate = [...stableWorkspaceDependencyNames].some(
    (dependencyName) =>
      consumedPackageNames.has(dependencyName) && versionedPackageNames.has(dependencyName),
  );

  return isChangedDependencyUpdate || isWorkspaceDependentUpdate;
}

function isChangesetsVersionMetadataChange(
  options: CheckOptions,
  significantChanges: ReadonlyMap<string, ReleaseSignificantChange>,
  changedFiles: readonly string[],
  packages: readonly PackageInfo[],
  consumedPackageNames: ReadonlySet<string>,
): boolean {
  const manifestFiles = getReleaseSignificantManifestFiles(significantChanges);
  if (!manifestFiles || manifestFiles.length === 0) {
    return false;
  }

  if (consumedPackageNames.size === 0) {
    return false;
  }

  const packageVersions = readPackageVersions(options, packages);
  const versionedPackageNames = getManifestPackageNames(manifestFiles, packages);
  const generatedMetadataFiles = getGeneratedReleaseMetadataFiles(significantChanges);

  for (const file of manifestFiles) {
    const pkg = getOwningPackage(file, packages);
    const version = pkg ? packageVersions.get(pkg.name) : null;
    const changelogFile = pkg ? `${pkg.relativeDir}/CHANGELOG.md` : "";
    const changedDependencyNames = getChangedDependencyNamesForManifest(options, file);
    const stableWorkspaceDependencyNames = getStableWorkspaceDependencyNamesForManifest(
      options,
      file,
      packageVersions,
    );

    if (
      !pkg ||
      !version ||
      !changedDependencyNames ||
      !stableWorkspaceDependencyNames ||
      (!consumedPackageNames.has(pkg.name) &&
        !isGeneratedDependentVersionUpdate(
          changedDependencyNames,
          stableWorkspaceDependencyNames,
          consumedPackageNames,
          versionedPackageNames,
        )) ||
      !changedFiles.includes(changelogFile) ||
      !changelogContainsVersion(options, changelogFile, version)
    ) {
      return false;
    }

    if (!isGeneratedVersionManifestChange(options, file, packageVersions, versionedPackageNames)) {
      return false;
    }
  }

  for (const file of generatedMetadataFiles) {
    if (
      !isGeneratedReleaseMetadataFileChange(options, file, packageVersions, versionedPackageNames)
    ) {
      return false;
    }
  }

  return true;
}

function isMeaningfulNoReleaseReason(reason: string): boolean {
  return reason.trim().length >= 12 && /[A-Za-z0-9]/.test(reason);
}

function readNoReleaseReasonFromText(text: string): string | null {
  const match = noReleaseReasonLinePattern.exec(text);
  if (!match) {
    return null;
  }

  const reason = match[1]?.trim() ?? "";
  return isMeaningfulNoReleaseReason(reason) ? reason : null;
}

function getNoReleaseJustification(rootDir: string): NoReleaseJustification | null {
  const eventPath = env.GITHUB_EVENT_PATH?.trim();
  if (!eventPath) {
    return null;
  }

  try {
    const event = JSON.parse(readFileSync(resolve(rootDir, eventPath), "utf-8")) as unknown;
    if (typeof event !== "object" || event === null || !("pull_request" in event)) {
      return null;
    }

    const pullRequest = (event as { readonly pull_request?: unknown }).pull_request;
    if (typeof pullRequest !== "object" || pullRequest === null || !("body" in pullRequest)) {
      return null;
    }

    const body = (pullRequest as { readonly body?: unknown }).body;
    if (typeof body !== "string") {
      return null;
    }

    const reason = readNoReleaseReasonFromText(body);
    return reason
      ? {
          reason,
          source: "pull request body",
        }
      : null;
  } catch {
    return null;
  }
}

function isPackageTestFile(packageRelativeFile: string): boolean {
  const fileName = basename(packageRelativeFile);

  return (
    packageRelativeFile.startsWith("__tests__/") ||
    packageRelativeFile.startsWith("src/__tests__/") ||
    packageRelativeFile.startsWith("src/tests/") ||
    packageRelativeFile.startsWith("test/") ||
    packageRelativeFile.startsWith("tests/") ||
    testFilePattern.test(fileName)
  );
}

function isReleaseSignificantPackageFile(packageRelativeFile: string): boolean {
  if (packageRelativeFile === "package.json") {
    return true;
  }

  if (isPackageTestFile(packageRelativeFile)) {
    return false;
  }

  if (
    packageRelativeFile.startsWith("src/") ||
    packageRelativeFile.startsWith("templates/") ||
    packageRelativeFile.startsWith("bin/")
  ) {
    return true;
  }

  if (
    packageRelativeFile === "README.md" ||
    packageRelativeFile === "CHANGELOG.md" ||
    packageRelativeFile.startsWith("docs/")
  ) {
    return false;
  }

  return false;
}

function getReleaseSignificantChanges(
  options: CheckOptions,
  changedFiles: readonly string[],
  packages: readonly PackageInfo[],
): Map<string, ReleaseSignificantChange> {
  const changes = new Map<string, ReleaseSignificantChange>();

  for (const file of changedFiles) {
    const pkg = getOwningPackage(file, packages);
    if (!pkg || pkg.private) {
      continue;
    }

    const packageRelativeFile = file.slice(`${pkg.relativeDir}/`.length);
    if (
      packageRelativeFile === "package.json" &&
      isCiScriptOnlyManifestChange(
        readJsonObjectAtRef(options, options.baseRef, file),
        readJsonObjectAtRef(options, options.headRef, file),
      )
    ) {
      continue;
    }

    if (!isReleaseSignificantPackageFile(packageRelativeFile)) {
      continue;
    }

    addReleaseSignificantChange(changes, pkg.name, file, "package files");
  }

  return changes;
}

function addReleaseSignificantChange(
  changes: Map<string, ReleaseSignificantChange>,
  packageName: string,
  file: string,
  surface: string,
  changedExportPaths?: readonly string[],
): void {
  const packageFiles = changes.get(packageName) ?? {
    files: [],
    surface,
  };
  packageFiles.files.push(file);
  changes.set(
    packageName,
    changedExportPaths
      ? {
          ...packageFiles,
          changedExportPaths: [
            ...new Set([...(packageFiles.changedExportPaths ?? []), ...changedExportPaths]),
          ].sort(),
        }
      : packageFiles,
  );
}

function readPublicApiSnapshotPackages(
  options: CheckOptions,
  ref: string,
): PublicApiSnapshotData | null {
  let content: string;
  try {
    content = runGit(options.rootDir, ["show", `${ref}:${publicApiSnapshotPath}`]);
  } catch {
    return null;
  }

  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("packages" in parsed)) {
    throw new Error(`${publicApiSnapshotPath} must contain a packages array`);
  }

  const packagesValue = (parsed as { readonly packages?: unknown }).packages;
  if (!Array.isArray(packagesValue)) {
    throw new Error(`${publicApiSnapshotPath} must contain a packages array`);
  }

  const schemaVersion = (parsed as { readonly schemaVersion?: unknown }).schemaVersion;
  if (typeof schemaVersion !== "number") {
    throw new Error(`${publicApiSnapshotPath} must contain a numeric schemaVersion`);
  }
  const packages = packagesValue
    .map((pkg) => {
      if (typeof pkg !== "object" || pkg === null || !("packageName" in pkg)) {
        throw new Error(`${publicApiSnapshotPath} contains an invalid package entry`);
      }

      const packageName = (pkg as { readonly packageName?: unknown }).packageName;
      if (typeof packageName !== "string" || packageName.length === 0) {
        throw new Error(`${publicApiSnapshotPath} contains an invalid package name`);
      }

      const packageRecord = pkg as Record<string, unknown>;
      const entrypoints = new Map<string, string>();
      const metadataKey = JSON.stringify({
        compatibilityGroups: packageRecord.compatibilityGroups ?? null,
        relativeDir: packageRecord.relativeDir ?? null,
      });
      let migrationRootKey: string | null = null;
      if (schemaVersion === 1) {
        migrationRootKey = JSON.stringify({
          kind: "code",
          runtimeExports: packageRecord.runtimeExports ?? null,
          typeExports: packageRecord.typeExports ?? null,
        });
        entrypoints.set(".", JSON.stringify(pkg));
      } else if (schemaVersion === 2 && Array.isArray(packageRecord.entrypoints)) {
        for (const entrypoint of packageRecord.entrypoints) {
          if (
            typeof entrypoint !== "object" ||
            entrypoint === null ||
            typeof (entrypoint as { exportPath?: unknown }).exportPath !== "string"
          ) {
            throw new Error(
              `${publicApiSnapshotPath} contains an invalid entrypoint for ${packageName}`,
            );
          }
          const exportPath = (entrypoint as { exportPath: string }).exportPath;
          entrypoints.set(exportPath, JSON.stringify(entrypoint));
          if (exportPath === ".") {
            const entrypointRecord = entrypoint as Record<string, unknown>;
            migrationRootKey = JSON.stringify({
              kind: entrypointRecord.kind ?? null,
              runtimeExports: entrypointRecord.runtimeExports ?? null,
              typeExports: entrypointRecord.typeExports ?? null,
            });
          }
        }
      } else {
        throw new Error(`${publicApiSnapshotPath} uses unsupported schemaVersion ${schemaVersion}`);
      }
      return {
        packageName,
        entrypoints,
        metadataKey,
        migrationRootKey,
      };
    })
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
  return { schemaVersion, packages };
}

function getPublicApiSnapshotChanges(
  options: CheckOptions,
  changedFiles: readonly string[],
): PublicApiSnapshotChange[] {
  if (!changedFiles.includes(publicApiSnapshotPath)) {
    return [];
  }

  try {
    const previousPackages = readPublicApiSnapshotPackages(options, options.baseRef);
    const currentPackages = readPublicApiSnapshotPackages(options, options.headRef);

    if (!previousPackages || !currentPackages) {
      return [{ packageName: "public API snapshot", changedExportPaths: [] }];
    }

    const previousByPackage = new Map(
      previousPackages.packages.map((pkg) => [pkg.packageName, pkg] as const),
    );
    const currentByPackage = new Map(
      currentPackages.packages.map((pkg) => [pkg.packageName, pkg] as const),
    );
    const packageNames = [...new Set([...previousByPackage.keys(), ...currentByPackage.keys()])];
    const migration = previousPackages.schemaVersion === 1 && currentPackages.schemaVersion === 2;
    const changes = packageNames.sort().flatMap((packageName): PublicApiSnapshotChange[] => {
      const previous = previousByPackage.get(packageName);
      const current = currentByPackage.get(packageName);
      const paths = [
        ...new Set([
          ...(previous?.entrypoints.keys() ?? []),
          ...(current?.entrypoints.keys() ?? []),
        ]),
      ]
        .sort()
        .filter((exportPath) => {
          if (exportPath === "." && previous && current) {
            if (previous.metadataKey !== current.metadataKey) {
              return true;
            }
            if (
              migration &&
              previous.migrationRootKey !== null &&
              previous.migrationRootKey === current.migrationRootKey
            ) {
              return false;
            }
          }
          return previous?.entrypoints.get(exportPath) !== current?.entrypoints.get(exportPath);
        });
      return paths.length > 0 ? [{ packageName, changedExportPaths: paths }] : [];
    });
    return changes;
  } catch {
    return [{ packageName: "public API snapshot", changedExportPaths: [] }];
  }
}

function addPublicApiSnapshotChanges(
  changes: Map<string, ReleaseSignificantChange>,
  options: CheckOptions,
  changedFiles: readonly string[],
): void {
  for (const change of getPublicApiSnapshotChanges(options, changedFiles)) {
    const pathEvidence =
      change.changedExportPaths.length > 0 ? ` (${change.changedExportPaths.join(", ")})` : "";
    addReleaseSignificantChange(
      changes,
      change.packageName,
      publicApiSnapshotPath,
      `public API snapshot${pathEvidence}`,
      change.changedExportPaths,
    );
  }
}

function isSnapshotOnlyReleaseChange(
  significantChanges: ReadonlyMap<string, ReleaseSignificantChange>,
): boolean {
  return (
    significantChanges.size > 0 &&
    [...significantChanges.values()].every((change) =>
      change.files.every((file) => file === publicApiSnapshotPath),
    )
  );
}

function logInvalidChangesetPackageNames(coverage: ChangesetCoverage): void {
  if (coverage.unknownNames.length === 0 && coverage.privateNames.length === 0) {
    return;
  }

  log("");
  log("Invalid changeset package names:");
  for (const packageName of coverage.unknownNames) {
    log(`- ${packageName} (unknown package)`);
  }
  for (const packageName of coverage.privateNames) {
    log(`- ${packageName} (private package)`);
  }
}

function logInvalidChangesetFiles(changesets: ChangedChangesetMetadata): void {
  if (changesets.invalidFiles.length === 0) {
    return;
  }

  log("");
  log("Invalid changeset files:");
  for (const invalid of [...changesets.invalidFiles].sort((left, right) =>
    left.file.localeCompare(right.file),
  )) {
    log(`- ${invalid.file} (${invalid.state} metadata)`);
  }
}

function logUncoveredPackages(coverage: ChangesetCoverage): void {
  if (coverage.uncoveredPackages.size === 0) {
    return;
  }

  log("");
  log("Uncovered release-significant packages:");
  for (const [packageName, change] of coverage.uncoveredPackages) {
    const snapshotSurface =
      change.changedExportPaths &&
      change.changedExportPaths.length > 0 &&
      !change.surface.startsWith("public API snapshot")
        ? `; public API snapshot (${change.changedExportPaths.join(", ")})`
        : "";
    log(`- ${packageName} (${change.surface}${snapshotSurface})`);
    for (const file of [...change.files].sort()) {
      log(`  - ${file}`);
    }
  }
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const changedFiles = getChangedFiles(options);
    const packages = readPackages(options.rootDir);
    const significantChanges = getReleaseSignificantChanges(options, changedFiles, packages);
    addPublicApiSnapshotChanges(significantChanges, options, changedFiles);
    const changesets = getChangedChangesetMetadata(options, changedFiles);
    const coverage = getChangesetCoverage(changesets, packages, significantChanges);

    if (changesets.invalidFiles.length > 0) {
      log("changeset-required: changed changesets contain invalid metadata.");
      logInvalidChangesetFiles(changesets);
      logInvalidChangesetPackageNames(coverage);
      logUncoveredPackages(coverage);
      exit(1);
    }

    if (coverage.privateNames.length > 0 || coverage.unknownNames.length > 0) {
      log("changeset-required: changed changesets contain invalid package names.");
      logInvalidChangesetPackageNames(coverage);
      logUncoveredPackages(coverage);
      exit(1);
    }

    if (significantChanges.size === 0) {
      log("changeset-required: no publishable package behavior changes detected (passing)");
      exit(0);
    }

    if (coverage.uncoveredPackages.size === 0) {
      log(
        "changeset-required: changed changesets cover all affected publishable packages (passing)",
      );
      exit(0);
    }

    if (
      isChangesetsVersionMetadataChange(
        options,
        significantChanges,
        changedFiles,
        packages,
        changesets.consumedPackageNames,
      )
    ) {
      log("changeset-required: generated Changesets version metadata found (passing)");
      exit(0);
    }

    const noReleaseJustification = getNoReleaseJustification(options.rootDir);
    if (isSnapshotOnlyReleaseChange(significantChanges) && noReleaseJustification) {
      log(
        "changeset-required: public API snapshot change has checked no-release justification (passing)",
      );
      log(`No-release source: ${noReleaseJustification.source}`);
      log(`No-release reason: ${noReleaseJustification.reason}`);
      exit(0);
    }

    log("changeset-required: publishable package changes require a non-README changeset.");
    log(
      "Add .changeset/<name>.md for release-significant package changes, or add `Changeset-required no-release reason: <reason>` to the PR body for snapshot-only corrections.",
    );

    logUncoveredPackages(coverage);

    exit(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`changeset-required: failed: ${message}`);
    exit(1);
  }
}

main();
