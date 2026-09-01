import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GOAL_SPECS } from "../../packages/create-croco-app/src/goals.ts";
import { SUPPORTED_CREATE_CROCO_APP_CHOICES } from "../../packages/create-croco-app/src/supported-options.ts";
import {
  assertGeneratedBrowserWorkflowLeastPrivilege,
  assertGeneratedVerificationValidationsAreReadOnly,
  collectDisallowedGeneratedDotenvFiles,
  markWorkspacePackageClosureBuilt,
  assertGeneratedPresentationProfileMatchesCatalog,
  createSaasMonetizationCanarySource,
  getGeneratedGoalSmokeCaseInputs,
  getGeneratedSmokeDependencyCaseInputs,
  hasCompleteTapTestEvidence,
  isActiveDotenvAssignment,
  isDotenvFileName,
  prepareGeneratedUnitEvidenceCapture,
  readCommandOutputSegment,
  readGeneratedSmokeAllowlistMetadata,
  reconcileGeneratedTestPaths,
  requiresCommandShell,
  RESOLVED_PLAYWRIGHT_BROWSERS_PATH,
  resolveTapSelectedGeneratedPaths,
  selectCompletedGeneratedTestEntries,
  turboBuildArguments,
  turboConcurrencyArguments,
} from "../create-croco-app-generated-smoke.mts";
import type { TestInventoryEntry } from "../test-inventory.mts";
import { readCompletedPlaywrightPaths, readCompletedVitestPaths } from "../test-lane-runner.mts";
import {
  classifySmokeCommandFailure,
  classifySmokeFailure,
  collectSmokeFailureArtifactFiles,
  copyGeneratedSmokeArtifacts,
  createSmokeRecoverySummary,
  extractSmokeCommandDiagnosticCodes,
  renderGeneratedSmokeArtifacts,
  shouldIncludeSmokeFailureArtifact,
  shouldSkipSmokeArtifactDirectory,
} from "../create-croco-app-generated-smoke-report.mts";
import {
  assertGeneratedSmokeJourneyReport,
  createGeneratedSmokeJourneyReport,
  GENERATED_SMOKE_JOURNEY_DEFINITIONS,
  isCanonicalGeneratedSmokeJourneySelection,
  renderGeneratedSmokeJourneyReport,
  writeCanonicalGeneratedSmokeJourneyBundle,
  writeGeneratedSmokeJourneyBundle,
  type GeneratedSmokeJourneySourceReport,
} from "../create-croco-app-generated-smoke-journey-report.mts";
import {
  assertGeneratedSmokeMatrixContract,
  createGeneratedSmokeMatrixAggregateReport,
  createGeneratedSmokeMatrixTierReport,
  GENERATED_SMOKE_MATRIX_CASES,
  renderGeneratedSmokeMatrixReport,
  selectGeneratedSmokeMatrixCases,
  type SmokeMatrixCaseDefinition,
} from "../create-croco-app-generated-smoke-matrix.mts";
import {
  assertGeneratedTemplateLintContracts,
  createWorkspacePackageIndex,
  resolveLocalCrocoPackagesForGeneratedProject,
  rewriteExternalCrocoRanges,
  writePnpmWorkspaceOverrides,
} from "../create-croco-app-generated-smoke-support.mts";

describe("generated environment template validation", () => {
  it("recognizes dotenv files while excluding unrelated dot-prefixed names", () => {
    expect(
      [".env", ".env.local", ".env.development", ".env.test.local"].map(isDotenvFileName),
    ).toEqual([true, true, true, true]);
    expect([".environment", ".envrc", "env.local"].map(isDotenvFileName)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("recognizes active dotenv assignments with supported whitespace and export syntax", () => {
    expect(
      ["NAME=value", " NAME = value", "export NAME=value", "\texport\tNAME = value"].map(
        isActiveDotenvAssignment,
      ),
    ).toEqual([true, true, true, true]);
    expect(
      ["# NAME=value", "  # export NAME=value", "NAME", "export NAME"].map(
        isActiveDotenvAssignment,
      ),
    ).toEqual([false, false, false, false]);
  });

  it("finds nested dotenv files while ignoring examples, dependencies, and unrelated names", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "croco-generated-env-test-"));

    try {
      writeFile(join(projectDir, ".env.example"), "# ROOT=value\n");
      writeFile(join(projectDir, "apps/api/.env.local"), "TOKEN=value\n");
      writeFile(join(projectDir, "apps/web/.env.development.local"), "URL=value\n");
      writeFile(join(projectDir, "apps/web/.environment"), "ignored\n");
      writeFile(join(projectDir, "node_modules/example/.env"), "IGNORED=value\n");

      expect(collectDisallowedGeneratedDotenvFiles(projectDir)).toEqual([
        "apps/api/.env.local",
        "apps/web/.env.development.local",
      ]);
    } finally {
      rmSync(projectDir, { force: true, recursive: true });
    }
  });
});

const tempRoots: string[] = [];
const journeySourceCaseNames = [
  "production-app-starter",
  "graphql-lambda-api",
  "rest-spa-contracts",
] as const;

function generatedUnitInventoryEntry(generatedPath: string): TestInventoryEntry {
  const sourcePath = `packages/create-croco-app/templates/test/${generatedPath}`;
  return {
    path: sourcePath,
    lane: "generated-app",
    qualifiers: [],
    owner: "@croco/create-croco-app",
    generated: {
      sourcePath,
      generatedPath,
      commandId: "create-croco-app",
    },
  };
}

