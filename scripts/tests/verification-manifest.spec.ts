import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertVerificationManifest,
  createVerificationLaneManifest,
  createVerificationManifest,
  generatedTestMaterializationArguments,
  PUBLISH_REQUIRED_GENERATED_SMOKE_CASES,
  VERIFICATION_DEPENDENCY_CLASSIFICATION,
  VERIFICATION_LANE_OWNERSHIP,
  verificationImplementationPaths,
} from "../verification-manifest.mts";
import {
  RELEASE_GATE_ENTRYPOINT_PATHS,
  RELEASE_GATE_FIXTURE_PATHS,
  RELEASE_GATE_IMPLEMENTATION_PATHS,
  RELEASE_GATE_MAINTENANCE_PATHS,
  RELEASE_GATE_POLICY_INPUT_PATHS,
  RELEASE_GATE_SUPPORT_PATHS,
  RELEASE_GATE_TEST_PATHS,
  RELEASE_GATE_WORKFLOW_PATHS,
} from "../release-gate-maintenance.mts";
import { effectivePublishManifest, findPackageJsonFiles } from "../package-manifest-contracts.mjs";
import {
  assertGeneratedSmokeCaseDependencyMapping,
  assertGeneratedSmokeDependencyMapping,
  readGeneratedSmokeCaseDirectDependencies,
  selectGeneratedSmokeCasesForChangedFiles,
  selectGeneratedTestPathsForSmokeCases,
} from "../create-croco-app-generated-smoke-dependencies.mts";
import { getGeneratedSmokeDependencyCaseInputs } from "../create-croco-app-generated-smoke.mts";
import { assertPackedDependencyClosure } from "../packed-decorator-consumers.mts";
import { readTestInventory } from "../test-inventory.mts";
import { generate } from "../../packages/create-croco-app/src/generator.ts";
import {
  normalizeNonInteractiveOptions,
  parseCliOptions,
} from "../../packages/create-croco-app/src/options.ts";
import type { EvidenceCommand } from "../release-spine-evidence.mts";

const ROOT_DIR = resolve(__dirname, "../..");
const SCRIPT_EXTENSIONS = [".mts", ".ts", ".mjs", ".js"] as const;

function releaseGateImportSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)(["'])(\.{1,2}\/[^"']+)\1/g)]
    .map((match) => match[2])
    .filter((specifier): specifier is string => specifier !== undefined);
}

function discoverReleaseGateScriptPaths(roots: readonly string[]): readonly string[] {
  const discovered = new Set<string>();
  const pending = [...roots];

  for (const path of pending) {
    if (discovered.has(path)) continue;
    discovered.add(path);

    const source = readFileSync(resolve(ROOT_DIR, path), "utf8");
    for (const specifier of releaseGateImportSpecifiers(source)) {
      const unresolved = resolve(ROOT_DIR, dirname(path), specifier);
      const candidates = extname(unresolved)
        ? [unresolved]
        : SCRIPT_EXTENSIONS.map((extension) => `${unresolved}${extension}`);
      const resolved = candidates.find((candidate) => existsSync(candidate));
      if (!resolved) continue;
      const repositoryPath = relative(ROOT_DIR, resolved).replaceAll("\\", "/");
      if (repositoryPath.startsWith("scripts/") && !discovered.has(repositoryPath)) {
        pending.push(repositoryPath);
      }
    }
  }

  return [...discovered].sort();
}

function parseGeneratedSmokeRawOptions(args: readonly string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) continue;
    if (arg.startsWith("--no-")) {
      options[toCamelCase(arg.slice("--no-".length))] = false;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      options[toCamelCase(arg.slice(2))] = true;
      continue;
    }
    options[toCamelCase(arg.slice(2))] = value;
    index += 1;
  }
  return options;
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

const repoIds = [
  "verification-policy",
  "test-inventory",
  "turbo-cache-contract",
  "verification-contract-tests",
  "changeset-required",
  "package-manifests",
  "release-version-sync",
  "docs-catalog",
  "docs-api-triggers",
  "problem-registry",
  "docs-examples",
  "release-docs",
  "ci-executables",
  "ci-performance-budget",
  "architecture-policy-runtime",
  "architecture-policy",
  "architecture-circular-allowlist",
  "dependency-boundaries",
  "security-allowlists",
  "generated-secret-placeholders",
  "compiler-baseline",
  "decorator-signature-spike",
  "strict-contract-typecheck",
  "static-misuse",
  "lint",
  "format",
  "architecture-circular",
  "benchmark-thresholds",
];
const spineOnlyIds = [
  "build",
  "quick-start-lambda-smoke",
  "first-success",
  "package-entrypoints-smoke",
  "package-bins-smoke",
  "generated-app-smoke",
  "packed-decorator-consumers",
  "alpha-release-smoke",
  "typecheck",
  "test",
  "integration-test-lane",
  "published-test-lane",
  "test-evidence-reconcile",
  "cli-packed-e2e",
  "provider-certification",
  "production-ready",
  "spine-promotion",
  "core-coverage",
  "core-coverage-warning",
  "public-api",
];

const publishOnlyIds = [
  "release-gate-tests",
  "release-metadata",
  "spine-bundle-size",
  "dependency-audit-policy",
  "provenance-config",
  "publish-dry-run",
];

const expectedLaneIds = {
  "core-verification": [
    "verification-policy",
    "test-inventory",
    "turbo-cache-contract",
    "verification-contract-tests",
    "changeset-required",
    "package-manifests",
    "release-version-sync",
    "docs-catalog",
    "docs-api-triggers",
    "problem-registry",
    "docs-examples",
    "release-docs",
    "ci-executables",
    "ci-performance-budget",
    "architecture-policy-runtime",
    "architecture-policy",
    "architecture-circular-allowlist",
    "dependency-boundaries",
    "compiler-baseline",
    "decorator-signature-spike",
    "strict-contract-typecheck",
    "static-misuse",
    "lint",
    "format",
    "architecture-circular",
    "benchmark-thresholds",
    "build",
    "quick-start-lambda-smoke",
    "first-success",
    "typecheck",
    "test",
    "integration-test-lane",
    "cli-packed-e2e",
    "release-gate-tests",
  ],
  "generated-apps": ["generated-app-smoke"],
  "package-artifacts": [
    "package-entrypoints-smoke",
    "packed-decorator-consumers",
    "package-bins-smoke",
    "alpha-release-smoke",
    "published-test-lane",
    "provider-certification",
    "public-api",
    "release-metadata",
    "publish-dry-run",
  ],
  "coverage-security": [
    "security-allowlists",
    "generated-secret-placeholders",
    "core-coverage",
    "core-coverage-warning",
    "dependency-audit-policy",
    "provenance-config",
  ],
  "split-validation-shadow": [
    "test-evidence-reconcile",
    "production-ready",
    "spine-promotion",
    "spine-bundle-size",
  ],
} as const;

