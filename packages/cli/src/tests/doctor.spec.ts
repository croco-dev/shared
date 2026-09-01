import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { renderUsage } from "citty";
import { Project } from "ts-morph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor, formatDoctorReport, getDoctorExitCode, runDoctor } from "../commands/doctor.js";
import type { DoctorDiagnostic, DoctorLocation, DoctorReport } from "../commands/doctor.js";
import { createCrocoCommand } from "../commands/root.js";
import { CLI_DIAGNOSTIC_CODES, CLI_LEGACY_DIAGNOSTIC_CODES } from "../libs/diagnosticCodes.js";

const tempRepos: string[] = [];

describe("doctor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const repo of tempRepos.splice(0)) {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("reports a stable workspace diagnostic when run outside a Croco monorepo", () => {
    const repo = createTempRepo();
    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorWorkspaceNotFound,
        legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorWorkspaceNotFound,
        severity: "error",
        action: expect.stringContaining("--cwd"),
      }),
    ]);
    expect(formatDoctorReport(report)).toContain("Location:");
    expect(getDoctorExitCode(report)).toBe(1);
  });

  it("passes when workspace discovery, repository-core boundary, and Lambda telemetry flush are healthy", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "repository-core", "@croco/repository-core");
    writeFile(repo, "packages/repository-core/src/index.ts", "export type Repository = {};\n");
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/handler.ts",
      [
        'import { lambdaPreset, TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init(lambdaPreset({ serviceName: 'api' }));",
        "export const handler = async () => {",
        "  try {",
        "    await telemetryReady;",
        "    return { statusCode: 200 };",
        "  } finally {",
        "    await telemetry.forceFlush();",
        "  }",
        "};",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: join(repo, "packages", "api") });

    expect(report.summary).toBe("healthy");
    expect(report.packageCount).toBe(2);
    expect(report.diagnostics).toEqual([]);
    expect(formatDoctorReport(report)).toContain("Diagnostics: none");
    expect(getDoctorExitCode(report)).toBe(0);
  });

  it("snapshots the healthy croco.doctor.v1 JSON report", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "repository-core", "@croco/repository-core");
    writeFile(repo, "packages/repository-core/src/index.ts", "export type Repository = {};\n");
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/handler.ts",
      [
        'import { lambdaPreset, TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init(lambdaPreset({ serviceName: 'api' }));",
        "export const handler = async () => {",
        "  try {",
        "    await telemetryReady;",
        "    return { statusCode: 200 };",
        "  } finally {",
        "    await telemetry.forceFlush();",
        "  }",
        "};",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: join(repo, "packages", "api") });

    expect(normalizeDoctorReportForSnapshot(report, repo)).toMatchInlineSnapshot(`
      {
        "checks": [
          {
            "diagnostics": [],
            "id": "workspace-discovery",
            "note": "2 package(s) discovered from pnpm-workspace.yaml",
            "status": "pass",
            "title": "Workspace discovery",
          },
          {
            "diagnostics": [],
            "id": "workspace-version-consistency",
            "note": "2 workspace package manifest(s) use consistent local dependency ranges.",
            "status": "pass",
            "title": "Workspace package version consistency",
          },
          {
            "diagnostics": [],
            "id": "spine-package-state",
            "note": "No external @croco spine package dependencies were declared.",
            "status": "skipped",
            "title": "Spine package install and build state",
          },
          {
            "diagnostics": [],
            "id": "contract-graph-readiness",
            "note": "No contract graph script or snapshot artifact was found.",
            "status": "skipped",
            "title": "ContractGraph artifact",
          },
          {
            "diagnostics": [],
            "id": "project-manifest-bundle",
            "note": ".croco/manifest was not found.",
            "status": "skipped",
            "title": "Project manifest bundle",
          },
          {
            "diagnostics": [],
            "id": "advisory-gate-readiness",
            "note": "No advisory release-hardening scripts or artifacts were found.",
            "status": "skipped",
            "title": "Advisory release-hardening readiness",
          },
          {
            "diagnostics": [],
            "id": "problem-registry-readiness",
            "note": "No ProblemRegistry artifact or drift-check script was found.",
            "status": "skipped",
            "title": "ProblemRegistry artifact drift gate",
          },
          {
            "diagnostics": [],
            "id": "runtime-capability-manifest",
            "note": "No runtime capability manifest or runtime-policy check script was found.",
            "status": "skipped",
            "title": "RuntimeCapabilityManifest presence",
          },
          {
            "diagnostics": [],
            "id": "http-security-middleware-contract",
            "note": "No @croco/transports-http createApp source was discovered.",
            "status": "skipped",
            "title": "HTTP security middleware contract",
          },
          {
            "diagnostics": [],
            "id": "di-graph-bootstrap",
            "note": ".croco/build/di-graph.manifest.json was not found.",
            "status": "skipped",
            "title": "DI graph bootstrap errors",
          },
          {
            "diagnostics": [],
            "id": "provider-certification",
            "note": "croco-saas-profile.manifest.json was not found.",
            "status": "skipped",
            "title": "Provider certification gaps",
          },
          {
            "diagnostics": [],
            "id": "repository-core-boundary",
            "note": "No Drizzle references found in packages/repository-core/src.",
            "status": "pass",
            "title": "repository-core dependency boundary",
          },
          {
            "diagnostics": [],
            "id": "lambda-telemetry-flush",
            "note": "No Lambda telemetry entrypoints are missing forceFlush().",
            "status": "pass",
            "title": "Lambda telemetry flush boundary",
          },
          {
            "diagnostics": [],
            "id": "application-intent-manifest",
            "note": "croco.app.json was not found; custom workspaces do not require it.",
            "status": "skipped",
            "title": "Application intent manifest",
          },
        ],
        "diagnostics": [],
        "packageCount": 2,
        "rootDir": "<workspace-root>",
        "summary": "healthy",
        "version": "croco.doctor.v1",
      }
    `);
  });

  it("snapshots the failing croco.doctor.v1 JSON report", () => {
    const repo = createTempRepo();

    const report = runDoctor({ cwd: repo });

    expect(normalizeDoctorReportForSnapshot(report, repo)).toMatchInlineSnapshot(`
      {
        "checks": [
          {
            "diagnostics": [
              {
                "action": "Run croco doctor from inside a Croco monorepo, or pass --cwd to a directory under the workspace root.",
                "cause": "croco doctor could not find pnpm-workspace.yaml by walking up from the execution directory.",
                "checkId": "workspace-discovery",
                "code": "CROCO_CLI_DOCTOR_001",
                "legacyCode": "doctor/workspace-not-found",
                "location": {
                  "file": "<cwd>",
                },
                "severity": "error",
              },
            ],
            "id": "workspace-discovery",
            "status": "fail",
            "title": "Workspace discovery",
          },
        ],
        "diagnostics": [
          {
            "action": "Run croco doctor from inside a Croco monorepo, or pass --cwd to a directory under the workspace root.",
            "cause": "croco doctor could not find pnpm-workspace.yaml by walking up from the execution directory.",
            "checkId": "workspace-discovery",
            "code": "CROCO_CLI_DOCTOR_001",
            "legacyCode": "doctor/workspace-not-found",
            "location": {
              "file": "<cwd>",
            },
            "severity": "error",
          },
        ],
        "packageCount": 0,
        "rootDir": null,
        "summary": "issues_detected",
        "version": "croco.doctor.v1",
      }
    `);
  });

  it("passes the application intent manifest check for a healthy generated workspace", () => {
    const repo = createWorkerGoalWorkspace();

    const report = runDoctor({ cwd: repo });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "application-intent-manifest",
        status: "pass",
        diagnostics: [],
      }),
    );
  });

  it("checks workspace quality-gate scripts on the manifest scope package", () => {
    const repo = createWorkerGoalWorkspace();
    writeWorkspacePackage(repo, "packages/ssr-worker", "@test/ssr-worker");
    writeWorkspacePackage(repo, "packages/a-ssr-worker", "@other/ssr-worker", {
      scripts: {
        "presentation:smoke": "tsx src/smoke/presentationSmoke.ts",
      },
    });

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CROCO_DOCTOR_APP_MANIFEST_WORKSPACE_DRIFT",
        cause: expect.stringContaining(
          "packages/ssr-worker/package.json#scripts.presentation:smoke",
        ),
      }),
    );
  });

  it("skips the application intent manifest check for a custom workspace", () => {
    const repo = createCrocoWorkspace();

    const report = runDoctor({ cwd: repo });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "application-intent-manifest",
        status: "skipped",
        diagnostics: [],
      }),
    );
  });

  it("reports malformed application intent JSON with a stable diagnostic", () => {
    const repo = createWorkerGoalWorkspace();
    writeFile(repo, "croco.app.json", "{ not json");

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CROCO_DOCTOR_APP_MANIFEST_JSON_INVALID",
        checkId: "application-intent-manifest",
        location: { file: "croco.app.json" },
      }),
    );
  });

  it("reports unsupported application intent manifest versions with a stable diagnostic", () => {
    const repo = createWorkerGoalWorkspace({ manifest: { schemaVersion: 2 } });

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CROCO_DOCTOR_APP_MANIFEST_VERSION_UNSUPPORTED",
        cause: expect.stringContaining("schemaVersion"),
        location: { file: "croco.app.json" },
      }),
    );
  });

  it.each([
    ["goal", "unknown-goal", "CROCO_DOCTOR_APP_MANIFEST_GOAL_UNSUPPORTED"],
    ["runtimeTarget", "unknown-runtime", "CROCO_DOCTOR_APP_MANIFEST_RUNTIME_UNSUPPORTED"],
    [
      "providers",
      ["cloudflare-workers", "unknown-provider"],
      "CROCO_DOCTOR_APP_MANIFEST_PROVIDER_UNSUPPORTED",
    ],
  ])(
    "reports unsupported application intent %s values with a distinct stable diagnostic",
    (field, value, code) => {
      const repo = createWorkerGoalWorkspace({ manifest: { [field]: value } });

      const report = runDoctor({ cwd: repo });

      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          code,
          cause: expect.stringContaining(`croco.app.json.${field}`),
          location: { file: "croco.app.json" },
        }),
      );
    },
  );

  it("reports supported values that contradict the selected goal contract", () => {
    const repo = createWorkerGoalWorkspace({ manifest: { goal: "saas-api" } });

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CROCO_DOCTOR_APP_MANIFEST_GOAL_CONTRACT_MISMATCH",
        cause: expect.stringMatching(/croco\.app\.json\.runtimeTarget.*saas-api.*node/),
        location: { file: "croco.app.json" },
      }),
    );
  });

  it("identifies the manifest field and package evidence when declared provider intent drifts", () => {
    const repo = createWorkerGoalWorkspace({ includeMetaVite: false });

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CROCO_DOCTOR_APP_MANIFEST_WORKSPACE_DRIFT",
        cause: expect.stringMatching(
          /croco\.app\.json\.providers\[1\].*@croco\/meta-vite.*package\.json/,
        ),
        location: { file: "croco.app.json" },
      }),
    );
  });

  it("requires the concrete in-memory events adapter declared by generated application intent", () => {
    const repo = createSpaBackendSplitGoalWorkspace({ includeEventsInmemory: false });

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CROCO_DOCTOR_APP_MANIFEST_WORKSPACE_DRIFT",
        cause: expect.stringMatching(
          /croco\.app\.json\.providers\[1\].*@croco\/events-inmemory.*package\.json/,
        ),
        location: { file: "croco.app.json" },
      }),
    );
  });

  it("identifies the manifest field and root script evidence when a declared quality gate drifts", () => {
    const repo = createWorkerGoalWorkspace({ includeBuildScript: false });

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CROCO_DOCTOR_APP_MANIFEST_WORKSPACE_DRIFT",
        cause: expect.stringMatching(
          /croco\.app\.json\.qualityGates\[2\].*package\.json#scripts\.build/,
        ),
        location: { file: "croco.app.json" },
      }),
    );
  });

  it("discovers packages from inline workspace arrays and excludes negated globs", () => {
    const repo = createTempRepo();
    writeFile(repo, "pnpm-workspace.yaml", "packages: ['apps/*', 'libs/**', '!libs/legacy/**']\n");
    writeWorkspacePackage(repo, "apps/api", "@croco/app-api");
    writeWorkspacePackage(repo, "libs/shared/provider", "@croco/provider");
    writeWorkspacePackage(repo, "libs/legacy/provider", "@croco/legacy-provider");

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("healthy");
    expect(report.packageCount).toBe(2);
    expect(formatDoctorReport(report)).toContain("2 package(s) discovered");
  });

  it("fails workspace discovery when configured package globs resolve no packages", () => {
    const repo = createTempRepo();
    writeFile(repo, "pnpm-workspace.yaml", "packages: ['apps/*']\n");

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorWorkspacePackagesEmpty,
        legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorWorkspacePackagesEmpty,
        location: expect.objectContaining({ file: "pnpm-workspace.yaml" }),
      }),
    ]);
  });

  it("reports invalid package manifests as stable doctor diagnostics", () => {
    const repo = createCrocoWorkspace();
    writeFile(repo, "packages/api/package.json", "{ not json");

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorWorkspacePackageInvalid,
        legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorWorkspacePackageInvalid,
        location: expect.objectContaining({ file: "packages/api/package.json" }),
        action: expect.stringContaining("valid JSON"),
      }),
    ]);
  });

  it("flags repository-core Drizzle implementation leakage with location and recovery action", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "repository-core", "@croco/repository-core");
    writeFile(
      repo,
      "packages/repository-core/src/index.ts",
      "export type LeakedTable = import('drizzle-orm').Table;\n",
    );

    const report = runDoctor({ cwd: repo });
    const markdown = formatDoctorReport(report);

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorRepositoryCoreDrizzleBoundary,
        legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorRepositoryCoreDrizzleBoundary,
        location: expect.objectContaining({
          file: "packages/repository-core/src/index.ts",
          line: 1,
          packageName: "@croco/repository-core",
        }),
      }),
    ]);
    expect(markdown).toContain("Cause: @croco/repository-core is an interface layer");
    expect(markdown).toContain("Action: Move Drizzle-specific types");
  });

  it("flags Lambda telemetry initialization that cannot prove forceFlush before return", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/handler.ts",
      [
        'import { lambdaPreset, TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init(lambdaPreset({ serviceName: 'api' }));",
        "export const handler = async () => {",
        "  await telemetryReady;",
        "  return { statusCode: 200 };",
        "};",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
        legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
        location: expect.objectContaining({
          file: "packages/api/src/handler.ts",
          line: 1,
          packageName: "@croco/api",
        }),
        action: expect.stringContaining("finally"),
      }),
    ]);
  });

  it("does not treat comments or unused helpers as Lambda telemetry flush evidence", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/handler.ts",
      [
        'import { lambdaPreset, TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init(lambdaPreset({ serviceName: 'api' }));",
        "async function flushTelemetry() {",
        "  await telemetry.forceFlush();",
        "}",
        "export const handler = async () => {",
        "  await telemetryReady;",
        "  // TODO: call telemetry.forceFlush() before returning",
        "  return { statusCode: 200 };",
        "};",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
        legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    ]);
  });

  it("falls back to a missing flush diagnostic when Lambda AST analysis fails", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/handler.ts",
      [
        'import { TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init({ serviceName: 'api' });",
        "const crocoHandler = createCrocoApp().lambdaHandler({ flush: flushTelemetry });",
        "export const handler = async (...args: Parameters<typeof crocoHandler>) => {",
        "  await telemetryReady;",
        "  return crocoHandler(...args);",
        "};",
        "",
      ].join("\n"),
    );
    vi.spyOn(Project.prototype, "createSourceFile").mockImplementationOnce(() => {
      throw new Error("AST analysis failed");
    });

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
  });

  it("accepts a delegated Croco Lambda handler configured with a telemetry flush boundary", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/lambda.ts",
      [
        'import { TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init({ serviceName: 'api' });",
        "const crocoHandler = createCrocoApp().lambdaHandler({",
        "  flush: async () => {",
        "    await telemetry.forceFlush();",
        "  },",
        "});",
        "export const handler = async (...args: Parameters<typeof crocoHandler>) => {",
        "  await telemetryReady;",
        "  return crocoHandler(...args);",
        "};",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
    expect(report.checks.find((check) => check.id === "lambda-telemetry-flush")?.status).toBe(
      "pass",
    );
  });

  it("flags a preset Lambda handler without a telemetry flush boundary", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/handler.ts",
      [
        'import { createLambdaHandler } from "@croco/preset-lambda";',
        'import { lambdaPreset, TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "void telemetry.init(lambdaPreset({ serviceName: 'api' }));",
        "export const handler = createLambdaHandler({ fetch: async () => new Response('ok') });",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
    expect(report.checks.find((check) => check.id === "lambda-telemetry-flush")?.status).toBe(
      "fail",
    );
  });

  it("accepts a preset Lambda handler configured with a telemetry flush boundary", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/handler.ts",
      [
        'import { createLambdaHandler } from "@croco/preset-lambda";',
        'import { lambdaPreset, TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "void telemetry.init(lambdaPreset({ serviceName: 'api' }));",
        "export const handler = createLambdaHandler(",
        "  { fetch: async () => new Response('ok') },",
        "  { flush: async () => telemetry.forceFlush() },",
        ");",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
    expect(report.checks.find((check) => check.id === "lambda-telemetry-flush")?.status).toBe(
      "pass",
    );
  });

  it("accepts a canonical Lambda host bound to an application runtime", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/lambda.ts",
      [
        'import { createLambdaHost } from "@croco/preset-lambda";',
        'import { TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init({ serviceName: 'api' });",
        "const app = {",
        "  applicationRuntime: { bindHostCallback: <T>(callback: T): T => callback },",
        "};",
        "const lambdaHost = createLambdaHost(",
        "  { fetch: async () => new Response('ok') },",
        "  { flush: async () => telemetry.forceFlush() },",
        ");",
        "const telemetryAwareLambdaHost = async (...args: Parameters<typeof lambdaHost>) => {",
        "  await telemetryReady;",
        "  return lambdaHost(...args);",
        "};",
        "export const handler =",
        "  app.applicationRuntime.bindHostCallback(telemetryAwareLambdaHost);",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
    expect(report.checks.find((check) => check.id === "lambda-telemetry-flush")?.status).toBe(
      "pass",
    );
  });

  it.each([
    {
      importStatement:
        'import { createLambdaHandler as createPresetHandler } from "@croco/preset-lambda";',
      invocation: "createPresetHandler",
      label: "aliased",
    },
    {
      importStatement: 'import * as lambdaPreset from "@croco/preset-lambda";',
      invocation: "lambdaPreset.createLambdaHandler",
      label: "namespace",
    },
  ])("accepts an $label preset Lambda handler import", ({ importStatement, invocation }) => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/handler.ts",
      [
        importStatement,
        'import { lambdaPreset, TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "void telemetry.init(lambdaPreset({ serviceName: 'api' }));",
        `export const handler = ${invocation}(`,
        "  { fetch: async () => new Response('ok') },",
        "  { flush: async () => telemetry.forceFlush() },",
        ");",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
  });

  it("does not treat an unrelated createLambdaHandler function as a Croco flush boundary", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/handler.ts",
      [
        'import { lambdaPreset, TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "void telemetry.init(lambdaPreset({ serviceName: 'api' }));",
        "function createLambdaHandler(_app: unknown, _options: unknown) {",
        "  return async () => ({ statusCode: 200 });",
        "}",
        "export const handler = createLambdaHandler(",
        "  {},",
        "  { flush: async () => telemetry.forceFlush() },",
        ");",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
  });

  it.each([
    {
      exportStatement: "export const handler = crocoHandler;",
      label: "direct handler export",
    },
    {
      exportStatement: "export default crocoHandler;",
      label: "default handler export",
    },
  ])("accepts a configured handler exposed through a $label", ({ exportStatement }) => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/lambda.ts",
      [
        'import { TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const crocoHandler = createCrocoApp().lambdaHandler({",
        "  flush: async () => telemetry.forceFlush(),",
        "});",
        exportStatement,
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.checks.find((check) => check.id === "lambda-telemetry-flush")?.status).toBe(
      "pass",
    );
  });

  it.each([
    {
      label: "shorthand property",
      setup: [
        "const flush = async () => {",
        "  await telemetry.forceFlush();",
        "};",
        "const crocoHandler = createCrocoApp().lambdaHandler({ flush });",
      ],
    },
    {
      label: "method property",
      setup: [
        "const crocoHandler = createCrocoApp().lambdaHandler({",
        "  async flush() {",
        "    await telemetry.forceFlush();",
        "  },",
        "});",
      ],
    },
  ])("accepts a delegated flush configured with a $label", ({ setup }) => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/lambda.ts",
      [
        'import { TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init({ serviceName: 'api' });",
        ...setup,
        "export const handler = async (...args: Parameters<typeof crocoHandler>) => {",
        "  await telemetryReady;",
        "  return crocoHandler(...args);",
        "};",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.checks.find((check) => check.id === "lambda-telemetry-flush")?.status).toBe(
      "pass",
    );
  });

  it("rejects strings and unrelated properties as delegated flush evidence", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/lambda.ts",
      [
        'import { TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init({ serviceName: 'api' });",
        "const crocoHandler = createCrocoApp().lambdaHandler({",
        '  flush: async () => "telemetry.forceFlush()",',
        "  inspect: async () => telemetry.forceFlush(),",
        "});",
        "export const handler = async (...args: Parameters<typeof crocoHandler>) => {",
        "  await telemetryReady;",
        "  return crocoHandler(...args);",
        "};",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
  });

  it.each([
    {
      label: "unrelated receiver",
      flushBody: ["  await cache.forceFlush();"],
    },
    {
      label: "uninvoked nested function",
      flushBody: [
        "  const neverCalled = async () => telemetry.forceFlush();",
        "  void neverCalled;",
      ],
    },
    {
      label: "shadowed telemetry runtime binding",
      flushBody: ["  const telemetry = cache;", "  await telemetry.forceFlush();"],
    },
  ])("rejects a $label as delegated telemetry flush evidence", ({ flushBody }) => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/lambda.ts",
      [
        'import { TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init({ serviceName: 'api' });",
        "const cache = { forceFlush: async () => undefined };",
        "const crocoHandler = createCrocoApp().lambdaHandler({",
        "  flush: async () => {",
        ...flushBody,
        "  },",
        "});",
        "export const handler = async (...args: Parameters<typeof crocoHandler>) => {",
        "  await telemetryReady;",
        "  return crocoHandler(...args);",
        "};",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
  });

  it("rejects a shadowed delegated handler binding", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/lambda.ts",
      [
        'import { TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init({ serviceName: 'api' });",
        "const crocoHandler = createCrocoApp().lambdaHandler({",
        "  flush: async () => telemetry.forceFlush(),",
        "});",
        "export const handler = async (...args: Parameters<typeof crocoHandler>) => {",
        "  await telemetryReady;",
        "  const crocoHandler = async () => ({ statusCode: 200 });",
        "  return crocoHandler(...args);",
        "};",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
  });

  it("rejects an uninvoked nested delegated handler call", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeFile(
      repo,
      "packages/api/src/lambda.ts",
      [
        'import { TelemetryRuntime } from "@croco/telemetry-sdk-node";',
        "const telemetry = TelemetryRuntime.getInstance();",
        "const telemetryReady = telemetry.init({ serviceName: 'api' });",
        "const crocoHandler = createCrocoApp().lambdaHandler({",
        "  flush: async () => telemetry.forceFlush(),",
        "});",
        "const fallbackHandler = async () => ({ statusCode: 200 });",
        "export const handler = async () => {",
        "  await telemetryReady;",
        "  const neverCalled = async () => crocoHandler();",
        "  void neverCalled;",
        "  return fallbackHandler();",
        "};",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorLambdaTelemetryFlushMissing,
      }),
    );
  });

  it("passes generated SaaS-style readiness artifacts without live provider credentials", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "contract:snapshot": "croco contracts check --json --out contract-graph.snapshot.json",
        "runtime-policy:check":
          "croco runtime-policy check --manifest croco-runtime-policy.manifest.json",
      },
      devDependencies: {
        "@croco/cli": "file:../packs/croco-cli.tgz",
      },
    });
    writeWorkspacePackage(repo, "packages/api", "@smoke/api-server", {
      dependencies: {
        "@croco/auth-better-auth": "file:../packs/croco-auth-better-auth.tgz",
        "@croco/problems-core": "file:../packs/croco-problems-core.tgz",
        "@croco/transports-http": "file:../packs/croco-transports-http.tgz",
      },
    });
    writeFile(
      repo,
      "packages/api/src/app.ts",
      [
        'import { bodyLimitMiddleware, corsMiddleware, createApp, rateLimitHttpMiddleware, securityHeadersMiddleware } from "@croco/transports-http";',
        "export function createApiApp() {",
        "  return createApp({",
        "    controllers: [],",
        "    middlewares: [",
        "      securityHeadersMiddleware(),",
        "      corsMiddleware({ origins: ['http://localhost:5173'] }),",
        "      bodyLimitMiddleware({ limit: 1024 }),",
        "      rateLimitHttpMiddleware({ rateLimiter: {} as never, policy: {} as never }),",
        "    ],",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    writeNodeModulePackage(repo, "@croco/cli");
    for (const packageName of [
      "@croco/auth-better-auth",
      "@croco/problems-core",
      "@croco/transports-http",
    ]) {
      writeNodeModulePackage(repo, packageName, "packages/api");
    }
    writeJson(repo, "contract-graph.snapshot.json", {
      snapshotVersion: "croco.contract-graph.snapshot.v1",
      graphVersion: "croco.contract-graph.v1",
      controllerCount: 0,
      routeCount: 0,
      operationIds: [],
      controllers: [],
      routes: [],
      diagnostics: [],
    });
    writeJson(repo, "croco-runtime-policy.manifest.json", {
      schemaVersion: "croco.runtime-policy/v1",
      runtime: { platform: "node" },
      table: { plans: [] },
    });
    writeJson(repo, "croco-saas-profile.manifest.json", {
      schemaVersion: "croco.saas-provider-profile/v1",
      profile: {
        name: "saas-node-postgres",
        displayName: "Node/Postgres SaaS",
        runtimeTarget: "node",
      },
      packages: ["@croco/auth-better-auth"],
      capabilities: [
        "runtime",
        "auth",
        "billing",
        "metering",
        "storage",
        "tasks",
        "telemetry",
        "webhookVerification",
      ].map((capability) => ({
        capability,
        provider: "zero-credential",
        status: "configured",
        env: [],
        notes: "covered by generated smoke",
      })),
    });

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("healthy");
    expect(report.diagnostics).toEqual([]);
    expect(getDoctorExitCode(report)).toBe(0);
    expect(report.checks.map((check) => check.id)).toEqual([
      "workspace-discovery",
      "workspace-version-consistency",
      "spine-package-state",
      "contract-graph-readiness",
      "project-manifest-bundle",
      "advisory-gate-readiness",
      "problem-registry-readiness",
      "runtime-capability-manifest",
      "http-security-middleware-contract",
      "di-graph-bootstrap",
      "provider-certification",
      "repository-core-boundary",
      "lambda-telemetry-flush",
      "application-intent-manifest",
    ]);
  });

  it("passes generated app profile consistency when current runtime and provider artifacts match", () => {
    const repo = createCrocoWorkspace();
    writeHealthySaasProviderDoctorWorkspace(repo);
    writeRuntimeCapabilityManifest(repo, "node");

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("healthy");
    expect(report.diagnostics).toEqual([]);
  });

  it("rejects runtime composition metadata whose host disagrees with the compatibility platform", () => {
    const repo = createCrocoWorkspace();
    writeHealthySaasProviderDoctorWorkspace(repo);
    writeRuntimeCapabilityManifest(repo, "node", "lambda");

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorRuntimeCapabilityManifestInvalid,
        location: { file: "croco-runtime-capability.manifest.json" },
      }),
    ]);
  });

  it("fails generated app profile consistency when runtime and provider targets differ", () => {
    const repo = createCrocoWorkspace();
    writeHealthySaasProviderDoctorWorkspace(repo);
    writeRuntimeCapabilityManifest(repo, "cloudflare-workers");

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorRuntimeProfileMismatch,
        cause: expect.stringContaining(
          "Runtime target 'cloudflare-workers' from croco-runtime-capability.manifest.json does not match provider runtimeTarget 'node'",
        ),
        location: expect.objectContaining({ file: "croco-saas-profile.manifest.json" }),
        action:
          "Regenerate the runtime capability and provider profile artifacts from the same application profile, then rerun croco doctor.",
      }),
    ]);
    expect(getDoctorExitCode(report)).toBe(1);
  });

  it("preserves the provider diagnostic when a profile artifact is malformed", () => {
    const repo = createCrocoWorkspace();
    writeHealthySaasProviderDoctorWorkspace(repo);
    writeRuntimeCapabilityManifest(repo, "cloudflare-workers");
    writeProviderProfileManifest(repo, { profile: "invalid" });

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorProviderProfileInvalid,
      }),
    ]);
  });

  it("rejects a current provider profile that omits its runtime target", () => {
    const repo = createCrocoWorkspace();
    writeHealthySaasProviderDoctorWorkspace(repo);
    writeRuntimeCapabilityManifest(repo, "cloudflare-workers");
    writeProviderProfileManifest(repo, {
      profile: { name: "saas-node-postgres" },
    });

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorProviderProfileInvalid,
        cause: expect.stringContaining("is not a croco.saas-provider-profile/v1 artifact"),
      }),
    ]);
  });

  it("preserves the provider parse diagnostic when a profile artifact contains invalid JSON", () => {
    const repo = createCrocoWorkspace();
    writeHealthySaasProviderDoctorWorkspace(repo);
    writeRuntimeCapabilityManifest(repo, "cloudflare-workers");
    writeFile(repo, "croco-saas-profile.manifest.json", "{ invalid json");

    const report = runDoctor({ cwd: repo });

    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorProviderProfileInvalid,
        cause: expect.stringContaining("could not be parsed"),
      }),
    ]);
  });

  it("fails generated SaaS provider readiness when the provider manifest version is unsupported", () => {
    const repo = createCrocoWorkspace();
    writeHealthySaasProviderDoctorWorkspace(repo);
    writeRuntimeCapabilityManifest(repo, "cloudflare-workers");
    writeProviderProfileManifest(repo, {
      schemaVersion: "croco.saas-provider-profile/v2",
    });

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorProviderProfileVersionUnsupported,
        cause: expect.stringContaining("croco.saas-provider-profile/v2"),
        action: expect.stringContaining("migration guidance"),
      }),
    ]);
    expect(getDoctorExitCode(report)).toBe(1);
  });

  it("fails generated SaaS provider readiness when the linked tenant manifest version is unsupported", () => {
    const repo = createCrocoWorkspace();
    writeHealthySaasProviderDoctorWorkspace(repo);
    writeProviderProfileManifest(repo, {
      tenantModel: {
        manifest: "croco-tenant-model.manifest.json",
      },
    });
    writeTenantModelManifest(repo, {
      schemaVersion: "croco.tenant-model/v2",
    });

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorTenantModelVersionUnsupported,
        cause: expect.stringContaining("croco.tenant-model/v2"),
        location: expect.objectContaining({ file: "croco-tenant-model.manifest.json" }),
      }),
    ]);
    expect(getDoctorExitCode(report)).toBe(1);
  });

  it("passes generated SaaS provider readiness when the linked tenant manifest uses the v1 contract", () => {
    const repo = createCrocoWorkspace();
    writeHealthySaasProviderDoctorWorkspace(repo);
    writeProviderProfileManifest(repo, {
      tenantModel: {
        manifest: "croco-tenant-model.manifest.json",
      },
    });
    writeTenantModelManifest(repo);

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("healthy");
    expect(report.diagnostics).toEqual([]);
    expect(getDoctorExitCode(report)).toBe(0);
  });

  it("passes advisory release-hardening readiness when local evidence is present", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"], { spine: [] });
    writePassingCoreCoverageEvidence(repo);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeJson(repo, "scripts/static-misuse-raw-error-allowlist.json", {
      schemaVersion: 1,
      entries: [
        {
          package: "@croco/framework-context",
          file: "packages/framework-context/src/index.ts",
          line: 1,
          excerpt: "throw new Error('internal invariant');",
          reason: "Reviewed internal invariant while migrating static misuse diagnostics.",
          owner: "framework-error-handling",
        },
      ],
    });

    const report = runDoctor({ cwd: repo });
    const check = report.checks.find((candidate) => candidate.id === "advisory-gate-readiness");

    expect(report.summary).toBe("healthy");
    expect(check).toMatchObject({ status: "pass", diagnostics: [] });
    expect(report.diagnostics).toEqual([]);
    expect(getDoctorExitCode(report)).toBe(0);
  });

  it("accepts preserved benchmark pre-promotion baseline failures as advisory evidence", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"], { spine: [] });
    writePassingCoreCoverageEvidence(repo);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo, { prePromotionBaselineFailuresPerRun: 1 });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const check = report.checks.find((candidate) => candidate.id === "advisory-gate-readiness");

    expect(report.summary).toBe("healthy");
    expect(check).toMatchObject({ status: "pass", diagnostics: [] });
    expect(report.diagnostics).toEqual([]);
    expect(getDoctorExitCode(report)).toBe(0);
  });

  it("honors temporary core coverage selection exclusions", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/problems-core exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"], { spine: [] });
    writeCoreCoverageTemporaryExclusion(
      repo,
      "@croco/framework-context",
      "Temporary baseline stabilization while coverage rows are reviewed.",
    );
    writePassingCoreCoverageEvidence(repo, "@croco/problems-core");
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const check = report.checks.find((candidate) => candidate.id === "advisory-gate-readiness");

    expect(report.summary).toBe("healthy");
    expect(check).toMatchObject({ status: "pass", diagnostics: [] });
    expect(report.diagnostics).toEqual([]);
    expect(getDoctorExitCode(report)).toBe(0);
  });

  it("does not report private packages as core coverage candidates", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/problems-core exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-private", "@croco/framework-private", {
      private: true,
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-private"]);
    writePassingCoreCoverageEvidence(repo, "@croco/problems-core");
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo, {
      package: "@croco/framework-private",
      file: "packages/framework-private/src/index.ts",
    });

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toEqual([]);
  });

  it("keeps spine packages visible even when temporary core coverage exclusions are configured", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/problems-core exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeCoreCoverageTemporaryExclusion(
      repo,
      "@croco/framework-context",
      "Temporary baseline stabilization while coverage rows are reviewed.",
    );
    writePassingCoreCoverageEvidence(repo, "@croco/problems-core");
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        cause: expect.stringContaining("1.0 spine package"),
      }),
    ]);
  });

  it("reports core coverage filter and threshold-set mismatches", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeCoreCoverageConfig(repo, ["@croco/problems-core"]);
    writePassingCoreCoverageEvidence(repo, "@croco/problems-core");
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const causes = report.diagnostics
      .filter(
        (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
      )
      .map((diagnostic) => diagnostic.cause);

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(causes).toEqual([
      expect.stringContaining("missing from the shared core coverage config"),
      expect.stringContaining("missing from test:coverage:core filters"),
    ]);
  });

  it("uses shared coverage ownership instead of dispatcher prerequisite filters", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "pnpm --filter @croco/problems-core build && node --experimental-strip-types scripts/verification-command.mts --id core-coverage",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeCoreCoverageConfig(repo, ["@croco/framework-context"]);
    writePassingCoreCoverageEvidence(repo);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const coverageDiagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(coverageDiagnostics).toEqual([]);
  });

  it("reports a missing core coverage warning script when core coverage is configured", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"], { spine: [] });
    rmSync(join(repo, "scripts/core-coverage-warning-check.mts"));
    writePassingCoreCoverageEvidence(repo);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        location: { file: "scripts/core-coverage-warning-check.mts" },
        cause: expect.stringContaining("core-coverage-warning-check.mts is missing"),
      }),
    ]);
  });

  it("reports a missing package catalog when core coverage readiness is configured", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("docs/package-catalog.json is missing");
  });

  it("reports missing core coverage threshold config when readiness is configured", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    rmSync(join(repo, "scripts/core-coverage-config.mts"));
    writePassingCoreCoverageEvidence(repo);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain(
      "scripts/core-coverage-config.mts is missing CORE_COVERAGE_PACKAGES",
    );
  });

  it("reports missing core coverage threshold constants when package selection exists", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeFile(repo, "vitest.config.ts", "export const OTHER_COVERAGE_THRESHOLDS = {};\n");
    writePassingCoreCoverageEvidence(repo);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("vitest.config.ts is missing CORE_COVERAGE_THRESHOLDS");
  });

  it("accepts semicolonless core coverage threshold constants", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeFile(
      repo,
      "vitest.config.ts",
      [
        "export const CORE_COVERAGE_THRESHOLDS = {",
        "  lines: 80,",
        "  branches: 80,",
        "  functions: 80,",
        "  statements: 80,",
        "}",
        "",
      ].join("\n"),
    );
    writePassingCoreCoverageEvidence(repo);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("reports missing core coverage summaries for selected packages", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].location?.file).toBe(
      "packages/framework-context/coverage/coverage-summary.json",
    );
    expect(diagnostics[0].cause).toContain("coverage summary not found");
  });

  it("reports core coverage threshold and baseline regressions", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeJson(repo, "packages/framework-context/coverage/coverage-summary.json", {
      total: {
        statements: { pct: 70 },
        branches: { pct: 70 },
        functions: { pct: 70 },
        lines: { pct: 70 },
      },
    });
    writeFile(
      repo,
      "ci-reports/coverage/core-baseline.txt",
      [
        "| Package | Statements | Branches | Functions | Lines |",
        "|---------|-----------:|---------:|----------:|------:|",
        "| `@croco/framework-context` | 75 | 70 | 60 | 90 |",
        "",
      ].join("\n"),
    );
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("threshold warning(s)");
    expect(diagnostics[0].cause).toContain("lines 70.00% < 80%");
    expect(diagnostics[0].cause).toContain("baseline warning(s)");
    expect(diagnostics[0].cause).toContain("lines 70.00% < baseline 90.00%");
  });

  it("reports core coverage baseline hard errors", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeCoreCoverageSummary(repo, "@croco/framework-context");
    writeFile(
      repo,
      "ci-reports/coverage/core-baseline.txt",
      [
        "| Package | Statements | Branches | Functions | Lines |",
        "|---------|-----------:|---------:|----------:|------:|",
        "| `@croco/framework-context` | 0 | 12abc | 92.69 | 84.81 |",
        "",
      ].join("\n"),
    );
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("baseline branches must be numeric");
    expect(diagnostics[0].cause).toContain("baseline statements cannot be 0");
  });

  it("reports missing core coverage baseline rows when summaries exist", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeCoreCoverageSummary(repo, "@croco/framework-context");
    writeFile(
      repo,
      "ci-reports/coverage/core-baseline.txt",
      [
        "| Package | Statements | Branches | Functions | Lines |",
        "|---------|-----------:|---------:|----------:|------:|",
        "",
      ].join("\n"),
    );
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain(
      "baseline entry is missing when coverage summary exists",
    );
  });

  it("reports malformed core coverage summaries even when baseline rows exist", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeJson(repo, "packages/framework-context/coverage/coverage-summary.json", {
      total: {
        statements: { pct: 80 },
      },
    });
    writeFile(
      repo,
      "ci-reports/coverage/core-baseline.txt",
      [
        "| Package | Statements | Branches | Functions | Lines |",
        "|---------|-----------:|---------:|----------:|------:|",
        "| `@croco/framework-context` | 80 | 80 | 80 | 80 |",
        "",
      ].join("\n"),
    );
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].location?.file).toBe(
      "packages/framework-context/coverage/coverage-summary.json",
    );
    expect(diagnostics[0].cause).toContain(
      "coverage-summary.json total branches, functions, lines pct must be numeric",
    );
  });

  it("reports missing core coverage baseline files when summaries exist", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeCoreCoverageSummary(repo, "@croco/framework-context");
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].location?.file).toBe("ci-reports/coverage/core-baseline.txt");
    expect(diagnostics[0].cause).toContain(
      "baseline entry is missing when coverage summary exists",
    );
  });

  it("honors intentional core coverage zero-baseline reasons", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeCoreCoverageSummary(repo, "@croco/framework-context");
    writeCoreCoverageIntentionalZeroBaselineReason(
      repo,
      "@croco/framework-context",
      "bootstrap package with no branchable statements yet",
    );
    writeFile(
      repo,
      "ci-reports/coverage/core-baseline.txt",
      [
        "| Package | Statements | Branches | Functions | Lines |",
        "|---------|-----------:|---------:|----------:|------:|",
        "| `@croco/framework-context` | 0 | 0 | 80 | 80 |",
        "",
      ].join("\n"),
    );
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("ignores commented-out intentional core coverage zero-baseline reasons", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeCoreCoverageSummary(repo, "@croco/framework-context");
    writeFile(
      repo,
      "scripts/core-coverage-warning-check.mts",
      [
        "const INTENTIONAL_ZERO_BASELINE_REASONS: Record<string, string> = {",
        '  // "@croco/framework-context": "bootstrap package with no branchable statements yet",',
        "  /*",
        '  "@croco/framework-context": "commented block reason",',
        "  */",
        "};",
        "",
      ].join("\n"),
    );
    writeFile(
      repo,
      "ci-reports/coverage/core-baseline.txt",
      [
        "| Package | Statements | Branches | Functions | Lines |",
        "|---------|-----------:|---------:|----------:|------:|",
        "| `@croco/framework-context` | 0 | 0 | 92.69 | 84.81 |",
        "",
      ].join("\n"),
    );
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("baseline statements, branches cannot be 0");
  });

  it("rejects malformed bundle-size baseline entries as advisory readiness warning", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writePassingCoreCoverageEvidence(repo);
    writeJson(repo, "ci-reports/bundle-size/baseline.json", {
      schemaVersion: 1,
      artifacts: {
        "@croco/framework-context:packages/framework-context/dist/index.js": "1024",
      },
    });
    writeBenchmarkVarianceEvidence(repo);
    writeJson(repo, "scripts/static-misuse-raw-error-allowlist.json", {
      schemaVersion: 1,
      entries: [
        {
          package: "@croco/framework-context",
          file: "packages/framework-context/src/index.ts",
          line: 1,
          excerpt: "throw new Error('internal invariant');",
          reason: "Reviewed internal invariant while migrating static misuse diagnostics.",
          owner: "framework-error-handling",
        },
      ],
    });

    const report = runDoctor({ cwd: repo });
    const check = report.checks.find((candidate) => candidate.id === "advisory-gate-readiness");

    expect(report.summary).toBe("healthy");
    expect(check).toMatchObject({ status: "fail" });
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
        cause: expect.stringContaining("must be a non-negative byte number"),
      }),
    ]);
    expect(getDoctorExitCode(report)).toBe(0);
  });

  it("rejects empty bundle-size baseline artifacts as advisory readiness warning", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writePassingCoreCoverageEvidence(repo);
    writeJson(repo, "ci-reports/bundle-size/baseline.json", {
      schemaVersion: 1,
      artifacts: {},
    });
    writeBenchmarkVarianceEvidence(repo);
    writeJson(repo, "scripts/static-misuse-raw-error-allowlist.json", {
      schemaVersion: 1,
      entries: [
        {
          package: "@croco/framework-context",
          file: "packages/framework-context/src/index.ts",
          line: 1,
          excerpt: "throw new Error('internal invariant');",
          reason: "Reviewed internal invariant while migrating static misuse diagnostics.",
          owner: "framework-error-handling",
        },
      ],
    });

    const report = runDoctor({ cwd: repo });
    const check = report.checks.find((candidate) => candidate.id === "advisory-gate-readiness");

    expect(report.summary).toBe("healthy");
    expect(check).toMatchObject({ status: "fail" });
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
        cause: expect.stringContaining("does not contain any baseline entries"),
      }),
    ]);
    expect(getDoctorExitCode(report)).toBe(0);
  });

  it("rejects bundle-size baselines that drift from measured artifacts", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeFile(repo, "packages/framework-context/dist/index.js", "export const runtime = 'cjs';\n");
    writeFile(repo, "packages/framework-context/dist/index.mjs", "export const runtime = 'esm';\n");
    writeJson(repo, "ci-reports/bundle-size/baseline.json", {
      schemaVersion: 1,
      artifacts: {
        "@croco/framework-context:packages/framework-context/dist/index.js": 1024,
        "@croco/framework-context:packages/framework-context/dist/legacy.js": 512,
      },
    });
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("missing current artifact baseline");
    expect(diagnostics[0].cause).toContain("stale baseline key");
  });

  it("rejects bundle-size artifacts that exceed committed baselines", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeFile(repo, "packages/framework-context/dist/index.js", "export const runtime = 'cjs';\n");
    writeJson(repo, "ci-reports/bundle-size/baseline.json", {
      schemaVersion: 1,
      artifacts: {
        "@croco/framework-context:packages/framework-context/dist/index.js": 1,
      },
    });
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("artifact(s) over baseline");
    expect(diagnostics[0].cause).toContain(
      "@croco/framework-context:packages/framework-context/dist/index.js",
    );
  });

  it("ignores package-quality skipped dist subtrees when comparing bundle baselines", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeFile(repo, "packages/framework-context/dist/index.js", "export const runtime = 'cjs';\n");
    writeFile(
      repo,
      "packages/framework-context/dist/node_modules/internal/index.js",
      "export const ignored = true;\n",
    );
    writeFile(
      repo,
      "packages/framework-context/dist/coverage/coverage-summary.json",
      '{"total":{}}\n',
    );
    writeFile(
      repo,
      "packages/framework-context/dist/dist/generated.js",
      "export const ignored = true;\n",
    );
    writeJson(repo, "ci-reports/bundle-size/baseline.json", {
      schemaVersion: 1,
      artifacts: {
        "@croco/framework-context:packages/framework-context/dist/index.js": 1024,
      },
    });
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("keeps dot-directory bundle artifacts aligned with package-quality baselines", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeFile(repo, "packages/framework-context/dist/.vite/manifest.json", "{}\n");
    writeJson(repo, "ci-reports/bundle-size/baseline.json", {
      schemaVersion: 1,
      artifacts: {
        "@croco/framework-context:packages/framework-context/dist/.vite/manifest.json": 64,
      },
    });
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("reports missing bundle artifacts when dist exists as a file", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeFile(repo, "packages/framework-context/dist", "not a directory\n");
    writeJson(repo, "ci-reports/bundle-size/baseline.json", {
      schemaVersion: 1,
      artifacts: {
        "@croco/framework-context:packages/framework-context/dist/index.js": 1024,
      },
    });
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("has no measured bundle artifact");
  });

  it("normalizes lowercase hashed bundle chunks before comparing baselines", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeFile(
      repo,
      "packages/framework-context/dist/chunk-abcdef12.js",
      "export const runtime = 'chunk';\n",
    );
    writeJson(repo, "ci-reports/bundle-size/baseline.json", {
      schemaVersion: 1,
      artifacts: {
        "@croco/framework-context:packages/framework-context/dist/chunk-*.js": 512,
      },
    });
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("reports advisory release-hardening readiness warnings without failing the doctor summary", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/problems-core exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writeWorkspacePackage(repo, "packages/problems-core", "@croco/problems-core");
    writeFile(repo, "packages/problems-core/src/index.ts", "export {};\n");
    writePackageCatalog(repo, ["framework-context"]);
    writePassingCoreCoverageEvidence(repo, "@croco/problems-core");
    writeJson(repo, "docs/problem-code-registry.json", {
      version: "croco.problem-code-registry.v1",
      problemCount: 0,
      problems: [],
    });
    writeFile(
      repo,
      "packages/docs/src/content/docs/en/reference/problem-recovery-cookbook.md",
      "# Problem recovery cookbook\n",
    );
    writeJson(repo, "scripts/static-misuse-raw-error-allowlist.json", {
      schemaVersion: 1,
      entries: [
        {
          package: "@croco/framework-context",
          file: "packages/framework-context/src/index.ts",
          line: 1,
          excerpt: "throw new Error('internal invariant');",
          reason: "Reviewed internal invariant while migrating static misuse diagnostics.",
        },
      ],
    });

    const report = runDoctor({ cwd: repo });
    const check = report.checks.find((candidate) => candidate.id === "advisory-gate-readiness");
    const codes = report.diagnostics.map((diagnostic) => diagnostic.code);

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(check).toMatchObject({ status: "fail" });
    expect(report.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
      "warning",
      "warning",
      "warning",
      "warning",
    ]);
    expect(codes).toEqual([
      CLI_DIAGNOSTIC_CODES.doctorCoreCoverageCandidateMissing,
      CLI_DIAGNOSTIC_CODES.doctorBundleSizeBaselineMissing,
      CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
      CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
    ]);
    expect(report.diagnostics[0].action).toContain("pnpm test:coverage:core");
    expect(report.diagnostics[1].action).toContain("pnpm package-quality:report");
    expect(report.diagnostics[2].action).toContain("pnpm bench:readiness");
    expect(report.diagnostics[3].action).toContain("owner or expiresOn");
  });

  it("rejects incomplete benchmark variance evidence as advisory readiness warning", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkResult(repo);
    writeFile(
      repo,
      "ci-reports/benchmark/latest-five-green-runs.md",
      [
        "# Benchmark variance evidence",
        "",
        "<!-- croco-benchmark-variance-evidence:v1 -->",
        "```json",
        JSON.stringify({
          version: 1,
          runs: [],
          checks: {},
          rows: [],
        }),
        "```",
        "",
      ].join("\n"),
    );
    writeJson(repo, "scripts/static-misuse-raw-error-allowlist.json", {
      schemaVersion: 1,
      entries: [],
    });

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("exactly 5 GitHub Actions runs");
  });

  it("rejects normalized benchmark variance timestamps as advisory readiness warning", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo, { reviewedAt: "2026-02-31T00:00:00Z" });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("reviewedAt must be an ISO timestamp");
  });

  it("accepts benchmark run attempt URLs as advisory evidence", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo, { runUrlSuffix: "/attempts/1" });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toEqual([]);
  });

  it("rejects unsafe benchmark run ids as advisory readiness warning", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo, {
      runIds: [Number.MAX_SAFE_INTEGER + 1, 2, 3, 4, 5],
    });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("positive safe integer id");
  });

  it("rejects benchmark variance evidence that drifts from current benchmark rows", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo, {
      resultReports: [
        { name: "Example benchmark", p75: 10, baseline: 10 },
        { name: "New benchmark", p75: 1, baseline: 1 },
      ],
    });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("row set must match benchmark-result.json");
  });

  it("rejects benchmark variance evidence names that only match after trimming", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo, {
      resultReports: [{ name: " Example benchmark ", p75: 10, baseline: 10 }],
    });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("row set must match benchmark-result.json");
  });

  it("rejects benchmark variance evidence with a stale committed baseline", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo, {
      resultReports: [{ name: "Example benchmark", p75: 10, baseline: 9 }],
    });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("committed baseline must match");
  });

  it("rejects benchmark readiness when current threshold entries are missing", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo, {
      resultReports: [{ name: "Example benchmark", p75: 10, baseline: 10, threshold: null }],
    });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("threshold entry missing");
  });

  it("rejects benchmark readiness when current p75 entries are missing", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo, {
      resultReports: [{ name: "Example benchmark", p75: null, baseline: 10, threshold: 20 }],
    });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("p75 entry missing");
  });

  it("rejects benchmark readiness when current result gate failures remain", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeJson(repo, "benchmark-result.json", {
      allPassed: false,
      gateFailures: ["Example benchmark: p75 30.0ms exceeds threshold 20.0ms"],
      reports: [
        {
          name: "Example benchmark",
          p75: 10,
          threshold: 20,
          baseline: 10,
          thresholdStatus: "pass",
          baselineStatus: "pass",
        },
      ],
    });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("benchmark-result.json gateFailures includes");
  });

  it("does not force promoted benchmark baseline failure evidence to zero", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo, {
      promotedBaselineFailures: 5,
      resultReports: [{ name: "Example benchmark", p75: 10, baseline: 1 }],
    });
    writeValidStaticMisuseAllowlist(repo);

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorBenchmarkVarianceEvidenceMissing,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain(
      "5 reviewed run(s) fail the promoted baseline tolerance",
    );
    expect(diagnostics[0].cause).not.toContain("checks.promotedBaselineFailures must be 0");
  });

  it("rejects non-positive security allowlist line numbers", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo, { line: 0 });

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("line must be a positive integer");
  });

  it("rejects stale security allowlist source references", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo, { excerpt: "throw new Error('stale');" });

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("excerpt does not match the current source line");
  });

  it("rejects non-string security allowlist expiresOn metadata", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo, { expiresOn: 123 });

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("expiresOn must use YYYY-MM-DD");
  });

  it("rejects expired security allowlist expiresOn metadata", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo, { expiresOn: "2000-01-01" });

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("expiresOn must not be in the past");
  });

  it("rejects whitespace-only security allowlist metadata strings", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo, { owner: "   ", reason: "   " });

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("missing reason");
    expect(diagnostics[0].cause).toContain("owner or expiresOn metadata is required");
  });

  it("rejects padded security allowlist exact source fields", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeValidStaticMisuseAllowlist(repo, {
      package: " @croco/framework-context ",
      file: "packages/framework-context/src/index.ts",
      excerpt: " throw new Error('internal invariant'); ",
    });

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("package must match @croco/framework-context");
    expect(diagnostics[0].cause).toContain("excerpt does not match the current source line");
  });

  it("checks empty-catch static misuse allowlist metadata", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "test:coverage:core":
          "CORE_COVERAGE=true pnpm --filter @croco/framework-context exec vitest run",
        "bench:readiness": "node scripts/benchmark-readiness-report.mts",
      },
    });
    writeWorkspacePackage(repo, "packages/framework-context", "@croco/framework-context", {
      scripts: { build: "tsup" },
    });
    writePackageCatalog(repo, ["framework-context"]);
    writeBundleSizeBaseline(repo);
    writeBenchmarkVarianceEvidence(repo);
    writeJson(repo, "scripts/static-misuse-empty-catch-allowlist.json", {
      schemaVersion: 1,
      entries: [
        {
          package: "@croco/framework-context",
          file: "packages/framework-context/src/index.ts",
          line: 1,
          excerpt: "throw new Error('stale');",
          reason: "Reviewed empty catch while migrating static misuse diagnostics.",
          owner: "framework-error-handling",
        },
      ],
    });

    const report = runDoctor({ cwd: repo });
    const diagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === CLI_DIAGNOSTIC_CODES.doctorSecurityAllowlistMetadataInvalid,
    );

    expect(report.summary).toBe("healthy");
    expect(getDoctorExitCode(report)).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].cause).toContain("scripts/static-misuse-empty-catch-allowlist.json");
    expect(diagnostics[0].cause).toContain("excerpt does not match the current source line");
  });

  it("reads schema-versioned Project manifest bundle artifacts", () => {
    const repo = createCrocoWorkspace();
    writePackage(repo, "api", "@croco/api");
    writeProjectManifestBundle(repo);

    const report = runDoctor({ cwd: repo });
    const bundleCheck = report.checks.find((check) => check.id === "project-manifest-bundle");

    expect(report.summary).toBe("healthy");
    expect(bundleCheck).toMatchObject({
      status: "pass",
      note: "6 schema-versioned manifest bundle artifact(s) are readable.",
    });
  });

  it("fails Project manifest bundle readiness when project-map scripts expect missing artifacts", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "project-map:check":
          "croco project map --check --manifest croco.project-map.json --manifest-bundle .croco/manifest",
      },
    });
    writePackage(repo, "api", "@croco/api");

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.projectMapManifestMissing,
        legacyCode: CLI_LEGACY_DIAGNOSTIC_CODES.projectMapManifestMissing,
        checkId: "project-manifest-bundle",
        location: expect.objectContaining({ file: ".croco/manifest" }),
      }),
    ]);
  });

  it("reports readiness failures with stable CROCO diagnostic codes", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "contract:snapshot": "croco contracts check --json --out contract-graph.snapshot.json",
        "problem-registry:check": "node scripts/problem-registry.mts --check",
        "runtime-policy:check":
          "croco runtime-policy check --manifest croco-runtime-policy.manifest.json",
      },
      devDependencies: {
        "@croco/cli": "file:../packs/croco-cli.tgz",
      },
    });
    writeWorkspacePackage(repo, "packages/api", "@smoke/api-server", {
      dependencies: {
        "@croco/transports-http": "file:../packs/croco-transports-http.tgz",
      },
    });
    writeFile(
      repo,
      "packages/api/src/app.ts",
      [
        'import { createApp, securityHeadersMiddleware } from "@croco/transports-http";',
        "export function createApiApp() {",
        "  return createApp({",
        "    controllers: [],",
        "    securityValidation: 'off',",
        "    middlewares: [securityHeadersMiddleware()],",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(repo, ".croco/build/di-graph.manifest.json", {
      version: "croco.di-graph.manifest.v1",
      status: "failed",
      diagnostics: [
        {
          code: "CROCO_DI_001",
          legacyCode: "framework-context/di-missing-provider",
          severity: "error",
          message: "Provider ApiController is not registered",
        },
      ],
    });

    const report = runDoctor({ cwd: repo });
    const codes = report.diagnostics.map((diagnostic) => diagnostic.code);

    expect(report.summary).toBe("issues_detected");
    expect(codes).toEqual(
      expect.arrayContaining([
        "CROCO_DOCTOR_SPINE_PACKAGE_NOT_INSTALLED",
        "CROCO_DOCTOR_CONTRACT_GRAPH_MISSING",
        "CROCO_DOCTOR_PROBLEM_REGISTRY_MISSING",
        "CROCO_DOCTOR_RUNTIME_CAPABILITY_MANIFEST_MISSING",
        "CROCO_DOCTOR_HTTP_SECURITY_VALIDATION_DISABLED",
        "CROCO_DOCTOR_HTTP_SECURITY_MIDDLEWARE_MISSING",
        "CROCO_DOCTOR_DI_BOOTSTRAP_ERRORS",
      ]),
    );
    expect(codes.every((code) => code.startsWith("CROCO_"))).toBe(true);
    expect(getDoctorExitCode(report)).toBe(1);
  });

  it("flags root package dependencies that drift from local workspace package versions", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      devDependencies: {
        "@croco/cli": "^0.0.1",
      },
    });
    writePackage(repo, "cli", "@croco/cli", { version: "0.0.3" });

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "CROCO_DOCTOR_WORKSPACE_VERSION_CONFLICT",
        location: expect.objectContaining({
          file: "package.json",
          packageName: "croco-doctor-test",
        }),
      }),
    ]);
  });

  it("does not count HTTP security middleware tokens outside createApp middlewares", () => {
    const repo = createCrocoWorkspace();
    writeWorkspacePackage(repo, "packages/api", "@smoke/api-server", {
      dependencies: {
        "@croco/transports-http": "file:../packs/croco-transports-http.tgz",
      },
    });
    writeNodeModulePackage(repo, "@croco/transports-http", "packages/api");
    writeFile(
      repo,
      "packages/api/src/app.ts",
      [
        'import { bodyLimitMiddleware, corsMiddleware, createApp, rateLimitHttpMiddleware, securityHeadersMiddleware } from "@croco/transports-http";',
        "function unusedSecuritySetup() {",
        "  securityHeadersMiddleware();",
        "  corsMiddleware({ origins: ['http://localhost:5173'] });",
        "  bodyLimitMiddleware({ limit: 1024 });",
        "  rateLimitHttpMiddleware({ rateLimiter: {} as never, policy: {} as never });",
        "}",
        "export function createApiApp() {",
        "  return createApp({",
        "    controllers: [],",
        "    middlewares: [",
        "      'securityHeadersMiddleware()',",
        "      'corsMiddleware()',",
        "      'bodyLimitMiddleware()',",
        "      'rateLimitHttpMiddleware()',",
        "    ],",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "CROCO_DOCTOR_HTTP_SECURITY_MIDDLEWARE_MISSING",
        location: expect.objectContaining({
          file: "packages/api/src/app.ts",
          packageName: "@smoke/api-server",
        }),
      }),
    ]);
  });

  it("accepts HTTP security middleware through a local helper referenced by createApp", () => {
    const repo = createCrocoWorkspace();
    writeWorkspacePackage(repo, "packages/api", "@smoke/api-server", {
      dependencies: {
        "@croco/transports-http": "file:../packs/croco-transports-http.tgz",
      },
    });
    writeNodeModulePackage(repo, "@croco/transports-http", "packages/api");
    writeFile(
      repo,
      "packages/api/src/app.ts",
      [
        'import { bodyLimitMiddleware, corsMiddleware, createApp, rateLimitHttpMiddleware, securityHeadersMiddleware } from "@croco/transports-http";',
        "export function createApiApp() {",
        "  return createApp({",
        "    controllers: [],",
        "    middlewares: [",
        "      securityHeadersMiddleware(),",
        "      corsMiddleware({ origins: ['http://localhost:5173'] }),",
        "      bodyLimitMiddleware({ limit: 1024 }),",
        "      createApiRateLimitMiddleware(),",
        "    ],",
        "  });",
        "}",
        "function createApiRateLimitMiddleware() {",
        "  return rateLimitHttpMiddleware({ rateLimiter: {} as never, policy: {} as never });",
        "}",
        "",
      ].join("\n"),
    );

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("healthy");
    expect(report.diagnostics).toEqual([]);
  });

  it("fails ProblemRegistry readiness when the declared drift gate fails", () => {
    const repo = createCrocoWorkspace();
    writeRootPackage(repo, {
      scripts: {
        "problem-registry:check": "node -e \"console.error('registry drift'); process.exit(1)\"",
      },
    });
    writePackage(repo, "api", "@croco/api");
    writeJson(repo, "docs/problem-code-registry.json", {
      version: "croco.problem-code-registry.v1",
      problemCount: 0,
      problems: [],
    });
    writeFile(
      repo,
      "packages/docs/src/content/docs/en/reference/problem-recovery-cookbook.md",
      "# Problem recovery cookbook\n",
    );

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "CROCO_DOCTOR_PROBLEM_REGISTRY_DRIFT",
        cause: expect.stringContaining("registry drift"),
        location: expect.objectContaining({ file: "docs/problem-code-registry.json" }),
      }),
    ]);
  });

  it("validates nested package export build targets including require outputs", () => {
    const repo = createCrocoWorkspace();
    writeWorkspacePackage(repo, "packages/api", "@smoke/api-server", {
      dependencies: {
        "@croco/problems-core": "file:../packs/croco-problems-core.tgz",
      },
    });
    writeNodeModulePackage(repo, "@croco/problems-core", "packages/api", {
      publishConfig: {
        exports: {
          ".": {
            import: "./dist/index.mjs",
            require: "./dist/index.cjs",
            types: "./dist/index.d.ts",
          },
        },
      },
    });
    writeFile(
      repo,
      "packages/api/node_modules/@croco/problems-core/dist/index.mjs",
      "export {};\n",
    );

    const report = runDoctor({ cwd: repo });

    expect(report.summary).toBe("issues_detected");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "CROCO_DOCTOR_SPINE_PACKAGE_NOT_BUILT",
        location: expect.objectContaining({
          file: "packages/api/node_modules/@croco/problems-core/dist/index.cjs",
          packageName: "@croco/problems-core",
        }),
      }),
    ]);
  });

  it("registers the doctor command metadata", () => {
    expect(Object.keys(doctor.args ?? {})).toEqual(["cwd", "dryRun", "overwrite", "path", "json"]);
  });

  it("renders top-level CLI help without loading implementation-heavy subcommands", async () => {
    const usage = await renderUsage(createCrocoCommand());

    expect(usage).toContain("Croco framework CLI");
    expect(usage).toContain("`contracts`");
    expect(usage).toContain("`doctor`");
    expect(usage).toContain("`runtime-policy`");
  });
});

function createTempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "croco-doctor-"));
  tempRepos.push(repo);
  return repo;
}

function createCrocoWorkspace(): string {
  const repo = createTempRepo();
  writeFile(repo, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  writeRootPackage(repo);
  return repo;
}

function createWorkerGoalWorkspace(
  options: {
    readonly includeBuildScript?: boolean;
    readonly includeMetaVite?: boolean;
    readonly manifest?: Record<string, unknown>;
  } = {},
): string {
  const repo = createCrocoWorkspace();
  writeRootPackage(repo, {
    scripts: {
      typecheck: "turbo typecheck",
      ...(options.includeBuildScript === false ? {} : { build: "turbo build" }),
    },
  });
  writeWorkspacePackage(repo, "packages/api-worker", "@test/api-worker", {
    dependencies: {
      "@croco/transports-cloudflare-workers": "workspace:*",
    },
  });
  writeWorkspacePackage(repo, "packages/ssr-worker", "@test/ssr-worker", {
    scripts: {
      "presentation:smoke": "tsx src/smoke/presentationSmoke.ts",
    },
    dependencies: options.includeMetaVite === false ? {} : { "@croco/meta-vite": "workspace:*" },
  });
  writeJson(repo, "croco.app.json", {
    schemaVersion: 1,
    projectName: "worker-app",
    scope: "@test",
    goal: "worker",
    preset: "ddd-vike-fullstack",
    runtimeTarget: "cloudflare-workers",
    protocol: "rest",
    providers: ["cloudflare-workers", "meta-vite"],
    storage: [],
    auth: "none",
    billing: "none",
    telemetry: "none",
    deploymentPreset: "cloudflare-workers",
    qualityGates: ["install", "typecheck", "build", "ssr-worker:presentation:smoke"],
    ...options.manifest,
  });
  return repo;
}

function createSpaBackendSplitGoalWorkspace(
  options: { readonly includeEventsInmemory?: boolean } = {},
): string {
  const repo = createCrocoWorkspace();
  writeRootPackage(repo, {
    scripts: {
      "dev:smoke": "tsx scripts/dev-smoke.ts",
      lint: "oxlint .",
      test: "vitest run",
      typecheck: "turbo typecheck",
      build: "turbo build",
      "contract:verify": "tsx scripts/contract-verify.ts",
    },
  });
  writeWorkspacePackage(repo, "packages/api", "@test/api", {
    dependencies: {
      "@croco/transports-http": "workspace:*",
      "@croco/repository-core": "workspace:*",
      ...(options.includeEventsInmemory === false
        ? {}
        : { "@croco/events-inmemory": "workspace:*" }),
      "@test/provider-rpc": "workspace:*",
    },
  });
  writeJson(repo, "croco.app.json", {
    schemaVersion: 1,
    projectName: "spa-app",
    scope: "@test",
    goal: "spa-backend-split",
    preset: "production-app",
    runtimeTarget: "node",
    protocol: "rest-rpc-client",
    providers: ["in-memory-repository", "in-memory-events", "generated-rpc-client"],
    storage: ["in-memory-demo"],
    auth: "none",
    billing: "none",
    telemetry: "opentelemetry-otlp",
    deploymentPreset: "lambda-spa",
    qualityGates: ["install", "dev:smoke", "lint", "test", "typecheck", "build", "contract:verify"],
  });
  return repo;
}

function writeRootPackage(repo: string, manifest: Record<string, unknown> = {}): void {
  writeJson(repo, "package.json", {
    name: "croco-doctor-test",
    private: true,
    packageManager: "pnpm@11.9.0",
    ...manifest,
  });

  const scripts = manifest.scripts;
  const scriptsRecord =
    scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>) : null;
  const coreCoverageScript = scriptsRecord?.["test:coverage:core"];
  if (typeof coreCoverageScript === "string") {
    writeCoreCoverageConfig(repo, parseCoreCoverageScriptFilters(coreCoverageScript));
    writeCoreCoverageWarningCheckScript(repo);
  }
}

