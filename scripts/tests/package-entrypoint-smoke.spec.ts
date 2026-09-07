import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const scriptPath = resolve(__dirname, "../package-entrypoint-smoke.mts");
const scriptTestTimeout = 60_000;
const spawnTimeoutMs = 180_000;
const tempRoots: string[] = [];

vi.setConfig({ testTimeout: scriptTestTimeout });

type ScriptResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
};

type TempRootOptions = {
  readonly catalog?: Record<string, string>;
  readonly packageManager?: string | false;
};

describe("package-entrypoint-smoke.mts", () => {
  afterAll(() => {
    vi.resetConfig();
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("checks valid importable packages and skips the private docs site", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "valid");
    writeDocsPackage(root);

    const result = runScript(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "package-entrypoint-smoke: @croco/valid packed tarball installed with node-linker=isolated",
    );
    expect(result.stdout).toContain("✓ @croco/valid: esm 1, cjs 1, types 1");
    expect(result.stdout).toContain("summary checked=1 exempt=0 skippedPrivate=1");
  });

  it("rejects packed exports whose types condition is not first", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "misordered", {
      exportsValue: {
        ".": {
          import: "./dist/index.mjs",
          require: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
      },
    });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '@croco/misordered: packed exports["."] conditions must be ordered types, import, require',
    );
  });

  it("resolves the import declaration from a mode-specific types condition", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "mode-specific-types", {
      exportsValue: {
        ".": {
          types: {
            import: "./dist/index.d.mts",
            require: "./dist/index.d.ts",
          },
          import: "./dist/index.mjs",
          require: "./dist/index.js",
        },
      },
    });

    const result = runScript(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("✓ @croco/mode-specific-types: esm 1, cjs 1, types 1");
  });

  it("validates CSS exports as static assets without loading them in Node", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "styled", {
      exportsValue: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.mjs",
          require: "./dist/index.js",
        },
        "./styles.css": "./dist/styles.css",
        "./conditional-styles": {
          types: "./dist/index.d.ts",
          import: "./dist/styles.css",
          require: "./dist/styles.css",
        },
      },
    });
    writeFileSync(join(root, "packages", "styled", "dist", "styles.css"), ".root {}\n");

    const result = runScript(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ @croco/styled: esm 1, cjs 1, types 2");
  });

  it("reads packed runtime entrypoints larger than the Node default output buffer", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "large-entrypoint", {
      cjsContent: `exports.padding = "${"a".repeat(2 * 1024 * 1024)}";\nexports.value = "ok";\n`,
    });

    const result = runScript(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("✓ @croco/large-entrypoint: esm 1, cjs 1, types 1");
  });

  it("requires the root package manager pin for isolated consumers", () => {
    const root = createTempRoot({ packageManager: false });
    writeImportablePackage(root, "valid");

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "packageManager must pin the pnpm version",
    );
  });

  it("rejects an unbounded catalog peer after pnpm resolves the packed manifest", () => {
    const root = createTempRoot({ catalog: { unsafePeer: "*" } });
    writeImportablePackage(root, "unsafe-catalog-peer", {
      peerDependencies: { unsafePeer: "catalog:" },
    });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      '@croco/unsafe-catalog-peer: packed peerDependencies.unsafePeer must use a bounded semver range, not "*"',
    );
  });

  it("rejects a public docs site package without an entrypoint exemption", () => {
    const root = createTempRoot();
    writePublicDocsPackage(root);

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "packages/docs/package.json: public package without src/index.ts needs an explicit entrypoint exemption",
    );
  });

  it("fails early when package build artifacts are absent", () => {
    const root = createTempRoot();
    writeUnbuiltPackage(root, "unbuilt");

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Package entrypoint smoke build prerequisite failed:");
    expect(result.stdout).toContain("1 public package(s) are missing build artifacts under dist.");
    expect(result.stdout).toContain("Run pnpm build before pnpm package-entrypoints:smoke.");
    expect(result.stdout).toContain("@croco/unbuilt (packages/unbuilt/dist)");
    expect(result.stdout).toContain(
      '@croco/unbuilt: exports["."].types points to missing file ./dist/index.d.ts',
    );
    expect(result.stdout).not.toContain("no ESM import target found");
  });

  it("fails early when a required build artifact is absent from a non-empty dist directory", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "partial-build");
    rmSync(join(root, "packages", "partial-build", "dist", "index.js"));

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Package entrypoint smoke build prerequisite failed:");
    expect(result.stdout).toContain("@croco/partial-build (packages/partial-build/dist)");
    expect(result.stdout).toContain(
      "@croco/partial-build: main points to missing file ./dist/index.js",
    );
  });

  it("fails early when a declaration artifact is absent from an otherwise complete dist directory", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "partial-types");
    rmSync(join(root, "packages", "partial-types", "dist", "index.d.ts"));

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Package entrypoint smoke build prerequisite failed:");
    expect(result.stdout).toContain("@croco/partial-types (packages/partial-types/dist)");
    expect(result.stdout).toContain(
      '@croco/partial-types: exports["."].types points to missing file ./dist/index.d.ts',
    );
  });

  it("checks source entrypoints when publishConfig only contains publish metadata", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "source-entrypoints", {
      publishConfig: { access: "public" },
      sourceMain: "./dist/index.js",
      sourceTypes: "./dist/index.d.ts",
    });
    rmSync(join(root, "packages", "source-entrypoints", "dist", "index.js"));

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Package entrypoint smoke build prerequisite failed:");
    expect(result.stdout).toContain(
      "@croco/source-entrypoints: main points to missing file ./dist/index.js",
    );
  });

  it("fails when an export map points at a missing runtime entrypoint", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "invalid-export", {
      importTarget: "./dist/missing.mjs",
    });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '@croco/invalid-export: exports["."].import points to missing file ./dist/missing.mjs',
    );
  });

  it("fails when an export map has an invalid shape", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "invalid-export-map", {
      exportsValue: [],
    });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "@croco/invalid-export-map: exports must be a string or object",
    );
  });

  it("fails when a declaration target is missing", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "missing-types", {
      typesTarget: "./dist/missing.d.ts",
    });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '@croco/missing-types: exports["."].types points to missing file ./dist/missing.d.ts',
    );
  });

  it("reports direct-dist root and publishConfig face mismatches", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "telemetry-api");

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("@croco/telemetry-api: main must match publishConfig.main");
    expect(result.stdout).toContain("@croco/telemetry-api: types must match publishConfig.types");
    expect(result.stdout).toContain(
      "@croco/telemetry-api: exports must match publishConfig.exports",
    );
  });

  it("fails when a runtime entrypoint imports an undeclared dependency", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "hidden-helper");
    writeImportablePackage(root, "hidden-owner", {
      cjsContent: 'exports.value = require("@croco/hidden-helper").value;\n',
      dependencies: {
        "@croco/hidden-helper": "0.0.0",
      },
      declarationContent:
        'export type { Value } from "@croco/hidden-helper";\nexport declare const value: string;\n',
      esmContent: 'export { value } from "@croco/hidden-helper";\n',
    });
    writeImportablePackage(root, "missing-runtime-dependency", {
      cjsContent: 'exports.value = require("@croco/hidden-helper").value;\n',
      dependencies: {
        "@croco/hidden-owner": "0.0.0",
      },
      esmContent: 'export { value } from "@croco/hidden-helper";\n',
    });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("@croco/hidden-helper");
  });

  it("installs transitive internal dependencies from packed tarball overrides", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "runtime-helper", {
      declarationContent: "export type Value = string;\nexport declare const value: string;\n",
    });
    writeImportablePackage(root, "runtime-bridge", {
      cjsContent: 'exports.value = require("@croco/runtime-helper").value;\n',
      dependencies: {
        "@croco/runtime-helper": "0.0.0",
      },
      declarationContent: 'export type { Value } from "@croco/runtime-helper";\n',
      esmContent: 'export { value } from "@croco/runtime-helper";\n',
    });
    writeImportablePackage(root, "uses-runtime-bridge", {
      cjsContent: 'exports.value = require("@croco/runtime-bridge").value;\n',
      dependencies: {
        "@croco/runtime-bridge": "0.0.0",
      },
      declarationContent: 'export type { Value } from "@croco/runtime-bridge";\n',
      esmContent: 'export { value } from "@croco/runtime-bridge";\n',
    });

    const result = runScript(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "package-entrypoint-smoke: @croco/uses-runtime-bridge packed tarball installed with node-linker=isolated",
    );
    expect(result.stdout).toContain("summary checked=3 exempt=0 skippedPrivate=0");
  });

  it("constructs the packed framework logger in development and production", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "framework-logger", {
      cjsContent: "class Logger {}\nexports.Logger = Logger;\n",
      declarationContent: "export declare class Logger { constructor(config: unknown); }\n",
      esmContent:
        'export class Logger { constructor(config) { if (config.isProduction !== (process.env.NODE_ENV === "production")) throw new Error("environment mismatch"); } }\n',
      packageName: "@croco/framework-logger",
    });

    const result = runScript(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("framework logger development startup ok");
    expect(result.stdout).toContain("framework logger production startup ok");
  });

  it("proves pure imports, decorator metadata, and UI CSS behavior in packed bundles", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "problems-core", {
      esmContent: 'globalThis.__crocoPureImportRetained = true;\nexport const value = "ok";\n',
      packageName: "@croco/problems-core",
      sideEffects: false,
      sourceExports: defaultPublishExports(),
      sourceMain: "./dist/index.js",
      sourceTypes: "./dist/index.d.ts",
    });
    writeImportablePackage(root, "audit-core", {
      declarationContent:
        "export declare const AUDIT_PARAM_KEY: symbol;\nexport declare function Auditable(options: { resourceIdIndex?: number }): MethodDecorator;\n",
      esmContent: decoratorBundleFixtureSource(),
      packageName: "@croco/audit-core",
      sideEffects: ["./dist/index.js", "./dist/index.mjs"],
    });
    writeImportablePackage(root, "ui-astryx", {
      exportsValue: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.mjs",
          require: "./dist/index.js",
        },
        "./styles.css": "./dist/styles.css",
      },
      packageName: "@croco/ui-astryx",
      sideEffects: ["./dist/styles.css"],
    });
    writeFileSync(
      join(root, "packages", "ui-astryx", "dist", "styles.css"),
      '@import "./theme.css";\n',
    );
    writeFileSync(
      join(root, "packages", "ui-astryx", "dist", "theme.css"),
      ".croco-bundle-smoke { color: green; }\n",
    );

    const result = runScript(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("bundle tree-shaking ok @croco/problems-core");
    expect(result.stdout).toContain("bundle metadata initialization ok @croco/audit-core");
    expect(result.stdout).toContain("bundle decorator metadata ok @croco/audit-core");
    expect(result.stdout).toContain("bundle css retained @croco/ui-astryx/styles.css");
  });

  it("fails bundle smoke when a pure package import cannot be removed", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "problems-core", {
      esmContent: 'globalThis.__crocoPureImportRetained = true;\nexport const value = "ok";\n',
      packageName: "@croco/problems-core",
      sideEffects: ["./dist/index.js", "./dist/index.mjs"],
      sourceExports: defaultPublishExports(),
      sourceMain: "./dist/index.js",
      sourceTypes: "./dist/index.d.ts",
    });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "@croco/problems-core: unused pure package import contributed",
    );
  });

  it("fails bundle smoke when metadata initialization is declared side-effect free", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "audit-core", {
      declarationContent:
        "export declare const AUDIT_PARAM_KEY: symbol;\nexport declare function Auditable(options: { resourceIdIndex?: number }): MethodDecorator;\n",
      esmContent: decoratorBundleFixtureSource(),
      packageName: "@croco/audit-core",
      sideEffects: false,
    });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "bundled metadata initialization was not retained",
    );
  });

  it("fails bundle smoke when the packed UI stylesheet has no retained content", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "ui-astryx", {
      exportsValue: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.mjs",
          require: "./dist/index.js",
        },
        "./styles.css": "./dist/styles.css",
      },
      packageName: "@croco/ui-astryx",
      sideEffects: ["./dist/styles.css"],
    });
    writeFileSync(join(root, "packages", "ui-astryx", "dist", "styles.css"), "");

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "@croco/ui-astryx: bundled CSS entrypoint was not retained",
    );
  });

  it(
    "verifies packed ESM and CJS decorator metadata with implicit DI",
    () => {
      const root = createTempRoot();
      writeDecoratorMetadataPackages(root);

      const result = runScript(root);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain(
        "cjs decorator metadata and implicit DI ok @croco/auth-better-auth",
      );
      expect(result.stdout).toContain(
        "esm decorator metadata and implicit DI ok @croco/auth-better-auth",
      );
      expect(result.stdout).toContain(
        "cjs decorator metadata and implicit DI ok @croco/features-posthog",
      );
      expect(result.stdout).toContain(
        "esm decorator metadata and implicit DI ok @croco/features-posthog",
      );
      expect(result.stdout).toContain(
        "cjs decorator metadata and implicit DI ok @croco/metering-core",
      );
      expect(result.stdout).toContain(
        "esm decorator metadata and implicit DI ok @croco/metering-core",
      );
    },
    scriptTestTimeout,
  );

  it("fails when the packed auth service loses concrete constructor metadata", () => {
    const root = createTempRoot();
    writeDecoratorMetadataPackages(root, { missingAuthMetadata: true });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "BetterAuthProvider design:paramtypes expected [BetterAuthFactory, Object], received [missing]",
    );
  });

  it("rejects a packed auth provider that requires an options dependency", () => {
    const root = createTempRoot();
    writeDecoratorMetadataPackages(root, { requiredAuthOptions: true });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "BetterAuthProvider expected constructor arity 1, received 2",
    );
  });

  it(
    "fails when the packed feature service loses concrete constructor metadata",
    () => {
      const root = createTempRoot();
      writeDecoratorMetadataPackages(root, { missingFeatureMetadata: true });

      const result = runScript(root);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "PostHogFeatureManager design:paramtypes expected [PostHogClient], received [missing]",
      );
    },
    scriptTestTimeout,
  );

  it(
    "fails when a packed decorated method loses design:type metadata",
    () => {
      const root = createTempRoot();
      writeDecoratorMetadataPackages(root, { missingMemberMetadata: true });

      const result = runScript(root);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "LlmService.generate design:type expected Function, received missing",
      );
    },
    scriptTestTimeout,
  );

  it(
    "fails when the packed container injects trailing metadata instead of preserving defaults",
    () => {
      const root = createTempRoot();
      writeDecoratorMetadataPackages(root, { brokenDefaultResolution: true });

      const result = runScript(root);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "Container.get(MeterRegistry) expected default cacheTtlMs=60000",
      );
    },
    scriptTestTimeout,
  );

  it("matches packed tarballs by manifest name when package names share a prefix", () => {
    const root = createTempRoot();
    const prefixedExport = {
      types: "./dist/index.d.ts",
      import: "./dist/index.mjs",
      require: "./dist/index.js",
    };
    writeImportablePackage(root, "aaa-prefix-extra", {
      exportsValue: {
        ".": prefixedExport,
        "./extra": {
          types: "./dist/extra.d.ts",
          import: "./dist/extra.mjs",
          require: "./dist/extra.js",
        },
      },
      packageName: "@croco/prefix-extra",
    });
    writeFileSync(
      join(root, "packages", "aaa-prefix-extra", "dist", "extra.js"),
      'exports.extra = "ok";\n',
    );
    writeFileSync(
      join(root, "packages", "aaa-prefix-extra", "dist", "extra.mjs"),
      'export const extra = "ok";\n',
    );
    writeFileSync(
      join(root, "packages", "aaa-prefix-extra", "dist", "extra.d.ts"),
      "export declare const extra: string;\n",
    );
    writeImportablePackage(root, "zzz-prefix", {
      packageName: "@croco/prefix",
    });

    const result = runScript(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ @croco/prefix-extra: esm 2, cjs 2, types 2");
    expect(result.stdout).toContain("✓ @croco/prefix: esm 1, cjs 1, types 1");
  });

  it("reads packed entrypoints larger than the child process output buffer", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "large-entrypoint", {
      cjsContent: `exports.value = "${"x".repeat(1_100_000)}";\n`,
    });

    const result = runScript(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ @croco/large-entrypoint: esm 1, cjs 1, types 1");
  });

  it("does not resolve dependencies from package-local node_modules", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "package-local-dependency", {
      cjsContent: 'require("package-local-only");\nexports.value = "ok";\n',
      dependencies: {
        "package-local-only": "1.0.0",
      },
      esmContent: 'import "package-local-only";\nexport const value = "ok";\n',
    });
    writePackageLocalDependency(root, "package-local-dependency", "package-local-only");

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("package-local-only");
  });

  it("fails when declarations import an undeclared type dependency", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "missing-type-dependency", {
      declarationContent:
        'import type { MissingType } from "@croco-smoke/missing-types";\nexport type Value = MissingType;\n',
    });

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("@croco-smoke/missing-types");
  });

  it("does not treat diagnostic code string literals as type dependency imports", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "diagnostic-codes", {
      declarationContent:
        'type DiagnosticCode = "architecture-policy/forbidden-import" | "architecture-policy/private-entrypoint-import";\nexport type Value = { readonly code: DiagnosticCode };\n',
    });

    const result = runScript(root);

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("undeclared type dependency");
  });

  it("does not treat generated runtime source strings as runtime dependency imports", () => {
    const root = createTempRoot();
    writeImportablePackage(root, "generated-source", {
      cjsContent:
        'const generated = `import { ProblemClientError } from "@croco/frontend-problems";\\n`;\nexports.value = generated;\n',
    });

    const result = runScript(root);

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("undeclared runtime dependency");
  });
});

