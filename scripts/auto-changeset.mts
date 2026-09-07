import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { env, exit, stdout } from "node:process";

import { isCiScriptOnlyManifestChange } from "./package-manifest-contracts.mjs";

type BumpType = "major" | "minor" | "patch";

type ParsedCommit = {
  readonly hash: string;
  readonly subject: string;
  readonly type: string | null;
  readonly scope: string | null;
  readonly isBreaking: boolean;
  readonly body: string;
};

type WorkspacePackage = {
  readonly directory: string;
  readonly name: string;
  readonly private: boolean;
};

const changesetDirectory = resolve(process.cwd(), ".changeset");
const workspaceFile = resolve(process.cwd(), "pnpm-workspace.yaml");
const conventionalCommitPattern =
  /^(feat|fix|chore|docs|refactor|perf|test|style|build|ci|revert)(\(.+\))?(!)?:\s/;
const bumpRank: Record<BumpType, number> = {
  patch: 0,
  minor: 1,
  major: 2,
};

function log(message: string): void {
  stdout.write(`${message}\n`);
}

function runGit(args: readonly string[]): string {
  const result = spawnSync("git", [...args], { encoding: "utf-8" });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

function canResolveGitRef(ref: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", ref], { encoding: "utf-8" });
  return result.status === 0;
}

function resolveBaseRef(): string {
  if (canResolveGitRef("origin/trunk")) {
    return "origin/trunk";
  }

  return "trunk";
}

function hasExistingChangeset(changedFiles: readonly string[]): boolean {
  return changedFiles.some(
    (file) =>
      file.startsWith(".changeset/") && file.endsWith(".md") && file !== ".changeset/README.md",
  );
}

function getCommitHashes(baseRef: string): string[] {
  const output = runGit(["rev-list", `${baseRef}..HEAD`]);
  return output.split("\n").filter(Boolean);
}

function getChangedFiles(baseRef: string): string[] {
  const output = runGit(["diff", "--name-only", `${baseRef}...HEAD`]);
  return output.split("\n").filter(Boolean);
}

function parseCommitBlock(block: string): ParsedCommit | null {
  const [hash, subject = "", ...bodyLines] = block.trim().split("\n");

  if (!hash) {
    return null;
  }

  const body = bodyLines.join("\n").trim();
  const match = subject.match(conventionalCommitPattern);
  const type = match?.[1] ?? null;
  const scope = match?.[2] ? match[2].slice(1, -1) : null;
  const isBreaking = match?.[3] === "!" || /^(BREAKING CHANGE|BREAKING-CHANGE):/m.test(body);

  return {
    hash,
    subject,
    type,
    scope,
    isBreaking,
    body,
  };
}

function getParsedCommits(hashes: readonly string[]): ParsedCommit[] {
  if (hashes.length === 0) {
    return [];
  }

  const output = runGit(["log", "--no-walk", "--format=%H%n%s%n%b===END===", ...hashes]);

  return output
    .split("===END===")
    .map(parseCommitBlock)
    .filter((commit): commit is ParsedCommit => commit !== null);
}

function getCommitBump(commit: ParsedCommit): BumpType {
  if (commit.isBreaking) {
    return "major";
  }

  if (commit.type === "feat") {
    return "minor";
  }

  return "patch";
}

function determineBumpType(commits: readonly ParsedCommit[]): BumpType {
  let highest: BumpType = "patch";

  for (const commit of commits) {
    const bump = getCommitBump(commit);

    if (bump === "major") {
      return "major";
    }

    if (bumpRank[bump] > bumpRank[highest]) {
      highest = bump;
    }
  }

  return highest;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function getWorkspacePackagePatterns(): string[] {
  if (!existsSync(workspaceFile)) {
    return ["packages/**/*"];
  }

  const patterns: string[] = [];
  let inPackagesSection = false;

  for (const line of readFileSync(workspaceFile, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      inPackagesSection = trimmed === "packages:";
      continue;
    }

    if (!inPackagesSection || !trimmed.startsWith("- ")) {
      continue;
    }

    const pattern = unquoteYamlScalar(trimmed.slice(2));

    if (pattern.length > 0 && !pattern.startsWith("!")) {
      patterns.push(pattern);
    }
  }

  return patterns.length > 0 ? patterns : ["packages/**/*"];
}

function findPackageJsonFiles(directory: string, results: string[] = []): string[] {
  if (!existsSync(directory)) {
    return results;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      findPackageJsonFiles(path, results);
      continue;
    }

    if (entry.isFile() && entry.name === "package.json") {
      results.push(path);
    }
  }

  return results.sort();
}

function findDirectPackageJsonFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const results: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const packageJsonPath = resolve(directory, entry.name, "package.json");

    if (existsSync(packageJsonPath)) {
      results.push(packageJsonPath);
    }
  }

  return results.sort();
}

