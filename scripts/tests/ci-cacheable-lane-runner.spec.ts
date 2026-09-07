import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CACHEABLE_LANE_CHECK_SCHEMA,
  collectImmutableCheckOutputs,
  createCacheableLaneExecutionPlan,
  createProducerBundleFromReport,
  runCacheableLane,
} from "../ci-cacheable-lane-runner.mts";
import { createReusableReceipt, PRODUCER_LANES } from "../ci-lane-evidence.mts";
import { SECURITY_OWNERSHIP } from "../ci-verification-contract.mts";
import { defaultCommandRunner } from "../release-spine-evidence.mts";
import { fileDigest, inventoryDigest, readTestInventory } from "../test-inventory.mts";
import { VERIFICATION_LANE_OWNERSHIP } from "../verification-manifest.mts";
import { VerificationProblem } from "../verification-problem.mts";
import type { ExperimentIdentity, ProducerLane } from "../ci-lane-evidence.mts";
import type {
  CommandRunner,
  EvidenceArtifactReference,
  EvidenceCommand,
} from "../release-spine-evidence.mts";

const DIGEST = "a".repeat(64);
const COMMIT_SHA = "b".repeat(40);
const ARTIFACT_FRESHNESS_CLOCK = {
  nowIso: () => new Date(0).toISOString(),
  nowMs: () => 0,
};

function identity(
  profile: "repo" | "spine" | "publish" = "publish",
  runId = "12345",
  runAttempt = 2,
): ExperimentIdentity {
  return {
    architectureVersion: "shadow-split",
    commitSha: COMMIT_SHA,
    runId,
    runAttempt,
    profile,
    manifestDigest: DIGEST,
    inventoryDigest: "c".repeat(64),
    toolchainDigest: "d".repeat(64),
    inputDigest: "e".repeat(64),
    verificationExperimentId: `cacheable-lanes-test-${runId}-${runAttempt}`,
  };
}

function useCurrentRunEnvironment(): void {
  vi.stubEnv("GITHUB_SHA", COMMIT_SHA);
  vi.stubEnv("GITHUB_RUN_ID", "12345");
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
}

function successfulRunner(rootDir: string): CommandRunner {
  return async (command) => {
    for (const artifact of command.artifacts ?? []) {
      const path = join(rootDir, artifact.path);
      mkdirSync(dirname(path), { recursive: true });
      const contents = artifact.path.endsWith("published-test-lane.json")
        ? JSON.stringify({
            schemaVersion: "croco.test-lane-report/v2",
            inventoryVersion: 1,
            inventoryDigest: DIGEST,
            lane: "published",
            allowLive: false,
            selectedOwners: ["fixture"],
            status: "passed",
            executedPaths: ["fixture.spec.ts"],
            skippedFiles: [],
            diagnostics: [],
            commands: [
              {
                owner: "fixture",
                cwd: ".",
                paths: ["fixture.spec.ts"],
                command: ["vitest", "run", "fixture.spec.ts"],
                status: "passed",
                exitCode: 0,
                durationMs: 1,
                cacheStatus: "miss",
                executedPaths: ["fixture.spec.ts"],
                skippedFiles: [],
                executionState: "executed",
              },
            ],
          })
        : artifact.path.endsWith("public-api-summary.json")
          ? JSON.stringify({ status: "pass" })
          : `${command.id}\n`;
      writeFileSync(path, `${contents}\n`);
    }
    return {
      errorCode: null,
      errorMessage: null,
      signal: null,
      status: 0,
      stderr: "",
      stdout: `${command.id} passed`,
      timedOut: false,
    };
  };
}

function invalidPublishedLaneRunner(rootDir: string): CommandRunner {
  const fallback = successfulRunner(rootDir);
  return async (command, context) => {
    const result = await fallback(command, context);
    for (const artifact of command.artifacts ?? []) {
      if (!artifact.path.endsWith("published-test-lane.json")) continue;
      writeFileSync(
        join(rootDir, artifact.path),
        `${JSON.stringify({ schemaVersion: "croco.test-lane-report/v2" })}\n`,
      );
    }
    return result;
  };
}

