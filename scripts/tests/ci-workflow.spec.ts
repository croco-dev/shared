import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isNode, parseDocument } from "yaml";
import { describe, expect, it } from "vitest";

import {
  CACHEABLE_FAILURE_CLASSES,
  CACHEABLE_FAILURE_COMMAND,
} from "../ci-cacheable-failure-injection.mts";
import {
  findRequiredWorkflowContextCollisionViolations,
  findRequiredWorkflowPolicyViolations,
} from "../branch-protection-policy.mts";
import { createVerificationManifest, getVerificationCommand } from "../verification-manifest.mts";
import { parseArgs as parseVerificationArgs } from "../release-spine-evidence.mts";
import { ensureSarif, GITLEAKS_CORE_ARGS } from "../security-gitleaks-smoke.mts";
import {
  findTrustedGitleaksImageViolations,
  findWorkflowPermissionViolations,
  findWorkflowVerificationViolations,
  TRUSTED_GITLEAKS_IMAGE,
} from "../workflow-verification-contract.mts";

const ROOT_DIR = resolve(import.meta.dirname, "../..");
const WORKFLOW = readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf8");
const WORKFLOW_DOCUMENT = parseDocument(WORKFLOW, { uniqueKeys: true });
if (WORKFLOW_DOCUMENT.errors.length > 0) {
  throw new Error(WORKFLOW_DOCUMENT.errors.map(({ message }) => message).join("\n"));
}
const WORKFLOW_JOBS = (WORKFLOW_DOCUMENT.toJS() as { readonly jobs?: unknown }).jobs;
if (typeof WORKFLOW_JOBS !== "object" || WORKFLOW_JOBS === null || Array.isArray(WORKFLOW_JOBS)) {
  throw new Error("ci.yml must declare a jobs mapping");
}
const DOCS_SYNC_JOB = (WORKFLOW_JOBS as Readonly<Record<string, unknown>>)["docs-sync-check"];
if (typeof DOCS_SYNC_JOB !== "object" || DOCS_SYNC_JOB === null || Array.isArray(DOCS_SYNC_JOB)) {
  throw new Error("ci.yml must declare the docs-sync-check job as a mapping");
}
const WORKFLOWS = Object.fromEntries(
  readdirSync(resolve(ROOT_DIR, ".github/workflows"))
    .filter((path) => /\.ya?ml$/.test(path))
    .map((path) => [path, readFileSync(resolve(ROOT_DIR, ".github/workflows", path), "utf8")]),
);
const RENOVATE_CONFIG = JSON.parse(
  readFileSync(resolve(ROOT_DIR, ".github/renovate.json"), "utf8"),
) as Record<string, unknown>;
const ROOT_PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(ROOT_DIR, "package.json"), "utf8"),
) as Record<string, unknown>;
const PNPM_LOCK = readFileSync(resolve(ROOT_DIR, "pnpm-lock.yaml"), "utf8");
const NVMRC = readFileSync(resolve(ROOT_DIR, ".nvmrc"), "utf8").trim();
const GITLEAKS_SMOKE = readFileSync(
  resolve(ROOT_DIR, "scripts/security-gitleaks-smoke.mts"),
  "utf8",
);
const DOCS_PLAYWRIGHT_CONFIG = readFileSync(
  resolve(ROOT_DIR, "packages/docs/playwright.config.ts"),
  "utf8",
);
const DOCS_ASTRO_CONFIG = readFileSync(resolve(ROOT_DIR, "packages/docs/astro.config.mjs"), "utf8");
const DOCS_PLAYWRIGHT_TEARDOWN = readFileSync(
  resolve(ROOT_DIR, "packages/docs/playwright.global-teardown.ts"),
  "utf8",
);
function workflowJob(id: string): string {
  if ((WORKFLOW_JOBS as Readonly<Record<string, unknown>>)[id] === undefined) {
    throw new Error(`ci.yml does not declare the ${id} job`);
  }
  const job = WORKFLOW_DOCUMENT.getIn(["jobs", id], true);
  if (!isNode(job) || !job.range) throw new Error(`ci.yml ${id} job has no source range`);
  return WORKFLOW.slice(job.range[0], job.range[1]);
}

function workflowJobCondition(id: string): unknown {
  const job = (WORKFLOW_JOBS as Readonly<Record<string, unknown>>)[id];
  if (typeof job !== "object" || job === null || Array.isArray(job)) {
    throw new Error(`ci.yml ${id} job must be a mapping`);
  }
  return (job as Readonly<Record<string, unknown>>).if;
}

const VALIDATE_JOB = workflowJob("validate");
const REPOSITORY_CONTRACTS_JOB = workflowJob("repository-contracts");
const REAL_RESOURCE_JOB = workflowJob("real-resource-tests");
const DOCS_SYNC_JOB_SOURCE = workflowJob("docs-sync-check");
const DOCS_BUILD_JOB = workflowJob("docs-build");
const SECRET_SCAN = (() => {
  const start = VALIDATE_JOB.indexOf("- name: Secret scan blocking report");
  const end = VALIDATE_JOB.indexOf("- name: Assemble security policy summary");
  if (start === -1 || end === -1) {
    throw new Error("ci.yml validate job does not declare the secret scan boundary steps");
  }
  return VALIDATE_JOB.slice(start, end);
})();

function workflowStep(name: string): string {
  const start = VALIDATE_JOB.indexOf(`      - name: ${name}`);
  if (start === -1) throw new Error(`ci.yml validate job does not declare the ${name} step`);
  const next = VALIDATE_JOB.indexOf("      - name:", start + 1);
  return VALIDATE_JOB.slice(start, next === -1 ? undefined : next);
}

describe("workflow token permissions", () => {
  it("gives every workflow job an explicit effective permission scope", () => {
    expect(findWorkflowPermissionViolations(WORKFLOWS)).toEqual([]);
  });

  it("rejects a workflow that omits both workflow and job permissions", () => {
    const mutant = {
      "unsafe.yml":
        "name: Unsafe\non: pull_request\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps: []\n",
    };

    expect(findWorkflowPermissionViolations(mutant)).toEqual([
      { path: "unsafe.yml", reason: "workflow must declare top-level permissions" },
      {
        path: "unsafe.yml",
        reason: "jobs.validate must declare permissions when the workflow does not",
      },
    ]);
  });

  it("requires a top-level fail-closed default even when each job is scoped", () => {
    const mutant = {
      "job-scoped.yml":
        "name: Job scoped\non: pull_request\njobs:\n  validate:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps: []\n",
    };

    expect(findWorkflowPermissionViolations(mutant)).toEqual([
      { path: "job-scoped.yml", reason: "workflow must declare top-level permissions" },
    ]);
  });

  it("rejects unapproved write grants", () => {
    const mutant = {
      "unsafe.yml":
        "name: Unsafe\non: pull_request\npermissions:\n  contents: read\n  pull-requests: write\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps: []\n",
    };

    expect(findWorkflowPermissionViolations(mutant)).toContainEqual({
      path: "unsafe.yml",
      reason: "workflow.pull-requests grants unapproved write access",
    });
  });

  it("rejects job-level write-all grants", () => {
    const mutant = {
      "unsafe.yml":
        "name: Unsafe\non: pull_request\npermissions:\n  contents: read\njobs:\n  validate:\n    permissions: write-all\n    runs-on: ubuntu-latest\n    steps: []\n",
    };

    expect(findWorkflowPermissionViolations(mutant)).toContainEqual({
      path: "unsafe.yml",
      reason: "jobs.validate.permissions must be an explicit permission map",
    });
  });

  it("keeps immutable local path filtering least-privileged", () => {
    const ciWorkflow = WORKFLOWS["ci.yml"] ?? "";
    const mutant = {
      "ci.yml": ciWorkflow.replace(
        "      contents: read\n",
        "      contents: read\n      pull-requests: read\n",
      ),
    };

    expect(mutant["ci.yml"]).not.toBe(ciWorkflow);
    expect(findWorkflowPermissionViolations(mutant)).toContainEqual({
      path: "ci.yml",
      reason: "jobs.changes must grant only contents: read for local immutable path filtering",
    });
  });

  it.each([
    [
      "an untrusted pull_request_target trigger",
      (workflow: string) => workflow.replace("  workflow_run:\n", "  pull_request_target:\n"),
    ],
    [
      "a PR-head comment publisher checkout",
      (workflow: string) =>
        workflow.replace(
          "          ref: ${{ github.workflow_sha }}",
          "          ref: ${{ github.event.pull_request.head.sha }}",
        ),
    ],
    [
      "persisted checkout credentials",
      (workflow: string) =>
        workflow.replace(
          "      - name: Checkout trusted comment publisher\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: ${{ github.workflow_sha }}\n          persist-credentials: false",
          "      - name: Checkout trusted comment publisher\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: ${{ github.workflow_sha }}\n          persist-credentials: true",
        ),
    ],
    [
      "an additional write-job command",
      (workflow: string) =>
        workflow.replace(
          "      - name: Comment PR with benchmark results",
          "      - name: Execute pull request code\n        run: node untrusted.mjs\n      - name: Comment PR with benchmark results",
        ),
    ],
  ])("rejects benchmark comment boundary drift from %s", (_name, mutate) => {
    const benchmark = WORKFLOWS["benchmark-comment.yml"] ?? "";
    const mutated = mutate(benchmark);
    expect(mutated).not.toBe(benchmark);
    expect(findWorkflowPermissionViolations({ "benchmark-comment.yml": mutated })).toContainEqual({
      path: "benchmark-comment.yml",
      reason:
        "jobs.comment write access must use the trusted workflow_run artifact publisher boundary",
    });
  });
});

