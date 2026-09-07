import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve(__dirname, "../auto-changeset.mts");
const nullSha = "0000000000000000000000000000000000000000";
const tempRepos: string[] = [];

type ScriptResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
};

describe("auto-changeset.mts", () => {
  afterEach(() => {
    for (const repo of tempRepos.splice(0)) {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("skips when current branch is trunk", () => {
    const repo = createTempRepo();
    const head = git(repo, ["rev-parse", "HEAD"]);
    const result = runScript(`refs/heads/trunk ${head} refs/heads/trunk ${nullSha}\n`, repo);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("auto-changeset: on trunk branch (skipping)");
    expect(listChangesets(repo)).toEqual([]);
  });

  it("skips in GitHub Actions", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/ci-skip");
    commitFile(repo, "feature.txt", "feature", "feat: add checkout flow");

    const result = runScript(
      newBranchStdin("feature/ci-skip", git(repo, ["rev-parse", "HEAD"])),
      repo,
      { GITHUB_ACTIONS: "true" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "auto-changeset: GitHub Actions environment detected (skipping)",
    );
    expect(listChangesets(repo)).toEqual([]);
  });

  it("skips changeset release branches", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "changeset-release/trunk");
    commitFile(repo, "version.txt", "version", "chore: version packages");

    const result = runScript(
      newBranchStdin("changeset-release/trunk", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("auto-changeset: on changeset release branch (skipping)");
    expect(listChangesets(repo)).toEqual([]);
  });

  it("skips when a feature branch has no commits ahead of trunk", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/no-commits");

    const result = runScript(
      newBranchStdin("feature/no-commits", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("auto-changeset: no commits found (skipping)");
    expect(listChangesets(repo)).toEqual([]);
  });

  it("detects feat commit → minor bump", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/minor");
    commitFile(
      repo,
      "packages/telemetry-sdk-node/src/runtime.ts",
      "export const runtime = true;",
      "feat: add telemetry runtime",
    );

    const result = runScript(
      newBranchStdin("feature/minor", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("auto-changeset: created and committed");
    expect(result.stdout).toContain(
      "auto-changeset: push aborted — run 'git push' again to include the changeset",
    );
    const changeset = readOnlyChangeset(repo);
    expect(changeset).toContain("'@croco/telemetry-sdk-node': minor");
    expect(changeset).not.toContain("'@croco/framework-context': minor");
    expect(changeset).not.toContain("'create-croco-app': minor");
    const commitSubject = git(repo, ["log", "-1", "--format=%s"]);
    expect(commitSubject).toBe("chore: add changeset");
    expect(commitSubject).not.toMatch(/\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i);
  });

  it("detects fix commit → patch bump", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "fix/patch");
    commitFile(
      repo,
      "packages/frontend-vite/src/plugin.ts",
      "export const plugin = true;",
      "fix: handle vite plugin timeout",
    );

    const result = runScript(newBranchStdin("fix/patch", git(repo, ["rev-parse", "HEAD"])), repo);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("auto-changeset: created and committed");
    expect(result.stdout).toContain(
      "auto-changeset: push aborted — run 'git push' again to include the changeset",
    );
    expect(readOnlyChangeset(repo)).toContain("'@croco/frontend-vite': patch");
  });

  it("detects feat! → major bump (BREAKING CHANGE from title)", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/breaking-title");
    commitFile(
      repo,
      "packages/telemetry-sdk-node/src/runtime.ts",
      "export const runtime = true;",
      "feat!: replace telemetry runtime",
    );

    const result = runScript(
      newBranchStdin("feature/breaking-title", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("auto-changeset: created and committed");
    expect(result.stdout).toContain(
      "auto-changeset: push aborted — run 'git push' again to include the changeset",
    );
    expect(readOnlyChangeset(repo)).toContain("'@croco/telemetry-sdk-node': major");
  });

  it("detects BREAKING CHANGE from body footer → major bump", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/breaking-body");
    commitFile(
      repo,
      "packages/telemetry-sdk-node/src/runtime.ts",
      "export const runtime = true;",
      "feat: update runtime",
      "BREAKING CHANGE: runtime options changed",
    );

    const result = runScript(
      newBranchStdin("feature/breaking-body", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("auto-changeset: created and committed");
    expect(result.stdout).toContain(
      "auto-changeset: push aborted — run 'git push' again to include the changeset",
    );
    expect(readOnlyChangeset(repo)).toContain("'@croco/telemetry-sdk-node': major");
  });

  it("skips when changeset already exists", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/existing-changeset");
    writeFileSync(join(repo, ".changeset", "existing.md"), "---\n---\n\nExisting changeset\n");
    git(repo, ["add", ".changeset/existing.md"]);
    git(repo, ["commit", "-m", "chore: add existing changeset"]);
    commitFile(repo, "feature.txt", "feature", "feat: add billing flow");

    const result = runScript(
      newBranchStdin("feature/existing-changeset", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("auto-changeset: existing changeset found (skipping)");
    expect(listChangesets(repo)).toEqual(["existing.md"]);
  });

  it("ignores changesets that already exist on trunk", () => {
    const repo = createTempRepo();
    writeFileSync(join(repo, ".changeset", "trunk.md"), "---\n---\n\nExisting trunk changeset\n");
    git(repo, ["add", ".changeset/trunk.md"]);
    git(repo, ["commit", "-m", "chore: add trunk changeset"]);
    checkoutBranch(repo, "feature/trunk-changeset");
    commitFile(
      repo,
      "packages/telemetry-sdk-node/src/runtime.ts",
      "export const runtime = true;",
      "fix: handle telemetry flush",
    );

    const result = runScript(
      newBranchStdin("feature/trunk-changeset", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("auto-changeset: created and committed");
    const generatedChangesets = listChangesets(repo).filter((file) => file !== "trunk.md");
    expect(generatedChangesets).toHaveLength(1);
    expect(readChangeset(repo, generatedChangesets[0])).toContain(
      "'@croco/telemetry-sdk-node': patch",
    );
  });

  it("uses origin/trunk when local trunk is stale", () => {
    const repo = createTempRepo();
    commitFile(
      repo,
      "packages/frontend-vite/src/base.ts",
      "export const base = true;",
      "fix: update base package",
    );
    git(repo, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
    checkoutBranch(repo, "feature/origin-base");
    git(repo, ["branch", "-f", "trunk", "HEAD~1"]);
    commitFile(
      repo,
      "packages/telemetry-sdk-node/src/runtime.ts",
      "export const runtime = true;",
      "fix: handle telemetry flush",
    );

    const result = runScript(
      newBranchStdin("feature/origin-base", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(1);
    const changeset = readOnlyChangeset(repo);
    expect(changeset).toContain("'@croco/telemetry-sdk-node': patch");
    expect(changeset).not.toContain("'@croco/frontend-vite': patch");
  });

  it("chooses minor over patch when both feat and fix present", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/mixed");
    commitFile(
      repo,
      "packages/frontend-vite/src/fix.ts",
      "export const fix = true;",
      "fix: handle empty cart",
    );
    commitFile(
      repo,
      "packages/frontend-vite/src/feature.ts",
      "export const feature = true;",
      "feat: add cart summary",
    );

    const result = runScript(
      newBranchStdin("feature/mixed", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("auto-changeset: created and committed");
    expect(result.stdout).toContain(
      "auto-changeset: push aborted — run 'git push' again to include the changeset",
    );
    expect(readOnlyChangeset(repo)).toContain("'@croco/frontend-vite': minor");
  });

  it("generates changeset entries for every touched publishable package", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/multiple-packages");
    commitFile(
      repo,
      "packages/telemetry-sdk-node/src/runtime.ts",
      "export const runtime = true;",
      "fix: handle telemetry flush",
    );
    commitFile(
      repo,
      "packages/frontend-vite/src/plugin.ts",
      "export const plugin = true;",
      "fix: handle vite plugin",
    );

    const result = runScript(
      newBranchStdin("feature/multiple-packages", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(1);
    const changeset = readOnlyChangeset(repo);
    expect(changeset).toContain("'@croco/frontend-vite': patch");
    expect(changeset).toContain("'@croco/telemetry-sdk-node': patch");
  });

  it.each([
    [
      "docs:api:model",
      "node --experimental-strip-types ../docs/scripts/generate-package-api-model.mts",
    ],
    [
      "test:evidence",
      "pnpm run test --maxWorkers=1 --reporter=json --outputFile=.turbo/croco-test-evidence.json",
    ],
  ])("skips canonical CI script %s-only manifest changes", (scriptName, scriptCommand) => {
    const repo = createTempRepo();
    checkoutBranch(repo, "ci/api-model-script");
    writePackageManifest(repo, "packages/telemetry-sdk-node", "@croco/telemetry-sdk-node", false, {
      [scriptName]: scriptCommand,
    });
    git(repo, ["add", "packages/telemetry-sdk-node/package.json"]);
    git(repo, ["commit", "-m", "fix(ci): cache API model generation"]);

    const result = runScript(
      newBranchStdin("ci/api-model-script", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "auto-changeset: no publishable package changes found (skipping)",
    );
    expect(listChangesets(repo)).toEqual([]);
  });

  it.each([
    [
      "docs:api:model",
      "node --experimental-strip-types ../docs/scripts/generate-package-api-model.mts",
    ],
    [
      "test:evidence",
      "pnpm run test --maxWorkers=1 --reporter=json --outputFile=.turbo/croco-test-evidence.json",
    ],
  ])(
    "does not exempt other manifest changes alongside the CI script %s",
    (scriptName, scriptCommand) => {
      const repo = createTempRepo();
      checkoutBranch(repo, "ci/api-model-script-and-version");
      writePackageManifest(
        repo,
        "packages/telemetry-sdk-node",
        "@croco/telemetry-sdk-node",
        false,
        {
          [scriptName]: scriptCommand,
        },
        "0.0.1",
      );
      git(repo, ["add", "packages/telemetry-sdk-node/package.json"]);
      git(repo, ["commit", "-m", "fix: update telemetry package"]);

      const result = runScript(
        newBranchStdin("ci/api-model-script-and-version", git(repo, ["rev-parse", "HEAD"])),
        repo,
      );

      expect(result.status).toBe(1);
      expect(readOnlyChangeset(repo)).toContain("'@croco/telemetry-sdk-node': patch");
    },
  );

  it("uses pnpm workspace package patterns outside packages", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/workspace-pattern");
    writeWorkspaceFile(repo, ["packages/**/*", "tools/*"]);
    writePackageManifest(repo, "tools/release-helper", "@croco/release-helper");
    git(repo, ["add", "pnpm-workspace.yaml", "tools/release-helper/package.json"]);
    git(repo, ["commit", "-m", "fix: update release helper"]);

    const result = runScript(
      newBranchStdin("feature/workspace-pattern", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(1);
    const changeset = readOnlyChangeset(repo);
    expect(changeset).toContain("'@croco/release-helper': patch");
    expect(changeset).not.toContain("'@croco/framework-context': patch");
  });

  it("skips root-only changes without generating unrelated package entries", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "docs/root-only");
    commitFile(repo, "README.md", "# Test repo\n\nUpdated docs", "docs: update root readme");

    const result = runScript(
      newBranchStdin("docs/root-only", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "auto-changeset: no publishable package changes found (skipping)",
    );
    expect(listChangesets(repo)).toEqual([]);
  });

  it("skips private-package-only changes", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "docs/private-package");
    commitFile(
      repo,
      "packages/docs/src/index.ts",
      "export const docs = true;",
      "fix: update docs package",
    );

    const result = runScript(
      newBranchStdin("docs/private-package", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "auto-changeset: no publishable package changes found (skipping)",
    );
    expect(listChangesets(repo)).toEqual([]);
  });

  it("fails when git inspection fails unexpectedly", () => {
    const repo = mkdtempSync(join(tmpdir(), "croco-auto-changeset-not-git-"));
    tempRepos.push(repo);

    const result = runScript("", repo);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("auto-changeset: failed:");
    expect(result.stdout).toContain("not a git repository");
  });

  it("fails when the changeset cannot be written", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/write-failure");
    commitFile(
      repo,
      "packages/telemetry-sdk-node/src/runtime.ts",
      "export const runtime = true;",
      "feat: add telemetry runtime",
    );
    rmSync(join(repo, ".changeset"), { force: true, recursive: true });

    const result = runScript(
      newBranchStdin("feature/write-failure", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("auto-changeset: failed:");
    expect(result.stdout).toContain(".changeset");
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("feat: add telemetry runtime");
  });

  it("fails when the generated changeset cannot be committed", () => {
    const repo = createTempRepo();
    checkoutBranch(repo, "feature/commit-failure");
    commitFile(
      repo,
      "packages/telemetry-sdk-node/src/runtime.ts",
      "export const runtime = true;",
      "feat: add telemetry runtime",
    );
    const hooksPath = join(repo, "hooks");
    const prepareCommitMessageHook = join(hooksPath, "prepare-commit-msg");
    mkdirSync(hooksPath);
    writeFileSync(
      prepareCommitMessageHook,
      "#!/bin/sh\necho prepare-commit-msg hook failed >&2\nexit 1\n",
    );
    chmodSync(prepareCommitMessageHook, 0o755);
    git(repo, ["config", "core.hooksPath", hooksPath]);

    const result = runScript(
      newBranchStdin("feature/commit-failure", git(repo, ["rev-parse", "HEAD"])),
      repo,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("auto-changeset: failed:");
    expect(result.stdout).toContain("prepare-commit-msg hook failed");
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("feat: add telemetry runtime");
  });
});

function createTempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "croco-auto-changeset-"));
  tempRepos.push(repo);

  git(repo, ["init", "--initial-branch=trunk"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "tag.gpgsign", "false"]);
  git(repo, ["config", "core.hooksPath", "/dev/null"]);
  git(repo, ["config", "advice.detachedHead", "false"]);
  writeFileSync(join(repo, "README.md"), "# Test repo\n");
  writeWorkspaceFile(repo, ["packages/**/*", "examples/*"]);
  writePackageManifest(repo, "packages/framework-context", "@croco/framework-context");
  writePackageManifest(repo, "packages/telemetry-sdk-node", "@croco/telemetry-sdk-node");
  writePackageManifest(repo, "packages/frontend-vite", "@croco/frontend-vite");
  writePackageManifest(repo, "packages/docs", "@croco/docs", true);
  git(repo, ["add", "README.md", "pnpm-workspace.yaml", "packages"]);
  git(repo, ["commit", "-m", "chore: initial commit"]);
  mkdirSync(join(repo, ".changeset"));

  return repo;
}

function checkoutBranch(repo: string, branch: string): void {
  git(repo, ["checkout", "-b", branch]);
}

function writePackageManifest(
  repo: string,
  packageDirectory: string,
  name: string,
  isPrivate = false,
  scripts?: Readonly<Record<string, string>>,
  version = "0.0.0",
): void {
  const directory = join(repo, packageDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name, private: isPrivate, version, ...(scripts ? { scripts } : {}) }, null, 2)}\n`,
  );
}

function writeWorkspaceFile(repo: string, patterns: readonly string[]): void {
  writeFileSync(
    join(repo, "pnpm-workspace.yaml"),
    `packages:\n${patterns.map((pattern) => `  - ${pattern}`).join("\n")}\n`,
  );
}

function commitFile(
  repo: string,
  fileName: string,
  content: string,
  subject: string,
  body?: string,
): void {
  const path = join(repo, fileName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${content}\n`);
  git(repo, ["add", fileName]);

  if (body) {
    git(repo, ["commit", "-m", subject, "-m", body]);
    return;
  }

  git(repo, ["commit", "-m", subject]);
}

function runScript(
  stdin: string,
  cwd: string,
  scriptEnv: Record<string, string> = {},
): ScriptResult {
  const { CI: _ci, GITHUB_ACTIONS: _githubActions, ...baseEnv } = process.env;
  const result = spawnSync("node", ["--experimental-strip-types", scriptPath], {
    cwd,
    encoding: "utf-8",
    env: {
      ...baseEnv,
      ...scriptEnv,
    },
    input: stdin,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

function newBranchStdin(branch: string, localSha: string): string {
  return `refs/heads/${branch} ${localSha} refs/heads/${branch} ${nullSha}\n`;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
    },
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

function listChangesets(repo: string): string[] {
  return git(repo, ["ls-files", ".changeset/*.md"])
    .split("\n")
    .filter(Boolean)
    .map((file) => file.replace(".changeset/", ""));
}

function readOnlyChangeset(repo: string): string {
  const changesets = listChangesets(repo);
  expect(changesets).toHaveLength(1);

  return readChangeset(repo, changesets[0]);
}

function readChangeset(repo: string, changeset: string): string {
  return git(repo, ["show", `HEAD:.changeset/${changeset}`]);
}
