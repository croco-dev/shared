import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CORE_COVERAGE_PACKAGES,
  toCoreCoveragePackageDirectory,
} from "../core-coverage-config.mts";
import {
  TEST_LANES,
  ancestorDirectoriesWithinRoot,
  classifyDiscoveredTest,
  createTestInventoryEvidenceReport,
  createInventoryFromDiscovery,
  discoverAuthoredTests,
  fileDigest,
  findCaseCollisionDiagnostics,
  inventoryDigest,
  parseTestInventory,
  readTestInventory,
  resolveTestProfile,
  runTestInventoryCli,
  validateExecutedPaths,
  validateGeneratedMaterialization,
  validateRepositoryPath,
  validateTestInventory,
} from "../test-inventory.mts";
import type {
  MaterializationEvidence,
  TestInventory,
  TestInventoryEntry,
} from "../test-inventory.mts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "croco-test-inventory-"));
  temporaryDirectories.push(root);
  write(root, "packages/example/package.json", JSON.stringify({ name: "@croco/example" }));
  write(
    root,
    "packages/create-croco-app/package.json",
    JSON.stringify({ name: "create-croco-app" }),
  );
  return root;
}

function write(root: string, path: string, contents = "export {};\n"): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function entry(path: string, overrides: Partial<TestInventoryEntry> = {}): TestInventoryEntry {
  return {
    path,
    lane: "fast",
    qualifiers: [],
    owner: "@croco/example",
    ...overrides,
  };
}

function inventory(
  tests: readonly TestInventoryEntry[],
  exceptions: TestInventory["exceptions"] = [],
): TestInventory {
  return { version: 1, tests, exceptions };
}

function codes(result: { diagnostics: readonly { code: string }[] }): string[] {
  return result.diagnostics.map(({ code }) => code);
}

