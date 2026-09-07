import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCurrentRunAttestation,
  createProducerBundle,
  evidenceDigest,
  PRODUCER_LANES,
} from "../ci-lane-evidence.mts";
import { cacheableInputDigest, changedFilesDigest } from "../ci-cacheable-experiment-identity.mts";
import {
  assembleSynthesisInput,
  parseSynthesisInput,
  PRODUCER_FACTS_FILE,
  PRODUCER_FACTS_SCHEMA,
  SYNTHESIS_INPUT_SCHEMA,
} from "../ci-synthesis-input.mts";
import {
  productionReadyFastTestLaneReport,
  runSplitValidationSynthesis,
} from "../ci-split-validation-synthesis.mts";
import { SECURITY_OWNERSHIP } from "../ci-verification-contract.mts";
import { inventoryDigest } from "../test-inventory.mts";
import { VERIFICATION_LANE_OWNERSHIP } from "../verification-manifest.mts";
import type { ExperimentIdentity, ProducerBundle, ProducerLane } from "../ci-lane-evidence.mts";
import type { ProducerFacts } from "../ci-synthesis-input.mts";
import type { LaneReport } from "../test-evidence-reconcile.mts";
import type { TestInventory } from "../test-inventory.mts";
import type { VerificationProfile } from "../verification-manifest.mts";

const inventory: TestInventory = { version: 1, tests: [], exceptions: [] };
const BASE_SHA = "e".repeat(40);
const INVENTORY_FILE_DIGEST = "f".repeat(64);
const CHANGED_FILES_DIGEST = changedFilesDigest([]);
const identity: ExperimentIdentity = {
  architectureVersion: "shadow-split",
  commitSha: "a".repeat(40),
  runId: "777",
  runAttempt: 2,
  profile: "publish",
  manifestDigest: "b".repeat(64),
  inventoryDigest: inventoryDigest(inventory),
  toolchainDigest: "c".repeat(64),
  inputDigest: cacheableInputDigest({
    commitSha: "a".repeat(40),
    workflowDigest: "b".repeat(64),
    inventoryFileDigest: INVENTORY_FILE_DIGEST,
    toolchainDigest: "c".repeat(64),
    baseSha: BASE_SHA,
    changedFilesDigest: CHANGED_FILES_DIGEST,
  }),
  verificationExperimentId: "777-2-cacheable",
};

const publicApi = {
  status: "not-collected",
  packageCount: null,
  changedPackages: null,
  changedEntrypoints: null,
  entrypointsAdded: null,
  entrypointsRemoved: null,
  targetChanges: null,
  runtimeAdded: null,
  runtimeRemoved: null,
  typeAdded: null,
  typeRemoved: null,
  snapshotPath: "public-api.json",
  reportPath: "ci-reports/package-quality/public-api-summary.json",
  updateCommand: "pnpm public-api:write",
} as const;