describe("CI executable supply chain", () => {
  it("pins Gitleaks to a readable version and immutable OCI digest", () => {
    expect(findTrustedGitleaksImageViolations(WORKFLOW)).toEqual([]);
    expect(WORKFLOW).toContain(
      "ghcr.io/gitleaks/gitleaks:v8.23.0@sha256:b4b81841085b4060054a71155500a340e3d2e2a5995c186546649e3efd80b84e",
    );
    expect(WORKFLOW).toContain("# renovate: datasource=docker depName=ghcr.io/gitleaks/gitleaks");
    expect(WORKFLOW).not.toContain("ghcr.io/gitleaks/gitleaks:v8.23.0 detect");
    expect(WORKFLOW.match(/ghcr\.io\/gitleaks\/gitleaks:v8\.23\.0@sha256:/g)).toHaveLength(1);
  });

  it("rejects moving the trusted image declaration to an inert job", () => {
    const trustedDeclaration = [
      "  # renovate: datasource=docker depName=ghcr.io/gitleaks/gitleaks",
      `  GITLEAKS_IMAGE: ${TRUSTED_GITLEAKS_IMAGE}`,
    ].join("\n");
    const mutant = WORKFLOW.replace(
      trustedDeclaration,
      `  "GITLEAKS_IMAGE": ghcr.io/gitleaks/gitleaks:v9@sha256:${"b".repeat(64)}`,
    ).replace(
      "  changes:",
      `  inert:\n    env:\n      # renovate: datasource=docker depName=ghcr.io/gitleaks/gitleaks\n      GITLEAKS_IMAGE: ${TRUSTED_GITLEAKS_IMAGE}\n    steps: []\n\n  changes:`,
    );

    expect(mutant).not.toBe(WORKFLOW);
    expect(findTrustedGitleaksImageViolations(mutant)).not.toEqual([]);
  });

  it("keeps Madge inside the exact workspace dependency and authoritative manifest", () => {
    const scripts = ROOT_PACKAGE_JSON.scripts as Record<string, string>;
    const devDependencies = ROOT_PACKAGE_JSON.devDependencies as Record<string, string>;
    const circularCommand = getVerificationCommand("architecture-circular").command;

    expect(scripts["architecture:check:circular"]).toBe(
      "pnpm exec madge --circular --extensions ts packages",
    );
    expect(circularCommand.slice(-7)).toEqual([
      "pnpm",
      "exec",
      "madge",
      "--circular",
      "--extensions",
      "ts",
      "packages",
    ]);
    expect(circularCommand).not.toContain("npx");
    expect(devDependencies.madge).toBe("8.0.0");
    expect(PNPM_LOCK).toContain("madge:\n        specifier: 8.0.0\n        version: 8.0.0");
  });

  it("configures Renovate to rotate the Gitleaks tag and digest together", () => {
    const managers = RENOVATE_CONFIG.customManagers as Array<Record<string, unknown>>;
    const manager = managers[0];
    const matchString = String((manager?.matchStrings as string[])[0]);
    const match = new RegExp(matchString).exec(WORKFLOW);

    expect(RENOVATE_CONFIG.extends).toEqual(expect.arrayContaining(["docker:pinDigests"]));
    expect(manager?.customType).toBe("regex");
    expect(manager?.datasourceTemplate).toBe("docker");
    expect(manager?.depNameTemplate).toBe("ghcr.io/gitleaks/gitleaks");
    expect(match?.groups).toMatchObject({
      currentValue: "v8.23.0",
      currentDigest: "sha256:b4b81841085b4060054a71155500a340e3d2e2a5995c186546649e3efd80b84e",
    });
  });
});