describe("verification manifest", () => {
  it("passes the exact verification base to Problem registry checks", () => {
    const baseSha = "a".repeat(40);
    const command = createVerificationManifest("repo", {
      base: baseSha,
      changedFiles: ["scripts/problem-registry.mts"],
      head: "b".repeat(40),
    }).find(({ id }) => id === "problem-registry");

    expect(command?.command).toEqual([
      "node",
      "--experimental-strip-types",
      "scripts/tracked-file-mutation-guard.mts",
      "--recovery",
      "pnpm problem-registry:write",
      "--",
      "node",
      "--experimental-strip-types",
      "scripts/problem-registry.mts",
      "--check",
      "--base",
      baseSha,
    ]);
  });

  it("discovers static, dynamic, and side-effect relative imports", () => {
    expect(
      releaseGateImportSpecifiers(`
        import value from "./static.mts";
        import("./dynamic.mts");
        import "./side-effect.mts";
      `),
    ).toEqual(["./static.mts", "./dynamic.mts", "./side-effect.mts"]);
  });

  it("composes exact ordered repo, spine, and publish profiles", () => {
    expect(createVerificationManifest("repo").map(({ id }) => id)).toEqual(repoIds);
    expect(createVerificationManifest("spine").map(({ id }) => id)).toEqual([
      ...repoIds,
      ...spineOnlyIds,
    ]);
    expect(createVerificationManifest("publish").map(({ id }) => id)).toEqual([
      "release-metadata",
      ...repoIds,
      ...spineOnlyIds,
      ...publishOnlyIds.filter((id) => id !== "release-metadata"),
    ]);
    expect(
      createVerificationManifest("publish").find(({ id }) => id === "spine-bundle-size")?.command,
    ).toEqual(["node", "--experimental-strip-types", "scripts/package-quality-report.mts"]);
    expect(
      createVerificationManifest("repo").find(({ id }) => id === "test-inventory"),
    ).toMatchObject({
      command: expect.arrayContaining([
        "scripts/test-inventory.mts",
        "--check",
        "--profile",
        "ordinary",
        "--output",
        "ci-reports/package-quality/test-inventory.json",
      ]),
      artifacts: [
        expect.objectContaining({
          path: "ci-reports/package-quality/test-inventory.json",
          required: true,
        }),
      ],
    });
  });

  it("owns all 54 commands exactly once across the closed verification lanes", () => {
    const publishIds = [...repoIds, ...spineOnlyIds, ...publishOnlyIds];
    const ownedIds = Object.values(expectedLaneIds).flat();

    expect(publishIds).toHaveLength(54);
    expect(new Set(ownedIds).size).toBe(54);
    expect([...ownedIds].sort()).toEqual([...publishIds].sort());
    expect(VERIFICATION_LANE_OWNERSHIP).toEqual(
      Object.fromEntries(
        Object.entries(expectedLaneIds).flatMap(([lane, ids]) => ids.map((id) => [id, lane])),
      ),
    );
  });

  it("preserves the exact pre-split monolithic manifest output", () => {
    const manifests = (["repo", "spine", "publish"] as const).map((profile) =>
      createVerificationManifest(profile),
    );
    expect(
      createHash("sha256").update(JSON.stringify(manifests)).digest("hex"),
      "The pre-split monolithic manifest changed; update this digest only after intentionally verifying the new serialized commands.",
    ).toBe("8af5fdd8d9a771799ebdad2957196b812be065bfb6a5939ead52c569b2142336");
  });

  it("classifies every dependency edge and every cross-lane edge for synthesis", () => {
    const manifest = createVerificationManifest("publish");
    const expectedEdges = manifest.flatMap((command) =>
      (command.dependsOn ?? []).map((dependency) => `${command.id}->${dependency}`),
    );

    expect(Object.keys(VERIFICATION_DEPENDENCY_CLASSIFICATION).sort()).toEqual(
      [...expectedEdges].sort(),
    );
    for (const command of manifest) {
      for (const dependency of command.dependsOn ?? []) {
        const classifications =
          VERIFICATION_DEPENDENCY_CLASSIFICATION[
            `${command.id}->${dependency}` as keyof typeof VERIFICATION_DEPENDENCY_CLASSIFICATION
          ];
        expect(classifications.length, `${command.id}->${dependency}`).toBeGreaterThan(0);
        expect(new Set(classifications).size, `${command.id}->${dependency}`).toBe(
          classifications.length,
        );
        if (
          VERIFICATION_LANE_OWNERSHIP[command.id as keyof typeof VERIFICATION_LANE_OWNERSHIP] !==
          VERIFICATION_LANE_OWNERSHIP[dependency as keyof typeof VERIFICATION_LANE_OWNERSHIP]
        ) {
          expect(classifications, `${command.id}->${dependency}`).toContain("logical-synthesis");
        }
      }
    }
  });

  it("selects owned commands unchanged and exposes transitive physical-local prerequisites", () => {
    const context = {
      base: "origin/trunk",
      changedFiles: ["scripts/verification-manifest.mts"],
      head: "HEAD",
    } as const;
    const monolithic = createVerificationManifest("publish", context);
    const serializedMonolithic = JSON.stringify(monolithic);

    for (const [lane, ids] of Object.entries(expectedLaneIds)) {
      const selected = createVerificationLaneManifest(
        "publish",
        lane as keyof typeof expectedLaneIds,
        context,
      );
      expect(selected.commands).toEqual(monolithic.filter(({ id }) => ids.includes(id as never)));
      for (const command of selected.commands) {
        expect(command.applicable).toBe(monolithic.find(({ id }) => id === command.id)?.applicable);
      }
    }

    expect(
      createVerificationLaneManifest("publish", "package-artifacts").physicalLocalPrerequisites.map(
        ({ id }) => id,
      ),
    ).toEqual(["architecture-policy-runtime", "build"]);
    expect(
      createVerificationLaneManifest("publish", "generated-apps").physicalLocalPrerequisites.map(
        ({ id }) => id,
      ),
    ).toEqual(["release-metadata", "architecture-policy-runtime", "build"]);
    expect(
      createVerificationLaneManifest("publish", "coverage-security").physicalLocalPrerequisites.map(
        ({ id }) => id,
      ),
    ).toEqual(["release-metadata", "architecture-policy-runtime", "build"]);
    expect(
      createVerificationLaneManifest("publish", "split-validation-shadow")
        .physicalLocalPrerequisites,
    ).toEqual([]);
    expect(
      createVerificationLaneManifest(
        "publish",
        "package-artifacts",
        context,
      ).physicalLocalPrerequisites.map(({ id }) => id),
    ).toEqual(["architecture-policy-runtime", "build"]);
    expect(JSON.stringify(monolithic)).toBe(serializedMonolithic);
    expect(createVerificationManifest("publish", context)).toEqual(monolithic);
  });

  it("rejects verification lanes outside the closed lane set", () => {
    expect(() =>
      createVerificationLaneManifest("publish", "unknown" as "core-verification"),
    ).toThrow("Unknown verification lane: unknown");
  });

  it("runs every blocking generated case and the smallest inventory-complete advisory set", () => {
    const generatedSmoke = createVerificationManifest("publish").find(
      ({ id }) => id === "generated-app-smoke",
    );
    expect(generatedSmoke?.command).toEqual([
      "node",
      "--experimental-strip-types",
      "scripts/create-croco-app-generated-smoke.mts",
      ...PUBLISH_REQUIRED_GENERATED_SMOKE_CASES,
    ]);
    expect(
      generatedSmoke?.artifacts?.find(
        ({ path }) => path === "ci-reports/generated-apps/spine-blocking-journeys",
      )?.required,
    ).toBe(false);

    const generatedInventoryPaths = readTestInventory()
      .inventory.tests.filter(({ lane }) => lane === "generated-app")
      .map(({ path }) => path)
      .sort();
    expect(
      selectGeneratedTestPathsForSmokeCases(
        PUBLISH_REQUIRED_GENERATED_SMOKE_CASES,
        generatedInventoryPaths,
      ).sort(),
    ).toEqual(generatedInventoryPaths);
    expect(PUBLISH_REQUIRED_GENERATED_SMOKE_CASES).toHaveLength(12);

    const packedCli = createVerificationManifest("publish").find(
      ({ id }) => id === "cli-packed-e2e",
    );
    expect(packedCli?.command).toEqual(
      expect.arrayContaining([
        "scripts/test-lane-evidence-check.mts",
        "ci-reports/package-quality/integration-test-lane.json",
      ]),
    );
    expect(VERIFICATION_LANE_OWNERSHIP["cli-packed-e2e"]).toBe("core-verification");
    expect(VERIFICATION_DEPENDENCY_CLASSIFICATION["cli-packed-e2e->integration-test-lane"]).toEqual(
      ["physical-local"],
    );
  });

  it("treats inventory changes as affecting every declared fidelity lane", () => {
    const manifest = createVerificationManifest("publish", {
      base: "origin/trunk",
      changedFiles: ["test-inventory.json"],
      head: "HEAD",
    });
    for (const id of [
      "generated-app-smoke",
      "package-entrypoints-smoke",
      "integration-test-lane",
      "published-test-lane",
      "core-coverage",
    ]) {
      expect(manifest.find((command) => command.id === id)?.applicable, id).toBe(true);
    }
  });

  it("runs packed decorator consumers for publish and relevant package changes", () => {
    const publishCommand = createVerificationManifest("publish").find(
      ({ id }) => id === "packed-decorator-consumers",
    );
    expect(publishCommand).toMatchObject({
      applicable: true,
      command: ["node", "--experimental-strip-types", "scripts/packed-decorator-consumers.mts"],
      dependsOn: ["build"],
    });
    expect(VERIFICATION_LANE_OWNERSHIP["packed-decorator-consumers"]).toBe("package-artifacts");
    expect(VERIFICATION_DEPENDENCY_CLASSIFICATION["packed-decorator-consumers->build"]).toEqual([
      "physical-local",
      "logical-synthesis",
    ]);

    const context = {
      base: "origin/trunk",
      head: "HEAD",
    } as const;
    const relevant = createVerificationManifest("spine", {
      ...context,
      changedFiles: ["packages/protocols-rest/src/libs/decorators/HttpMethod.ts"],
    });
    const sharedConfig = createVerificationManifest("spine", {
      ...context,
      changedFiles: ["tsconfig/tsconfig.node.json"],
    });
    const gateOnly = createVerificationManifest("spine", {
      ...context,
      changedFiles: ["scripts/packed-decorator-consumers.mts"],
    });
    const unrelated = createVerificationManifest("spine", {
      ...context,
      changedFiles: ["packages/storage-s3/src/index.ts"],
    });
    expect(relevant.find(({ id }) => id === "packed-decorator-consumers")?.applicable).toBe(true);
    expect(sharedConfig.find(({ id }) => id === "packed-decorator-consumers")?.applicable).toBe(
      true,
    );
    expect(gateOnly.find(({ id }) => id === "build")?.command).toEqual(
      expect.arrayContaining([
        "--filter=@croco/problems-core",
        "--filter=@croco/diagnostics-core",
        "--filter=@croco/framework-context",
        "--filter=@croco/protocols-core",
        "--filter=@croco/protocols-rest",
      ]),
    );
    expect(unrelated.find(({ id }) => id === "packed-decorator-consumers")?.applicable).toBe(false);
  });

  it.each(["dependencies", "optionalDependencies", "peerDependencies"] as const)(
    "rejects local protocols in packed %s",
    (section) => {
      for (const protocol of ["workspace:", "file:", "link:", "portal:"]) {
        expect(() =>
          assertPackedDependencyClosure(
            "@croco/source",
            { [section]: { external: `${protocol}../external` } },
            new Set(),
          ),
        ).toThrow(`repository-local ${section} entry external@${protocol}../external`);
      }
    },
  );

  it.each(["dependencies", "optionalDependencies", "peerDependencies"] as const)(
    "rejects unpacked internal packages in packed %s",
    (section) => {
      expect(() =>
        assertPackedDependencyClosure(
          "@croco/source",
          { [section]: { "@croco/missing": "1.0.0" } },
          new Set(["@croco/source"]),
        ),
      ).toThrow(`unpacked internal ${section} entry @croco/missing`);
    },
  );

  it("accepts registry dependencies and packed internal packages", () => {
    expect(() =>
      assertPackedDependencyClosure(
        "@croco/source",
        {
          dependencies: { "@croco/packed": "1.0.0", external: "^2.0.0" },
          optionalDependencies: { optional: "~3.0.0" },
          peerDependencies: { peer: ">=4" },
        },
        new Set(["@croco/source", "@croco/packed"]),
      ),
    ).not.toThrow();
  });

  it("selects exact inventory lane owners for ordinary changes and full lanes for publish", () => {
    const cli = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["packages/cli/src/index.ts"],
      head: "HEAD",
    });
    expect(cli.find(({ id }) => id === "integration-test-lane")).toMatchObject({
      applicable: true,
      command: expect.arrayContaining(["--lane", "integration", "--owner", "@croco/cli"]),
    });
    expect(cli.find(({ id }) => id === "published-test-lane")?.applicable).toBe(false);

    const metaVite = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["packages/meta-vite/src/index.ts"],
      head: "HEAD",
    });
    expect(metaVite.find(({ id }) => id === "published-test-lane")).toMatchObject({
      applicable: true,
      command: expect.arrayContaining(["--lane", "published", "--owner", "@croco/meta-vite"]),
    });

    for (const id of ["integration-test-lane", "published-test-lane"]) {
      const command = createVerificationManifest("publish", {
        base: "origin/trunk",
        changedFiles: ["packages/retry-core/src/index.ts"],
        head: "HEAD",
      }).find((candidate) => candidate.id === id);
      expect(command?.applicable, id).toBe(true);
      expect(command?.command, id).not.toContain("--owner");
    }
  });

  it("runs one authoritative release-gate suite without duplicating contract tests", () => {
    const manual = createVerificationManifest("publish");
    expect(manual.find(({ id }) => id === "release-gate-tests")?.applicable).toBe(true);
    expect(manual.find(({ id }) => id === "verification-contract-tests")?.applicable).toBe(false);

    const maintenance = createVerificationManifest("publish", {
      base: "origin/trunk",
      changedFiles: ["scripts/production-ready-check.mts"],
      head: "HEAD",
    });
    expect(maintenance.find(({ id }) => id === "release-gate-tests")?.applicable).toBe(true);
    expect(maintenance.find(({ id }) => id === "verification-contract-tests")?.applicable).toBe(
      false,
    );

    const packageCandidate = createVerificationManifest("publish", {
      base: "origin/trunk",
      changedFiles: ["packages/retry-core/package.json"],
      head: "HEAD",
    });
    expect(packageCandidate.find(({ id }) => id === "release-gate-tests")?.applicable).toBe(false);
    expect(
      packageCandidate.find(({ id }) => id === "verification-contract-tests")?.applicable,
    ).toBe(false);
    expect(packageCandidate.find(({ id }) => id === "test")?.command).not.toContain("--owner");

    const spineScripts = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["scripts/ci-cacheable-failure-injection.mts"],
      head: "HEAD",
    });
    expect(spineScripts.find(({ id }) => id === "verification-contract-tests")?.applicable).toBe(
      false,
    );
    expect(spineScripts.find(({ id }) => id === "test")?.command).toEqual(
      expect.arrayContaining(["--owner", "repo:ci"]),
    );

    expect(
      createVerificationManifest("repo").find(({ id }) => id === "verification-contract-tests")
        ?.applicable,
    ).toBe(true);
    expect(
      createVerificationManifest("spine").find(({ id }) => id === "verification-contract-tests")
        ?.applicable,
    ).toBe(false);
  });

  it("keeps affected task evidence while selecting scoped package accountability checks", () => {
    const manifest = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["packages/customer-health-core/src/libs/CustomerHealthScore.ts"],
      head: "HEAD",
    });
    const byId = new Map(manifest.map((command) => [command.id, command]));

    expect(byId.get("build")?.command).toContain("--filter=...[origin/trunk]");
    expect(byId.get("typecheck")?.command).toContain("--filter=...[origin/trunk]");
    expect(byId.get("test")?.command).toEqual(
      expect.arrayContaining(["scripts/test-lane-runner.mts", "--lane", "fast"]),
    );
    expect(byId.get("test")?.command).not.toContain("--force");
    expect(byId.get("turbo-cache-contract")?.command).toEqual([
      "node",
      "--experimental-strip-types",
      "scripts/turbo-cache-contract.mts",
    ]);
    expect(manifest.findIndex(({ id }) => id === "build")).toBeLessThan(
      manifest.findIndex(({ id }) => id === "typecheck"),
    );
    expect(manifest.findIndex(({ id }) => id === "typecheck")).toBeLessThan(
      manifest.findIndex(({ id }) => id === "test"),
    );
    expect(byId.get("package-entrypoints-smoke")?.command).toContain("--build-missing");
    expect(byId.get("package-entrypoints-smoke")?.concurrencyGroups).toEqual([
      "workspace-artifacts",
      "package-entrypoints",
    ]);
    for (const id of [
      "alpha-release-smoke",
      "cli-packed-e2e",
      "core-coverage",
      "package-bins-smoke",
      "package-entrypoints-smoke",
      "quick-start-lambda-smoke",
    ]) {
      expect(byId.get(id)?.applicable, id).toBe(false);
    }
    for (const id of ["production-ready", "spine-promotion"]) {
      expect(byId.get(id)?.applicable, id).toBe(true);
      expect(byId.get(id)?.selectionReason, id).toContain(
        "packages/customer-health-core/src/libs/CustomerHealthScore.ts",
      );
    }
    expect(byId.get("generated-app-smoke")?.applicable).toBe(false);
    expect(byId.get("spine-promotion")?.command).toContain("customer-health-core");
  });

  it("selects fast-test owners through the complete transitive workspace dependency graph", () => {
    const command = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["packages/framework-config/src/libs/ConfigService.ts"],
      head: "HEAD",
    }).find(({ id }) => id === "test");

    expect(command?.command).toEqual(
      expect.arrayContaining([
        "--owner",
        "@croco/framework-config",
        "--owner",
        "@croco/framework-logger",
        "--owner",
        "@croco/auth-core",
        "--owner",
        "@croco/membership-core",
      ]),
    );
  });

  it("routes script implementation changes through the repo CI fast lane", () => {
    const command = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["scripts/package-quality-report.mts"],
      head: "HEAD",
    }).find(({ id }) => id === "test");

    expect(command).toMatchObject({ applicable: true });
    expect(command?.command).toEqual(
      expect.arrayContaining(["--lane", "fast", "--owner", "repo:ci"]),
    );
  });

  it.each([
    ["examples/example/src/index.ts", "repo:examples"],
    ["tests/root-contract.spec.ts", "repo:tests"],
  ])("routes %s through fast owner %s", (path, owner) => {
    const command = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: [path],
      head: "HEAD",
    }).find(({ id }) => id === "test");

    expect(command).toMatchObject({ applicable: true });
    expect(command?.command).toEqual(expect.arrayContaining(["--owner", owner]));
  });

  it("selects package accountability checks for scoped certified, spine, and catalog changes", () => {
    for (const path of [
      "packages/telemetry-api/src/index.ts",
      "packages/retry-core/src/index.ts",
      "docs/package-catalog.json",
    ]) {
      const byId = new Map(
        createVerificationManifest("spine", {
          base: "origin/trunk",
          changedFiles: [path],
          head: "HEAD",
        }).map((command) => [command.id, command]),
      );

      for (const id of ["production-ready", "spine-promotion"]) {
        expect(byId.get(id)?.applicable, `${id}: ${path}`).toBe(true);
        expect(byId.get(id)?.selectionReason, `${id}: ${path}`).toContain(path);
      }
      const isCatalog = path === "docs/package-catalog.json";
      expect(byId.get("build")?.command.includes("--filter=...[origin/trunk]"), path).toBe(
        !isCatalog,
      );
      expect(byId.get("typecheck")?.command.includes("--filter=...[origin/trunk]"), path).toBe(
        !isCatalog,
      );
      expect(byId.get("test")?.command).toEqual(
        expect.arrayContaining(["scripts/test-lane-runner.mts", "--lane", "fast"]),
      );
      const affectedGeneratedSmokeCases = selectGeneratedSmokeCasesForChangedFiles([path]);
      expect(byId.get("generated-app-smoke")?.applicable, path).toBe(
        isCatalog || affectedGeneratedSmokeCases.length > 0,
      );
      if (isCatalog) {
        expect(byId.get("generated-app-smoke")?.command, path).toContain("--tier");
        expect(byId.get("generated-app-smoke")?.command, path).toContain("spine-blocking");
      }
      if (!isCatalog) {
        expect(byId.get("spine-promotion")?.command, path).toContain(path.split("/")[1]);
      }
    }
  });

  it("keeps catalog accountability unscoped when package files change in the same range", () => {
    const byId = new Map(
      createVerificationManifest("spine", {
        base: "origin/trunk",
        changedFiles: ["docs/package-catalog.json", "packages/retry-core/src/index.ts"],
        head: "HEAD",
      }).map((command) => [command.id, command]),
    );

    expect(byId.get("build")?.command.some((argument) => argument.startsWith("--filter="))).toBe(
      false,
    );
    expect(byId.get("generated-app-smoke")?.applicable).toBe(true);
    expect(byId.get("spine-promotion")?.command).not.toContain("--package");
  });

  it("keeps targeted scaffold PR smoke and full non-PR spine coverage", () => {
    const scaffoldPullRequest = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["packages/create-croco-app/src/index.ts"],
      head: "HEAD",
    });
    const pullRequestById = new Map(scaffoldPullRequest.map((command) => [command.id, command]));
    const fullById = new Map(
      createVerificationManifest("spine").map((command) => [command.id, command]),
    );
    const journeyArtifact = (command: EvidenceCommand | undefined) =>
      command?.artifacts?.find(
        ({ path }) => path === "ci-reports/generated-apps/spine-blocking-journeys",
      );

    expect(pullRequestById.get("generated-app-smoke")?.applicable).toBe(true);
    expect(journeyArtifact(pullRequestById.get("generated-app-smoke"))?.required).toBe(true);
    expect(pullRequestById.get("integration-test-lane")?.applicable).toBe(true);
    expect(pullRequestById.get("cli-packed-e2e")?.applicable).toBe(true);
    expect(pullRequestById.get("alpha-release-smoke")?.applicable).toBe(false);
    expect(fullById.get("generated-app-smoke")?.applicable).toBe(true);
    expect(journeyArtifact(fullById.get("generated-app-smoke"))?.required).toBe(true);
    expect(fullById.get("alpha-release-smoke")?.applicable).toBe(true);
    expect(fullById.get("production-ready")?.applicable).toBe(true);
    expect(fullById.get("spine-promotion")?.applicable).toBe(true);
  });

  it("runs the full fast lane when package accountability needs complete task evidence", () => {
    const byId = new Map(
      createVerificationManifest("spine", {
        base: "origin/trunk",
        changedFiles: ["docs/package-catalog.json"],
        head: "HEAD",
      }).map((command) => [command.id, command]),
    );

    expect(byId.get("test")?.applicable).toBe(true);
    expect(byId.get("test")?.command).not.toContain("--owner");
    expect(byId.get("production-ready")?.applicable).toBe(true);
    expect(byId.get("production-ready")?.command).toContain("--fast-test-lane-report");
  });

  it("selects generated smoke cases through template runtime dependency closure", () => {
    assertGeneratedSmokeDependencyMapping();

    for (const packagePath of [
      "packages/protocols-rest/src/index.ts",
      "packages/transports-http/src/index.ts",
      "packages/telemetry-sdk-node/src/index.ts",
    ]) {
      const selectedCases = selectGeneratedSmokeCasesForChangedFiles([packagePath]);
      const manifest = createVerificationManifest("spine", {
        base: "origin/trunk",
        changedFiles: [packagePath],
        head: "HEAD",
      });
      const generatedSmoke = manifest.find(({ id }) => id === "generated-app-smoke");

      expect(selectedCases.length, packagePath).toBeGreaterThan(0);
      expect(selectedCases.length, packagePath).toBeLessThan(18);
      expect(generatedSmoke?.applicable, packagePath).toBe(true);
      expect(generatedSmoke?.command, packagePath).toEqual([
        "node",
        "--experimental-strip-types",
        "scripts/create-croco-app-generated-smoke.mts",
        ...selectedCases,
      ]);
      expect(
        generatedSmoke?.artifacts?.find(
          ({ path }) => path === "ci-reports/generated-apps/spine-blocking-journeys",
        )?.required,
        packagePath,
      ).toBe(false);
      expect(
        generatedSmoke?.artifacts?.filter(({ path }) => path.includes("spine-blocking-matrix")),
        packagePath,
      ).toHaveLength(2);
      expect(
        generatedSmoke?.artifacts
          ?.filter(({ path }) => path.includes("spine-blocking-matrix"))
          .every(({ required }) => required),
        packagePath,
      ).toBe(true);
    }
  });

  it("rejects unknown generated smoke case names", () => {
    expect(() => readGeneratedSmokeCaseDirectDependencies("unknown-smoke-case")).toThrow(
      "Unknown generated smoke case: unknown-smoke-case",
    );
  });

  it("passes the exact selected generated test paths to evidence reconciliation", () => {
    const manifest = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["packages/cache-core/src/index.ts"],
      head: "HEAD",
    });
    const reconcile = manifest.find(({ id }) => id === "test-evidence-reconcile");
    const requiredPaths = (reconcile?.command ?? []).flatMap((argument, index, command) =>
      argument === "--required-generated-path" && command[index + 1] ? [command[index + 1]] : [],
    );

    expect(requiredPaths.length).toBeGreaterThan(0);
    expect(requiredPaths).toContain(
      "packages/create-croco-app/templates/base-ddd/libs/shared/utils-env/src/tests/createEnv.spec.ts",
    );
    expect(requiredPaths).not.toContain(
      "packages/create-croco-app/templates/admin-console/apps/api-server/src/tests/AdminConsole.spec.ts",
    );
  });

  it("requires only executed tests for internal-tool and admin-console selections", () => {
    const paths = readTestInventory()
      .inventory.tests.filter(({ lane }) => lane === "generated-app")
      .map(({ path }) => path);
    const internal = selectGeneratedTestPathsForSmokeCases(["goal-internal-tool"], paths);
    const admin = selectGeneratedTestPathsForSmokeCases(["admin-console-starter"], paths);

    expect(internal).toHaveLength(4);
    expect(internal.some((path) => path.includes("/tests/journeys/"))).toBe(false);
    expect(admin).toEqual(
      [
        ...internal,
        "packages/create-croco-app/templates/admin-console/tests/journeys/plan-release.spec.ts",
      ].sort(),
    );
    expect(
      selectGeneratedTestPathsForSmokeCases(
        [
          "goal-saas-api",
          "goal-internal-tool",
          "admin-console-starter",
          "saas-golden-path",
          "saas-cloudflare-profile",
          "saas-lambda-profile",
          "ai-saas-golden-path",
        ],
        paths,
      ),
    ).toHaveLength(12);
    expect(selectGeneratedTestPathsForSmokeCases(["rest-spa-contracts"], paths)).toEqual([]);
    expect(() => selectGeneratedTestPathsForSmokeCases(["unknown-smoke-case"], paths)).toThrow(
      "Unknown generated smoke case: unknown-smoke-case",
    );
  });

  it("omits all generated materialization validation arguments for an empty selected path set", () => {
    const generatedInventoryPaths = readTestInventory()
      .inventory.tests.filter(({ lane }) => lane === "generated-app")
      .map(({ path }) => path);
    const blankBasicPaths = selectGeneratedTestPathsForSmokeCases(
      ["blank-basic"],
      generatedInventoryPaths,
    );

    expect(blankBasicPaths).toEqual([]);
    expect(generatedTestMaterializationArguments(blankBasicPaths)).toEqual([]);
    expect(
      generatedTestMaterializationArguments(["templates/example/src/tests/unit.spec.ts"]),
    ).toEqual([
      "--materialization-evidence",
      "ci-reports/generated-apps/materialization-evidence.json",
      "--generated-root",
      "ci-reports/generated-apps/materialized-tests",
      "--required-generated-path",
      "templates/example/src/tests/unit.spec.ts",
    ]);
  });

  it("requires every generated inventory path for publish evidence", () => {
    const manifest = createVerificationManifest("publish");
    const reconcile = manifest.find(({ id }) => id === "test-evidence-reconcile");
    const requiredPaths = (reconcile?.command ?? []).filter(
      (argument, index, command) => command[index - 1] === "--required-generated-path",
    );
    const generatedInventoryPaths = readTestInventory()
      .inventory.tests.filter(({ lane }) => lane === "generated-app")
      .map(({ path }) => path);

    expect(requiredPaths).toEqual(generatedInventoryPaths);
  });

  it("does not select generated smoke for an unrelated package change", () => {
    const changedFiles = ["packages/customer-health-core/src/libs/CustomerHealthScore.ts"];
    expect(selectGeneratedSmokeCasesForChangedFiles(changedFiles)).toEqual([]);
    expect(
      createVerificationManifest("spine", {
        base: "origin/trunk",
        changedFiles,
        head: "HEAD",
      }).find(({ id }) => id === "generated-app-smoke")?.applicable,
    ).toBe(false);
  });

  it("selects the exact generated case for a dynamically injected provider dependency", () => {
    expect(selectGeneratedSmokeCasesForChangedFiles(["packages/storage-r2/src/index.ts"])).toEqual([
      "saas-cloudflare-profile",
    ]);
    expect(
      selectGeneratedSmokeCasesForChangedFiles(["packages/auth-better-auth/src/index.ts"]),
    ).toEqual(["goal-saas-api", "saas-golden-path", "ai-saas-golden-path"]);
  });

  it("selects dynamically injected tenant and UI dependencies", () => {
    expect(
      selectGeneratedSmokeCasesForChangedFiles(["packages/tx-drizzle/src/index.ts"]),
    ).toContain("saas-golden-path");
    expect(selectGeneratedSmokeCasesForChangedFiles(["packages/ui-astryx/src/index.ts"])).toEqual([
      "graphql-vite-spa-astryx",
    ]);
    expect(
      selectGeneratedSmokeCasesForChangedFiles(["packages/dataloader-core/src/index.ts"]),
    ).toEqual([]);
  });

  it("materializes every generated smoke case independently of dependency selection", async () => {
    const generatedRoot = mkdtempSync(join(tmpdir(), "croco-smoke-dependency-contract-"));
    try {
      for (const smokeCase of getGeneratedSmokeDependencyCaseInputs()) {
        const projectDir = join(generatedRoot, smokeCase.name);
        const cliOptions = parseCliOptions(
          projectDir,
          parseGeneratedSmokeRawOptions(smokeCase.args),
        );
        await generate(projectDir, normalizeNonInteractiveOptions(cliOptions));
        assertGeneratedSmokeCaseDependencyMapping(smokeCase.name, projectDir);
        const generatedEntries = readTestInventory().inventory.tests.filter(
          ({ lane }) => lane === "generated-app",
        );
        const executedPaths = generatedEntries
          .filter((entry) => {
            const generatedPath = entry.generated?.generatedPath;
            if (!generatedPath || !existsSync(join(projectDir, generatedPath))) return false;
            return smokeCase.validations.some((validation) => {
              if (generatedPath.startsWith("tests/journeys/")) {
                return (
                  validation.label === "browser journeys" &&
                  (!validation.paths || validation.paths.includes(generatedPath))
                );
              }
              return (
                validation.label === "test" &&
                (!validation.packagePath ||
                  generatedPath.startsWith(`${validation.packagePath.join("/")}/`))
              );
            });
          })
          .map(({ path }) => path)
          .sort();
        expect(
          selectGeneratedTestPathsForSmokeCases(
            [smokeCase.name],
            generatedEntries.map(({ path }) => path),
          ),
          smokeCase.name,
        ).toEqual(executedPaths);
      }
    } finally {
      rmSync(generatedRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not require package build artifacts for repository-only CI maintenance", () => {
    const maintenance = createVerificationManifest("publish", {
      base: "origin/trunk",
      changedFiles: [
        ".github/workflows/ci.yml",
        "scripts/ci-performance-budget.mts",
        "scripts/tests/ci-workflow.spec.ts",
        "scripts/verification-manifest.mts",
      ],
      head: "HEAD",
    });
    const byId = new Map(maintenance.map((command) => [command.id, command]));

    for (const id of [
      "cli-packed-e2e",
      "first-success",
      "generated-app-smoke",
      "package-bins-smoke",
      "package-entrypoints-smoke",
      "production-ready",
      "quick-start-lambda-smoke",
      "spine-promotion",
    ]) {
      expect(byId.get(id)?.applicable, id).toBe(false);
    }
    expect(byId.get("production-ready")?.selectionReason).toBe(
      "Skipped because no package graph or package catalog input changed.",
    );
    expect(byId.get("spine-promotion")?.selectionReason).toBe(
      "Skipped because no package graph or package catalog input changed.",
    );
    expect(byId.get("build")?.command).not.toContain("--filter=...[origin/trunk]");
    expect(byId.get("typecheck")?.command).not.toContain("--filter=...[origin/trunk]");
    expect(byId.get("test")?.command).not.toContain("--filter=...[origin/trunk]");
    expect(byId.get("release-gate-tests")?.applicable).toBe(true);
  });

  it("distinguishes inventory integration and packed CLI selectors", () => {
    const cliChange = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["packages/cli/src/index.ts"],
      head: "HEAD",
    });
    const generatorChange = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["packages/create-croco-app/src/index.ts"],
      head: "HEAD",
    });

    expect(cliChange.find(({ id }) => id === "integration-test-lane")).toMatchObject({
      applicable: true,
      command: expect.arrayContaining(["--lane", "integration", "--owner", "@croco/cli"]),
      label: "Inventory integration test lane",
    });
    expect(cliChange.find(({ id }) => id === "cli-packed-e2e")?.applicable).toBe(false);
    expect(generatorChange.find(({ id }) => id === "integration-test-lane")).toMatchObject({
      applicable: true,
      command: expect.arrayContaining(["--lane", "integration", "--owner", "create-croco-app"]),
    });
    expect(generatorChange.find(({ id }) => id === "cli-packed-e2e")).toMatchObject({
      applicable: true,
      command: expect.arrayContaining(["src/tests/integration/CliCommandIntegration.spec.ts"]),
      label: "Packed installed CLI integration tests",
    });
  });

  it("selects integration owners that depend on a changed package for tests", () => {
    const manifest = createVerificationManifest("spine", {
      base: "origin/trunk",
      changedFiles: ["packages/execution-core/src/index.ts"],
      head: "HEAD",
    });
    expect(manifest.find(({ id }) => id === "integration-test-lane")?.command).toEqual(
      expect.arrayContaining(["--owner", "@croco/cli"]),
    );
  });

  it("routes every CLI integration spec through the authoritative inventory lane", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "packages/cli/package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    const integrationFiles = readdirSync(resolve(ROOT_DIR, "packages/cli/src/tests/integration"))
      .filter((path) => path.endsWith(".spec.ts"))
      .sort();

    expect(packageJson.scripts?.["test:e2e"]).toBe("vitest run src/tests/integration");
    expect(integrationFiles).toContain("jobs-e2e.spec.ts");
    expect(
      createVerificationManifest("spine", {
        base: "origin/trunk",
        changedFiles: ["packages/cli/src/jobs.ts"],
        head: "HEAD",
      }).find(({ id }) => id === "integration-test-lane")?.command,
    ).toEqual(expect.arrayContaining(["--lane", "integration", "--owner", "@croco/cli"]));
  });

  it("uses full evidence only for root accountability changes", () => {
    for (const path of [
      "pnpm-lock.yaml",
      "packages/create-croco-app/src/index.ts",
      "packages/cli/src/index.ts",
    ]) {
      const manifest = createVerificationManifest("publish", {
        base: "origin/trunk",
        changedFiles: [path],
        head: "HEAD",
      });
      const build = manifest.find(({ id }) => id === "build");

      expect(build?.command.includes("--filter=...[origin/trunk]"), path).toBe(false);
      expect(
        manifest.findIndex(({ id }) => id === "build"),
        path,
      ).toBeLessThan(manifest.findIndex(({ id }) => id === "generated-app-smoke"));
    }
  });

  it("builds every package binary before a scoped package-accountability binary smoke", () => {
    const binPackages = findPackageJsonFiles(resolve(ROOT_DIR, "packages"))
      .map((packagePath) => {
        const sourcePkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
          readonly name?: string;
          readonly private?: boolean;
          readonly publishConfig?: Record<string, unknown>;
        };
        const publishManifest = effectivePublishManifest(sourcePkg) as {
          readonly bin?: unknown;
        };
        return {
          bin: publishManifest.bin,
          name: sourcePkg.name,
          packagePath,
          private: sourcePkg.private,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          readonly bin: unknown;
          readonly name: string;
          readonly packagePath: string;
          readonly private?: boolean;
        } => entry.private !== true && entry.bin !== undefined && typeof entry.name === "string",
      );
    const expectedBinFilters = binPackages.map(({ name }) => `--filter=${name}`).sort();
    for (const { packagePath } of binPackages) {
      const manifest = createVerificationManifest("publish", {
        base: "origin/trunk",
        changedFiles: [`${relative(ROOT_DIR, dirname(packagePath))}/src/index.ts`],
        head: "HEAD",
      });
      const packageBuildFilters = [
        ...new Set(
          manifest
            .find(({ id }) => id === "build")
            ?.command.filter(
              (argument) =>
                argument.startsWith("--filter=") &&
                argument !== "--filter=...[origin/trunk]" &&
                argument !== "--filter=!@croco/docs",
            ),
        ),
      ].sort();

      expect(packageBuildFilters).toEqual(expectedBinFilters);
      expect(manifest.find(({ id }) => id === "package-bins-smoke")?.applicable).toBe(true);
    }
  });

  it("keeps the release-gate inventory complete, sorted, and executable from one root alias", () => {
    const command = createVerificationManifest("publish").find(
      ({ id }) => id === "release-gate-tests",
    );
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(RELEASE_GATE_TEST_PATHS).toHaveLength(52);
    expect(RELEASE_GATE_TEST_PATHS).toEqual([...RELEASE_GATE_TEST_PATHS].sort());
    expect(RELEASE_GATE_ENTRYPOINT_PATHS).toEqual([...RELEASE_GATE_ENTRYPOINT_PATHS].sort());
    expect(RELEASE_GATE_FIXTURE_PATHS).toEqual([...RELEASE_GATE_FIXTURE_PATHS].sort());
    expect(RELEASE_GATE_SUPPORT_PATHS).toEqual([...RELEASE_GATE_SUPPORT_PATHS].sort());
    expect(RELEASE_GATE_POLICY_INPUT_PATHS).toEqual([...RELEASE_GATE_POLICY_INPUT_PATHS].sort());
    expect(RELEASE_GATE_WORKFLOW_PATHS).toEqual([...RELEASE_GATE_WORKFLOW_PATHS].sort());
    expect(RELEASE_GATE_ENTRYPOINT_PATHS).toEqual(verificationImplementationPaths());
    expect(new Set(RELEASE_GATE_MAINTENANCE_PATHS).size).toBe(
      RELEASE_GATE_MAINTENANCE_PATHS.length,
    );
    expect(RELEASE_GATE_MAINTENANCE_PATHS).toContain("scripts/release-gate-maintenance.mts");
    expect(command?.command).toEqual([
      "node",
      "--experimental-strip-types",
      "scripts/test-lane-evidence-check.mts",
      "--report",
      "ci-reports/package-quality/fast-test-lane.json",
      "--lane",
      "fast",
      ...RELEASE_GATE_TEST_PATHS.flatMap((path) => ["--path", path]),
    ]);
    expect(command?.applicable).toBe(true);
    expect(command?.command).toContain("scripts/tests/turbo-task-contract.spec.ts");
    expect(packageJson.scripts?.["test:release-gates"]).toBe(
      "node --experimental-strip-types scripts/verification-command.mts --id release-gate-tests",
    );
    for (const path of RELEASE_GATE_MAINTENANCE_PATHS) {
      expect(existsSync(resolve(ROOT_DIR, path)), path).toBe(true);
    }
    for (const workflowPath of RELEASE_GATE_WORKFLOW_PATHS) {
      const workflowContractPath = `scripts/tests/${basename(workflowPath, ".yml")}-workflow.spec.ts`;
      expect(RELEASE_GATE_TEST_PATHS, workflowContractPath).toContain(workflowContractPath);
    }

    const discoveredScriptPaths = discoverReleaseGateScriptPaths([
      ...RELEASE_GATE_ENTRYPOINT_PATHS,
      ...RELEASE_GATE_TEST_PATHS,
      "scripts/release-gate-maintenance.mts",
    ]);
    expect(RELEASE_GATE_MAINTENANCE_PATHS).toEqual(expect.arrayContaining(discoveredScriptPaths));
    expect(RELEASE_GATE_IMPLEMENTATION_PATHS).toEqual(
      expect.arrayContaining(discoveredScriptPaths.filter((path) => !path.includes("/tests/"))),
    );

    const matchingImplementationSpecs = discoveredScriptPaths
      .filter((path) => /^scripts\/[^/]+\.(?:mts|mjs|ts)$/.test(path))
      .map(
        (implementationPath) =>
          `scripts/tests/${basename(implementationPath).replace(/\.(?:mts|mjs|ts)$/, ".spec.ts")}`,
      )
      .filter((testPath) => existsSync(testPath));
    expect(RELEASE_GATE_TEST_PATHS).toEqual(
      expect.arrayContaining([...new Set(matchingImplementationSpecs)]),
    );
  });

  it("runs publish package gates only for their relevant changed inputs", () => {
    const maintenance = createVerificationManifest("publish", {
      base: "origin/trunk",
      changedFiles: [
        ".changeset/README.md",
        "packages/retry-core/tests/RetryTemplate.spec.ts",
        "scripts/verification-manifest.mts",
      ],
      head: "HEAD",
    });
    expect(maintenance.find(({ id }) => id === "release-metadata")?.applicable).toBe(false);
    expect(maintenance.find(({ id }) => id === "spine-bundle-size")?.applicable).toBe(false);

    for (const path of [
      ".changeset/config.json",
      "ci-reports/bundle-size/baseline.json",
      "docs/package-catalog.json",
    ]) {
      const directInput = createVerificationManifest("publish", {
        base: "origin/trunk",
        changedFiles: [path],
        head: "HEAD",
      });
      expect(directInput.find(({ id }) => id === "release-gate-tests")?.applicable).toBe(true);
      expect(directInput.find(({ id }) => id === "spine-bundle-size")?.applicable).toBe(true);
    }

    const verifierChanges = createVerificationManifest("publish", {
      base: "origin/trunk",
      changedFiles: ["scripts/release-metadata-check.mts", "scripts/package-quality-report.mts"],
      head: "HEAD",
    });
    expect(verifierChanges.find(({ id }) => id === "release-metadata")?.applicable).toBe(true);
    expect(verifierChanges.find(({ id }) => id === "spine-bundle-size")?.applicable).toBe(true);

    const packageChange = createVerificationManifest("publish", {
      base: "origin/trunk",
      changedFiles: [".changeset/example.md", "packages/retry-core/src/index.ts"],
      head: "HEAD",
    });
    expect(packageChange.find(({ id }) => id === "release-metadata")?.applicable).toBe(true);
    expect(packageChange.find(({ id }) => id === "spine-bundle-size")?.applicable).toBe(true);
    expect(packageChange.find(({ id }) => id === "release-metadata")?.command).not.toContain(
      "--allow-pending-changesets",
    );

    const pullRequestPackageChange = createVerificationManifest("publish", {
      allowPendingReleaseMetadata: true,
      base: "origin/trunk",
      changedFiles: [".changeset/example.md"],
      head: "HEAD",
    });
    expect(pullRequestPackageChange.find(({ id }) => id === "release-metadata")?.command).toContain(
      "--allow-pending-changesets",
    );
  });

  it("makes the changeset gate contextual", () => {
    expect(
      createVerificationManifest("repo").find(({ id }) => id === "changeset-required")?.applicable,
    ).toBe(false);
    const contextual = createVerificationManifest("repo", {
      base: "origin/trunk",
      head: "HEAD",
    }).find(({ id }) => id === "changeset-required");
    expect(contextual?.applicable).toBe(true);
    expect(contextual?.command).toContain("origin/trunk");
  });

  it("runs root workflow and manifest contract tests inside every profile", () => {
    const command = createVerificationManifest("repo").find(
      ({ id }) => id === "verification-contract-tests",
    );

    expect(command?.command).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "scripts/tests/verification-command.spec.ts",
      "scripts/tests/verification-change-classifier.spec.ts",
      "scripts/tests/verification-manifest.spec.ts",
      "scripts/tests/release-spine-evidence.spec.ts",
      "scripts/tests/ci-workflow.spec.ts",
      "scripts/tests/ci-performance-budget.spec.ts",
      "scripts/tests/release-workflow.spec.ts",
      "scripts/tests/turbo-task-contract.spec.ts",
      "scripts/tests/branch-protection-policy.spec.ts",
      "scripts/tests/repository-policy-audit-workflow.spec.ts",
      "scripts/tests/verification-policy.spec.ts",
      "scripts/tests/test-inventory.spec.ts",
      "scripts/tests/test-lane-runner.spec.ts",
      "scripts/tests/turbo-cache-contract.spec.ts",
    ]);
  });

  it("builds verification runtime prerequisites through the mutation guard", () => {
    const command = createVerificationManifest("repo").find(
      ({ id }) => id === "architecture-policy-runtime",
    );

    expect(command?.command).toEqual([
      "node",
      "--experimental-strip-types",
      "scripts/tracked-file-mutation-guard.mts",
      "--recovery",
      "Fix the verification runtime build prerequisites",
      "--",
      "pnpm",
      "--filter",
      "@croco/architecture-policy...",
      "--filter",
      "@croco/tenant-core...",
      "build",
    ]);
  });

  it("rejects duplicate IDs and composite root aliases", () => {
    const command = createVerificationManifest("repo").find(
      ({ id }) => id === "package-manifests",
    ) as EvidenceCommand;
    expect(() => assertVerificationManifest([command, command])).toThrow(
      "Duplicate verification command ID",
    );
    expect(() =>
      assertVerificationManifest([{ ...command, id: "wrapper", command: ["pnpm", "check"] }]),
    ).toThrow("Composite root alias");
  });

  it("gates publish builds on release metadata without changing ordinary profiles", () => {
    expect(
      createVerificationManifest("publish").find(({ id }) => id === "build")?.dependsOn,
    ).toEqual(["architecture-policy-runtime", "release-metadata"]);
    for (const profile of ["repo", "spine"] as const) {
      for (const command of createVerificationManifest(profile)) {
        expect(command.dependsOn ?? []).not.toContain("release-metadata");
      }
    }
    expect(
      createVerificationLaneManifest("publish", "core-verification").physicalLocalPrerequisites.map(
        ({ id }) => id,
      ),
    ).toEqual(["release-metadata"]);
  });

  it("rejects invalid scheduling metadata", () => {
    const command = createVerificationManifest("repo").find(
      ({ id }) => id === "package-manifests",
    ) as EvidenceCommand;
    expect(() => assertVerificationManifest([{ ...command, dependsOn: ["missing"] }])).toThrow(
      "depends on unknown command missing",
    );
    expect(() => assertVerificationManifest([{ ...command, dependsOn: [command.id] }])).toThrow(
      "cannot depend on itself",
    );
    expect(() =>
      assertVerificationManifest([
        { ...command, id: "left", dependsOn: ["right"] },
        { ...command, id: "right", dependsOn: ["left"] },
      ]),
    ).toThrow("dependency graph contains a cycle");
    expect(() => assertVerificationManifest([{ ...command, concurrencyGroups: [" "] }])).toThrow(
      "empty concurrency group",
    );
    expect(() =>
      assertVerificationManifest([{ ...command, concurrencyGroups: ["same", "same"] }]),
    ).toThrow("duplicate concurrency group");
  });

  it("declares artifact and status prerequisites semantically", () => {
    const byId = new Map(
      createVerificationManifest("publish").map((command) => [command.id, command]),
    );
    const expectedDependencies: Readonly<Record<string, readonly string[]>> = {
      "architecture-policy": ["architecture-policy-runtime"],
      "benchmark-thresholds": ["verification-contract-tests"],
      build: ["architecture-policy-runtime"],
      "package-entrypoints-smoke": ["build", "typecheck", "generated-app-smoke"],
      "package-bins-smoke": ["build"],
      "generated-app-smoke": ["build"],
      "alpha-release-smoke": ["build"],
      "integration-test-lane": ["build"],
      "published-test-lane": ["build"],
      "test-evidence-reconcile": [
        "test",
        "integration-test-lane",
        "published-test-lane",
        "generated-app-smoke",
      ],
      "cli-packed-e2e": ["integration-test-lane"],
      typecheck: ["build"],
      test: ["build", "typecheck"],
      "production-ready": ["build", "typecheck", "test"],
      "spine-promotion": [
        "test",
        "generated-app-smoke",
        "provider-certification",
        "production-ready",
      ],
      "core-coverage-warning": ["core-coverage"],
      "core-coverage": ["build"],
      "release-gate-tests": ["test"],
      "publish-dry-run": ["build"],
    };
    for (const [id, dependencies] of Object.entries(expectedDependencies)) {
      expect(byId.get(id)?.dependsOn).toEqual(expect.arrayContaining(dependencies));
    }
    expect(byId.get("production-ready")?.command).toEqual(
      expect.arrayContaining([
        "--require-task-summaries",
        "--fast-test-lane-report",
        "ci-reports/package-quality/fast-test-lane.json",
      ]),
    );
    expect(byId.get("spine-bundle-size")?.dependsOn).toEqual(
      expect.arrayContaining([
        "changeset-required",
        "lint",
        "format",
        "build",
        "typecheck",
        "test",
        "provider-certification",
        "production-ready",
        "spine-promotion",
      ]),
    );
    for (const id of [
      "package-bins-smoke",
      "test",
      "generated-app-smoke",
      "alpha-release-smoke",
      "integration-test-lane",
      "published-test-lane",
      "cli-packed-e2e",
      "core-coverage",
      "publish-dry-run",
    ]) {
      expect(byId.get(id)?.concurrencyGroups).toContain("workspace-artifacts");
    }
    expect(byId.get("test")?.concurrencyGroups).toEqual([
      "workspace-artifacts",
      "test-integration",
    ]);
    expect(byId.get("published-test-lane")?.concurrencyGroups).toEqual([
      "workspace-artifacts",
      "package-entrypoints",
      "test-integration",
    ]);
    expect(byId.get("core-coverage")?.concurrencyGroups).toEqual([
      "workspace-artifacts",
      "test-integration",
    ]);
    expect(byId.get("typecheck")?.concurrencyGroups).toEqual(["workspace-artifacts"]);
    expect(byId.get("package-entrypoints-smoke")?.concurrencyGroups).toEqual([
      "package-entrypoints",
    ]);
    expect(byId.get("integration-test-lane")?.concurrencyGroups).toEqual([
      "workspace-artifacts",
      "package-entrypoints",
      "test-integration",
    ]);
    expect(byId.get("release-gate-tests")?.concurrencyGroups).toBeUndefined();
    expect(byId.get("typecheck")?.command).not.toContain("--only");
    expect(byId.get("package-entrypoints-smoke")?.timeoutMs).toBe(15 * 60 * 1_000);
  });

  it("routes compatibility aliases through authoritative profiles", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.check).toBe("pnpm verify:repo");
    expect(packageJson.scripts?.["audit:read-only"]).toBe("pnpm verify:repo");
    expect(packageJson.scripts?.["verification-policy:check"]).toContain(
      "scripts/verification-command.mts --id verification-policy",
    );
  });

  it("guards every mutation-prone repository command at its manifest definition", () => {
    const guardedIds = new Set([
      "verification-policy",
      "changeset-required",
      "package-manifests",
      "docs-catalog",
      "docs-api-triggers",
      "problem-registry",
      "docs-examples",
      "release-docs",
      "ci-executables",
      "architecture-policy-runtime",
      "architecture-policy",
      "architecture-circular-allowlist",
      "dependency-boundaries",
      "security-allowlists",
      "generated-secret-placeholders",
      "compiler-baseline",
      "strict-contract-typecheck",
      "static-misuse",
      "architecture-circular",
      "benchmark-thresholds",
    ]);

    for (const command of createVerificationManifest("repo")) {
      if (!guardedIds.has(command.id)) continue;
      expect(command.command).toContain("scripts/tracked-file-mutation-guard.mts");
      expect(command.command).toContain("--recovery");
      expect(command.command).toContain("--");
    }
  });
});