function parseCoreCoverageScriptFilters(script: string): string[] {
  return [...script.matchAll(/--filter\s+(@croco\/[^\s]+)/g)].map(([, packageName]) => packageName);
}

function writePackage(
  repo: string,
  dirName: string,
  packageName: string,
  manifest: Record<string, unknown> = {},
): void {
  writeWorkspacePackage(repo, `packages/${dirName}`, packageName, manifest);
}

function writeWorkspacePackage(
  repo: string,
  relativeDir: string,
  packageName: string,
  manifest: Record<string, unknown> = {},
): void {
  writeJson(repo, `${relativeDir}/package.json`, { name: packageName, ...manifest });
  writeFile(repo, `${relativeDir}/src/index.ts`, "throw new Error('internal invariant');\n");
}

function writeNodeModulePackage(
  repo: string,
  packageName: string,
  importerDir = ".",
  manifest: Record<string, unknown> = {},
): void {
  const packagePath = `${importerDir}/node_modules/${packageName}/package.json`;
  writeJson(repo, packagePath, {
    name: packageName,
    version: "0.0.0-smoke",
    publishConfig: {
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
    },
    ...manifest,
  });
  writeFile(repo, `${importerDir}/node_modules/${packageName}/dist/index.js`, "export {};\n");
  writeFile(repo, `${importerDir}/node_modules/${packageName}/dist/index.d.ts`, "export {};\n");
}

