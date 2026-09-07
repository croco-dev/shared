import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildSpinePromotionMarkdown,
  createCiPromotionEvidenceContext,
  createReleasePromotionEvidenceContext,
  createSpinePromotionReport,
  hasSpinePromotionFailures,
  type PromotionEvidenceContext,
  type PromotionEvidenceReference,
  parseArgs,
  readExplicitPromotionEvidenceContext,
  writeSpinePromotionReport,
} from "../spine-promotion-check.mts";
import { inventoryDigest, readTestInventory } from "../test-inventory.mts";
import { createTestLanePlan } from "../test-lane-runner.mts";

const tempRepos: string[] = [];
const commitSha = "0123456789abcdef";
const startedAt = "2026-01-01T00:00:00.000Z";
const completedAt = "2026-01-01T00:10:00.000Z";
const fastTestLaneReportPath = "ci-reports/package-quality/fast-test-lane.json";

describe("spine-promotion-check.mts", () => {
  afterEach(() => {
    for (const repo of tempRepos.splice(0)) {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("passes structured references backed by the current blocking test task", () => {
    const fixture = createPromotionFixture("protocols-core");
    const report = createReport(fixture.repo, createContext("@croco/protocols-core"));

    expect(hasSpinePromotionFailures(report)).toBe(false);
    expect(buildSpinePromotionMarkdown(report)).toContain("promotion-ready");
  });

  it("limits current-run evidence accountability to explicitly selected packages", () => {
    const fixture = createPromotionFixture("protocols-core");
    const report = createSpinePromotionReport({
      currentCommit: commitSha,
      evidenceContext: createContext("@croco/protocols-core"),
      packageNames: ["retry-core"],
      rootDir: fixture.repo,
    });

    expect(report.betaSpineRows).toEqual([]);
    expect(hasSpinePromotionFailures(report)).toBe(false);
  });

  it("keeps global catalog validation outside the scoped evidence selection", () => {
    const repo = createTempRepo();
    writePackage(repo, "protocols-core");
    writeCatalog(repo, {
      betaPackages: ["protocols-core", "missing-core"],
      productionPackages: [],
      promotionPackages: {
        "missing-core": metadata(defaultReferences()),
        "protocols-core": metadata(defaultReferences()),
      },
      spinePackages: ["protocols-core", "missing-core"],
    });

    const report = createSpinePromotionReport({
      currentCommit: commitSha,
      evidenceContext: createContext("@croco/protocols-core"),
      packageNames: ["protocols-core"],
      rootDir: repo,
      testInventory: () => ["src/tests/evidence.spec.ts"],
    });

    expect(report.catalogErrors).toContainEqual(
      expect.stringContaining(
        "spine package missing-core is beta but has no public workspace package",
      ),
    );
    expect(hasSpinePromotionFailures(report)).toBe(true);
  });

  it("parses repeatable scoped package selectors", () => {
    expect(
      parseArgs(["--package", "@croco/retry-core", "--package", "protocols-core"]).packageNames,
    ).toEqual(["protocols-core", "retry-core"]);
  });

  it("rejects arbitrary prose instead of treating it as executable evidence", () => {
    const repo = createTempRepo();
    writePackage(repo, "protocols-core");
    writeCatalogMetadata(repo, "protocols-core", ["route contract graph fixtures"]);

    const report = createReport(repo, createContext("@croco/protocols-core"));

    expect(hasSpinePromotionFailures(report)).toBe(true);
    expect(report.betaSpineRows[0]?.missingFields).toContain("targetEvidence");
  });

  it("rejects malformed references even when other references are valid", () => {
    const fixture = createPromotionFixture("protocols-core", [
      ...defaultReferences(),
      { description: "ambiguous", role: "behavior", commandId: "test", testPath: 42 },
    ]);

    const report = createReport(fixture.repo, createContext("@croco/protocols-core"));

    expect(report.catalogErrors).toContainEqual(
      expect.stringContaining("targetEvidence entries require"),
    );
  });

  it("rejects empty selectors instead of degrading them to command-only evidence", () => {
    const fixture = createPromotionFixture("protocols-core", [
      reference("behavior", { testPath: " " }),
      reference("compatibility"),
      reference("failure-recovery"),
    ]);

    expect(
      createReport(fixture.repo, createContext("@croco/protocols-core")).catalogErrors,
    ).toContainEqual(expect.stringContaining("targetEvidence entries require"));
  });

  it("rejects unknown and self-referencing command IDs", () => {
    const fixture = createPromotionFixture("protocols-core", [
      reference("behavior", { commandId: "missing-command" }),
      reference("compatibility", { commandId: "spine-promotion" }),
      reference("failure-recovery"),
    ]);
    const report = createReport(fixture.repo, createContext("@croco/protocols-core"));

    expect(report.betaSpineRows[0]?.evidenceFailures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unknown blocking command missing-command"),
        expect.stringContaining("spine-promotion cannot reference itself"),
      ]),
    );
  });

  it.each(["pending", "skipped", "failed", "timed_out", "interrupted"] as const)(
    "rejects a %s current-run result",
    (outcome) => {
      const fixture = createPromotionFixture("protocols-core");
      const context = createContext("@croco/protocols-core", { outcome });

      expect(hasSpinePromotionFailures(createReport(fixture.repo, context))).toBe(true);
    },
  );

  it("rejects advisory-only and mismatched run-attempt evidence", () => {
    const fixture = createPromotionFixture("protocols-core");
    const context = createContext("@croco/protocols-core", {
      blocking: false,
      commandRunAttempt: "2",
    });
    const failures = createReport(fixture.repo, context).betaSpineRows[0]?.evidenceFailures ?? [];

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("advisory-only"),
        expect.stringContaining("another run or attempt"),
      ]),
    );
  });

  it("rejects a renamed test and a test excluded from the package task", () => {
    const missing = createPromotionFixture("protocols-core", [
      reference("behavior", { testPath: "src/tests/renamed.spec.ts" }),
      reference("compatibility"),
      reference("failure-recovery"),
    ]);
    const excluded = createPromotionFixture(
      "cli",
      undefined,
      "vitest run --exclude src/tests/evidence.spec.ts",
    );

    expect(
      hasSpinePromotionFailures(createReport(missing.repo, createContext("@croco/protocols-core"))),
    ).toBe(true);
    expect(
      hasSpinePromotionFailures(createReport(excluded.repo, createContext("@croco/cli"))),
    ).toBe(true);
  });

  it("rejects a test omitted by an explicit Vitest selector", () => {
    const fixture = createPromotionFixture(
      "protocols-core",
      undefined,
      "vitest run src/tests/another.spec.ts",
    );

    expect(
      buildSpinePromotionMarkdown(
        createReport(fixture.repo, createContext("@croco/protocols-core")),
      ),
    ).toContain("is not selected by the package test task");
  });

  it("rejects specs absent from the effective Vitest inventory and symlink escapes", () => {
    const inventoryFixture = createPromotionFixture("protocols-core");
    const inventoryReport = createSpinePromotionReport({
      currentCommit: commitSha,
      evidenceContext: createContext("@croco/protocols-core"),
      rootDir: inventoryFixture.repo,
      testInventory: () => [],
    });
    const symlinkFixture = createPromotionFixture("testing");
    const linkedTest = join(
      symlinkFixture.repo,
      "packages",
      "testing",
      "src",
      "tests",
      "evidence.spec.ts",
    );
    rmSync(linkedTest);
    writeFileSync(join(symlinkFixture.repo, "outside.spec.ts"), "export {};\n");
    symlinkSync(join(symlinkFixture.repo, "outside.spec.ts"), linkedTest);

    expect(buildSpinePromotionMarkdown(inventoryReport)).toContain(
      "absent from the effective Vitest test inventory",
    );
    expect(
      buildSpinePromotionMarkdown(
        createReport(symlinkFixture.repo, createContext("@croco/testing")),
      ),
    ).toContain("resolves outside the package");
  });

  it("requires the selected package task to pass in the current Turbo result", () => {
    const fixture = createPromotionFixture("protocols-core");
    const context = createContext("@croco/another-package");

    expect(buildSpinePromotionMarkdown(createReport(fixture.repo, context))).toContain(
      "@croco/protocols-core test task did not pass in the current run",
    );
  });

  it.each([
    { exists: false, fresh: true, semanticStatus: "passed" as const },
    { exists: true, fresh: false, semanticStatus: "passed" as const },
    { exists: true, fresh: true, semanticStatus: "failed" as const },
  ])("rejects missing, stale, or semantically failed required reports", (artifact) => {
    const fixture = createPromotionFixture("create-croco-app", [
      reference("behavior", {
        artifactPath: "ci-reports/generated-apps/spine-blocking-matrix.json",
        commandId: "generated-app-smoke",
        testPath: undefined,
      }),
      reference("compatibility"),
      reference("failure-recovery"),
    ]);
    const context = createContext("create-croco-app", { artifact });

    expect(hasSpinePromotionFailures(createReport(fixture.repo, context))).toBe(true);
  });

  it("rejects reports not declared by the authoritative command manifest", () => {
    const fixture = createPromotionFixture("create-croco-app", [
      reference("behavior", {
        artifactPath: "ci-reports/arbitrary.json",
        commandId: "generated-app-smoke",
        testPath: undefined,
      }),
      reference("compatibility"),
      reference("failure-recovery"),
    ]);

    expect(
      buildSpinePromotionMarkdown(createReport(fixture.repo, createContext("create-croco-app"))),
    ).toContain("is not declared by generated-app-smoke");
  });

  it("rejects unknown and traversal artifact paths in local contexts", () => {
    const fixture = createPromotionFixture("create-croco-app");
    const contextPath = join(fixture.repo, "local-context.json");
    writeJson(contextPath, {
      schemaVersion: 1,
      source: "local",
      commitSha,
      runId: "run-1",
      runAttempt: "1",
      startedAt,
      completedAt,
      commands: [
        { commandId: "test", artifacts: [] },
        { commandId: "generated-app-smoke", artifacts: [{ path: "../../outside.json" }] },
      ],
    });

    expect(() => readExplicitPromotionEvidenceContext(contextPath, fixture.repo)).toThrow(
      "is not declared by generated-app-smoke",
    );
  });

  it("rejects commit mismatch and release references to later commands", () => {
    const fixture = createPromotionFixture("protocols-core", [
      reference("behavior", { commandId: "public-api", testPath: undefined }),
      reference("compatibility"),
      reference("failure-recovery"),
    ]);
    const context = createContext("@croco/protocols-core", {
      commitSha: "stale",
      source: "release",
    });
    const failures = createReport(fixture.repo, context).betaSpineRows[0]?.evidenceFailures ?? [];

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not match HEAD"),
        expect.stringContaining("does not precede spine-promotion"),
      ]),
    );
  });

  it("rejects command timestamps outside the evidence run interval", () => {
    const fixture = createPromotionFixture("protocols-core");
    const context = createContext("@croco/protocols-core", {
      commandCompletedAt: "2026-01-01T00:11:00.000Z",
    });

    expect(buildSpinePromotionMarkdown(createReport(fixture.repo, context))).toContain(
      "timestamps are outside the current-run interval",
    );
  });

  it("normalizes CI Turbo evidence and authoritative release fast-lane evidence", () => {
    const fixture = createPromotionFixture("protocols-core");
    const runId = "run-1";
    const runAttempt = "1";
    writeJson(join(fixture.repo, "ci-run.json"), {
      commitSha,
      runId,
      runAttempt,
      startedAt,
    });
    writeTurboTestSummary(
      fixture.repo,
      "random-summary-name.json",
      "@croco/protocols-core",
      Date.parse(startedAt) + 1_000,
    );

    const ciContext = createCiPromotionEvidenceContext({
      env: { SPINE_PROMOTION_TEST_OUTCOME: "success" },
      rootDir: fixture.repo,
      runFile: join(fixture.repo, "ci-run.json"),
    });
    writeReleaseCheckpoint(fixture.repo, runId, runAttempt);
    const releaseContext = createReleasePromotionEvidenceContext({
      checkpointPath: join(fixture.repo, "release-checkpoint.json"),
      commitSha,
      runId,
      runAttempt,
    });

    expect(hasSpinePromotionFailures(createReport(fixture.repo, ciContext))).toBe(false);
    expect(hasSpinePromotionFailures(createReport(fixture.repo, releaseContext))).toBe(false);
    expect(() =>
      createReleasePromotionEvidenceContext({
        checkpointPath: join(fixture.repo, "release-checkpoint.json"),
        commitSha,
        runId: "another-run",
        runAttempt,
      }),
    ).toThrow("checkpoint provenance does not match");
  });

  it.each([0, 1])("uses the newest CI test:evidence summary with exit code %s", (exitCode) => {
    const fixture = createPromotionFixture("protocols-core");
    writeJson(join(fixture.repo, "ci-run.json"), {
      commitSha,
      runId: "run-1",
      runAttempt: "1",
      startedAt,
    });
    writeTurboTestSummary(
      fixture.repo,
      "old-test.json",
      "@croco/protocols-core",
      Date.parse(startedAt) + 1_000,
      { exitCode: 1 - exitCode },
    );
    writeTurboTestSummary(
      fixture.repo,
      "new-evidence.json",
      "@croco/protocols-core",
      Date.parse(startedAt) + 2_000,
      { taskName: "test:evidence", exitCode },
    );

    const context = createCiPromotionEvidenceContext({
      env: { SPINE_PROMOTION_TEST_OUTCOME: "success" },
      rootDir: fixture.repo,
      runFile: join(fixture.repo, "ci-run.json"),
    });

    expect(context.commands.find(({ commandId }) => commandId === "test")?.testTasks).toEqual([
      {
        packageName: "@croco/protocols-core",
        status: exitCode === 0 ? "passed" : "failed",
        taskId: "@croco/protocols-core#test:evidence",
      },
    ]);
    expect(hasSpinePromotionFailures(createReport(fixture.repo, context))).toBe(exitCode !== 0);
  });

  it("uses passed release fast-lane commands even when later Turbo summaries disagree", () => {
    const fixture = createPromotionFixture("protocols-core");
    const runId = "run-1";
    const runAttempt = "1";
    writeTurboTestSummary(
      fixture.repo,
      "authoritative-test.json",
      "@croco/protocols-core",
      Date.parse(startedAt) + 1_000,
    );
    writeTurboTestSummary(
      fixture.repo,
      "later-nested-test.json",
      "@croco/testing",
      Date.parse(completedAt) + 1_000,
    );
    writeReleaseCheckpoint(fixture.repo, runId, runAttempt);

    const context = createReleasePromotionEvidenceContext({
      checkpointPath: join(fixture.repo, "release-checkpoint.json"),
      commitSha,
      runId,
      runAttempt,
    });

    expect(hasSpinePromotionFailures(createReport(fixture.repo, context))).toBe(false);
  });

  it("fails release synthesis when the fast-lane report omits the promotion owner", () => {
    const fixture = createPromotionFixture("protocols-core");
    writeReleaseCheckpoint(fixture.repo, "run-1", "1");
    const laneReportPath = join(fixture.repo, fastTestLaneReportPath);
    const laneReport = JSON.parse(readFileSync(laneReportPath, "utf8")) as {
      commands: { owner: string }[];
    };
    laneReport.commands[0] = { ...laneReport.commands[0], owner: "@croco/another-package" };
    writeJson(laneReportPath, laneReport);

    expect(() =>
      createReleasePromotionEvidenceContext({
        checkpointPath: join(fixture.repo, "release-checkpoint.json"),
        commitSha,
        runId: "run-1",
        runAttempt: "1",
      }),
    ).toThrow("does not match the selected fast-lane plan");
  });

  it("fails release synthesis when the required fast-lane owner command failed", () => {
    const fixture = createPromotionFixture("protocols-core");
    writeReleaseCheckpoint(fixture.repo, "run-1", "1");
    const laneReportPath = join(fixture.repo, fastTestLaneReportPath);
    const laneReport = JSON.parse(readFileSync(laneReportPath, "utf8")) as {
      status: string;
      commands: { status: string; exitCode: number }[];
    };
    laneReport.status = "failed";
    laneReport.commands[0] = { ...laneReport.commands[0], status: "failed", exitCode: 1 };
    writeJson(laneReportPath, laneReport);

    expect(() =>
      createReleasePromotionEvidenceContext({
        checkpointPath: join(fixture.repo, "release-checkpoint.json"),
        commitSha,
        runId: "run-1",
        runAttempt: "1",
      }),
    ).toThrow("Test lane evidence is failed");
  });

  it("fails release synthesis for missing, stale, malformed, or mismatched lane evidence", () => {
    const fixture = createPromotionFixture("protocols-core");
    const checkpointPath = join(fixture.repo, "release-checkpoint.json");
    const laneReportPath = join(fixture.repo, fastTestLaneReportPath);
    const createContext = () =>
      createReleasePromotionEvidenceContext({
        checkpointPath,
        commitSha,
        runId: "run-1",
        runAttempt: "1",
      });

    writeReleaseCheckpoint(fixture.repo, "run-1", "1", { artifactExists: false });
    expect(createContext).toThrow("missing or stale");

    writeReleaseCheckpoint(fixture.repo, "run-1", "1", { artifactFresh: false });
    expect(createContext).toThrow("missing or stale");

    writeReleaseCheckpoint(fixture.repo, "run-1", "1");
    writeJson(laneReportPath, { schemaVersion: "unknown" });
    expect(createContext).toThrow("invalid report shape");

    writeReleaseCheckpoint(fixture.repo, "run-1", "1");
    const laneReport = JSON.parse(readFileSync(laneReportPath, "utf8")) as {
      inventoryDigest: string;
    };
    laneReport.inventoryDigest = "stale";
    writeJson(laneReportPath, laneReport);
    expect(createContext).toThrow("stale test inventory digest");
  });

  it("fails stale promotion metadata outside the beta spine", () => {
    const repo = createTempRepo();
    writePackage(repo, "stable");
    writeCatalog(repo, {
      betaPackages: [],
      productionPackages: ["stable"],
      promotionPackages: { stable: metadata(defaultReferences()) },
      spinePackages: ["stable"],
    });

    const report = createReport(repo, createContext("@croco/stable"));

    expect(hasSpinePromotionFailures(report)).toBe(true);
    expect(report.catalogErrors[0]).toContain("must be removed");
  });

  it("fails closed when no current-run context is supplied", () => {
    const fixture = createPromotionFixture("protocols-core");

    expect(hasSpinePromotionFailures(createReport(fixture.repo, null))).toBe(true);
  });

  it("accepts pnpm separators and explicit context input", () => {
    const repo = createTempRepo();
    const options = parseArgs(["--", "--root", repo, "--context", "context.json"]);

    expect(options.rootDir).toBe(repo);
    expect(options.contextFile).toBe(join(repo, "context.json"));
  });

  it("writes the markdown report artifact", () => {
    const fixture = createPromotionFixture("testing");
    const report = createReport(fixture.repo, createContext("@croco/testing"));
    const markdownPath = writeSpinePromotionReport(report, join(fixture.repo, "reports"));

    expect(readFileSync(markdownPath, "utf-8")).toContain("# Beta Spine Promotion Gate");
  });
});

