#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inventoryDigest,
  isSelectedByVitestScript,
  readTestInventory,
  TEST_LANES,
} from "./test-inventory.mts";
import type { TestInventory, TestInventoryEntry, TestLane } from "./test-inventory.mts";

export type TestLaneCommand = {
  readonly owner: string;
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly command: readonly string[];
};

export type TestLaneCommandResult = TestLaneCommand & {
  readonly durationMs: number;
  readonly exitCode: number;
  readonly status: "passed" | "failed";
  readonly cacheStatus?: "hit" | "miss";
  readonly executedPaths: readonly string[];
  readonly skippedFiles: readonly TestLaneSkippedFile[];
  readonly executionState?: "executed" | "reused";
  readonly cacheHash?: string;
};

export type TestLaneSkippedFile = {
  readonly path: string;
  readonly status: "partially-executed" | "skipped" | "failed-with-skips";
  readonly passedAssertions: number;
  readonly skippedAssertions: readonly TestLaneSkippedAssertion[];
};

export type TestLaneSkippedAssertion = {
  readonly name: string;
  readonly status: "skipped" | "todo" | "pending" | "disabled";
};

export type TestLaneReport = {
  readonly schemaVersion: "croco.test-lane-report/v2";
  readonly inventoryVersion: 1;
  readonly inventoryDigest: string;
  readonly lane: Exclude<TestLane, "generated-app">;
  readonly allowLive: boolean;
  readonly selectedOwners: readonly string[];
  readonly executedPaths: readonly string[];
  readonly skippedFiles: readonly TestLaneSkippedFile[];
  readonly status: "passed" | "failed";
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
  readonly commands: readonly TestLaneCommandResult[];
};

export type TestLaneCommandRunner = (command: TestLaneCommand) => {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly totalTests?: number;
  readonly skippedTests?: number;
  readonly cacheStatus?: "hit" | "miss";
  readonly executedPaths?: readonly string[];
  readonly skippedFiles?: readonly TestLaneSkippedFile[];
  readonly executionState?: "executed" | "reused";
  readonly cacheHash?: string;
  readonly failureDetails?: readonly string[];
};

export type TestLaneScriptResolver = (
  command: TestLaneCommand,
  lane: TestLaneReport["lane"],
) => string | undefined;

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST_EVIDENCE_FILE = ".turbo/croco-test-evidence.json";
const MAX_FAST_PACKAGE_PROCESSES = 4;
export const DEFAULT_MAX_ROOT_VITEST_WORKERS = 2;
export const MAX_ROOT_VITEST_WORKERS = DEFAULT_MAX_ROOT_VITEST_WORKERS;

export function resolveMaxRootVitestWorkers(
  env: NodeJS.ProcessEnv = process.env,
  parallelism: number = typeof availableParallelism === "function" ? availableParallelism() : 2,
): number {
  const configured = env.MAX_ROOT_VITEST_WORKERS ?? env.CROCO_TEST_WORKERS;
  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return Math.max(1, Math.min(DEFAULT_MAX_ROOT_VITEST_WORKERS, parallelism));
}
const MAX_FAILURE_DETAILS = 8;
const MAX_FAILURE_DETAIL_LENGTH = 2_000;
const MAX_LIVE_TEST_OUTPUT_BYTES = 10 * 1024 * 1024;
export const SKIPPED_ASSERTION_STATUSES = ["skipped", "todo", "pending", "disabled"] as const;

type LiveResourceRequirements = Readonly<Record<string, readonly string[]>>;

export function redactLiveResourceValues(
  text: string,
  resourceNames: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const replacements = resourceNames
    .flatMap((name) => {
      const value = environment[name];
      if (!value) return [];
      return [
        ...new Set([
          value,
          ...value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
        ]),
      ].map((candidate) => ({ candidate, replacement: `[REDACTED:${name}]` }));
    })
    .sort((left, right) => right.candidate.length - left.candidate.length);

  return replacements.reduce(
    (redacted, { candidate, replacement }) => redacted.split(candidate).join(replacement),
    text,
  );
}
export function createFastPackageTurboArguments(
  rootDir: string,
  packageCommands: readonly TestLaneCommand[],
): string[] {
  const concurrency = Math.max(1, Math.min(MAX_FAST_PACKAGE_PROCESSES, availableParallelism()));

  // Do not pass --only: the test task declares build + ^build in turbo.json, and
  // skipping those leaves dependency dist/ absent on a cold Turbo cache, which
  // breaks workspace package resolution in every test that imports a built entry.
  return [
    "turbo",
    "run",
    "test:evidence",
    `--concurrency=${concurrency}`,
    ...resolveTurboPackageFilters(rootDir, packageCommands).map(
      (packageName) => `--filter=${packageName}`,
    ),
    "--summarize",
    "--continue=always",
  ];
}