describe("generated test execution evidence", () => {
  const entries: readonly TestInventoryEntry[] = [
    {
      path: "packages/create-croco-app/templates/example/src/tests/unit.spec.ts",
      lane: "generated-app",
      qualifiers: [],
      owner: "@croco/create-croco-app",
      generated: {
        sourcePath: "packages/create-croco-app/templates/example/src/tests/unit.spec.ts",
        generatedPath: "src/tests/unit.spec.ts",
        commandId: "create-croco-app",
      },
    },
    {
      path: "packages/create-croco-app/templates/example/tests/journeys/user.spec.ts",
      lane: "generated-app",
      qualifiers: [],
      owner: "@croco/create-croco-app",
      generated: {
        sourcePath: "packages/create-croco-app/templates/example/tests/journeys/user.spec.ts",
        generatedPath: "tests/journeys/user.spec.ts",
        commandId: "create-croco-app",
      },
    },
  ];
  const utilsEnvInventory = [
    generatedUnitInventoryEntry("libs/shared/utils-env/src/tests/createEnv.spec.ts"),
  ];

  it("does not treat generated files as executed before their exact test stages pass", () => {
    const projectDir = createTempRoot();
    writeFile(join(projectDir, "src/tests/unit.spec.ts"), "test source");
    writeFile(join(projectDir, "tests/journeys/user.spec.ts"), "journey source");

    expect(selectCompletedGeneratedTestEntries(projectDir, entries, new Set())).toEqual([]);
    expect(
      selectCompletedGeneratedTestEntries(
        projectDir,
        entries,
        new Set(["src/tests/unit.spec.ts"]),
      ).map(({ path }) => path),
    ).toEqual([entries[0].path]);
    expect(
      selectCompletedGeneratedTestEntries(
        projectDir,
        entries,
        new Set(["src/tests/unit.spec.ts", "tests/journeys/user.spec.ts"]),
      ).map(({ path }) => path),
    ).toEqual(entries.map(({ path }) => path));
  });

  it("rejects skipped and partial TAP output from generated exact tests", () => {
    expect(
      hasCompleteTapTestEvidence(
        "TAP version 13\n# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# todo 0\n",
      ),
    ).toBe(true);
    expect(
      hasCompleteTapTestEvidence(
        "TAP version 13\n# tests 2\n# pass 1\n# fail 0\n# skipped 1\n# todo 0\n",
      ),
    ).toBe(false);
    expect(
      hasCompleteTapTestEvidence(
        "TAP version 13\n# tests 2\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n",
      ),
    ).toBe(false);
  });

  it("rejects partially or entirely skipped generated files", () => {
    const projectDir = createTempRoot();
    const vitestReport = join(projectDir, "vitest.json");
    const playwrightReport = join(projectDir, "playwright.json");
    writeFile(
      vitestReport,
      JSON.stringify({
        testResults: [
          {
            name: join(projectDir, "src/tests/passed.spec.ts"),
            status: "passed",
            assertionResults: [{ status: "passed" }],
          },
          {
            name: join(projectDir, "src/tests/partial.spec.ts"),
            status: "passed",
            assertionResults: [{ status: "passed" }, { status: "skipped" }],
          },
        ],
      }),
    );
    writeFile(
      playwrightReport,
      JSON.stringify({
        suites: [
          {
            specs: [
              {
                file: "tests/journeys/passed.spec.ts",
                tests: [{ results: [{ status: "passed" }] }],
              },
              {
                file: "tests/journeys/skipped.spec.ts",
                tests: [{ results: [{ status: "skipped" }] }],
              },
            ],
          },
        ],
      }),
    );

    expect(readCompletedVitestPaths(vitestReport, projectDir)).toEqual([
      "src/tests/passed.spec.ts",
    ]);
    expect(readCompletedPlaywrightPaths(playwrightReport, projectDir)).toEqual([
      "tests/journeys/passed.spec.ts",
    ]);
  });

  it("reconciles Playwright basenames only when they identify one expected journey", () => {
    expect(
      reconcileGeneratedTestPaths(
        ["create-user.spec.ts", "problem-rendering.spec.ts"],
        ["tests/journeys/create-user.spec.ts", "tests/journeys/problem-rendering.spec.ts"],
      ),
    ).toEqual(["tests/journeys/create-user.spec.ts", "tests/journeys/problem-rendering.spec.ts"]);
    expect(
      reconcileGeneratedTestPaths(
        ["duplicate.spec.ts"],
        [
          "apps/admin/tests/journeys/duplicate.spec.ts",
          "apps/console/tests/journeys/duplicate.spec.ts",
        ],
      ),
    ).toEqual([]);
  });

  it("captures evidence inside each existing generated test stage without adding test commands", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../create-croco-app-generated-smoke.mts"),
      "utf8",
    );

    expect(source).not.toContain("runExactGeneratedTest");
    expect(source).not.toContain('"--force"');
    expect(source).toContain('"create-croco-app", "dist", "bin.js"');
    expect(source).not.toContain('"create-croco-app", "dist", "index.js"');
    expect(source.match(/runValidation\(projectDir, smokeCase, validation/g)).toHaveLength(1);
    expect(source).toContain('validation.label === "test"');
    expect(source).toContain('validation.label === "browser journeys"');
    expect(source).toMatch(/try \{\n\s+unitCapture =/);
  });

  it("instruments the existing generated package test script and restores it", () => {
    const projectDir = createTempRoot();
    const packageDir = join(projectDir, "libs/shared/utils-env");
    const manifestPath = join(packageDir, "package.json");
    const turboConfigPath = join(projectDir, "turbo.json");
    writeGeneratedPackage(projectDir, "package.json", {
      name: "generated-app",
      scripts: { test: "turbo test" },
    });
    writeGeneratedPackage(projectDir, "turbo.json", {
      tasks: { test: { dependsOn: ["build"] } },
    });
    writeFile(join(projectDir, "libs/shared/utils-env/src/tests/createEnv.spec.ts"), "test source");
    writeGeneratedPackage(projectDir, "libs/shared/utils-env/package.json", {
      name: "@smoke/utils-env",
      scripts: { test: "tsx --test src/tests/**/*.spec.ts" },
    });
    const original = readFileSync(manifestPath, "utf8");
    const originalTurboConfig = readFileSync(turboConfigPath, "utf8");

    const capture = prepareGeneratedUnitEvidenceCapture(projectDir, utilsEnvInventory);
    expect(capture.reports).toHaveLength(1);
    expect(capture.reports[0]).toMatchObject({
      kind: "tap",
      path: join(packageDir, ".croco-generated-test-evidence.json"),
      packageDir,
      selectedGeneratedPaths: ["libs/shared/utils-env/src/tests/createEnv.spec.ts"],
    });
    expect(readFileSync(manifestPath, "utf8")).toContain(
      "tsx --test --test-reporter=tap --test-reporter-destination=.croco-generated-test-evidence.json src/tests/**/*.spec.ts",
    );
    expect(readGeneratedPackage(projectDir, "turbo.json")).toMatchObject({
      tasks: { test: { outputs: [".croco-generated-test-evidence.json"] } },
    });
    capture.restore();

    expect(readFileSync(manifestPath, "utf8")).toBe(original);
    expect(readFileSync(turboConfigPath, "utf8")).toBe(originalTurboConfig);
    expect(existsSync(join(packageDir, ".croco-generated-test-evidence.json"))).toBe(false);
  });

  it("does not credit aggregate TAP output when the script selects a different file", () => {
    const projectDir = createTempRoot();
    writeFile(
      join(projectDir, "libs/shared/utils-env/src/tests/createEnv.spec.ts"),
      "mapped test source",
    );
    writeFile(
      join(projectDir, "libs/shared/utils-env/src/tests/other.spec.ts"),
      "other test source",
    );
    writeGeneratedPackage(projectDir, "libs/shared/utils-env/package.json", {
      name: "@smoke/utils-env",
      scripts: { test: "tsx --test src/tests/other.spec.ts" },
    });

    expect(() => prepareGeneratedUnitEvidenceCapture(projectDir, utilsEnvInventory)).toThrow(
      "TAP generated test selectors do not exactly match mapped tests",
    );
  });

  it("rolls back earlier generated package and Turbo mutations when preparation later fails", () => {
    const projectDir = createTempRoot();
    const validManifestPath = join(projectDir, "apps/valid/package.json");
    const turboConfigPath = join(projectDir, "turbo.json");
    writeGeneratedPackage(projectDir, "package.json", {
      name: "generated-app",
      scripts: { test: "turbo test" },
    });
    writeGeneratedPackage(projectDir, "turbo.json", {
      tasks: { test: { dependsOn: ["build"] } },
    });
    writeFile(join(projectDir, "apps/valid/src/tests/valid.spec.ts"), "valid test source");
    writeGeneratedPackage(projectDir, "apps/valid/package.json", {
      name: "@smoke/valid",
      scripts: { test: "vitest run" },
    });
    writeFile(
      join(projectDir, "libs/unsupported/src/tests/unsupported.spec.ts"),
      "unsupported test source",
    );
    writeGeneratedPackage(projectDir, "libs/unsupported/package.json", {
      name: "@smoke/unsupported",
      scripts: { test: "node src/tests/unsupported.spec.ts" },
    });
    const originalValidManifest = readFileSync(validManifestPath, "utf8");
    const originalTurboConfig = readFileSync(turboConfigPath, "utf8");

    expect(() =>
      prepareGeneratedUnitEvidenceCapture(projectDir, [
        generatedUnitInventoryEntry("apps/valid/src/tests/valid.spec.ts"),
        generatedUnitInventoryEntry("libs/unsupported/src/tests/unsupported.spec.ts"),
      ]),
    ).toThrow("uses an unsupported evidence runner");

    expect(readFileSync(validManifestPath, "utf8")).toBe(originalValidManifest);
    expect(readFileSync(turboConfigPath, "utf8")).toBe(originalTurboConfig);
    expect(existsSync(join(projectDir, "apps/valid/.croco-generated-test-evidence.json"))).toBe(
      false,
    );
  });

  it("rejects generated inventory paths outside the generated project boundary", () => {
    const root = createTempRoot();
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFile(join(root, "outside/src/tests/outside.spec.ts"), "outside test source");
    writeGeneratedPackage(root, "outside/package.json", {
      name: "@smoke/outside",
      scripts: { test: "vitest run" },
    });

    expect(() =>
      prepareGeneratedUnitEvidenceCapture(projectDir, [
        generatedUnitInventoryEntry("../outside/src/tests/outside.spec.ts"),
      ]),
    ).toThrow("Generated test has no package.json boundary: ../outside/src/tests/outside.spec.ts");
  });

  it("excludes directory entries selected by broad TAP globs", () => {
    const projectDir = createTempRoot();
    const packageDir = join(projectDir, "apps/api");
    writeFile(join(projectDir, "apps/api/src/tests/unit.spec.ts"), "test source");
    mkdirSync(join(packageDir, "src/tests/fixtures"), { recursive: true });

    expect(resolveTapSelectedGeneratedPaths("tsx --test src/**", packageDir, projectDir)).toEqual([
      "apps/api/src/tests/unit.spec.ts",
    ]);
  });
});