function createPromotionFixture(
  shortName: string,
  references: readonly unknown[] = defaultReferences(),
  testScript = "vitest run",
): { readonly repo: string } {
  const repo = createTempRepo();
  writePackage(repo, shortName, testScript);
  writeTestInventory(repo, shortName);
  writeCatalogMetadata(repo, shortName, references);
  return { repo };
}

function createReport(repo: string, evidenceContext: PromotionEvidenceContext | null) {
  return createSpinePromotionReport({
    currentCommit: commitSha,
    evidenceContext,
    generatedAt: completedAt,
    rootDir: repo,
    testInventory: () => ["src/tests/evidence.spec.ts"],
  });
}

function createContext(
  packageName: string,
  options: {
    readonly artifact?: {
      readonly exists: boolean;
      readonly fresh: boolean;
      readonly semanticStatus: "passed" | "failed";
    };
    readonly blocking?: boolean;
    readonly commandRunAttempt?: string;
    readonly commandCompletedAt?: string;
    readonly commitSha?: string;
    readonly outcome?: "passed" | "failed" | "pending" | "skipped" | "timed_out" | "interrupted";
    readonly source?: "ci" | "release" | "local";
  } = {},
): PromotionEvidenceContext {
  const base = {
    artifacts: [],
    blocking: options.blocking ?? true,
    completedAt: options.commandCompletedAt ?? completedAt,
    outcome: options.outcome ?? "passed",
    runAttempt: options.commandRunAttempt ?? "1",
    runId: "run-1",
    startedAt,
    testTasks: [{ packageName, status: "passed" as const, taskId: `${packageName}#test` }],
  };
  return {
    schemaVersion: 1,
    source: options.source ?? "local",
    commitSha: options.commitSha ?? commitSha,
    runId: "run-1",
    runAttempt: "1",
    startedAt,
    completedAt,
    commands: [
      { ...base, commandId: "test" },
      {
        ...base,
        commandId: "generated-app-smoke",
        artifacts: [
          {
            exists: options.artifact?.exists ?? true,
            fresh: options.artifact?.fresh ?? true,
            path: "ci-reports/generated-apps/spine-blocking-matrix.json",
            semanticStatus: options.artifact?.semanticStatus ?? "passed",
          },
        ],
      },
      { ...base, commandId: "public-api" },
    ],
  };
}