function writeProjectManifestBundle(repo: string): void {
  for (const artifact of [
    { path: "contract-graph.json", schemaVersion: "croco.manifest.contract-graph.v1" },
    { path: "problems.json", schemaVersion: "croco.manifest.problems.v1" },
    { path: "di-graph.json", schemaVersion: "croco.manifest.di-graph.v1" },
    { path: "runtime.json", schemaVersion: "croco.manifest.runtime.v1" },
    { path: "policies.json", schemaVersion: "croco.manifest.policies.v1" },
    { path: "providers.json", schemaVersion: "croco.manifest.providers.v1" },
  ]) {
    writeJson(repo, `.croco/manifest/${artifact.path}`, {
      schemaVersion: artifact.schemaVersion,
      source: {
        schemaVersion: "croco.project-map.manifest.v1",
        artifact: "croco.project-map.json",
      },
    });
  }
}

function writePackageCatalog(
  repo: string,
  packages: readonly string[],
  options: { readonly spine?: readonly string[] } = {},
): void {
  writeJson(repo, "docs/package-catalog.json", {
    schemaVersion: 1,
    spine: { packages: options.spine ?? packages },
    groups: {
      Core: { packages },
    },
    maturity: {
      production: { packages },
    },
  });
}

function writeCoreCoverageConfig(repo: string, packages: readonly string[]): void {
  writeFile(
    repo,
    "scripts/core-coverage-config.mts",
    [
      "export const CORE_COVERAGE_PACKAGES = [",
      ...packages.map((packageName) => `  "${packageName}",`),
      "];",
      "",
    ].join("\n"),
  );
  writeFile(
    repo,
    "vitest.config.ts",
    [
      "export const CORE_COVERAGE_THRESHOLDS = {",
      "  lines: 80,",
      "  branches: 80,",
      "  functions: 80,",
      "  statements: 80,",
      "};",
      "",
    ].join("\n"),
  );
}