function createTempRoot(options: TempRootOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "croco-entrypoint-smoke-test-"));
  const packageManager = options.packageManager ?? "pnpm@10.15.1";
  tempRoots.push(root);
  mkdirSync(join(root, "packages"));
  mkdirSync(join(root, "node_modules", "reflect-metadata"), { recursive: true });
  writeFileSync(join(root, "node_modules", "reflect-metadata", "index.js"), "\n");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "croco-entrypoint-smoke-test-root",
        ...(packageManager === false ? {} : { packageManager }),
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    `${JSON.stringify(
      {
        ...(options.catalog ? { catalog: options.catalog } : {}),
        packages: ["packages/*"],
      },
      null,
      2,
    )}\n`,
  );

  return root;
}

function writeImportablePackage(
  root: string,
  packageDirName: string,
  options: {
    readonly cjsContent?: string;
    readonly declarationContent?: string;
    readonly dependencies?: Record<string, string>;
    readonly esmContent?: string;
    readonly exportsValue?: unknown;
    readonly importTarget?: string;
    readonly packageName?: string;
    readonly peerDependencies?: Record<string, string>;
    readonly publishConfig?: Record<string, unknown>;
    readonly sideEffects?: boolean | readonly string[];
    readonly sourceExports?: unknown;
    readonly sourceMain?: string;
    readonly sourceTypes?: string;
    readonly typesTarget?: string;
  } = {},
): void {
  const packageDir = join(root, "packages", packageDirName);
  mkdirSync(join(packageDir, "src"), { recursive: true });
  mkdirSync(join(packageDir, "dist"), { recursive: true });

  const packageName = options.packageName ?? `@croco/${packageDirName}`;
  writeFileSync(join(packageDir, "src", "index.ts"), 'export const value = "ok";\n');
  writeFileSync(
    join(packageDir, "dist", "index.js"),
    options.cjsContent ?? 'exports.value = "ok";\n',
  );
  writeFileSync(
    join(packageDir, "dist", "index.mjs"),
    options.esmContent ?? 'export const value = "ok";\n',
  );
  writeFileSync(
    join(packageDir, "dist", "index.d.ts"),
    options.declarationContent ?? "export declare const value: string;\n",
  );
  writeFileSync(
    join(packageDir, "dist", "index.d.mts"),
    options.declarationContent ?? "export declare const value: string;\n",
  );
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        peerDependencies: options.peerDependencies,
        sideEffects: options.sideEffects,
        exports: options.sourceExports,
        version: "0.0.0",
        dependencies: options.dependencies,
        files: ["dist"],
        type: "commonjs",
        main: options.sourceMain ?? "./src/index.ts",
        types: options.sourceTypes ?? "./src/index.ts",
        publishConfig:
          options.publishConfig ??
          ({
            access: "public",
            main: "./dist/index.js",
            types: options.typesTarget ?? "./dist/index.d.ts",
            exports: options.exportsValue ?? {
              ".": {
                types: options.typesTarget ?? "./dist/index.d.ts",
                import: options.importTarget ?? "./dist/index.mjs",
                require: "./dist/index.js",
              },
            },
          } satisfies Record<string, unknown>),
      },
      null,
      2,
    )}\n`,
  );
}

function defaultPublishExports(): Record<string, unknown> {
  return {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.mjs",
      require: "./dist/index.js",
    },
  };
}

function decoratorBundleFixtureSource(): string {
  return [
    'export const AUDIT_PARAM_KEY = Symbol("audit:param");',
    "const metadata = new WeakMap();",
    "Reflect.defineMetadata = (key, value, target, propertyKey) => {",
    "  const values = metadata.get(target) ?? new Map();",
    "  values.set(`${String(key)}:${String(propertyKey)}`, value);",
    "  metadata.set(target, values);",
    "};",
    "Reflect.getMetadata = (key, target, propertyKey) => metadata.get(target)?.get(`${String(key)}:${String(propertyKey)}`);",
    "export function Auditable(options) {",
    "  return (target, propertyKey) => {",
    "    Reflect.defineMetadata(AUDIT_PARAM_KEY, { resourceIdIndex: options.resourceIdIndex }, target, propertyKey);",
    "  };",
    "}",
    "",
  ].join("\n");
}

function writeDecoratorMetadataPackages(
  root: string,
  options: {
    readonly brokenDefaultResolution?: boolean;
    readonly missingAuthMetadata?: boolean;
    readonly requiredAuthOptions?: boolean;
    readonly missingFeatureMetadata?: boolean;
    readonly missingMemberMetadata?: boolean;
  } = {},
): void {
  const dependencyResolution = options.brokenDefaultResolution
    ? "dependencies.map((dependency) => this.get(dependency))"
    : "dependencies.map((dependency, index) => index >= token.length ? undefined : this.get(dependency))";
  const cjsContainer = [
    "const metadata = new WeakMap();",
    "Reflect.defineMetadata = (key, value, target, propertyKey) => {",
    "  const targetMetadata = metadata.get(target) ?? new Map();",
    '  targetMetadata.set(`${key}:${String(propertyKey ?? "")}`, value);',
    "  metadata.set(target, targetMetadata);",
    "};",
    'Reflect.getMetadata = (key, target, propertyKey) => metadata.get(target)?.get(`${key}:${String(propertyKey ?? "")}`);',
    "class Container {",
    "  static values = new Map();",
    "  static set(token, value) { this.values.set(token, value); return value; }",
    "  static get(token) {",
    "    if (this.values.has(token)) return this.values.get(token);",
    '    const dependencies = Reflect.getMetadata("design:paramtypes", token) ?? [];',
    `    const value = new token(...${dependencyResolution});`,
    "    this.values.set(token, value);",
    "    return value;",
    "  }",
    "  static reset() { this.values.clear(); }",
    "}",
    "exports.Container = Container;",
    "",
  ].join("\n");
  const esmContainer = cjsContainer
    .replace("class Container", "export class Container")
    .replace("exports.Container = Container;", "");
  writeImportablePackage(root, "framework-context", {
    cjsContent: cjsContainer,
    declarationContent: "export declare class Container {}\n",
    esmContent: esmContainer,
    packageName: "@croco/framework-context",
  });

  writeImportablePackage(root, "integrations-posthog", {
    cjsContent: "class PostHogClient {}\nexports.PostHogClient = PostHogClient;\n",
    declarationContent: "export declare class PostHogClient {}\n",
    esmContent: "export class PostHogClient {}\n",
    packageName: "@croco/integrations-posthog",
  });

  const authOptions = options.requiredAuthOptions ? "options" : "options = {}";
  const authMetadata = options.missingAuthMetadata
    ? ""
    : 'Reflect.defineMetadata("design:paramtypes", [BetterAuthFactory, Object], BetterAuthProvider);\n';
  writeImportablePackage(root, "auth-better-auth", {
    cjsContent: [
      'require("@croco/framework-context");',
      "class BetterAuthFactory {}",
      `class BetterAuthProvider { constructor(factory, ${authOptions}) { this.factory = factory; } }`,
      authMetadata,
      "exports.BetterAuthFactory = BetterAuthFactory;",
      "exports.BetterAuthProvider = BetterAuthProvider;",
      "",
    ].join("\n"),
    declarationContent:
      "export declare class BetterAuthFactory {}\nexport declare class BetterAuthProvider {}\n",
    dependencies: { "@croco/framework-context": "0.0.0" },
    esmContent: [
      'import "@croco/framework-context";',
      "export class BetterAuthFactory {}",
      `export class BetterAuthProvider { constructor(factory, ${authOptions}) { this.factory = factory; } }`,
      authMetadata,
      "",
    ].join("\n"),
    packageName: "@croco/auth-better-auth",
  });

  const featureMetadata = options.missingFeatureMetadata
    ? ""
    : 'Reflect.defineMetadata("design:paramtypes", [PostHogClient], PostHogFeatureManager);\n';
  writeImportablePackage(root, "features-posthog", {
    cjsContent: [
      'require("@croco/framework-context");',
      'const { PostHogClient } = require("@croco/integrations-posthog");',
      "class PostHogFeatureManager { constructor(posthogClient) { this.posthogClient = posthogClient; } }",
      featureMetadata,
      "exports.PostHogFeatureManager = PostHogFeatureManager;",
      "",
    ].join("\n"),
    declarationContent: "export declare class PostHogFeatureManager {}\n",
    dependencies: {
      "@croco/framework-context": "0.0.0",
      "@croco/integrations-posthog": "0.0.0",
    },
    esmContent: [
      'import "@croco/framework-context";',
      'import { PostHogClient } from "@croco/integrations-posthog";',
      "export class PostHogFeatureManager { constructor(posthogClient) { this.posthogClient = posthogClient; } }",
      featureMetadata,
      "",
    ].join("\n"),
    packageName: "@croco/features-posthog",
  });

  writeImportablePackage(root, "metering-core", {
    cjsContent: [
      'require("@croco/framework-context");',
      "class MeterRepository {}",
      "class MeterRegistry { constructor(repository, cacheTtlMs = 60000) { this.repository = repository; this.cacheTtlMs = cacheTtlMs; } }",
      'Reflect.defineMetadata("design:paramtypes", [MeterRepository, Number], MeterRegistry);',
      "exports.MeterRepository = MeterRepository;",
      "exports.MeterRegistry = MeterRegistry;",
      "",
    ].join("\n"),
    declarationContent:
      "export declare class MeterRepository {}\nexport declare class MeterRegistry {}\n",
    dependencies: { "@croco/framework-context": "0.0.0" },
    esmContent: [
      'import "@croco/framework-context";',
      "export class MeterRepository {}",
      "export class MeterRegistry { constructor(repository, cacheTtlMs = 60000) { this.repository = repository; this.cacheTtlMs = cacheTtlMs; } }",
      'Reflect.defineMetadata("design:paramtypes", [MeterRepository, Number], MeterRegistry);',
      "",
    ].join("\n"),
    packageName: "@croco/metering-core",
  });

  const memberMetadata = options.missingMemberMetadata
    ? ""
    : 'Reflect.defineMetadata("design:type", Function, LlmService.prototype, "generate");';
  writeImportablePackage(root, "llm-core", {
    cjsContent: [
      'require("@croco/framework-context");',
      "class LlmService { generate() {} }",
      memberMetadata,
      "exports.LlmService = LlmService;",
      "",
    ].join("\n"),
    declarationContent: "export declare class LlmService { generate(): void; }\n",
    dependencies: { "@croco/framework-context": "0.0.0" },
    esmContent: [
      'import "@croco/framework-context";',
      "export class LlmService { generate() {} }",
      memberMetadata,
      "",
    ].join("\n"),
    packageName: "@croco/llm-core",
  });
}

function writePackageLocalDependency(
  root: string,
  packageDirName: string,
  dependencyName: string,
): void {
  const dependencyDir = join(
    root,
    "packages",
    packageDirName,
    "node_modules",
    ...dependencyName.split("/"),
  );

  mkdirSync(dependencyDir, { recursive: true });
  writeFileSync(
    join(dependencyDir, "package.json"),
    `${JSON.stringify(
      {
        name: dependencyName,
        version: "1.0.0",
        main: "./index.js",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dependencyDir, "index.js"), "module.exports = {};\n");
}

