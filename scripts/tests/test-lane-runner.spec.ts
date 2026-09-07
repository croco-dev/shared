import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_ROOT_VITEST_WORKERS,
  MAX_ROOT_VITEST_WORKERS,
  createFastPackageTurboArguments,
  createTestLanePlan,
  hasFailedBuildTask,
  readCompletedPlaywrightPaths,
  readCompletedVitestPaths,
  readVitestExecutionEvidence,
  readVitestFailureDetails,
  readTurboRunSummary,
  readTurboTestTaskEvidence,
  redactLiveResourceValues,
  resolveMaxRootVitestWorkers,
  resolveTurboPackageFilters,
  runTestLane,
} from "../test-lane-runner.mts";
import { readTestInventory } from "../test-inventory.mts";
import type { TestInventory } from "../test-inventory.mts";

const REAL_TURBO_TEST_TIMEOUT_MS = 120_000;
const PACKAGE_MANAGER = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as {
    readonly packageManager: string;
  }
).packageManager;

const inventory: TestInventory = {
  version: 1,
  exceptions: [],
  tests: [
    { path: "packages/a/src/tests/a.spec.ts", lane: "fast", qualifiers: [], owner: "@croco/a" },
    {
      path: "packages/a/src/tests/i.spec.ts",
      lane: "integration",
      qualifiers: [],
      owner: "@croco/a",
    },
    {
      path: "packages/b/src/tests/i.spec.ts",
      lane: "integration",
      qualifiers: [],
      owner: "@croco/b",
    },
    { path: "packages/b/src/tests/live.spec.ts", lane: "live", qualifiers: [], owner: "@croco/b" },
    { path: "scripts/tests/repo.spec.ts", lane: "fast", qualifiers: [], owner: "repo:ci" },
  ],
};