type VitestJsonReport = {
  readonly testResults?: readonly {
    readonly name?: string;
    readonly status?: string;
    readonly message?: string;
    readonly assertionResults?: readonly {
      readonly status?: string;
      readonly title?: string;
      readonly fullName?: string;
      readonly failureMessages?: readonly string[];
    }[];
  }[];
};

type PlaywrightJsonSuite = {
  readonly suites?: readonly PlaywrightJsonSuite[];
  readonly specs?: readonly {
    readonly file?: string;
    readonly tests?: readonly {
      readonly results?: readonly { readonly status?: string }[];
    }[];
  }[];
};

export type TurboRunSummary = {
  readonly tasks?: readonly {
    readonly package?: string;
    readonly task?: string;
    readonly hash?: string;
    readonly cliArguments?: readonly string[];
    readonly command?: string;
    readonly execution?: { readonly exitCode?: number };
    readonly cache?: { readonly status?: string };
  }[];
};

function relativeExistingPath(workspaceRoot: string, absolutePath: string): string | undefined {
  const workspace = statSync(workspaceRoot);
  const segments: string[] = [];
  let current = absolutePath;
  while (true) {
    const candidate = statSync(current);
    if (candidate.dev === workspace.dev && candidate.ino === workspace.ino) {
      return segments.reverse().join("/");
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    segments.push(basename(current));
    current = parent;
  }
}

function isPortableAbsolutePath(path: string): boolean {
  return (
    isAbsolute(path) ||
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.startsWith("\\\\")
  );
}

function localVitestPath(name: string, workspaceRoot: string): string | undefined {
  const absoluteName = isAbsolute(name)
    ? name
    : isPortableAbsolutePath(name)
      ? undefined
      : resolve(workspaceRoot, name);
  if (!absoluteName) return undefined;
  if (absoluteName === workspaceRoot || absoluteName.startsWith(`${workspaceRoot}${sep}`)) {
    return relative(workspaceRoot, absoluteName).split(sep).join("/");
  }
  return existsSync(absoluteName) ? relativeExistingPath(workspaceRoot, absoluteName) : undefined;
}

export function readCompletedVitestPaths(
  reportPath: string,
  workspaceRoot: string,
): readonly string[] {
  return readVitestExecutionEvidence(reportPath, workspaceRoot).executedPaths;
}

function skippedVitestFile(
  status: string | undefined,
  assertionResults: NonNullable<VitestJsonReport["testResults"]>[number]["assertionResults"],
  path: string,
): TestLaneSkippedFile | undefined {
  if (!assertionResults?.length) return undefined;
  const passedAssertions = assertionResults.filter(
    (assertion) => assertion.status === "passed",
  ).length;
  const skippedAssertions = assertionResults.flatMap((assertion, index) => {
    const assertionStatus = SKIPPED_ASSERTION_STATUSES.find(
      (candidate) => candidate === assertion.status,
    );
    return assertionStatus
      ? [
          {
            name: assertion.fullName ?? assertion.title ?? `<unnamed assertion ${index + 1}>`,
            status: assertionStatus,
          },
        ]
      : [];
  });
  if (skippedAssertions.length === 0) return undefined;
  return {
    path,
    status:
      status === "failed"
        ? "failed-with-skips"
        : passedAssertions > 0
          ? "partially-executed"
          : "skipped",
    passedAssertions,
    skippedAssertions,
  };
}

export function readVitestExecutionEvidence(
  reportPath: string,
  workspaceRoot: string,
): {
  readonly executedPaths: readonly string[];
  readonly skippedFiles: readonly TestLaneSkippedFile[];
} {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJsonReport;
  return (
    collectVitestEvidence(report, (name) => localVitestPath(name, workspaceRoot), "ignore") ?? {
      executedPaths: [],
      skippedFiles: [],
    }
  );
}

function collectVitestEvidence(
  report: VitestJsonReport,
  resolvePath: (name: string) => string | undefined,
  unresolvedPathPolicy: "ignore" | "reject",
):
  | {
      readonly executedPaths: readonly string[];
      readonly skippedFiles: readonly TestLaneSkippedFile[];
    }
  | undefined {
  const executedPaths: string[] = [];
  const skippedFiles: TestLaneSkippedFile[] = [];
  for (const { name, status, assertionResults } of report.testResults ?? []) {
    if (!assertionResults?.length || !name) continue;
    const path = resolvePath(name);
    if (!path) {
      if (unresolvedPathPolicy === "reject") return undefined;
      continue;
    }
    if (
      status === "passed" &&
      assertionResults.every((assertion) => assertion.status === "passed")
    ) {
      executedPaths.push(path);
      continue;
    }
    const skippedFile = skippedVitestFile(status, assertionResults, path);
    if (skippedFile) skippedFiles.push(skippedFile);
  }
  return {
    executedPaths: [...new Set(executedPaths)].sort(compareText),
    skippedFiles: skippedFiles.sort((left, right) => compareText(left.path, right.path)),
  };
}

function portableTurboVitestPath(
  name: string,
  workspaceRoot: string,
  normalizedWorkspacePath: string,
  expectedPaths: readonly string[],
  allowRelocation: boolean,
): string | undefined {
  const localPath = localVitestPath(name, workspaceRoot);
  if (localPath) return localPath;
  if (!allowRelocation) return undefined;

  const normalizedName = name.replaceAll("\\", "/");
  const matches = expectedPaths.filter((expectedPath) => {
    const normalizedExpected = expectedPath.replaceAll("\\", "/");
    const expectedSuffix =
      normalizedWorkspacePath === "" || normalizedWorkspacePath === "."
        ? normalizedExpected
        : `${normalizedWorkspacePath}/${normalizedExpected}`;
    const currentPath = resolve(workspaceRoot, expectedPath);
    const insideWorkspace =
      currentPath !== workspaceRoot && currentPath.startsWith(`${workspaceRoot}${sep}`);
    return (
      insideWorkspace &&
      existsSync(currentPath) &&
      (normalizedName === expectedSuffix || normalizedName.endsWith(`/${expectedSuffix}`))
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function readPortableTurboVitestEvidence(
  reportPath: string,
  workspaceRoot: string,
  workspacePath: string,
  expectedPaths: readonly string[],
  allowRelocation: boolean,
):
  | {
      readonly executedPaths: readonly string[];
      readonly skippedFiles: readonly TestLaneSkippedFile[];
    }
  | undefined {
  const normalizedWorkspacePath = workspacePath
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/$/u, "");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJsonReport;
  return collectVitestEvidence(
    report,
    (name) =>
      portableTurboVitestPath(
        name,
        workspaceRoot,
        normalizedWorkspacePath,
        expectedPaths,
        allowRelocation,
      ),
    "reject",
  );
}

export function readVitestFailureDetails(
  reportPath: string,
  workspaceRoot: string,
): readonly string[] {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJsonReport;
  return (report.testResults ?? [])
    .flatMap(({ name, status, message, assertionResults }) => {
      if (status !== "failed") return [];
      const absoluteName = name
        ? isAbsolute(name)
          ? name
          : resolve(workspaceRoot, name)
        : undefined;
      const file =
        absoluteName &&
        (absoluteName === workspaceRoot || absoluteName.startsWith(`${workspaceRoot}${sep}`))
          ? relative(workspaceRoot, absoluteName).split(sep).join("/")
          : (name ?? "<unknown test file>");
      const failedAssertions = (assertionResults ?? []).filter(
        (assertion) => assertion.status === "failed",
      );
      const details =
        failedAssertions.length > 0
          ? failedAssertions
          : [{ fullName: undefined, title: undefined, failureMessages: [message] }];
      return details.map((assertion) => {
        const title = assertion.fullName ?? assertion.title;
        const failures = (assertion.failureMessages ?? []).filter(
          (failure): failure is string => typeof failure === "string" && failure.length > 0,
        );
        return `${file}${title ? ` > ${title}` : ""}${failures.length > 0 ? `\n${failures.join("\n")}` : ""}`.slice(
          0,
          MAX_FAILURE_DETAIL_LENGTH,
        );
      });
    })
    .slice(0, MAX_FAILURE_DETAILS);
}

export function readCompletedPlaywrightPaths(
  reportPath: string,
  workspaceRoot: string,
  expectedPaths: readonly string[] = [],
): readonly string[] {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as PlaywrightJsonSuite;
  const visit = (suite: PlaywrightJsonSuite): readonly string[] => [
    ...(suite.specs ?? []).flatMap(({ file, tests }) =>
      file &&
      Boolean(tests?.length) &&
      tests?.every(
        ({ results }) =>
          Boolean(results?.length) && results?.every(({ status }) => status === "passed"),
      )
        ? [
            relative(workspaceRoot, isAbsolute(file) ? file : resolve(workspaceRoot, file))
              .split(sep)
              .join("/"),
          ]
        : [],
    ),
    ...(suite.suites ?? []).flatMap(visit),
  ];
  return [
    ...new Set(
      visit(report).flatMap((observedPath) => {
        if (expectedPaths.length === 0 || expectedPaths.includes(observedPath)) {
          return [observedPath];
        }
        const matches = expectedPaths.filter((expectedPath) =>
          expectedPath.endsWith(`/${observedPath}`),
        );
        return matches.length === 1 ? matches : [];
      }),
    ),
  ].sort(compareText);
}

function evidencePath(rootDir: string, command: TestLaneCommand): string {
  return resolve(rootDir, command.cwd, VITEST_EVIDENCE_FILE);
}

function runVitestCommandWithEvidence(
  rootDir: string,
  command: TestLaneCommand,
): {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly executedPaths: readonly string[];
  readonly skippedFiles: readonly TestLaneSkippedFile[];
  readonly executionState: "executed";
  readonly failureDetails: readonly string[];
} {
  const reportPath = evidencePath(rootDir, command);
  rmSync(reportPath, { force: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  const startedAt = Date.now();
  const maxWorkers = resolveMaxRootVitestWorkers();
  const result = spawnSync(
    command.command[0],
    [
      ...command.command.slice(1),
      `--maxWorkers=${maxWorkers}`,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    { cwd: resolve(rootDir, command.cwd), env: process.env, stdio: "inherit" },
  );
  const evidence = existsSync(reportPath)
    ? readVitestExecutionEvidence(reportPath, resolve(rootDir, command.cwd))
    : { executedPaths: [], skippedFiles: [] };
  const failureDetails =
    result.status !== 0 && existsSync(reportPath)
      ? readVitestFailureDetails(reportPath, resolve(rootDir, command.cwd))
      : [];
  rmSync(reportPath, { force: true });
  return {
    exitCode: result.status ?? 1,
    durationMs: Date.now() - startedAt,
    ...evidence,
    executionState: "executed" as const,
    failureDetails,
  };
}

export function readTurboRunSummary(rootDir: string, output: string): TurboRunSummary | undefined {
  const summaryPath = /Summary:\s+([^\r\n]+\.json)/.exec(output)?.[1]?.trim();
  const resolvedSummaryPath = summaryPath ? resolve(rootDir, summaryPath) : undefined;
  if (resolvedSummaryPath && existsSync(resolvedSummaryPath)) {
    return JSON.parse(readFileSync(resolvedSummaryPath, "utf8")) as TurboRunSummary;
  }

  const runsDirectory = resolve(rootDir, ".turbo/runs");
  if (!existsSync(runsDirectory)) return undefined;
  const newest = readdirSync(runsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const path = resolve(runsDirectory, entry.name);
      return { path, modifiedAt: statSync(path).mtimeMs };
    })
    .sort(
      (left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path),
    )[0];
  return newest ? (JSON.parse(readFileSync(newest.path, "utf8")) as TurboRunSummary) : undefined;
}

/**
 * True when a turbo run failed at least one package BUILD task. build tasks can
 * fail transiently under resource contention (tsup's declaration worker misses
 * a dependency dist that is mid-rebuild), unlike hard test failures, so the
 * fast lane retries once only in that case.
 */
export function hasFailedBuildTask(summary: TurboRunSummary | undefined): boolean {
  if (!summary?.tasks) return false;
  return summary.tasks.some(
    (task) => task.task === "build" && (task.execution?.exitCode ?? 0) !== 0,
  );
}

export function readTurboTestTaskEvidence(
  rootDir: string,
  command: TestLaneCommand,
  packageName: string,
  summary: TurboRunSummary | undefined,
):
  | {
      readonly executedPaths: readonly string[];
      readonly skippedFiles: readonly TestLaneSkippedFile[];
      readonly executionState: "executed" | "reused";
      readonly cacheHash: string;
    }
  | undefined {
  const task = summary?.tasks?.find(
    (candidate) => candidate.package === packageName && candidate.task === "test:evidence",
  );
  const reportPath = evidencePath(rootDir, command);
  if (
    task?.execution?.exitCode !== 0 ||
    typeof task.hash !== "string" ||
    task.hash.length === 0 ||
    task.command !==
      `pnpm run test --maxWorkers=1 --reporter=json --outputFile=${VITEST_EVIDENCE_FILE}` ||
    task.cliArguments?.length !== 0 ||
    !existsSync(reportPath)
  ) {
    return undefined;
  }
  const evidence = readPortableTurboVitestEvidence(
    reportPath,
    resolve(rootDir, command.cwd),
    command.cwd,
    command.paths,
    task.cache?.status === "HIT",
  );
  if (!evidence) return undefined;
  return {
    ...evidence,
    executionState: task.cache?.status === "HIT" ? "reused" : "executed",
    cacheHash: task.hash,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function workspaceDirectory(path: string): string {
  if (path.startsWith("scripts/tests/") || path.startsWith("tests/")) return ".";
  const match = /^(packages|apps|examples)\/([^/]+)\//.exec(path);
  if (!match?.[1] || !match[2]) throw new Error(`Cannot resolve workspace for ${path}`);
  return `${match[1]}/${match[2]}`;
}

function toWorkspacePath(workspace: string, path: string): string {
  if (workspace === ".") return path;
  const prefix = `${workspace}/`;
  if (!path.startsWith(prefix)) throw new Error(`${path} is outside ${workspace}`);
  return path.slice(prefix.length);
}

export function createTestLanePlan(
  inventory: TestInventory,
  lane: Exclude<TestLane, "generated-app">,
  owners: readonly string[] = [],
): readonly TestLaneCommand[] {
  const selectedOwners = new Set(owners);
  const entries = inventory.tests.filter(
    (entry) =>
      entry.lane === lane && (selectedOwners.size === 0 || selectedOwners.has(entry.owner)),
  );
  const grouped = new Map<string, TestInventoryEntry[]>();
  for (const entry of entries) {
    const workspace = workspaceDirectory(entry.path);
    const key = `${workspace}\u0000${entry.owner}`;
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, group]) => {
      const [workspace = ".", owner = ""] = key.split("\u0000");
      const paths = group.map(({ path }) => toWorkspacePath(workspace, path)).sort(compareText);
      return {
        owner,
        cwd: workspace,
        paths,
        command:
          workspace === "."
            ? ["pnpm", "exec", "vitest", "run", ...paths]
            : ["pnpm", "run", lane === "fast" ? "test" : `test:${lane}`],
      };
    });
}

function defaultRunner(
  rootDir: string,
  lane: TestLaneReport["lane"],
  plan: readonly TestLaneCommand[],
  resolveScript: TestLaneScriptResolver,
  liveResourceRequirements: LiveResourceRequirements,
): TestLaneCommandRunner {
  if (lane === "fast") {
    let packageResult:
      | {
          readonly exitCode: number;
          readonly durationMs: number;
          readonly cacheStatus?: "hit" | "miss";
        }
      | undefined;
    const packageEvidence = new Map<
      string,
      {
        readonly executedPaths: readonly string[];
        readonly skippedFiles: readonly TestLaneSkippedFile[];
        readonly executionState: "executed" | "reused";
        readonly cacheHash?: string;
      }
    >();
    const rootResults = new Map<
      string,
      {
        readonly exitCode: number;
        readonly durationMs: number;
        readonly executedPaths: readonly string[];
        readonly skippedFiles: readonly TestLaneSkippedFile[];
        readonly failureDetails: readonly string[];
      }
    >();
    return (command) => {
      if (!packageResult) {
        const packageCommands = plan.filter(({ cwd }) => cwd !== ".");
        for (const packageCommand of packageCommands) {
          rmSync(evidencePath(rootDir, packageCommand), { force: true });
        }
        const startedAt = Date.now();
        if (packageCommands.length === 0) {
          packageResult = { exitCode: 0, durationMs: 0 };
        } else {
          const runTurbo = () => {
            const result = spawnSync(
              "pnpm",
              createFastPackageTurboArguments(rootDir, packageCommands),
              { cwd: rootDir, env: process.env, encoding: "utf8" },
            );
            process.stdout.write(result.stdout ?? "");
            process.stderr.write(result.stderr ?? "");
            return { result, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
          };

          const first = runTurbo();
          let latest = first;
          const firstSummary = readTurboRunSummary(rootDir, first.output);
          if ((first.result.status ?? 1) !== 0 && hasFailedBuildTask(firstSummary)) {
            // Retry once: a build task can fail transiently when tsup's
            // declaration worker resolves a dependency dist that a concurrent
            // --clean rebuild left without its .d.ts yet. The second run
            // replays the completed dependency dist atomically from the turbo
            // cache, so the retry converges without masking real test failures.
            latest = runTurbo();
          }
          const cache = /Cached:\s+(\d+) cached,\s+(\d+) total/.exec(latest.result.stdout ?? "");
          packageResult = {
            exitCode: latest.result.status ?? 1,
            durationMs: Date.now() - startedAt,
            cacheStatus: cache && cache[1] === cache[2] ? "hit" : "miss",
          };
          const summary = readTurboRunSummary(rootDir, latest.output);
          for (const packageCommand of packageCommands) {
            const packageName = resolveTurboPackageFilters(rootDir, [packageCommand])[0];
            const evidence = readTurboTestTaskEvidence(
              rootDir,
              packageCommand,
              packageName ?? "",
              summary,
            );
            if (evidence) packageEvidence.set(packageCommand.cwd, evidence);
          }
        }
        for (const rootCommand of plan.filter(({ cwd }) => cwd === ".")) {
          rootResults.set(rootCommand.owner, runVitestCommandWithEvidence(rootDir, rootCommand));
        }
      }
      return command.cwd === "."
        ? (rootResults.get(command.owner) ?? packageResult)
        : {
            ...packageResult,
            ...(packageEvidence.get(command.cwd) ?? { executedPaths: [], skippedFiles: [] }),
          };
    };
  }
  return (command) => {
    const reportDirectory = mkdtempSync(resolve(tmpdir(), "croco-test-lane-"));
    try {
      const reportPath = resolve(reportDirectory, "vitest.json");
      const playwright = resolveScript(command, lane)?.includes("playwright test") ?? false;
      const startedAt = Date.now();
      const args = [
        ...command.command.slice(1),
        "--reporter=json",
        ...(playwright ? [] : [`--outputFile=${reportPath}`]),
      ];
      const environment = playwright
        ? { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath }
        : process.env;
      const result =
        lane === "live"
          ? spawnSync(command.command[0], args, {
              cwd: resolve(rootDir, command.cwd),
              env: environment,
              encoding: "utf8",
              maxBuffer: MAX_LIVE_TEST_OUTPUT_BYTES,
            })
          : spawnSync(command.command[0], args, {
              cwd: resolve(rootDir, command.cwd),
              env: environment,
              stdio: "inherit",
            });
      if (lane === "live") {
        const resourceNames = liveResourceRequirements[command.owner] ?? [];
        process.stdout.write(
          redactLiveResourceValues(
            typeof result.stdout === "string" ? result.stdout : "",
            resourceNames,
          ),
        );
        process.stderr.write(
          redactLiveResourceValues(
            typeof result.stderr === "string" ? result.stderr : "",
            resourceNames,
          ),
        );
      }
      const evidence = existsSync(reportPath)
        ? playwright
          ? {
              executedPaths: readCompletedPlaywrightPaths(
                reportPath,
                resolve(rootDir, command.cwd),
                command.paths,
              ),
              skippedFiles: [],
            }
          : readVitestExecutionEvidence(reportPath, resolve(rootDir, command.cwd))
        : { executedPaths: [], skippedFiles: [] };
      return {
        exitCode: result.status ?? 1,
        durationMs: Date.now() - startedAt,
        ...evidence,
        executionState: "executed" as const,
      };
    } finally {
      rmSync(reportDirectory, { recursive: true, force: true });
    }
  };
}

function defaultScriptResolver(rootDir: string): TestLaneScriptResolver {
  return (command, lane) => {
    if (command.cwd === ".") return undefined;
    const manifest = JSON.parse(
      readFileSync(resolve(rootDir, command.cwd, "package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    return manifest.scripts?.[lane === "fast" ? "test" : `test:${lane}`];
  };
}

function expectedLaneSelections(command: TestLaneCommand): readonly string[] {
  const paths = command.paths.join(" ");
  return [`vitest run ${paths}`, `playwright test ${paths}`];
}

export function resolveTurboPackageFilters(
  rootDir: string,
  commands: readonly TestLaneCommand[],
): readonly string[] {
  return [
    ...new Set(
      commands
        .filter(({ cwd }) => cwd !== ".")
        .map(({ cwd }) => {
          const manifest = JSON.parse(
            readFileSync(resolve(rootDir, cwd, "package.json"), "utf8"),
          ) as { readonly name?: string };
          if (!manifest.name) throw new Error(`${cwd}/package.json has no package name`);
          return manifest.name;
        }),
    ),
  ].sort(compareText);
}

function validateLaneScript(
  command: TestLaneCommand,
  lane: TestLaneReport["lane"],
  resolveScript: TestLaneScriptResolver,
  workspaceTestPaths: readonly string[],
): string | undefined {
  if (command.cwd === ".") return undefined;
  const script = resolveScript(command, lane)?.trim();
  if (!script)
    return `${command.cwd}/package.json has no ${lane === "fast" ? "test" : `test:${lane}`} script`;
  const commandWithoutEnvironment = script.replace(/^(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*/, "");
  const selectedFastPaths =
    lane === "fast"
      ? workspaceTestPaths
          .filter((path) => isSelectedByVitestScript(script, path))
          .sort(compareText)
      : [];
  if (
    expectedLaneSelections(command).includes(commandWithoutEnvironment) ||
    (lane === "fast" && JSON.stringify(selectedFastPaths) === JSON.stringify(command.paths))
  ) {
    return undefined;
  }
  const scriptName = lane === "fast" ? "test" : `test:${lane}`;
  return `${command.cwd}/package.json ${scriptName} must select exactly: ${command.paths.join(", ")}`;
}

export function runTestLane(options: {
  readonly inventory: TestInventory;
  readonly lane: Exclude<TestLane, "generated-app">;
  readonly owners?: readonly string[];
  readonly allowLive?: boolean;
  readonly runner?: TestLaneCommandRunner;
  readonly scriptResolver?: TestLaneScriptResolver;
  readonly rootDir?: string;
  readonly liveCredentialsAvailable?: boolean;
}): TestLaneReport {
  const owners = [...new Set(options.owners ?? [])].sort(compareText);
  const plan = createTestLanePlan(options.inventory, options.lane, owners);
  const diagnostics: { code: string; message: string }[] = [];
  if (options.lane === "live" && !options.allowLive) {
    diagnostics.push({
      code: "TEST_LIVE_CREDENTIALS_MISSING",
      message:
        "The live lane requires explicit --allow-live after credentials/resources are provisioned.",
    });
  }
  if (plan.length === 0) {
    diagnostics.push({
      code: "TEST_LANE_EMPTY_SELECTION",
      message: `No ${options.lane} tests match owners: ${owners.join(", ") || "<all>"}.`,
    });
  }
  const rootDir = options.rootDir ?? ROOT_DIR;
  const liveResourceRequirements: LiveResourceRequirements =
    options.lane === "live"
      ? (JSON.parse(
          readFileSync(resolve(rootDir, "config/live-test-resources.json"), "utf8"),
        ) as LiveResourceRequirements)
      : {};
  if (options.lane === "live" && options.allowLive && options.liveCredentialsAvailable !== true) {
    const missing = plan.flatMap(({ owner }) =>
      liveResourceRequirements[owner] === undefined
        ? [`${owner}:<undeclared>`]
        : liveResourceRequirements[owner]
            .filter((name) => !process.env[name])
            .map((name) => `${owner}:${name}`),
    );
    if (missing.length > 0) {
      diagnostics.push({
        code: "TEST_LIVE_CREDENTIALS_MISSING",
        message: `Required live credentials/resources are unavailable: ${[...new Set(missing)].sort().join(", ")}.`,
      });
    }
  }
  const resolveScript = options.scriptResolver ?? defaultScriptResolver(rootDir);
  for (const command of plan) {
    const workspaceTestPaths = options.inventory.tests
      .filter(
        ({ lane, path }) => lane !== "generated-app" && workspaceDirectory(path) === command.cwd,
      )
      .map(({ path }) => toWorkspacePath(command.cwd, path));
    const error = validateLaneScript(command, options.lane, resolveScript, workspaceTestPaths);
    if (error) {
      diagnostics.push({ code: "TEST_LANE_SCRIPT_DRIFT", message: error });
    }
  }
  const runner =
    options.runner ??
    defaultRunner(rootDir, options.lane, plan, resolveScript, liveResourceRequirements);
  const commandFailureDetails: { readonly owner: string; readonly details: readonly string[] }[] =
    [];
  const commands =
    diagnostics.length > 0
      ? []
      : plan.map((command): TestLaneCommandResult => {
          const { failureDetails = [], ...result } = runner(command);
          if (failureDetails.length > 0) {
            commandFailureDetails.push({
              owner: command.owner,
              details:
                options.lane === "live"
                  ? failureDetails.map((detail) =>
                      redactLiveResourceValues(
                        detail,
                        liveResourceRequirements[command.owner] ?? [],
                      ),
                    )
                  : failureDetails,
            });
          }
          const executedPaths = [...new Set(result.executedPaths ?? [])].sort(compareText);
          const skippedFiles = [...(result.skippedFiles ?? [])].sort((left, right) =>
            compareText(left.path, right.path),
          );
          const complete =
            skippedFiles.length === 0 &&
            JSON.stringify(executedPaths) === JSON.stringify(command.paths);
          return {
            ...command,
            ...result,
            executedPaths,
            skippedFiles,
            status: result.exitCode === 0 && complete ? "passed" : "failed",
          };
        });
  if (commands.some(({ status }) => status === "failed")) {
    diagnostics.push({
      code: "TEST_LANE_EXECUTION_FAILED",
      message: `At least one ${options.lane} lane command failed.`,
    });
  }
  for (const { owner, details } of commandFailureDetails) {
    diagnostics.push({
      code: "TEST_LANE_COMMAND_FAILURE_DETAIL",
      message: `${owner}: ${details.join("\n\n")}`,
    });
  }
  if (commands.some(({ status, exitCode }) => exitCode === 0 && status === "failed")) {
    diagnostics.push({
      code: "TEST_LANE_EXECUTION_INCOMPLETE",
      message: `At least one ${options.lane} lane command did not complete every selected test path without skips.`,
    });
  }
  for (const command of commands) {
    if (command.skippedFiles.length === 0) continue;
    diagnostics.push({
      code: "TEST_LANE_EXECUTION_SKIPPED",
      message: `${command.owner}: ${command.skippedFiles
        .map(
          ({ path, status, skippedAssertions }) =>
            `${path} (${status}; skipped: ${skippedAssertions
              .map((assertion) => `${assertion.name} [${assertion.status}]`)
              .join(", ")})`,
        )
        .join("; ")}`,
    });
  }
  return {
    schemaVersion: "croco.test-lane-report/v2",
    inventoryVersion: 1,
    inventoryDigest: inventoryDigest(options.inventory),
    lane: options.lane,
    allowLive: options.allowLive ?? false,
    selectedOwners: owners,
    executedPaths: commands
      .flatMap(({ cwd, executedPaths }) =>
        executedPaths.map((path) => (cwd === "." ? path : `${cwd}/${path}`)),
      )
      .sort(compareText),
    skippedFiles: commands
      .flatMap(({ cwd, skippedFiles }) =>
        skippedFiles.map((file) => ({
          ...file,
          path: cwd === "." ? file.path : `${cwd}/${file.path}`,
        })),
      )
      .sort((left, right) => compareText(left.path, right.path)),
    status: diagnostics.length === 0 ? "passed" : "failed",
    diagnostics,
    commands,
  };
}

function parseArguments(args: readonly string[]): {
  readonly lane: Exclude<TestLane, "generated-app">;
  readonly owners: readonly string[];
  readonly allowLive: boolean;
  readonly list: boolean;
  readonly output?: string;
} {
  let lane: Exclude<TestLane, "generated-app"> | undefined;
  const owners: string[] = [];
  let allowLive = false;
  let list = false;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--lane") {
      const value = args[index + 1];
      if (!value || !TEST_LANES.includes(value as TestLane) || value === "generated-app") {
        throw new Error("--lane requires fast, integration, published, or live");
      }
      lane = value as Exclude<TestLane, "generated-app">;
      index += 1;
    } else if (argument === "--owner") {
      const owner = args[index + 1];
      if (!owner) throw new Error("--owner requires a value");
      owners.push(owner);
      index += 1;
    } else if (argument === "--allow-live") {
      allowLive = true;
    } else if (argument === "--list") {
      list = true;
    } else if (argument === "--output") {
      output = args[index + 1];
      if (!output) throw new Error("--output requires a path");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!lane) throw new Error("--lane is required");
  return { lane, owners, allowLive, list, ...(output ? { output } : {}) };
}

export function runTestLaneCli(args: readonly string[], rootDir = ROOT_DIR): number {
  const options = parseArguments(args);
  const { inventory, diagnostics } = readTestInventory(resolve(rootDir, "test-inventory.json"));
  if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics));
  const report = options.list
    ? {
        schemaVersion: "croco.test-lane-plan/v1",
        inventoryVersion: 1,
        inventoryDigest: inventoryDigest(inventory),
        lane: options.lane,
        commands: createTestLanePlan(inventory, options.lane, options.owners),
      }
    : runTestLane({
        inventory,
        lane: options.lane,
        owners: options.owners,
        allowLive: options.allowLive,
        rootDir,
      });
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputPath = resolve(rootDir, options.output);
    const relation = relative(resolve(rootDir), outputPath);
    if (relation === ".." || relation.startsWith(`..${sep}`)) {
      throw new Error("--output must remain inside the repository");
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, rendered);
  } else {
    process.stdout.write(rendered);
  }
  return "status" in report && report.status === "failed" ? 1 : 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runTestLaneCli(process.argv.slice(2));
}