function writeCoreCoverageTemporaryExclusion(
  repo: string,
  packageName: string,
  reason: string,
): void {
  writeFile(
    repo,
    "scripts/core-coverage-warning-check.mts",
    [
      "const TEMPORARY_CORE_COVERAGE_SELECTION_EXCLUSIONS: Record<string, string> = {",
      `  "${packageName}": "${reason}",`,
      "};",
      "",
    ].join("\n"),
  );
}

function writeCoreCoverageWarningCheckScript(repo: string): void {
  writeFile(
    repo,
    "scripts/core-coverage-warning-check.mts",
    [
      "const TEMPORARY_CORE_COVERAGE_SELECTION_EXCLUSIONS: Record<string, string> = {};",
      "const INTENTIONAL_ZERO_BASELINE_REASONS: Record<string, string> = {};",
      "",
    ].join("\n"),
  );
}

function writeCoreCoverageIntentionalZeroBaselineReason(
  repo: string,
  packageName: string,
  reason: string,
): void {
  writeFile(
    repo,
    "scripts/core-coverage-warning-check.mts",
    [
      "const INTENTIONAL_ZERO_BASELINE_REASONS: Record<string, string> = {",
      `  "${packageName}": "${reason}",`,
      "};",
      "",
    ].join("\n"),
  );
}