function generatedArtifactsRunner(
  rootDir: string,
  includeSourcePath: (path: string) => boolean = () => true,
): CommandRunner {
  return async (command, context) => {
    if (command.command[0] === "node" && command.command[1] === "-e") {
      return defaultCommandRunner(command, context);
    }
    if (command.id === "generated-app-smoke") {
      const repositoryRoot = join(import.meta.dirname, "..", "..");
      const { diagnostics, inventory } = readTestInventory(
        join(repositoryRoot, "test-inventory.json"),
      );
      if (diagnostics.length > 0) {
        throw new VerificationProblem(
          "INVALID_TEST_FIXTURE_INVENTORY",
          "contract",
          "Expected the repository test inventory to be valid.",
        );
      }
      writeFileSync(join(rootDir, "test-inventory.json"), `${JSON.stringify(inventory)}\n`);
      const materializedRoot = join(rootDir, "ci-reports", "generated-apps", "materialized-tests");
      const materializations = inventory.tests
        .filter(
          (entry) =>
            entry.lane === "generated-app" && entry.generated && includeSourcePath(entry.path),
        )
        .map((entry) => {
          const generated = entry.generated;
          if (!generated) {
            throw new VerificationProblem(
              "MISSING_TEST_FIXTURE_GENERATED_MAPPING",
              "contract",
              `Expected generated mapping for ${entry.path}.`,
            );
          }
          const sourcePath = join(rootDir, entry.path);
          const generatedPath = join(materializedRoot, generated.generatedPath);
          mkdirSync(dirname(sourcePath), { recursive: true });
          mkdirSync(dirname(generatedPath), { recursive: true });
          writeFileSync(sourcePath, `${entry.path}\n`);
          writeFileSync(generatedPath, `${entry.path}\n`);
          return {
            sourcePath: entry.path,
            sourceDigest: fileDigest(sourcePath),
            generatedPath: generated.generatedPath,
            generatedDigest: fileDigest(generatedPath),
            inventoryDigest: inventoryDigest(inventory),
            commandId: generated.commandId,
          };
        });
      for (const artifact of command.artifacts ?? []) {
        if (!artifact.required || artifact.path.endsWith("materialized-tests")) continue;
        const path = join(rootDir, artifact.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          artifact.path.endsWith("materialization-evidence.json")
            ? `${JSON.stringify(materializations)}\n`
            : `${command.id}\n`,
        );
      }
    }
    return {
      errorCode: null,
      errorMessage: null,
      signal: null,
      status: 0,
      stderr: "",
      stdout: `${command.id} passed`,
      timedOut: false,
    };
  };
}

function failingRunner(failedId: string): CommandRunner {
  return async (command) => ({
    errorCode: null,
    errorMessage: null,
    signal: null,
    status: command.id === failedId ? 1 : 0,
    stderr: command.id === failedId ? `${failedId} failed` : "",
    stdout: "",
    timedOut: false,
  });
}

function regularFiles(path: string): readonly string[] {
  const metadata = lstatSync(path);
  if (metadata.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => regularFiles(join(path, entry.name)));
}