function findWorkspacePackageJsonFiles(pattern: string): string[] {
  const normalizedPattern = toGitPath(pattern).replace(/\/+$/, "");

  if (normalizedPattern.endsWith("/**/*") || normalizedPattern.endsWith("/**")) {
    const directory = normalizedPattern.replace(/\/\*\*\/?\*?$/, "");
    return findPackageJsonFiles(resolve(process.cwd(), directory));
  }

  if (normalizedPattern.endsWith("/*")) {
    const directory = normalizedPattern.slice(0, -2);
    return findDirectPackageJsonFiles(resolve(process.cwd(), directory));
  }

  const packageJsonPath = resolve(process.cwd(), normalizedPattern, "package.json");

  if (existsSync(packageJsonPath)) {
    return [packageJsonPath];
  }

  return [];
}

function readWorkspacePackage(packageJsonPath: string): WorkspacePackage | null {
  const content = readFileSync(packageJsonPath, "utf-8");
  const manifest = JSON.parse(content) as { name?: unknown; private?: unknown };

  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    return null;
  }

  return {
    directory: toGitPath(relative(process.cwd(), dirname(packageJsonPath))),
    name: manifest.name,
    private: manifest.private === true,
  };
}

function getWorkspacePackages(): WorkspacePackage[] {
  const packageJsonPaths = new Set(
    getWorkspacePackagePatterns().flatMap(findWorkspacePackageJsonFiles),
  );

  return [...packageJsonPaths]
    .map(readWorkspacePackage)
    .filter((packageInfo): packageInfo is WorkspacePackage => packageInfo !== null)
    .sort((left, right) => right.directory.length - left.directory.length);
}

function toGitPath(path: string): string {
  return path.split(sep).join("/");
}

function readJsonAtRef(ref: string, file: string): unknown | null {
  const result = spawnSync("git", ["show", `${ref}:${file}`], { encoding: "utf-8" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    return null;
  }

  return JSON.parse(result.stdout) as unknown;
}

function resolveChangedPackageNames(baseRef: string, changedFiles: readonly string[]): string[] {
  const packages = getWorkspacePackages();
  const packageNames = new Set<string>();

  for (const file of changedFiles) {
    const owner = packages.find(
      (packageInfo) =>
        file === `${packageInfo.directory}/package.json` ||
        file.startsWith(`${packageInfo.directory}/`),
    );

    if (owner && !owner.private) {
      if (
        file === `${owner.directory}/package.json` &&
        isCiScriptOnlyManifestChange(readJsonAtRef(baseRef, file), readJsonAtRef("HEAD", file))
      ) {
        continue;
      }

      packageNames.add(owner.name);
    }
  }

  return [...packageNames].sort();
}

function formatChangeset(
  bump: BumpType,
  commits: readonly ParsedCommit[],
  packageNames: readonly string[],
): string {
  const entries = commits.map((commit) => `- ${commit.subject}`);
  const packageEntries = packageNames.map((packageName) => `'${packageName}': ${bump}`);

  return ["---", ...packageEntries, "---", "", ...entries, ""].join("\n");
}

function createChangeset(
  commits: readonly ParsedCommit[],
  packageNames: readonly string[],
): string {
  const bump = determineBumpType(commits);
  const filename = `${randomBytes(4).toString("hex")}.md`;
  const changesetPath = resolve(changesetDirectory, filename);

  writeFileSync(changesetPath, formatChangeset(bump, commits, packageNames), "utf-8");

  return changesetPath;
}

function stageAndCommit(changesetPath: string): void {
  runGit(["add", changesetPath]);
  runGit(["commit", "--no-verify", "-m", "chore: add changeset"]);
}

function main(): void {
  try {
    const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);

    if (env.GITHUB_ACTIONS === "true") {
      log("auto-changeset: GitHub Actions environment detected (skipping)");
      exit(0);
    }

    if (branch === "trunk") {
      log("auto-changeset: on trunk branch (skipping)");
      exit(0);
    }

    if (branch.startsWith("changeset-release/")) {
      log("auto-changeset: on changeset release branch (skipping)");
      exit(0);
    }

    const baseRef = resolveBaseRef();
    const changedFiles = getChangedFiles(baseRef);

    if (hasExistingChangeset(changedFiles)) {
      log("auto-changeset: existing changeset found (skipping)");
      exit(0);
    }

    const hashes = getCommitHashes(baseRef);
    const commits = getParsedCommits(hashes);

    if (commits.length === 0) {
      log("auto-changeset: no commits found (skipping)");
      exit(0);
    }

    const packageNames = resolveChangedPackageNames(baseRef, changedFiles);

    if (packageNames.length === 0) {
      log("auto-changeset: no publishable package changes found (skipping)");
      exit(0);
    }

    const changesetPath = createChangeset(commits, packageNames);
    stageAndCommit(changesetPath);
    log(`auto-changeset: created and committed ${changesetPath}`);
    log("auto-changeset: push aborted — run 'git push' again to include the changeset");
    exit(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`auto-changeset: failed: ${message}`);
    exit(1);
  }
}

main();