describe("Phase B cacheable verification shadow", () => {
  it("isolates every docs Playwright input and removes its temporary root", () => {
    expect(DOCS_PLAYWRIGHT_CONFIG).toContain(
      'cpSync(join(import.meta.dirname, "public"), join(isolatedBuildRoot, "public"),',
    );
    expect(DOCS_PLAYWRIGHT_CONFIG).toContain("reuseExistingServer: false");
    expect(DOCS_PLAYWRIGHT_CONFIG).toContain('globalTeardown: "./playwright.global-teardown.ts"');
    expect(
      DOCS_PLAYWRIGHT_CONFIG.indexOf('process.once("exit", cleanupIsolatedBuildRoot)'),
    ).toBeLessThan(DOCS_PLAYWRIGHT_CONFIG.indexOf('cpSync(join(import.meta.dirname, "src")'));
    expect(DOCS_ASTRO_CONFIG).toContain('publicDir: join(isolatedBuildRoot, "public")');
    expect(DOCS_PLAYWRIGHT_TEARDOWN).toContain(
      "rmSync(isolatedRoot, { recursive: true, force: true })",
    );
  });

  it("keeps ordinary runs latest-only while giving each manual experiment an independent group", () => {
    expect(WORKFLOW).toContain(
      "group: ci-${{ github.event_name == 'workflow_dispatch' && github.run_id || github.ref }}",
    );
    expect(WORKFLOW).toContain("cancel-in-progress: true");
  });

  const producerJobs = [
    "core-verification",
    "generated-apps",
    "package-artifacts",
    "coverage-security",
  ] as const;

  it("fails fast when an explicitly selected workflow job is missing", () => {
    expect(() => workflowJob("missing-cacheable-job")).toThrow(
      "ci.yml does not declare the missing-cacheable-job job",
    );
  });

  it("pins one Node patch release across independent hosted runners", () => {
    expect(NVMRC).toMatch(/^\d+\.\d+\.\d+$/);
    for (const jobId of producerJobs) {
      expect(workflowJob(jobId)).toContain('node-version-file: ".nvmrc"');
    }
    expect(workflowJob("split-validation-shadow")).toContain('node-version-file: ".nvmrc"');
  });

  it("keeps the monolithic validate job authoritative while running cacheable lanes in parallel on pull requests and manual runs", () => {
    expect(VALIDATE_JOB).toContain("needs: changes");
    expect(VALIDATE_JOB).not.toContain("ci-cacheable-lanes:producer");
    for (const jobId of producerJobs) {
      const job = workflowJob(jobId);
      expect(job).toContain("needs: changes");
      expect(workflowJobCondition(jobId)).toBe(
        "github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request'",
      );
      expect(job).toContain("scripts/ci-cacheable-experiment-identity.mts");
      expect(job).toContain("scripts/ci-cacheable-lane-runner.mts");
      expect(job).toContain("if: always()");
      expect(job).toContain(
        `name: ci-lane-${jobId}-${"${{ github.run_id }}"}-${"${{ github.run_attempt }}"}`,
      );
      expect(job).toContain("continue-on-error: true");
    }
    expect(workflowJob("generated-apps")).toContain(
      "PLAYWRIGHT_BROWSERS_PATH: /home/runner/.cache/ms-playwright",
    );
    expect(workflowJob("core-verification")).toContain(
      "PLAYWRIGHT_BROWSERS_PATH: /home/runner/.cache/ms-playwright",
    );
    const cacheableJobs = [
      ...producerJobs.map((jobId) => workflowJob(jobId)),
      workflowJob("split-validation-shadow"),
    ].join("\n");
    expect(workflowJobCondition("split-validation-shadow")).toBe(
      "always() && (github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request') && needs.changes.result == 'success'",
    );
    expect(findWorkflowVerificationViolations(cacheableJobs, ROOT_DIR)).toEqual([]);
  });

  it("restores only exact producer receipts and keeps physical security execution fresh", () => {
    for (const jobId of producerJobs.slice(0, 3)) {
      const job = workflowJob(jobId);
      expect(job).toContain("id: split_identity");
      expect(job).toContain("id: exact_receipts");
      expect(job).toContain(
        'input_digest=$(node -e \'process.stdout.write(JSON.parse(require("node:fs")',
      );
      expect(job).toContain('echo "input_digest=$input_digest" >> "$GITHUB_OUTPUT"');
      expect(job).not.toContain('echo "input_digest=$(node -e');
      expect(job).toContain(`path: .ci-cache/exact/${jobId}`);
      expect(job).toContain(
        `key: ci-lane-receipt-v1-${"${{ runner.os }}"}-${jobId}-${"${{ needs.changes.outputs.profile }}"}-${"${{ steps.split_identity.outputs.input_digest }}"}`,
      );
      const exactCacheStart = job.indexOf(`      - name: Restore exact`);
      const exactCacheEnd = job.indexOf("      - name:", exactCacheStart + 1);
      const exactCache = job.slice(exactCacheStart, exactCacheEnd);
      expect(exactCache).not.toContain("restore-keys:");
      expect(exactCache).toContain(
        "if: env.CROCO_CACHEABLE_FAILURE_CLASS == 'none' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)",
      );
      expect(job).toContain('[ "$TRUSTED_CACHE" = "true" ]; then');
      expect(job).toContain("--cache-origin github-exact-key");
    }
    const security = workflowJob("coverage-security");
    expect(security).not.toContain("id: exact_receipts");
    expect(security).not.toContain("--cache-dir");
    expect(security).toContain('NPM_CONFIG_PROVENANCE: "true"');

    for (const jobId of producerJobs) {
      const job = workflowJob(jobId);
      expect(job).toContain("lane_args=(--allow-pending-release-metadata)");
      expect(job).not.toContain(
        'if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then\n            lane_args+=(--allow-pending-release-metadata)',
      );
      expect(job).toContain('"${lane_args[@]}"');
    }
  });

  it("downloads the exact four immutable bundles before advisory synthesis", () => {
    const shadow = workflowJob("split-validation-shadow");
    expect(shadow).toContain(
      "needs: [changes, core-verification, generated-apps, package-artifacts, coverage-security]",
    );
    expect(shadow).toContain("continue-on-error: true");
    for (const lane of producerJobs) {
      expect(shadow).toContain(
        `name: ci-lane-${lane}-${"${{ github.run_id }}"}-${"${{ github.run_attempt }}"}`,
      );
      expect(shadow).toContain(`--producer-dir ${lane}=incoming/${lane}`);
    }
    expect(shadow).toContain("scripts/ci-synthesis-input.mts");
    expect(shadow).toContain("scripts/ci-split-validation-synthesis.mts");
    expect(shadow).toContain("ci-reports/cacheable-ci/split-validation-shadow.json");
    expect(shadow).toContain("ci-reports/security/split-security-policy-summary.json");
  });

  it("runs each explicit failure class without reusable receipts and records the class", () => {
    for (const failureClass of CACHEABLE_FAILURE_CLASSES) {
      expect(WORKFLOW).toContain(`          - ${failureClass}`);
    }
    expect(WORKFLOW).toContain(
      "CROCO_CACHEABLE_FAILURE_CLASS: ${{ inputs.cacheable_failure_class || 'none' }}",
    );
    expect(VALIDATE_JOB).toContain('args+=(--inject-failure "$CROCO_CACHEABLE_FAILURE_CLASS")');
    expect(workflowStep("Record observed CI performance budget")).toContain(
      '--injected-failure "$CROCO_CACHEABLE_FAILURE_CLASS"',
    );
    for (const [jobId, failureClass] of [
      ["core-verification", "core-verification"],
      ["generated-apps", "generated-apps"],
      ["package-artifacts", "package-artifacts"],
      ["coverage-security", "coverage-security"],
    ] as const) {
      const job = workflowJob(jobId);
      expect(job).toContain(`= "${failureClass}" ]; then`);
      expect(job).toContain('failure_args+=(--inject-failure "$CROCO_CACHEABLE_FAILURE_CLASS")');
      expect(job).toContain(
        'if [ "$CROCO_CACHEABLE_FAILURE_CLASS" != "none" ]; then\n            failure_args+=(--full-selection)',
      );
    }
    const shadow = workflowJob("split-validation-shadow");
    expect(shadow).toContain('[ "$CROCO_CACHEABLE_FAILURE_CLASS" = "validate-synthesis" ]; then');
    expect(shadow).toContain("selection_args+=(--full-selection)");
    expect(shadow).toContain('"${selection_args[@]}"');
    expect(VALIDATE_JOB).toContain("args+=(--full-selection)");
    const fullPublish = createVerificationManifest("publish");
    for (const commandId of Object.values(CACHEABLE_FAILURE_COMMAND)) {
      expect(fullPublish.find(({ id }) => id === commandId)?.applicable, commandId).not.toBe(false);
    }
  });

  it("digest-binds the three physical security outcomes and their raw reports", () => {
    const security = workflowJob("coverage-security");
    expect(security).toContain("scripts/ci-cacheable-security-evidence.mts");
    expect(security).toContain("--security-results ci-reports/security/security-physical.json");
    for (const path of [
      "security-physical.json",
      "pnpm-audit-prod.txt",
      "gitleaks-smoke.txt",
      "gitleaks.txt",
      "gitleaks.sarif",
    ]) {
      expect(security).toContain(`--security-artifact ci-reports/security/${path}`);
    }
    expect(security).toContain("Advisory Gitleaks smoke exit code: ${SMOKE_EXIT:-unknown}");
    expect(security).toContain("Advisory secret scan exit code: ${SCAN_EXIT:-unknown}");
    expect(security).not.toContain('test "$SMOKE_EXIT" = "0"');
    expect(security).not.toContain('test "$SCAN_EXIT" = "0"');
    expect(security).toContain("name: Report advisory physical security failures");
    expect(security).toContain(
      "This shadow lane is advisory; validate retains the blocking Gitleaks checks.",
    );
    expect(VALIDATE_JOB).toContain("name: Secret scan blocking report");
  });
});

