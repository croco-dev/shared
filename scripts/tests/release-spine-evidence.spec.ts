import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGeneratedSmokeJourneyReport,
  writeGeneratedSmokeJourneyBundle,
  type GeneratedSmokeJourneySourceReport,
} from "../create-croco-app-generated-smoke-journey-report.mts";
import { CACHEABLE_FAILURE_COMMAND } from "../ci-cacheable-failure-injection.mts";
import {
  DEFAULT_CLI_MAX_CONCURRENCY,
  createReleaseSpineEvidenceManifest,
  createReleaseSpineCommands,
  defaultCommandRunner,
  failedCheckDiagnostics,
  interruptActiveCommand,
  markReportInterrupted,
  parseArgs,
  resolveDefaultCliMaxConcurrency,
  reuseTestEvidence,
  runReleaseSpineEvidence,
} from "../release-spine-evidence.mts";
import { createVerificationManifest } from "../verification-manifest.mts";
import type {
  Clock,
  CommandRunResult,
  CommandRunner,
  EvidenceArtifactExpectation,
  EvidenceCommand,
  ReleaseSpineEvidenceReport,
} from "../release-spine-evidence.mts";

const tempRepos: string[] = [];

describe("release-spine-evidence.mts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const repo of tempRepos.splice(0)) {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("defines the full release spine evidence manifest", () => {
    const manifest = createReleaseSpineEvidenceManifest();
    const publishManifest = createVerificationManifest("publish");

    expect(manifest[0]?.id).toBe("verification-policy");
    expect(manifest.at(-1)?.id).toBe("public-api");
    expect(findCheck(manifest, "changeset-required").applicable).toBe(false);
    expect(findCheck(manifest, "production-ready").command).toEqual([
      "node",
      "--experimental-strip-types",
      "scripts/tracked-file-mutation-guard.mts",
      "--recovery",
      "Fix the reported production-ready package violations",
      "--",
      "node",
      "--experimental-strip-types",
      "scripts/production-ready-check.mts",
      "--require-task-summaries",
      "--fast-test-lane-report",
      "ci-reports/package-quality/fast-test-lane.json",
    ]);
    expect(findCheck(publishManifest, "release-metadata").command).toEqual([
      "node",
      "--experimental-strip-types",
      "scripts/release-metadata-check.mts",
    ]);
    expect(
      findCheck(manifest, "generated-app-smoke").artifacts?.map((artifact) => artifact.path),
    ).toEqual([
      "ci-reports/generated-apps/spine-blocking-matrix.md",
      "ci-reports/generated-apps/spine-blocking-matrix.json",
      "ci-reports/generated-apps/spine-blocking-journeys",
      "ci-reports/generated-apps/materialization-evidence.json",
      "ci-reports/generated-apps/materialized-tests",
    ]);
    expect(findCheck(manifest, "generated-app-smoke").command).toEqual([
      "node",
      "--experimental-strip-types",
      "scripts/create-croco-app-generated-smoke.mts",
      "--tier",
      "spine-blocking",
    ]);
    expect(
      findCheck(manifest, "alpha-release-smoke").artifacts?.map((artifact) => artifact.path),
    ).toEqual(["ci-reports/release/alpha-release-smoke.md"]);
    expect(
      findCheck(publishManifest, "spine-bundle-size").artifacts?.map((artifact) => artifact.path),
    ).toEqual([
      "ci-reports/package-quality/report.md",
      "ci-reports/package-quality/summary.json",
      "ci-reports/package-quality/bundle-size.md",
    ]);
    expect(manifest.findIndex((check) => check.id === "format")).toBeLessThan(
      manifest.findIndex((check) => check.id === "build"),
    );
  });

  it("writes checkpointed markdown and JSON reports and copies required artifacts", async () => {
    const repo = createTempRepo();
    const fakeTime = createFakeClock();
    const outputDir = join(repo, "ci-reports", "release");
    const sourceArtifact = join(repo, "ci-reports", "source", "provider.md");
    const checkpoints: ReleaseSpineEvidenceReport[] = [];
    const commands = [
      createCommand("provider-certification", {
        selectionReason: "Selected because provider package inputs changed.",
        artifacts: [
          {
            label: "Provider report",
            path: "ci-reports/source/provider.md",
            required: true,
          },
        ],
      }),
    ];
    const runner: CommandRunner = () => {
      mkdirSync(join(repo, "ci-reports", "source"), { recursive: true });
      writeFileSync(sourceArtifact, "# provider\n");
      return okResult("provider ok");
    };

    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir,
      totalTimeoutMs: 1_000,
      clock: fakeTime.clock,
      commands,
      runner,
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(report.status).toBe("passed");
    expect(checkpoints.map((checkpoint) => checkpoint.status)).toContain("running");
    expect(
      readJson<ReleaseSpineEvidenceReport>(join(outputDir, "spine-evidence.json")).status,
    ).toBe("passed");
    expect(readFileSync(join(outputDir, "spine-evidence.md"), "utf-8")).toContain(
      "# Release Spine Evidence",
    );
    expect(readFileSync(join(outputDir, "spine-evidence.md"), "utf-8")).toContain(
      "- Selection reason: Selected because provider package inputs changed.",
    );
    expect(existsSync(join(outputDir, "artifacts", "provider-certification", "provider.md"))).toBe(
      true,
    );
  });

  it("derives the publish manifest for programmatic runs when commands are omitted", async () => {
    const repo = createTempRepo();
    const calledIds: string[] = [];
    const calledCommands: EvidenceCommand[] = [];
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "ci-reports", "verification", "publish"),
      totalTimeoutMs: 10_000,
      profile: "publish",
      base: "origin/trunk",
      changedFiles: [],
      head: "HEAD",
      runner: (command) => {
        calledIds.push(command.id);
        calledCommands.push(command);
        return okResult(command.id);
      },
    });

    expect(report.profile).toBe("publish");
    expect(calledIds).toContain("dependency-audit-policy");
    expect(calledIds).toContain("provenance-config");
    expect(calledIds.at(-1)).toBe("publish-dry-run");
    expect(findCheck(calledCommands, "changeset-required").command).toContain("origin/trunk");
    expect(report.checks.map(({ id }) => id).at(-1)).toBe("publish-dry-run");
  });

  it("converts an early checkpoint rejection into failed evidence", async () => {
    const repo = createTempRepo();
    let checkpointCount = 0;
    let runnerCalled = false;
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 10_000,
      commands: [createCommand("checkpoint-failure")],
      onCheckpoint: () => {
        checkpointCount += 1;
        if (checkpointCount === 2) throw new Error("checkpoint write failed");
      },
      runner: () => {
        runnerCalled = true;
        return okResult("unexpected");
      },
    });

    expect(runnerCalled).toBe(false);
    expect(report.status).toBe("failed");
    expect(report.checks[0]).toMatchObject({
      errorCode: "POST_RUN_EVIDENCE_FAILED",
      errorMessage: "checkpoint write failed",
      status: "failed",
    });
  });

  it.each([
    ["scripts/release-metadata-check.mts", "release-metadata"],
    ["scripts/package-quality-report.mts", "spine-bundle-size"],
  ])("executes and fails changed publish verifier %s", async (changedFile, failingId) => {
    const repo = createTempRepo();
    const calledIds: string[] = [];
    const selectedCommand = {
      ...findCheck(
        createVerificationManifest("publish", {
          base: "origin/trunk",
          changedFiles: [changedFile],
          head: "HEAD",
        }),
        failingId,
      ),
      dependsOn: [],
    };
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "ci-reports", "verification", "publish"),
      totalTimeoutMs: 10_000,
      profile: "publish",
      base: "origin/trunk",
      changedFiles: [changedFile],
      commands: [selectedCommand],
      head: "HEAD",
      runner: (command) => {
        calledIds.push(command.id);
        return command.id === failingId
          ? { ...okResult(command.id), status: 2 }
          : okResult(command.id);
      },
    });

    expect(calledIds).toContain(failingId);
    expect(findCheck(report.checks, failingId)).toMatchObject({ status: "failed" });
  });

  it("fails a passing command when a required artifact is missing", async () => {
    const repo = createTempRepo();
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "ci-reports", "release"),
      totalTimeoutMs: 1_000,
      commands: [
        createCommand("generated-app-smoke", {
          artifacts: [
            {
              label: "Spine-blocking generated app matrix",
              path: "ci-reports/generated-apps/spine-blocking-matrix.md",
              required: true,
            },
          ],
        }),
      ],
      runner: () => okResult("generated app ok"),
    });

    expect(report.status).toBe("failed");
    expect(report.checks[0]?.status).toBe("failed");
    expect(report.checks[0]?.failureReason).toContain("Required release evidence artifact");
    expect(failedCheckDiagnostics(report)).toEqual([
      expect.stringContaining("generated-app-smoke: failed: Required release evidence artifact"),
    ]);
  });

  it("records post-run helper rejection as a failed check while active checks finish", async () => {
    const repo = createTempRepo();
    const fakeTime = createFakeClock();
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "ci-reports", "release"),
      totalTimeoutMs: 1_000,
      maxConcurrency: 2,
      clock: fakeTime.clock,
      commands: [createCommand("post-run-rejection"), createCommand("concurrent-success")],
      runner: async (command) => {
        if (command.id === "concurrent-success") {
          await Promise.resolve();
          return okResult("concurrent success");
        }
        fakeTime.advance(25);
        const result = { ...okResult("post-run") };
        Object.defineProperty(result, "stdout", {
          get: () => {
            throw new Error("stdout helper rejected");
          },
        });
        return result;
      },
    });

    expect(report.status).toBe("failed");
    expect(findCheck(report.checks, "post-run-rejection")).toMatchObject({
      status: "failed",
      errorCode: "POST_RUN_EVIDENCE_FAILED",
      completedAt: "1970-01-01T00:00:00.025Z",
      durationMs: 25,
      failureReason: expect.stringContaining("stdout helper rejected"),
    });
    expect(findCheck(report.checks, "concurrent-success")).toMatchObject({ status: "passed" });
  });

  it("allows filtered generated smoke to omit its optional journey bundle", async () => {
    const repo = createTempRepo();
    const generatedSmoke = {
      ...findCheck(
        createVerificationManifest("publish", {
          base: "origin/trunk",
          changedFiles: ["packages/protocols-rest/src/index.ts"],
          head: "HEAD",
        }),
        "generated-app-smoke",
      ),
      dependsOn: [],
    };
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "ci-reports", "release"),
      totalTimeoutMs: 1_000,
      clock: createFakeClock().clock,
      commands: [generatedSmoke],
      runner: () => {
        for (const artifact of generatedSmoke.artifacts ?? []) {
          if (!artifact.required) continue;
          const path = join(repo, artifact.path);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, artifact.path.endsWith(".json") ? "{}\n" : "# matrix\n");
        }
        return okResult("filtered generated app smoke ok");
      },
    });

    expect(report.status).toBe("passed");
    expect(report.checks[0]).toMatchObject({ status: "passed" });
    expect(report.checks[0]?.artifacts).toHaveLength(5);
    expect(report.checks[0]?.artifacts.filter(({ required }) => required)).toHaveLength(4);
    expect(
      report.checks[0]?.artifacts.find(
        ({ sourcePath }) => sourcePath === "ci-reports/generated-apps/spine-blocking-journeys",
      ),
    ).toMatchObject({
      exists: false,
      required: false,
    });
  });

  it("preserves journey report relative links when copying release evidence", async () => {
    const repo = createTempRepo();
    const outputDir = join(repo, "ci-reports", "release");
    const journeyRoot = join(repo, "ci-reports", "generated-apps", "spine-blocking-journeys");
    const generatedAppsRoot = join(repo, "ci-reports", "generated-apps");
    const sourceArtifactRelativePath =
      "artifacts/production-app-starter/contract-graph.snapshot.json";
    const sourceArtifactPath = join(generatedAppsRoot, sourceArtifactRelativePath);
    const failureArtifactPaths = [
      "cases/production-app-starter/stdout.log",
      "cases/production-app-starter/stderr.log",
      "cases/production-app-starter/files/.croco/diagnostic.json",
    ];
    const sourceReport = createReleaseJourneySourceReport(sourceArtifactRelativePath);
    const productionCase = sourceReport.cases[0];
    if (!productionCase) {
      throw new Error("missing production-app-starter release fixture");
    }
    const journeyReport = createGeneratedSmokeJourneyReport(
      {
        ...sourceReport,
        status: "failed",
        failure: "production app failed after collecting evidence",
        cases: [
          {
            ...productionCase,
            status: "failed",
            error: "production app failed after collecting evidence",
            artifactBundle: {
              stdoutPath: `ci-reports/generated-apps/${failureArtifactPaths[0]}`,
              stderrPath: `ci-reports/generated-apps/${failureArtifactPaths[1]}`,
              files: [`ci-reports/generated-apps/${failureArtifactPaths[2]}`],
            },
          },
          ...sourceReport.cases.slice(1),
        ],
      },
      ["production-app-starter", "graphql-lambda-api", "rest-spa-contracts"],
      undefined,
      "ci-reports/generated-apps",
    );
    const runner: CommandRunner = () => {
      mkdirSync(dirname(sourceArtifactPath), { recursive: true });
      writeFileSync(sourceArtifactPath, '{"status":"passed"}\n');
      for (const failureArtifactPath of failureArtifactPaths) {
        const absolutePath = join(generatedAppsRoot, failureArtifactPath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, `${failureArtifactPath}\n`);
      }
      writeGeneratedSmokeJourneyBundle(journeyRoot, journeyReport, generatedAppsRoot);
      return okResult("generated app ok");
    };

    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir,
      totalTimeoutMs: 1_000,
      commands: [
        createCommand("generated-app-smoke", {
          artifacts: [
            {
              label: "Journey bundle",
              path: "ci-reports/generated-apps/spine-blocking-journeys",
              required: true,
              copyRelativePath: "spine-blocking-journeys",
            },
          ],
        }),
      ],
      runner,
    });

    const copiedJourneyRoot = join(
      outputDir,
      "artifacts",
      "generated-app-smoke",
      "spine-blocking-journeys",
    );
    expect(report.status).toBe("passed");
    for (const journey of journeyReport.journeys) {
      for (const artifact of journey.artifacts) {
        expect(readFileSync(join(copiedJourneyRoot, "report.md"), "utf8")).toContain(
          `(${artifact})`,
        );
        expect(existsSync(join(copiedJourneyRoot, artifact))).toBe(true);
      }
    }
  });

  it("fails a passing command when a required artifact was not refreshed", async () => {
    const repo = createTempRepo();
    const artifactPath = join(repo, "ci-reports", "generated-apps", "spine-blocking-matrix.md");
    const fakeTime = createFakeClock();
    fakeTime.advance(1_000);
    mkdirSync(join(repo, "ci-reports", "generated-apps"), { recursive: true });
    writeFileSync(artifactPath, "# stale matrix\n");
    utimesSync(artifactPath, new Date(0), new Date(0));

    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "ci-reports", "release"),
      totalTimeoutMs: 1_000,
      commands: [
        createCommand("generated-app-smoke", {
          artifacts: [
            {
              label: "Spine-blocking generated app matrix",
              path: "ci-reports/generated-apps/spine-blocking-matrix.md",
              required: true,
            },
          ],
        }),
      ],
      clock: fakeTime.clock,
      runner: () => okResult("generated app ok"),
    });

    expect(report.status).toBe("failed");
    expect(report.checks[0]?.artifacts[0]?.exists).toBe(true);
    expect(report.checks[0]?.artifacts[0]?.fresh).toBe(false);
    expect(report.checks[0]?.artifacts[0]?.copiedPath).toBeNull();
    expect(report.checks[0]?.failureReason).toContain("were not refreshed");
  });

  it("records failed command output with bounded excerpts", async () => {
    const repo = createTempRepo();
    const outputDir = join(repo, "ci-reports", "release");
    const outputRoot = join(outputDir, "artifacts", "release-metadata");
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(join(outputRoot, "stdout.log"), "stale stdout");
    writeFileSync(join(outputRoot, "stderr.log"), "stale stderr");
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir,
      totalTimeoutMs: 1_000,
      commands: [createCommand("release-metadata")],
      maxOutputExcerptLength: 12,
      runner: () => ({
        errorCode: null,
        errorMessage: null,
        signal: null,
        status: 2,
        stderr: "stderr: release metadata failed",
        stdout: "stdout: release metadata diagnostics",
        timedOut: false,
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.checks[0]?.stdoutExcerpt).toContain("[truncated 24 chars]");
    expect(report.checks[0]?.stdoutExcerpt).toContain("diagnostics");
    expect(report.checks[0]?.stderrExcerpt).toContain("[truncated");
    expect(report.checks[0]?.stderrExcerpt).toContain("failed");
    expect(
      readFileSync(join(outputDir, "artifacts", "release-metadata", "stdout.log"), "utf8"),
    ).toBe("stdout: release metadata diagnostics");
    expect(
      readFileSync(join(outputDir, "artifacts", "release-metadata", "stderr.log"), "utf8"),
    ).toBe("stderr: release metadata failed");
    expect(report.checks[0]?.artifacts.map(({ copiedPath }) => copiedPath)).toEqual([
      "ci-reports/release/artifacts/release-metadata/stdout.log",
      "ci-reports/release/artifacts/release-metadata/stderr.log",
    ]);
    expect(readFileSync(join(outputDir, "spine-evidence.md"), "utf8")).toContain(
      "artifacts/release-metadata/stdout.log",
    );
  });

  it("contains a rejected runner and continues writing the final report", async () => {
    const repo = createTempRepo();
    const outputDir = join(repo, "ci-reports", "release");
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir,
      totalTimeoutMs: 1_000,
      commands: [createCommand("rejected"), createCommand("continued")],
      runner: (check) => {
        if (check.id === "rejected") {
          throw new Error("runner rejected");
        }
        return okResult("continued");
      },
    });

    expect(report.status).toBe("failed");
    expect(report.checks.map(({ status }) => status)).toEqual(["failed", "passed"]);
    expect(report.checks[0]?.errorMessage).toBe("runner rejected");
    expect(readJson<ReleaseSpineEvidenceReport>(join(outputDir, "spine-evidence.json"))).toEqual(
      report,
    );
  });

  it("preserves complete real command output beyond the in-memory buffer", async () => {
    const repo = createTempRepo();
    const outputDir = join(repo, "ci-reports", "release");
    const stdout = "full stdout survives the bounded buffer";
    const stderr = "full stderr survives the bounded buffer";
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir,
      totalTimeoutMs: 10_000,
      commands: [
        createCommand("real-failure", {
          command: [
            process.execPath,
            "-e",
            `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(7)`,
          ],
          timeoutMs: 5_000,
        }),
      ],
      maxCommandOutputBufferLength: 8,
    });

    expect(report.status).toBe("failed");
    expect(report.checks[0]?.stdoutExcerpt).toBe(stdout.slice(-8));
    expect(report.checks[0]?.stderrExcerpt).toBe(stderr.slice(-8));
    expect(readFileSync(join(outputDir, "artifacts", "real-failure", "stdout.log"), "utf8")).toBe(
      stdout,
    );
    expect(readFileSync(join(outputDir, "artifacts", "real-failure", "stderr.log"), "utf8")).toBe(
      stderr,
    );
    expect(report.checks[0]?.artifacts.map(({ copiedPath }) => copiedPath)).toEqual([
      "ci-reports/release/artifacts/real-failure/stdout.log",
      "ci-reports/release/artifacts/real-failure/stderr.log",
    ]);
  });

  it("removes streamed command output after a successful check", async () => {
    const repo = createTempRepo();
    const outputDir = join(repo, "ci-reports", "release");
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir,
      totalTimeoutMs: 10_000,
      commands: [
        createCommand("real-success", {
          command: [process.execPath, "-e", "console.log('success')"],
          timeoutMs: 5_000,
        }),
      ],
    });

    expect(report.status).toBe("passed");
    expect(existsSync(join(outputDir, "artifacts", "real-success", "stdout.log"))).toBe(false);
    expect(existsSync(join(outputDir, "artifacts", "real-success", "stderr.log"))).toBe(false);
  });

  it("records command-output cleanup failures without aborting the final report", async () => {
    const repo = createTempRepo();
    const outputDir = join(repo, "ci-reports", "release");
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir,
      totalTimeoutMs: 1_000,
      commands: [createCommand("cleanup-failure")],
      runner: (_check, context) => {
        if (!context.stdoutPath) {
          throw new Error("stdout path is required");
        }
        mkdirSync(context.stdoutPath, { recursive: true });
        writeFileSync(join(context.stdoutPath, "retained.log"), "cleanup blocked");
        return okResult("ok");
      },
    });

    expect(report.status).toBe("failed");
    expect(report.checks[0]?.status).toBe("failed");
    expect(report.checks[0]?.errorCode).toBe("COMMAND_OUTPUT_CLEANUP_FAILED");
    expect(report.checks[0]?.failureReason).toContain("stdout.log");
    expect(report.checks[0]?.artifacts.map(({ label }) => label)).toEqual([
      "Command stdout (bounded fallback; may be truncated)",
      "Command stderr (bounded fallback; may be truncated)",
    ]);
    expect(existsSync(join(outputDir, "spine-evidence.json"))).toBe(true);
  });

  it("finalizes real command evidence before reporting an interruption", async () => {
    const repo = createTempRepo();
    const outputDir = join(repo, "ci-reports", "release");
    const readyPaths = [join(repo, "interrupted-a.ready"), join(repo, "interrupted-b.ready")];
    let interruptSignal: NodeJS.Signals | null = null;
    const reportPromise = runReleaseSpineEvidence({
      rootDir: repo,
      outputDir,
      totalTimeoutMs: 15_000,
      maxConcurrency: 2,
      commands: [
        createCommand("interrupted-a", {
          command: [
            process.execPath,
            "-e",
            `process.on("SIGTERM", () => undefined); process.stdout.write("partial output"); require("node:fs").writeFileSync(${JSON.stringify(readyPaths[0])}, "ready"); setInterval(() => undefined, 10_000)`,
          ],
          timeoutMs: 10_000,
        }),
        createCommand("interrupted-b", {
          command: [
            process.execPath,
            "-e",
            `process.on("SIGTERM", () => undefined); require("node:fs").writeFileSync(${JSON.stringify(readyPaths[1])}, "ready"); setInterval(() => undefined, 10_000)`,
          ],
          timeoutMs: 10_000,
        }),
        createCommand("not-started"),
      ],
      getInterruptSignal: () => interruptSignal,
    });
    await Promise.all(readyPaths.map((path) => waitForPath(path)));
    interruptSignal = "SIGTERM";
    interruptActiveCommand(interruptSignal, 50);
    const report = await reportPromise;

    expect(report.status).toBe("interrupted");
    expect(report.checks.map(({ status }) => status)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
    ]);
    expect(report.checks[0]?.signal).toBe("SIGTERM");
    expect(readFileSync(join(outputDir, "artifacts", "interrupted-a", "stdout.log"), "utf8")).toBe(
      "partial output",
    );
    expect(report.checks[0]?.artifacts.map(({ copiedPath }) => copiedPath)).toEqual([
      "ci-reports/release/artifacts/interrupted-a/stdout.log",
      "ci-reports/release/artifacts/interrupted-a/stderr.log",
    ]);
    expect(report.checks[1]?.artifacts.map(({ copiedPath }) => copiedPath)).toEqual([
      "ci-reports/release/artifacts/interrupted-b/stdout.log",
      "ci-reports/release/artifacts/interrupted-b/stderr.log",
    ]);
  });

  it("fails spine and publish execution on the same broken shared command ID", async () => {
    for (const profile of ["spine", "publish"] as const) {
      const sharedCommand = createVerificationManifest(profile).find(({ id }) => id === "build");
      expect(sharedCommand).toBeDefined();

      const repo = createTempRepo();
      const report = await runReleaseSpineEvidence({
        rootDir: repo,
        outputDir: join(repo, "ci-reports", profile),
        totalTimeoutMs: 1_000,
        profile,
        commands: sharedCommand ? [{ ...sharedCommand, dependsOn: undefined }] : [],
        runner: () => ({
          errorCode: null,
          errorMessage: null,
          signal: null,
          status: 2,
          stderr: "shared build gate failed",
          stdout: "",
          timedOut: false,
        }),
      });

      expect(report.status).toBe("failed");
      expect(report.checks[0]).toMatchObject({ id: "build", status: "failed" });
    }
  });

  it("reports command failure reasons before missing artifact reasons", async () => {
    const repo = createTempRepo();
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "ci-reports", "release"),
      totalTimeoutMs: 1_000,
      commands: [
        createCommand("release-metadata", {
          artifacts: [
            {
              label: "Release metadata",
              path: "ci-reports/release-metadata/report.md",
              required: true,
            },
          ],
        }),
      ],
      runner: () => ({
        errorCode: null,
        errorMessage: null,
        signal: null,
        status: 2,
        stderr: "",
        stdout: "",
        timedOut: false,
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.checks[0]?.failureReason).toBe("Command exited with status 2.");
  });

  it("records command timeouts and skips remaining checks after total timeout exhaustion", async () => {
    const repo = createTempRepo();
    const fakeTime = createFakeClock();
    const runner: CommandRunner = (_command, context) => {
      expect(context.timeoutMs).toBe(50);
      fakeTime.advance(100);
      return {
        errorCode: "ETIMEDOUT",
        errorMessage: "spawn timed out",
        signal: null,
        status: null,
        stderr: "timeout",
        stdout: "",
        timedOut: true,
      };
    };

    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "ci-reports", "release"),
      totalTimeoutMs: 50,
      commands: [createCommand("core-coverage"), createCommand("public-api")],
      clock: fakeTime.clock,
      runner,
    });

    expect(report.status).toBe("timed_out");
    expect(report.checks.map((check) => check.status)).toEqual([
      "timed_out",
      "skipped_after_timeout",
    ]);
  });

  it("runs independent checks in parallel without exceeding the configured bound", async () => {
    const repo = createTempRepo();
    let active = 0;
    let maximumActive = 0;
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 1_000,
      maxConcurrency: 2,
      commands: [createCommand("a"), createCommand("b"), createCommand("c")],
      runner: async (command) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, command.id === "a" ? 20 : 5),
        );
        active--;
        return okResult(command.id);
      },
    });

    expect(report.status).toBe("passed");
    expect(maximumActive).toBe(2);
  });

  it.each([
    { metadataStatus: 2, allowPendingReleaseMetadata: false },
    { metadataStatus: 0, allowPendingReleaseMetadata: false },
    { metadataStatus: 0, allowPendingReleaseMetadata: true },
  ])(
    "gates heavy publish commands on metadata ($metadataStatus, pending=$allowPendingReleaseMetadata)",
    async ({ metadataStatus, allowPendingReleaseMetadata }) => {
      const repo = createTempRepo();
      const heavyIds = [
        "build",
        "typecheck",
        "test",
        "integration-test-lane",
        "published-test-lane",
        "generated-app-smoke",
        "package-entrypoints-smoke",
        "core-coverage",
        "publish-dry-run",
      ];
      const manifest = createVerificationManifest("publish", { allowPendingReleaseMetadata });
      const commands = manifest.map((command) => ({ ...command, artifacts: [] }));
      const events: string[] = [];
      const report = await runReleaseSpineEvidence({
        rootDir: repo,
        outputDir: join(repo, "out"),
        totalTimeoutMs: 10_000,
        maxConcurrency: 4,
        profile: "publish",
        commands,
        runner: async (command) => {
          events.push(`start:${command.id}`);
          await Promise.resolve();
          events.push(`end:${command.id}`);
          return command.id === "release-metadata"
            ? { ...okResult(command.id), status: metadataStatus }
            : okResult(command.id);
        },
      });

      expect(report.status).toBe(metadataStatus === 0 ? "passed" : "failed");
      expect(findCheck(report.checks, "release-metadata").status).toBe(
        metadataStatus === 0 ? "passed" : "failed",
      );
      expect(
        findCheck(manifest, "release-metadata").command.includes("--allow-pending-changesets"),
      ).toBe(allowPendingReleaseMetadata);
      for (const id of heavyIds) {
        expect(findCheck(report.checks, id).status, id).toBe(
          metadataStatus === 0 ? "passed" : "skipped_prerequisite",
        );
        if (metadataStatus === 0) {
          expect(events.indexOf(`start:${id}`), id).toBeGreaterThan(
            events.indexOf("end:release-metadata"),
          );
        } else {
          expect(events, id).not.toContain(`start:${id}`);
        }
      }
      if (metadataStatus !== 0) {
        expect(findCheck(report.checks, "build").failureReason).toContain(
          "release-metadata (failed)",
        );
      }
      expect(report.summary.pending).toBe(0);
    },
  );

  it("continues publish builds when release metadata is outside the changed inputs", async () => {
    const repo = createTempRepo();
    const manifest = createVerificationManifest("publish", {
      base: "origin/trunk",
      head: "HEAD",
      changedFiles: ["packages/framework-context/src/index.ts"],
    });
    const commands = manifest
      .filter(({ id }) => ["release-metadata", "architecture-policy-runtime", "build"].includes(id))
      .map((command) => ({ ...command, artifacts: [] }));
    const runner = vi.fn((command: EvidenceCommand) => okResult(command.id));
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 10_000,
      profile: "publish",
      commands,
      runner,
    });

    expect(report.status).toBe("passed");
    expect(findCheck(report.checks, "release-metadata").status).toBe("not_applicable");
    expect(findCheck(report.checks, "build").status).toBe("passed");
    expect(runner.mock.calls.map(([command]) => command.id)).not.toContain("release-metadata");
  });

  it("waits for dependencies and fails closed when a prerequisite fails", async () => {
    const repo = createTempRepo();
    const events: string[] = [];
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 1_000,
      maxConcurrency: 3,
      commands: [
        createCommand("build"),
        createCommand("consumer", { dependsOn: ["build"] }),
        createCommand("independent"),
      ],
      runner: async (command) => {
        events.push(`start:${command.id}`);
        await Promise.resolve();
        events.push(`end:${command.id}`);
        return command.id === "build"
          ? { ...okResult(command.id), status: 2 }
          : okResult(command.id);
      },
    });

    expect(events).toContain("start:independent");
    expect(events).not.toContain("start:consumer");
    expect(report.checks.map(({ status }) => status)).toEqual([
      "failed",
      "skipped_prerequisite",
      "passed",
    ]);
    expect(report.checks[1]?.failureReason).toBe(
      "Skipped because prerequisite check(s) did not pass: build (failed).",
    );
  });

  it("terminalizes transitive prerequisite failures without pending checks", async () => {
    const repo = createTempRepo();
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 1_000,
      maxConcurrency: 3,
      commands: [
        createCommand("build"),
        createCommand("package", { dependsOn: ["build"] }),
        createCommand("publish", { dependsOn: ["package"] }),
      ],
      runner: async (command) =>
        command.id === "build" ? { ...okResult(command.id), status: 2 } : okResult(command.id),
    });

    expect(report.status).toBe("failed");
    expect(report.checks.map(({ status }) => status)).toEqual([
      "failed",
      "skipped_prerequisite",
      "skipped_prerequisite",
    ]);
    expect(report.summary.pending).toBe(0);
    expect(report.checks[2]?.failureReason).toBe(
      "Skipped because prerequisite check(s) did not pass: package (skipped_prerequisite).",
    );
  });

  it("starts a dependent only after its prerequisite completes", async () => {
    const repo = createTempRepo();
    const events: string[] = [];
    await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 1_000,
      maxConcurrency: 2,
      commands: [createCommand("first"), createCommand("second", { dependsOn: ["first"] })],
      runner: async (command) => {
        events.push(`start:${command.id}`);
        await Promise.resolve();
        events.push(`end:${command.id}`);
        return okResult(command.id);
      },
    });

    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("locks integration against fast tests and workspace artifacts without serializing independent work", async () => {
    const repo = createTempRepo();
    const runtimeGate = createDeferred<void>();
    const buildGate = createDeferred<void>();
    const typecheckGate = createDeferred<void>();
    const testGate = createDeferred<void>();
    const generatedGate = createDeferred<void>();
    const entrypointGate = createDeferred<void>();
    const events: string[] = [];
    const manifest = createVerificationManifest("spine");
    const commands = [
      "architecture-policy-runtime",
      "build",
      "package-entrypoints-smoke",
      "package-bins-smoke",
      "generated-app-smoke",
      "typecheck",
      "test",
      "integration-test-lane",
    ].map((id) => ({
      ...findCheck(manifest, id),
      artifacts: [],
    }));
    const execution = runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 10_000,
      maxConcurrency: 4,
      commands,
      runner: async (command) => {
        events.push(`start:${command.id}`);
        if (command.id === "architecture-policy-runtime") await runtimeGate.promise;
        if (command.id === "build") await buildGate.promise;
        if (command.id === "typecheck") await typecheckGate.promise;
        if (command.id === "test") await testGate.promise;
        if (command.id === "package-entrypoints-smoke") await entrypointGate.promise;
        if (command.id === "generated-app-smoke") await generatedGate.promise;
        events.push(`end:${command.id}`);
        return okResult(command.id);
      },
    });

    await vi.waitFor(() => expect(events).toContain("start:architecture-policy-runtime"));
    expect(events).not.toContain("start:build");
    runtimeGate.resolve(undefined);
    await vi.waitFor(() => expect(events).toContain("start:build"));
    expect(events).not.toContain("start:typecheck");
    expect(events).not.toContain("start:test");
    expect(events).not.toContain("start:package-bins-smoke");
    buildGate.resolve(undefined);

    await vi.waitFor(() => expect(events).toContain("start:generated-app-smoke"));
    expect(events).not.toContain("start:typecheck");
    expect(events).not.toContain("start:package-entrypoints-smoke");
    expect(events).not.toContain("start:test");
    generatedGate.resolve(undefined);

    await vi.waitFor(() => expect(events).toContain("start:typecheck"));
    expect(events).not.toContain("start:package-entrypoints-smoke");
    expect(events).not.toContain("start:test");
    typecheckGate.resolve(undefined);

    await vi.waitFor(() => {
      expect(events).toContain("start:test");
      expect(events).toContain("start:package-entrypoints-smoke");
    });
    expect(events).not.toContain("start:integration-test-lane");
    testGate.resolve(undefined);
    await vi.waitFor(() => expect(events).toContain("end:test"));
    expect(events).not.toContain("start:integration-test-lane");
    entrypointGate.resolve(undefined);

    const report = await execution;
    expect(report.status).toBe("passed");
    expect(events.indexOf("end:architecture-policy-runtime")).toBeLessThan(
      events.indexOf("start:build"),
    );
    expect(events.indexOf("end:build")).toBeLessThan(events.indexOf("start:typecheck"));
    expect(events.indexOf("end:build")).toBeLessThan(events.indexOf("start:test"));
    expect(events.indexOf("end:generated-app-smoke")).toBeLessThan(
      events.indexOf("start:typecheck"),
    );
    expect(events.indexOf("start:test")).toBeLessThan(
      events.indexOf("end:package-entrypoints-smoke"),
    );
    expect(events.indexOf("start:package-entrypoints-smoke")).toBeLessThan(
      events.indexOf("end:test"),
    );
    expect(events.indexOf("end:test")).toBeLessThan(events.indexOf("start:integration-test-lane"));
    expect(events.indexOf("end:package-entrypoints-smoke")).toBeLessThan(
      events.indexOf("start:integration-test-lane"),
    );
  });

  it("serializes a concurrency group while allowing unrelated work to overlap", async () => {
    const repo = createTempRepo();
    let groupedActive = 0;
    let maximumGroupedActive = 0;
    let unrelatedOverlapped = false;
    await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 1_000,
      maxConcurrency: 3,
      commands: [
        createCommand("pack-a", { concurrencyGroups: ["packaging"] }),
        createCommand("pack-b", { concurrencyGroups: ["packaging"] }),
        createCommand("lint"),
      ],
      runner: async (command) => {
        if ((command.concurrencyGroups?.length ?? 0) > 0) {
          groupedActive++;
          maximumGroupedActive = Math.max(maximumGroupedActive, groupedActive);
        } else {
          unrelatedOverlapped = groupedActive > 0;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        if ((command.concurrencyGroups?.length ?? 0) > 0) groupedActive--;
        return okResult(command.id);
      },
    });

    expect(maximumGroupedActive).toBe(1);
    expect(unrelatedOverlapped).toBe(true);
  });

  it("keeps manifest report order under reverse completion and collects independent failures", async () => {
    const repo = createTempRepo();
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 1_000,
      maxConcurrency: 3,
      commands: [createCommand("slow"), createCommand("medium"), createCommand("fast")],
      runner: async (command) => {
        const delay = command.id === "slow" ? 30 : command.id === "medium" ? 20 : 5;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
        return { ...okResult(command.id), status: command.id === "medium" ? 0 : 2 };
      },
    });

    expect(report.checks.map(({ id }) => id)).toEqual(["slow", "medium", "fast"]);
    expect(report.checks.map(({ status }) => status)).toEqual(["failed", "passed", "failed"]);
    expect(report.summary.failed).toBe(2);
  });

  it("uses maxConcurrency=1 as an explicit sequential fallback", async () => {
    const repo = createTempRepo();
    let active = 0;
    let maximumActive = 0;
    await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 1_000,
      maxConcurrency: 1,
      commands: [createCommand("a"), createCommand("b")],
      runner: async (command) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active--;
        return okResult(command.id);
      },
    });

    expect(maximumActive).toBe(1);
  });

  it("marks running and pending checks interrupted for best-effort signal reports", async () => {
    const repo = createTempRepo();
    let pendingReport: ReleaseSpineEvidenceReport | null = null;
    let runningReport: ReleaseSpineEvidenceReport | null = null;

    await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "ci-reports", "release"),
      totalTimeoutMs: 1_000,
      commands: [createCommand("build"), createCommand("test")],
      runner: () => okResult("ok"),
      onCheckpoint: (checkpoint) => {
        if (!pendingReport && checkpoint.checks.every((check) => check.status === "pending")) {
          pendingReport = checkpoint;
        }
        if (!runningReport && checkpoint.checks.some((check) => check.status === "running")) {
          runningReport = checkpoint;
        }
      },
    });

    expect(pendingReport).not.toBeNull();
    expect(runningReport).not.toBeNull();
    const earlyInterrupted = markReportInterrupted(
      pendingReport ?? failMissingInterruptReport(),
      "SIGINT",
      "2026-01-01T00:00:00.000Z",
    );
    const interrupted = markReportInterrupted(
      runningReport ?? failMissingInterruptReport(),
      "SIGTERM",
      "2026-01-01T00:00:00.000Z",
    );

    expect(earlyInterrupted.status).toBe("interrupted");
    expect(earlyInterrupted.checks.map((check) => check.status)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.checks.map((check) => check.status)).toEqual(["interrupted", "interrupted"]);
  });

  it("runs real commands through the default async runner", async () => {
    const repo = createTempRepo();
    const stdoutPath = join(repo, "command-output", "stdout.log");
    const stderrPath = join(repo, "command-output", "stderr.log");

    const result = await defaultCommandRunner(
      {
        id: "node-output",
        label: "Node output",
        category: "quality",
        command: [process.execPath, "-e", "console.log('runner ok')"],
        timeoutMs: 1_000,
      },
      {
        cwd: repo,
        stderrPath,
        stdoutPath,
        timeoutMs: 1_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("runner ok");
    expect(readFileSync(stdoutPath, "utf8")).toBe("runner ok\n");
    expect(readFileSync(stderrPath, "utf8")).toBe("");
    expect(result.timedOut).toBe(false);
  });

  it("reports command output open failures without rejecting", async () => {
    const repo = createTempRepo();
    const blockedOutputRoot = join(repo, "blocked-output");
    writeFileSync(blockedOutputRoot, "not a directory");

    const result = await defaultCommandRunner(
      {
        id: "blocked-output",
        label: "Blocked output",
        category: "quality",
        command: [process.execPath, "-e", "console.log('not started')"],
        timeoutMs: 1_000,
      },
      {
        cwd: repo,
        stdoutPath: join(blockedOutputRoot, "stdout.log"),
        timeoutMs: 1_000,
      },
    );

    expect(result.status).toBeNull();
    expect(result.errorMessage).toContain("Failed to persist command stdout");
    expect(result.stdoutFileComplete).toBe(false);
  });

  it("reports command output write failures without throwing", async () => {
    const repo = createTempRepo();
    const outputRoot = join(repo, "command-output");
    const outputError = Object.assign(new Error("disk full"), { code: "ENOSPC" });

    const result = await defaultCommandRunner(
      {
        id: "failed-output-write",
        label: "Failed output write",
        category: "quality",
        command: [process.execPath, "-e", "process.stdout.write('diagnostics')"],
        timeoutMs: 1_000,
      },
      {
        cwd: repo,
        stderrPath: join(outputRoot, "stderr.log"),
        stdoutPath: join(outputRoot, "stdout.log"),
        timeoutMs: 1_000,
        writeOutput: () => {
          throw outputError;
        },
      },
    );

    expect(result.status).toBeNull();
    expect(result.errorCode).toBe("ENOSPC");
    expect(result.errorMessage).toContain("Failed to persist command stdout: disk full");
    expect(result.stdoutFileComplete).toBe(false);
  });

  it("keeps the complete sibling stream when one output stream fails", async () => {
    const repo = createTempRepo();
    const outputDir = join(repo, "ci-reports", "release");
    const stdout = "o".repeat(100);
    const stderr = "s".repeat(100);
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir,
      totalTimeoutMs: 5_000,
      commands: [
        createCommand("partial-output-failure", {
          command: [
            process.execPath,
            "-e",
            `process.stderr.write(${JSON.stringify(stderr)}); process.stdout.write(${JSON.stringify(stdout)})`,
          ],
          timeoutMs: 2_000,
        }),
      ],
      commandOutputWriter: (descriptor, output, offset, length) => {
        const text = Buffer.from(output)
          .subarray(offset, offset + length)
          .toString("utf8");
        if (/^o+$/.test(text)) {
          throw Object.assign(new Error("stdout disk full"), { code: "ENOSPC" });
        }
        return writeSync(descriptor, output, offset, length);
      },
      maxCommandOutputBufferLength: 8,
    });

    expect(report.status).toBe("failed");
    expect(
      readFileSync(join(outputDir, "artifacts", "partial-output-failure", "stdout.log"), "utf8"),
    ).toBe(stdout.slice(-8));
    expect(
      readFileSync(join(outputDir, "artifacts", "partial-output-failure", "stderr.log"), "utf8"),
    ).toBe(stderr);
    expect(report.checks[0]?.artifacts.map(({ fresh }) => fresh)).toEqual([true, true]);
    expect(report.checks[0]?.artifacts.map(({ label }) => label)).toEqual([
      "Command stdout (bounded fallback; may be truncated)",
      "Command stderr",
    ]);
  });

  it("retries short command-output writes until the full buffer is persisted", async () => {
    const repo = createTempRepo();
    const stdoutPath = join(repo, "command-output", "stdout.log");
    let writeCalls = 0;
    const result = await defaultCommandRunner(
      {
        id: "short-output-write",
        label: "Short output write",
        category: "quality",
        command: [process.execPath, "-e", "process.stdout.write('complete diagnostics')"],
        timeoutMs: 1_000,
      },
      {
        cwd: repo,
        stdoutPath,
        timeoutMs: 1_000,
        writeOutput: (descriptor, output, offset) => {
          writeCalls++;
          return writeSync(descriptor, output, offset, 1);
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdoutFileComplete).toBe(true);
    expect(writeCalls).toBeGreaterThan(1);
    expect(readFileSync(stdoutPath, "utf8")).toBe("complete diagnostics");
  });

  it("times out real commands through the default async runner", async () => {
    const repo = createTempRepo();
    const stdoutPath = join(repo, "command-output", "stdout.log");
    const stderrPath = join(repo, "command-output", "stderr.log");

    const result = await defaultCommandRunner(
      {
        id: "slow-node",
        label: "Slow Node",
        category: "quality",
        command: [
          process.execPath,
          "-e",
          "process.stdout.write('before timeout'); setTimeout(() => undefined, 10_000)",
        ],
        timeoutMs: 2_000,
      },
      {
        cwd: repo,
        stderrPath,
        stdoutPath,
        timeoutMs: 2_000,
      },
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(true);
    expect(readFileSync(stdoutPath, "utf8")).toBe("before timeout");
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  });

  it("parses root, output, and timeout options after the pnpm separator", () => {
    const repo = createTempRepo();
    const options = parseArgs([
      "--",
      "--root",
      repo,
      "--output-dir",
      "ci-reports/custom-release",
      "--total-timeout-ms",
      "25",
      "--max-concurrency",
      "1",
    ]);

    expect(options.rootDir).toBe(repo);
    expect(options.outputDir).toBe(resolve("ci-reports/custom-release"));
    expect(options.totalTimeoutMs).toBe(25);
    expect(options.maxConcurrency).toBe(1);
  });

  it("uses safe bounded CLI concurrency by default", () => {
    const expected = Math.max(2, Math.min(DEFAULT_CLI_MAX_CONCURRENCY, availableParallelism()));
    expect(parseArgs([]).maxConcurrency).toBe(expected);
  });

  it("resolves concurrency from CLI flags, environment, or runner parallelism", () => {
    expect(parseArgs(["--concurrency", "3"]).maxConcurrency).toBe(3);
    expect(parseArgs(["--concurrency=5"]).maxConcurrency).toBe(5);
    expect(parseArgs(["--max-concurrency", "6"]).maxConcurrency).toBe(6);
    expect(parseArgs(["--max-concurrency=7"]).maxConcurrency).toBe(7);
    expect(parseArgs([], { CROCO_CI_CONCURRENCY: "8" }).maxConcurrency).toBe(8);
    expect(parseArgs([], { CROCO_CONCURRENCY: "9" }).maxConcurrency).toBe(9);
    expect(resolveDefaultCliMaxConcurrency({}, 1)).toBe(1);
    expect(resolveDefaultCliMaxConcurrency({}, 2)).toBe(2);
    expect(resolveDefaultCliMaxConcurrency({}, 4)).toBe(2);
    expect(resolveDefaultCliMaxConcurrency({}, 8)).toBe(2);
    expect(resolveDefaultCliMaxConcurrency({ CROCO_CI_CONCURRENCY: "4" }, 2)).toBe(4);
    expect(resolveDefaultCliMaxConcurrency({ CROCO_CI_CONCURRENCY: "0" }, 4)).toBe(2);
    expect(resolveDefaultCliMaxConcurrency({ CROCO_CI_CONCURRENCY: "-1" }, 4)).toBe(2);
    expect(resolveDefaultCliMaxConcurrency({ CROCO_CI_CONCURRENCY: "abc" }, 4)).toBe(2);

    expect(() => parseArgs(["--concurrency"])).toThrowError(/--concurrency requires a value/);
    expect(() => parseArgs(["--concurrency="])).toThrowError(/--concurrency requires a value/);
    expect(() => parseArgs(["--concurrency", "0"])).toThrowError(
      /--concurrency must be a positive integer/,
    );
    expect(() => parseArgs(["--concurrency=0"])).toThrowError(
      /--concurrency must be a positive integer/,
    );
    expect(() => parseArgs(["--concurrency=abc"])).toThrowError(
      /--concurrency must be a positive integer/,
    );
  });

  it("records immutable base, head, and candidate OIDs in verification evidence", async () => {
    const repo = createTempRepo();
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const candidateSha = "c".repeat(40);
    vi.stubEnv("GITHUB_SHA", candidateSha);

    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 1_000,
      commands: [createCommand("identity-evidence")],
      verificationBaseSha: baseSha,
      verificationHeadSha: headSha,
      verificationCandidateSha: candidateSha,
      runner: () => okResult("passed"),
    });

    expect(report.provenance.verificationIdentity).toEqual({
      baseSha,
      headSha,
      candidateSha,
    });
    expect(readFileSync(join(repo, "out", "spine-evidence.md"), "utf8")).toContain(
      `- Merge candidate: \`${candidateSha}\``,
    );
  });

  it("rejects incomplete immutable verification evidence identity", async () => {
    expect(() => parseArgs(["--verification-base-sha", "a".repeat(40)])).not.toThrow();
    await expect(
      runReleaseSpineEvidence({
        rootDir: createTempRepo(),
        outputDir: "out",
        totalTimeoutMs: 1_000,
        commands: [],
        verificationBaseSha: "a".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "INCOMPLETE_VERIFICATION_IDENTITY" });
  });

  it("rejects verification evidence for a candidate other than the GitHub revision", async () => {
    vi.stubEnv("GITHUB_SHA", "d".repeat(40));

    await expect(
      runReleaseSpineEvidence({
        rootDir: createTempRepo(),
        outputDir: "out",
        totalTimeoutMs: 1_000,
        commands: [],
        verificationBaseSha: "a".repeat(40),
        verificationHeadSha: "b".repeat(40),
        verificationCandidateSha: "c".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_CANDIDATE_PROVENANCE_MISMATCH" });
  });

  it("keeps default repository verification evidence outside the worktree", () => {
    const repo = createTempRepo();
    const options = parseArgs(["--root", repo, "--profile", "repo"]);
    tempRepos.push(options.outputDir);

    expect(options.outputDir.startsWith(`${repo}/`)).toBe(false);
    expect(options.outputDir.startsWith(join(tmpdir(), "croco-verification-repo-"))).toBe(true);
  });

  it("parses the explicit cacheable failure class", () => {
    expect(parseArgs(["--inject-failure", "core-verification"]).injectedFailure).toBe(
      "core-verification",
    );
    expect(() => parseArgs(["--inject-failure", "unknown"])).toThrow(
      "Failure class must be one of",
    );
    expect(parseArgs(["--full-selection"]).fullSelection).toBe(true);
  });

  it("uses the full publish manifest when full selection is requested with a scoped range", () => {
    const commands = createReleaseSpineCommands({
      rootDir: process.cwd(),
      profile: "publish",
      base: "origin/trunk",
      head: "HEAD",
      changedFiles: ["packages/retry-core/package.json"],
      fullSelection: true,
    });

    for (const id of Object.values(CACHEABLE_FAILURE_COMMAND)) {
      expect(findCheck(commands, id).applicable).not.toBe(false);
    }
  });

  it("fails the deterministic command without invoking its real runner", async () => {
    const repo = createTempRepo();
    const runner = vi.fn<CommandRunner>(() => okResult("unexpected"));
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "evidence"),
      totalTimeoutMs: 1_000,
      profile: "publish",
      commands: [createCommand("verification-policy")],
      injectedFailure: "core-verification",
      runner,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(report.status).toBe("failed");
    expect(report.checks[0]).toMatchObject({
      id: "verification-policy",
      status: "failed",
      errorCode: "CACHEABLE_EXPERIMENT_INJECTED_FAILURE",
      exitCode: 1,
    });
  });

  it("enables pending release metadata only through the explicit option", () => {
    expect(parseArgs([]).allowPendingReleaseMetadata).toBe(false);
    expect(parseArgs(["--allow-pending-release-metadata"]).allowPendingReleaseMetadata).toBe(true);
  });

  it("reuses exact-head passed evidence without executing the verification command", async () => {
    const repo = createTempRepo();
    const evidencePath = join(repo, "bundle.json");
    writeFileSync(
      evidencePath,
      JSON.stringify({
        schemaVersion: "croco.test-evidence/v1",
        status: "passed",
        missingArtifacts: [],
        summary: { failed: 0, flaky: 0, passed: 1, skipped: 0, total: 1 },
        records: [
          {
            schemaVersion: "croco.test-evidence/v1",
            id: "verification/repo/public-api",
            runner: "croco-verification",
            outcome: "passed",
            intent: { contractIds: ["public-api"], description: "Public API" },
            observed: { contractIds: ["public-api"] },
            fidelity: {
              boot: "isolated",
              dependency: "fake",
              isolation: "fake",
              runtime: "node",
              validation: "isolated",
            },
            replay: { command: "fake public-api" },
            diagnostics: [],
            attempts: [{ attempt: 1, outcome: "passed" }],
            resources: { leaks: [], status: "not-checked" },
            attachments: [],
            metadata: { commitSha: "exact-head", profile: "spine" },
          },
        ],
      }),
    );
    const commands = reuseTestEvidence(
      [createCommand("public-api")],
      evidencePath,
      "exact-head",
      "spine",
      repo,
    );
    const runner = vi.fn(() => okResult("must not run"));
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 100,
      commands,
      runner,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(report.checks[0]).toMatchObject({
      status: "passed",
      durationMs: 0,
      exitCode: 0,
      artifacts: [],
    });
  });

  it("parses an optional exact-head evidence bundle input", () => {
    expect(
      parseArgs(["--test-evidence", "ci-reports/test-evidence/bundle.json"]).testEvidencePath,
    ).toBe("ci-reports/test-evidence/bundle.json");
  });

  it("keeps a non-applicable check non-applicable even when reuse metadata is present", async () => {
    const repo = createTempRepo();
    const command = {
      ...createCommand("not-applicable"),
      applicable: false,
      selectionReason: "Skipped because the changed files are unrelated.",
      reusedEvidence: { path: "bundle.json", recordId: "verification/spine/not-applicable" },
    };
    const runner = vi.fn(() => okResult("must not run"));
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 100,
      commands: [command],
      runner,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(report.checks[0]).toMatchObject({
      failureReason: "Skipped because the changed files are unrelated.",
      selectionReason: "Skipped because the changed files are unrelated.",
      status: "not_applicable",
    });
    expect(readFileSync(join(repo, "out", "spine-evidence.md"), "utf8")).toContain(
      "- Selection reason: Skipped because the changed files are unrelated.",
    );
  });

  it("rejects failed bundles and bundles with missing artifacts for command reuse", () => {
    const repo = createTempRepo();
    const evidencePath = join(repo, "bundle.json");
    writeFileSync(
      evidencePath,
      JSON.stringify({
        ...reusableEvidenceBundle("fake a"),
        status: "failed",
        missingArtifacts: [
          { path: "missing.json", recordId: "verification/spine/artifactful", required: true },
        ],
      }),
    );
    expect(() => reuseTestEvidence([createCommand("a")], evidencePath, "exact-head")).toThrow(
      "requires a passed croco.test-evidence/v1 bundle without missing artifacts",
    );
  });

  it("reuses an attached required artifact only when it exists and marks it as reused", async () => {
    const repo = createTempRepo();
    const evidencePath = join(repo, "bundle.json");
    writeFileSync(
      evidencePath,
      JSON.stringify({
        schemaVersion: "croco.test-evidence/v1",
        status: "passed",
        missingArtifacts: [],
        summary: { failed: 0, flaky: 0, passed: 1, skipped: 0, total: 1 },
        records: [
          {
            schemaVersion: "croco.test-evidence/v1",
            id: "verification/spine/artifactful",
            runner: "croco-verification",
            outcome: "passed",
            intent: { contractIds: ["artifactful"], description: "Artifactful" },
            observed: { contractIds: ["artifactful"] },
            fidelity: {
              boot: "isolated",
              dependency: "fake",
              isolation: "fake",
              runtime: "node",
              validation: "isolated",
            },
            replay: { command: "fake artifactful" },
            diagnostics: [],
            attempts: [{ attempt: 1, outcome: "passed" }],
            resources: { leaks: [], status: "not-checked" },
            attachments: [{ kind: "report", path: "missing.json" }],
            metadata: { commitSha: "exact-head", profile: "spine" },
          },
        ],
      }),
    );
    const command = {
      ...createCommand("artifactful"),
      artifacts: [{ label: "required", path: "missing.json", required: true }],
    };
    expect(
      reuseTestEvidence([command], evidencePath, "exact-head", "spine", repo)[0],
    ).not.toHaveProperty("reusedEvidence");
    writeFileSync(join(repo, "missing.json"), "{}\n");
    const commands = reuseTestEvidence([command], evidencePath, "exact-head", "spine", repo);
    const runner = vi.fn(() => okResult("must not run"));
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 100,
      commands,
      runner,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(report.checks[0]?.artifacts[0]).toMatchObject({
      exists: true,
      fresh: false,
      reusedEvidenceRecordId: "verification/spine/artifactful",
    });
  });

  it("does not reuse evidence with a mismatched command", () => {
    const repo = createTempRepo();
    const evidencePath = join(repo, "bundle.json");
    writeFileSync(evidencePath, JSON.stringify(reusableEvidenceBundle("pnpm wrong-command")));
    expect(
      reuseTestEvidence(
        [createCommand("artifactful")],
        evidencePath,
        "exact-head",
        "spine",
        repo,
      )[0],
    ).not.toHaveProperty("reusedEvidence");
  });

  it("clears reuse metadata when missing artifacts force command execution", async () => {
    const repo = createTempRepo();
    const runner = vi.fn(() => okResult("executed"));
    const report = await runReleaseSpineEvidence({
      rootDir: repo,
      outputDir: join(repo, "out"),
      totalTimeoutMs: 100,
      commands: [
        {
          ...createCommand("artifactful"),
          artifacts: [{ label: "required", path: "missing.json", required: true }],
          reusedEvidence: { path: "bundle.json", recordId: "verification/spine/artifactful" },
        },
      ],
      runner,
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(report.checks[0]).not.toHaveProperty("reusedEvidence");
  });

  it("wraps unreadable and malformed reuse inputs in a stable verification problem", () => {
    const repo = createTempRepo();
    const missingPath = join(repo, "missing.json");
    expect(() => reuseTestEvidence([], missingPath, "exact-head")).toThrow(
      "Unable to read a valid croco.test-evidence/v1 bundle",
    );
    const malformedPath = join(repo, "malformed.json");
    writeFileSync(malformedPath, "{not-json");
    expect(() => reuseTestEvidence([], malformedPath, "exact-head")).toThrow("Cause:");
  });

  it("rejects profile overrides after a profile alias has selected one", () => {
    expect(() => parseArgs(["--profile", "publish", "--", "--profile", "repo"])).toThrow(
      "--profile may be provided only once",
    );
  });

  it("preserves explicit output options when root is parsed later", () => {
    const repo = createTempRepo();
    const outputDir = "ci-reports/custom-release";
    const options = parseArgs(["--output-dir", outputDir, "--root", repo]);

    expect(options.rootDir).toBe(repo);
    expect(options.outputDir).toBe(resolve(outputDir));
  });

  it("rejects partial numeric timeout option values", () => {
    expect(() => parseArgs(["--total-timeout-ms", "25ms"])).toThrow(
      "--total-timeout-ms must be a positive integer",
    );
  });

  it("wires the root package script", () => {
    const packageJson = readJson(join(__dirname, "../../package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["release:spine-evidence"]).toBe("pnpm verify:spine");
  });
});

function createReleaseJourneySourceReport(
  contractArtifactPath: string,
): GeneratedSmokeJourneySourceReport {
  const step = (
    label: string,
    options: { readonly artifact?: string; readonly diagnosticCodes?: readonly string[] } = {},
  ) => ({
    label,
    command: `pnpm ${label.toLowerCase().replaceAll(" ", ":")}`,
    artifacts: options.artifact ? [{ reportRelativePath: options.artifact }] : [],
    status: "passed" as const,
    diagnosticCodes: options.diagnosticCodes ?? [],
  });

  return {
    generatedAt: "2026-07-11T00:00:00.000Z",
    status: "passed",
    gates: [],
    cases: [
      {
        name: "production-app-starter",
        status: "passed",
        recovery: { localRerunCommand: "pnpm create-croco-app:smoke production-app-starter" },
        steps: [
          step("generate"),
          step("install"),
          step("dev smoke"),
          step("Contract snapshot", { artifact: contractArtifactPath }),
          step("Contract coverage"),
          step("Contract diff"),
          step("OpenAPI contract"),
          step("RPC client"),
          step("DI graph verify"),
        ],
      },
      {
        name: "graphql-lambda-api",
        status: "passed",
        recovery: { localRerunCommand: "pnpm create-croco-app:smoke graphql-lambda-api" },
        steps: [step("protected GraphQL route smoke")],
      },
      {
        name: "rest-spa-contracts",
        status: "passed",
        recovery: { localRerunCommand: "pnpm create-croco-app:smoke rest-spa-contracts" },
        steps: [
          step("strict Problem declaration canary", {
            diagnosticCodes: ["contract-route-missing-problem-response-contract"],
          }),
          step("strict OpenAPI schema canary"),
          step("strict RPC schema canary"),
        ],
      },
    ],
  };
}

function createTempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "croco-release-spine-evidence-"));
  tempRepos.push(repo);
  return repo;
}

function createCommand(
  id: string,
  options: {
    readonly artifacts?: readonly EvidenceArtifactExpectation[];
    readonly command?: readonly string[];
    readonly concurrencyGroups?: readonly string[];
    readonly dependsOn?: readonly string[];
    readonly selectionReason?: string;
    readonly timeoutMs?: number;
  } = {},
): EvidenceCommand {
  return {
    id,
    label: id,
    category: "quality",
    command: options.command ?? ["fake", id],
    concurrencyGroups: options.concurrencyGroups,
    dependsOn: options.dependsOn,
    selectionReason: options.selectionReason,
    timeoutMs: options.timeoutMs ?? 100,
    artifacts: options.artifacts,
  };
}

function okResult(stdout: string): CommandRunResult {
  return {
    errorCode: null,
    errorMessage: null,
    signal: null,
    status: 0,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) throw new Error("Deferred promise was not initialized");
      resolvePromise(value);
    },
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function findCheck(manifest: readonly EvidenceCommand[], id: string): EvidenceCommand {
  const check = manifest.find((entry) => entry.id === id);
  if (!check) {
    throw new Error(`Missing manifest check ${id}`);
  }
  return check;
}

function reusableEvidenceBundle(command: string): object {
  return {
    schemaVersion: "croco.test-evidence/v1",
    status: "passed",
    missingArtifacts: [],
    summary: { failed: 0, flaky: 0, passed: 1, skipped: 0, total: 1 },
    records: [
      {
        schemaVersion: "croco.test-evidence/v1",
        id: "verification/spine/artifactful",
        runner: "croco-verification",
        outcome: "passed",
        intent: { contractIds: ["artifactful"], description: "Artifactful" },
        observed: { contractIds: ["artifactful"] },
        fidelity: {
          boot: "isolated",
          dependency: "fake",
          isolation: "fake",
          runtime: "node",
          validation: "isolated",
        },
        replay: { command },
        diagnostics: [],
        attempts: [{ attempt: 1, outcome: "passed" }],
        resources: { leaks: [], status: "not-checked" },
        attachments: [],
        metadata: { commitSha: "exact-head", profile: "spine" },
      },
    ],
  };
}

function createFakeClock(): {
  readonly advance: (ms: number) => void;
  readonly clock: Clock;
} {
  let currentMs = 0;
  return {
    advance: (ms: number) => {
      currentMs += ms;
    },
    clock: {
      nowIso: () => new Date(currentMs).toISOString(),
      nowMs: () => currentMs,
    },
  };
}

function failMissingInterruptReport(): never {
  throw new Error("Missing interrupt checkpoint report");
}