describe("generated browser workflow policy", () => {
  it("accepts read-only permissions with non-persistent checkout credentials", () => {
    const root = createTempRoot();
    const workflowPath = join(root, "browser-tests.yml");
    writeFile(
      workflowPath,
      `permissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n        with:\n          persist-credentials: false\n`,
    );

    expect(() => assertGeneratedBrowserWorkflowLeastPrivilege(workflowPath)).not.toThrow();
  });

  it.each([
    [
      "broader token permissions",
      `permissions:\n  contents: read\n  pull-requests: write\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n        with:\n          persist-credentials: false\n`,
      "permissions must grant only contents: read",
    ],
    [
      "persistent checkout credentials",
      `permissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n`,
      "checkout steps must set persist-credentials: false",
    ],
    [
      "job-level permission escalation",
      `permissions:\n  contents: read\njobs:\n  test:\n    permissions:\n      contents: write\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n        with:\n          persist-credentials: false\n`,
      "job test permissions must grant only contents: read",
    ],
    [
      "mixed-case checkout reference",
      `permissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n        with:\n          persist-credentials: false\n      - uses: AcTiOnS/ChEcKoUt@0123456789012345678901234567890123456789\n        with:\n          persist-credentials: false\n`,
      "checkout steps must use canonical actions/checkout@ casing",
    ],
  ])("rejects %s", (_label, workflow, expectedMessage) => {
    const root = createTempRoot();
    const workflowPath = join(root, "browser-tests.yml");
    writeFile(workflowPath, workflow);

    expect(() => assertGeneratedBrowserWorkflowLeastPrivilege(workflowPath)).toThrow(
      expectedMessage,
    );
  });
});

describe("generated smoke command execution", () => {
  it("uses the native Windows command shell only for cmd shims", () => {
    expect(requiresCommandShell("corepack.cmd", "win32")).toBe(true);
    expect(requiresCommandShell("COREPACK.CMD", "win32")).toBe(true);
    expect(requiresCommandShell("node.exe", "win32")).toBe(false);
    expect(requiresCommandShell("corepack", "linux")).toBe(false);
  });

  it("bounds Windows workspace build concurrency for TypeScript declaration bundling", () => {
    expect(turboConcurrencyArguments("win32")).toEqual(["--concurrency=1"]);
    expect(turboConcurrencyArguments("linux")).toEqual(["--concurrency=4"]);
    expect(turboBuildArguments(["@croco/example"], "win32")).toEqual([
      "build",
      "--concurrency=1",
      "--filter=@croco/example...",
    ]);
    expect(turboBuildArguments(["@croco/example"], "linux")).toEqual([
      "build",
      "--concurrency=4",
      "--filter=@croco/example...",
    ]);
  });

  it("reuses every package built by a successful workspace dependency closure", () => {
    const built = new Set(["@croco/already-built"]);
    const workspacePackages = new Map([
      [
        "@croco/app",
        {
          name: "@croco/app",
          packageDir: "/workspace/packages/app",
          version: "1.0.0",
          dependencyNames: ["@croco/core"],
        },
      ],
      [
        "@croco/core",
        {
          name: "@croco/core",
          packageDir: "/workspace/packages/core",
          version: "1.0.0",
          dependencyNames: ["@croco/shared"],
        },
      ],
      [
        "@croco/shared",
        {
          name: "@croco/shared",
          packageDir: "/workspace/packages/shared",
          version: "1.0.0",
          dependencyNames: [],
        },
      ],
    ]);

    markWorkspacePackageClosureBuilt(["@croco/app"], workspacePackages, built);

    expect([...built].sort()).toEqual([
      "@croco/already-built",
      "@croco/app",
      "@croco/core",
      "@croco/shared",
    ]);
  });

  it("fails when a declared workspace build root is unknown", () => {
    expect(() =>
      markWorkspacePackageClosureBuilt(["@croco/missing"], new Map(), new Set()),
    ).toThrow("Workspace build references unknown package @croco/missing");
  });
});

describe("generated verification mutation coverage", () => {
  it("requires guards and recovery for contract and non-codegen verify validations", () => {
    expect(() =>
      assertGeneratedVerificationValidationsAreReadOnly([
        { args: ["contract:verify"], readOnly: true, recovery: "pnpm codegen" },
        { args: ["profile:check"], readOnly: true, recovery: "regenerate profile" },
        { args: ["di:verify"], readOnly: true, recovery: "pnpm di:graph" },
      ]),
    ).not.toThrow();
    expect(() =>
      assertGeneratedVerificationValidationsAreReadOnly([{ args: ["contract:verify"] }]),
    ).toThrow("contract:verify");
    expect(() =>
      assertGeneratedVerificationValidationsAreReadOnly([{ args: ["profile:check"] }]),
    ).toThrow("profile:check");
  });

  it("creates deterministic SaaS monetization contract canaries", () => {
    const source = `meterBindings: [{ meterKey: "api_requests", meterId: "polar-api-requests" }]\nusage: { supported: true }`;

    expect(createSaasMonetizationCanarySource(source, "unbound-meter")).toContain(
      "meterBindings: []",
    );
    expect(createSaasMonetizationCanarySource(source, "checkout-only-provider")).toContain(
      'usage: { supported: false, reason: "checkout only" }',
    );
  });
});

describe("generated template lint contracts", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts uniform lint scripts with configs and exact dependencies", () => {
    const templatesDir = createTempRoot();
    writeGeneratedLintTemplate(templatesDir, "blank");
    writeGeneratedLintTemplate(templatesDir, "saas");

    expect(() => assertGeneratedTemplateLintContracts(templatesDir)).not.toThrow();
  });

  it("rejects missing lint scripts and configs", () => {
    const missingScriptTemplates = createTempRoot();
    writeGeneratedLintTemplate(missingScriptTemplates, "blank", { lintCommand: undefined });
    expect(() => assertGeneratedTemplateLintContracts(missingScriptTemplates)).toThrow(
      "missing a lint script",
    );

    const missingConfigTemplates = createTempRoot();
    writeGeneratedLintTemplate(missingConfigTemplates, "blank", { writeConfig: false });
    expect(() => assertGeneratedTemplateLintContracts(missingConfigTemplates)).toThrow(
      "requires missing config",
    );
  });

  it("rejects non-exact linter dependencies", () => {
    const templatesDir = createTempRoot();
    writeGeneratedLintTemplate(templatesDir, "blank", { version: "^2.3.12" });

    expect(() => assertGeneratedTemplateLintContracts(templatesDir)).toThrow(
      "must use an exact version",
    );
  });

  it("rejects lint scripts that mask tool failures", () => {
    const templatesDir = createTempRoot();
    writeGeneratedLintTemplate(templatesDir, "blank", {
      lintCommand: "biome lint . || true",
    });

    expect(() => assertGeneratedTemplateLintContracts(templatesDir)).toThrow(
      "lint script must be exactly biome lint .",
    );
  });
});

