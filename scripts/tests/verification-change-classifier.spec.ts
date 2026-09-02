import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { RELEASE_GATE_MAINTENANCE_PATHS } from "../release-gate-maintenance.mts";
import {
  classifyVerificationChanges,
  classifyVerificationPathFilters,
  readVerificationChangedFiles,
} from "../verification-change-classifier.mts";
import {
  createVerificationManifest,
  verificationImplementationPaths,
} from "../verification-manifest.mts";
import { formatVerificationProblem, VerificationProblem } from "../verification-problem.mts";

describe("verification change classifier", () => {
  it("loads before dependencies are installed", () => {
    const root = mkdtempSync(join(tmpdir(), "croco-verification-classifier-loader-"));
    try {
      const loaderPath = join(root, "reject-yaml-loader.mjs");
      writeFileSync(
        loaderPath,
        [
          "export async function resolve(specifier, context, nextResolve) {",
          '  if (specifier === "yaml") throw new Error("yaml loaded during classification");',
          "  return nextResolve(specifier, context);",
          "}",
        ].join("\n"),
      );
      const classifierUrl = new URL("../verification-change-classifier.mts", import.meta.url).href;

      expect(() =>
        execFileSync(
          execPath,
          [
            "--experimental-strip-types",
            "--experimental-loader",
            pathToFileURL(loaderPath).href,
            "--input-type=module",
            "--eval",
            `await import(${JSON.stringify(classifierUrl)});`,
          ],
          { stdio: "pipe" },
        ),
      ).not.toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps both sides of a rename out of a watched path", () => {
    const root = mkdtempSync(join(tmpdir(), "croco-verification-classifier-"));
    try {
      execFileSync("git", ["init", "--initial-branch=trunk"], { cwd: root });
      execFileSync("git", ["config", "user.email", "fixture@croco.dev"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Croco fixture"], { cwd: root });
      mkdirSync(join(root, "packages", "foo", "src"), { recursive: true });
      writeFileSync(join(root, "packages", "foo", "src", "api.ts"), "export {};\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "--message", "base"], { cwd: root });
      const base = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      mkdirSync(join(root, "archive"));
      execFileSync("git", ["mv", "packages/foo/src/api.ts", "archive/api.ts"], { cwd: root });
      execFileSync("git", ["commit", "--message", "rename"], { cwd: root });
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();

      const files = readVerificationChangedFiles(base, head, root);

      expect(files).toEqual(expect.arrayContaining(["packages/foo/src/api.ts", "archive/api.ts"]));
      expect(
        classifyVerificationPathFilters(files, "api-source:\n  - 'packages/*/src/**'"),
      ).toEqual({ "api-source": true });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("classifies exact immutable diff paths with the workflow glob subset", () => {
    expect(
      classifyVerificationPathFilters(
        ["docs/guides/start.md", "packages/retry-core/src/index.ts", ".github/workflows/ci.yml"],
        [
          "docs:",
          "  - 'README.md'",
          "  - 'docs/**/*.md'",
          "package_source:",
          "  - 'packages/*/src/**'",
          "workflow:",
          "  - '.github/workflows/ci.yml'",
          "unmatched:",
          "  - 'examples/**'",
        ].join("\n"),
      ),
    ).toEqual({ docs: true, package_source: true, workflow: true, unmatched: false });
  });

  it("fails closed for empty or non-string path filter definitions", () => {
    expect(() => classifyVerificationPathFilters(["docs/guide.md"], "docs: []")).toThrow(
      expect.objectContaining({ code: "INVALID_VERIFICATION_PATH_FILTERS" }),
    );
    expect(() => classifyVerificationPathFilters(["docs/guide.md"], "docs: [1]")).toThrow(
      expect.objectContaining({ code: "INVALID_VERIFICATION_PATH_FILTERS" }),
    );
  });

  it.each([
    [["docs/guide.md"], "repo"],
    [["docs-backup/guide.md"], "spine"],
    [["packages/retry-core/README.md.bak"], "spine"],
    [["packages/retry-core/src/index.ts"], "spine"],
    [["scripts/release-spine-evidence.mts"], "publish"],
    [["scripts/test-evidence-runtime.mts"], "publish"],
    [["scripts/ci-executable-policy.mts"], "publish"],
    [["scripts/tests/ci-executable-policy.spec.ts"], "publish"],
    [[".github/actionlint.yaml"], "publish"],
    [[".github/renovate.json"], "publish"],
    [[".github/workflows/ci.yml"], "publish"],
    [[".changeset/new.md"], "repo"],
    [["packages/retry-core/package.json"], "publish"],
    [["test-inventory.json"], "publish"],
    [["turbo.json"], "publish"],
    [["vitest.config.ts"], "publish"],
    [["tsconfig.json"], "publish"],
    [[".nvmrc"], "publish"],
    [[".gitignore"], "publish"],
  ] as const)("routes pull request files %j to %s", (files, profile) => {
    expect(classifyVerificationChanges("pull_request", files, "ci")).toMatchObject({
      profile,
      shouldRunVerification: true,
    });
  });

  it("routes trunk changesets, candidates, maintenance, and docs independently", () => {
    expect(classifyVerificationChanges("push", [".changeset/new.md"])).toMatchObject({
      allowPendingReleaseMetadata: false,
      profile: null,
      shouldUpdateReleasePr: true,
      shouldRunChangesetsAction: true,
    });
    expect(classifyVerificationChanges("push", ["packages/retry-core/package.json"])).toMatchObject(
      {
        allowPendingReleaseMetadata: false,
        profile: "publish",
        shouldRunVerification: true,
        shouldUpdateReleasePr: false,
        shouldRunChangesetsAction: true,
      },
    );
    expect(
      classifyVerificationChanges("push", ["scripts/release-spine-evidence.mts"]),
    ).toMatchObject({
      allowPendingReleaseMetadata: true,
      profile: "publish",
      shouldRunVerification: true,
      shouldRunChangesetsAction: false,
    });
    expect(classifyVerificationChanges("push", ["docs/guide.md"])).toMatchObject({
      allowPendingReleaseMetadata: false,
      profile: null,
      shouldRunVerification: false,
      shouldRunChangesetsAction: false,
    });
  });

  it("keeps workflow hardening out of diff-local Changesets publishing", () => {
    expect(
      classifyVerificationChanges("push", [
        ".github/actionlint.yaml",
        ".github/renovate.json",
        ".github/workflows/benchmark.yml",
        ".github/workflows/ci.yml",
        ".github/workflows/pr-review-companion.yml",
        ".github/workflows/release.yml",
        "scripts/ci-executable-policy.mts",
        "scripts/tests/ci-executable-policy.spec.ts",
        "scripts/tests/verification-change-classifier.spec.ts",
      ]),
    ).toMatchObject({
      allowPendingReleaseMetadata: true,
      profile: "publish",
      shouldRunVerification: true,
      shouldUpdateReleasePr: false,
      shouldRunChangesetsAction: false,
    });
  });

  it.each([
    [["packages/retry-core/src/index.ts"], "spine"],
    [[".changeset/new.md", "packages/retry-core/src/index.ts"], "spine"],
    [["docs/guide.md"], "repo"],
  ] as const)("routes CI push files %j to %s verification", (files, profile) => {
    expect(classifyVerificationChanges("push", files, "ci")).toMatchObject({
      profile,
      shouldRunVerification: true,
      shouldRunChangesetsAction: false,
      shouldUpdateReleasePr: false,
    });
  });

  it.each(verificationImplementationPaths())(
    "routes manifest-owned implementation maintenance %s through publish verification",
    (path) => {
      for (const event of ["pull_request", "push"] as const) {
        expect(classifyVerificationChanges(event, [path])).toMatchObject({
          profile: "publish",
          shouldRunVerification: true,
        });
      }
    },
  );

  it.each(RELEASE_GATE_MAINTENANCE_PATHS)(
    "routes authoritative release-gate maintenance %s through publish verification",
    (path) => {
      for (const event of ["pull_request", "push"] as const) {
        const classification = classifyVerificationChanges(event, [path]);
        expect(classification).toMatchObject({
          profile: "publish",
          shouldRunVerification: true,
        });
        const releaseGate = createVerificationManifest("publish", {
          base: "origin/trunk",
          changedFiles: [path],
          head: "HEAD",
        }).find(({ id }) => id === "release-gate-tests");
        expect(releaseGate?.applicable).toBe(true);
      }
    },
  );

  it.each([
    "scripts/verification-manifest.mts",
    "scripts/verification-change-classifier.mts",
    "scripts/verification-command.mts",
    "scripts/verification-problem.mts",
    "scripts/workflow-verification-contract.mts",
  ])("routes verification control maintenance %s through publish verification", (path) => {
    expect(classifyVerificationChanges("push", [path])).toMatchObject({
      profile: "publish",
      shouldRunVerification: true,
    });
  });

  it("unions mixed release actions and maps dispatch explicitly", () => {
    expect(
      classifyVerificationChanges("push", [".changeset/new.md", "package.json"]),
    ).toMatchObject({
      profile: "publish",
      shouldUpdateReleasePr: true,
      shouldRunChangesetsAction: true,
    });
    expect(classifyVerificationChanges("workflow_dispatch", [])).toMatchObject({
      allowPendingReleaseMetadata: false,
      profile: "publish",
      shouldRunVerification: true,
      shouldUpdateReleasePr: true,
      shouldRunChangesetsAction: true,
    });
    expect(classifyVerificationChanges("workflow_dispatch", [], "ci")).toMatchObject({
      allowPendingReleaseMetadata: true,
      profile: "publish",
      shouldRunVerification: true,
      shouldUpdateReleasePr: false,
      shouldRunChangesetsAction: false,
    });
  });

  it("fails closed for unknown release-adjacent paths", () => {
    try {
      classifyVerificationChanges("pull_request", [".changeset/unknown.json"]);
      expect.unreachable("classification must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationProblem);
      expect(error).toMatchObject({
        category: "contract",
        code: "UNCLASSIFIED_RELEASE_PATH",
        message: expect.stringContaining("Unclassified release-adjacent path"),
      });
      expect(formatVerificationProblem(error)).toContain("[UNCLASSIFIED_RELEASE_PATH/contract]");
    }
  });
});