function writeUnbuiltPackage(root: string, packageDirName: string): void {
  const packageDir = join(root, "packages", packageDirName);
  mkdirSync(join(packageDir, "src"), { recursive: true });

  const packageName = `@croco/${packageDirName}`;
  writeFileSync(join(packageDir, "src", "index.ts"), 'export const value = "ok";\n');
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: "0.0.0",
        files: ["dist"],
        type: "commonjs",
        main: "./src/index.ts",
        types: "./src/index.ts",
        publishConfig: {
          access: "public",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
          exports: {
            ".": {
              import: "./dist/index.mjs",
              require: "./dist/index.js",
              types: "./dist/index.d.ts",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeDocsPackage(root: string): void {
  const packageDir = join(root, "packages", "docs");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@croco/docs",
        private: true,
        version: "0.0.0",
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
}

function writePublicDocsPackage(root: string): void {
  const packageDir = join(root, "packages", "docs");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@croco/docs",
        publishConfig: {
          access: "public",
        },
        type: "module",
        version: "0.0.0",
      },
      null,
      2,
    )}\n`,
  );
}

function runScript(root: string): ScriptResult {
  const result = spawnSync("node", ["--experimental-strip-types", scriptPath, "--root", root], {
    encoding: "utf-8",
    timeout: spawnTimeoutMs,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}