describe("create-croco-app generated smoke journey report", () => {
  it("projects the seven stable user journeys from exact executed smoke steps", () => {
    const report = createGeneratedSmokeJourneyReport(
      createJourneySourceReport(),
      journeySourceCaseNames,
    );

    expect(report.schemaVersion).toBe("croco.generated-app-smoke-journeys/v1");
    expect(report.status).toBe("passed");
    expect(report.journeys.map(({ id }) => id)).toEqual(
      GENERATED_SMOKE_JOURNEY_DEFINITIONS.map(({ id }) => id),
    );
    expect(report.journeys.find(({ id }) => id === "create-app")).toMatchObject({
      status: "passed",
      sourceSelectors: [
        {
          caseName: "production-app-starter",
          stepLabels: ["generate", "install"],
        },
      ],
      commands: ["node create-croco-app production-app-starter", "pnpm install"],
      artifacts: ["evidence/create-app.json"],
      recoveryAction: "pnpm create-croco-app:smoke production-app-starter",
    });
    expect(report.journeys.find(({ id }) => id === "validate-contracts")?.sourceArtifacts).toEqual([
      "artifacts/production-app-starter/contract-graph.snapshot.json",
    ]);
    expect(report.journeys.find(({ id }) => id === "validate-contracts")?.artifacts).toContain(
      "proof/artifacts/production-app-starter/contract-graph.snapshot.json",
    );
    expect(report.journeys.find(({ id }) => id === "handle-expected-failures")).toMatchObject({
      status: "passed",
      diagnosticCodes: ["contract-route-missing-problem-response-contract"],
    });
  });

  it("accepts v1 and rejects malformed journey report schemas", () => {
    const report = createGeneratedSmokeJourneyReport(
      createJourneySourceReport(),
      journeySourceCaseNames,
    );
    assertGeneratedSmokeJourneyReport(report);
    const candidate = () =>
      structuredClone(report) as unknown as {
        schemaVersion: string;
        status: string;
        journeys: Array<{
          id: string;
          title?: string;
          status: string;
          recoveryAction: string;
          sourceSelectors: Array<{
            caseName: string;
            stepLabels: string[];
          }>;
        }>;
      };

    const unknownVersion = candidate();
    unknownVersion.schemaVersion = "croco.generated-app-smoke-journeys/v2";
    expect(() => assertGeneratedSmokeJourneyReport(unknownVersion)).toThrow("Unknown");

    const duplicateId = candidate();
    const duplicateJourney = duplicateId.journeys[1];
    if (!duplicateJourney) {
      throw new Error("missing duplicate journey fixture");
    }
    duplicateJourney.id = "create-app";
    expect(() => assertGeneratedSmokeJourneyReport(duplicateId)).toThrow("duplicate journey ID");

    const missingField = candidate();
    const missingFieldJourney = missingField.journeys[0];
    if (!missingFieldJourney) {
      throw new Error("missing required-field journey fixture");
    }
    delete missingFieldJourney.title;
    expect(() => assertGeneratedSmokeJourneyReport(missingField)).toThrow("title");

    const blankRecovery = candidate();
    const blankRecoveryJourney = blankRecovery.journeys[0];
    if (!blankRecoveryJourney) {
      throw new Error("missing recovery journey fixture");
    }
    blankRecoveryJourney.recoveryAction = "  ";
    expect(() => assertGeneratedSmokeJourneyReport(blankRecovery)).toThrow("recoveryAction");

    const unknownStatus = candidate();
    const unknownStatusJourney = unknownStatus.journeys[0];
    if (!unknownStatusJourney) {
      throw new Error("missing status journey fixture");
    }
    unknownStatusJourney.status = "skipped";
    expect(() => assertGeneratedSmokeJourneyReport(unknownStatus)).toThrow("unknown status");

    const changedSelector = candidate();
    const changedSelectorJourney = changedSelector.journeys[0];
    if (!changedSelectorJourney) {
      throw new Error("missing selector journey fixture");
    }
    changedSelectorJourney.sourceSelectors[0] = {
      caseName: "rest-spa-contracts",
      stepLabels: ["generate", "install"],
    };
    expect(() => assertGeneratedSmokeJourneyReport(changedSelector)).toThrow(
      "sourceSelectors do not match the canonical journey definition",
    );
  });

  it("does not report create-app as passed when dependency installation fails", () => {
    const source = createJourneySourceReport();
    const productionCase = source.cases[0];
    if (!productionCase) {
      throw new Error("missing production-app-starter fixture");
    }
    const report = createGeneratedSmokeJourneyReport(
      {
        ...source,
        status: "failed",
        cases: [
          {
            ...productionCase,
            status: "failed",
            error: "install failed",
            artifactBundle: {
              stdoutPath: "ci-reports/generated-apps/cases/production-app-starter/stdout.log",
              stderrPath: "ci-reports/generated-apps/cases/production-app-starter/stderr.log",
              files: ["ci-reports/generated-apps/cases/production-app-starter/files/package.json"],
            },
            steps: productionCase.steps.map((step) =>
              step.label === "install"
                ? { ...step, status: "failed", error: "install failed" }
                : step,
            ),
          },
          ...source.cases.slice(1),
        ],
      },
      journeySourceCaseNames,
      undefined,
      "ci-reports/generated-apps",
    );

    expect(report.journeys.find(({ id }) => id === "create-app")).toMatchObject({
      status: "failed",
      failure: "install failed",
    });
    expect(report.journeys.find(({ id }) => id === "create-app")?.sourceArtifacts).toEqual([
      "cases/production-app-starter/stdout.log",
      "cases/production-app-starter/stderr.log",
      "cases/production-app-starter/files/package.json",
    ]);
  });

  it("fails a journey when its source case fails after the selected steps pass", () => {
    const source = createJourneySourceReport();
    const productionCase = source.cases[0];
    if (!productionCase) {
      throw new Error("missing production-app-starter fixture");
    }

    const report = createGeneratedSmokeJourneyReport(
      {
        ...source,
        status: "failed",
        failure: "production case failed",
        cases: [
          {
            ...productionCase,
            status: "failed",
            error: "production case failed",
          },
          ...source.cases.slice(1),
        ],
      },
      journeySourceCaseNames,
    );

    expect(report.journeys.find(({ id }) => id === "run-local-api")).toMatchObject({
      status: "failed",
      failure: "production case failed",
    });
  });

  it("fails loudly when a passed source case omits an exact journey selector", () => {
    const source = createJourneySourceReport();
    const productionCase = source.cases[0];
    if (!productionCase) {
      throw new Error("missing production-app-starter fixture");
    }

    expect(() =>
      createGeneratedSmokeJourneyReport(
        {
          ...source,
          cases: [
            {
              ...productionCase,
              steps: productionCase.steps.filter(({ label }) => label !== "Contract diff"),
            },
            ...source.cases.slice(1),
          ],
        },
        journeySourceCaseNames,
      ),
    ).toThrow("validate-contracts selector drift");
  });

  it("keeps not-yet-reached journeys pending during progressive writes", () => {
    const source = createJourneySourceReport();
    const report = createGeneratedSmokeJourneyReport(
      {
        ...source,
        status: "pending",
        cases: source.cases.map((smokeCase) => ({
          ...smokeCase,
          status: "pending",
          steps: [],
        })),
      },
      journeySourceCaseNames,
    );

    expect(report.status).toBe("pending");
    expect(
      report.journeys.every(
        ({ status, commands }) => status === "pending" && commands.length === 0,
      ),
    ).toBe(true);
  });

  it("propagates a terminal blocking bootstrap failure to every untouched journey", () => {
    const source = createJourneySourceReport();
    const bootstrapCommand = "node turbo build --filter=create-croco-app... --force";
    const report = createGeneratedSmokeJourneyReport(
      {
        ...source,
        status: "failed",
        failure: "bootstrap failed",
        gates: [
          {
            label: "create-croco-app CLI bootstrap",
            command: bootstrapCommand,
            tier: "spine-blocking",
            status: "failed",
            error: "bootstrap failed",
          },
        ],
        cases: source.cases.map((smokeCase) => ({
          ...smokeCase,
          status: "pending",
          steps: [],
        })),
      },
      journeySourceCaseNames,
    );

    expect(report.status).toBe("failed");
    expect(
      report.journeys.every(
        ({ status, commands, failure }) =>
          status === "failed" &&
          commands.includes(bootstrapCommand) &&
          failure === "bootstrap failed",
      ),
    ).toBe(true);
  });

  it("writes a self-contained bundle whose Markdown evidence links all resolve", () => {
    const root = createTempRoot();
    const sourceRoot = join(root, "source");
    const sourceArtifact = join(
      sourceRoot,
      "artifacts",
      "production-app-starter",
      "contract-graph.snapshot.json",
    );
    mkdirSync(dirname(sourceArtifact), { recursive: true });
    writeFileSync(sourceArtifact, '{"version":"croco.contract-graph.v1"}\n');
    const outputDir = join(root, "journeys");
    const report = createGeneratedSmokeJourneyReport(
      createJourneySourceReport(),
      journeySourceCaseNames,
    );

    writeGeneratedSmokeJourneyBundle(outputDir, report, sourceRoot);

    const markdown = readFileSync(join(outputDir, "report.md"), "utf8");
    expect(markdown).toBe(renderGeneratedSmokeJourneyReport(report));
    expect(readFileSync(join(outputDir, "report.json"), "utf8")).toContain(
      '"schemaVersion": "croco.generated-app-smoke-journeys/v1"',
    );
    for (const journey of report.journeys) {
      const relativePath = `evidence/${journey.id}.json`;
      expect(markdown).toContain(`[${relativePath}](${relativePath})`);
      expect(readFileSync(join(outputDir, relativePath), "utf8")).toContain(
        `"id": "${journey.id}"`,
      );
    }
    expect(
      readFileSync(
        join(
          outputDir,
          "proof",
          "artifacts",
          "production-app-starter",
          "contract-graph.snapshot.json",
        ),
        "utf8",
      ),
    ).toContain("croco.contract-graph.v1");
  });

  it("preserves the previous bundle when staging a replacement fails", () => {
    const outputDir = join(createTempRoot(), "journeys");
    const sentinelPath = join(outputDir, "sentinel.txt");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(sentinelPath, "previous bundle\n");
    const report = createGeneratedSmokeJourneyReport(
      createJourneySourceReport(),
      journeySourceCaseNames,
    );

    expect(() => writeGeneratedSmokeJourneyBundle(outputDir, report)).toThrow(
      "requires a source root",
    );
    expect(readFileSync(sentinelPath, "utf8")).toBe("previous bundle\n");
  });

  it("preserves the canonical bundle for advisory, unfiltered, and named selections", () => {
    const outputDir = join(createTempRoot(), "journeys");
    const sentinelPath = join(outputDir, "sentinel.txt");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(sentinelPath, "canonical\n");
    const rejectedSelections = [
      {
        selectedCaseNames: ["advisory"],
        spineCaseNames: journeySourceCaseNames,
        selectedTier: "ecosystem-advisory",
        requestedCaseNames: [],
      },
      {
        selectedCaseNames: [...journeySourceCaseNames, "advisory"],
        spineCaseNames: journeySourceCaseNames,
        requestedCaseNames: [],
      },
      {
        selectedCaseNames: ["production-app-starter"],
        spineCaseNames: journeySourceCaseNames,
        selectedTier: "spine-blocking",
        requestedCaseNames: ["production-app-starter"],
      },
      {
        selectedCaseNames: journeySourceCaseNames,
        spineCaseNames: journeySourceCaseNames,
        selectedTier: "spine-blocking",
        requestedCaseNames: journeySourceCaseNames,
      },
    ];

    for (const selection of rejectedSelections) {
      expect(isCanonicalGeneratedSmokeJourneySelection(selection)).toBe(false);
      expect(
        writeCanonicalGeneratedSmokeJourneyBundle({
          selection,
          outputDir,
          createReport: () => {
            throw new Error("partial selection must not project or write the canonical report");
          },
        }),
      ).toBe(false);
      expect(readFileSync(sentinelPath, "utf8")).toBe("canonical\n");
    }
    expect(
      isCanonicalGeneratedSmokeJourneySelection({
        selectedCaseNames: journeySourceCaseNames,
        spineCaseNames: journeySourceCaseNames,
        selectedTier: "spine-blocking",
        requestedCaseNames: [],
      }),
    ).toBe(true);
  });
});