function digest(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function ownedIds(lane: ProducerLane): readonly string[] {
  return Object.entries(VERIFICATION_LANE_OWNERSHIP)
    .filter(([, owner]) => owner === lane)
    .map(([id]) => id);
}

function facts(
  lane: ProducerLane,
  options: {
    readonly fastLane?: LaneReport | null;
    readonly inventory?: TestInventory;
    readonly productionReadyRequireTaskSummaries?: boolean;
  } = {},
): ProducerFacts {
  if (lane === "core-verification") {
    return {
      schemaVersion: PRODUCER_FACTS_SCHEMA,
      lane,
      inventory: options.inventory ?? inventory,
      fastLane: options.fastLane ?? null,
      integrationLane: null,
      packageTasks: [],
      productionReadyRequireTaskSummaries: options.productionReadyRequireTaskSummaries ?? true,
      bundleSize: {
        ciMode: "warning-only",
        enforceSpineBundleSize: false,
        baselinePath: "ci-reports/bundle-size/baseline.json",
        reportPath: "ci-reports/package-quality/bundle-size.md",
        localCommand: "pnpm package-quality:report",
        deltaPolicy: {
          kind: "global",
          allowedPositiveDeltaBytes: 0,
          description: "fixture",
        },
        spinePackageNames: [],
        measuredPackageCount: 0,
        artifactCount: 0,
        missingBaselineCount: 0,
        overBaselineCount: 0,
        unmatchedBaselineCount: 0,
        notBuiltPackageCount: 0,
        spineBlockingRegressionCount: 0,
        spineBlockingSetupIssueCount: 0,
        spineBlockingUnmatchedBaselineCount: 0,
        spineBlockingIssueCount: 0,
        nonSpineAdvisoryWarningCount: 0,
        advisoryWarningCount: 0,
        unmatchedBaselines: [],
        blockingUnmatchedBaselines: [],
        artifacts: [],
      },
    };
  }
  if (lane === "generated-apps") {
    return {
      schemaVersion: PRODUCER_FACTS_SCHEMA,
      lane,
      requiredSourcePaths: [],
      executedSourcePaths: [],
      materializations: [],
      promotionArtifacts: [],
    };
  }
  if (lane === "package-artifacts") {
    return {
      schemaVersion: PRODUCER_FACTS_SCHEMA,
      lane,
      publishedLane: null,
      publicApi,
      promotionArtifacts: [],
    };
  }
  return {
    schemaVersion: PRODUCER_FACTS_SCHEMA,
    lane,
    securityPhysical: SECURITY_OWNERSHIP.filter(({ owner }) => owner === "coverage-security").map(
      ({ id, owner, semantics }) => ({
        id,
        owner,
        semantics,
        outcome: "passed",
        diagnostics: [],
      }),
    ),
  };
}

function createBundleFixture(options: {
  root: string;
  lane: ProducerLane;
  failedCheckId?: string;
  identity: ExperimentIdentity;
  factsOptions?: Parameters<typeof facts>[1];
}): ProducerBundle {
  const directory = join(options.root, options.lane);
  mkdirSync(directory, { recursive: true });
  const factsPath = join(directory, PRODUCER_FACTS_FILE);
  writeFileSync(
    factsPath,
    `${JSON.stringify(facts(options.lane, options.factsOptions), null, 2)}\n`,
  );
  const factsContents = readFileSync(factsPath);
  const output = {
    path: `ci-reports/cacheable-ci/${options.lane}/${PRODUCER_FACTS_FILE}`,
    digest: digest(factsContents),
    bytes: factsContents.length,
  };
  const checks = ownedIds(options.lane).map((checkId) => {
    const failed = checkId === options.failedCheckId;
    const selected = failed;
    const attestation = createCurrentRunAttestation({
      commitSha: options.identity.commitSha,
      runId: options.identity.runId,
      runAttempt: options.identity.runAttempt,
      profile: options.identity.profile,
      lane: options.lane,
      checkId,
      manifestDigest: options.identity.manifestDigest,
      inventoryDigest: options.identity.inventoryDigest,
      toolchainDigest: options.identity.toolchainDigest,
      inputDigest: options.identity.inputDigest,
      receiptDigest: null,
      outputDigest: null,
      decision: failed ? "failed" : "not-applicable",
      diagnostics: failed ? [`${checkId}:failed`] : [],
      issuedAt: "2026-08-14T01:05:00.000Z",
    });
    return {
      check: {
        id: checkId,
        selection: selected ? ("selected" as const) : ("not-applicable" as const),
        semantics:
          checkId === "core-coverage-warning" ? ("advisory" as const) : ("blocking" as const),
        outcome: failed ? ("failed" as const) : ("not-applicable" as const),
        receiptDigest: null,
        attestationDigest: attestation.attestationDigest,
        diagnostics: failed ? [`${checkId}:failed`] : [],
      },
      attestation,
    };
  });
  const bundle = createProducerBundle({
    ...options.identity,
    lane: options.lane,
    startedAt: "2026-08-14T01:00:00.000Z",
    completedAt: "2026-08-14T01:10:00.000Z",
    status: options.failedCheckId ? "failure" : "success",
    checks: checks.map(({ check }) => check),
    receipts: [],
    attestations: checks.map(({ attestation }) => attestation),
    artifactFiles: [output],
  });
  writeFileSync(join(directory, "producer-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

function replaceProducerArtifact(
  value: ReturnType<typeof fixture>,
  lane: ProducerLane,
  nextFacts: ProducerFacts,
  extraFiles: readonly { path: string; contents: string }[] = [],
): void {
  const directory = value.producerDirectories[lane];
  writeFileSync(join(directory, PRODUCER_FACTS_FILE), `${JSON.stringify(nextFacts, null, 2)}\n`);
  const artifactFiles = [
    { path: PRODUCER_FACTS_FILE, contents: readFileSync(join(directory, PRODUCER_FACTS_FILE)) },
    ...extraFiles.map((entry) => {
      const localPath = join(directory, entry.path);
      mkdirSync(join(localPath, ".."), { recursive: true });
      writeFileSync(localPath, entry.contents);
      return { path: entry.path, contents: readFileSync(localPath) };
    }),
  ].map(({ path, contents }) => ({
    path: `ci-reports/cacheable-ci/${lane}/${path}`,
    digest: digest(contents),
    bytes: contents.length,
  }));
  const previous = JSON.parse(
    readFileSync(join(directory, "producer-bundle.json"), "utf8"),
  ) as ProducerBundle;
  const bundle = createProducerBundle({
    ...value.identity,
    lane,
    startedAt: previous.startedAt,
    completedAt: previous.completedAt,
    status: previous.status,
    checks: previous.checks,
    receipts: previous.receipts,
    attestations: previous.attestations,
    artifactFiles,
  });
  writeFileSync(join(directory, "producer-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);
}

function replaceProducerFactsContents(
  value: ReturnType<typeof fixture>,
  lane: ProducerLane,
  contents: string,
): void {
  const directory = value.producerDirectories[lane];
  const factsPath = join(directory, PRODUCER_FACTS_FILE);
  writeFileSync(factsPath, contents);
  const factsContents = readFileSync(factsPath);
  const previous = JSON.parse(
    readFileSync(join(directory, "producer-bundle.json"), "utf8"),
  ) as ProducerBundle;
  const bundle = createProducerBundle({
    ...value.identity,
    lane,
    startedAt: previous.startedAt,
    completedAt: previous.completedAt,
    status: previous.status,
    checks: previous.checks,
    receipts: previous.receipts,
    attestations: previous.attestations,
    artifactFiles: [
      {
        path: `ci-reports/cacheable-ci/${lane}/${PRODUCER_FACTS_FILE}`,
        digest: digest(factsContents),
        bytes: factsContents.length,
      },
    ],
  });
  writeFileSync(join(directory, "producer-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);
}

function createFastLaneReport(
  fixtureInventory: TestInventory,
  owners: readonly string[],
): LaneReport {
  const selected = new Set(owners);
  const commands = fixtureInventory.tests
    .filter(({ lane, owner }) => lane === "fast" && selected.has(owner))
    .map(({ owner, path }) => {
      const cwd = path.split("/src/")[0] ?? ".";
      const testPath = path.slice(cwd === "." ? 0 : cwd.length + 1);
      return {
        owner,
        cwd,
        paths: [testPath],
        command: ["pnpm", "run", "test"],
        status: "passed" as const,
        exitCode: 0,
        durationMs: 1,
        executedPaths: [testPath],
        skippedFiles: [],
        executionState: "executed" as const,
      };
    });
  return {
    schemaVersion: "croco.test-lane-report/v2",
    inventoryVersion: 1,
    inventoryDigest: inventoryDigest(fixtureInventory),
    lane: "fast",
    allowLive: false,
    selectedOwners: owners,
    executedPaths: commands.flatMap(({ cwd, executedPaths }) =>
      executedPaths.map((path) => `${cwd}/${path}`),
    ),
    skippedFiles: [],
    status: "passed",
    diagnostics: [],
    commands,
  };
}

function writeSynthesisRepositoryContracts(root: string): void {
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(
    join(root, "docs", "package-catalog.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        groups: {},
        maturity: {
          production: { label: "production-ready", packages: [] },
          beta: { label: "beta", packages: [] },
          alpha: { label: "alpha", packages: [] },
          deprecated: { label: "deprecated", packages: [] },
        },
        extensionMatrix: { groups: [], packages: {} },
        spine: { packages: [], behavioralEvidence: { packages: {} } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "docs", "package-docs-baseline.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        allowedMissingReadme: [],
        allowedMissingApiDocs: [],
        allowedMissingTests: [],
        temporaryProductionApiDocExceptions: {},
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "public-api-surface.snapshot.json"),
    `${JSON.stringify({ schemaVersion: 2, packages: [] }, null, 2)}\n`,
  );
}

function fixture(
  failed?: { lane: ProducerLane; checkId: string },
  options: {
    readonly affectedOwners?: readonly string[];
    readonly inventory?: TestInventory;
    readonly profile?: VerificationProfile;
    readonly productionReadyRequireTaskSummaries?: boolean;
    readonly selectedCheckIds?: readonly string[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "croco-synthesis-input-"));
  const fixtureInventory = options.inventory ?? inventory;
  const fixtureIdentity = {
    ...identity,
    profile: options.profile ?? identity.profile,
    inventoryDigest: inventoryDigest(fixtureInventory),
  };
  const affectedOwners = options.affectedOwners ?? [];
  const fastLane =
    affectedOwners.length > 0 ? createFastLaneReport(fixtureInventory, affectedOwners) : null;
  const producerDirectories = Object.fromEntries(
    PRODUCER_LANES.map((lane) => [lane, join(root, lane)]),
  ) as Record<ProducerLane, string>;
  const bundles = PRODUCER_LANES.map((lane) =>
    createBundleFixture({
      root,
      lane,
      failedCheckId: failed?.lane === lane ? failed.checkId : undefined,
      identity: fixtureIdentity,
      factsOptions: {
        fastLane,
        inventory: fixtureInventory,
        productionReadyRequireTaskSummaries: options.productionReadyRequireTaskSummaries,
      },
    }),
  );
  const selectedCheckIds = [...(options.selectedCheckIds ?? (failed ? [failed.checkId] : []))];
  return {
    root,
    producerDirectories,
    bundles,
    selectedCheckIds,
    identity: fixtureIdentity,
    affectedOwners,
  };
}

function assemble(value = fixture(), spinePromotionPackages: readonly string[] = []) {
  return assembleSynthesisInput({
    rootDir: value.root,
    identity: value.identity,
    selection: {
      baseSha: BASE_SHA,
      headSha: value.identity.commitSha,
      changedFilesDigest: CHANGED_FILES_DIGEST,
      inventoryFileDigest: INVENTORY_FILE_DIGEST,
      selectedCheckIds: value.selectedCheckIds,
    },
    producerDirectories: value.producerDirectories,
    affectedOwners: value.affectedOwners,
    packagingOwners: [],
    spinePromotionPackages,
  });
}

describe("cacheable CI synthesis input", () => {
  it("keeps ordinary affected-owner evidence out of production-ready full-evidence validation", () => {
    const affectedOwnerReport = createFastLaneReport(
      {
        version: 1,
        tests: [
          {
            path: "packages/batch-qstash/src/tests/QStashBatchExecutor.spec.ts",
            lane: "fast",
            qualifiers: [],
            owner: "@croco/batch-qstash",
          },
        ],
        exceptions: [],
      },
      ["@croco/batch-qstash"],
    );

    expect(productionReadyFastTestLaneReport("repo", affectedOwnerReport)).toBeNull();
    expect(productionReadyFastTestLaneReport("publish", affectedOwnerReport)).toBe(
      affectedOwnerReport,
    );
  });

  it.each([
    ["repo", "passed", []],
    [
      "publish",
      "failed",
      [
        "Fast test lane evidence normalized synthesis input is invalid: expected a full repository fast-lane report without owner filtering",
      ],
    ],
  ] as const)(
    "synthesizes %s affected-owner evidence with the profile's full-evidence contract",
    (profile, expectedOutcome, expectedDiagnostics) => {
      const owner = "@croco/batch-qstash";
      const value = fixture(undefined, {
        affectedOwners: [owner],
        inventory: {
          version: 1,
          tests: [
            {
              path: "packages/batch-qstash/src/tests/QStashBatchExecutor.spec.ts",
              lane: "fast",
              qualifiers: [],
              owner,
            },
          ],
          exceptions: [],
        },
        profile,
        productionReadyRequireTaskSummaries: false,
        selectedCheckIds: ["production-ready"],
      });
      writeSynthesisRepositoryContracts(value.root);

      const result = runSplitValidationSynthesis({
        input: assemble(value),
        rootDir: value.root,
        now: () => "2026-08-14T02:00:00.000Z",
      });
      const productionReady = result.evidence.checks.find(({ id }) => id === "production-ready");

      expect(productionReady).toMatchObject({
        selection: "selected",
        outcome: expectedOutcome,
        diagnostics: expectedDiagnostics,
      });
      expect(result.failed).toBe(profile === "publish");
    },
  );

  it("assembles exact immutable producer files into one self-contained normalized contract", () => {
    const result = assemble();

    expect(result.schemaVersion).toBe(SYNTHESIS_INPUT_SCHEMA);
    expect(result.producers.map(({ lane }) => lane)).toEqual(PRODUCER_LANES);
    expect(result.producerResults).toHaveLength(
      Object.values(VERIFICATION_LANE_OWNERSHIP).filter(
        (lane) => lane !== "split-validation-shadow",
      ).length,
    );
    expect(result.synthesisPlan.every(({ selection }) => selection === "not-applicable")).toBe(
      true,
    );
    expect(result.facts.productionReadyRequireTaskSummaries).toBe(true);
    expect(parseSynthesisInput(result)).toEqual(result);
  });

  it("binds scoped spine promotion packages into the synthesis contract", () => {
    const result = assemble(fixture(), ["docs"]);

    expect(result.facts.spinePromotionPackages).toEqual(["docs"]);
    expect(parseSynthesisInput(result)).toEqual(result);
  });

  it("accepts not-built bundle entries without counting them as measured artifacts", () => {
    const value = fixture();
    const current = facts("core-verification") as Extract<
      ProducerFacts,
      { lane: "core-verification" }
    >;
    replaceProducerArtifact(value, "core-verification", {
      ...current,
      bundleSize: {
        ...current.bundleSize,
        measuredPackageCount: 1,
        artifactCount: 0,
        notBuiltPackageCount: 1,
        nonSpineAdvisoryWarningCount: 1,
        advisoryWarningCount: 1,
        artifacts: [
          {
            packageName: "@croco/example",
            relativeDir: "packages/example",
            scope: "non-spine",
            artifactPath: null,
            baselineKey: null,
            sizeBytes: null,
            baselineBytes: null,
            deltaBytes: null,
            deltaPercent: null,
            allowedPositiveDeltaBytes: null,
            status: "not-built",
            blocking: false,
            blockingReason: null,
            recoveryCommand: "pnpm build",
          },
        ],
      },
    });

    expect(() => assemble(value)).not.toThrow();
  });

  it("rejects bundle counters that do not match their semantic artifact subsets", () => {
    const value = fixture();
    const current = facts("core-verification") as Extract<
      ProducerFacts,
      { lane: "core-verification" }
    >;
    replaceProducerArtifact(value, "core-verification", {
      ...current,
      bundleSize: { ...current.bundleSize, artifactCount: 1 },
    });

    expect(() => assemble(value)).toThrow(/bundleSize counters/);
  });

  it("accepts a valid failed producer bundle and propagates its selected failure", () => {
    const value = fixture({ lane: "generated-apps", checkId: "generated-app-smoke" });
    const result = assemble(value);

    expect(result.producers.find(({ lane }) => lane === "generated-apps")?.status).toBe("failure");
    expect(result.producerResults.find(({ id }) => id === "generated-app-smoke")).toMatchObject({
      selection: "selected",
      outcome: "failed",
    });
  });

  it("rejects missing, extra, mutated, and symbolic-link artifact files", () => {
    const missing = fixture();
    writeFileSync(join(missing.root, "generated-apps", PRODUCER_FACTS_FILE), "");
    expect(() => assemble(missing)).toThrow(/bytes or digest/);

    const extra = fixture();
    writeFileSync(join(extra.root, "core-verification", "extra.json"), "{}\n");
    expect(() => assemble(extra)).toThrow(/do not exactly match/);

    const symlink = fixture();
    symlinkSync(
      join(symlink.root, "coverage-security", PRODUCER_FACTS_FILE),
      join(symlink.root, "coverage-security", "unexpected-link.json"),
    );
    expect(() => assemble(symlink)).toThrow(/symbolic link/);
  });

  it.each([
    ["producer-bundle.json", "core-verification"],
    [PRODUCER_FACTS_FILE, "generated-apps"],
  ] as const)("reports malformed %s with lane-specific evidence", (file, lane) => {
    const value = fixture();
    if (file === "producer-bundle.json") {
      writeFileSync(join(value.producerDirectories[lane], file), "{not-json");
    } else {
      replaceProducerFactsContents(value, lane, "{not-json");
    }

    try {
      assemble(value);
      throw new Error("expected malformed producer JSON to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "UNREADABLE_PRODUCER_ARTIFACT" });
      expect(error).toHaveProperty("message", expect.stringContaining(lane));
      expect(error).toHaveProperty("message", expect.stringContaining(file));
    }
  });

  it("accepts a runner execution checkpoint only when the producer bundle digest-binds it", () => {
    const value = fixture();
    replaceProducerArtifact(value, "core-verification", facts("core-verification"), [
      { path: "execution/release-spine-evidence.json", contents: '{"status":"passed"}\n' },
    ]);

    expect(() => assemble(value)).not.toThrow();
  });

  it.each([
    [
      "packageTasks",
      (current: ProducerFacts) => ({
        ...current,
        packageTasks: [
          {
            packageName: "@croco/invalid",
            relativeDir: "packages/invalid",
            private: "yes",
            tasks: {},
          },
        ],
      }),
    ],
    [
      "bundleSize",
      (current: ProducerFacts) => {
        const { ciMode: _ciMode, ...bundleSize } = (
          current as Extract<ProducerFacts, { lane: "core-verification" }>
        ).bundleSize;
        return { ...current, bundleSize };
      },
    ],
    [
      "publicApi",
      (current: ProducerFacts) => ({
        ...current,
        publicApi: {
          ...(current as Extract<ProducerFacts, { lane: "package-artifacts" }>).publicApi,
          packageCount: "many",
        },
      }),
    ],
    [
      "securityPhysical",
      (current: ProducerFacts) => ({
        ...current,
        securityPhysical: (
          current as Extract<ProducerFacts, { lane: "coverage-security" }>
        ).securityPhysical.map((result, index) =>
          index === 0 ? { ...result, diagnostics: [42] } : result,
        ),
      }),
    ],
  ] as const)("rejects digest-recomputed malformed nested %s facts", (field, mutate) => {
    const lane =
      field === "publicApi"
        ? "package-artifacts"
        : field === "securityPhysical"
          ? "coverage-security"
          : "core-verification";
    const value = fixture();
    replaceProducerArtifact(value, lane, mutate(facts(lane)) as ProducerFacts);

    expect(() => assemble(value)).toThrow(/invalid|keys|must be/i);
  });

  it.each([
    ["unsupported version", (current: TestInventory) => ({ ...current, version: 2 })],
    ["top-level unknown", (current: TestInventory) => ({ ...current, unexpected: true })],
    ["diagnostics drift", (current: TestInventory) => ({ ...current, diagnostics: [] })],
    [
      "entry unknown",
      (current: TestInventory) => ({
        ...current,
        tests: [
          {
            path: "scripts/tests/fixture.spec.ts",
            lane: "fast",
            qualifiers: [],
            owner: "repo:ci",
            unexpected: true,
          },
        ],
      }),
    ],
    [
      "invalid entry path",
      (current: TestInventory) => ({
        ...current,
        tests: [
          {
            path: "../fixture.spec.ts",
            lane: "fast",
            qualifiers: [],
            owner: "repo:ci",
          },
        ],
      }),
    ],
  ] as const)("rejects digest-recomputed strict inventory %s", (_case, mutate) => {
    const value = fixture();
    const current = facts("core-verification") as Extract<
      ProducerFacts,
      { lane: "core-verification" }
    >;
    replaceProducerArtifact(value, "core-verification", {
      ...current,
      inventory: mutate(current.inventory) as TestInventory,
    });

    expect(() => assemble(value)).toThrow(/inventory|keys|diagnostics|path/i);
  });

  it.each([
    ["entry unknown", (entry: Record<string, unknown>) => ({ ...entry, unexpected: true })],
    [
      "invalid source path",
      (entry: Record<string, unknown>) => ({ ...entry, sourcePath: "../escape.spec.ts" }),
    ],
    [
      "invalid digest",
      (entry: Record<string, unknown>) => ({ ...entry, sourceDigest: "not-a-digest" }),
    ],
    [
      "inventory digest drift",
      (entry: Record<string, unknown>) => ({ ...entry, inventoryDigest: "0".repeat(64) }),
    ],
  ] as const)("rejects digest-recomputed strict materialization %s", (_case, mutate) => {
    const value = fixture();
    const sourcePath = "packages/create-croco-app/templates/fixture/src/example.spec.ts";
    const materialization = {
      sourcePath,
      sourceDigest: "1".repeat(64),
      generatedPath: "ci-reports/generated-apps/materialized-tests/example.spec.ts",
      materializedPath: "packages/create-croco-app/templates/fixture/src/example.spec.ts",
      generatedDigest: "2".repeat(64),
      inventoryDigest: identity.inventoryDigest,
      commandId: "generated-app-smoke",
    };
    const current = facts("generated-apps") as Extract<ProducerFacts, { lane: "generated-apps" }>;
    replaceProducerArtifact(value, "generated-apps", {
      ...current,
      requiredSourcePaths: [sourcePath],
      executedSourcePaths: [sourcePath],
      materializations: [mutate(materialization) as never],
    });

    expect(() => assemble(value)).toThrow(/materialization|keys|path|digest|inventory/i);
  });

  it("rejects producer identity and selection drift after assembly", () => {
    const result = assemble();
    expect(() =>
      parseSynthesisInput({ ...result, identity: { ...result.identity, runId: "other" } }),
    ).toThrow(/Digest|digest/);
    const generated = result.producerResults.find(({ id }) => id === "generated-app-smoke");
    if (!generated) throw new Error("expected generated result");
    expect(() =>
      parseSynthesisInput({
        ...result,
        producerResults: result.producerResults.map((entry) =>
          entry === generated ? { ...entry, selection: "selected", outcome: "failed" } : entry,
        ),
      }),
    ).toThrow(/selection drifted/);
  });

  it("rejects a selection head that is not the identity commit", () => {
    const value = fixture();
    expect(() =>
      assembleSynthesisInput({
        rootDir: value.root,
        identity,
        selection: {
          baseSha: BASE_SHA,
          headSha: "f".repeat(40),
          changedFilesDigest: CHANGED_FILES_DIGEST,
          inventoryFileDigest: INVENTORY_FILE_DIGEST,
          selectedCheckIds: value.selectedCheckIds,
        },
        producerDirectories: value.producerDirectories,
        affectedOwners: [],
        packagingOwners: [],
        spinePromotionPackages: [],
      }),
    ).toThrow(/headSha must equal identity.commitSha/);
  });

  it("rejects a changed-file selection even when the outer synthesis digest is recomputed", () => {
    const result = assemble();
    const { synthesisInputDigest: _synthesisInputDigest, ...unsigned } = result;
    const changed = {
      ...unsigned,
      selection: { ...unsigned.selection, changedFilesDigest: "0".repeat(64) },
    };

    expect(() =>
      parseSynthesisInput({
        ...changed,
        synthesisInputDigest: evidenceDigest(changed),
      }),
    ).toThrow(/not bound by identity.inputDigest/);
  });

  it("synthesizes all 54 checks and five security results without legacy workspace inputs", () => {
    const value = fixture();
    const input = assemble(value);
    const timestamps = ["2026-08-14T02:00:00.000Z", "2026-08-14T02:01:00.000Z"];
    const result = runSplitValidationSynthesis({
      input,
      rootDir: value.root,
      now: () => timestamps.shift() ?? "2026-08-14T02:01:00.000Z",
    });

    expect(result.failed).toBe(false);
    expect(result.evidence.checks).toHaveLength(Object.keys(VERIFICATION_LANE_OWNERSHIP).length);
    expect(result.evidence.security).toHaveLength(SECURITY_OWNERSHIP.length);
    expect(
      result.evidence.security.find(({ id }) => id === "security-policy-summary"),
    ).toMatchObject({
      outcome: "passed",
      diagnostics: [],
    });
    expect(result.evidence.security.find(({ id }) => id === "security-upload")).toMatchObject({
      outcome: "not-applicable",
      diagnostics: ["HOSTED_TRANSPORT_NOT_OBSERVED"],
    });
    expect(
      JSON.parse(
        readFileSync(
          join(value.root, "ci-reports/security/split-security-policy-summary.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      schemaVersion: "croco.ci-split-security-policy-summary/v1",
      results: expect.any(Array),
    });
    expect(result.evidence.blockingOutcome).toBe("passed");
    expect(
      JSON.parse(
        readFileSync(
          join(value.root, "ci-reports/cacheable-ci/split-validation-shadow.json"),
          "utf8",
        ),
      ),
    ).toEqual(result.evidence);
  });

  it("preserves a valid producer failure as a failed shadow outcome", () => {
    const value = fixture({ lane: "generated-apps", checkId: "generated-app-smoke" });
    value.selectedCheckIds.push(
      "test-evidence-reconcile",
      "production-ready",
      "spine-promotion",
      "spine-bundle-size",
    );
    const result = runSplitValidationSynthesis({
      input: assemble(value),
      rootDir: value.root,
      now: () => "2026-08-14T02:00:00.000Z",
    });

    expect(result.failed).toBe(true);
    expect(result.evidence.blockingOutcome).toBe("failed");
    expect(result.evidence.checks.find(({ id }) => id === "generated-app-smoke")?.outcome).toBe(
      "failed",
    );
    expect(result.evidence.checks.find(({ id }) => id === "production-ready")?.diagnostics).toEqual(
      [
        "production-ready:Skipped because prerequisite check(s) did not pass: test-evidence-reconcile (skipped_prerequisite).",
      ],
    );
    expect(result.evidence.checks.find(({ id }) => id === "spine-promotion")?.diagnostics).toEqual([
      "spine-promotion:Skipped because prerequisite check(s) did not pass: generated-app-smoke (failed), production-ready (skipped_prerequisite).",
    ]);
  });

  it("executes selected synthesis checks from normalized facts and writes their report", () => {
    const value = fixture();
    value.selectedCheckIds.push("test-evidence-reconcile");
    const result = runSplitValidationSynthesis({
      input: assemble(value),
      rootDir: value.root,
      now: () => "2026-08-14T02:00:00.000Z",
    });

    expect(result.failed).toBe(false);
    expect(result.evidence.checks.find(({ id }) => id === "test-evidence-reconcile")).toMatchObject(
      { selection: "selected", outcome: "passed" },
    );
    expect(
      JSON.parse(
        readFileSync(join(value.root, "ci-reports/package-quality/test-evidence.json"), "utf8"),
      ),
    ).toMatchObject({ mode: "enforced", profile: "publish", diagnostics: [] });
  });

  it("injects the synthesis failure class into its deterministic blocking check", () => {
    const value = fixture();
    value.selectedCheckIds.push(
      "test-evidence-reconcile",
      "production-ready",
      "spine-promotion",
      "spine-bundle-size",
    );
    const result = runSplitValidationSynthesis({
      input: assemble(value),
      rootDir: value.root,
      now: () => "2026-08-14T02:00:00.000Z",
      injectedFailure: "validate-synthesis",
    });

    expect(result.failed).toBe(true);
    expect(result.evidence.checks.find(({ id }) => id === "test-evidence-reconcile")).toMatchObject(
      {
        selection: "selected",
        outcome: "failed",
        diagnostics: ["test-evidence-reconcile:CACHEABLE_EXPERIMENT_INJECTED_FAILURE"],
      },
    );
    expect(result.evidence.checks.find(({ id }) => id === "production-ready")?.diagnostics).toEqual(
      [
        "production-ready:Skipped because prerequisite check(s) did not pass: test-evidence-reconcile (failed).",
      ],
    );
    expect(result.evidence.checks.find(({ id }) => id === "spine-promotion")?.diagnostics).toEqual([
      "spine-promotion:Skipped because prerequisite check(s) did not pass: production-ready (skipped_prerequisite).",
    ]);
    expect(() =>
      runSplitValidationSynthesis({
        input: assemble(fixture()),
        rootDir: value.root,
        injectedFailure: "core-verification",
      }),
    ).toThrow(/cannot inject/);
  });
});