describe("test inventory parser and digest", () => {
  it("accepts every supported lane and both compatible qualifiers", () => {
    const tests = TEST_LANES.map((lane, index) => ({
      path: `packages/example/src/tests/${lane}.spec.ts`,
      lane,
      qualifiers:
        lane === "fast"
          ? ["coverage"]
          : lane === "integration"
            ? ["coverage", "release-only"]
            : ["release-only"],
      owner: "@croco/example",
      ...(lane === "generated-app"
        ? {
            generated: {
              sourcePath: `packages/example/src/tests/${lane}.spec.ts`,
              generatedPath: "tests/generated.spec.ts",
              commandId: "generator",
            },
          }
        : {}),
    }));
    const result = parseTestInventory({ version: 1, tests });
    expect(result.inventory.tests.map(({ lane }) => lane)).toEqual(TEST_LANES);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects invalid lanes, qualifiers, and incompatible qualifier combinations", () => {
    const invalidLane = parseTestInventory({
      version: 1,
      tests: [
        { path: "packages/example/src/tests/a.spec.ts", lane: "slow", owner: "@croco/example" },
      ],
    });
    const invalidQualifier = parseTestInventory({
      version: 1,
      tests: [
        {
          path: "packages/example/src/tests/a.spec.ts",
          lane: "fast",
          qualifiers: ["nightly"],
          owner: "@croco/example",
        },
      ],
    });
    const incompatible = parseTestInventory({
      version: 1,
      tests: [
        {
          path: "packages/example/src/tests/a.spec.ts",
          lane: "published",
          qualifiers: ["coverage"],
          owner: "@croco/example",
        },
      ],
    });
    expect(codes(invalidLane)).toContain("TEST_INVENTORY_INVALID_LANE");
    expect(codes(invalidQualifier)).toContain("TEST_INVENTORY_INVALID_QUALIFIER");
    expect(codes(incompatible)).toContain("TEST_INVENTORY_INCOMPATIBLE_QUALIFIERS");
  });

  it("produces a stable SHA-256 digest independent of entry and qualifier order", () => {
    const first = inventory([
      entry("packages/example/src/tests/b.spec.ts"),
      entry("packages/example/src/tests/a.spec.ts", {
        qualifiers: ["release-only", "coverage"],
        lane: "integration",
      }),
    ]);
    const second = inventory([
      entry("packages/example/src/tests/a.spec.ts", {
        qualifiers: ["coverage", "release-only"],
        lane: "integration",
      }),
      entry("packages/example/src/tests/b.spec.ts"),
    ]);
    expect(inventoryDigest(first)).toBe(inventoryDigest(second));
    expect(inventoryDigest(first)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("deterministic test discovery", () => {
  it("discovers every included root and authored suffix plus compile contracts", () => {
    const root = createRepository();
    const paths = [
      "packages/example/src/tests/a.spec.ts",
      "packages/example/e2e/a.test.mts",
      "packages/create-croco-app/templates/basic/src/a.spec.tsx",
      "apps/web/src/a.test.jsx",
      "examples/demo/src/a.spec.cjs",
      "scripts/tests/a.test.mjs",
      "scripts/tests/b.test.js",
      "tests/a.spec.cts",
      "tests/contracts/public-type.ts",
      "tests/compile/config.mts",
    ];
    write(root, "apps/web/package.json", JSON.stringify({ name: "@croco/web" }));
    write(root, "examples/demo/package.json", JSON.stringify({ name: "@croco-example/demo" }));
    for (const path of paths) write(root, path);
    expect(discoverAuthoredTests(root).paths).toEqual([...paths].sort());
  });

  it("excludes dependency, output, cache, coverage, temporary, generated, and fixture-output directories at any depth", () => {
    const root = createRepository();
    const excluded = [
      "node_modules",
      "dist",
      "build",
      "lib",
      "out",
      ".turbo",
      ".cache",
      "coverage",
      ".nyc_output",
      "tmp",
      "temp",
      ".tmp",
      ".git",
      ".owx",
      "generated",
      "__generated__",
      "codegen-output",
      "fixture-output",
      "fixtures-output",
      "snapshots-output",
    ];
    write(root, "packages/example/src/tests/kept.spec.ts");
    for (const directory of excluded)
      write(root, `packages/example/src/nested/${directory}/hidden.spec.ts`);
    expect(discoverAuthoredTests(root).paths).toEqual(["packages/example/src/tests/kept.spec.ts"]);
  });

  it("rejects non-NFC, absolute, backslash, dot-segment, duplicate-separator, and escaping paths", () => {
    const invalid = [
      "/absolute.spec.ts",
      "packages\\example\\a.spec.ts",
      "packages/example/../a.spec.ts",
      "packages/example//a.spec.ts",
      "../outside.spec.ts",
      `packages/example/cafe\u0301.spec.ts`,
    ];
    for (const path of invalid)
      expect(validateRepositoryPath(path)?.code, path).toBe("TEST_DISCOVERY_INVALID_PATH");
  });

  it("reports case collisions and rejects file and directory symlinks without traversing them", () => {
    const root = createRepository();
    write(root, "outside.spec.ts");
    mkdirSync(join(root, "packages/example/src/tests"), { recursive: true });
    symlinkSync(
      join(root, "outside.spec.ts"),
      join(root, "packages/example/src/tests/link.spec.ts"),
    );
    mkdirSync(join(root, "real-directory"));
    symlinkSync(join(root, "real-directory"), join(root, "packages/example/src/symlink-directory"));
    expect(codes(discoverAuthoredTests(root))).toContain("TEST_DISCOVERY_SYMLINK");
    expect(
      codes({
        diagnostics: findCaseCollisionDiagnostics([
          "packages/example/src/tests/Case.spec.ts",
          "packages/example/src/tests/case.spec.ts",
        ]),
      }),
    ).toEqual(["TEST_DISCOVERY_CASE_COLLISION"]);
  });
});

describe("inventory reconciliation and ownership", () => {
  it("terminates ancestor traversal at the repository or filesystem root", () => {
    const root = join(tmpdir(), "repository-root");
    expect(ancestorDirectoriesWithinRoot(root, join(root, "a", "b", "test.spec.ts"))).toEqual([
      join(root, "a", "b"),
      join(root, "a"),
    ]);
    expect(
      ancestorDirectoriesWithinRoot(root, join(tmpdir(), "other-root", "test.spec.ts")),
    ).toBeUndefined();
  });

  it("reports orphan, missing, duplicate, and root-sensitive owner diagnostics", () => {
    const root = createRepository();
    write(root, "packages/example/src/tests/orphan.spec.ts");
    write(root, "tests/example.spec.ts");
    const result = validateTestInventory(
      root,
      inventory([
        entry("packages/example/src/tests/missing.spec.ts"),
        entry("tests/example.spec.ts"),
        entry("tests/example.spec.ts"),
      ]),
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "TEST_INVENTORY_ORPHAN",
        "TEST_INVENTORY_MISSING_FILE",
        "TEST_INVENTORY_DUPLICATE_PATH",
        "TEST_INVENTORY_INVALID_OWNER",
      ]),
    );
  });

  it("validates exact non-executable fixture exceptions and rejects malformed, ordinary, and stale exceptions", () => {
    const root = createRepository();
    write(root, "packages/example/src/fixtures/parser-fixture.spec.ts");
    const accepted = parseTestInventory({
      version: 1,
      tests: [],
      exceptions: [
        {
          path: "packages/example/src/fixtures/parser-fixture.spec.ts",
          kind: "non-executable-fixture",
          reason: "Input text consumed by the parser contract.",
          owner: "@croco/example",
        },
      ],
    });
    expect(validateTestInventory(root, accepted.inventory, accepted.diagnostics).valid).toBe(true);

    write(
      root,
      "packages/example/package.json",
      JSON.stringify({
        name: "@croco/example",
        scripts: {
          test: "vitest run src/tests",
          "test:fixture": "CROCO_FIXTURE=1 vitest run src/fixtures/parser-fixture.spec.ts",
        },
      }),
    );
    expect(codes(validateTestInventory(root, accepted.inventory, accepted.diagnostics))).toContain(
      "TEST_INVENTORY_INVALID_EXCEPTION",
    );

    const ordinary = parseTestInventory({
      version: 1,
      tests: [],
      exceptions: [
        {
          path: "packages/example/src/tests/a.spec.ts",
          kind: "non-executable-fixture",
          reason: "no",
          owner: "@croco/example",
        },
      ],
    });
    expect(codes(ordinary)).toContain("TEST_INVENTORY_INVALID_EXCEPTION");

    const staleInventory = inventory(
      [],
      [
        {
          path: "packages/example/src/fixtures/missing-fixture.spec.ts",
          kind: "non-executable-fixture",
          reason: "Fixture was removed.",
          owner: "@croco/example",
        },
      ],
    );
    expect(codes(validateTestInventory(root, staleInventory))).toContain(
      "TEST_INVENTORY_STALE_EXCEPTION",
    );

    mkdirSync(join(root, "packages/example/src/fixtures/directory-fixture.spec.ts"), {
      recursive: true,
    });
    const directoryInventory = inventory(
      [],
      [
        {
          path: "packages/example/src/fixtures/directory-fixture.spec.ts",
          kind: "non-executable-fixture",
          reason: "A directory cannot be excepted.",
          owner: "@croco/example",
        },
      ],
    );
    expect(codes(validateTestInventory(root, directoryInventory))).toContain(
      "TEST_INVENTORY_INVALID_EXCEPTION",
    );
  });

  it("rejects undeclared execution paths", () => {
    expect(
      codes({
        diagnostics: validateExecutedPaths(
          inventory([entry("packages/example/src/tests/a.spec.ts")]),
          ["packages/example/src/tests/a.spec.ts", "packages/example/src/tests/hidden.spec.ts"],
        ),
      }),
    ).toEqual(["TEST_INVENTORY_UNDECLARED_EXECUTION"]);
  });
});

describe("lane profile matrix", () => {
  const cases: readonly [
    TestInventoryEntry["lane"],
    "ordinary" | "publish" | "scheduled-live",
    boolean,
    "R" | "O" | "N/A",
    string,
  ][] = [
    ["fast", "ordinary", true, "R", "REQUIRED_AFFECTED"],
    ["fast", "ordinary", false, "O", "OPTIONAL_UNAFFECTED"],
    ["fast", "publish", false, "R", "REQUIRED_PUBLISH"],
    ["fast", "scheduled-live", false, "O", "OPTIONAL_SCHEDULED"],
    ["integration", "ordinary", true, "R", "REQUIRED_AFFECTED"],
    ["integration", "scheduled-live", false, "O", "OPTIONAL_SCHEDULED"],
    ["published", "ordinary", true, "R", "REQUIRED_AFFECTED"],
    ["published", "ordinary", false, "N/A", "UNAFFECTED_PACKAGING_SURFACE"],
    ["published", "publish", false, "R", "REQUIRED_PUBLISH"],
    ["published", "scheduled-live", false, "N/A", "PROFILE_EXCLUDES_FIDELITY_LANE"],
    ["generated-app", "ordinary", true, "R", "REQUIRED_AFFECTED"],
    ["generated-app", "ordinary", false, "N/A", "UNAFFECTED_PACKAGING_SURFACE"],
    ["generated-app", "publish", false, "R", "REQUIRED_PUBLISH"],
    ["generated-app", "scheduled-live", false, "N/A", "PROFILE_EXCLUDES_FIDELITY_LANE"],
    ["live", "ordinary", true, "N/A", "PROFILE_EXCLUDES_LIVE"],
    ["live", "publish", true, "N/A", "PROFILE_EXCLUDES_LIVE"],
    ["live", "scheduled-live", false, "R", "REQUIRED_SCHEDULED_LIVE"],
  ];

  it.each(cases)("resolves %s in %s", (lane, profile, affected, requirement, reasonCode) => {
    expect(
      resolveTestProfile({ lane, qualifiers: [] }, profile, {
        affected,
        packagingSurfaceAffected: affected,
      }),
    ).toEqual({ requirement, reasonCode });
  });

  it("makes coverage entries required when affected and release-only entries publish-only", () => {
    expect(
      resolveTestProfile({ lane: "fast", qualifiers: ["coverage"] }, "ordinary", {
        affected: true,
      }),
    ).toEqual({ requirement: "R", reasonCode: "REQUIRED_COVERAGE" });
    expect(
      resolveTestProfile({ lane: "fast", qualifiers: ["coverage"] }, "scheduled-live"),
    ).toEqual({ requirement: "N/A", reasonCode: "PROFILE_EXCLUDES_COVERAGE" });
    expect(
      resolveTestProfile({ lane: "integration", qualifiers: ["release-only"] }, "ordinary"),
    ).toEqual({
      requirement: "N/A",
      reasonCode: "RELEASE_ONLY",
    });
    expect(
      resolveTestProfile({ lane: "integration", qualifiers: ["release-only"] }, "publish")
        .requirement,
    ).toBe("R");
    expect(resolveTestProfile({ lane: "live", qualifiers: ["release-only"] }, "publish")).toEqual({
      requirement: "N/A",
      reasonCode: "PROFILE_EXCLUDES_LIVE",
    });
    expect(
      resolveTestProfile({ lane: "live", qualifiers: ["release-only"] }, "scheduled-live"),
    ).toEqual({ requirement: "R", reasonCode: "REQUIRED_SCHEDULED_LIVE" });
  });

  it("records additive execution evidence and fails enforced missing required lanes", () => {
    const testInventory = inventory([
      entry("packages/example/src/tests/fast.spec.ts"),
      entry("packages/example/src/tests/LiveSmoke.spec.ts", { lane: "live" }),
    ]);
    const reportOnly = createTestInventoryEvidenceReport(testInventory, "ordinary", {
      affectedOwners: ["@croco/example"],
    });
    expect(reportOnly).toMatchObject({
      mode: "report-only",
      inventoryVersion: 1,
      inventoryDigest: inventoryDigest(testInventory),
      diagnostics: [],
      entries: [
        expect.objectContaining({
          path: "packages/example/src/tests/LiveSmoke.spec.ts",
          requirement: "N/A",
          state: "not-run",
          reasonCode: "PROFILE_EXCLUDES_LIVE",
        }),
        expect.objectContaining({
          path: "packages/example/src/tests/fast.spec.ts",
          requirement: "R",
          state: "not-run",
          reasonCode: "REQUIRED_AFFECTED",
        }),
      ],
    });
    expect(
      codes({
        diagnostics: createTestInventoryEvidenceReport(testInventory, "ordinary", {
          affectedOwners: ["@croco/example"],
          enforce: true,
        }).diagnostics,
      }),
    ).toContain("TEST_EVIDENCE_MISSING_REQUIRED");
    expect(
      codes({
        diagnostics: createTestInventoryEvidenceReport(testInventory, "scheduled-live", {
          enforce: true,
          liveCredentialsAvailable: false,
        }).diagnostics,
      }),
    ).toContain("TEST_LIVE_CREDENTIALS_MISSING");
  });
});

describe("generated-app materialization", () => {
  function setupGenerated(): {
    root: string;
    generatedRoot: string;
    testInventory: TestInventory;
    evidence: MaterializationEvidence;
  } {
    const root = createRepository();
    const sourcePath = "packages/create-croco-app/templates/basic/src/example.spec.ts";
    const generatedPath = "src/example.spec.ts";
    const materializedPath = "packages/create-croco-app/templates/basic/src/example.spec.ts";
    write(root, sourcePath, "source\n");
    const generatedRoot = join(root, "materialized");
    write(generatedRoot, materializedPath, "generated\n");
    const generatedEntry = entry(sourcePath, {
      lane: "generated-app",
      owner: "create-croco-app",
      generated: { sourcePath, generatedPath, commandId: "create-croco-app" },
    });
    const testInventory = inventory([generatedEntry]);
    return {
      root,
      generatedRoot,
      testInventory,
      evidence: {
        sourcePath,
        sourceDigest: fileDigest(join(root, sourcePath)),
        generatedPath,
        materializedPath,
        generatedDigest: fileDigest(join(generatedRoot, materializedPath)),
        inventoryDigest: inventoryDigest(testInventory),
        commandId: "create-croco-app",
      },
    };
  }

  it("accepts canonical source, destination, command, inventory, and file digests", () => {
    const fixture = setupGenerated();
    expect(
      validateGeneratedMaterialization(fixture.root, fixture.testInventory, fixture.generatedRoot, [
        fixture.evidence,
      ]),
    ).toEqual([]);
  });

  it("reports missing evidence, undeclared execution, mapping mismatch, and stale source digest", () => {
    const fixture = setupGenerated();
    expect(
      codes({
        diagnostics: validateGeneratedMaterialization(
          fixture.root,
          fixture.testInventory,
          fixture.generatedRoot,
          [],
        ),
      }),
    ).toContain("TEST_GENERATED_MAPPING_MISSING");
    expect(
      codes({
        diagnostics: validateGeneratedMaterialization(
          fixture.root,
          fixture.testInventory,
          fixture.generatedRoot,
          [
            {
              ...fixture.evidence,
              sourcePath: "packages/create-croco-app/templates/basic/src/undeclared.spec.ts",
            },
          ],
        ),
      }),
    ).toEqual(
      expect.arrayContaining([
        "TEST_GENERATED_EXECUTION_UNDECLARED",
        "TEST_GENERATED_MAPPING_MISSING",
      ]),
    );
    expect(
      codes({
        diagnostics: validateGeneratedMaterialization(
          fixture.root,
          fixture.testInventory,
          fixture.generatedRoot,
          [
            {
              ...fixture.evidence,
              commandId: "wrong-command",
              inventoryDigest: createHash("sha256").update("wrong").digest("hex"),
              generatedDigest: createHash("sha256").update("wrong").digest("hex"),
            },
          ],
        ),
      }),
    ).toContain("TEST_GENERATED_MAPPING_MISMATCH");
    expect(
      codes({
        diagnostics: validateGeneratedMaterialization(
          fixture.root,
          fixture.testInventory,
          fixture.generatedRoot,
          [
            {
              ...fixture.evidence,
              sourceDigest: createHash("sha256").update("stale").digest("hex"),
            },
          ],
        ),
      }),
    ).toContain("TEST_GENERATED_SOURCE_DIGEST_MISMATCH");
  });

  it("reports a missing generated source without attempting to hash it", () => {
    const fixture = setupGenerated();
    rmSync(join(fixture.root, fixture.evidence.sourcePath));

    expect(
      codes({
        diagnostics: validateGeneratedMaterialization(
          fixture.root,
          fixture.testInventory,
          fixture.generatedRoot,
          [fixture.evidence],
        ),
      }),
    ).toContain("TEST_GENERATED_SOURCE_DIGEST_MISMATCH");
  });
});

describe("classification, CLI, and repository migration", () => {
  it("classifies generated, published, integration, live resource, and core coverage tests defensibly", () => {
    const root = createRepository();
    write(
      root,
      "packages/problems-core/package.json",
      JSON.stringify({ name: "@croco/problems-core" }),
    );
    write(
      root,
      "packages/testing-resources/package.json",
      JSON.stringify({ name: "@croco/testing-resources" }),
    );
    const cases = [
      ["packages/create-croco-app/templates/basic/src/a.spec.ts", "generated-app"],
      ["packages/example/src/tests/PublishedConsumer.spec.ts", "published"],
      ["packages/example/src/tests/integration/jobs-e2e.spec.ts", "integration"],
      ["packages/example/src/tests/Store.postgres.spec.ts", "live"],
      ["packages/example/src/tests/RedisMetering.integration.spec.ts", "live"],
      ["packages/example/src/tests/TimescaleMetricsStore.integration.spec.ts", "live"],
      ["packages/example/src/tests/MigrationStatusPostgres.spec.ts", "live"],
      ["packages/example/src/tests/LiveSmoke.spec.ts", "live"],
      ["packages/testing-resources/src/tests/RealResources.spec.ts", "live"],
      ["scripts/tests/provider-certification-check.spec.ts", "fast"],
      ["scripts/tests/package-entrypoint-smoke.spec.ts", "fast"],
    ] as const;
    for (const [path, lane] of cases)
      expect(classifyDiscoveredTest(root, path).lane, path).toBe(lane);
    expect(
      classifyDiscoveredTest(root, "packages/problems-core/src/tests/Problem.spec.ts").qualifiers,
    ).toEqual(["coverage"]);
  });

  it("derives every core coverage test qualifier from the shared package ownership", () => {
    for (const packageName of CORE_COVERAGE_PACKAGES) {
      const packageDirectory = toCoreCoveragePackageDirectory(packageName);
      expect(
        classifyDiscoveredTest(
          REPOSITORY_ROOT,
          `packages/${packageDirectory}/src/tests/CoreCoverageContract.spec.ts`,
        ).qualifiers,
        packageName,
      ).toEqual(["coverage"]);
    }

    expect(
      classifyDiscoveredTest(
        REPOSITORY_ROOT,
        "packages/tenant-core/src/tests/CoreCoverageContract.spec.ts",
      ).qualifiers,
    ).toEqual([]);
  });

  it("writes and checks a deterministic JSON report artifact", () => {
    const root = createRepository();
    write(root, "packages/example/src/tests/a.spec.ts");
    expect(
      runTestInventoryCli(
        [
          "--write",
          "--profile",
          "ordinary",
          "--affected-owner",
          "@croco/example",
          "--output",
          "ci-reports/test-inventory.json",
        ],
        root,
      ),
    ).toBe(0);
    const first = readFileSync(join(root, "ci-reports/test-inventory.json"), "utf8");
    expect(
      runTestInventoryCli(
        [
          "--check",
          "--profile",
          "ordinary",
          "--affected-owner",
          "@croco/example",
          "--output",
          "ci-reports/test-inventory.json",
        ],
        root,
      ),
    ).toBe(0);
    expect(readFileSync(join(root, "ci-reports/test-inventory.json"), "utf8")).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      schemaVersion: "croco.test-inventory-report/v1",
      valid: true,
      inventoryVersion: 1,
      discoveredPaths: ["packages/example/src/tests/a.spec.ts"],
      evidence: {
        mode: "report-only",
        profile: "ordinary",
        entries: [
          expect.objectContaining({
            path: "packages/example/src/tests/a.spec.ts",
            requirement: "R",
            state: "not-run",
            reasonCode: "REQUIRED_AFFECTED",
          }),
        ],
      },
    });
  });

  it("keeps the checked-in repository inventory at zero orphan with stable generation", () => {
    const parsed = readTestInventory(join(REPOSITORY_ROOT, "test-inventory.json"));
    const report = validateTestInventory(REPOSITORY_ROOT, parsed.inventory, parsed.diagnostics);
    expect(report.diagnostics).toEqual([]);
    expect(report.discoveredPaths).toContain("scripts/tests/test-inventory.spec.ts");
    expect(createInventoryFromDiscovery(REPOSITORY_ROOT)).toEqual(parsed.inventory);
  });
});
