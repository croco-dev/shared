import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildBundleSizeMarkdown,
  buildReportMarkdown,
  createPackageQualityReport,
  parseWorkspacePackagePatterns,
  scanDependencyBoundaries,
  writePackageQualityReport,
} from "../package-quality-report.mts";

const tempRepos: string[] = [];

describe("package-quality-report.mts", () => {
  afterEach(() => {
    for (const repo of tempRepos.splice(0)) {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("renders package task status from Turbo run summaries", () => {
    const repo = createTempRepo();
    writePackage(repo, "alpha", "@croco/alpha", {
      build: "tsup",
      test: "vitest run",
      typecheck: "tsc --noEmit",
    });
    writePackage(repo, "beta", "@croco/beta", {
      build: "tsup",
    });
    writeTurboSummary(repo, "build.json", "turbo run build --summarize", 100, [
      task("@croco/alpha", "build", 0, "packages/alpha/.turbo/turbo-build.log"),
      task("@croco/beta", "build", 1, "packages/beta/.turbo/turbo-build.log"),
    ]);
    writeTurboSummary(repo, "typecheck.json", "turbo run typecheck --summarize", 200, [
      task("@croco/alpha", "typecheck", 0, "packages/alpha/.turbo/turbo-typecheck.log"),
    ]);

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
    });
    const markdown = buildReportMarkdown(report);

    expect(markdown).toContain(
      "| `@croco/beta` | fail; log: `packages/beta/.turbo/turbo-build.log`",
    );
    expect(markdown).toContain("| `@croco/alpha` | pass");
    expect(markdown).toContain("not-collected");
    expect(markdown).toContain("not-configured");
    expect(markdown).toContain(
      "- `@croco/beta` build failed; log: `packages/beta/.turbo/turbo-build.log`",
    );
  });

  it.each([
    { exitCode: 0, status: "pass" },
    { exitCode: 1, status: "fail" },
  ])("reports newer test:evidence $status without losing task identity", ({ exitCode, status }) => {
    const repo = createTempRepo();
    writePackage(repo, "alpha", "@croco/alpha", { test: "vitest run" });
    writeTurboSummary(repo, "old-test.json", "turbo run test --summarize", 100, [
      task("@croco/alpha", "test", 1 - exitCode, "packages/alpha/.turbo/turbo-test.log"),
    ]);
    writeTurboSummary(repo, "evidence.json", "turbo run test:evidence --summarize", 200, [
      task(
        "@croco/alpha",
        "test:evidence",
        exitCode,
        "packages/alpha/.turbo/turbo-test:evidence.log",
      ),
    ]);

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
    });

    expect(
      report.rows.find(({ packageName }) => packageName === "@croco/alpha")?.tasks.test,
    ).toEqual({
      task: "test",
      status,
      taskId: "@croco/alpha#test:evidence",
      logFile: "packages/alpha/.turbo/turbo-test:evidence.log",
      cacheStatus: exitCode === 0 ? "HIT" : "MISS",
    });
  });

  it.each(["test", "test:evidence"])(
    "binds %s summary to its authoritative check interval",
    (taskName) => {
      const repo = createTempRepo();
      writePackage(repo, "alpha", "@croco/alpha", { test: "vitest run" });
      const now = Date.now();
      writeTurboSummary(repo, "authoritative.json", `turbo run ${taskName} --summarize`, now, [
        task("@croco/alpha", taskName, 0, `packages/alpha/.turbo/turbo-${taskName}.log`),
      ]);
      writeTurboSummary(repo, "later-nested.json", "turbo run test --summarize", now + 10_000, [
        task("@croco/alpha", "test", 1, "packages/alpha/.turbo/turbo-test.log"),
      ]);

      const report = createPackageQualityReport({
        rootDir: repo,
        summaryDir: join(repo, ".turbo", "runs"),
        summaryWindows: {
          test: {
            startedAt: new Date(now - 1_000).toISOString(),
            completedAt: new Date(now + 1_000).toISOString(),
          },
        },
      });

      expect(
        report.rows.find(({ packageName }) => packageName === "@croco/alpha")?.tasks.test,
      ).toMatchObject({
        status: "pass",
      });
    },
  );

  it("rejects invalid authoritative summary timestamps", () => {
    const repo = createTempRepo();
    writePackage(repo, "alpha", "@croco/alpha", { test: "vitest run" });
    writeTurboSummary(repo, "test.json", "turbo run test --summarize", Date.now(), [
      task("@croco/alpha", "test", 0, "packages/alpha/.turbo/turbo-test.log"),
    ]);

    expect(() =>
      createPackageQualityReport({
        rootDir: repo,
        summaryDir: join(repo, ".turbo", "runs"),
        summaryWindows: {
          test: { startedAt: "invalid", completedAt: new Date().toISOString() },
        },
      }),
    ).toThrow("summaryWindows.test must contain parseable timestamps");
  });

  it("renders from normalized task, bundle, public API, and gate facts without Turbo or dist", () => {
    const repo = createTempRepo();
    writePackage(repo, "alpha", "@croco/alpha", {
      build: "tsup",
      test: "vitest run",
      typecheck: "tsc --noEmit",
    });
    writeTurboSummary(repo, "build.json", "turbo run build --summarize", 100, [
      task("@croco/alpha", "build", 0, "packages/alpha/.turbo/turbo-build.log"),
    ]);
    const source = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
    });
    rmSync(join(repo, ".turbo"), { force: true, recursive: true });
    rmSync(join(repo, "packages", "alpha", "dist"), { force: true, recursive: true });

    const normalized = createPackageQualityReport({
      rootDir: repo,
      summaryDir: "normalized-synthesis-input",
      packageRows: source.rows,
      bundleSize: source.bundleSize,
      publicApi: source.publicApi,
      gateOutcomes: source.gateOutcomes,
    });

    expect(normalized.rows).toEqual(source.rows);
    expect(normalized.bundleSize).toEqual(source.bundleSize);
    expect(normalized.publicApi).toEqual(source.publicApi);
    expect(normalized.gateOutcomes).toEqual(source.gateOutcomes);
  });

  it("includes example workspace package failures", () => {
    const repo = createTempRepo();
    writeFile(
      repo,
      "pnpm-workspace.yaml",
      "packages:\n  - packages/**/*\n  - examples/*\n\nonlyBuiltDependencies:\n  - esbuild\n",
    );
    writeWorkspacePackage(repo, "examples/demo", "@croco-example/demo", {
      build: "tsc --noEmit",
    });
    writeTurboSummary(repo, "build.json", "turbo run build --summarize", 100, [
      task(
        "@croco-example/demo",
        "build",
        1,
        "examples/demo/.turbo/turbo-build.log",
        "examples/demo",
      ),
    ]);

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
    });
    const markdown = buildReportMarkdown(report);

    expect(markdown).toContain(
      "| `@croco-example/demo` | fail; log: `examples/demo/.turbo/turbo-build.log`",
    );
    expect(markdown).toContain(
      "- `@croco-example/demo` build failed; log: `examples/demo/.turbo/turbo-build.log`",
    );
  });

  it("writes markdown and JSON dashboard artifacts", () => {
    const repo = createTempRepo();
    writePackage(repo, "alpha", "@croco/alpha", {
      build: "tsup",
    });
    writeFile(
      repo,
      "ci-reports/package-quality/public-api-summary.json",
      `${JSON.stringify(
        {
          status: "fail",
          packageCount: 1,
          changedPackages: 1,
          changedEntrypoints: 2,
          entrypointsAdded: 1,
          entrypointsRemoved: 0,
          targetChanges: 1,
          runtimeAdded: 1,
          runtimeRemoved: 0,
          typeAdded: 0,
          typeRemoved: 1,
          snapshotPath: "public-api-surface.snapshot.json",
          reportPath: "ci-reports/package-quality/public-api-diff.md",
          updateCommand: "pnpm public-api:write",
        },
        null,
        2,
      )}\n`,
    );

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
    });
    const markdownPath = writePackageQualityReport(
      report,
      join(repo, "ci-reports", "package-quality"),
    );
    const markdown = readFileSync(markdownPath, "utf-8");
    const summaryJson = readFileSync(
      join(repo, "ci-reports", "package-quality", "summary.json"),
      "utf-8",
    );
    const bundleSizeMarkdown = readFileSync(
      join(repo, "ci-reports", "package-quality", "bundle-size.md"),
      "utf-8",
    );

    expect(markdown).toContain("# Package Quality Dashboard");
    expect(markdown).toContain("`strict-contract-typecheck`");
    expect(markdown).toContain("`static-misuse:check`");
    expect(markdown).toContain("| `public-api:check` | package public export surface drift");
    expect(markdown).toContain(
      "| `bundle-size:warning` | publishable package generated artifact growth",
    );
    expect(markdown).toContain(
      "| `package-manifests:check` | package manifests and Croco compatibility train",
    );
    expect(markdown).toContain(
      "| `production-ready:check` | production-ready package maturity evidence",
    );
    expect(markdown).toContain(
      "| `spine-promotion:check` | beta Croco 1.0 spine executable promotion evidence",
    );
    expect(markdown).toContain(
      "provider-certification, production-ready, spine-promotion, and the dedicated benchmark workflow",
    );
    expect(markdown).toContain(
      "| `benchmark` | performance drift | blocking in dedicated benchmark workflow | n/a (separate workflow) | latest-five-green evidence and benchmark baselines are committed |",
    );
    expect(markdown).toContain("- Runtime exports added/removed: 1 / 0");
    expect(markdown).toContain("- Type exports added/removed: 0 / 1");
    expect(markdown).toContain("run `pnpm public-api:write`");
    expect(summaryJson).toContain('"packageName": "@croco/alpha"');
    expect(summaryJson).toContain('"publicApi"');
    expect(summaryJson).toContain('"bundleSize"');
    expect(summaryJson).toContain('"compatibilityTrain"');
    expect(bundleSizeMarkdown).toContain("# Bundle Size Warning Report");
  });

  it("reports compatibility train policy from manifests and generated app dependencies", () => {
    const repo = createTempRepo();
    writePackageManifest(repo, "packages/runtime", {
      name: "@croco/runtime",
      version: "0.0.3",
      scripts: {
        build: "tsup",
      },
    });
    writePackageManifest(repo, "packages/peer", {
      name: "@croco/peer",
      version: "0.0.3",
      peerDependencies: {
        "@croco/runtime": "^0.0.3",
      },
    });
    writeCatalog(repo, ["runtime"]);
    writeFile(
      repo,
      "scripts/internal-peer-dependency-range-exceptions.json",
      `${JSON.stringify(
        [
          {
            package: "@croco/peer",
            section: "peerDependencies",
            dependency: "@croco/runtime",
            range: "^0.0.3",
            reason: "Published peers intentionally accept the current compatible alpha line.",
            owner: "release",
            compatibilityRationale:
              "The peer package consumes only stable source-level contracts covered by the compatibility train.",
          },
        ],
        null,
        2,
      )}\n`,
    );
    writeFile(
      repo,
      "packages/create-croco-app/templates/app/package.json.hbs",
      `${JSON.stringify(
        {
          dependencies: {
            "@croco/runtime": "workspace:*",
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
      generatedAppVersionSet: {
        policy: "tested-croco-compatibility-train",
        source: "fixture",
        packages: [{ packageName: "@croco/runtime", range: "^0.0.3" }],
      },
    });
    const dashboard = buildReportMarkdown(report);

    expect(report.compatibilityTrain).toEqual(
      expect.objectContaining({
        status: "pass",
        internalRangeDriftCount: 0,
        peerExceptionCount: 1,
        spinePackageCount: 1,
        generatedAppDependencyCount: 1,
        generatedAppRangeDriftCount: 0,
        generatedAppSpineDependencyCount: 1,
        spinePackageNames: ["@croco/runtime"],
      }),
    );
    expect(report.compatibilityTrain.peerExceptions[0]).toEqual(
      expect.objectContaining({
        packageName: "@croco/peer",
        dependencyName: "@croco/runtime",
        owner: "release",
      }),
    );
    expect(report.compatibilityTrain.generatedAppDependencies[0]).toEqual(
      expect.objectContaining({
        packageName: "@croco/runtime",
        templateRange: "workspace:*",
        actualRange: "^0.0.3",
        expectedRange: "^0.0.3",
        inSpine: true,
        status: "pass",
        failureReason: null,
      }),
    );
    expect(dashboard).toContain("## Compatibility train policy");
    expect(dashboard).toContain(
      "Fixed/linked decision: Compatibility-train validation is sufficient",
    );
    expect(dashboard).toContain(
      "| `@croco/runtime` | spine | `workspace:*` | `^0.0.3` | `^0.0.3` | pass |",
    );
    expect(dashboard).toContain(
      "| Package | Dependency | Range | Owner | Reason | Compatibility rationale |",
    );
    expect(dashboard).toContain(
      "| `@croco/peer` | `@croco/runtime` | `^0.0.3` | release | Published peers intentionally accept the current compatible alpha line. | The peer package consumes only stable source-level contracts covered by the compatibility train. |",
    );
  });

  it("fails compatibility train reporting when generated app ranges are stale", () => {
    const repo = createTempRepo();
    writePackageManifest(repo, "packages/runtime", {
      name: "@croco/runtime",
      version: "0.0.3",
    });
    writeCatalog(repo, ["runtime"]);
    writeFile(
      repo,
      "packages/create-croco-app/templates/app/package.json.hbs",
      `${JSON.stringify(
        {
          dependencies: {
            "@croco/runtime": "workspace:*",
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
      generatedAppVersionSet: {
        policy: "tested-croco-compatibility-train",
        source: "fixture",
        packages: [{ packageName: "@croco/runtime", range: "^0.0.2" }],
      },
    });
    const dashboard = buildReportMarkdown(report);

    expect(report.compatibilityTrain).toEqual(
      expect.objectContaining({
        status: "fail",
        internalRangeDriftCount: 0,
        generatedAppRangeDriftCount: 1,
        generatedAppDependencyCount: 1,
      }),
    );
    expect(report.compatibilityTrain.generatedAppDependencies[0]).toEqual(
      expect.objectContaining({
        packageName: "@croco/runtime",
        actualRange: "^0.0.2",
        expectedRange: "^0.0.3",
        status: "fail",
        failureReason: "expected ^0.0.3",
      }),
    );
    expect(dashboard).toContain("fail; 0 internal range drift(s); 1 generated app range drift(s)");
    expect(dashboard).toContain(
      "| `@croco/runtime` | spine | `workspace:*` | `^0.0.2` | `^0.0.3` | fail: expected ^0.0.3 |",
    );
  });

  it("fails compatibility train reporting when exported generated app ranges are stale outside templates", () => {
    const repo = createTempRepo();
    writePackageManifest(repo, "packages/runtime", {
      name: "@croco/runtime",
      version: "0.0.3",
    });
    writePackageManifest(repo, "packages/profile-runtime", {
      name: "@croco/profile-runtime",
      version: "0.0.4",
    });
    writeCatalog(repo, ["runtime"]);
    writeFile(
      repo,
      "packages/create-croco-app/templates/app/package.json.hbs",
      `${JSON.stringify(
        {
          dependencies: {
            "@croco/runtime": "workspace:*",
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
      generatedAppVersionSet: {
        policy: "tested-croco-compatibility-train",
        source: "fixture-version-set",
        packages: [
          { packageName: "@croco/runtime", range: "^0.0.3" },
          { packageName: "@croco/profile-runtime", range: "^0.0.3" },
        ],
      },
    });
    const generatedAppDependency = report.compatibilityTrain.generatedAppDependencies.find(
      (dependency) => dependency.packageName === "@croco/profile-runtime",
    );

    expect(report.compatibilityTrain).toEqual(
      expect.objectContaining({
        status: "fail",
        generatedAppRangeDriftCount: 1,
        generatedAppDependencyCount: 2,
      }),
    );
    expect(generatedAppDependency).toEqual(
      expect.objectContaining({
        templateRange: "version-set",
        actualRange: "^0.0.3",
        expectedRange: "^0.0.4",
        sourcePath: "fixture-version-set",
        status: "fail",
        failureReason: "expected ^0.0.4",
      }),
    );
  });

  it("uses shared peer exception schema for compatibility train reporting", () => {
    const repo = createTempRepo();
    writePackageManifest(repo, "packages/runtime", {
      name: "@croco/runtime",
      version: "0.0.3",
    });
    writePackageManifest(repo, "packages/peer", {
      name: "@croco/peer",
      version: "0.0.3",
      peerDependencies: {
        "@croco/runtime": "^0.0.3",
      },
    });
    writeFile(
      repo,
      "scripts/internal-peer-dependency-range-exceptions.json",
      `${JSON.stringify(
        [
          {
            package: "@croco/peer",
            section: "peerDependencies",
            dependency: "@croco/runtime",
            range: "^0.0.3",
            rationale: "Legacy schema is missing reason, owner, and compatibilityRationale.",
          },
        ],
        null,
        2,
      )}\n`,
    );

    expect(() =>
      createPackageQualityReport({
        rootDir: repo,
        summaryDir: join(repo, ".turbo", "runs"),
      }),
    ).toThrow(
      /scripts\/internal-peer-dependency-range-exceptions\.json\[0\]\.reason must be a string/,
    );
  });

  it("reports bundle-size artifact ownership when baselines are missing", () => {
    const repo = createTempRepo();
    const artifactSource = "console.log('alpha');\n";
    writePackage(repo, "alpha", "@croco/alpha", {
      build: "tsup",
    });
    writeFile(repo, "packages/alpha/dist/index.js", artifactSource);

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
    });
    const artifact = report.bundleSize.artifacts.find(
      (entry) => entry.artifactPath === "packages/alpha/dist/index.js",
    );
    const dashboard = buildReportMarkdown(report);
    const bundleMarkdown = buildBundleSizeMarkdown(report.bundleSize);

    expect(artifact).toEqual(
      expect.objectContaining({
        packageName: "@croco/alpha",
        sizeBytes: Buffer.byteLength(artifactSource),
        baselineBytes: null,
        status: "missing-baseline",
        recoveryCommand: "pnpm --filter @croco/alpha build && pnpm package-quality:report",
      }),
    );
    expect(report.bundleSize.missingBaselineCount).toBe(1);
    expect(dashboard).toContain("warning-only; 1 missing bundle-size baseline(s)");
    expect(bundleMarkdown).toContain(
      "| `@croco/alpha` | `packages/alpha/dist/index.js` | 22 B | missing | - | - | missing-baseline |",
    );
  });

  it("reports bundle-size growth against committed baselines", () => {
    const repo = createTempRepo();
    const artifactSource = "console.log('larger alpha bundle');\n";
    writePackage(repo, "alpha", "@croco/alpha", {
      build: "tsup",
    });
    writeFile(repo, "packages/alpha/dist/index.js", artifactSource);
    writeFile(
      repo,
      "ci-reports/bundle-size/baseline.json",
      `${JSON.stringify(
        {
          artifacts: {
            "@croco/alpha:packages/alpha/dist/index.js": {
              bytes: 10,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
    });
    const artifact = report.bundleSize.artifacts.find(
      (entry) => entry.artifactPath === "packages/alpha/dist/index.js",
    );
    const bundleMarkdown = buildBundleSizeMarkdown(report.bundleSize);

    expect(artifact).toEqual(
      expect.objectContaining({
        packageName: "@croco/alpha",
        baselineKey: "@croco/alpha:packages/alpha/dist/index.js",
        baselineBytes: 10,
        deltaBytes: Buffer.byteLength(artifactSource) - 10,
        status: "over-baseline",
      }),
    );
    expect(report.bundleSize.overBaselineCount).toBe(1);
    expect(bundleMarkdown).toContain("over-baseline");
    expect(bundleMarkdown).toContain("ci-reports/bundle-size/baseline.json");
  });

  it("normalizes lowercase hashed chunks when matching bundle-size baselines", () => {
    const repo = createTempRepo();
    const artifactSource = "console.log('chunk');\n";
    writePackage(repo, "alpha", "@croco/alpha", {
      build: "tsup",
    });
    writeFile(repo, "packages/alpha/dist/chunk-abcdef12.js", artifactSource);

    writeFile(
      repo,
      "ci-reports/bundle-size/baseline.json",
      `${JSON.stringify(
        {
          artifacts: {
            "@croco/alpha:packages/alpha/dist/chunk-*.js": 64,
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
    });
    const artifact = report.bundleSize.artifacts.find(
      (entry) => entry.artifactPath === "packages/alpha/dist/chunk-*.js",
    );

    expect(artifact).toEqual(
      expect.objectContaining({
        packageName: "@croco/alpha",
        baselineKey: "@croco/alpha:packages/alpha/dist/chunk-*.js",
        baselineBytes: 64,
        status: "within-baseline",
      }),
    );
    expect(report.bundleSize.missingBaselineCount).toBe(0);
    expect(report.bundleSize.unmatchedBaselineCount).toBe(0);
  });

  it("blocks spine bundle-size regressions in enforcement mode while non-spine packages stay advisory", () => {
    const repo = createTempRepo();
    const spineArtifactSource = "console.log('larger spine bundle');\n";
    const nonSpineArtifactSource = "console.log('larger non-spine bundle');\n";
    writePackage(repo, "spine", "@croco/spine", {
      build: "tsup",
    });
    writePackage(repo, "non-spine", "@croco/non-spine", {
      build: "tsup",
    });
    writeCatalog(repo, ["spine"]);
    writeFile(repo, "packages/spine/dist/index.js", spineArtifactSource);
    writeFile(repo, "packages/non-spine/dist/index.js", nonSpineArtifactSource);
    writeFile(
      repo,
      "ci-reports/bundle-size/baseline.json",
      `${JSON.stringify(
        {
          artifacts: {
            "@croco/spine:packages/spine/dist/index.js": 10,
            "@croco/non-spine:packages/non-spine/dist/index.js": 10,
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
      enforceSpineBundleSize: true,
    });
    const spineArtifact = report.bundleSize.artifacts.find(
      (entry) => entry.artifactPath === "packages/spine/dist/index.js",
    );
    const nonSpineArtifact = report.bundleSize.artifacts.find(
      (entry) => entry.artifactPath === "packages/non-spine/dist/index.js",
    );
    const dashboard = buildReportMarkdown(report);
    const bundleMarkdown = buildBundleSizeMarkdown(report.bundleSize);

    expect(report.bundleSize.ciMode).toBe("spine-blocking");
    expect(report.bundleSize.spineBlockingRegressionCount).toBe(1);
    expect(report.bundleSize.spineBlockingIssueCount).toBe(1);
    expect(report.bundleSize.nonSpineAdvisoryWarningCount).toBe(1);
    expect(spineArtifact).toEqual(
      expect.objectContaining({
        blocking: true,
        scope: "spine",
        status: "over-baseline",
      }),
    );
    expect(nonSpineArtifact).toEqual(
      expect.objectContaining({
        blocking: false,
        scope: "non-spine",
        status: "over-baseline",
      }),
    );
    expect(dashboard).toContain("spine-blocking; 1 spine blocking issue(s); 1 advisory warning(s)");
    expect(bundleMarkdown).toContain("## Spine blocking enforcement");
    expect(bundleMarkdown).toContain("| `@croco/spine` | `packages/spine/dist/index.js`");
    expect(bundleMarkdown).toContain("| `@croco/non-spine` | `packages/non-spine/dist/index.js`");
  });

  it("blocks spine baseline coverage gaps in enforcement mode", () => {
    const repo = createTempRepo();
    writePackage(repo, "missing-baseline", "@croco/missing-baseline", {
      build: "tsup",
    });
    writePackage(repo, "not-built", "@croco/not-built", {
      build: "tsup",
    });
    writeCatalog(repo, ["missing-baseline", "not-built"]);
    writeFile(repo, "packages/missing-baseline/dist/index.js", "console.log('missing');\n");

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
      enforceSpineBundleSize: true,
    });

    expect(report.bundleSize.spineBlockingSetupIssueCount).toBe(2);
    expect(report.bundleSize.spineBlockingIssueCount).toBe(2);
    expect(report.bundleSize.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: "@croco/missing-baseline",
          blocking: true,
          status: "missing-baseline",
        }),
        expect.objectContaining({
          packageName: "@croco/not-built",
          blocking: true,
          status: "not-built",
        }),
      ]),
    );
  });

  it("blocks spine-owned unmatched baselines while ambiguous unmatched baselines stay advisory", () => {
    const repo = createTempRepo();
    const artifactSource = "console.log('stable spine bundle');\n";
    writePackage(repo, "spine", "@croco/spine", {
      build: "tsup",
    });
    writeCatalog(repo, ["spine"]);
    writeFile(repo, "packages/spine/dist/index.js", artifactSource);
    writeFile(
      repo,
      "ci-reports/bundle-size/baseline.json",
      `${JSON.stringify(
        {
          artifacts: {
            "@croco/spine:packages/spine/dist/index.js": Buffer.byteLength(artifactSource),
            "@croco/spine:packages/spine/dist/stale.js": 10,
            "packages/spine/dist/stale.css": 10,
            "dist/ambiguous.js": 10,
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
      enforceSpineBundleSize: true,
    });

    expect(report.bundleSize.unmatchedBaselineCount).toBe(3);
    expect(report.bundleSize.spineBlockingUnmatchedBaselineCount).toBe(2);
    expect(report.bundleSize.spineBlockingIssueCount).toBe(2);
    expect(report.bundleSize.advisoryWarningCount).toBe(1);
    expect(report.bundleSize.blockingUnmatchedBaselines).toEqual([
      "@croco/spine:packages/spine/dist/stale.js",
      "packages/spine/dist/stale.css",
    ]);
  });

  it("keeps hashed chunk normalization stable under spine enforcement", () => {
    const repo = createTempRepo();
    writePackage(repo, "cli", "@croco/cli", {
      build: "tsup",
    });
    writeCatalog(repo, ["cli"]);
    writeFile(repo, "packages/cli/dist/chunk-ABCDEFGH.js", "1234567890");
    writeFile(repo, "packages/cli/dist/chunk-ZYXWVUTS.js", "12345");
    writeFile(repo, "packages/cli/dist/create-ZYXWVUTS.js", "1234567890");
    writeFile(
      repo,
      "ci-reports/bundle-size/baseline.json",
      `${JSON.stringify(
        {
          artifacts: {
            "@croco/cli:packages/cli/dist/chunk-*.js": 10,
            "@croco/cli:packages/cli/dist/create-ABCDEFGH.js": 10,
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
      enforceSpineBundleSize: true,
    });
    const chunkArtifact = report.bundleSize.artifacts.find(
      (entry) => entry.artifactPath === "packages/cli/dist/chunk-*.js",
    );
    const namedChunkArtifact = report.bundleSize.artifacts.find(
      (entry) => entry.artifactPath === "packages/cli/dist/create-*.js",
    );

    expect(chunkArtifact).toEqual(
      expect.objectContaining({
        baselineKey: "@croco/cli:packages/cli/dist/chunk-*.js",
        blocking: true,
        sizeBytes: 15,
        status: "over-baseline",
      }),
    );
    expect(namedChunkArtifact).toEqual(
      expect.objectContaining({
        baselineKey: "@croco/cli:packages/cli/dist/create-*.js",
        blocking: false,
        sizeBytes: 10,
        status: "within-baseline",
      }),
    );
    expect(report.bundleSize.unmatchedBaselines).toEqual([]);
  });

  it("exits non-zero only when bundle-size spine enforcement is requested", () => {
    const repo = createTempRepo();
    writePackage(repo, "spine", "@croco/spine", {
      build: "tsup",
    });
    writeCatalog(repo, ["spine"]);
    writeFile(repo, "packages/spine/dist/index.js", "console.log('larger spine bundle');\n");
    writeFile(
      repo,
      "ci-reports/bundle-size/baseline.json",
      `${JSON.stringify(
        {
          artifacts: {
            "@croco/spine:packages/spine/dist/index.js": 10,
          },
        },
        null,
        2,
      )}\n`,
    );

    const scriptPath = join(process.cwd(), "scripts/package-quality-report.mts");
    const outputDir = join(repo, "ci-reports", "package-quality");
    const advisoryResult = spawnSync(
      process.execPath,
      ["--experimental-strip-types", scriptPath, "--root", repo, "--output-dir", outputDir],
      {
        encoding: "utf-8",
      },
    );
    const enforcedResult = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        scriptPath,
        "--root",
        repo,
        "--output-dir",
        outputDir,
        "--",
        "--enforce-spine-bundle-size",
      ],
      {
        encoding: "utf-8",
      },
    );

    expect(advisoryResult.status).toBe(0);
    expect(enforcedResult.status).toBe(1);
    expect(enforcedResult.stdout).toContain("spine bundle-size blocking issues=1");
  });

  it("keeps boundary-check-only isolated from bundle-size enforcement", () => {
    const repo = createTempRepo();
    writeFile(repo, "packages/repository-core/src/index.ts", "export const value = 1;\n");
    writeFile(repo, "packages/protocols-desktop/src/index.ts", "export const value = 1;\n");
    const scriptPath = join(process.cwd(), "scripts/package-quality-report.mts");
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        scriptPath,
        "--root",
        repo,
        "--boundary-check-only",
        "--enforce-spine-bundle-size",
      ],
      {
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dependency-boundaries: all rules passed");
  });

  it("reports unmatched bundle-size baselines as warning-only stale setup work", () => {
    const repo = createTempRepo();
    writePackage(repo, "alpha", "@croco/alpha", {
      build: "tsup",
    });
    writeFile(repo, "packages/alpha/dist/index.js", "console.log('alpha');\n");
    writeFile(
      repo,
      "ci-reports/bundle-size/baseline.json",
      `${JSON.stringify(
        {
          artifacts: {
            "@croco/alpha:packages/alpha/dist/index.js": 64,
            "@croco/alpha:packages/alpha/dist/stale.js": 128,
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = createPackageQualityReport({
      rootDir: repo,
      summaryDir: join(repo, ".turbo", "runs"),
    });
    const dashboard = buildReportMarkdown(report);
    const bundleMarkdown = buildBundleSizeMarkdown(report.bundleSize);

    expect(report.bundleSize.unmatchedBaselineCount).toBe(1);
    expect(report.bundleSize.unmatchedBaselines).toEqual([
      "@croco/alpha:packages/alpha/dist/stale.js",
    ]);
    expect(dashboard).toContain("1 unmatched bundle-size baseline(s)");
    expect(bundleMarkdown).toContain("## Unmatched baselines");
    expect(bundleMarkdown).toContain("| `@croco/alpha:packages/alpha/dist/stale.js` |");
  });

  it("flags repository-core Drizzle boundary violations", () => {
    const repo = createTempRepo();
    writePackage(repo, "repository-core", "@croco/repository-core", {
      build: "tsup",
    });
    writeFile(
      repo,
      "packages/repository-core/src/index.ts",
      "export const leak = 'drizzle-orm';\n",
    );

    const results = scanDependencyBoundaries(repo);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "repository-core-drizzle-free",
          packageName: "@croco/repository-core",
          status: "fail",
          violations: [
            expect.objectContaining({
              file: "packages/repository-core/src/index.ts",
              line: 1,
            }),
          ],
        }),
      ]),
    );
  });

  it("flags Electron runtime imports in desktop protocol sources", () => {
    const repo = createTempRepo();
    writePackage(repo, "protocols-desktop", "@croco/protocols-desktop", {
      build: "tsup",
    });
    writeFile(
      repo,
      "packages/protocols-desktop/src/index.ts",
      'import { app } from "electron";\nexport const desktop = app;\n',
    );

    const results = scanDependencyBoundaries(repo);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "protocols-desktop-runtime-free",
          packageName: "@croco/protocols-desktop",
          status: "fail",
          violations: [
            expect.objectContaining({
              file: "packages/protocols-desktop/src/index.ts",
              line: 1,
            }),
          ],
        }),
      ]),
    );
  });

  it("reads package globs from pnpm-workspace.yaml", () => {
    expect(
      parseWorkspacePackagePatterns(`
packages:
  - packages/**/*
  - "examples/*"
  - '!ignored/*'

onlyBuiltDependencies:
  - esbuild
`),
    ).toEqual(["packages/**/*", "examples/*"]);
  });
});

function createTempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "croco-package-quality-"));
  tempRepos.push(repo);
  mkdirSync(join(repo, "packages"), { recursive: true });
  mkdirSync(join(repo, ".turbo", "runs"), { recursive: true });
  return repo;
}

function writePackage(
  repo: string,
  dirName: string,
  packageName: string,
  scripts: Record<string, string>,
): void {
  writeWorkspacePackage(repo, `packages/${dirName}`, packageName, scripts);
}

function writePackageManifest(
  repo: string,
  relativeDir: string,
  packageJson: Record<string, unknown>,
): void {
  writeFile(repo, `${relativeDir}/package.json`, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFile(repo, `${relativeDir}/src/index.ts`, "export const value = 1;\n");
}

function writeWorkspacePackage(
  repo: string,
  relativeDir: string,
  packageName: string,
  scripts: Record<string, string>,
): void {
  writeFile(
    repo,
    `${relativeDir}/package.json`,
    `${JSON.stringify(
      {
        name: packageName,
        scripts,
      },
      null,
      2,
    )}\n`,
  );
  writeFile(repo, `${relativeDir}/src/index.ts`, "export const value = 1;\n");
}

function writeCatalog(repo: string, spinePackages: readonly string[]): void {
  writeFile(
    repo,
    "docs/package-catalog.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        spine: {
          label: "Croco 1.0 spine",
          description: "Fixture spine",
          packages: spinePackages,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeTurboSummary(
  repo: string,
  fileName: string,
  command: string,
  endTime: number,
  tasks: readonly ReturnType<typeof task>[],
): void {
  writeFile(
    repo,
    `.turbo/runs/${fileName}`,
    `${JSON.stringify(
      {
        execution: {
          command,
          endTime,
          exitCode: tasks.some((entry) => entry.execution.exitCode !== 0) ? 1 : 0,
        },
        tasks,
      },
      null,
      2,
    )}\n`,
  );
}

function task(
  packageName: string,
  taskName: string,
  exitCode: number,
  logFile: string,
  directory = `packages/${packageName.replace(/^@croco\/?/, "")}`,
) {
  return {
    taskId: `${packageName}#${taskName}`,
    task: taskName,
    package: packageName,
    directory,
    logFile,
    cache: {
      status: exitCode === 0 ? "HIT" : "MISS",
    },
    execution: {
      exitCode,
    },
  };
}

function writeFile(repo: string, relativePath: string, content: string): void {
  const filePath = join(repo, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}
