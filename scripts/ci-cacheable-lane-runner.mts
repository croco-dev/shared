#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";

import {
  createCurrentRunAttestation,
  createProducerBundle,
  createReusableReceipt,
  evidenceDigest,
  parseExperimentIdentity,
  PRODUCER_LANES,
} from "./ci-lane-evidence.mts";
import {
  injectedFailureCommandId,
  parseCacheableFailureClass,
} from "./ci-cacheable-failure-injection.mts";
import { restoreExactLaneCache, writeExactLaneCache } from "./ci-cacheable-lane-cache.mts";
import {
  parseProducerFacts,
  parseSecurityPhysicalResults,
  PRODUCER_FACTS_FILE,
  PRODUCER_FACTS_SCHEMA,
} from "./ci-synthesis-input.mts";
import { createPackageQualityReport, readPublicApiGuardResult } from "./package-quality-report.mts";
import { runReleaseSpineEvidence } from "./release-spine-evidence.mts";
import {
  assertLaneReportShape,
  assertMaterializationEvidence,
} from "./test-evidence-reconcile.mts";
import { readTestInventory, validateGeneratedMaterialization } from "./test-inventory.mts";
import {
  createVerificationLaneManifest,
  createVerificationManifest,
  VERIFICATION_LANE_OWNERSHIP,
} from "./verification-manifest.mts";
import { VerificationProblem } from "./verification-problem.mts";
import type {
  CurrentRunAttestation,
  EvidenceIdentity,
  EvidenceOutput,
  ExperimentIdentity,
  ProducerBundle,
  ProducerCheckResult,
  ProducerLane,
  ReusableReceipt,
  CacheOrigin,
  SynthesisSecurityResult,
  VerificationProfile,
} from "./ci-lane-evidence.mts";
import type { CacheableFailureClass } from "./ci-cacheable-failure-injection.mts";
import type { ProducerFacts, PromotionArtifactFact } from "./ci-synthesis-input.mts";
import type {
  ExactLaneCacheContext,
  LaneCacheCommandBinding,
  LaneCacheMaterialization,
} from "./ci-cacheable-lane-cache.mts";
import type { LaneReport } from "./test-evidence-reconcile.mts";
import type { MaterializationEvidence } from "./test-inventory.mts";
import type {
  Clock,
  CommandRunner,
  EvidenceArtifactReference,
  EvidenceCheckResult,
  EvidenceCommand,
  ReleaseSpineEvidenceReport,
} from "./release-spine-evidence.mts";
import type { VerificationContext, VerificationLaneManifest } from "./verification-manifest.mts";

export const CACHEABLE_LANE_CHECK_SCHEMA = "croco.ci-cacheable-lane-check/v1" as const;

const DEFAULT_TOTAL_TIMEOUT_MS = 150 * 60 * 1000;
const DEFAULT_MAX_CONCURRENCY = 2;
const PRODUCER_BUNDLE_FILE = "producer-bundle.json";
type NormalizedCheckRecord = {
  readonly schemaVersion: typeof CACHEABLE_LANE_CHECK_SCHEMA;
  readonly identity: EvidenceIdentity;
  readonly checkId: string;
  readonly selection: "selected" | "not-applicable";
  readonly semantics: "blocking" | "advisory";
  readonly outcome: "passed" | "failed" | "not-applicable";
  readonly commandDigest: string;
  readonly execution: {
    readonly status: EvidenceCheckResult["status"];
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly durationMs: number | null;
    readonly exitCode: number | null;
    readonly errorCode: string | null;
    readonly failureReason: string | null;
  };
  readonly diagnostics: readonly string[];
};

export type CacheableLaneExecutionPlan = {
  readonly laneManifest: VerificationLaneManifest;
  readonly commands: readonly EvidenceCommand[];
  readonly ownedCommands: readonly EvidenceCommand[];
  readonly ownedIds: readonly string[];
  readonly physicalPrerequisiteIds: readonly string[];
};

export type RunCacheableLaneOptions = {
  readonly identity: ExperimentIdentity;
  readonly lane: ProducerLane;
  readonly profile: VerificationProfile;
  readonly rootDir: string;
  readonly outputDir?: string;
  readonly base?: string;
  readonly head?: string;
  readonly changedFiles?: readonly string[];
  readonly allowPendingReleaseMetadata?: boolean;
  readonly maxConcurrency?: number;
  readonly totalTimeoutMs?: number;
  readonly runner?: CommandRunner;
  readonly clock?: Clock;
  readonly securityPhysical?: readonly SynthesisSecurityResult[];
  readonly securityArtifactPaths?: readonly string[];
  readonly cacheDir?: string;
  readonly cacheOrigin?: CacheOrigin;
  readonly injectedFailure?: CacheableFailureClass;
  readonly fullSelection?: boolean;
};

export type CacheableLaneRunResult = {
  readonly report: ReleaseSpineEvidenceReport;
  readonly additionalArtifactFiles?: readonly EvidenceOutput[];
  readonly bundle: ProducerBundle;
  readonly outputDir: string;
  readonly failed: boolean;
  readonly cacheHit: boolean;
};

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function assertSafeOutputDirectory(rootDir: string, outputDir: string): string {
  const absoluteRoot = resolve(rootDir);
  const absoluteOutput = resolve(absoluteRoot, outputDir);
  const repositoryRelative = relative(absoluteRoot, absoluteOutput).replaceAll("\\", "/");
  if (
    repositoryRelative === "" ||
    repositoryRelative.startsWith("../") ||
    isAbsolute(repositoryRelative) ||
    repositoryRelative.split("/").some((segment) => {
      const normalized = segment.toLowerCase();
      return normalized === ".turbo" || normalized === "dist" || normalized.includes("checkpoint");
    })
  ) {
    throw new VerificationProblem(
      "UNSAFE_CACHEABLE_LANE_OUTPUT",
      "input",
      "Cacheable lane output must be a repository-relative directory outside mutable legacy state.",
    );
  }
  return absoluteOutput;
}