describe("create-croco-app-generated-smoke dependency resolution", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("resolves template-only generated Croco dependencies from the workspace index", () => {
    const root = createTempRoot();
    const projectDir = join(root, "generated-app");
    writeWorkspacePackage(root, "template-only", "@croco/template-only", {
      "@croco/transitive-only": "workspace:*",
    });
    writeWorkspacePackage(root, "transitive-only", "@croco/transitive-only");
    writeGeneratedPackage(projectDir, "package.json", {
      name: "generated-app",
      dependencies: {
        "@croco/template-only": "^0.0.0",
      },
    });

    const workspacePackageIndex = createWorkspacePackageIndex(root);
    const workspacePackages = resolveLocalCrocoPackagesForGeneratedProject(
      projectDir,
      workspacePackageIndex,
    );

    expect(workspacePackages.map(({ name }) => name)).toEqual([
      "@croco/template-only",
      "@croco/transitive-only",
    ]);
  });

  it("fails when a generated manifest references an unhandled Croco dependency", () => {
    const root = createTempRoot();
    const projectDir = join(root, "generated-app");
    writeGeneratedPackage(projectDir, "package.json", {
      name: "generated-app",
      dependencies: {
        "@croco/missing-workspace": "^0.0.0",
      },
    });

    const workspacePackageIndex = createWorkspacePackageIndex(root);

    expect(() =>
      resolveLocalCrocoPackagesForGeneratedProject(projectDir, workspacePackageIndex),
    ).toThrow(
      "Generated project package.json references @croco/missing-workspace, but it is not a local @croco workspace package and has no explicit generated-smoke external exception",
    );
  });

  it("rewrites external Croco dependencies while preserving generated workspace package names", () => {
    const root = createTempRoot();
    const projectDir = join(root, "generated-app");
    writeGeneratedPackage(projectDir, "package.json", {
      name: "generated-app",
      dependencies: {
        "@croco/provider-rpc": "workspace:*",
        "@croco/template-only": "^0.0.0",
      },
    });
    writeGeneratedPackage(projectDir, "libs/provider-rpc/package.json", {
      name: "@croco/provider-rpc",
      version: "0.0.0",
    });

    rewriteExternalCrocoRanges(projectDir, {
      "@croco/template-only": "file:/tmp/template-only.tgz",
    });

    const packageJson = readGeneratedPackage(projectDir, "package.json");
    expect(packageJson.dependencies?.["@croco/template-only"]).toBe("file:/tmp/template-only.tgz");
    expect(packageJson.dependencies?.["@croco/provider-rpc"]).toBe("workspace:*");
  });

  it("allows published-range fallback only through explicit external exceptions", () => {
    const root = createTempRoot();
    const projectDir = join(root, "generated-app");
    const externalExceptions = {
      "@croco/external-only": {
        range: "^9.0.0",
        reason: "fixture package that intentionally has no local workspace package",
      },
    };
    writeGeneratedPackage(projectDir, "package.json", {
      name: "generated-app",
      dependencies: {
        "@croco/external-only": "workspace:*",
      },
    });

    const workspacePackageIndex = createWorkspacePackageIndex(root);
    const workspacePackages = resolveLocalCrocoPackagesForGeneratedProject(
      projectDir,
      workspacePackageIndex,
      externalExceptions,
    );
    rewriteExternalCrocoRanges(projectDir, {}, externalExceptions);

    const packageJson = readGeneratedPackage(projectDir, "package.json");
    expect(workspacePackages).toEqual([]);
    expect(packageJson.dependencies?.["@croco/external-only"]).toBe("^9.0.0");
  });

  it("writes local tarball overrides to pnpm-workspace.yaml", () => {
    const root = createTempRoot();
    const projectDir = join(root, "generated-app");
    writeGeneratedPackage(projectDir, "package.json", {
      name: "generated-app",
      dependencies: {
        "@croco/template-only": "^0.0.0",
      },
    });
    writeFileSync(
      join(projectDir, "pnpm-workspace.yaml"),
      [
        "packages:",
        '  - "apps/**/*"',
        "",
        "overrides:",
        "  sharp: 0.35.4",
        "",
        "onlyBuiltDependencies:",
        "  - esbuild",
        "",
      ].join("\n"),
    );

    writePnpmWorkspaceOverrides(projectDir, {
      "@croco/template-only": "file:/tmp/template-only.tgz",
    });

    const workspaceConfig = readFileSync(join(projectDir, "pnpm-workspace.yaml"), "utf8");
    const packageJson = readGeneratedPackage(projectDir, "package.json") as {
      readonly pnpm?: unknown;
    };

    expect(workspaceConfig).toContain('packages:\n  - "apps/**/*"');
    expect(workspaceConfig).toContain("onlyBuiltDependencies:\n  - esbuild");
    expect(workspaceConfig).toContain('"sharp": "0.35.4"');
    expect(workspaceConfig).toContain(
      'overrides:\n  "@croco/template-only": "file:/tmp/template-only.tgz"',
    );
    expect(packageJson.pnpm).toBeUndefined();
  });

  it("reports malformed generated secret allowlist metadata with smoke case context", () => {
    const root = createTempRoot();
    const metadataPath = join(root, "security-allowlist-metadata.json");
    writeFileSync(metadataPath, "{ invalid-json");

    expect(() => readGeneratedSmokeAllowlistMetadata(metadataPath, "saas-golden-path")).toThrow(
      /saas-golden-path generated secret allowlist metadata is invalid JSON:/,
    );
  });

  it("rejects generated Astryx metadata that drifts from the presentation profile catalog", () => {
    const root = createTempRoot();
    const projectDir = join(root, "generated-app");
    const catalogPath = join(root, "runtime-profiles.json");
    const ui = {
      name: "astryx",
      styleEngine: "stylex",
      requiresStylexCompile: false,
      maturity: "beta",
      generatedAppSmokeCase: "graphql-vite-spa-astryx",
    };
    const profile = { webApp: "web", runtimeProfile: "browser-vite-spa-astryx", ui };
    writeGeneratedPackage(projectDir, "apps/web/croco.presentation-profile.json", profile);
    writeGeneratedPackage(projectDir, "croco-presentation-profile.manifest.json", {
      schemaVersion: "croco.generated-presentation-profile/v1",
      profiles: [profile],
    });
    writeGeneratedPackage(root, "runtime-profiles.json", {
      profiles: [
        {
          name: "browser-vite-spa-astryx",
          generatedAppSmokeCase: "graphql-vite-spa-astryx",
          ui,
        },
      ],
    });

    expect(() =>
      assertGeneratedPresentationProfileMatchesCatalog(
        projectDir,
        "apps/web/croco.presentation-profile.json",
        "browser-vite-spa-astryx",
        "graphql-vite-spa-astryx",
        catalogPath,
      ),
    ).not.toThrow();

    writeGeneratedPackage(projectDir, "apps/web/croco.presentation-profile.json", {
      ...profile,
      ui: { ...ui, maturity: "alpha" },
    });
    expect(() =>
      assertGeneratedPresentationProfileMatchesCatalog(
        projectDir,
        "apps/web/croco.presentation-profile.json",
        "browser-vite-spa-astryx",
        "graphql-vite-spa-astryx",
        catalogPath,
      ),
    ).toThrow("does not match browser-vite-spa-astryx");
  });

  it("copies configured smoke artifacts into the report tree and renders matrix evidence", () => {
    const root = createTempRoot();
    const generatedProjectDir = join(root, "generated-app");
    const reportDir = join(root, "ci-reports", "generated-apps");
    const scenarioPath = "ci-reports/saas-golden-path/scenario.json";
    writeGeneratedPackage(generatedProjectDir, scenarioPath, {
      schemaVersion: "croco.saas-golden-path.scenario/v1",
    });

    const artifacts = copyGeneratedSmokeArtifacts({
      generatedSmokeReportDir: reportDir,
      smokeCaseName: "saas-golden-path",
      validationDir: generatedProjectDir,
      artifactPaths: [scenarioPath],
    });

    expect(artifacts).toEqual([
      {
        sourcePath: join(generatedProjectDir, scenarioPath),
        reportPath: join(
          reportDir,
          "artifacts",
          "saas-golden-path",
          "ci-reports",
          "saas-golden-path",
          "scenario.json",
        ),
        reportRelativePath: "artifacts/saas-golden-path/ci-reports/saas-golden-path/scenario.json",
      },
    ]);
    expect(readFileSync(artifacts[0].reportPath, "utf8")).toContain(
      '"schemaVersion": "croco.saas-golden-path.scenario/v1"',
    );
    expect(renderGeneratedSmokeArtifacts(artifacts)).toContain(
      "`artifacts/saas-golden-path/ci-reports/saas-golden-path/scenario.json`",
    );
  });
});