function securityPhysical() {
  return SECURITY_OWNERSHIP.filter(({ owner }) => owner === "coverage-security").map(
    ({ id, owner, semantics }) => ({
      id,
      owner,
      semantics,
      outcome: "passed" as const,
      diagnostics: [],
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cacheable producer lane planning", () => {
  it("covers every producer-owned check exactly once and filters absent logical dependencies", () => {
    const plannedOwnedIds = PRODUCER_LANES.flatMap((lane) => [
      ...createCacheableLaneExecutionPlan("publish", lane).ownedIds,
    ]);
    const expectedOwnedIds = Object.entries(VERIFICATION_LANE_OWNERSHIP)
      .filter(([, lane]) => lane !== "split-validation-shadow")
      .map(([id]) => id);

    expect(new Set(plannedOwnedIds).size).toBe(plannedOwnedIds.length);
    expect([...plannedOwnedIds].sort()).toEqual([...expectedOwnedIds].sort());

    for (const lane of PRODUCER_LANES) {
      const plan = createCacheableLaneExecutionPlan("publish", lane);
      const localIds = new Set(plan.commands.map(({ id }) => id));
      expect(
        plan.commands.every((command) =>
          (command.dependsOn ?? []).every((dependency) => localIds.has(dependency)),
        ),
      ).toBe(true);
      expect(plan.physicalPrerequisiteIds.every((id) => !plan.ownedIds.includes(id))).toBe(true);
    }

    const packagePlan = createCacheableLaneExecutionPlan("publish", "package-artifacts", {
      allowPendingReleaseMetadata: true,
    });
    expect(packagePlan.physicalPrerequisiteIds).toEqual(["architecture-policy-runtime", "build"]);
    expect(packagePlan.commands.find(({ id }) => id === "release-metadata")?.command).toContain(
      "--allow-pending-changesets",
    );

    const corePlan = createCacheableLaneExecutionPlan("publish", "core-verification");
    expect(
      corePlan.commands.find((command) => command.id === "typecheck")?.concurrencyGroups,
    ).toEqual(["workspace-artifacts"]);
    expect(corePlan.commands.find((command) => command.id === "test")?.concurrencyGroups).toEqual([
      "workspace-artifacts",
      "test-integration",
    ]);
    expect(
      corePlan.commands.find((command) => command.id === "integration-test-lane")
        ?.concurrencyGroups,
    ).toEqual(["workspace-artifacts", "package-entrypoints", "test-integration"]);
  });

  it("rejects the synthesis lane as a producer", () => {
    expect(() =>
      createCacheableLaneExecutionPlan("publish", "split-validation-shadow" as ProducerLane),
    ).toThrow(/must be one of/);
  });
});

describe("cacheable producer lane evidence", () => {
  it("emits an exact N/A attestation without executing or creating a receipt", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-na-"));
    const runner = vi.fn<CommandRunner>();

    const result = await runCacheableLane({
      identity: identity(),
      lane: "generated-apps",
      profile: "publish",
      rootDir,
      base: "base",
      head: "head",
      changedFiles: ["README.md"],
      runner,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(result.failed).toBe(false);
    expect(result.bundle.checks).toEqual([
      expect.objectContaining({
        id: "generated-app-smoke",
        selection: "not-applicable",
        outcome: "not-applicable",
        receiptDigest: null,
      }),
    ]);
    expect(result.bundle.receipts).toEqual([]);
    expect(result.bundle.attestations).toHaveLength(1);
    expect(result.bundle.attestations[0]?.decision).toBe("not-applicable");
    const record = JSON.parse(
      readFileSync(join(result.outputDir, "checks", "generated-app-smoke.json"), "utf8"),
    ) as { schemaVersion: string; selection: string };
    expect(record).toMatchObject({
      schemaVersion: CACHEABLE_LANE_CHECK_SCHEMA,
      selection: "not-applicable",
    });
  });

  it("emits N/A evidence for owned commands absent from the selected profile", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-profile-na-"));
    const runner = vi.fn<CommandRunner>();

    const result = await runCacheableLane({
      identity: identity("repo"),
      lane: "generated-apps",
      profile: "repo",
      rootDir,
      runner,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(result.report.checks).toEqual([]);
    expect(result.bundle.checks).toEqual([
      expect.objectContaining({
        id: "generated-app-smoke",
        selection: "not-applicable",
        outcome: "not-applicable",
      }),
    ]);
    expect(result.bundle.attestations).toHaveLength(1);
    expect(result.bundle.receipts).toEqual([]);
  });

  it("emits a deterministic failed producer record and forbids cache reuse", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-injected-"));
    const result = await runCacheableLane({
      identity: identity(),
      lane: "coverage-security",
      profile: "publish",
      rootDir,
      runner: successfulRunner(rootDir),
      securityPhysical: securityPhysical(),
      injectedFailure: "coverage-security",
    });

    expect(result.failed).toBe(true);
    expect(result.bundle.checks.find(({ id }) => id === "security-allowlists")).toMatchObject({
      outcome: "failed",
      diagnostics: ["security-allowlists:CACHEABLE_EXPERIMENT_INJECTED_FAILURE"],
    });
    await expect(
      runCacheableLane({
        identity: identity(),
        lane: "core-verification",
        profile: "publish",
        rootDir: mkdtempSync(join(tmpdir(), "croco-cacheable-lane-injected-cache-")),
        cacheDir: ".cache",
        injectedFailure: "core-verification",
      }),
    ).rejects.toThrow(/cannot restore or write reusable receipts/);
  });

  it("forbids change-scoped receipt caching for full-selection runs", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-full-selection-cache-"));

    await expect(
      runCacheableLane({
        identity: identity(),
        lane: "core-verification",
        profile: "publish",
        rootDir,
        fullSelection: true,
        cacheDir: join(rootDir, ".cache", "core-verification"),
        runner: successfulRunner(rootDir),
      }),
    ).rejects.toMatchObject({ code: "FULL_SELECTION_CACHE_FORBIDDEN", category: "input" });
  });

  it("normalizes invalid lane report parsing and validation failures", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-invalid-report-"));

    await expect(
      runCacheableLane({
        identity: identity(),
        lane: "package-artifacts",
        profile: "publish",
        rootDir,
        clock: ARTIFACT_FRESHNESS_CLOCK,
        runner: invalidPublishedLaneRunner(rootDir),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_LANE_REPORT",
      category: "contract",
      message: expect.stringContaining("Test lane evidence has an invalid report shape"),
    });
  });

  it("restores only an exact-key lane cache and issues current-run attestations", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-exact-hit-"));
    const cacheDir = join(rootDir, ".cache", "package-artifacts");
    const base = "a".repeat(40);
    const changedFiles = ["packages/testing/package.json"];
    const cold = await runCacheableLane({
      identity: identity("publish"),
      lane: "package-artifacts",
      profile: "publish",
      rootDir,
      base,
      head: COMMIT_SHA,
      changedFiles,
      cacheDir,
      clock: ARTIFACT_FRESHNESS_CLOCK,
      runner: successfulRunner(rootDir),
    });
    expect(cold.cacheHit).toBe(false);
    expect(cold.failed).toBe(false);
    expect(cold.bundle.receipts.length).toBeGreaterThan(0);

    vi.stubEnv("GITHUB_RUN_ID", "67890");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "3");
    const hit = await runCacheableLane({
      identity: identity("publish", "67890", 3),
      lane: "package-artifacts",
      profile: "publish",
      rootDir,
      base,
      head: COMMIT_SHA,
      changedFiles,
      cacheDir,
      cacheOrigin: "github-exact-key",
      clock: ARTIFACT_FRESHNESS_CLOCK,
      runner: successfulRunner(rootDir),
    });

    expect(hit.cacheHit).toBe(true);
    expect(hit.bundle.runId).toBe("67890");
    expect(hit.bundle.runAttempt).toBe(3);
    expect(hit.bundle.attestations[0]).toMatchObject({ runId: "67890", runAttempt: 3 });
    expect(hit.bundle.receipts.length).toBeGreaterThan(0);
    expect(hit.bundle.receipts.every(({ cache }) => cache.origin === "github-exact-key")).toBe(
      true,
    );
    expect(
      hit.bundle.checks.map(({ id, selection, semantics, outcome, diagnostics }) => ({
        id,
        selection,
        semantics,
        outcome,
        diagnostics,
      })),
    ).toEqual(
      cold.bundle.checks.map(({ id, selection, semantics, outcome, diagnostics }) => ({
        id,
        selection,
        semantics,
        outcome,
        diagnostics,
      })),
    );
    const currentRecord = JSON.parse(
      readFileSync(join(hit.outputDir, "checks", "package-entrypoints-smoke.json"), "utf8"),
    ) as { identity: { runId: string; runAttempt: number } };
    expect(currentRecord.identity).toMatchObject({ runId: "67890", runAttempt: 3 });

    vi.stubEnv("GITHUB_RUN_ID", "67891");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "4");
    const mutatingRunner: CommandRunner = async (command) => {
      if (command.id === "package-entrypoints-smoke") {
        const artifact = command.artifacts?.[0];
        if (!artifact) throw new Error("Expected a package entrypoint artifact.");
        writeFileSync(join(rootDir, artifact.path), "mutated cached output\n");
      }
      return {
        errorCode: null,
        errorMessage: null,
        signal: null,
        status: 0,
        stderr: "",
        stdout: `${command.id} passed`,
        timedOut: false,
      };
    };
    await expect(
      runCacheableLane({
        identity: identity("publish", "67891", 4),
        lane: "package-artifacts",
        profile: "publish",
        rootDir,
        base,
        head: COMMIT_SHA,
        changedFiles,
        cacheDir,
        cacheOrigin: "github-exact-key",
        clock: ARTIFACT_FRESHNESS_CLOCK,
        runner: mutatingRunner,
      }),
    ).rejects.toMatchObject({ code: "EXACT_CACHE_REVALIDATION_FAILED" });
  });

  it("canonicalizes symbolic cache refs before binding lane commands", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-symbolic-ref-"));
    const cacheDir = join(rootDir, ".cache", "package-artifacts");
    const packageManifest = join(rootDir, "packages", "testing", "package.json");
    mkdirSync(dirname(packageManifest), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: rootDir });
    execFileSync("git", ["config", "user.email", "ci@example.invalid"], { cwd: rootDir });
    execFileSync("git", ["config", "user.name", "CI Fixture"], { cwd: rootDir });
    writeFileSync(packageManifest, '{"name":"@croco/testing"}\n');
    execFileSync("git", ["add", "."], { cwd: rootDir });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: rootDir });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    writeFileSync(packageManifest, '{"name":"@croco/testing","private":true}\n');
    execFileSync("git", ["add", "."], { cwd: rootDir });
    execFileSync("git", ["commit", "--quiet", "-m", "head"], { cwd: rootDir });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    vi.stubEnv("GITHUB_SHA", headSha);
    vi.stubEnv("GITHUB_RUN_ID", "12345");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    const coldIdentity = { ...identity("publish", "12345", 1), commitSha: headSha };
    const changedFiles = ["packages/testing/package.json"];

    const cold = await runCacheableLane({
      identity: coldIdentity,
      lane: "package-artifacts",
      profile: "publish",
      rootDir,
      base: baseSha,
      head: headSha,
      changedFiles,
      cacheDir,
      clock: ARTIFACT_FRESHNESS_CLOCK,
      runner: successfulRunner(rootDir),
    });
    expect(cold.cacheHit).toBe(false);

    vi.stubEnv("GITHUB_RUN_ID", "67890");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
    const hit = await runCacheableLane({
      identity: { ...coldIdentity, runId: "67890", runAttempt: 2 },
      lane: "package-artifacts",
      profile: "publish",
      rootDir,
      base: "HEAD^",
      head: "HEAD",
      changedFiles,
      cacheDir,
      cacheOrigin: "github-exact-key",
      clock: ARTIFACT_FRESHNESS_CLOCK,
      runner: successfulRunner(rootDir),
    });

    expect(hit.cacheHit).toBe(true);
  });

  it("emits seven-case producer facts for 12 executed paths and rejects a missing selected test", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-generated-seven-cases-"));
    const selectedPath = (path: string) =>
      !path.includes("/base-ddd/") && !path.includes("/spa-be-split/tests/journeys/");
    const options = {
      identity: identity("spine"),
      lane: "generated-apps" as const,
      profile: "spine" as const,
      rootDir,
      base: "a".repeat(40),
      head: COMMIT_SHA,
      changedFiles: ["packages/metering-core/src/index.ts"],
    };
    const result = await runCacheableLane({
      ...options,
      runner: generatedArtifactsRunner(rootDir, selectedPath),
    });
    expect(result.failed).toBe(false);
    const facts = JSON.parse(
      readFileSync(join(result.outputDir, "producer-facts.json"), "utf8"),
    ) as { requiredSourcePaths: string[]; executedSourcePaths: string[] };
    expect(facts.executedSourcePaths).toHaveLength(12);
    expect(facts.requiredSourcePaths).toEqual(facts.executedSourcePaths);
    expect(
      facts.requiredSourcePaths.some((path) => path.includes("/spa-be-split/tests/journeys/")),
    ).toBe(false);

    const missingRoot = mkdtempSync(join(tmpdir(), "croco-cacheable-generated-missing-selected-"));
    await expect(
      runCacheableLane({
        ...options,
        rootDir: missingRoot,
        runner: generatedArtifactsRunner(
          missingRoot,
          (path) => selectedPath(path) && !path.endsWith("/AdminConsole.spec.ts"),
        ),
      }),
    ).rejects.toMatchObject({ code: "INVALID_GENERATED_SYNTHESIS_FACTS" });
  });

  it("restores a generated-app cache when an optional artifact was not produced", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-generated-optional-"));
    const cacheDir = join(rootDir, ".cache", "generated-apps");
    const base = "a".repeat(40);
    const changedFiles = [
      "packages/create-croco-app/templates/admin-console/apps/api-server/src/tests/AdminConsole.spec.ts",
    ];
    const optionalArtifact = join(
      rootDir,
      "ci-reports",
      "generated-apps",
      "spine-blocking-journeys",
    );

    const cold = await runCacheableLane({
      identity: identity("publish"),
      lane: "generated-apps",
      profile: "publish",
      rootDir,
      base,
      head: COMMIT_SHA,
      changedFiles,
      cacheDir,
      runner: generatedArtifactsRunner(rootDir),
    });
    expect(cold.failed).toBe(false);
    expect(existsSync(optionalArtifact)).toBe(false);

    vi.stubEnv("GITHUB_RUN_ID", "67890");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "3");
    const hit = await runCacheableLane({
      identity: identity("publish", "67890", 3),
      lane: "generated-apps",
      profile: "publish",
      rootDir,
      base,
      head: COMMIT_SHA,
      changedFiles,
      cacheDir,
      cacheOrigin: "github-exact-key",
      runner: generatedArtifactsRunner(rootDir),
    });

    expect(hit.cacheHit).toBe(true);
    expect(hit.failed).toBe(false);
    expect(existsSync(optionalArtifact)).toBe(false);
    expect(hit.report.checks.find(({ id }) => id === "generated-app-smoke")).toMatchObject({
      status: "passed",
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          sourcePath: "ci-reports/generated-apps/spine-blocking-journeys",
          required: false,
          exists: false,
        }),
      ]),
    });
  });

  it("rejects cross-run caching for the physical coverage-security lane", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-security-cache-"));

    await expect(
      runCacheableLane({
        identity: identity(),
        lane: "coverage-security",
        profile: "publish",
        rootDir,
        cacheDir: join(rootDir, ".cache", "coverage-security"),
        cacheOrigin: "github-exact-key",
        runner: vi.fn<CommandRunner>(),
        securityPhysical: securityPhysical(),
      }),
    ).rejects.toThrow(/coverage-security physical results cannot be restored/);
  });

  it("reports an invalid exact-cache base with a stable change-range Problem", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-invalid-base-"));

    await expect(
      runCacheableLane({
        identity: identity(),
        lane: "package-artifacts",
        profile: "publish",
        rootDir,
        base: "missing-base-ref",
        head: COMMIT_SHA,
        changedFiles: [],
        cacheDir: join(rootDir, ".cache", "package-artifacts"),
        runner: successfulRunner(rootDir),
      }),
    ).rejects.toMatchObject({ code: "CACHEABLE_LANE_CHANGE_RANGE_FAILED", category: "input" });
  });

  it.each(["release-metadata", "architecture-policy-runtime"])(
    "turns a failed %s prerequisite into owned failure evidence without attesting it",
    async (prerequisite) => {
      useCurrentRunEnvironment();
      const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-prerequisite-"));

      const result = await runCacheableLane({
        identity: identity(),
        lane: "generated-apps",
        profile: "publish",
        rootDir,
        runner: failingRunner(prerequisite),
      });

      expect(result.failed).toBe(true);
      expect(result.report.checks.map(({ id }) => id)).toEqual([
        "release-metadata",
        "architecture-policy-runtime",
        "build",
        "generated-app-smoke",
      ]);
      expect(result.bundle.checks.map(({ id }) => id)).toEqual(["generated-app-smoke"]);
      expect(result.bundle.attestations.map(({ checkId }) => checkId)).toEqual([
        "generated-app-smoke",
      ]);
      expect(result.bundle.receipts).toEqual([]);
      expect(result.bundle.checks[0]).toMatchObject({
        outcome: "failed",
        receiptDigest: null,
      });
    },
  );

  it("creates executed receipts for selected passed checks and keeps warning semantics advisory", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-passed-"));

    const result = await runCacheableLane({
      identity: identity(),
      lane: "coverage-security",
      profile: "publish",
      rootDir,
      clock: ARTIFACT_FRESHNESS_CLOCK,
      runner: successfulRunner(rootDir),
      securityPhysical: securityPhysical(),
    });

    expect(result.failed).toBe(false);
    expect(result.bundle.status).toBe("success");
    expect(result.bundle.receipts).toHaveLength(result.bundle.checks.length);
    expect(result.bundle.receipts.every(({ cache }) => cache.origin === "executed")).toBe(true);
    expect(result.bundle.checks.find(({ id }) => id === "core-coverage-warning")?.semantics).toBe(
      "advisory",
    );
    expect(
      result.bundle.checks
        .filter(({ id }) => id !== "core-coverage-warning")
        .every(({ semantics }) => semantics === "blocking"),
    ).toBe(true);

    const currentIdentity = identity("publish", "current-cache-run", 4);
    const exactReceipts = new Map(
      result.bundle.receipts.map((receipt) => {
        const { schemaVersion: _schema, receiptDigest: _digest, ...unsigned } = receipt;
        return [
          receipt.checkId,
          createReusableReceipt({
            ...unsigned,
            cache: { origin: "github-exact-key", revalidated: true, policyDigest: null },
          }),
        ];
      }),
    );
    const exactBundle = createProducerBundleFromReport({
      identity: currentIdentity,
      lane: "coverage-security",
      rootDir,
      outputDir: result.outputDir,
      plan: createCacheableLaneExecutionPlan("publish", "coverage-security"),
      report: {
        ...result.report,
        provenance: {
          commitSha: currentIdentity.commitSha,
          runId: currentIdentity.runId,
          runAttempt: String(currentIdentity.runAttempt),
        },
      },
      reusedReceipts: exactReceipts,
    });
    expect(exactBundle.receipts.every(({ cache }) => cache.origin === "github-exact-key")).toBe(
      true,
    );
    const exactRecord = JSON.parse(
      readFileSync(join(result.outputDir, "checks", "core-coverage-warning.json"), "utf8"),
    ) as { identity: { runId: string; runAttempt: number } };
    expect(exactRecord.identity).toMatchObject({ runId: "current-cache-run", runAttempt: 4 });

    const warningBefore = result.bundle.receipts.find(
      ({ checkId }) => checkId === "core-coverage-warning",
    );
    const copiedWarning = result.report.checks
      .find(({ id }) => id === "core-coverage-warning")
      ?.artifacts.find(({ copiedPath }) => copiedPath !== null)?.copiedPath;
    if (!warningBefore || !copiedWarning) {
      throw new Error("Expected core coverage warning receipt and copied artifact.");
    }
    writeFileSync(join(rootDir, copiedWarning), "mutated warning evidence\n");
    const mutatedBundle = createProducerBundleFromReport({
      identity: identity(),
      lane: "coverage-security",
      rootDir,
      outputDir: result.outputDir,
      plan: createCacheableLaneExecutionPlan("publish", "coverage-security"),
      report: result.report,
    });
    expect(
      mutatedBundle.receipts.find(({ checkId }) => checkId === "core-coverage-warning")
        ?.receiptDigest,
    ).not.toBe(warningBefore.receiptDigest);
    expect(mutatedBundle.bundleDigest).not.toBe(result.bundle.bundleDigest);

    const plan = createCacheableLaneExecutionPlan("publish", "coverage-security");
    const firstCheck = result.report.checks[0];
    if (!firstCheck) throw new Error("Expected the coverage lane report to contain checks.");
    expect(() =>
      createProducerBundleFromReport({
        identity: identity(),
        lane: "coverage-security",
        rootDir,
        outputDir: result.outputDir,
        plan,
        report: {
          ...result.report,
          checks: [...result.report.checks, firstCheck],
        },
      }),
    ).toThrow(/duplicate check IDs/);
  });

  it("does not fail the producer job for the advisory coverage warning", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-advisory-"));

    const result = await runCacheableLane({
      identity: identity(),
      lane: "coverage-security",
      profile: "publish",
      rootDir,
      runner: failingRunner("core-coverage-warning"),
      securityPhysical: securityPhysical(),
    });

    expect(result.failed).toBe(false);
    expect(result.bundle.status).toBe("success");
    expect(result.bundle.checks.find(({ id }) => id === "core-coverage-warning")).toMatchObject({
      semantics: "advisory",
      outcome: "failed",
    });
  });

  it("copies and digest-binds exact workflow security reports", async () => {
    useCurrentRunEnvironment();
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-security-"));
    const auditPath = join(rootDir, "ci-reports", "security", "pnpm-audit-prod.txt");
    const sarifPath = join(rootDir, "ci-reports", "security", "gitleaks.sarif");
    mkdirSync(dirname(auditPath), { recursive: true });
    writeFileSync(auditPath, "audit evidence\n");
    writeFileSync(sarifPath, '{"runs":[]}\n');

    const result = await runCacheableLane({
      identity: identity(),
      lane: "coverage-security",
      profile: "publish",
      rootDir,
      runner: successfulRunner(rootDir),
      securityPhysical: securityPhysical(),
      securityArtifactPaths: [
        "ci-reports/security/pnpm-audit-prod.txt",
        "ci-reports/security/gitleaks.sarif",
      ],
    });

    expect(result.bundle.artifact.files.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "ci-reports/cacheable-ci/coverage-security/security/pnpm-audit-prod.txt",
        "ci-reports/cacheable-ci/coverage-security/security/gitleaks.sarif",
      ]),
    );
    expect(readFileSync(join(result.outputDir, "security", "pnpm-audit-prod.txt"), "utf8")).toBe(
      "audit evidence\n",
    );

    await expect(
      runCacheableLane({
        identity: identity(),
        lane: "coverage-security",
        profile: "publish",
        rootDir,
        runner: successfulRunner(rootDir),
        securityPhysical: securityPhysical(),
        securityArtifactPaths: ["package.json"],
      }),
    ).rejects.toThrow(/descendant/);
  });

  it("expands copied artifact directories into sorted exact immutable file outputs", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-directory-"));
    const outputDir = join(rootDir, "ci-reports", "cacheable-ci", "generated-apps");
    const copiedRelative = join(
      "ci-reports",
      "cacheable-ci",
      "generated-apps",
      "execution",
      "artifacts",
      "generated-app-smoke",
      "bundle",
    );
    const copiedDirectory = join(rootDir, copiedRelative);
    mkdirSync(join(copiedDirectory, "nested"), { recursive: true });
    writeFileSync(join(copiedDirectory, "z.json"), "z\n");
    writeFileSync(join(copiedDirectory, "nested", "a.json"), "a\n");
    const artifact: EvidenceArtifactReference = {
      label: "Generated bundle",
      path: "ci-reports/generated-apps/source",
      required: true,
      copiedPath: copiedRelative,
      copyError: null,
      exists: true,
      fresh: true,
      modifiedAt: new Date().toISOString(),
      sourcePath: "ci-reports/generated-apps/source",
    };

    const recordOutput = {
      path: "ci-reports/cacheable-ci/generated-apps/checks/generated-app-smoke.json",
      digest: DIGEST,
      bytes: 1,
    } as const;
    const outputs = collectImmutableCheckOutputs({
      rootDir,
      outputDir,
      recordOutput,
      artifacts: [artifact],
    });

    expect(outputs.map(({ path }) => path)).toEqual([
      "ci-reports/cacheable-ci/generated-apps/checks/generated-app-smoke.json",
      "ci-reports/cacheable-ci/generated-apps/execution/artifacts/generated-app-smoke/bundle/nested/a.json",
      "ci-reports/cacheable-ci/generated-apps/execution/artifacts/generated-app-smoke/bundle/z.json",
    ]);
    expect(() =>
      collectImmutableCheckOutputs({
        rootDir,
        outputDir,
        recordOutput,
        artifacts: [{ ...artifact, copiedPath: `${copiedRelative}-missing` }],
      }),
    ).toThrow(/Unable to read copied artifact/);
  });

  it.each([false, true])(
    "includes all immutable prerequisite evidence in coverage-security (metadata failure: %s)",
    async (metadataFails) => {
      useCurrentRunEnvironment();
      const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-paths-"));

      const result = await runCacheableLane({
        identity: identity(),
        lane: "coverage-security",
        profile: "publish",
        rootDir,
        runner: metadataFails ? failingRunner("release-metadata") : successfulRunner(rootDir),
        securityPhysical: securityPhysical(),
      });
      const serialized = JSON.stringify(result.bundle);
      const prerequisite = result.report.checks.find(({ id }) => id === "release-metadata");
      expect(prerequisite?.status).toBe(metadataFails ? "failed" : "passed");
      expect(result.bundle.checks.some(({ id }) => id === "release-metadata")).toBe(false);
      const prerequisiteFiles = prerequisite?.artifacts.flatMap(({ copiedPath }) =>
        copiedPath === null ? [] : regularFiles(join(rootDir, copiedPath)),
      );
      expect(prerequisiteFiles).toHaveLength(metadataFails ? 2 : 0);
      for (const path of prerequisiteFiles ?? []) {
        expect(result.bundle.artifact.files).toContainEqual({
          path: relative(rootDir, path).replaceAll("\\", "/"),
          digest: fileDigest(path),
          bytes: lstatSync(path).size,
        });
      }

      expect(result.bundle.checks.some(({ id }) => id === "build")).toBe(false);
      expect(serialized).not.toMatch(/(?:^|[\\/])\.turbo(?:[\\/]|$)/);
      expect(serialized).not.toMatch(/(?:^|[\\/])dist(?:[\\/]|$)/);
      expect(serialized.toLowerCase()).not.toContain("checkpoint");
      expect(result.bundle.artifact.files.every(({ path }) => path.startsWith("ci-reports/"))).toBe(
        true,
      );
      const uploadedFiles = regularFiles(result.outputDir)
        .map((path) => relative(rootDir, path).replaceAll("\\", "/"))
        .filter((path) => !path.endsWith("/producer-bundle.json"))
        .sort();
      expect(result.bundle.artifact.files.map(({ path }) => path).sort()).toEqual(uploadedFiles);
    },
  );

  it("fails closed when current-run provenance drifts from the strict identity", async () => {
    useCurrentRunEnvironment();
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "3");
    const rootDir = mkdtempSync(join(tmpdir(), "croco-cacheable-lane-drift-"));

    await expect(
      runCacheableLane({
        identity: identity(),
        lane: "generated-apps",
        profile: "publish",
        rootDir,
        base: "base",
        head: "head",
        changedFiles: ["README.md"],
        runner: successfulRunner(rootDir),
      }),
    ).rejects.toThrow(/runAttempt does not match/);
  });
});