function writePassingCoreCoverageEvidence(
  repo: string,
  packageName = "@croco/framework-context",
): void {
  if (packageName === "@croco/problems-core") {
    writeWorkspacePackage(repo, "packages/problems-core", "@croco/problems-core");
    writeFile(repo, "packages/problems-core/src/index.ts", "export {};\n");
    writeJson(repo, "docs/problem-code-registry.json", {
      version: "croco.problem-code-registry.v1",
      problemCount: 0,
      problems: [],
    });
    writeFile(
      repo,
      "packages/docs/src/content/docs/en/reference/problem-recovery-cookbook.md",
      "# Problem recovery cookbook\n",
    );
  }

  writeCoreCoverageSummary(repo, packageName);
  writeFile(
    repo,
    "ci-reports/coverage/core-baseline.txt",
    [
      "| Package | Statements | Branches | Functions | Lines |",
      "|---------|-----------:|---------:|----------:|------:|",
      `| \`${packageName}\` | 80 | 80 | 80 | 80 |`,
      "",
    ].join("\n"),
  );
}

function writeBundleSizeBaseline(repo: string): void {
  writeFile(repo, "packages/framework-context/dist/index.js", "export const runtime = 'cjs';\n");
  writeFile(repo, "packages/framework-context/dist/index.mjs", "export const runtime = 'esm';\n");
  writeJson(repo, "ci-reports/bundle-size/baseline.json", {
    schemaVersion: 1,
    artifacts: {
      "@croco/framework-context:packages/framework-context/dist/index.js": 1024,
      "@croco/framework-context:packages/framework-context/dist/index.mjs": {
        bytes: 768,
      },
    },
  });
}