function changedFilesForRange(
  rootDir: string,
  base?: string,
  head?: string,
): readonly string[] | undefined {
  if (!base && !head) return undefined;
  if (!base || !head) {
    throw new VerificationProblem(
      "INCOMPLETE_CHANGE_RANGE",
      "input",
      "base and head must be provided together.",
    );
  }
  try {
    return execFileSync("git", ["diff", "--name-only", base, head], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new VerificationProblem(
      "CACHEABLE_LANE_CHANGE_RANGE_FAILED",
      "input",
      `Unable to resolve changed files for ${base}..${head}: ${message}`,
    );
  }
}

function canonicalCacheRef(rootDir: string, ref: string): string {
  if (/^[a-f0-9]{40}$/.test(ref)) return ref;
  try {
    return execFileSync("git", ["rev-parse", `${ref}^{commit}`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new VerificationProblem(
      "CACHEABLE_LANE_CHANGE_RANGE_FAILED",
      "input",
      `Unable to resolve cache ref ${ref}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function commandWithLocalDependencies(
  command: EvidenceCommand,
  localIds: ReadonlySet<string>,
): EvidenceCommand {
  const dependsOn = (command.dependsOn ?? []).filter((id) => localIds.has(id));
  if (dependsOn.length === 0) {
    const { dependsOn: _removed, ...withoutDependencies } = command;
    return withoutDependencies;
  }
  return { ...command, dependsOn };
}

export function createCacheableLaneExecutionPlan(
  profile: VerificationProfile,
  lane: ProducerLane,
  context: VerificationContext = {},
): CacheableLaneExecutionPlan {
  if (!PRODUCER_LANES.includes(lane)) {
    throw new VerificationProblem(
      "UNKNOWN_CACHEABLE_PRODUCER_LANE",
      "input",
      `Cacheable producer lane must be one of ${PRODUCER_LANES.join(", ")}.`,
    );
  }
  const laneManifest = createVerificationLaneManifest(profile, lane, context);
  const ownershipManifest =
    profile === "publish" ? laneManifest : createVerificationLaneManifest("publish", lane, context);
  const ownedCommands = ownershipManifest.commands;
  const ownedIds = ownedCommands.map(({ id }) => id);
  if (new Set(ownedIds).size !== ownedIds.length) {
    throw new VerificationProblem(
      "DUPLICATE_CACHEABLE_LANE_COMMAND",
      "contract",
      `Lane ${lane} contains duplicate owned commands.`,
    );
  }
  const physicalPrerequisiteIds = laneManifest.physicalLocalPrerequisites.map(({ id }) => id);
  const localIds = new Set([...physicalPrerequisiteIds, ...ownedIds]);
  if (localIds.size !== physicalPrerequisiteIds.length + ownedIds.length) {
    throw new VerificationProblem(
      "AMBIGUOUS_CACHEABLE_LANE_OWNERSHIP",
      "contract",
      `Lane ${lane} repeats a physical prerequisite as an owned command.`,
    );
  }
  const commands = [...laneManifest.physicalLocalPrerequisites, ...laneManifest.commands].map(
    (command) => commandWithLocalDependencies(command, localIds),
  );
  return { laneManifest, commands, ownedCommands, ownedIds, physicalPrerequisiteIds };
}

export function cacheableLaneTaskHash(
  identity: ExperimentIdentity,
  lane: ProducerLane,
  command: EvidenceCommand,
): string {
  return evidenceDigest({
    lane,
    checkId: command.id,
    profile: identity.profile,
    inputDigest: identity.inputDigest,
    command,
  });
}

function cacheCommandBindings(
  identity: ExperimentIdentity,
  lane: ProducerLane,
  plan: CacheableLaneExecutionPlan,
): readonly LaneCacheCommandBinding[] {
  return plan.ownedCommands.map((command) => ({
    checkId: command.id,
    commandDigest: evidenceDigest(command.command),
    taskHash: cacheableLaneTaskHash(identity, lane, command),
  }));
}

function digestParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function exactCacheContext(options: {
  readonly identity: ExperimentIdentity;
  readonly lane: ProducerLane;
  readonly plan: CacheableLaneExecutionPlan;
  readonly rootDir: string;
  readonly outputDir: string;
  readonly base?: string;
  readonly head?: string;
  readonly changedFiles?: readonly string[];
}): ExactLaneCacheContext {
  if (!options.base || !options.head || !options.changedFiles) {
    throw new VerificationProblem(
      "CACHE_REQUIRES_EXACT_CHANGE_RANGE",
      "input",
      "Exact lane cache requires base, head, and resolved changed files.",
    );
  }
  let baseSha = options.base;
  if (!/^[a-f0-9]{40}$/.test(baseSha)) {
    try {
      baseSha = execFileSync("git", ["rev-parse", `${options.base}^{commit}`], {
        cwd: options.rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      throw new VerificationProblem(
        "CACHEABLE_LANE_CHANGE_RANGE_FAILED",
        "input",
        `Unable to resolve cache base ${options.base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const outputRelative = relative(options.rootDir, options.outputDir).replaceAll("\\", "/");
  return {
    identity: options.identity,
    lane: options.lane,
    baseSha,
    changedFilesDigest: digestParts([...options.changedFiles].sort()),
    outputDir: outputRelative,
    commandBindings: cacheCommandBindings(options.identity, options.lane, options.plan),
  };
}

function cacheHitCommand(rootDir: string, command: EvidenceCommand): EvidenceCommand {
  const artifactPaths = (command.artifacts ?? [])
    .map(({ path }) => path)
    .filter((path) => existsSync(resolve(rootDir, path)));
  return {
    ...command,
    command: [
      "node",
      "-e",
      "const fs=require('node:fs'); for (const path of process.argv.slice(1)) { const now=new Date(); fs.utimesSync(path, now, now); }",
      ...artifactPaths,
    ],
  };
}

function diagnosticsForCheck(check: EvidenceCheckResult): readonly string[] {
  if (check.status === "passed" || check.status === "not_applicable") return [];
  return [
    `${check.id}:${check.errorCode ?? check.failureReason ?? check.status}`
      .replace(/\s+/g, " ")
      .trim(),
  ];
}

function outcomeForCheck(check: EvidenceCheckResult): "passed" | "failed" | "not-applicable" {
  if (check.status === "not_applicable") return "not-applicable";
  return check.status === "passed" ? "passed" : "failed";
}

function wasExecuted(check: EvidenceCheckResult): boolean {
  return check.startedAt !== null;
}

function checkSemantics(checkId: string): "blocking" | "advisory" {
  return checkId === "core-coverage-warning" ? "advisory" : "blocking";
}

function normalizedCheckRecord(
  identity: EvidenceIdentity,
  command: EvidenceCommand,
  check: EvidenceCheckResult,
  diagnostics: readonly string[] = diagnosticsForCheck(check),
): NormalizedCheckRecord {
  return {
    schemaVersion: CACHEABLE_LANE_CHECK_SCHEMA,
    identity,
    checkId: check.id,
    selection: check.status === "not_applicable" ? "not-applicable" : "selected",
    semantics: checkSemantics(check.id),
    outcome: outcomeForCheck(check),
    commandDigest: evidenceDigest(command.command),
    execution: {
      status: check.status,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
      durationMs: check.durationMs,
      exitCode: check.exitCode,
      errorCode: check.errorCode,
      failureReason: check.failureReason,
    },
    diagnostics,
  };
}

function assertReportIdentity(
  report: ReleaseSpineEvidenceReport,
  identity: ExperimentIdentity,
): void {
  const comparisons = [
    ["commitSha", report.provenance.commitSha, identity.commitSha],
    ["runId", report.provenance.runId, identity.runId],
    ["runAttempt", report.provenance.runAttempt, String(identity.runAttempt)],
    ["profile", report.profile, identity.profile],
  ] as const;
  for (const [field, actual, expected] of comparisons) {
    if (actual !== expected) {
      throw new VerificationProblem(
        "CACHEABLE_LANE_IDENTITY_DRIFT",
        "contract",
        `Release evidence ${field} does not match the strict experiment identity.`,
      );
    }
  }
}

function assertExactOwnedCheckSet(
  report: ReleaseSpineEvidenceReport,
  plan: CacheableLaneExecutionPlan,
): ReadonlyMap<string, EvidenceCheckResult> {
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  if (byId.size !== report.checks.length) {
    throw new VerificationProblem(
      "DUPLICATE_CACHEABLE_LANE_RESULT",
      "contract",
      "Cacheable lane report contains duplicate check IDs.",
    );
  }
  const expectedExecutionIds = plan.commands.map(({ id }) => id).sort();
  const actualExecutionIds = report.checks.map(({ id }) => id).sort();
  if (JSON.stringify(expectedExecutionIds) !== JSON.stringify(actualExecutionIds)) {
    throw new VerificationProblem(
      "CACHEABLE_LANE_EXECUTION_SET_MISMATCH",
      "contract",
      "Cacheable lane report does not exactly match the planned execution set.",
    );
  }
  return byId;
}

function profileNotApplicableCheck(
  command: EvidenceCommand,
  profile: VerificationProfile,
  completedAt: string,
): EvidenceCheckResult {
  const { artifacts: _artifacts, ...definition } = command;
  return {
    ...definition,
    artifacts: [],
    completedAt,
    durationMs: null,
    effectiveTimeoutMs: null,
    errorCode: null,
    errorMessage: null,
    exitCode: null,
    failureReason: `Not applicable to the ${profile} verification profile.`,
    signal: null,
    startedAt: null,
    status: "not_applicable",
    stderrExcerpt: "",
    stdoutExcerpt: "",
  };
}

function outputForFile(rootDir: string, path: string): EvidenceOutput {
  const contents = readFileSync(path);
  return {
    path: relative(resolve(rootDir), path).replaceAll("\\", "/"),
    digest: sha256(contents),
    bytes: contents.byteLength,
  };
}

function assertPathWithin(parent: string, candidate: string, code: string): void {
  const relativePath = relative(resolve(parent), resolve(candidate)).replaceAll("\\", "/");
  if (relativePath === "" || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new VerificationProblem(
      code,
      "contract",
      `Immutable lane evidence path must be a descendant of ${parent}.`,
    );
  }
}

function expandImmutableFiles(path: string): readonly string[] {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    throw new VerificationProblem(
      "SYMLINK_CACHEABLE_LANE_ARTIFACT",
      "contract",
      `Immutable lane evidence cannot include a symbolic link: ${path}`,
    );
  }
  if (metadata.isFile()) return [path];
  if (!metadata.isDirectory()) {
    throw new VerificationProblem(
      "NON_FILE_CACHEABLE_LANE_ARTIFACT",
      "contract",
      `Immutable lane evidence must resolve to a regular file or directory: ${path}`,
    );
  }
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => expandImmutableFiles(join(path, entry.name)));
}

export function collectImmutableCheckOutputs(options: {
  readonly rootDir: string;
  readonly outputDir: string;
  readonly recordOutput: EvidenceOutput;
  readonly artifacts: readonly EvidenceArtifactReference[];
}): readonly EvidenceOutput[] {
  const outputs: EvidenceOutput[] = [options.recordOutput];
  for (const artifact of options.artifacts) {
    if (artifact.copiedPath === null) continue;
    if (!artifact.exists || !artifact.fresh || artifact.copyError !== null) {
      throw new VerificationProblem(
        "INVALID_COPIED_CACHEABLE_LANE_ARTIFACT",
        "contract",
        `Listed copied artifact for ${artifact.label} is not fresh and successful.`,
      );
    }
    const copiedPath = resolve(options.rootDir, artifact.copiedPath);
    assertPathWithin(options.outputDir, copiedPath, "CACHEABLE_LANE_ARTIFACT_OUTSIDE_OUTPUT");
    let files: readonly string[];
    try {
      files = expandImmutableFiles(copiedPath);
    } catch (error) {
      if (error instanceof VerificationProblem) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new VerificationProblem(
        "MISSING_CACHEABLE_LANE_ARTIFACT",
        "contract",
        `Unable to read copied artifact ${artifact.copiedPath}: ${message}`,
      );
    }
    outputs.push(...files.map((path) => outputForFile(options.rootDir, path)));
  }
  const paths = outputs.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) {
    throw new VerificationProblem(
      "DUPLICATE_CACHEABLE_LANE_ARTIFACT",
      "contract",
      "Immutable lane evidence contains duplicate output paths.",
    );
  }
  return outputs;
}

export function createProducerBundleFromReport(options: {
  readonly identity: ExperimentIdentity;
  readonly lane: ProducerLane;
  readonly rootDir: string;
  readonly outputDir: string;
  readonly plan: CacheableLaneExecutionPlan;
  readonly report: ReleaseSpineEvidenceReport;
  readonly additionalArtifactFiles?: readonly EvidenceOutput[];
  readonly reusedReceipts?: ReadonlyMap<string, ReusableReceipt>;
  readonly reusedChecks?: ReadonlyMap<string, ProducerCheckResult>;
}): ProducerBundle {
  const { identity, lane, plan, report } = options;
  if (identity.profile !== report.profile) {
    throw new VerificationProblem(
      "CACHEABLE_LANE_PROFILE_DRIFT",
      "contract",
      "Lane runner profile does not match the strict experiment identity.",
    );
  }
  assertReportIdentity(report, identity);
  if (!report.completedAt) {
    throw new VerificationProblem(
      "INCOMPLETE_CACHEABLE_LANE_REPORT",
      "contract",
      "Cacheable lane report must be complete before producing evidence.",
    );
  }
  const checkById = assertExactOwnedCheckSet(report, plan);
  const evidenceIdentity: EvidenceIdentity = { ...identity, lane };
  const checksDirectory = join(options.outputDir, "checks");
  const receipts: ReusableReceipt[] = [];
  const attestations: CurrentRunAttestation[] = [];
  const checks: ProducerCheckResult[] = [];
  const artifactFiles: EvidenceOutput[] = [...(options.additionalArtifactFiles ?? [])];
  const commandById = new Map(plan.ownedCommands.map((command) => [command.id, command]));

  for (const checkId of plan.ownedIds) {
    const command = commandById.get(checkId);
    if (!command) {
      throw new VerificationProblem(
        "MISSING_CACHEABLE_LANE_COMMAND",
        "contract",
        `Owned command ${checkId} is absent from the execution plan.`,
      );
    }
    const check =
      checkById.get(checkId) ??
      profileNotApplicableCheck(command, identity.profile, report.completedAt);
    if (VERIFICATION_LANE_OWNERSHIP[checkId as keyof typeof VERIFICATION_LANE_OWNERSHIP] !== lane) {
      throw new VerificationProblem(
        "CACHEABLE_LANE_OWNER_DRIFT",
        "contract",
        `Owned command ${checkId} is not assigned to ${lane}.`,
      );
    }
    const recordPath = join(checksDirectory, `${checkId}.json`);
    const reusedReceipt = options.reusedReceipts?.get(checkId);
    const reusedCheck = options.reusedChecks?.get(checkId);
    if (
      reusedReceipt &&
      options.reusedChecks &&
      (!reusedCheck ||
        reusedCheck.selection !== "selected" ||
        reusedCheck.semantics !== checkSemantics(checkId) ||
        reusedCheck.outcome !== "passed")
    ) {
      throw new VerificationProblem(
        "EXACT_CACHE_CHECK_REVALIDATION_FAILED",
        "contract",
        `Restored semantic result no longer matches ${checkId}.`,
      );
    }
    const record = normalizedCheckRecord(
      evidenceIdentity,
      command,
      check,
      reusedCheck?.diagnostics,
    );
    writeAtomicJson(recordPath, record);
    const recordOutput = outputForFile(options.rootDir, recordPath);
    const checkOutputs = collectImmutableCheckOutputs({
      rootDir: options.rootDir,
      outputDir: options.outputDir,
      recordOutput,
      artifacts: check.artifacts,
    });
    artifactFiles.push(...checkOutputs);

    const diagnostics = record.diagnostics;
    const selection = check.status === "not_applicable" ? "not-applicable" : "selected";
    const outcome = outcomeForCheck(check);
    if (reusedReceipt) {
      const cachedOutputs = reusedReceipt.outputs.filter(({ path }) => path !== recordOutput.path);
      const currentOutputs = checkOutputs.filter(({ path }) => path !== recordOutput.path);
      if (
        outcome !== "passed" ||
        evidenceDigest(cachedOutputs) !== evidenceDigest(currentOutputs)
      ) {
        throw new VerificationProblem(
          "EXACT_CACHE_REVALIDATION_FAILED",
          "contract",
          `Restored receipt outputs no longer match ${checkId}.`,
        );
      }
    }
    const receipt =
      reusedReceipt && outcome === "passed"
        ? createReusableReceipt({
            lane,
            checkId,
            profile: identity.profile,
            manifestDigest: identity.manifestDigest,
            inventoryDigest: identity.inventoryDigest,
            toolchainDigest: identity.toolchainDigest,
            inputDigest: identity.inputDigest,
            contentHash: evidenceDigest(record),
            taskHash: reusedReceipt.taskHash,
            commandDigest: reusedReceipt.commandDigest,
            cache: { origin: "github-exact-key", revalidated: true, policyDigest: null },
            outputs: checkOutputs,
          })
        : selection === "selected" && wasExecuted(check) && outcome === "passed"
          ? createReusableReceipt({
              lane,
              checkId,
              profile: identity.profile,
              manifestDigest: identity.manifestDigest,
              inventoryDigest: identity.inventoryDigest,
              toolchainDigest: identity.toolchainDigest,
              inputDigest: identity.inputDigest,
              contentHash: evidenceDigest(record),
              taskHash: cacheableLaneTaskHash(identity, lane, command),
              commandDigest: record.commandDigest,
              cache: { origin: "executed", revalidated: true, policyDigest: null },
              outputs: checkOutputs,
            })
          : null;
    if (receipt) receipts.push(receipt);
    const attestation = createCurrentRunAttestation({
      commitSha: identity.commitSha,
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      profile: identity.profile,
      lane,
      checkId,
      manifestDigest: identity.manifestDigest,
      inventoryDigest: identity.inventoryDigest,
      toolchainDigest: identity.toolchainDigest,
      inputDigest: identity.inputDigest,
      receiptDigest: receipt?.receiptDigest ?? null,
      outputDigest: receipt ? evidenceDigest(receipt.outputs) : null,
      decision: outcome,
      diagnostics,
      issuedAt: check.completedAt ?? report.completedAt,
    });
    attestations.push(attestation);
    checks.push({
      id: checkId,
      selection,
      semantics: record.semantics,
      outcome,
      receiptDigest: receipt?.receiptDigest ?? null,
      attestationDigest: attestation.attestationDigest,
      diagnostics,
    });
  }

  return createProducerBundle({
    ...evidenceIdentity,
    startedAt: report.generatedAt,
    completedAt: report.completedAt,
    status: checks.some(
      ({ semantics, outcome }) => semantics === "blocking" && outcome === "failed",
    )
      ? "failure"
      : "success",
    checks,
    receipts,
    attestations,
    artifactFiles,
  });
}

function copySecurityArtifacts(
  rootDir: string,
  outputDir: string,
  artifactPaths: readonly string[],
): readonly EvidenceOutput[] {
  const securityRoot = resolve(rootDir, "ci-reports", "security");
  const normalized = artifactPaths.map((path) => resolve(rootDir, path));
  if (new Set(normalized).size !== normalized.length) {
    throw new VerificationProblem(
      "DUPLICATE_SECURITY_ARTIFACT",
      "input",
      "Security artifact paths must be unique.",
    );
  }
  return normalized.map((sourcePath) => {
    assertPathWithin(securityRoot, sourcePath, "SECURITY_ARTIFACT_OUTSIDE_REPORT_ROOT");
    const metadata = lstatSync(sourcePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new VerificationProblem(
        "INVALID_SECURITY_ARTIFACT",
        "contract",
        `Security artifact must be a regular file: ${sourcePath}`,
      );
    }
    const securityRelative = relative(securityRoot, sourcePath);
    const copiedPath = join(outputDir, "security", securityRelative);
    mkdirSync(dirname(copiedPath), { recursive: true });
    copyFileSync(sourcePath, copiedPath);
    return outputForFile(rootDir, copiedPath);
  });
}

function cacheMaterializations(
  rootDir: string,
  report: ReleaseSpineEvidenceReport,
): readonly LaneCacheMaterialization[] {
  return report.checks.flatMap((check) =>
    check.artifacts.flatMap((artifact) => {
      if (
        artifact.copiedPath === null ||
        !artifact.exists ||
        !artifact.fresh ||
        artifact.copyError
      ) {
        return [];
      }
      const sourcePath = resolve(rootDir, artifact.sourcePath);
      const copiedPath = resolve(rootDir, artifact.copiedPath);
      const sourceMetadata = lstatSync(sourcePath);
      const copiedMetadata = lstatSync(copiedPath);
      if (sourceMetadata.isSymbolicLink() || copiedMetadata.isSymbolicLink()) {
        throw new VerificationProblem(
          "SYMLINK_CACHE_MATERIALIZATION",
          "contract",
          `Cache materialization for ${check.id} cannot contain a symbolic link root.`,
        );
      }
      if (sourceMetadata.isDirectory() !== copiedMetadata.isDirectory()) {
        throw new VerificationProblem(
          "CACHE_MATERIALIZATION_TYPE_MISMATCH",
          "contract",
          `Cache materialization for ${check.id} changed file type during evidence copy.`,
        );
      }
      return [
        {
          sourcePath: artifact.sourcePath.replaceAll("\\", "/"),
          copiedPath: artifact.copiedPath.replaceAll("\\", "/"),
          directory: sourceMetadata.isDirectory(),
        },
      ];
    }),
  );
}

function unboundExecutionOutputs(
  rootDir: string,
  outputDir: string,
  report: ReleaseSpineEvidenceReport,
  ownedIds: readonly string[],
): readonly EvidenceOutput[] {
  const copiedFiles = new Set(
    report.checks
      .filter((check) => ownedIds.includes(check.id))
      .flatMap((check) =>
        check.artifacts.flatMap((artifact) =>
          artifact.copiedPath === null
            ? []
            : expandImmutableFiles(resolve(rootDir, artifact.copiedPath)).map((path) =>
                relative(rootDir, path).replaceAll("\\", "/"),
              ),
        ),
      ),
  );
  return expandImmutableFiles(join(outputDir, "execution"))
    .map((path) => outputForFile(rootDir, path))
    .filter(({ path }) => !copiedFiles.has(path));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function laneReport(rootDir: string, path: string): LaneReport | null {
  const absolutePath = resolve(rootDir, path);
  try {
    const value = readJson(absolutePath);
    assertLaneReportShape(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const cause = error instanceof Error ? error.message : String(error);
    throw new VerificationProblem(
      "INVALID_LANE_REPORT",
      "contract",
      `Unable to read or validate lane report ${path}: ${cause}`,
    );
  }
}

function requiredGeneratedSourcePaths(
  profile: VerificationProfile,
  context: VerificationContext,
): readonly string[] {
  const command = createVerificationManifest(profile, context).find(
    ({ id }) => id === "test-evidence-reconcile",
  );
  if (!command) return [];
  return command.command.flatMap((argument, index) =>
    argument === "--required-generated-path" && command.command[index + 1]
      ? [command.command[index + 1]]
      : [],
  );
}

function semanticArtifactFacts(
  rootDir: string,
  report: ReleaseSpineEvidenceReport,
  checkIds: readonly string[],
): readonly PromotionArtifactFact[] {
  const selected = new Set(checkIds);
  return report.checks
    .filter(({ id }) => selected.has(id))
    .flatMap((check) =>
      check.artifacts.flatMap((artifact) => {
        const sourcePath = resolve(rootDir, artifact.sourcePath);
        if (!artifact.required || !artifact.exists || !artifact.fresh) return [];
        let metadata;
        try {
          metadata = statSync(sourcePath);
        } catch {
          return [];
        }
        if (!metadata.isFile()) return [];
        return [
          {
            commandId: check.id,
            path: artifact.sourcePath.replaceAll("\\", "/"),
            digest: sha256(readFileSync(sourcePath)),
            semanticStatus:
              check.status === "passed"
                ? ("passed" as const)
                : check.status === "not_applicable"
                  ? ("unknown" as const)
                  : ("failed" as const),
          },
        ];
      }),
    );
}

function createProducerFacts(options: {
  readonly rootDir: string;
  readonly lane: ProducerLane;
  readonly profile: VerificationProfile;
  readonly context: VerificationContext;
  readonly report: ReleaseSpineEvidenceReport;
  readonly securityPhysical?: readonly SynthesisSecurityResult[];
}): ProducerFacts {
  if (options.lane === "core-verification") {
    const { diagnostics, inventory } = readTestInventory(
      join(options.rootDir, "test-inventory.json"),
    );
    if (diagnostics.length > 0) {
      throw new VerificationProblem(
        "INVALID_SYNTHESIS_TEST_INVENTORY",
        "contract",
        "Core producer cannot emit facts from an invalid test inventory.",
      );
    }
    const summaryWindows = Object.fromEntries(
      (["build", "typecheck", "test"] as const).flatMap((id) => {
        const check = options.report.checks.find((candidate) => candidate.id === id);
        return check?.startedAt && check.completedAt
          ? [[id, { startedAt: check.startedAt, completedAt: check.completedAt }]]
          : [];
      }),
    );
    const quality = createPackageQualityReport({
      rootDir: options.rootDir,
      summaryDir: join(options.rootDir, ".turbo", "runs"),
      summaryWindows,
    });
    const productionReadyCommand = createVerificationManifest(
      options.profile,
      options.context,
    ).find(({ id }) => id === "production-ready");
    return {
      schemaVersion: PRODUCER_FACTS_SCHEMA,
      lane: options.lane,
      inventory,
      fastLane: laneReport(options.rootDir, "ci-reports/package-quality/fast-test-lane.json"),
      integrationLane: laneReport(
        options.rootDir,
        "ci-reports/package-quality/integration-test-lane.json",
      ),
      packageTasks: quality.rows,
      bundleSize: quality.bundleSize,
      productionReadyRequireTaskSummaries:
        productionReadyCommand?.command.includes("--require-task-summaries") ?? false,
    };
  }
  if (options.lane === "generated-apps") {
    const materializationPath = join(
      options.rootDir,
      "ci-reports/generated-apps/materialization-evidence.json",
    );
    let materializations: readonly MaterializationEvidence[] = [];
    try {
      const value = readJson(materializationPath);
      assertMaterializationEvidence(value);
      materializations = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const requiredSourcePaths = requiredGeneratedSourcePaths(options.profile, options.context);
    if (options.report.checks.find(({ id }) => id === "generated-app-smoke")?.status === "passed") {
      const { diagnostics, inventory } = readTestInventory(
        join(options.rootDir, "test-inventory.json"),
      );
      if (diagnostics.length > 0) {
        throw new VerificationProblem(
          "INVALID_SYNTHESIS_TEST_INVENTORY",
          "contract",
          "Generated producer cannot validate materializations against an invalid test inventory.",
        );
      }
      const materializationDiagnostics = validateGeneratedMaterialization(
        options.rootDir,
        inventory,
        join(options.rootDir, "ci-reports/generated-apps/materialized-tests"),
        materializations,
        new Set(requiredSourcePaths),
      );
      if (materializationDiagnostics.length > 0) {
        throw new VerificationProblem(
          "INVALID_GENERATED_SYNTHESIS_FACTS",
          "contract",
          JSON.stringify(materializationDiagnostics),
        );
      }
    }
    return {
      schemaVersion: PRODUCER_FACTS_SCHEMA,
      lane: options.lane,
      requiredSourcePaths,
      executedSourcePaths: materializations.map(({ sourcePath }) => sourcePath).sort(),
      materializations,
      promotionArtifacts: semanticArtifactFacts(options.rootDir, options.report, [
        "generated-app-smoke",
      ]),
    };
  }
  if (options.lane === "package-artifacts") {
    return {
      schemaVersion: PRODUCER_FACTS_SCHEMA,
      lane: options.lane,
      publishedLane: laneReport(
        options.rootDir,
        "ci-reports/package-quality/published-test-lane.json",
      ),
      publicApi: readPublicApiGuardResult(options.rootDir),
      promotionArtifacts: semanticArtifactFacts(options.rootDir, options.report, [
        "provider-certification",
        "public-api",
      ]),
    };
  }
  if (!options.securityPhysical) {
    throw new VerificationProblem(
      "MISSING_SECURITY_PHYSICAL_EVIDENCE",
      "contract",
      "coverage-security producer requires exact workflow-level physical security results.",
    );
  }
  return {
    schemaVersion: PRODUCER_FACTS_SCHEMA,
    lane: options.lane,
    securityPhysical: parseSecurityPhysicalResults(options.securityPhysical),
  };
}

export async function runCacheableLane(
  options: RunCacheableLaneOptions,
): Promise<CacheableLaneRunResult> {
  if (options.identity.profile !== options.profile) {
    throw new VerificationProblem(
      "CACHEABLE_LANE_PROFILE_DRIFT",
      "input",
      "--profile must match identity.profile.",
    );
  }
  if (options.lane === "coverage-security" && options.cacheDir) {
    throw new VerificationProblem(
      "SECURITY_LANE_CACHE_FORBIDDEN",
      "input",
      "coverage-security physical results cannot be restored from or saved to a cross-run cache.",
    );
  }
  if (options.fullSelection && options.cacheDir) {
    throw new VerificationProblem(
      "FULL_SELECTION_CACHE_FORBIDDEN",
      "input",
      "Full-selection runs cannot restore or write change-scoped reusable receipts.",
    );
  }
  const rootDir = resolve(options.rootDir);
  const base =
    options.cacheDir && options.base ? canonicalCacheRef(rootDir, options.base) : options.base;
  const head =
    options.cacheDir && options.head ? canonicalCacheRef(rootDir, options.head) : options.head;
  const outputDir = assertSafeOutputDirectory(
    rootDir,
    options.outputDir ?? join("ci-reports", "cacheable-ci", options.lane),
  );
  const changedFiles = options.changedFiles ?? changedFilesForRange(rootDir, base, head);
  const context: VerificationContext = options.fullSelection
    ? options.allowPendingReleaseMetadata
      ? { allowPendingReleaseMetadata: true }
      : {}
    : {
        ...(options.allowPendingReleaseMetadata ? { allowPendingReleaseMetadata: true } : {}),
        base,
        head,
        changedFiles,
      };
  const injectedCommandId = injectedFailureCommandId(options.injectedFailure ?? "none");
  if (
    injectedCommandId &&
    VERIFICATION_LANE_OWNERSHIP[injectedCommandId as keyof typeof VERIFICATION_LANE_OWNERSHIP] !==
      options.lane
  ) {
    throw new VerificationProblem(
      "CACHEABLE_FAILURE_LANE_MISMATCH",
      "input",
      `Injected failure target ${injectedCommandId} is not owned by ${options.lane}.`,
    );
  }
  if (injectedCommandId && options.cacheDir) {
    throw new VerificationProblem(
      "CACHEABLE_FAILURE_CACHE_FORBIDDEN",
      "input",
      "Injected failure runs cannot restore or write reusable receipts.",
    );
  }
  const plan = createCacheableLaneExecutionPlan(options.profile, options.lane, context);
  const cacheContext = options.cacheDir
    ? exactCacheContext({
        identity: options.identity,
        lane: options.lane,
        plan,
        rootDir,
        outputDir,
        base,
        head,
        changedFiles,
      })
    : null;
  const cacheHit =
    options.cacheDir && cacheContext
      ? restoreExactLaneCache({
          rootDir,
          cacheDir: resolve(rootDir, options.cacheDir),
          origin: options.cacheOrigin,
          context: cacheContext,
        })
      : null;
  const runCommands = cacheHit
    ? plan.commands.map((command) =>
        cacheHit.receipts.has(command.id) ? cacheHitCommand(rootDir, command) : command,
      )
    : plan.commands;
  const report = await runReleaseSpineEvidence({
    rootDir,
    outputDir: join(outputDir, "execution"),
    totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    maxConcurrency: options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    profile: options.profile,
    base,
    head,
    changedFiles,
    commands: runCommands,
    runner: options.runner,
    clock: options.clock,
    injectedFailure: options.injectedFailure,
  });
  const factsPath = join(outputDir, PRODUCER_FACTS_FILE);
  if (cacheHit) {
    parseProducerFacts(readJson(factsPath), options.lane);
  } else {
    const facts = createProducerFacts({
      rootDir,
      lane: options.lane,
      profile: options.profile,
      context,
      report,
      securityPhysical: options.securityPhysical,
    });
    writeAtomicJson(factsPath, facts);
  }
  const factsOutput = outputForFile(rootDir, factsPath);
  const securityOutputs = copySecurityArtifacts(
    rootDir,
    outputDir,
    options.securityArtifactPaths ?? [],
  );
  const executionOutputs = unboundExecutionOutputs(rootDir, outputDir, report, plan.ownedIds);
  const bundle = createProducerBundleFromReport({
    identity: options.identity,
    lane: options.lane,
    rootDir,
    outputDir,
    plan,
    report,
    additionalArtifactFiles: [factsOutput, ...securityOutputs, ...executionOutputs],
    reusedReceipts: cacheHit?.receipts,
    reusedChecks: cacheHit
      ? new Map(cacheHit.bundle.checks.map((check) => [check.id, check]))
      : undefined,
  });
  writeAtomicJson(join(outputDir, PRODUCER_BUNDLE_FILE), bundle);
  if (options.cacheDir && cacheContext && !cacheHit) {
    writeExactLaneCache({
      rootDir,
      cacheDir: resolve(rootDir, options.cacheDir),
      context: cacheContext,
      bundle,
      materializations: cacheMaterializations(rootDir, report),
    });
  }
  return {
    report,
    bundle,
    outputDir,
    failed: bundle.status === "failure",
    cacheHit: cacheHit !== null,
  };
}

type CliOptions = {
  readonly identityPath: string;
  readonly lane: ProducerLane;
  readonly profile: VerificationProfile;
  readonly rootDir: string;
  readonly outputDir?: string;
  readonly base?: string;
  readonly head?: string;
  readonly securityResultsPath?: string;
  readonly securityArtifactPaths: readonly string[];
  readonly cacheDir?: string;
  readonly cacheOrigin?: CacheOrigin;
  readonly injectedFailure: CacheableFailureClass;
  readonly fullSelection: boolean;
  readonly allowPendingReleaseMetadata: boolean;
};

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new VerificationProblem("MISSING_CLI_ARGUMENT", "input", `${flag} requires a value.`);
  }
  return value;
}

function parseCli(args: readonly string[]): CliOptions {
  let identityPath: string | undefined;
  let lane: ProducerLane | undefined;
  let profile: VerificationProfile | undefined;
  let rootDir: string | undefined;
  let outputDir: string | undefined;
  let base: string | undefined;
  let head: string | undefined;
  let securityResultsPath: string | undefined;
  let cacheDir: string | undefined;
  let cacheOrigin: CacheOrigin | undefined;
  let injectedFailure: CacheableFailureClass = "none";
  let fullSelection = false;
  let allowPendingReleaseMetadata = false;
  const securityArtifactPaths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--allow-pending-release-metadata") {
      allowPendingReleaseMetadata = true;
      continue;
    }
    if (flag === "--full-selection") {
      fullSelection = true;
      continue;
    }
    const value = requiredValue(args, index, flag ?? "argument");
    index += 1;
    if (flag === "--identity") identityPath = value;
    else if (flag === "--lane") {
      if (!PRODUCER_LANES.includes(value as ProducerLane)) {
        throw new VerificationProblem(
          "UNKNOWN_CACHEABLE_PRODUCER_LANE",
          "input",
          `--lane must be one of ${PRODUCER_LANES.join(", ")}.`,
        );
      }
      lane = value as ProducerLane;
    } else if (flag === "--profile") {
      if (value !== "repo" && value !== "spine" && value !== "publish") {
        throw new VerificationProblem(
          "UNKNOWN_VERIFICATION_PROFILE",
          "input",
          "--profile must be repo, spine, or publish.",
        );
      }
      profile = value;
    } else if (flag === "--root") rootDir = value;
    else if (flag === "--output") outputDir = value;
    else if (flag === "--base") base = value;
    else if (flag === "--head") head = value;
    else if (flag === "--security-results") securityResultsPath = value;
    else if (flag === "--security-artifact") securityArtifactPaths.push(value);
    else if (flag === "--cache-dir") cacheDir = value;
    else if (flag === "--cache-origin") {
      if (value !== "github-exact-key" && value !== "github-restore-prefix" && value !== "fork") {
        throw new VerificationProblem(
          "INVALID_CACHE_ORIGIN",
          "input",
          "--cache-origin must be github-exact-key, github-restore-prefix, or fork.",
        );
      }
      cacheOrigin = value;
    } else if (flag === "--inject-failure") {
      injectedFailure = parseCacheableFailureClass(value);
    } else {
      throw new VerificationProblem("UNKNOWN_CLI_ARGUMENT", "input", `Unknown argument: ${flag}`);
    }
  }
  if (!identityPath || !lane || !profile || !rootDir) {
    throw new VerificationProblem(
      "MISSING_CLI_ARGUMENT",
      "input",
      "Required: --identity <json> --lane <producer-lane> --profile <profile> --root <dir> [--base <sha> --head <sha> --output <dir>]",
    );
  }
  if ((base === undefined) !== (head === undefined)) {
    throw new VerificationProblem(
      "INCOMPLETE_CHANGE_RANGE",
      "input",
      "--base and --head must be provided together.",
    );
  }
  return {
    identityPath,
    lane,
    profile,
    rootDir,
    outputDir,
    base,
    head,
    securityResultsPath,
    securityArtifactPaths,
    cacheDir,
    cacheOrigin,
    injectedFailure,
    fullSelection,
    allowPendingReleaseMetadata,
  };
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseCli(args);
  const identity = parseExperimentIdentity(
    JSON.parse(readFileSync(resolve(options.identityPath), "utf8")) as unknown,
  );
  const securityPhysical = options.securityResultsPath
    ? parseSecurityPhysicalResults(readJson(resolve(options.securityResultsPath)))
    : undefined;
  const result = await runCacheableLane({
    identity,
    lane: options.lane,
    profile: options.profile,
    rootDir: options.rootDir,
    outputDir: options.outputDir,
    base: options.base,
    head: options.head,
    securityPhysical,
    securityArtifactPaths: options.securityArtifactPaths,
    cacheDir: options.cacheDir,
    cacheOrigin: options.cacheOrigin,
    injectedFailure: options.injectedFailure,
    fullSelection: options.fullSelection,
    allowPendingReleaseMetadata: options.allowPendingReleaseMetadata,
  });
  if (result.failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  main(argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    exit(1);
  });
}
