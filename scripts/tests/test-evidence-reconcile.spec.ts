import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertLaneReportShape,
  assertMaterializationEvidence,
  parseTestEvidenceProfile,
  reconcileTestEvidence,
  requiredGeneratedSourcePaths,
} from "../test-evidence-reconcile.mts";
import { selectGeneratedTestPathsForSmokeCases } from "../create-croco-app-generated-smoke-dependencies.mts";
import { PUBLISH_REQUIRED_GENERATED_SMOKE_CASES } from "../verification-manifest.mts";
import { inventoryDigest, readTestInventory } from "../test-inventory.mts";
import type { TestInventory } from "../test-inventory.mts";

const inventory: TestInventory = {
  version: 1,
  exceptions: [],
  tests: [
    { path: "packages/a/src/tests/a.spec.ts", lane: "fast", qualifiers: [], owner: "@croco/a" },
    { path: "packages/b/src/tests/b.spec.ts", lane: "fast", qualifiers: [], owner: "@croco/b" },
  ],
};

function laneReport(executedPaths: readonly string[] = []) {
  return {
    schemaVersion: "croco.test-lane-report/v2" as const,
    inventoryVersion: 1 as const,
    inventoryDigest: inventoryDigest(inventory),
    lane: "fast" as const,
    allowLive: false,
    selectedOwners: [],
    status: "passed" as const,
    executedPaths,
    skippedFiles: [],
    diagnostics: [],
    commands: [
      {
        owner: "@croco/a",
        cwd: "packages/a",
        paths: ["src/tests/a.spec.ts"],
        command: ["pnpm", "run", "test"],
        status: "passed" as const,
        exitCode: 0,
        durationMs: 1,
        executedPaths: ["src/tests/a.spec.ts"],
        skippedFiles: [],
        executionState: "executed" as const,
        cacheHash: "task-hash",
      },
    ],
  };
}