function writeCoreCoverageSummary(repo: string, packageName: string): void {
  const packageSlug = packageName.replace(/^@croco\//, "");
  writeJson(repo, `packages/${packageSlug}/coverage/coverage-summary.json`, {
    total: {
      statements: { pct: 80 },
      branches: { pct: 80 },
      functions: { pct: 80 },
      lines: { pct: 80 },
    },
  });
}

type BenchmarkVarianceEvidenceOptions = {
  readonly prePromotionBaselineFailuresPerRun?: number;
  readonly promotedBaselineFailures?: number;
  readonly reviewedAt?: string;
  readonly runIds?: readonly number[];
  readonly runUrlSuffix?: string;
  readonly resultReports?: readonly BenchmarkResultReport[];
};

type BenchmarkResultReport = {
  readonly name: string;
  readonly p75?: number | null;
  readonly baseline: number;
  readonly threshold?: number | null;
};

function writeBenchmarkVarianceEvidence(
  repo: string,
  options: BenchmarkVarianceEvidenceOptions = {},
): void {
  const runIds = options.runIds ?? [1, 2, 3, 4, 5];
  const prePromotionBaselineFailuresPerRun = options.prePromotionBaselineFailuresPerRun ?? 0;
  const gateFailures = Array.from(
    { length: prePromotionBaselineFailuresPerRun },
    (_, index) =>
      `Example benchmark ${index + 1}: p75 10.0ms exceeds baseline 1.0ms by more than 20%`,
  );
  const p75Values = [10, 10.2, 9.9, 10.1, 10];
  const p75ByRun = Object.fromEntries(
    runIds.map((runId, index) => [String(runId), p75Values[index] ?? 10]),
  );
  const resultReports = options.resultReports ?? [
    { name: "Example benchmark", p75: 10, baseline: 10 },
  ];

  writeBenchmarkResult(repo, resultReports);

  writeFile(
    repo,
    "ci-reports/benchmark/latest-five-green-runs.md",
    [
      "# Benchmark variance evidence",
      "",
      "<!-- croco-benchmark-variance-evidence:v1 -->",
      "```json",
      JSON.stringify({
        version: 1,
        source: "github-actions",
        reviewedAt: options.reviewedAt ?? "2026-07-01T00:00:00Z",
        tolerance: 0.15,
        selection: {
          workflowName: "Performance Benchmark",
          qualifyingBaseBranch: "trunk",
          qualifyingWorkflowStatus: "completed",
          qualifyingWorkflowConclusion: "success",
          orderedBy: "createdAt-desc",
          latestGreenTrunkRunIds: runIds,
        },
        runs: runIds.map((runId, index) => ({
          id: runId,
          url: `https://github.com/croco-dev/framework/actions/runs/${runId}${options.runUrlSuffix ?? ""}`,
          headSha: `${String.fromCharCode(97 + index).repeat(40)}`,
          headBranch: "trunk",
          baseBranch: "trunk",
          createdAt: `2026-06-30T0${runIds.length - index}:00:00Z`,
          workflowStatus: "completed",
          workflowConclusion: "success",
          artifact: {
            allPassed: gateFailures.length === 0,
            reportCount: 1,
            gateFailures,
          },
        })),
        checks: {
          sameRowSet: true,
          runnerFailures: 0,
          moduleFailures: 0,
          emptyReports: 0,
          missingReports: 0,
          thresholdFailures: 0,
          thresholdSkips: 0,
          baselineSkips: 0,
          prePromotionBaselineFailures: prePromotionBaselineFailuresPerRun * runIds.length,
          promotedBaselineFailures: options.promotedBaselineFailures ?? 0,
        },
        rows: [
          {
            name: "Example benchmark",
            min: 9.9,
            median: 10,
            max: 10.2,
            spread: 0.03,
            status: "pass",
            p75ByRun,
          },
        ],
      }),
      "```",
      "",
    ].join("\n"),
  );
}

function writeBenchmarkResult(
  repo: string,
  reports: readonly BenchmarkResultReport[] = [
    { name: "Example benchmark", p75: 10, baseline: 10 },
  ],
): void {
  writeJson(repo, "benchmark-result.json", {
    allPassed: true,
    gateFailures: [],
    reports: reports.map((report) => ({
      name: report.name,
      ...(report.p75 === null || report.p75 === undefined ? {} : { p75: report.p75 }),
      ...(report.threshold === null
        ? {}
        : {
            threshold: report.threshold ?? (typeof report.p75 === "number" ? report.p75 * 2 : 20),
          }),
      baseline: report.baseline,
      thresholdStatus: "pass",
      baselineStatus: "pass",
    })),
  });
}

function writeValidStaticMisuseAllowlist(
  repo: string,
  entry: Partial<{
    package: string;
    file: string;
    line: number;
    excerpt: string;
    reason: string;
    owner: string;
    expiresOn: unknown;
  }> = {},
  allowlistPath = "scripts/static-misuse-raw-error-allowlist.json",
): void {
  writeJson(repo, allowlistPath, {
    schemaVersion: 1,
    entries: [
      {
        package: "@croco/framework-context",
        file: "packages/framework-context/src/index.ts",
        line: 1,
        excerpt: "throw new Error('internal invariant');",
        reason: "Reviewed internal invariant while migrating static misuse diagnostics.",
        owner: "framework-error-handling",
        ...entry,
      },
    ],
  });
}

function writeHealthySaasProviderDoctorWorkspace(repo: string): void {
  writeRootPackage(repo, {
    scripts: {
      "contract:snapshot": "croco contracts check --json --out contract-graph.snapshot.json",
      "runtime-policy:check":
        "croco runtime-policy check --manifest croco-runtime-policy.manifest.json",
    },
    devDependencies: {
      "@croco/cli": "file:../packs/croco-cli.tgz",
    },
  });
  writeWorkspacePackage(repo, "packages/api", "@smoke/api-server", {
    dependencies: {
      "@croco/auth-better-auth": "file:../packs/croco-auth-better-auth.tgz",
      "@croco/problems-core": "file:../packs/croco-problems-core.tgz",
      "@croco/transports-http": "file:../packs/croco-transports-http.tgz",
    },
  });
  writeFile(
    repo,
    "packages/api/src/app.ts",
    [
      'import { bodyLimitMiddleware, corsMiddleware, createApp, rateLimitHttpMiddleware, securityHeadersMiddleware } from "@croco/transports-http";',
      "export function createApiApp() {",
      "  return createApp({",
      "    controllers: [],",
      "    middlewares: [",
      "      securityHeadersMiddleware(),",
      "      corsMiddleware({ origins: ['http://localhost:5173'] }),",
      "      bodyLimitMiddleware({ limit: 1024 }),",
      "      rateLimitHttpMiddleware({ rateLimiter: {} as never, policy: {} as never }),",
      "    ],",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  writeNodeModulePackage(repo, "@croco/cli");
  for (const packageName of [
    "@croco/auth-better-auth",
    "@croco/problems-core",
    "@croco/transports-http",
  ]) {
    writeNodeModulePackage(repo, packageName, "packages/api");
  }
  writeJson(repo, "contract-graph.snapshot.json", {
    snapshotVersion: "croco.contract-graph.snapshot.v1",
    graphVersion: "croco.contract-graph.v1",
    controllerCount: 0,
    routeCount: 0,
    operationIds: [],
    controllers: [],
    routes: [],
    diagnostics: [],
  });
  writeJson(repo, "croco-runtime-policy.manifest.json", {
    schemaVersion: "croco.runtime-policy/v1",
    runtime: { platform: "node" },
    table: { plans: [] },
  });
  writeProviderProfileManifest(repo);
}

function writeProviderProfileManifest(repo: string, manifest: Record<string, unknown> = {}): void {
  writeJson(repo, "croco-saas-profile.manifest.json", {
    schemaVersion: "croco.saas-provider-profile/v1",
    profile: {
      name: "saas-node-postgres",
      displayName: "Node/Postgres SaaS",
      runtimeTarget: "node",
    },
    packages: ["@croco/auth-better-auth"],
    capabilities: [
      "runtime",
      "auth",
      "billing",
      "metering",
      "storage",
      "tasks",
      "telemetry",
      "webhookVerification",
    ].map((capability) => ({
      capability,
      provider: "zero-credential",
      status: "configured",
      env: [],
      notes: "covered by generated smoke",
    })),
    ...manifest,
  });
}

function writeRuntimeCapabilityManifest(
  repo: string,
  platform: string,
  compositionHostPlatform?: string,
): void {
  writeJson(repo, "croco-runtime-capability.manifest.json", {
    version: "croco.runtime-capability.manifest.v1",
    platform,
    ...(compositionHostPlatform
      ? {
          composition: {
            host: {
              platform: compositionHostPlatform,
              lifecycle: compositionHostPlatform === "lambda" ? "invocation" : "process",
            },
            transports: [{ protocol: "http" }],
            buildTarget: { name: "test", format: "esm" },
          },
        }
      : {}),
    capabilities: {},
    diagnostics: [],
  });
}

function writeTenantModelManifest(repo: string, manifest: Record<string, unknown> = {}): void {
  writeJson(repo, "croco-tenant-model.manifest.json", {
    schemaVersion: "croco.tenant-model/v1",
    currentModel: "org",
    defaultModel: "org",
    selected: {
      name: "org",
    },
    models: [],
    schema: {},
    migration: {},
    ...manifest,
  });
}

function writeJson(repo: string, relativePath: string, value: unknown): void {
  writeFile(repo, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeDoctorReportForSnapshot(report: DoctorReport, rootDir: string): DoctorReport {
  return {
    ...report,
    rootDir: normalizeRootDirForSnapshot(report.rootDir, rootDir),
    checks: report.checks.map((check) => ({
      ...check,
      diagnostics: check.diagnostics.map((diagnostic) =>
        normalizeDiagnosticForSnapshot(diagnostic, rootDir),
      ),
    })),
    diagnostics: report.diagnostics.map((diagnostic) =>
      normalizeDiagnosticForSnapshot(diagnostic, rootDir),
    ),
  };
}

function normalizeRootDirForSnapshot(
  actualRootDir: string | null,
  expectedRootDir: string,
): string | null {
  if (actualRootDir === null) {
    return null;
  }

  if (actualRootDir !== expectedRootDir) {
    throw new Error(`Expected doctor rootDir ${expectedRootDir}, received ${actualRootDir}`);
  }

  return "<workspace-root>";
}

function normalizeDiagnosticForSnapshot(
  diagnostic: DoctorDiagnostic,
  rootDir: string,
): DoctorDiagnostic {
  return {
    ...diagnostic,
    location: normalizeLocationForSnapshot(diagnostic.location, rootDir),
  };
}

function normalizeLocationForSnapshot(
  location: DoctorLocation | null,
  rootDir: string,
): DoctorLocation | null {
  if (!location?.file) {
    return location;
  }

  if (location.file === rootDir) {
    return { ...location, file: "<cwd>" };
  }

  if (location.file.startsWith(`${rootDir}/`)) {
    return {
      ...location,
      file: `<workspace-root>/${relative(rootDir, location.file).split("\\").join("/")}`,
    };
  }

  return location;
}

function writeFile(repo: string, relativePath: string, content: string): void {
  const filePath = join(repo, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}
