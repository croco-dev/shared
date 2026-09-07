#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";

import { createVerificationManifest } from "./verification-manifest.mts";
import { PUBLISH_REQUIRED_GENERATED_SMOKE_CASES } from "./verification-manifest.mts";
import type { EvidenceCommand } from "./release-spine-evidence.mts";

const TARGET_MINUTES = 45;
const MAX_CONCURRENCY = 2;
const MILLISECONDS_PER_MINUTE = 60_000;

const observedDurationMinutes: Readonly<Record<string, number>> = {
  "architecture-policy-runtime": 0.4,
  "architecture-circular-allowlist": 0.3,
  "strict-contract-typecheck": 2.4,
  "dependency-audit-policy": 0.6,
  "package-entrypoints-smoke": 6,
  "packed-decorator-consumers": 0.5,
  "package-bins-smoke": 0.4,
  "quick-start-lambda-smoke": 2.1,
  typecheck: 4.8,
  test: 5.5,
  "integration-test-lane": 4.2,
  "published-test-lane": 1,
  "cli-packed-e2e": 2.2,
  "core-coverage": 3.1,
  "publish-dry-run": 0.1,
  build: 7.4,
};

type CriticalPathEvaluation = {
  readonly status: "passed" | "failed";
  readonly targetMinutes: number;
  readonly verificationMinutes: number;
  readonly advisoryMinutes: number;
  readonly requiredMinutes: number;
  readonly diagnostics: readonly string[];
};

function durationMinutes(command: EvidenceCommand): number {
  if (command.id === "generated-app-smoke") {
    if (command.command.includes("--full-matrix")) return 23.5;
    if (PUBLISH_REQUIRED_GENERATED_SMOKE_CASES.every((name) => command.command.includes(name))) {
      return 14;
    }
    return 10;
  }
  if (command.id === "release-gate-tests") {
    return command.command.includes("scripts/test-lane-evidence-check.mts") ? 0.1 : 4.4;
  }
  if (command.id === "cli-packed-e2e") {
    return command.command.includes("scripts/test-lane-evidence-check.mts") ? 0.1 : 2.2;
  }
  return observedDurationMinutes[command.id] ?? 0.2;
}

export function calculateVerificationCriticalPath(
  commands: readonly EvidenceCommand[],
  durationOverrides: Readonly<Record<string, number>> = {},
): number {
  const applicable = commands.filter((command) => command.applicable !== false);
  const completed = new Map(
    commands
      .filter((command) => command.applicable === false)
      .map((command) => [command.id, 0] as const),
  );
  const active: { readonly command: EvidenceCommand; readonly completedAt: number }[] = [];
  const pending = [...applicable];
  const activeGroups = new Set<string>();
  let now = 0;

  while (pending.length > 0 || active.length > 0) {
    let started = false;
    for (let index = 0; index < pending.length && active.length < MAX_CONCURRENCY; ) {
      const command = pending[index];
      const dependenciesReady = (command.dependsOn ?? []).every((id) => completed.has(id));
      const concurrencyGroups = command.concurrencyGroups ?? [];
      if (!dependenciesReady || concurrencyGroups.some((group) => activeGroups.has(group))) {
        index += 1;
        continue;
      }
      pending.splice(index, 1);
      for (const group of concurrencyGroups) activeGroups.add(group);
      active.push({
        command,
        completedAt:
          now +
          Math.round(
            (durationOverrides[command.id] ?? durationMinutes(command)) * MILLISECONDS_PER_MINUTE,
          ),
      });
      started = true;
    }

    if (active.length === 0) {
      throw new Error(
        `Critical-path model deadlocked with pending checks: ${pending.map(({ id }) => id).join(", ")}`,
      );
    }
    if (started && active.length < MAX_CONCURRENCY && pending.length > 0) continue;

    active.sort((left, right) => left.completedAt - right.completedAt);
    const next = active.shift();
    if (!next) throw new Error("Critical-path model lost its next active command");
    now = next.completedAt;
    completed.set(next.command.id, now);
    for (const group of next.command.concurrencyGroups ?? []) activeGroups.delete(group);
  }

  return now / MILLISECONDS_PER_MINUTE;
}

export function evaluatePublishCriticalPath(
  options: {
    readonly commands?: readonly EvidenceCommand[];
    readonly durationOverrides?: Readonly<Record<string, number>>;
    readonly workflow?: string;
    readonly testLaneRunnerSource?: string;
  } = {},
): CriticalPathEvaluation {
  const commands = options.commands ?? createVerificationManifest("publish");
  const workflow = options.workflow ?? readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const verificationMinutes = calculateVerificationCriticalPath(
    commands,
    options.durationOverrides,
  );
  const advisoryMatrixRemainsAvailable = /ecosystem-advisory:[\s\S]*--tier ecosystem-advisory/.test(
    workflow,
  );
  const advisoryMinutes = 0;
  const requiredMinutes = Math.max(verificationMinutes, advisoryMinutes);
  const diagnostics: string[] = [];
  const byId = new Map(commands.map((command) => [command.id, command]));
  const generatedCommand = byId.get("generated-app-smoke")?.command ?? [];
  if (
    generatedCommand.includes("--full-matrix") ||
    !PUBLISH_REQUIRED_GENERATED_SMOKE_CASES.every((name) => generatedCommand.includes(name))
  ) {
    diagnostics.push("publish generated smoke must use the inventory-complete required case set");
  }
  for (const id of ["release-gate-tests", "cli-packed-e2e"]) {
    if (!byId.get(id)?.command.includes("scripts/test-lane-evidence-check.mts")) {
      diagnostics.push(`${id} must reuse authoritative lane evidence instead of rerunning tests`);
    }
  }
  if (byId.get("typecheck")?.command.includes("--only")) {
    diagnostics.push("typecheck must retain its declared build dependencies on a clean checkout");
  }
  const testLaneRunner =
    options.testLaneRunnerSource ?? readFileSync(resolve("scripts/test-lane-runner.mts"), "utf8");
  const fastTurboArgs = /"turbo",\s*"run",\s*"test:evidence",([\s\S]*?)\];/.exec(
    testLaneRunner,
  )?.[1];
  if (fastTurboArgs !== undefined && /"--only"/.test(fastTurboArgs)) {
    diagnostics.push(
      "fast test lane must retain its declared build dependencies on a clean checkout",
    );
  }
  if (!advisoryMatrixRemainsAvailable) {
    diagnostics.push("the complete ecosystem-advisory matrix must remain manually executable");
  }
  if (requiredMinutes > TARGET_MINUTES) {
    diagnostics.push(
      `modeled publish critical path ${requiredMinutes.toFixed(1)}m exceeds ${TARGET_MINUTES}m`,
    );
  }

  return {
    status: diagnostics.length === 0 ? "passed" : "failed",
    targetMinutes: TARGET_MINUTES,
    verificationMinutes,
    advisoryMinutes,
    requiredMinutes,
    diagnostics,
  };
}

function isMainModule(): boolean {
  const entry = argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  const evaluation = evaluatePublishCriticalPath();
  console.log(JSON.stringify(evaluation, null, 2));
  if (evaluation.status === "failed") exit(1);
}