function defaultReferences(): readonly PromotionEvidenceReference[] {
  return [reference("behavior"), reference("compatibility"), reference("failure-recovery")];
}

function reference(
  role: PromotionEvidenceReference["role"],
  overrides: Partial<PromotionEvidenceReference> = {},
): PromotionEvidenceReference {
  return {
    description: `${role} evidence`,
    role,
    commandId: "test",
    testPath: "src/tests/evidence.spec.ts",
    ...overrides,
  };
}

function metadata(targetEvidence: readonly unknown[]) {
  return {
    owner: "owner",
    targetEvidence,
    recoveryAction: "Fix the referenced blocking evidence and rerun the gate.",
  };
}

function createTempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "croco-spine-promotion-"));
  tempRepos.push(repo);
  mkdirSync(join(repo, "packages"), { recursive: true });
  return repo;
}

function writePackage(repo: string, shortName: string, testScript = "vitest run"): void {
  const packageDir = join(repo, "packages", shortName);
  writeJson(join(packageDir, "package.json"), {
    name: shortName === "create-croco-app" ? shortName : `@croco/${shortName}`,
    scripts: { build: "tsup", test: testScript, typecheck: "tsc --noEmit" },
  });
  mkdirSync(join(packageDir, "src", "tests"), { recursive: true });
  writeFileSync(join(packageDir, "src", "tests", "evidence.spec.ts"), "export {};\n");
}

