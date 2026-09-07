import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  calculateVerificationCriticalPath,
  evaluatePublishCriticalPath,
} from "../ci-publish-critical-path.mts";
import { createVerificationManifest } from "../verification-manifest.mts";

const ROOT_DIR = resolve(import.meta.dirname, "../..");

describe("publish validate critical path", () => {
  it("keeps the optimized publish scheduler within the required wall-clock budget", () => {
    const manifest = createVerificationManifest("publish");

    expect(calculateVerificationCriticalPath(manifest)).toBeLessThanOrEqual(45);
  });

  it("passes only when duplicate executions are removed and advisory coverage remains available", () => {
    const evaluation = evaluatePublishCriticalPath({
      workflow: readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf8"),
    });

    expect(evaluation).toMatchObject({ status: "passed", diagnostics: [] });
    expect(evaluation.requiredMinutes).toBeLessThanOrEqual(evaluation.targetMinutes);
  });

  it("rejects a critical path that exceeds the budget below display precision", () => {
    const commands = createVerificationManifest("publish");
    const durationOverrides = Object.fromEntries(commands.map(({ id }) => [id, 0]));
    durationOverrides["generated-app-smoke"] = 45.04;

    const evaluation = evaluatePublishCriticalPath({
      commands,
      durationOverrides,
      workflow: readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf8"),
    });

    expect(evaluation.requiredMinutes).toBe(45.04);
    expect(evaluation.diagnostics).toContain("modeled publish critical path 45.0m exceeds 45m");
    expect(evaluation.status).toBe("failed");
  });

  it("fails when publish restores the full generated matrix or reruns release-gate tests", () => {
    const commands = createVerificationManifest("publish").map((command) => {
      if (command.id === "generated-app-smoke") {
        return { ...command, command: [...command.command.slice(0, 3), "--full-matrix"] };
      }
      if (command.id === "release-gate-tests") {
        return { ...command, command: ["pnpm", "exec", "vitest", "run"] };
      }
      return command;
    });

    const evaluation = evaluatePublishCriticalPath({
      commands,
      workflow: readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf8"),
    });

    expect(evaluation.status).toBe("failed");
    expect(evaluation.diagnostics).toEqual(
      expect.arrayContaining([
        "publish generated smoke must use the inventory-complete required case set",
        "release-gate-tests must reuse authoritative lane evidence instead of rerunning tests",
      ]),
    );
  });

  it("fails when typecheck skips the build graph required by a clean checkout", () => {
    const commands = createVerificationManifest("publish").map((command) =>
      command.id === "typecheck"
        ? { ...command, command: [...command.command, "--only"] }
        : command,
    );

    const evaluation = evaluatePublishCriticalPath({
      commands,
      workflow: readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf8"),
    });

    expect(evaluation.diagnostics).toContain(
      "typecheck must retain its declared build dependencies on a clean checkout",
    );
  });

  it("fails when the fast test lane skips the build graph required by a clean checkout", () => {
    // --only is placed after another argument to prove detection is not
    // limited to the position immediately after "test".
    const evaluation = evaluatePublishCriticalPath({
      commands: createVerificationManifest("publish"),
      workflow: readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf8"),
      testLaneRunnerSource:
        'return ["turbo", "run", "test:evidence", "--concurrency=4", "--only"];',
    });

    expect(evaluation.diagnostics).toContain(
      "fast test lane must retain its declared build dependencies on a clean checkout",
    );
  });

  it("accepts a fast test lane that retains its build graph on a clean checkout", () => {
    const evaluation = evaluatePublishCriticalPath({
      commands: createVerificationManifest("publish"),
      workflow: readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf8"),
      testLaneRunnerSource: 'return ["turbo", "run", "test:evidence", "--concurrency=4"];',
    });

    expect(evaluation.diagnostics).not.toContain(
      "fast test lane must retain its declared build dependencies on a clean checkout",
    );
    expect(evaluation).toMatchObject({ status: "passed", diagnostics: [] });
  });
});