describe("test evidence reconciliation", () => {
  it.each([
    { evidence: {}, label: "non-array evidence" },
    { evidence: [null], label: "null entry" },
    {
      evidence: [
        {
          sourcePath: "templates/a.spec.ts",
          sourceDigest: "source-digest",
          generatedPath: "apps/a.spec.ts",
          materializedPath: "templates/a.spec.ts",
          generatedDigest: "generated-digest",
          inventoryDigest: "inventory-digest",
        },
      ],
      label: "missing command id",
    },
    {
      evidence: [
        {
          sourcePath: "templates/a.spec.ts",
          sourceDigest: "source-digest",
          generatedPath: "apps/a.spec.ts",
          materializedPath: "templates/a.spec.ts",
          generatedDigest: 42,
          inventoryDigest: "inventory-digest",
          commandId: "generated-app-smoke",
        },
      ],
      label: "non-string digest",
    },
  ])("rejects $label before reconciling generated evidence", ({ evidence }) => {
    expect(() => assertMaterializationEvidence(evidence)).toThrow(
      "Generated materialization evidence has an invalid report shape",
    );
  });

  it("accepts complete generated materialization evidence", () => {
    expect(() =>
      assertMaterializationEvidence([
        {
          sourcePath: "templates/a.spec.ts",
          sourceDigest: "source-digest",
          generatedPath: "apps/a.spec.ts",
          materializedPath: "templates/a.spec.ts",
          generatedDigest: "generated-digest",
          inventoryDigest: "inventory-digest",
          commandId: "generated-app-smoke",
        },
      ]),
    ).not.toThrow();
  });

  it("validates CLI profiles instead of casting arbitrary input", () => {
    expect(parseTestEvidenceProfile("publish")).toBe("publish");
    expect(() => parseTestEvidenceProfile("forged")).toThrow(
      "--profile requires one of: ordinary, publish, scheduled-live",
    );
  });

  it("omits generated-path filtering unless required paths were explicitly supplied", () => {
    expect(requiredGeneratedSourcePaths([])).toBeUndefined();
    expect(
      requiredGeneratedSourcePaths([
        "--required-generated-path",
        "templates/a.spec.ts",
        "--required-generated-path",
        "templates/b.spec.ts",
      ]),
    ).toEqual(new Set(["templates/a.spec.ts", "templates/b.spec.ts"]));
  });

  it("fails required affected tests that have no lane execution evidence", () => {
    const report = reconcileTestEvidence({
      inventory,
      profile: "ordinary",
      affectedOwners: ["@croco/b"],
      reports: [laneReport(["packages/a/src/tests/a.spec.ts"])],
    });
    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: "TEST_EVIDENCE_MISSING_REQUIRED" }),
    ]);
  });

  it("does not require unselected generated tests in a publish profile", () => {
    const generatedInventory: TestInventory = {
      version: 1,
      exceptions: [],
      tests: [
        {
          path: "packages/create-croco-app/templates/a/src/tests/a.spec.ts",
          lane: "generated-app",
          qualifiers: [],
          owner: "create-croco-app",
          generated: {
            sourcePath: "packages/create-croco-app/templates/a/src/tests/a.spec.ts",
            generatedPath: "src/tests/a.spec.ts",
          },
        },
      ],
    };

    const report = reconcileTestEvidence({
      inventory: generatedInventory,
      profile: "publish",
      reports: [],
      requiredGeneratedPaths: [],
    });

    expect(report.diagnostics).toEqual([]);
    expect(report.entries).toEqual([
      expect.objectContaining({ requirement: "N/A", state: "not-run" }),
    ]);
  });

  it("reconciles the seven-case selection without requiring unexecuted SPA journeys", () => {
    const { inventory: repositoryInventory, diagnostics } = readTestInventory(
      join(import.meta.dirname, "..", "..", "test-inventory.json"),
    );
    expect(diagnostics).toEqual([]);
    const generatedInventory: TestInventory = {
      ...repositoryInventory,
      tests: repositoryInventory.tests.filter(({ lane }) => lane === "generated-app"),
    };
    const allPaths = generatedInventory.tests.map(({ path }) => path);
    const executedPaths = allPaths.filter(
      (path) => !path.includes("/base-ddd/") && !path.includes("/spa-be-split/tests/journeys/"),
    );
    expect(executedPaths).toHaveLength(14);
    const requiredGeneratedPaths = selectGeneratedTestPathsForSmokeCases(
      [
        "goal-saas-api",
        "goal-internal-tool",
        "admin-console-starter",
        "saas-golden-path",
        "saas-cloudflare-profile",
        "saas-lambda-profile",
        "ai-saas-golden-path",
      ],
      allPaths,
    );
    const reconcile = (paths: readonly string[], required = requiredGeneratedPaths) =>
      reconcileTestEvidence({
        inventory: generatedInventory,
        profile: "publish",
        reports: [],
        requiredGeneratedPaths: required,
        generatedExecutedPaths: paths,
      });

    expect(reconcile(executedPaths).diagnostics).toEqual([]);
    expect(reconcile(executedPaths.slice(1)).diagnostics).toEqual([
      expect.objectContaining({ code: "TEST_EVIDENCE_MISSING_REQUIRED", path: executedPaths[0] }),
    ]);
    const fullTierPaths = selectGeneratedTestPathsForSmokeCases(
      PUBLISH_REQUIRED_GENERATED_SMOKE_CASES,
      allPaths,
    );
    expect(fullTierPaths).toEqual([...allPaths].sort());
    expect(reconcile(allPaths, fullTierPaths).diagnostics).toEqual([]);
    expect(reconcile(executedPaths, fullTierPaths).diagnostics).toHaveLength(3);
  });

  it("rejects lane evidence produced from a stale inventory", () => {
    expect(() =>
      reconcileTestEvidence({
        inventory,
        profile: "ordinary",
        reports: [{ ...laneReport(["packages/a/src/tests/a.spec.ts"]), inventoryDigest: "stale" }],
      }),
    ).toThrow("stale inventory digest");
  });

  it("rejects a forged minimal report that only claims a digest and executed paths", () => {
    expect(() =>
      reconcileTestEvidence({
        inventory,
        profile: "ordinary",
        reports: [
          {
            inventoryDigest: inventoryDigest(inventory),
            status: "passed",
            executedPaths: ["packages/a/src/tests/a.spec.ts"],
          } as never,
        ],
      }),
    ).toThrow("invalid report shape");
  });

  it.each([
    { cacheHash: undefined, executionState: "reused", label: "missing reused task hash" },
    { exitCode: 1, label: "nonzero exit" },
    { executionState: undefined, label: "missing execution state" },
    { status: "failed", label: "failed command status" },
    { executedPaths: [], label: "missing executed paths" },
  ])("rejects $label in an otherwise passing lane report", (override) => {
    const valid = laneReport(["packages/a/src/tests/a.spec.ts"]);
    expect(() =>
      reconcileTestEvidence({
        inventory,
        profile: "ordinary",
        reports: [{ ...valid, commands: [{ ...valid.commands[0], ...override }] } as never],
      }),
    ).toThrow("invalid command result");
  });

  it("accepts freshly executed non-Turbo evidence without a cache hash", () => {
    const valid = laneReport(["packages/a/src/tests/a.spec.ts"]);
    const command = { ...valid.commands[0], executionState: "executed" as const };
    delete (command as { cacheHash?: string }).cacheHash;

    expect(() =>
      reconcileTestEvidence({
        inventory,
        profile: "ordinary",
        reports: [{ ...valid, commands: [command] }],
      }),
    ).not.toThrow();
  });

  it("preserves a structurally valid failed lane report for producer failure evidence", () => {
    const valid = laneReport([]);
    const failed = {
      ...valid,
      status: "failed",
      diagnostics: [{ code: "TEST_LANE_EXECUTION_FAILED", message: "command failed" }],
      commands: [
        {
          ...valid.commands[0],
          status: "failed",
          exitCode: 1,
          executedPaths: [],
        },
      ],
    };

    expect(() => assertLaneReportShape(failed)).not.toThrow();
    expect(() =>
      reconcileTestEvidence({ inventory, profile: "ordinary", reports: [failed as never] }),
    ).toThrow("Test lane evidence is failed");
  });

  it("preserves skipped assertion evidence while refusing to reconcile it as completed", () => {
    const valid = laneReport([]);
    const skippedFile = {
      path: "src/tests/a.spec.ts",
      status: "partially-executed" as const,
      passedAssertions: 1,
      skippedAssertions: [{ name: "requires database credentials", status: "skipped" as const }],
    };
    const failed = {
      ...valid,
      status: "failed" as const,
      skippedFiles: [{ ...skippedFile, path: "packages/a/src/tests/a.spec.ts" }],
      diagnostics: [
        { code: "TEST_LANE_EXECUTION_SKIPPED", message: "@croco/a: skipped assertion" },
      ],
      commands: [
        {
          ...valid.commands[0],
          status: "failed" as const,
          executedPaths: [],
          skippedFiles: [skippedFile],
        },
      ],
    };

    expect(() => assertLaneReportShape(failed)).not.toThrow();
    expect(() =>
      reconcileTestEvidence({ inventory, profile: "ordinary", reports: [failed] }),
    ).toThrow("Test lane evidence is failed");
  });

  it("accepts producer-ordered skipped files with mixed-case paths", () => {
    const valid = laneReport([]);
    const skippedFiles = ["src/tests/Z.spec.ts", "src/tests/a.spec.ts"].map((path) => ({
      path,
      status: "skipped" as const,
      passedAssertions: 0,
      skippedAssertions: [{ name: "requires credentials", status: "skipped" as const }],
    }));
    const failed = {
      ...valid,
      status: "failed" as const,
      skippedFiles: skippedFiles.map((file) => ({ ...file, path: `packages/a/${file.path}` })),
      diagnostics: [
        { code: "TEST_LANE_EXECUTION_SKIPPED", message: "@croco/a: skipped assertion" },
      ],
      commands: [
        {
          ...valid.commands[0],
          status: "failed" as const,
          paths: skippedFiles.map(({ path }) => path),
          executedPaths: [],
          skippedFiles,
        },
      ],
    };

    expect(() => assertLaneReportShape(failed)).not.toThrow();
  });

  it("rejects failed lane evidence that credits an unplanned path", () => {
    const valid = laneReport(["packages/a/src/tests/other.spec.ts"]);
    const failed = {
      ...valid,
      status: "failed",
      diagnostics: [{ code: "TEST_LANE_EXECUTION_FAILED", message: "command failed" }],
      commands: [
        {
          ...valid.commands[0],
          status: "failed",
          exitCode: 1,
          executedPaths: ["src/tests/other.spec.ts"],
        },
      ],
    };

    expect(() => assertLaneReportShape(failed)).toThrow("invalid command result");
  });
});