describe("create-croco-app generated smoke matrix", () => {
  it("executes every supported goal manifest and declared quality gate", () => {
    const goalCases = new Map(
      getGeneratedGoalSmokeCaseInputs().map((smokeCase) => [smokeCase.goal, smokeCase]),
    );

    expect([...goalCases.keys()]).toEqual(SUPPORTED_CREATE_CROCO_APP_CHOICES.goals);
    for (const goal of SUPPORTED_CREATE_CROCO_APP_CHOICES.goals) {
      const smokeCase = goalCases.get(goal);
      expect(smokeCase?.name).toBe(`goal-${goal}`);
      expect(smokeCase?.manifest).toEqual({
        ...GOAL_SPECS[goal].manifest,
        projectName: `goal-${goal}`,
        scope: "@smoke",
      });
      for (const qualityGate of GOAL_SPECS[goal].manifest.qualityGates) {
        expect(smokeCase?.executedQualityGates, `${goal} ${qualityGate}`).toContain(qualityGate);
      }
    }
  });

  it("installs Chromium before browser-backed goal tests", () => {
    const cases = new Map(
      getGeneratedSmokeDependencyCaseInputs().map((smokeCase) => [smokeCase.name, smokeCase]),
    );

    for (const caseName of ["goal-spa-backend-split", "goal-internal-tool"]) {
      const validations = cases.get(caseName)?.validations ?? [];
      const chromiumInstallIndex = validations.findIndex(
        ({ args }) => args?.[0] === "test:browser:install",
      );
      const testIndex = validations.findIndex(({ args }) => args?.[0] === "test");

      expect(chromiumInstallIndex, caseName).toBeGreaterThanOrEqual(0);
      expect(testIndex, caseName).toBeGreaterThan(chromiumInstallIndex);
    }
  });

  it("shares Playwright browsers cache path and optimizes redundant admin-console journeys", () => {
    expect(RESOLVED_PLAYWRIGHT_BROWSERS_PATH).toBeTruthy();
    const cases = new Map(
      getGeneratedSmokeDependencyCaseInputs().map((smokeCase) => [smokeCase.name, smokeCase]),
    );
    const adminCase = cases.get("admin-console-starter");
    const journeyValidation = adminCase?.validations.find(
      ({ label }) => label === "browser journeys",
    );
    expect(journeyValidation?.args).toEqual([
      "test:journey",
      "tests/journeys/plan-release.spec.ts",
    ]);
    expect(journeyValidation?.paths).toEqual(["tests/journeys/plan-release.spec.ts"]);
  });

  it("executes generated tests for Meta Vite smoke cases", () => {
    const cases = new Map(
      getGeneratedSmokeDependencyCaseInputs().map((smokeCase) => [smokeCase.name, smokeCase]),
    );
    const generatedTestValidation = {
      args: ["test"],
      label: "test",
      packagePath: ["libs", "shared", "utils-env"],
    };

    expect(cases.get("meta-vite-web")?.validations).toContainEqual(generatedTestValidation);
    expect(cases.get("meta-vite-fullstack-workers")?.validations).toContainEqual(
      generatedTestValidation,
    );
  });

  it("invokes representative Lambda and Workers host artifacts", () => {
    const cases = new Map(
      getGeneratedSmokeDependencyCaseInputs().map((smokeCase) => [smokeCase.name, smokeCase]),
    );

    expect(cases.get("graphql-lambda-api")?.validations).toContainEqual(
      expect.objectContaining({
        label: "protected GraphQL route smoke",
        packagePath: ["apps", "graphql-api"],
      }),
    );
    expect(cases.get("meta-vite-fullstack-workers")?.validations).toContainEqual(
      expect.objectContaining({
        label: "api-worker secure fetch smoke",
        packagePath: ["ssr-worker"],
      }),
    );
  });

  it("keeps REST SPA contract canaries selectable in the blocking tier", () => {
    expect(
      GENERATED_SMOKE_MATRIX_CASES.find(({ name }) => name === "rest-spa-contracts")?.tier,
    ).toBe("spine-blocking");
    expect(
      selectGeneratedSmokeMatrixCases(GENERATED_SMOKE_MATRIX_CASES, {
        args: ["rest-spa-contracts"],
      }).cases.map(({ name }) => name),
    ).toEqual(["rest-spa-contracts"]);
  });

  it("classifies every generated smoke case and requires advisory recovery metadata", () => {
    expect(
      GENERATED_SMOKE_MATRIX_CASES.filter(({ tier }) => tier === "spine-blocking").map(
        ({ name }) => name,
      ),
    ).toEqual([
      "goal-saas-api",
      "goal-spa-backend-split",
      "goal-worker",
      "goal-internal-tool",
      "graphql-lambda-api",
      "graphql-vite-spa-docker",
      "meta-vite-fullstack-workers",
      "production-app-starter",
      "saas-golden-path",
      "rest-spa-contracts",
    ]);
    expect(
      GENERATED_SMOKE_MATRIX_CASES.filter(({ tier }) => tier === "ecosystem-advisory"),
    ).toHaveLength(11);
    const graphqlLambdaApiCase: SmokeMatrixCaseDefinition | undefined =
      GENERATED_SMOKE_MATRIX_CASES.find(({ name }) => name === "graphql-lambda-api");
    expect(graphqlLambdaApiCase?.advisory).toBeUndefined();

    expect(() =>
      assertGeneratedSmokeMatrixContract([
        {
          ...GENERATED_SMOKE_MATRIX_CASES[0],
          advisory: { owner: "", recoveryAction: "recover" },
        },
      ]),
    ).toThrow("requires owner and recoveryAction");
  });

  it("intersects named cases with the selected tier and rejects mismatches", () => {
    const selection = selectGeneratedSmokeMatrixCases(GENERATED_SMOKE_MATRIX_CASES, {
      args: ["--", "--tier", "spine-blocking"],
    });

    expect(selection.cases.map(({ name }) => name)).toEqual([
      "goal-saas-api",
      "goal-spa-backend-split",
      "goal-worker",
      "goal-internal-tool",
      "graphql-lambda-api",
      "graphql-vite-spa-docker",
      "meta-vite-fullstack-workers",
      "production-app-starter",
      "saas-golden-path",
      "rest-spa-contracts",
    ]);
    expect(() =>
      selectGeneratedSmokeMatrixCases(GENERATED_SMOKE_MATRIX_CASES, {
        args: ["--tier", "spine-blocking", "blank-basic"],
      }),
    ).toThrow("do not belong to selected tier spine-blocking");
  });

  it("preserves canonical tier state and rebuilds aggregate release status from spine evidence", () => {
    const spine = createGeneratedSmokeMatrixTierReport(
      "spine-blocking",
      GENERATED_SMOKE_MATRIX_CASES.filter(({ tier }) => tier === "spine-blocking").map(
        ({ name }) => ({
          name,
          status: "passed" as const,
        }),
      ),
      { filteredRun: false, generatedAt: "2026-07-10T00:00:00.000Z" },
    );
    const firstAdvisory = createGeneratedSmokeMatrixTierReport(
      "ecosystem-advisory",
      [{ name: "blank-basic", status: "failed" }],
      { filteredRun: true, generatedAt: "2026-07-10T00:01:00.000Z" },
    );
    const advisory = createGeneratedSmokeMatrixTierReport(
      "ecosystem-advisory",
      [{ name: "graphql-standalone-api", status: "passed" }],
      {
        filteredRun: true,
        previousReport: firstAdvisory,
        generatedAt: "2026-07-10T00:02:00.000Z",
      },
    );
    const aggregate = createGeneratedSmokeMatrixAggregateReport(
      { "spine-blocking": spine, "ecosystem-advisory": advisory },
      "2026-07-10T00:03:00.000Z",
    );

    expect(advisory.cases.find(({ name }) => name === "blank-basic")?.status).toBe("failed");
    expect(advisory.cases.find(({ name }) => name === "graphql-standalone-api")?.status).toBe(
      "passed",
    );
    expect(aggregate.release.status).toBe("passed");
    expect(aggregate.status).toBe("failed");
    expect(renderGeneratedSmokeMatrixReport(advisory)).toContain(
      "create-croco-app blank template owner",
    );
    expect(renderGeneratedSmokeMatrixReport(advisory)).toContain(
      "CROCO_GENERATED_SMOKE_CASES=blank-basic pnpm create-croco-app:smoke",
    );
  });

  it("retains an owner and recovery action for tier-level failures", () => {
    const spine = createGeneratedSmokeMatrixTierReport(
      "spine-blocking",
      GENERATED_SMOKE_MATRIX_CASES.filter(({ tier }) => tier === "spine-blocking").map(
        ({ name }) => ({
          name,
          status: "passed" as const,
        }),
      ),
      {
        filteredRun: true,
        failure: {
          message: "create-croco-app CLI bootstrap failed",
          owner: "create-croco-app release spine owner",
          recoveryAction: "Repair the bootstrap command and rerun the spine tier.",
        },
      },
    );

    expect(spine.status).toBe("failed");
    expect(renderGeneratedSmokeMatrixReport(spine)).toContain(
      "create-croco-app release spine owner",
    );
    expect(renderGeneratedSmokeMatrixReport(spine)).toContain(
      "Repair the bootstrap command and rerun the spine tier.",
    );
  });

  it("treats missing or stale tier reports as pending aggregate evidence", () => {
    const spine = createGeneratedSmokeMatrixTierReport(
      "spine-blocking",
      GENERATED_SMOKE_MATRIX_CASES.filter(({ tier }) => tier === "spine-blocking").map(
        ({ name }) => ({ name, status: "passed" as const }),
      ),
      { filteredRun: true, generatedAt: "2026-07-10T00:00:00.000Z" },
    );
    const advisory = createGeneratedSmokeMatrixTierReport(
      "ecosystem-advisory",
      [{ name: "blank-basic", status: "passed" }],
      { filteredRun: true, generatedAt: "2026-07-10T00:00:00.000Z" },
    );
    const aggregate = createGeneratedSmokeMatrixAggregateReport(
      {
        "spine-blocking": {
          ...spine,
          release: { ...spine.release, status: "pending" },
        },
        "ecosystem-advisory": advisory,
      },
      "2026-07-10T00:01:00.000Z",
    );

    expect(aggregate.release.status).toBe("pending");
    expect(aggregate.tiers).toContainEqual({ tier: "spine-blocking", status: "pending" });

    const aggregateWithStaleAdvisoryMetadata = createGeneratedSmokeMatrixAggregateReport(
      {
        "spine-blocking": spine,
        "ecosystem-advisory": {
          ...advisory,
          cases: advisory.cases.map((smokeCase) => ({
            ...smokeCase,
            advisory: { ...smokeCase.advisory, owner: "stale owner" },
          })),
        },
      },
      "2026-07-10T00:02:00.000Z",
    );

    expect(aggregateWithStaleAdvisoryMetadata.tiers).toContainEqual({
      tier: "ecosystem-advisory",
      status: "pending",
    });
  });
});