function writeCatalogMetadata(
  repo: string,
  shortName: string,
  targetEvidence: readonly unknown[],
): void {
  writeCatalog(repo, {
    betaPackages: [shortName],
    productionPackages: [],
    promotionPackages: { [shortName]: metadata(targetEvidence) },
    spinePackages: [shortName],
  });
}

function writeCatalog(
  repo: string,
  options: {
    readonly betaPackages: readonly string[];
    readonly productionPackages: readonly string[];
    readonly promotionPackages: Readonly<Record<string, unknown>>;
    readonly spinePackages: readonly string[];
  },
): void {
  writeJson(join(repo, "docs", "package-catalog.json"), {
    schemaVersion: 1,
    spine: {
      packages: options.spinePackages,
      promotion: { packages: options.promotionPackages },
    },
    groups: {
      Core: {
        packages: [...new Set([...options.spinePackages, ...options.productionPackages])],
      },
    },
    maturity: {
      production: { packages: options.productionPackages },
      beta: { packages: options.betaPackages },
      alpha: { packages: [] },
      deprecated: { packages: [] },
    },
  });
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTurboTestSummary(
  repo: string,
  fileName: string,
  packageName: string,
  endTime = Date.now(),
  { taskName = "test", exitCode = 0 }: { taskName?: string; exitCode?: number } = {},
): void {
  writeJson(join(repo, ".turbo", "runs", fileName), {
    execution: {
      command: `turbo run ${taskName} --summarize --continue=always`,
      endTime,
      exitCode,
    },
    tasks: [
      {
        taskId: `${packageName}#${taskName}`,
        task: taskName,
        package: packageName,
        directory: `packages/${packageName.replace(/^@croco\//, "")}`,
        execution: { exitCode },
      },
    ],
  });
}

function writeTestInventory(repo: string, shortName: string): void {
  writeJson(join(repo, "test-inventory.json"), {
    version: 1,
    tests: [
      {
        path: `packages/${shortName}/src/tests/evidence.spec.ts`,
        lane: "fast",
        qualifiers: [],
        owner: shortName === "create-croco-app" ? shortName : `@croco/${shortName}`,
      },
    ],
    exceptions: [],
  });
}

function writeReleaseCheckpoint(
  repo: string,
  runId: string,
  runAttempt: string,
  options: {
    readonly artifactExists?: boolean;
    readonly artifactFresh?: boolean;
    readonly laneOwners?: readonly string[];
  } = {},
): void {
  const { diagnostics, inventory } = readTestInventory(join(repo, "test-inventory.json"));
  if (diagnostics.length > 0) {
    throw new Error(`Invalid fixture test inventory: ${JSON.stringify(diagnostics)}`);
  }
  const selectedOwners = options.laneOwners ?? [];
  const commands = createTestLanePlan(inventory, "fast", selectedOwners).map((command) => ({
    ...command,
    durationMs: 1,
    exitCode: 0,
    status: "passed",
    cacheStatus: "miss",
    executedPaths: command.paths,
    skippedFiles: [],
    executionState: "executed",
    cacheHash: `cache-${command.owner}`,
  }));
  writeJson(join(repo, fastTestLaneReportPath), {
    schemaVersion: "croco.test-lane-report/v2",
    inventoryVersion: 1,
    inventoryDigest: inventoryDigest(inventory),
    lane: "fast",
    allowLive: false,
    selectedOwners,
    executedPaths: commands
      .flatMap(({ cwd, executedPaths }) =>
        executedPaths.map((path) => (cwd === "." ? path : `${cwd}/${path}`)),
      )
      .sort(),
    skippedFiles: [],
    status: "passed",
    diagnostics: [],
    commands,
  });
  writeJson(join(repo, "release-checkpoint.json"), {
    schemaVersion: 1,
    generatedAt: startedAt,
    rootDir: repo,
    provenance: { commitSha, runId, runAttempt },
    checks: [
      {
        id: "test",
        status: "passed",
        startedAt,
        completedAt,
        artifacts: [
          {
            label: "Fast test lane evidence",
            path: fastTestLaneReportPath,
            required: true,
            copiedPath: null,
            copyError: null,
            exists: options.artifactExists ?? true,
            fresh: options.artifactFresh ?? true,
            modifiedAt: completedAt,
            sourcePath: fastTestLaneReportPath,
          },
        ],
      },
      {
        id: "spine-promotion",
        status: "running",
        startedAt: completedAt,
        completedAt: null,
        artifacts: [],
      },
    ],
    runId,
    runAttempt,
  });
}