describe("CI verification profile contract", () => {
  it("keeps every required check present, blocking, and unskippable", () => {
    expect(findRequiredWorkflowPolicyViolations(WORKFLOW)).toEqual([]);
    expect(findRequiredWorkflowContextCollisionViolations(WORKFLOWS)).toEqual([]);
    expect(findWorkflowVerificationViolations(REPOSITORY_CONTRACTS_JOB, ROOT_DIR)).toEqual([]);
  });

  it("fails closed when required workflow jobs or commands can disappear or skip", () => {
    const mutations = [
      WORKFLOW.replace("  repository-contracts:\n", "  repository-contracts-renamed:\n"),
      WORKFLOW.replace(
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    runs-on:",
        "  repository-contracts:\n    needs: changes\n    if: false\n    runs-on:",
      ),
      WORKFLOW.replace(
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    runs-on:",
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    name: decoy-contract\n    runs-on:",
      ),
      WORKFLOW.replace(
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    runs-on:",
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    strategy:\n      matrix:\n        shard: [1]\n    runs-on:",
      ),
      WORKFLOW.replace(
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    runs-on:",
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    defaults:\n      run:\n        shell: true {0}\n    runs-on:",
      ),
      WORKFLOW.replace(
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    runs-on:",
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    env:\n      NODE_OPTIONS: --import ./scripts/bypass.mjs\n    runs-on:",
      ),
      WORKFLOW.replace(
        "      - name: Check authoritative test inventory",
        '      - name: Inject process preload\n        run: echo "NODE_OPTIONS=--import ./scripts/bypass.mjs" >> "$GITHUB_ENV"\n      - name: Check authoritative test inventory',
      ),
      WORKFLOW.replace(
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    runs-on: ubuntu-latest",
        "  repository-contracts:\n    needs: changes\n    if: ${{ always() }}\n    runs-on: self-hosted",
      ),
      WORKFLOW.replace(
        "env:\n  # renovate:",
        "env:\n  NODE_OPTIONS: --import ./scripts/bypass.mjs\n  # renovate:",
      ),
      WORKFLOW.replace(
        "concurrency:\n  group: ci-${{ github.event_name == 'workflow_dispatch' && github.run_id || github.ref }}",
        "concurrency:\n  group: ci-global",
      ),
      WORKFLOW.replace(
        "  pull_request:\n    branches:\n      - trunk",
        "  pull_request:\n    branches:\n      - trunk\n    paths:\n      - 'packages/**'",
      ),
      WORKFLOW.replace(
        "  pull_request:\n    branches:\n      - trunk",
        "  pull_request:\n    branches:\n      - trunk\n    types: [opened]",
      ),
      WORKFLOW.replace("      api-source: ${{ steps.filter.outputs.api-source }}\n", ""),
      WORKFLOW.replace("            api-source:\n", "            api-source-removed:\n"),
      WORKFLOW.replace(
        "node --experimental-strip-types scripts/ci-verification-identity.mts resolve \\",
        "true \\",
      ),
      WORKFLOW.replace(
        "  changes:\n    runs-on: ubuntu-latest",
        "  changes:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: true {0}",
      ),
      WORKFLOW.replace(
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n      - name: Select verification profile",
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n          ref: trunk\n      - name: Select verification profile",
      ),
      WORKFLOW.replace(
        "      - name: Classify immutable changed paths",
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n          ref: trunk\n      - name: Classify immutable changed paths",
      ),
      WORKFLOW.replace(
        "node --experimental-strip-types scripts/ci-verification-identity.mts assert",
        "true",
      ),
      WORKFLOW.replace(
        "      - name: Initialize beta spine promotion evidence",
        "      - name: Rebind validate checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n          ref: trunk\n\n      - name: Initialize beta spine promotion evidence",
      ),
      WORKFLOW.replace(
        "      - name: Initialize beta spine promotion evidence",
        "      - name: Rebind validate worktree\n        run: git checkout --detach origin/trunk\n\n      - name: Initialize beta spine promotion evidence",
      ),
      WORKFLOW.replace(
        "      - name: Setup pnpm\n        if: needs.changes.outputs.api-source == 'true'\n        uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
        "      - name: Rebind docs checkout\n        if: needs.changes.outputs.api-source == 'true'\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n          ref: trunk\n      - name: Setup pnpm\n        if: needs.changes.outputs.api-source == 'true'\n        uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
      ),
      WORKFLOW.replace(
        "      - name: Setup pnpm\n        if: needs.changes.outputs.api-source == 'true'\n        uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
        "      - name: Rebind docs worktree\n        if: needs.changes.outputs.api-source == 'true'\n        run: git switch --detach origin/trunk\n      - name: Setup pnpm\n        if: needs.changes.outputs.api-source == 'true'\n        uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
      ),
      WORKFLOW.replace(
        '--base "$VERIFICATION_BASE" --head "$VERIFICATION_CANDIDATE"',
        "--base origin/trunk --head HEAD",
      ),
      WORKFLOW.replace("run: pnpm test-inventory:check", "run: echo inventory omitted"),
      WORKFLOW.replace(
        "      - name: Run repository contract tests\n        run:",
        "      - name: Run repository contract tests\n        if: false\n        run:",
      ),
      WORKFLOW.replace(
        "          scripts/tests/repository-policy-audit-workflow.spec.ts",
        "          scripts/tests/repository-policy-audit-workflow.spec.ts || true",
      ),
      WORKFLOW.replace(
        "  validate:\n    needs: changes\n    if: ${{ always() }}",
        "  validate:\n    needs: changes\n    if: needs.changes.result == 'success'",
      ),
      WORKFLOW.replace(
        '    env:\n      NPM_CONFIG_PROVENANCE: "true"',
        '    env:\n      NPM_CONFIG_PROVENANCE: "true"\n      NODE_OPTIONS: --import ./scripts/bypass.mjs',
      ),
      WORKFLOW.replace(
        "  docs-sync-check:\n    needs: changes\n    if: ${{ always() }}\n    runs-on:",
        "  docs-sync-check:\n    needs: changes\n    if: ${{ always() }}\n    env:\n      BASH_ENV: ./scripts/bypass.sh\n    runs-on:",
      ),
      WORKFLOW.replace(
        "      - name: Run selected verification profile\n        id:",
        "      - name: Run selected verification profile\n        if: false\n        id:",
      ),
      WORKFLOW.replace(
        "      - name: Reverify immutable candidate worktree",
        "      - name: Omit immutable candidate worktree reverification",
      ),
      WORKFLOW.replace(
        "      - name: Run selected verification profile",
        "      - name: Rebind validate index\n        run: git read-tree --reset -u origin/trunk\n\n      - name: Run selected verification profile",
      ),
      WORKFLOW.replace(
        "      - name: Build docs and check for drift",
        "      - name: Rebind docs index\n        if: needs.changes.outputs.api-source == 'true'\n        run: git read-tree --reset -u origin/trunk\n      - name: Build docs and check for drift",
      ),
      WORKFLOW.replace(
        '          node --experimental-strip-types scripts/release-spine-evidence.mts "${args[@]}"',
        '          node --experimental-strip-types scripts/release-spine-evidence.mts "${args[@]}" || true',
      ),
      WORKFLOW.replace(
        "      - name: Build docs and check for drift\n        if: needs.changes.outputs.api-source == 'true'",
        "      - name: Build docs and check for drift\n        if: false",
      ),
      WORKFLOW.replace(
        "      - name: Require successful change classification",
        "      - name: Allow failed change classification",
      ),
      WORKFLOW.replace(
        "      - name: Require successful change classification\n        shell: bash",
        "      - name: Require successful change classification\n        continue-on-error: true\n        shell: bash",
      ),
      WORKFLOW.replace("          exit 1\n", "          exit 1 || true\n"),
    ];

    for (const [index, mutation] of mutations.entries()) {
      expect(findRequiredWorkflowPolicyViolations(mutation), `mutation ${index}`).not.toEqual([]);
    }
  });

  it.each([
    [
      "an added validate step",
      WORKFLOW.replace(
        "      - name: Start validate performance measurement",
        '      - name: Inject validate environment\n        run: echo "BASH_ENV=./scripts/bypass.sh" >> "$GITHUB_ENV"\n\n      - name: Start validate performance measurement',
      ),
    ],
    [
      "a validate environment-file rewrite",
      WORKFLOW.replace(
        'run: echo "CROCO_VALIDATE_MEASUREMENT_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" >> "$GITHUB_ENV"',
        'run: echo "NODE_OPTIONS=--import ./scripts/bypass.mjs" >> "$GITHUB_ENV"',
      ),
    ],
    [
      "a docs PATH rewrite",
      WORKFLOW.replace(
        'run: echo "No API documentation source changed; the documentation drift build is not applicable."',
        'run: echo "./scripts" >> "$GITHUB_PATH"',
      ),
    ],
  ])("rejects %s in a protected required job", (_name, mutation) => {
    expect(mutation).not.toBe(WORKFLOW);
    expect(findRequiredWorkflowPolicyViolations(mutation)).toContainEqual(
      expect.stringContaining("BRANCH_POLICY_WORKFLOW_EXECUTION_OVERRIDE"),
    );
  });

  it("rejects another workflow that can emit a reserved required context", () => {
    expect(
      findRequiredWorkflowContextCollisionViolations({
        ...WORKFLOWS,
        "spoof.yml":
          "name: Spoof\non: pull_request\npermissions:\n  contents: read\njobs:\n  decoy:\n    name: repository-contracts\n    runs-on: ubuntu-latest\n    steps: []\n",
      }),
    ).toContainEqual(expect.stringContaining("BRANCH_POLICY_WORKFLOW_CONTEXT_COLLISION"));
  });

  it("requires benchmark.yml to remain the sole benchmark-gate authority", () => {
    const benchmark = WORKFLOWS["benchmark.yml"] ?? "";
    const mutation = benchmark.replace("  benchmark-gate:\n", "  benchmark-gate-removed:\n");
    expect(mutation).not.toBe(benchmark);
    expect(
      findRequiredWorkflowContextCollisionViolations({
        ...WORKFLOWS,
        "benchmark.yml": mutation,
      }),
    ).toContainEqual(
      expect.stringContaining("benchmark.yml must declare required status job benchmark-gate"),
    );
  });

  it.each(["repo", "spine", "publish"])(
    "leaves 30 minutes outside the %s profile for setup and post-verification evidence",
    (profile) => {
      const profileTimeoutMinutes =
        parseVerificationArgs(["--profile", profile, "--output-dir", tmpdir()]).totalTimeoutMs /
        60_000;
      expect(WORKFLOW_DOCUMENT.getIn(["jobs", "validate", "timeout-minutes"])).toBe(
        profileTimeoutMinutes + 30,
      );
    },
  );

  it("measures the complete validate-job boundary after post-spine checks", () => {
    expect(workflowStep("Start validate performance measurement")).toContain(
      "CROCO_VALIDATE_MEASUREMENT_STARTED_AT=",
    );
    expect(workflowStep("Complete validate performance measurement")).toContain(
      "CROCO_VALIDATE_MEASUREMENT_COMPLETED_AT=",
    );
    const performanceStep = workflowStep("Record observed CI performance budget");
    expect(performanceStep).toContain(
      '--measurement-started-at "$CROCO_VALIDATE_MEASUREMENT_STARTED_AT"',
    );
    expect(performanceStep).toContain(
      '--measurement-completed-at "$CROCO_VALIDATE_MEASUREMENT_COMPLETED_AT"',
    );
    expect(performanceStep).toContain("if [ -f ci-reports/ci-performance/report.md ]; then");
    expect(performanceStep).toContain('exit "$performance_status"');
    const coverageSummary = VALIDATE_JOB.indexOf("Publish core coverage warning summary");
    const measurementComplete = VALIDATE_JOB.indexOf("Complete validate performance measurement");
    const performanceBudget = VALIDATE_JOB.indexOf("Record observed CI performance budget");
    expect(coverageSummary).toBeGreaterThan(-1);
    expect(measurementComplete).toBeGreaterThan(-1);
    expect(performanceBudget).toBeGreaterThan(-1);
    expect(coverageSummary).toBeLessThan(measurementComplete);
    expect(measurementComplete).toBeLessThan(performanceBudget);
  });

  it("classifies changes and invokes exactly one shared profile", () => {
    expect(WORKFLOW).toContain("scripts/verification-change-classifier.mts");
    expect(WORKFLOW).toContain('--event "$GITHUB_EVENT_NAME"');
    expect(WORKFLOW).toContain("--workflow ci");
    expect(WORKFLOW).toContain("- name: Run selected verification profile");
    expect(WORKFLOW.match(/scripts\/release-spine-evidence\.mts/g)).toHaveLength(1);
    expect(WORKFLOW).toContain("validate:\n    needs: changes");
    expect(WORKFLOW).toContain("VERIFICATION_PROFILE: ${{ needs.changes.outputs.profile }}");
    expect(WORKFLOW).toContain(
      'args=(--profile "$VERIFICATION_PROFILE" --allow-pending-release-metadata)',
    );
    expect(WORKFLOW).not.toContain(
      'if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then\n            args+=(--allow-pending-release-metadata)',
    );
    expect(WORKFLOW).toContain(
      'args+=(--base "$VERIFICATION_BASE" --head "$VERIFICATION_CANDIDATE")',
    );
    expect(WORKFLOW).toContain('args+=(--verification-base-sha "$VERIFICATION_BASE")');
    expect(WORKFLOW).toContain('args+=(--verification-head-sha "$VERIFICATION_HEAD")');
    expect(WORKFLOW).toContain('args+=(--verification-candidate-sha "$VERIFICATION_CANDIDATE")');
    expect(WORKFLOW).not.toContain('if [ "$GITHUB_EVENT_NAME" != "workflow_dispatch" ]');
    expect(WORKFLOW).toContain(
      'if [ "$CROCO_CACHEABLE_FAILURE_CLASS" != "none" ]; then\n            args+=(--full-selection)\n            args+=(--inject-failure "$CROCO_CACHEABLE_FAILURE_CLASS")',
    );
    expect(WORKFLOW).toContain("VERIFICATION_BASE: ${{ needs.changes.outputs.base }}");
    expect(WORKFLOW).toContain("VERIFICATION_HEAD: ${{ needs.changes.outputs.head }}");
    expect(WORKFLOW).toContain("VERIFICATION_CANDIDATE: ${{ needs.changes.outputs.candidate }}");
    expect(WORKFLOW).toContain("name: Classify immutable changed paths");
    expect(WORKFLOW).toContain('--filters "$PATH_FILTERS" --github-output "$GITHUB_OUTPUT"');
    expect(WORKFLOW).not.toContain("dorny/paths-filter");
    expect(WORKFLOW).not.toContain('base="origin/$BASE_REF"');
    expect(WORKFLOW).not.toContain("test:release-gates");
  });

  it("keeps the advisory audit and ecosystem smoke outside blocking profiles", () => {
    expect(WORKFLOW).toContain("continue-on-error: true");
    expect(WORKFLOW).toContain("pnpm audit:prod > ci-reports/security/pnpm-audit-prod.txt");
    expect(WORKFLOW).toContain("ghcr.io/gitleaks/gitleaks:v8.23.0");
    expect(WORKFLOW).toContain("pnpm create-croco-app:smoke -- --tier ecosystem-advisory");
    expect(WORKFLOW).not.toContain("pnpm create-croco-app:smoke -- --tier spine-blocking");
    expect(VALIDATE_JOB).not.toContain("--tier ecosystem-advisory");
    expect(WORKFLOW).toContain("ecosystem-advisory:\n    needs: changes");
    expect(WORKFLOW).toContain(
      "ecosystem-advisory:\n    needs: changes\n    if: github.event_name == 'workflow_dispatch' && needs.changes.outputs.profile != 'repo'\n    continue-on-error: true\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    permissions:\n      actions: read\n      contents: read",
    );
    const ecosystemAdvisoryStart = WORKFLOW.indexOf("  ecosystem-advisory:");
    const ecosystemAdvisory = WORKFLOW.slice(
      ecosystemAdvisoryStart,
      WORKFLOW.indexOf("  windows-scaffold:", ecosystemAdvisoryStart),
    );
    expect(ecosystemAdvisory).toContain("persist-credentials: false");
  });

  it("makes the Gitleaks result blocking while preserving redacted evidence", () => {
    const initializeText = SECRET_SCAN.indexOf(": > ci-reports/security/gitleaks.txt");
    const initializeSarif = SECRET_SCAN.indexOf("ci-reports/security/gitleaks.sarif");
    const scanner = SECRET_SCAN.indexOf(
      'docker run --rm -v "$PWD:/repo" "${{ env.GITLEAKS_IMAGE }}"',
    );

    expect(SECRET_SCAN).toContain("if: always()");
    expect(SECRET_SCAN).not.toContain("continue-on-error");
    expect(initializeText).toBeGreaterThan(-1);
    expect(initializeSarif).toBeGreaterThan(-1);
    expect(initializeText).toBeLessThan(scanner);
    expect(initializeSarif).toBeLessThan(scanner);
    expect(SECRET_SCAN).toContain("detect --source /repo --redact --no-banner --log-opts=HEAD");
    expect(SECRET_SCAN).toContain(
      "--report-format sarif --report-path /repo/ci-reports/security/gitleaks.sarif",
    );
    expect(SECRET_SCAN).toContain('exit "$exit_code"');
    expect(SECRET_SCAN).toContain("Scanner operational failures are also blocking.");
    expect(SECRET_SCAN).not.toContain("warning-only for PR");
  });

  it("runs the four-case Gitleaks smoke before the always-run production scan", () => {
    const install = WORKFLOW.indexOf("      - name: Install dependencies");
    const smoke = WORKFLOW.indexOf("      - name: Security Gitleaks acceptance smoke");
    const production = WORKFLOW.indexOf("      - name: Secret scan blocking report");

    expect(smoke).toBeGreaterThan(install);
    expect(production).toBeGreaterThan(smoke);
    expect(WORKFLOW.slice(smoke, production)).not.toContain("if: always()");
    expect(SECRET_SCAN).toContain(GITLEAKS_CORE_ARGS.slice(0, -1).join(" "));
    expect(SECRET_SCAN).toContain("--report-path /repo/ci-reports/security/gitleaks.sarif");
    expect(GITLEAKS_SMOKE).toContain('reportHasRule(detectableResult.report, "github-pat")');
    expect(GITLEAKS_SMOKE).toContain('reportHasRule(invalidConfigResult.report, "github-pat")');
    expect(GITLEAKS_SMOKE).toContain('"detectable", detectable');
    expect(GITLEAKS_SMOKE).toContain('"allowlisted", allowlisted');
    expect(GITLEAKS_SMOKE).toContain('"stale-metadata", stale');
    expect(GITLEAKS_SMOKE).toContain('"dotted-allowlist", dotted');
    expect(GITLEAKS_SMOKE).toContain('"spaced-dotted-allowlist", spacedDotted');
    expect(GITLEAKS_SMOKE).toContain('"quoted-table-allowlist", quotedTable');
    expect(GITLEAKS_SMOKE).toContain('"rule-override", ruleOverride');
    expect(GITLEAKS_SMOKE).toContain('"clean", clean');
    expect(GITLEAKS_SMOKE).toContain('"invalid-config", invalidConfig');
    expect(GITLEAKS_SMOKE).not.toMatch(/ghp_[A-Za-z0-9]{36}/);
  });

  it("installs the browser required by the authoritative docs integration lane", () => {
    const install = VALIDATE_JOB.indexOf("      - name: Install dependencies");
    const playwright = VALIDATE_JOB.indexOf("      - name: Install Playwright Chromium");
    const verification = VALIDATE_JOB.indexOf("      - name: Run selected verification profile");

    expect(playwright).toBeGreaterThan(install);
    expect(playwright).toBeLessThan(verification);
    expect(VALIDATE_JOB).toContain("pnpm --dir packages/docs run playwright:install");
  });

  it("fails publish shadow reuse with an explicit missing-evidence diagnostic", () => {
    const shadow = workflowStep("Run full test suite for changed-test shadow");

    expect(shadow).toContain("if [ -f ci-reports/package-quality/fast-test-lane.json ]; then");
    expect(shadow).toContain(
      "Publish fast lane evidence is missing; the verification fast lane did not run.",
    );
    expect(shadow).toContain("full_suite_status=1");
  });

  it("keeps the blocking Gitleaks summary and report upload observable", () => {
    const summary = WORKFLOW.indexOf("      - name: Assemble security policy summary");
    const upload = WORKFLOW.indexOf("      - name: Upload security report");

    expect(WORKFLOW).toContain(
      "\\`gitleaks\\` secret scanning: blocking on pull requests, trunk pushes, and manual runs",
    );
    expect(WORKFLOW).toContain("steps.security_gitleaks.outputs.exit_code");
    expect(upload).toBeGreaterThan(summary);
    expect(
      WORKFLOW.slice(upload, WORKFLOW.indexOf("      - name: Run selected verification profile")),
    ).toContain("if: always()");
    expect(WORKFLOW).toContain("path: ci-reports/security");
    expect(WORKFLOW).toContain('cat ci-reports/security/summary.md >> "$GITHUB_STEP_SUMMARY"');
    expect(SECRET_SCAN).toContain("--ensure-sarif ci-reports/security/gitleaks.sarif");
  });

  it("replaces malformed SARIF with a valid redacted upload artifact and fails closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "croco-gitleaks-sarif-"));
    const report = join(directory, "gitleaks.sarif");
    try {
      writeFileSync(report, "not-json");

      expect(ensureSarif(report)).toBe(1);
      expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({ version: "2.1.0", runs: [] });
      expect(readFileSync(`${report}.invalid.txt`, "utf8")).toBe("not-json");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("allows only manifest entrypoints and explicit Actions-owned commands", () => {
    expect(
      findWorkflowVerificationViolations(`${VALIDATE_JOB}\n${REAL_RESOURCE_JOB}`, ROOT_DIR),
    ).toEqual([]);
  });

  it("runs persistence concurrency against a digest-pinned PostgreSQL service", () => {
    expect(REAL_RESOURCE_JOB).toContain(
      "postgres:16.10-alpine@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297",
    );
    expect(REAL_RESOURCE_JOB).toContain(
      "CREDITS_POSTGRES_URL: postgresql://postgres:postgres@127.0.0.1:5432/croco_membership",
    );
    expect(REAL_RESOURCE_JOB).toContain(
      "ENTITLEMENTS_POSTGRES_URL: postgresql://postgres:postgres@127.0.0.1:5432/croco_membership",
    );
    expect(REAL_RESOURCE_JOB).toContain(
      "ENGAGEMENT_POSTGRES_URL: postgresql://postgres:postgres@127.0.0.1:5432/croco_membership",
    );
    expect(REAL_RESOURCE_JOB).toContain(
      "EXECUTION_POSTGRES_URL: postgresql://postgres:postgres@127.0.0.1:5432/croco_membership",
    );
    expect(REAL_RESOURCE_JOB).toContain(
      "MEMBERSHIP_POSTGRES_URL: postgresql://postgres:postgres@127.0.0.1:5432/croco_membership",
    );
    expect(REAL_RESOURCE_JOB).toContain("pnpm build --filter=@croco/credits-drizzle...");
    expect(REAL_RESOURCE_JOB).toContain("pnpm --filter @croco/credits-drizzle test:postgres");
    expect(REAL_RESOURCE_JOB).toContain("pnpm build --filter=@croco/engagement-drizzle...");
    expect(REAL_RESOURCE_JOB).toContain("pnpm --filter @croco/engagement-drizzle test:postgres");
    expect(REAL_RESOURCE_JOB).toContain("pnpm build --filter=@croco/entitlements-drizzle...");
    expect(REAL_RESOURCE_JOB).toContain("pnpm --filter @croco/entitlements-drizzle test:postgres");
    expect(REAL_RESOURCE_JOB).toContain("pnpm build --filter=@croco/execution-drizzle...");
    expect(REAL_RESOURCE_JOB).toContain("pnpm --filter @croco/execution-drizzle test:postgres");
    expect(REAL_RESOURCE_JOB).toContain("pnpm build --filter=@croco/membership-drizzle...");
    expect(REAL_RESOURCE_JOB).toContain(
      "pnpm --filter @croco/membership-drizzle exec vitest run src/tests/DrizzleMembershipStore.postgres.spec.ts",
    );
  });

  it("routes entitlement persistence changes to the real PostgreSQL invariant suite", () => {
    expect(WORKFLOW).toContain("              - 'packages/entitlements-core/**'");
    expect(WORKFLOW).toContain("              - 'packages/entitlements-drizzle/**'");
    expect(WORKFLOW).toContain("              - 'packages/entitlements-drizzle/src/**'");
  });

  it("routes credit persistence changes to the real PostgreSQL conformance suite", () => {
    expect(WORKFLOW).toContain("              - 'packages/credits-core/**'");
    expect(WORKFLOW).toContain("              - 'packages/credits-drizzle/**'");
    expect(WORKFLOW).toContain("              - 'packages/credits-drizzle/src/**'");
  });

  it("routes engagement persistence changes to the real PostgreSQL conformance suite", () => {
    expect(WORKFLOW).toContain("              - 'packages/engagement-core/**'");
    expect(WORKFLOW).toContain("              - 'packages/engagement-drizzle/**'");
    expect(WORKFLOW).toContain("              - 'packages/engagement-drizzle/src/**'");
  });

  it("routes auth changes to the real PostgreSQL rotation suite", () => {
    expect(WORKFLOW).toContain("- 'packages/auth-core/**'");
    expect(WORKFLOW).toContain("- 'packages/auth-drizzle/**'");
    expect(REAL_RESOURCE_JOB).toContain("pnpm build --filter=@croco/auth-drizzle...");
    expect(REAL_RESOURCE_JOB).toContain(
      "AUTH_POSTGRES_URL: postgresql://postgres:postgres@127.0.0.1:5432/croco_membership",
    );
    expect(REAL_RESOURCE_JOB).toContain(
      "pnpm --filter @croco/auth-drizzle exec vitest run src/tests/DrizzleApiKeyStore.postgres.spec.ts",
    );
  });

  it("runs typed TestKernel resources against real PostgreSQL and Redis", () => {
    expect(REAL_RESOURCE_JOB).toContain("pnpm build --filter=@croco/testing-resources...");
    expect(REAL_RESOURCE_JOB).toContain("pnpm --filter @croco/testing-resources test:real");
  });

  it("runs metering idempotency composition against real Redis", () => {
    expect(WORKFLOW).toContain("              - 'packages/metering-core/**'");
    expect(REAL_RESOURCE_JOB).toContain("pnpm build --filter=@croco/metering-core...");
    expect(REAL_RESOURCE_JOB).toContain("pnpm --filter @croco/metering-core test:real");
  });

  it("runs Timescale metrics idempotency against a real TimescaleDB container", () => {
    expect(WORKFLOW).toContain("              - 'packages/metrics-core/src/**'");
    expect(REAL_RESOURCE_JOB).toContain("pnpm build --filter=@croco/metrics-core...");
    expect(REAL_RESOURCE_JOB).toContain("pnpm --filter @croco/metrics-core test:real");
  });

  it("runs fresh migration status against real PostgreSQL", () => {
    expect(WORKFLOW).toContain("              - 'packages/migration-runner/**'");
    expect(REAL_RESOURCE_JOB).toContain(
      "MIGRATION_POSTGRES_URL: postgresql://postgres:postgres@127.0.0.1:5432/croco_membership",
    );
    expect(REAL_RESOURCE_JOB).toContain(
      "pnpm --filter @croco/migration-runner exec vitest run src/tests/MigrationStatusPostgres.spec.ts",
    );
  });

  it.each(["--log-opts=--max-count=0", "--no-git", "--redact=false"])(
    "rejects a production Gitleaks argv override: %s",
    (extraArgument) => {
      const mutant = VALIDATE_JOB.replace(
        "--report-path /repo/ci-reports/security/gitleaks.sarif >",
        `--report-path /repo/ci-reports/security/gitleaks.sarif ${extraArgument} >`,
      );

      expect(mutant).not.toBe(VALIDATE_JOB);
      expect(findWorkflowVerificationViolations(mutant, ROOT_DIR)).toEqual([
        expect.objectContaining({ reason: "command is not in the Actions-only allowlist" }),
      ]);
    },
  );

  it("rejects alias, direct-leaf, and unknown verifier mutations", () => {
    for (const mutation of [
      "      - name: mutant\n        run: pnpm public-api:check\n",
      "      - name: mutant\n        run: pnpm run public-api:check\n",
      "      - name: mutant\n        run: CI=true pnpm public-api:check\n",
      "      - name: mutant\n        run: |\n          if ! pnpm public-api:check; then\n            exit 1\n          fi\n",
      "      - name: mutant\n        run: node --experimental-strip-types scripts/public-api-surface.mts --check\n",
      "      - name: mutant\n        run: pnpm unknown-verifier\n",
      "      - name: mutant\n        run: pnpm install --frozen-lockfile && pnpm public-api:check\n",
      "      - name: mutant\n        run: pnpm verify:publish-extra\n",
      "      - name: mutant\n        run: node -e \"require('node:child_process').execSync('pnpm public-api:check')\"\n",
      "      - name: mutant\n        run: |\n          echo starting && pnpm public-api:check\n",
      "      - name: mutant\n        run: |\n          echo starting; pnpm public-api:check\n",
      "      - name: mutant\n        run: |\n          command pnpm public-api:check\n",
      "      - name: mutant\n        run: if pnpm public-api:check; then echo ok; fi\n",
    ]) {
      expect(
        findWorkflowVerificationViolations(`${VALIDATE_JOB}\n${mutation}`, ROOT_DIR),
      ).toHaveLength(1);
    }
  });

  it("publishes profile, package quality, generated-app, and coverage evidence", () => {
    expect(WORKFLOW).toContain("name: verification-${{ needs.changes.outputs.profile }}");
    expect(WORKFLOW).toContain("name: package-quality-dashboard");
    expect(WORKFLOW).toContain("name: generated-app-smoke-ecosystem-advisory");
    expect(WORKFLOW).toContain("name: core-coverage-warning-report");
  });

  it("persists verification reports only through explicit CI artifact directories", () => {
    const verificationStep = workflowStep("Run selected verification profile");

    expect(verificationStep).toContain("args+=(--output-dir ci-reports/release)");
    expect(verificationStep).toContain(
      'args+=(--output-dir "ci-reports/verification/${VERIFICATION_PROFILE}")',
    );
    expect(verificationStep).toContain(
      'node --experimental-strip-types scripts/release-spine-evidence.mts "${args[@]}"',
    );
  });

  it("publishes unified JSON and Markdown evidence even when aggregation fails closed", () => {
    const ensureNativeStart = VALIDATE_JOB.indexOf("      - name: Ensure native Vitest evidence");
    const aggregateStart = VALIDATE_JOB.indexOf("      - name: Aggregate executable test evidence");

    expect(ensureNativeStart).toBeGreaterThan(-1);
    expect(ensureNativeStart).toBeLessThan(aggregateStart);
    expect(workflowStep("Ensure native Vitest evidence")).toContain("if: ${{ !cancelled() }}");
    expect(VALIDATE_JOB.slice(ensureNativeStart, aggregateStart)).toContain(
      "pnpm --filter @croco/testing test",
    );
    expect(VALIDATE_JOB.slice(ensureNativeStart, aggregateStart)).toContain(
      "find ci-reports/test-evidence/records -type f -name 'vitest-*.json' -print -quit",
    );
    expect(VALIDATE_JOB).toContain(
      'node --experimental-strip-types scripts/test-evidence-bundle.mts "${evidence_args[@]}" || evidence_status=$?',
    );
    expect(VALIDATE_JOB).toContain(
      "find ci-reports/test-evidence/records -type f -name '*.json' -print | sort",
    );
    expect(VALIDATE_JOB).toContain(
      "CROCO_TEST_EVIDENCE_DIR: ${{ github.workspace }}/ci-reports/test-evidence/records",
    );
    expect(VALIDATE_JOB).toContain("vitest_record_count=0");
    expect(VALIDATE_JOB).toContain('if [[ "$evidence_record" == */vitest-*.json ]]; then');
    expect(VALIDATE_JOB).toContain(
      "evidence_args+=(--input ci-reports/test-evidence/records/required-vitest-record.json)",
    );
    expect(VALIDATE_JOB).toContain("if [ -f ci-reports/test-evidence/summary.md ]; then");
    expect(VALIDATE_JOB).toContain('exit "$evidence_status"');
    expect(VALIDATE_JOB).toContain("ci-reports/test-evidence");
  });

  it("measures changed-test selection misses against cache-aware authoritative shadow evidence", () => {
    const fullSuiteStep = workflowStep("Run full test suite for changed-test shadow");
    expect(fullSuiteStep).toContain(
      "if: ${{ !cancelled() && github.event_name == 'workflow_dispatch' }}",
    );
    expect(fullSuiteStep).not.toContain("github.event_name == 'pull_request'");
    expect(fullSuiteStep).not.toContain("continue-on-error");
    expect(fullSuiteStep).toContain("VERIFICATION_PROFILE: ${{ needs.changes.outputs.profile }}");
    expect(fullSuiteStep).toContain('if [ "$VERIFICATION_PROFILE" = "publish" ]; then');
    expect(fullSuiteStep).toContain("ci-reports/package-quality/fast-test-lane.json");
    expect(fullSuiteStep).toContain("ci-reports/changed-test-plan/full-fast-lane.json");
    expect(fullSuiteStep).toContain('shadow_source="reused publish verification fast lane"');
    const publishBranchStart = fullSuiteStep.indexOf(
      'if [ "$VERIFICATION_PROFILE" = "publish" ]; then',
    );
    const nonPublishBranchStart = fullSuiteStep.indexOf("          else", publishBranchStart);
    const statusValidationStart = fullSuiteStep.indexOf(
      "scripts/changed-test-full-suite-status.mts",
      nonPublishBranchStart,
    );
    expect(publishBranchStart).toBeGreaterThan(-1);
    expect(nonPublishBranchStart).toBeGreaterThan(publishBranchStart);
    expect(statusValidationStart).toBeGreaterThan(nonPublishBranchStart);
    expect(fullSuiteStep.slice(publishBranchStart, nonPublishBranchStart)).toContain("cp \\");
    expect(fullSuiteStep.slice(publishBranchStart, nonPublishBranchStart)).not.toContain(
      "scripts/test-lane-runner.mts",
    );
    expect(fullSuiteStep.slice(nonPublishBranchStart, statusValidationStart)).toContain(
      "scripts/test-lane-runner.mts",
    );
    expect(fullSuiteStep.slice(nonPublishBranchStart, statusValidationStart)).toContain(
      "--lane fast",
    );
    expect(fullSuiteStep).not.toContain("--force");
    expect(fullSuiteStep).toContain("scripts/changed-test-full-suite-status.mts");
    expect(fullSuiteStep).toContain("full-suite-status.json");
    expect(fullSuiteStep).toContain("elapsed_seconds=$(($(date +%s) - started_at))");
    expect(fullSuiteStep).toContain("${{ runner.os }}/${{ runner.arch }}");
    expect(VALIDATE_JOB).toContain("Assert changed-test shadow evidence completeness");
    expect(VALIDATE_JOB).toContain("scripts/changed-test-full-suite-status.mts");
    expect(VALIDATE_JOB).toContain("full-suite-status.json");
    expect(fullSuiteStep).toContain('exit "$full_suite_status"');
    const completenessStep = workflowStep("Assert changed-test shadow evidence completeness");
    expect(completenessStep).not.toContain("continue-on-error");
    expect(completenessStep).toContain(
      "if: ${{ !cancelled() && github.event_name == 'workflow_dispatch' }}",
    );
    expect(completenessStep).toContain("--check ci-reports/changed-test-plan/full-fast-lane.json");
    expect(completenessStep).toContain(
      "test -f ci-reports/changed-test-plan/full-evidence/records/full-suite-status.json",
    );
    expect(VALIDATE_JOB).toContain("Restore changed-test shadow baseline");
    const restoreBaseline = VALIDATE_JOB.slice(
      VALIDATE_JOB.indexOf("      - name: Restore changed-test shadow baseline"),
      VALIDATE_JOB.indexOf("      - name: Aggregate changed-test shadow full evidence"),
    );
    expect(restoreBaseline).toContain(
      "if: ${{ !cancelled() && github.event_name == 'workflow_dispatch' }}",
    );
    expect(VALIDATE_JOB).toContain("path: ci-reports/changed-test-plan/baseline.json");
    expect(VALIDATE_JOB).toContain(
      "key: changed-test-plan-${{ github.event.pull_request.number }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(VALIDATE_JOB).toContain("      - name: Aggregate changed-test shadow full evidence");
    expect(workflowStep("Aggregate changed-test shadow full evidence")).not.toContain(
      "continue-on-error",
    );
    expect(workflowStep("Aggregate changed-test shadow full evidence")).toContain(
      "if: ${{ !cancelled() && github.event_name == 'workflow_dispatch' }}",
    );
    expect(VALIDATE_JOB).toContain("scripts/test-evidence-bundle.mts");
    expect(workflowStep("Aggregate changed-test shadow full evidence")).toContain(
      "--input ci-reports/changed-test-plan/full-evidence/records/full-suite-status.json",
    );
    expect(VALIDATE_JOB).toContain("--output ci-reports/changed-test-plan/full-evidence");
    expect(VALIDATE_JOB).toContain("      - name: Measure changed-test selection misses");
    expect(workflowStep("Measure changed-test selection misses")).not.toContain(
      "continue-on-error",
    );
    expect(workflowStep("Measure changed-test selection misses")).toContain(
      "if: ${{ !cancelled() && github.event_name == 'workflow_dispatch' && hashFiles('ci-reports/changed-test-plan/full-evidence/bundle.json') != '' }}",
    );
    expect(VALIDATE_JOB).toContain("scripts/changed-test-plan-shadow.mts");
    expect(workflowStep("Measure changed-test selection misses")).not.toContain(
      "--execute-selected",
    );
    expect(VALIDATE_JOB).toContain("ci-reports/changed-test-plan/full-evidence/bundle.json");
    expect(VALIDATE_JOB).toContain("ci-reports/changed-test-plan/summary.md");
    expect(workflowStep("Upload verification evidence")).toContain("ci-reports/changed-test-plan");
  });

  it("produces native evidence for profiles whose affected graph schedules no reporter", () => {
    expect(createVerificationManifest("repo").some(({ id }) => id === "test")).toBe(false);
    const unrelatedSpine = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["packages/retry-core/src/libs/Retry.ts"],
      head: "HEAD",
    });
    expect(unrelatedSpine.find(({ id }) => id === "test")?.command).toEqual(
      expect.arrayContaining(["scripts/test-lane-runner.mts", "--lane", "fast"]),
    );
    expect(VALIDATE_JOB).toContain("pnpm --filter @croco/testing test");
  });

  it("reports whether the publish-only audit policy was selected", () => {
    expect(WORKFLOW).toContain('audit_policy_result="selected by the shared publish profile"');
    expect(WORKFLOW).toContain(
      'audit_policy_result="not selected by the $VERIFICATION_PROFILE profile"',
    );
  });

  it("preserves docs path routing, isolated API-doc checking, and link checks", () => {
    expect(WORKFLOW).toContain("- 'packages/*/README.md'");
    expect(WORKFLOW).toContain("run: pnpm docs:api:check");
    expect(WORKFLOW).toContain("--exclude-path '(^|/)packages/docs/README\\.md$'");
    expect((DOCS_SYNC_JOB as Readonly<Record<string, unknown>>).if).toBe("${{ always() }}");
    expect(DOCS_SYNC_JOB_SOURCE).not.toContain("TURBO_TOKEN");
    expect(DOCS_BUILD_JOB).not.toContain("TURBO_TOKEN");
    expect(WORKFLOW).not.toContain("secrets.TURBO_TOKEN");
    expect(DOCS_BUILD_JOB).toContain("needs: [changes, docs-sync-check]");
    expect(DOCS_BUILD_JOB).toContain(
      "turbo-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml', 'turbo.json') }}-docs-sync-check-${{ github.sha }}",
    );
    expect(DOCS_BUILD_JOB).toContain(
      "pnpm turbo run docs:build --cache=local:rw --cache-dir=.turbo/cache",
    );
    expect(DOCS_BUILD_JOB).toContain("--env-mode=strict --summarize");
  });

  it("runs independent CI surfaces in parallel and restores content-addressed Turbo state", () => {
    expect(WORKFLOW).toContain("docs-sync-check:\n    needs: changes");
    expect(WORKFLOW).not.toContain("docs-sync-check:\n    needs: [validate, changes]");
    expect(WORKFLOW).toContain(
      "windows-scaffold:\n    needs: changes\n    if: github.event_name == 'workflow_dispatch' || needs.changes.outputs.windows-scaffold == 'true'",
    );
    expect(WORKFLOW).toContain("actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
    expect(WORKFLOW).toContain("path: .turbo");
    expect(WORKFLOW).toContain(
      "pnpm --filter @croco/meta-vite exec vitest run src/tests/published-contract.spec.ts",
    );
    expect(WORKFLOW).toContain('node (Join-Path $packageDir "dist/bin.js") $targetDir');
    expect(WORKFLOW).not.toContain('node (Join-Path $packageDir "dist/index.js") $targetDir');
    expect(WORKFLOW).not.toContain("pnpm turbo run build --filter=create-croco-app... --force");
  });

  it("keeps heavyweight platform and real-resource suites off unrelated pull requests", () => {
    expect(WORKFLOW).not.toContain("              - 'packages/**'");
    expect(WORKFLOW).toContain("              - 'packages/create-croco-app/**'");
    expect(WORKFLOW).toContain("real-resource-tests:\n    needs: changes");
    expect(WORKFLOW).toContain(
      "real-resource-tests:\n    needs: changes\n    if: github.event_name == 'workflow_dispatch' || needs.changes.outputs.real-resources == 'true'",
    );
    expect(REAL_RESOURCE_JOB).toContain("permissions:\n      contents: read");
    expect(VALIDATE_JOB).not.toContain("membership-postgres:");
    expect(VALIDATE_JOB).not.toContain("Verify typed TestKernel resources");
    expect((DOCS_SYNC_JOB as Readonly<Record<string, unknown>>).if).toBe("${{ always() }}");
  });
});