describe("create-croco-app generated smoke failure evidence", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("retains recovery details and artifact paths in the blocking-tier matrix report", () => {
    const spine = createGeneratedSmokeMatrixTierReport(
      "spine-blocking",
      [
        {
          name: "rest-spa-contracts",
          status: "failed",
          failureEvidence: {
            error: "contract graph drift detected",
            diagnosticCodes: ["CROCO_CONTRACT_DRIFT"],
            recovery: createSmokeRecoverySummary("rest-spa-contracts"),
            classification: classifySmokeFailure({ message: "contract graph drift detected" }),
            artifactBundle: {
              path: "ci-reports/generated-apps/cases/rest-spa-contracts",
              stdoutPath: "ci-reports/generated-apps/cases/rest-spa-contracts/stdout.log",
              stderrPath: "ci-reports/generated-apps/cases/rest-spa-contracts/stderr.log",
              files: [
                "ci-reports/generated-apps/cases/rest-spa-contracts/files/.croco/manifest/routes.json",
              ],
              outputTruncated: true,
            },
          },
        },
      ],
      { filteredRun: true, generatedAt: "2026-07-10T00:00:00.000Z" },
    );

    const rendered = renderGeneratedSmokeMatrixReport(spine);

    expect(spine.cases.find(({ name }) => name === "rest-spa-contracts")?.failureEvidence).toEqual(
      expect.objectContaining({ error: "contract graph drift detected" }),
    );
    expect(rendered).toContain("## Failed Case Recovery");
    expect(rendered).toContain("pnpm create-croco-app:smoke rest-spa-contracts");
    expect(rendered).toContain("ci-reports/generated-apps/cases/rest-spa-contracts/stdout.log");
    expect(rendered).toContain("truncated at 64 MiB");
  });

  it("classifies command output from captured stdout and stderr without assertion text", () => {
    const commandFailure = {
      message:
        "corepack pnpm check failed without expected output: ETIMEDOUT CROCO_EXPECTED_DIAGNOSTIC",
      stdout: "contract validation failed",
      stderr: "CROCO_CONTRACT_DRIFT",
      signal: null,
    };

    expect(extractSmokeCommandDiagnosticCodes(commandFailure)).toEqual(["CROCO_CONTRACT_DRIFT"]);
    expect(classifySmokeCommandFailure(commandFailure)).toEqual({
      kind: "deterministic",
      reason:
        "no transient timeout, network, DNS, socket, fetch, or termination indicator detected",
    });
  });

  it("reads complete Unicode command-output segments", () => {
    const root = createTempRoot();
    const outputPath = join(root, "command-output.log");
    const output = "first line\\nemoji: \\u{1F642}\\nlast line\\n";
    writeFileSync(outputPath, output, "utf8");

    const fileDescriptor = openSync(outputPath, "r");
    try {
      expect(readCommandOutputSegment(fileDescriptor, Buffer.byteLength(output), 0)).toBe(output);
    } finally {
      closeSync(fileDescriptor);
    }
  });

  it("keeps only relevant generated files in a failure artifact bundle", () => {
    const projectDir = createTempRoot();
    writeFile(join(projectDir, "package.json"), "{}\n");
    writeFile(join(projectDir, ".croco/manifest/routes.json"), "{}\n");
    writeFile(
      join(projectDir, "apps/api-server/src/controllers/userSchemas.ts"),
      "export const userSchemas = {};\n",
    );
    writeFile(join(projectDir, "node_modules/example/package.json"), "{}\n");

    const artifactPaths = collectSmokeFailureArtifactFiles(projectDir, "rest-spa-contracts").map(
      (path) => path.slice(projectDir.length + 1),
    );

    expect(shouldIncludeSmokeFailureArtifact("croco-runtime-capability.manifest.json")).toBe(true);
    expect(shouldIncludeSmokeFailureArtifact("node_modules/package/package.json")).toBe(false);
    expect(shouldSkipSmokeArtifactDirectory(".next")).toBe(true);
    expect(artifactPaths).toContain(".croco/manifest/routes.json");
    expect(artifactPaths).toContain("apps/api-server/src/controllers/userSchemas.ts");
    expect(artifactPaths).toContain("package.json");
    expect(artifactPaths).not.toContain("node_modules/example/package.json");
  });
});

