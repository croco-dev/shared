import { describe, expect, it } from "vitest";

import {
  canonicalExportConditionNames,
  effectivePublishManifest,
  EXPECTED_PACKAGE_LICENSE,
  exportConditionOrderDiagnostics,
  exportConditionSequenceParityDiagnostics,
  fieldMatchesPath,
  isCiScriptOnlyManifestChange,
  packageLicenseDiagnostics,
} from "../package-manifest-contracts.mjs";

describe("package-manifest-contracts", () => {
  it("exempts only additions of canonical CI scripts while preserving all existing scripts", () => {
    const base = { name: "@croco/example", scripts: { test: "vitest run" } };
    const head = {
      ...base,
      scripts: {
        ...base.scripts,
        "test:evidence":
          "pnpm run test --maxWorkers=1 --reporter=json --outputFile=.turbo/croco-test-evidence.json",
      },
    };
    expect(isCiScriptOnlyManifestChange(base, head)).toBe(true);
    expect(isCiScriptOnlyManifestChange(base, base)).toBe(false);
    expect(isCiScriptOnlyManifestChange(head, base)).toBe(false);
    expect(isCiScriptOnlyManifestChange(base, { ...head, main: "./dist/other.js" })).toBe(false);
    expect(
      isCiScriptOnlyManifestChange(base, {
        ...head,
        scripts: { ...head.scripts, test: "vitest run src/tests/Selected.spec.ts" },
      }),
    ).toBe(false);
    expect(
      isCiScriptOnlyManifestChange(base, {
        ...head,
        scripts: { ...head.scripts, "test:evidence": "echo success" },
      }),
    ).toBe(false);
    expect(
      isCiScriptOnlyManifestChange(
        { ...head, scripts: { ...head.scripts, "test:evidence": "echo old" } },
        head,
      ),
    ).toBe(false);
  });

  it("applies publishConfig overrides to the effective publish manifest", () => {
    expect(
      effectivePublishManifest({
        bin: { source: "./src/cli.ts" },
        name: "@croco/example",
        publishConfig: { bin: { published: "./dist/cli.js" } },
      }),
    ).toEqual({
      bin: { published: "./dist/cli.js" },
      name: "@croco/example",
    });
  });

  it("compares root and publish fields without object key order sensitivity", () => {
    const source = {
      exports: {
        ".": {
          import: "./dist/index.mjs",
          require: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
      },
      publishConfig: {
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            require: "./dist/index.js",
            import: "./dist/index.mjs",
          },
        },
      },
    };

    expect(fieldMatchesPath(source, "exports", "publishConfig.exports")).toBe(true);
  });

  it("keeps array values order-sensitive", () => {
    const source = {
      files: ["dist", "templates"],
      publishConfig: {
        files: ["templates", "dist"],
      },
    };

    expect(fieldMatchesPath(source, "files", "publishConfig.files")).toBe(false);
  });

  it("defines types, import, and require as the canonical export-condition order", () => {
    expect(
      canonicalExportConditionNames({
        require: "./dist/index.js",
        custom: "./dist/custom.js",
        types: "./dist/index.d.ts",
        import: "./dist/index.mjs",
      }),
    ).toEqual(["types", "import", "require", "custom"]);
  });

  it("reports noncanonical packed export-condition order", () => {
    expect(
      exportConditionOrderDiagnostics(
        {
          ".": {
            import: "./dist/index.mjs",
            require: "./dist/index.js",
            types: "./dist/index.d.ts",
          },
        },
        "packed exports",
      ),
    ).toEqual(['packed exports["."] conditions must be ordered types, import, require']);
  });

  it("reports noncanonical mode-specific declaration order", () => {
    expect(
      exportConditionOrderDiagnostics(
        {
          ".": {
            types: {
              require: "./dist/index.d.ts",
              import: "./dist/index.d.mts",
            },
            import: "./dist/index.mjs",
            require: "./dist/index.js",
          },
        },
        "packed exports",
      ),
    ).toEqual(['packed exports["."].types conditions must be ordered import, require']);
  });

  it("compares shared workspace and published condition sequences", () => {
    expect(
      exportConditionSequenceParityDiagnostics(
        {
          ".": {
            types: "./dist/index.d.ts",
            require: "./dist/index.js",
            import: "./dist/index.mjs",
          },
        },
        {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.mjs",
            require: "./dist/index.js",
          },
        },
      ),
    ).toEqual([
      'exports["."] and publishConfig.exports["."] must preserve the same shared condition order',
    ]);
  });

  it("defines Apache-2.0 as the canonical package license", () => {
    expect(EXPECTED_PACKAGE_LICENSE).toBe("Apache-2.0");
  });

  it("validates package license declarations", () => {
    expect(packageLicenseDiagnostics({ license: "Apache-2.0" })).toEqual([]);
    expect(packageLicenseDiagnostics({ license: "MIT" })).toEqual(['license must be "Apache-2.0"']);
    expect(packageLicenseDiagnostics({})).toEqual(['license must be "Apache-2.0"']);
    expect(packageLicenseDiagnostics({ private: true })).toEqual([]);
    expect(packageLicenseDiagnostics({ private: true, license: "UNLICENSED" })).toEqual([]);
  });
});