describe("test lane runner", () => {
  it("bounds fast package processes and Vitest workers while resolving the build graph", () => {
    const root = resolve(import.meta.dirname, "../..");
    const args = createFastPackageTurboArguments(root, [
      {
        owner: "@croco/events-core",
        cwd: "packages/events-core",
        paths: ["src/tests/EventBus.spec.ts"],
        command: ["pnpm", "run", "test"],
      },
    ]);

    expect(args).not.toContain("--only");
    expect(args).toContain("test:evidence");
    expect(args).not.toContain("--");
    expect(args).toContain("--filter=@croco/events-core");
    expect(args.find((argument) => argument.startsWith("--concurrency="))).toMatch(
      /^--concurrency=[1-4]$/,
    );
  });

  it("resolves root vitest worker allocation dynamically up to runner parallelism", () => {
    expect(MAX_ROOT_VITEST_WORKERS).toBe(2);
    expect(DEFAULT_MAX_ROOT_VITEST_WORKERS).toBe(2);
    expect(resolveMaxRootVitestWorkers({}, 1)).toBe(1);
    expect(resolveMaxRootVitestWorkers({}, 2)).toBe(2);
    expect(resolveMaxRootVitestWorkers({}, 4)).toBe(2);
    expect(resolveMaxRootVitestWorkers({}, 8)).toBe(2);
    expect(resolveMaxRootVitestWorkers({ MAX_ROOT_VITEST_WORKERS: "6" }, 2)).toBe(6);
    expect(resolveMaxRootVitestWorkers({ CROCO_TEST_WORKERS: "8" }, 2)).toBe(8);
    expect(resolveMaxRootVitestWorkers({ MAX_ROOT_VITEST_WORKERS: "invalid" }, 2)).toBe(2);
    expect(resolveMaxRootVitestWorkers({ MAX_ROOT_VITEST_WORKERS: "0" }, 4)).toBe(2);
    expect(resolveMaxRootVitestWorkers({ CROCO_TEST_WORKERS: "-2" }, 4)).toBe(2);
  });

  it.each(["cold", "warm"])(
    "resolves the build graph from a %s cache and restores fast test evidence",
    (cacheState) => {
      const root = mkdtempSync(join(tmpdir(), "croco-fast-lane-build-graph-"));
      const previousTurboCacheDirectory = process.env.TURBO_CACHE_DIR;
      const previousTurboForce = process.env.TURBO_FORCE;
      try {
        process.env.TURBO_CACHE_DIR = join(root, ".turbo-cache");
        delete process.env.TURBO_FORCE;
        writeFileSync(join(root, ".gitignore"), "node_modules\n**/dist\n**/.turbo\n.turbo-cache\n");
        mkdirSync(join(root, "packages/dependency"), { recursive: true });
        mkdirSync(join(root, "packages/consumer/src/tests"), { recursive: true });
        symlinkSync(
          resolve(import.meta.dirname, "../../node_modules"),
          join(root, "node_modules"),
          process.platform === "win32" ? "junction" : "dir",
        );
        writeFileSync(
          join(root, "package.json"),
          `${JSON.stringify({ private: true, packageManager: PACKAGE_MANAGER }, null, 2)}\n`,
        );
        writeFileSync(
          join(root, "pnpm-workspace.yaml"),
          "packages:\n  - packages/*\nverifyDepsBeforeRun: false\n",
        );
        writeFileSync(
          join(root, "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n  packages/dependency: {}\n  packages/consumer:\n    dependencies:\n      '@fixture/dependency':\n        specifier: workspace:*\n        version: link:../dependency\n",
        );
        writeFileSync(
          join(root, "turbo.json"),
          `${JSON.stringify(
            {
              tasks: {
                build: { dependsOn: ["^build"], outputs: ["dist/**"] },
                "test:evidence": {
                  dependsOn: ["build", "^build"],
                  outputs: [".turbo/croco-test-evidence.json"],
                },
              },
            },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          join(root, "packages/dependency/package.json"),
          `${JSON.stringify(
            {
              name: "@fixture/dependency",
              version: "1.0.0",
              scripts: { build: "node build.mjs" },
            },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          join(root, "packages/dependency/build.mjs"),
          'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("dist", { recursive: true });\nwriteFileSync("dist/ready.txt", "ready\\n");\n',
        );
        writeFileSync(
          join(root, "packages/consumer/package.json"),
          `${JSON.stringify(
            {
              name: "@fixture/consumer",
              version: "1.0.0",
              dependencies: { "@fixture/dependency": "workspace:*" },
              scripts: {
                build: "node build.mjs",
                test: "vitest run src/tests/consumer.spec.ts",
                "test:evidence":
                  "pnpm run test --maxWorkers=1 --reporter=json --outputFile=.turbo/croco-test-evidence.json",
              },
            },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          join(root, "packages/consumer/build.mjs"),
          'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("dist", { recursive: true });\nwriteFileSync("dist/ready.txt", "ready\\n");\n',
        );
        writeFileSync(
          join(root, "packages/consumer/src/tests/consumer.spec.ts"),
          'import { existsSync } from "node:fs";\nimport { expect, it } from "vitest";\nit("receives declared build artifacts", () => {\n  expect(existsSync("../dependency/dist/ready.txt")).toBe(true);\n  expect(existsSync("dist/ready.txt")).toBe(true);\n});\n',
        );

        if (cacheState === "warm") {
          execFileSync(
            resolve(import.meta.dirname, "../../node_modules/.bin/turbo"),
            ["run", "build", "--summarize"],
            { cwd: root, env: process.env, stdio: "pipe" },
          );
          rmSync(join(root, "packages/dependency/dist"), { recursive: true });
          rmSync(join(root, "packages/consumer/dist"), { recursive: true });
        }
        const buildSummary = readTurboRunSummary(root, "");
        const laneOptions: Parameters<typeof runTestLane>[0] = {
          inventory: {
            version: 1,
            exceptions: [],
            tests: [
              {
                path: "packages/consumer/src/tests/consumer.spec.ts",
                lane: "fast" as const,
                qualifiers: [],
                owner: "@fixture/consumer",
              },
            ],
          },
          lane: "fast" as const,
          rootDir: root,
        };
        const report = runTestLane(laneOptions);
        const laneSummary = readTurboRunSummary(root, "");
        const buildTasks = laneSummary?.tasks?.filter((task) => task.task === "build");
        expect(buildTasks).toHaveLength(2);
        for (const task of buildTasks ?? []) {
          expect(task.cache?.status).toBe(cacheState === "warm" ? "HIT" : "MISS");
          if (cacheState === "warm") {
            expect(task.hash).toBe(
              buildSummary?.tasks?.find((build) => build.package === task.package)?.hash,
            );
          }
        }

        expect(report.status).toBe("passed");
        expect(existsSync(join(root, "packages/dependency/dist/ready.txt"))).toBe(true);
        expect(existsSync(join(root, "packages/consumer/dist/ready.txt"))).toBe(true);
        expect(report.commands).toEqual([
          expect.objectContaining({
            owner: "@fixture/consumer",
            executionState: "executed",
            cacheHash: expect.any(String),
          }),
        ]);
        const restored = runTestLane(laneOptions);
        expect(restored.status).toBe("passed");
        expect(restored.commands[0]).toMatchObject({
          executionState: "reused",
          executedPaths: ["src/tests/consumer.spec.ts"],
        });
      } finally {
        if (previousTurboCacheDirectory === undefined) {
          delete process.env.TURBO_CACHE_DIR;
        } else {
          process.env.TURBO_CACHE_DIR = previousTurboCacheDirectory;
        }
        if (previousTurboForce === undefined) {
          delete process.env.TURBO_FORCE;
        } else {
          process.env.TURBO_FORCE = previousTurboForce;
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    REAL_TURBO_TEST_TIMEOUT_MS,
  );

  const exactScript = (command: { readonly paths: readonly string[] }, lane: string): string =>
    `vitest run ${command.paths.join(" ")}`;

  it("identifies failed build tasks for the one-shot lane retry", () => {
    expect(hasFailedBuildTask(undefined)).toBe(false);
    expect(hasFailedBuildTask({ tasks: [] })).toBe(false);
    expect(
      hasFailedBuildTask({
        tasks: [
          { package: "@croco/a", task: "test", execution: { exitCode: 1 } },
          { package: "@croco/a", task: "build", cache: { status: "HIT" } },
        ],
      }),
    ).toBe(false);
    expect(
      hasFailedBuildTask({
        tasks: [{ package: "@croco/b", task: "build", execution: { exitCode: 1 } }],
      }),
    ).toBe(true);
  });

  it("groups exact inventory paths by workspace and owner deterministically", () => {
    expect(createTestLanePlan(inventory, "integration")).toEqual([
      {
        owner: "@croco/a",
        cwd: "packages/a",
        paths: ["src/tests/i.spec.ts"],
        command: ["pnpm", "run", "test:integration"],
      },
      {
        owner: "@croco/b",
        cwd: "packages/b",
        paths: ["src/tests/i.spec.ts"],
        command: ["pnpm", "run", "test:integration"],
      },
    ]);
    expect(createTestLanePlan(inventory, "fast", ["repo:ci"])[0]).toMatchObject({
      cwd: ".",
      paths: ["scripts/tests/repo.spec.ts"],
      command: ["pnpm", "exec", "vitest", "run", "scripts/tests/repo.spec.ts"],
    });
    expect(createTestLanePlan(inventory, "fast", ["@croco/a"])[0]).toMatchObject({
      command: ["pnpm", "run", "test"],
    });
  });

  it("credits only Vitest files whose assertions all passed", () => {
    const root = mkdtempSync(join(tmpdir(), "croco-lane-report-"));
    const reportPath = join(root, "vitest.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        testResults: [
          {
            name: join(root, "src/tests/passed.spec.ts"),
            status: "passed",
            assertionResults: [{ status: "passed" }],
          },
          {
            name: join(root, "src/tests/partial.spec.ts"),
            status: "passed",
            assertionResults: [
              { status: "passed", fullName: "partial passes" },
              { status: "skipped", fullName: "partial needs credentials" },
              { status: "todo", fullName: "partial needs implementation" },
            ],
          },
          {
            name: join(root, "src/tests/all-skipped.spec.ts"),
            status: "passed",
            assertionResults: [{ status: "skipped", title: "needs Linux" }],
          },
          {
            name: join(root, "src/tests/failed.spec.ts"),
            status: "failed",
            assertionResults: [
              { status: "failed", fullName: "fails loudly" },
              { status: "skipped", fullName: "failure skips cleanup" },
            ],
          },
        ],
      }),
    );

    expect(readCompletedVitestPaths(reportPath, root)).toEqual(["src/tests/passed.spec.ts"]);
    expect(readVitestExecutionEvidence(reportPath, root)).toEqual({
      executedPaths: ["src/tests/passed.spec.ts"],
      skippedFiles: [
        {
          path: "src/tests/all-skipped.spec.ts",
          passedAssertions: 0,
          skippedAssertions: [{ name: "needs Linux", status: "skipped" }],
          status: "skipped",
        },
        {
          path: "src/tests/failed.spec.ts",
          passedAssertions: 0,
          skippedAssertions: [{ name: "failure skips cleanup", status: "skipped" }],
          status: "failed-with-skips",
        },
        {
          path: "src/tests/partial.spec.ts",
          passedAssertions: 1,
          skippedAssertions: [
            { name: "partial needs credentials", status: "skipped" },
            { name: "partial needs implementation", status: "todo" },
          ],
          status: "partially-executed",
        },
      ],
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("canonicalizes workspace aliases before comparing Vitest file paths", () => {
    const parent = mkdtempSync(join(tmpdir(), "croco-lane-alias-"));
    const root = join(parent, "workspace");
    const alias = join(parent, "workspace-alias");
    const testPath = join(root, "src/tests/passed.spec.ts");
    mkdirSync(join(root, "src/tests"), { recursive: true });
    writeFileSync(testPath, "export {};\n");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    const reportPath = join(root, "vitest.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        testResults: [
          {
            name: testPath,
            status: "passed",
            assertionResults: [{ status: "passed" }],
          },
        ],
      }),
    );

    expect(readCompletedVitestPaths(reportPath, alias)).toEqual(["src/tests/passed.spec.ts"]);
    rmSync(parent, { recursive: true, force: true });
  });

  it("retains bounded failed assertion details after the Vitest report is consumed", () => {
    const root = mkdtempSync(join(tmpdir(), "croco-lane-failure-report-"));
    const reportPath = join(root, "vitest.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        testResults: [
          {
            name: join(root, "scripts/tests/failing.spec.ts"),
            status: "failed",
            assertionResults: [
              {
                status: "failed",
                fullName: "failing contract rejects stale evidence",
                failureMessages: ["expected stale evidence to fail"],
              },
            ],
          },
        ],
      }),
    );

    expect(readVitestFailureDetails(reportPath, root)).toEqual([
      "scripts/tests/failing.spec.ts > failing contract rejects stale evidence\nexpected stale evidence to fail",
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("redacts complete and comma-delimited live resource values", () => {
    const environment = {
      POLAR_PRODUCT_ID: "product-secret",
      POLAR_PRICE_IDS: "price-one, price-two",
    };

    expect(
      redactLiveResourceValues(
        "product-secret is missing price-one and price-two from price-one, price-two",
        ["POLAR_PRODUCT_ID", "POLAR_PRICE_IDS"],
        environment,
      ),
    ).toBe(
      "[REDACTED:POLAR_PRODUCT_ID] is missing [REDACTED:POLAR_PRICE_IDS] and [REDACTED:POLAR_PRICE_IDS] from [REDACTED:POLAR_PRICE_IDS]",
    );
  });

  it("rejects skipped or partially completed Playwright specs", () => {
    const root = mkdtempSync(join(tmpdir(), "croco-playwright-report-"));
    const reportPath = join(root, "playwright.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        suites: [
          {
            specs: [
              {
                file: "e2e/passed.spec.ts",
                tests: [{ results: [{ status: "passed" }] }],
              },
              {
                file: "e2e/skipped.spec.ts",
                tests: [{ results: [{ status: "skipped" }] }],
              },
              {
                file: "e2e/partial.spec.ts",
                tests: [{ results: [{ status: "passed" }] }, { results: [{ status: "skipped" }] }],
              },
            ],
          },
        ],
      }),
    );

    expect(readCompletedPlaywrightPaths(reportPath, root)).toEqual(["e2e/passed.spec.ts"]);
    expect(readCompletedPlaywrightPaths(reportPath, root, ["tests/e2e/passed.spec.ts"])).toEqual([
      "tests/e2e/passed.spec.ts",
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not credit an ambiguous Playwright basename", () => {
    const root = mkdtempSync(join(tmpdir(), "croco-playwright-report-"));
    const reportPath = join(root, "playwright.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        suites: [
          {
            specs: [
              {
                file: "passed.spec.ts",
                tests: [{ results: [{ status: "passed" }] }],
              },
            ],
          },
        ],
      }),
    );

    expect(
      readCompletedPlaywrightPaths(reportPath, root, [
        "apps/admin/passed.spec.ts",
        "apps/console/passed.spec.ts",
      ]),
    ).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("relocates only complete unambiguous cached Vitest evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "croco-relocated-turbo-evidence-"));
    const workspace = "packages/a";
    const workspaceRoot = join(root, workspace);
    const reportPath = join(workspaceRoot, ".turbo/croco-test-evidence.json");
    const expectedPath = "src/tests/one.spec.ts";
    mkdirSync(join(workspaceRoot, ".turbo"), { recursive: true });
    mkdirSync(join(workspaceRoot, "src/tests"), { recursive: true });
    writeFileSync(join(workspaceRoot, expectedPath), "export {};\n");
    const command = {
      owner: "@croco/a",
      cwd: workspace,
      paths: [expectedPath],
      command: ["pnpm", "run", "test"],
    } as const;
    const summary = {
      tasks: [
        {
          package: "@croco/a",
          task: "test:evidence",
          hash: "task-hash",
          command:
            "pnpm run test --maxWorkers=1 --reporter=json --outputFile=.turbo/croco-test-evidence.json",
          cliArguments: [],
          execution: { exitCode: 0 },
          cache: { status: "HIT" },
        },
      ],
    } as const;
    const writeReport = (names: readonly string[]) =>
      writeFileSync(
        reportPath,
        JSON.stringify({
          testResults: names.map((name) => ({
            name,
            status: "passed",
            assertionResults: [{ status: "passed" }],
          })),
        }),
      );

    writeReport([`/relocated/worktree/${workspace}/${expectedPath}`]);
    expect(readTurboTestTaskEvidence(root, command, "@croco/a", summary)).toMatchObject({
      executedPaths: [expectedPath],
      executionState: "reused",
      cacheHash: "task-hash",
    });

    for (const invalidTask of [
      { ...summary.tasks[0], task: "test" },
      { ...summary.tasks[0], command: "pnpm run test" },
      { ...summary.tasks[0], cliArguments: ["--maxWorkers=2"] },
    ]) {
      expect(
        readTurboTestTaskEvidence(root, command, "@croco/a", { tasks: [invalidTask] }),
      ).toBeUndefined();
    }

    writeReport([`C:\\relocated\\worktree\\packages\\a\\src\\tests\\one.spec.ts`]);
    expect(readTurboTestTaskEvidence(root, command, "@croco/a", summary)).toMatchObject({
      executedPaths: [expectedPath],
      executionState: "reused",
      cacheHash: "task-hash",
    });

    writeFileSync(
      reportPath,
      JSON.stringify({
        testResults: [
          {
            name: `/relocated/worktree/${workspace}/${expectedPath}`,
            status: "passed",
            assertionResults: [
              { status: "passed" },
              { fullName: "requires Linux", status: "skipped" },
            ],
          },
        ],
      }),
    );
    expect(readTurboTestTaskEvidence(root, command, "@croco/a", summary)).toMatchObject({
      executedPaths: [],
      skippedFiles: [
        {
          path: expectedPath,
          passedAssertions: 1,
          skippedAssertions: [{ name: "requires Linux", status: "skipped" }],
          status: "partially-executed",
        },
      ],
    });

    expect(
      readTurboTestTaskEvidence(root, command, "@croco/a", {
        tasks: [{ ...summary.tasks[0], cache: { status: "MISS" } }],
      }),
    ).toBeUndefined();

    writeReport([`/relocated/worktree/packages/not-a/${expectedPath}`]);
    expect(readTurboTestTaskEvidence(root, command, "@croco/a", summary)).toBeUndefined();

    writeReport([`/relocated/worktree/${workspace}/${expectedPath}`]);
    expect(
      readTurboTestTaskEvidence(
        root,
        { ...command, paths: [expectedPath, expectedPath] },
        "@croco/a",
        summary,
      ),
    ).toBeUndefined();

    writeReport([
      `/relocated/worktree/${workspace}/${expectedPath}`,
      `/relocated/worktree/${workspace}/src/tests/unrelated.spec.ts`,
    ]);
    expect(readTurboTestTaskEvidence(root, command, "@croco/a", summary)).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps incomplete cached evidence invalid from a cold run through the next warm run", () => {
    const root = mkdtempSync(join(tmpdir(), "croco-turbo-evidence-"));
    const workspace = "packages/a";
    const reportPath = join(root, workspace, ".turbo/croco-test-evidence.json");
    mkdirSync(join(root, workspace, ".turbo"), { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify({
        testResults: [
          {
            name: join(root, workspace, "src/tests/one.spec.ts"),
            status: "passed",
            assertionResults: [{ status: "passed" }],
          },
          {
            name: join(root, workspace, "src/tests/two.spec.ts"),
            status: "passed",
            assertionResults: [{ status: "skipped" }],
          },
        ],
      }),
      { flush: true },
    );
    const command = {
      owner: "@croco/a",
      cwd: workspace,
      paths: ["src/tests/one.spec.ts", "src/tests/two.spec.ts"],
      command: ["pnpm", "run", "test"],
    } as const;

    for (const cacheStatus of ["MISS", "HIT"] as const) {
      const evidence = readTurboTestTaskEvidence(root, command, "@croco/a", {
        tasks: [
          {
            package: "@croco/a",
            task: "test:evidence",
            hash: "task-hash",
            command:
              "pnpm run test --maxWorkers=1 --reporter=json --outputFile=.turbo/croco-test-evidence.json",
            cliArguments: [],
            execution: { exitCode: 0 },
            cache: { status: cacheStatus },
          },
        ],
      });
      expect(evidence?.executedPaths).toEqual(["src/tests/one.spec.ts"]);
      expect(evidence?.skippedFiles).toEqual([
        {
          path: "src/tests/two.spec.ts",
          passedAssertions: 0,
          skippedAssertions: [{ name: "<unnamed assertion 1>", status: "skipped" }],
          status: "skipped",
        },
      ]);
      expect(evidence?.executionState).toBe(cacheStatus === "HIT" ? "reused" : "executed");
      const report = runTestLane({
        inventory: {
          version: 1,
          exceptions: [],
          tests: command.paths.map((path) => ({
            path: `${workspace}/${path}`,
            lane: "fast" as const,
            qualifiers: [],
            owner: "@croco/a",
          })),
        },
        lane: "fast",
        runner: () => ({ exitCode: 0, durationMs: 1, ...evidence }),
        scriptResolver: exactScript,
      });
      expect(report.status).toBe("failed");
      expect(report.skippedFiles).toEqual([
        expect.objectContaining({ path: "packages/a/src/tests/two.spec.ts", status: "skipped" }),
      ]);
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({ code: "TEST_LANE_EXECUTION_SKIPPED" }),
      );
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves relative Turbo summaries from the repository root", () => {
    const root = mkdtempSync(join(tmpdir(), "croco-turbo-summary-"));
    try {
      const path = join(root, ".turbo/runs/relative.json");
      mkdirSync(join(root, ".turbo/runs"), { recursive: true });
      writeFileSync(path, JSON.stringify({ tasks: [{ package: "@croco/a", task: "test" }] }));

      expect(readTurboRunSummary(root, "Summary: .turbo/runs/relative.json")).toEqual({
        tasks: [{ package: "@croco/a", task: "test" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the newest Turbo summary under the repository root", () => {
    const root = mkdtempSync(join(tmpdir(), "croco-turbo-summary-"));
    try {
      const runs = join(root, ".turbo/runs");
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(runs, "older.json"), JSON.stringify({ tasks: [{ package: "older" }] }));
      writeFileSync(join(runs, "newer.json"), JSON.stringify({ tasks: [{ package: "newer" }] }));
      const now = new Date();
      const older = new Date(now.getTime() - 10_000);
      utimesSync(join(runs, "older.json"), older, older);
      utimesSync(join(runs, "newer.json"), now, now);

      expect(readTurboRunSummary(root, "Summary: missing.json")).toEqual({
        tasks: [{ package: "newer" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records only successful exact paths and fails on any command failure", () => {
    const runner = vi
      .fn()
      .mockReturnValueOnce({
        exitCode: 0,
        durationMs: 3,
        executedPaths: ["src/tests/i.spec.ts"],
      })
      .mockReturnValueOnce({ exitCode: 1, durationMs: 5, executedPaths: [] });
    const report = runTestLane({
      inventory,
      lane: "integration",
      runner,
      scriptResolver: exactScript,
    });
    expect(report).toMatchObject({
      status: "failed",
      executedPaths: ["packages/a/src/tests/i.spec.ts"],
      diagnostics: [expect.objectContaining({ code: "TEST_LANE_EXECUTION_FAILED" })],
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("publishes command failure details without adding unvalidated command fields", () => {
    const report = runTestLane({
      inventory,
      lane: "fast",
      owners: ["repo:ci"],
      runner: () => ({
        exitCode: 1,
        durationMs: 5,
        executedPaths: ["scripts/tests/repo.spec.ts"],
        failureDetails: ["scripts/tests/repo.spec.ts > reports the failing assertion"],
      }),
      scriptResolver: exactScript,
    });

    expect(report.diagnostics).toContainEqual({
      code: "TEST_LANE_COMMAND_FAILURE_DETAIL",
      message: "repo:ci: scripts/tests/repo.spec.ts > reports the failing assertion",
    });
    expect(report.commands[0]).not.toHaveProperty("failureDetails");
  });

  it("redacts configured live resource values from lane diagnostics", () => {
    vi.stubEnv("POLAR_PRODUCT_ID", "product-secret");
    vi.stubEnv("POLAR_PRICE_IDS", "price-one,price-two");
    vi.stubEnv("POLAR_USAGE_EXTERNAL_CUSTOMER_ID", "customer-secret");
    try {
      const report = runTestLane({
        inventory: {
          version: 1,
          exceptions: [],
          tests: [
            {
              path: "packages/billing-polar/src/tests/PolarLiveSmoke.spec.ts",
              lane: "live",
              qualifiers: [],
              owner: "@croco/billing-polar",
            },
          ],
        },
        lane: "live",
        allowLive: true,
        liveCredentialsAvailable: true,
        runner: () => ({
          exitCode: 1,
          durationMs: 5,
          executedPaths: [],
          failureDetails: [
            "product-secret mapping omitted price-one and price-two for customer-secret",
          ],
        }),
        scriptResolver: exactScript,
      });
      const rendered = JSON.stringify(report);

      expect(rendered).not.toContain("product-secret");
      expect(rendered).not.toContain("price-one");
      expect(rendered).not.toContain("price-two");
      expect(rendered).not.toContain("customer-secret");
      expect(rendered).toContain("[REDACTED:POLAR_PRODUCT_ID]");
      expect(rendered).toContain("[REDACTED:POLAR_PRICE_IDS]");
      expect(rendered).toContain("[REDACTED:POLAR_USAGE_EXTERNAL_CUSTOMER_ID]");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed for live runs without explicit credential provisioning", () => {
    const runner = vi.fn((command: { readonly paths: readonly string[] }) => ({
      exitCode: 0,
      durationMs: 1,
      executedPaths: command.paths,
    }));
    expect(
      runTestLane({ inventory, lane: "live", runner, scriptResolver: exactScript }),
    ).toMatchObject({
      status: "failed",
      commands: [],
      diagnostics: [expect.objectContaining({ code: "TEST_LIVE_CREDENTIALS_MISSING" })],
    });
    expect(runner).not.toHaveBeenCalled();
    expect(
      runTestLane({
        inventory,
        lane: "live",
        allowLive: true,
        liveCredentialsAvailable: true,
        runner,
        scriptResolver: exactScript,
      }).status,
    ).toBe("passed");
  });

  it("rejects an all-skipped live command", () => {
    const report = runTestLane({
      inventory,
      lane: "live",
      allowLive: true,
      liveCredentialsAvailable: true,
      runner: () => ({ exitCode: 0, durationMs: 1, executedPaths: [] }),
      scriptResolver: exactScript,
    });
    expect(report).toMatchObject({
      status: "failed",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "TEST_LANE_EXECUTION_INCOMPLETE" }),
      ]),
    });
  });

  it.each(["fast", "integration", "published"] as const)(
    "rejects a successful %s command that skips or omits a selected path",
    (lane) => {
      const laneInventory: TestInventory = {
        version: 1,
        exceptions: [],
        tests: [
          { path: "packages/a/src/tests/one.spec.ts", lane, qualifiers: [], owner: "@croco/a" },
          { path: "packages/a/src/tests/two.spec.ts", lane, qualifiers: [], owner: "@croco/a" },
        ],
      };
      const report = runTestLane({
        inventory: laneInventory,
        lane,
        runner: () => ({
          exitCode: 0,
          durationMs: 1,
          executedPaths: ["src/tests/one.spec.ts"],
        }),
        scriptResolver: exactScript,
      });

      expect(report.status).toBe("failed");
      expect(report.executedPaths).toEqual(["packages/a/src/tests/one.spec.ts"]);
      expect(report.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "TEST_LANE_EXECUTION_INCOMPLETE" }),
        ]),
      );
    },
  );

  it("fails closed when a package lane script does not select the exact inventory paths", () => {
    const runner = vi.fn((command: { readonly paths: readonly string[] }) => ({
      exitCode: 0,
      durationMs: 1,
      executedPaths: command.paths,
    }));
    const report = runTestLane({
      inventory,
      lane: "integration",
      runner,
      scriptResolver: () => "vitest run src/tests/other.spec.ts",
    });
    expect(report).toMatchObject({
      status: "failed",
      commands: [],
    });
    expect(report.diagnostics).toHaveLength(2);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TEST_LANE_SCRIPT_DRIFT" })]),
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("allows broad fast scripts only when every owner test is fast", () => {
    const runner = vi.fn((command: { readonly paths: readonly string[] }) => ({
      exitCode: 0,
      durationMs: 1,
      executedPaths: command.paths,
    }));
    expect(
      runTestLane({
        inventory,
        lane: "fast",
        owners: ["@croco/a"],
        runner,
        scriptResolver: () => "vitest run",
      }).diagnostics,
    ).toEqual([expect.objectContaining({ code: "TEST_LANE_SCRIPT_DRIFT" })]);

    const allFastInventory: TestInventory = {
      version: 1,
      exceptions: [],
      tests: [
        { path: "packages/a/src/tests/a.spec.ts", lane: "fast", qualifiers: [], owner: "@croco/a" },
      ],
    };
    expect(
      runTestLane({
        inventory: allFastInventory,
        lane: "fast",
        runner,
        scriptResolver: () => "vitest run",
      }).status,
    ).toBe("passed");
  });

  it("fails empty owner selections instead of reporting false success", () => {
    expect(runTestLane({ inventory, lane: "published", owners: ["@croco/missing"] })).toMatchObject(
      {
        status: "failed",
        diagnostics: [expect.objectContaining({ code: "TEST_LANE_EMPTY_SELECTION" })],
      },
    );
  });

  it(
    "reuses the authoritative Turbo cache on a repeated real fast lane",
    () => {
      const root = resolve(import.meta.dirname, "../..");
      const repositoryInventory = readTestInventory(resolve(root, "test-inventory.json")).inventory;
      const first = runTestLane({
        inventory: repositoryInventory,
        lane: "fast",
        owners: ["@croco/events-core"],
        rootDir: root,
      });
      const second = runTestLane({
        inventory: repositoryInventory,
        lane: "fast",
        owners: ["@croco/events-core"],
        rootDir: root,
      });

      expect(first.status).toBe("passed");
      expect(second.commands).not.toHaveLength(0);
      expect(second.commands.every(({ cacheStatus }) => cacheStatus === "hit")).toBe(true);
      expect(second.commands.every(({ executionState }) => executionState === "reused")).toBe(true);
      expect(second.commands.every(({ cacheHash }) => Boolean(cacheHash))).toBe(true);
    },
    REAL_TURBO_TEST_TIMEOUT_MS,
  );

  it("accepts every real fast script and resolves inventory owners to workspace package filters", () => {
    const root = resolve(import.meta.dirname, "../..");
    const repositoryInventory = readTestInventory(resolve(root, "test-inventory.json")).inventory;
    const plan = createTestLanePlan(repositoryInventory, "fast");
    const report = runTestLane({
      inventory: repositoryInventory,
      lane: "fast",
      rootDir: root,
      runner: (command) => ({ exitCode: 0, durationMs: 1, executedPaths: command.paths }),
    });
    const exampleCommand = plan.find(({ owner }) => owner === "repo:examples");

    expect(report.diagnostics).toEqual([]);
    expect(exampleCommand).toBeDefined();
    expect(resolveTurboPackageFilters(root, exampleCommand ? [exampleCommand] : [])).toEqual([
      "@croco-example/saas-billing-golden-path",
    ]);
  });
});