function createJourneySourceReport(): GeneratedSmokeJourneySourceReport {
  const step = (
    label: string,
    command: string,
    options: {
      readonly artifacts?: readonly string[];
      readonly diagnosticCodes?: readonly string[];
    } = {},
  ) => ({
    label,
    command,
    artifacts: (options.artifacts ?? []).map((reportRelativePath) => ({ reportRelativePath })),
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
        recovery: {
          localRerunCommand: "pnpm create-croco-app:smoke production-app-starter",
        },
        steps: [
          step("generate", "node create-croco-app production-app-starter"),
          step("install", "pnpm install"),
          step("dev smoke", "pnpm dev:smoke"),
          step("Contract snapshot", "pnpm contract:snapshot", {
            artifacts: ["artifacts/production-app-starter/contract-graph.snapshot.json"],
          }),
          step("Contract coverage", "pnpm contract:coverage"),
          step("Contract diff", "pnpm contract:diff"),
          step("OpenAPI contract", "pnpm contract:openapi"),
          step("RPC client", "pnpm contract:client"),
          step("DI graph verify", "pnpm di:verify"),
        ],
      },
      {
        name: "graphql-lambda-api",
        status: "passed",
        recovery: { localRerunCommand: "pnpm create-croco-app:smoke graphql-lambda-api" },
        steps: [
          step(
            "protected GraphQL route smoke",
            "pnpm --dir apps/graphql-api exec tsx --eval <lambda-handler-smoke>",
          ),
        ],
      },
      {
        name: "rest-spa-contracts",
        status: "passed",
        recovery: { localRerunCommand: "pnpm create-croco-app:smoke rest-spa-contracts" },
        steps: [
          step("strict Problem declaration canary", "pnpm exec croco-rpc-codegen --check", {
            diagnosticCodes: ["contract-route-missing-problem-response-contract"],
          }),
          step("strict OpenAPI schema canary", "pnpm exec croco-openapi-spec"),
          step("strict RPC schema canary", "pnpm exec croco-rpc-codegen"),
        ],
      },
    ],
  };
}

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "croco-generated-smoke-test-"));
  tempRoots.push(root);
  mkdirSync(join(root, "packages"), { recursive: true });

  return root;
}

function writeGeneratedLintTemplate(
  templatesDir: string,
  template: string,
  options: {
    readonly lintCommand?: string;
    readonly version?: string;
    readonly writeConfig?: boolean;
  } = {},
): void {
  const templateDir = join(templatesDir, template);
  const lintCommand = Object.hasOwn(options, "lintCommand") ? options.lintCommand : "biome lint .";
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(
    join(templateDir, "package.json.hbs"),
    `${JSON.stringify(
      {
        scripts: lintCommand === undefined ? {} : { lint: lintCommand },
        devDependencies: { "@biomejs/biome": options.version ?? "2.3.12" },
      },
      null,
      2,
    )}\n`,
  );
  if (options.writeConfig !== false) {
    writeFileSync(join(templateDir, "biome.json"), "{}\n");
  }
}

function writeWorkspacePackage(
  root: string,
  packageDirName: string,
  packageName: string,
  dependencies: Record<string, string> = {},
): void {
  writeJson(join(root, "packages", packageDirName, "package.json"), {
    name: packageName,
    version: "0.0.0",
    dependencies,
  });
}

function writeGeneratedPackage(
  projectDir: string,
  relativePath: string,
  packageJson: Record<string, unknown>,
): void {
  writeJson(join(projectDir, relativePath), packageJson);
}

function readGeneratedPackage(
  projectDir: string,
  relativePath: string,
): {
  readonly dependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(projectDir, relativePath), "utf8")) as {
    readonly dependencies?: Record<string, string>;
  };
}

function writeJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
