import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { apiDocModelEntryPoints, apiDocPackages } from "../../packages/docs/api-docs.config.mjs";
import { prunePreviouslyDocumentedExports } from "../../packages/docs/scripts/prepare-api-models.mjs";
import {
  normalizeCliDiagnosticDefinitions,
  sanitizeGeneratedTypeDocIndex,
} from "../../packages/docs/scripts/sanitize-typedoc-index.mjs";

type PackageManifest = {
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
};

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const API_DOCS_ROOT = join(REPOSITORY_ROOT, "packages", "docs", "src", "content", "docs", "api");
const MODEL_SCRIPT =
  "node --experimental-strip-types ../docs/scripts/generate-package-api-model.mts";
const DOCS_WRAPPER = "node --experimental-strip-types scripts/build-docs.mts";
const TEMP_ROOTS: string[] = [];

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function markdownFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith(".md") ? [path] : [];
  });
}

describe("API documentation pipeline", () => {
  afterEach(() => {
    for (const root of TEMP_ROOTS.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it("keeps one canonical, ordered package-model catalog", () => {
    expect(apiDocPackages).toHaveLength(120);
    expect(new Set(apiDocPackages.map(({ packageName }) => packageName)).size).toBe(120);
    expect(new Set(apiDocPackages.map(({ directory }) => directory)).size).toBe(120);
    expect(new Set(apiDocPackages.map(({ moduleName }) => moduleName)).size).toBe(120);
    expect(apiDocModelEntryPoints).toEqual(
      apiDocPackages.map(({ directory }) => `../${directory}/.turbo/docs-api/model.json`),
    );
  });

  it("gives every documented package a cacheable model task and docs dependency edge", () => {
    const docsManifest = readManifest(join(REPOSITORY_ROOT, "packages", "docs", "package.json"));
    expect(docsManifest.scripts?.["docs:api:render"]).toBe(`${DOCS_WRAPPER} --api-render`);
    expect(docsManifest.scripts?.dev).toBe(`${DOCS_WRAPPER} --dev`);
    expect(docsManifest.scripts?.start).toBe(`${DOCS_WRAPPER} --dev`);
    expect(docsManifest.scripts?.["docs:dev"]).toBe(`${DOCS_WRAPPER} --dev`);

    for (const entry of apiDocPackages) {
      const packageRoot = join(REPOSITORY_ROOT, "packages", entry.directory);
      const manifest = readManifest(join(packageRoot, "package.json"));
      expect(manifest.name, entry.directory).toBe(entry.packageName);
      expect(manifest.scripts?.["docs:api:model"], entry.packageName).toBe(MODEL_SCRIPT);
      expect(docsManifest.devDependencies?.[entry.packageName], entry.packageName).toBe(
        "workspace:*",
      );
      expect(existsSync(join(packageRoot, entry.entryPoint)), entry.packageName).toBe(true);

      const entryModule = entry.entryPoint.replace(/\/index\.ts$/, "").replace(/\.ts$/, "");
      expect(entry.moduleName, entry.packageName).toBe(`${entry.directory}/${entryModule}`);
    }
  });

  it("prepares models before a package-local docs development server starts", () => {
    const fakeBin = createFakePnpm();
    const logPath = join(fakeBin, "calls.jsonl");
    const result = spawnSync(
      "node",
      [
        "--experimental-strip-types",
        join(REPOSITORY_ROOT, "packages", "docs", "scripts", "build-docs.mts"),
        "--dev",
      ],
      {
        cwd: join(REPOSITORY_ROOT, "packages", "docs"),
        encoding: "utf8",
        env: {
          ...process.env,
          CROCO_DOCS_API_ONLY: "1",
          CROCO_DOCS_BUILD_ROOT: "unsafe-external-root",
          FAKE_DOCS_DEV_LOG: logPath,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          TURBO_HASH: "",
        },
      },
    );
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(result.status, result.stderr).toBe(0);
    expect(calls.map(({ args }) => args)).toEqual([
      ["--workspace-root", "turbo", "run", "docs:api:model", "--env-mode=loose"],
      ["exec", "astro", "dev", "--host"],
    ]);
    expect(calls[1]).toMatchObject({ apiOnly: null, buildRoot: null });
  });

  it("matches the tracked generated API package directories", () => {
    const generatedDirectories = readdirSync(API_DOCS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort();
    const catalogDirectories = apiDocPackages.map(({ directory }) => directory).sort();
    expect(generatedDirectories).toEqual(catalogDirectories);
  });

  it("documents wrapped route schemas consistently across decorators and contract aliases", () => {
    for (const path of [
      "functions/Param.md",
      "functions/Query.md",
      "functions/routeParamSchema.md",
      "functions/routeQueryParamSchema.md",
      "type-aliases/RouteContractWithParams.md",
      "type-aliases/RouteContractWithQuery.md",
    ]) {
      const content = readFileSync(join(API_DOCS_ROOT, "protocols-rest/src", path), "utf8");
      expect(content, path).toContain("RouteParameterSchema");
      expect(content, path).not.toContain("AnyZodObject");
    }
  });

  it("documents decorator output keys separately from schema helper input keys", () => {
    const param = readFileSync(
      join(API_DOCS_ROOT, "protocols-rest/src/functions/Param.md"),
      "utf8",
    );
    expect(param).toContain("routepathparams/");
    expect(param).not.toContain("routepathparamname/");
    for (const name of ["routeParamSchema", "routeQueryParamSchema"]) {
      const content = readFileSync(
        join(API_DOCS_ROOT, `protocols-rest/src/functions/${name}.md`),
        "utf8",
      );
      const constraint = content.split("### Name")[1].split("## Parameters")[0];
      expect(constraint, name).toContain("RouteParameterObject");
      expect(constraint, name).toContain('"shape"');
      expect(constraint, name).not.toContain("routepathparams/");
      expect(constraint, name).not.toContain("routequery/");
    }
  });

  it("contains no untranslated TypeDoc Markdown theme tokens", () => {
    const untranslated = markdownFiles(API_DOCS_ROOT).filter((path) =>
      /\btheme_[a-z_]+\b/.test(readFileSync(path, "utf8")),
    );
    expect(untranslated).toEqual([]);
  });

  it("keeps the custom diagnostic table formatter-stable across repeated Astro setup", () => {
    const typeDocOutput = [
      "---",
      'title: "CROCO_DIAGNOSTIC_CODE_DEFINITIONS"',
      "---",
      "",
      "> `const` **CROCO_DIAGNOSTIC_CODE_DEFINITIONS**: readonly []",
      "",
    ].join("\n");
    const normalized = normalizeCliDiagnosticDefinitions(typeDocOutput);

    expect(normalized).toContain(
      "| Code                            | Legacy aliases / patterns                 | Title                                                         | Action                                                                                                                      |",
    );
    expect(normalized).toContain(
      "| ------------------------------- | ----------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |",
    );
    expect(normalized).toContain("---\n\n## CLI Diagnostic Definitions");
    expect(normalizeCliDiagnosticDefinitions(normalized)).toBe(normalized);
  });

  it("does not sanitize tracked API docs during Astro preview", async () => {
    const sanitize = vi.fn(async () => undefined);
    const integration = sanitizeGeneratedTypeDocIndex(sanitize);

    await integration.hooks["config:setup"]({ command: "preview" });
    expect(sanitize).not.toHaveBeenCalled();

    await integration.hooks["config:setup"]({ command: "build" });
    expect(sanitize).toHaveBeenCalledOnce();
  });

  it("preserves cross-package inheritance and revived symbol links after model merge", () => {
    const problemSubclass = readFileSync(
      join(
        API_DOCS_ROOT,
        "events-core",
        "src",
        "classes",
        "EventAfterCommitRequiresActiveTransactionProblem.md",
      ),
      "utf8",
    );

    expect(problemSubclass).toContain("- [`Problem`](/api/problems-core/src/classes/problem/)");
    expect(problemSubclass).toContain(
      "[`Problem`](/api/problems-core/src/classes/problem/).[`cause`](/api/problems-core/src/classes/problem/#cause)",
    );
  });

  it("deduplicates re-exports while preserving references to the canonical symbol", () => {
    const seenSymbols = new Set<string>();
    const sharedRootSymbol = {
      packageName: "@croco/shared",
      packagePath: "src/index.ts",
      qualifiedName: "SharedContract",
    };
    const sharedMemberSymbol = {
      packageName: "@croco/shared",
      packagePath: "src/index.ts",
      qualifiedName: "SharedContract.value",
    };
    const firstModel = {
      children: [{ id: 1, name: "SharedContract" }],
      symbolIdMap: { 1: sharedRootSymbol },
    };
    const secondModel = {
      children: [
        {
          id: 2,
          name: "SharedContract",
          children: [{ id: 3, name: "value" }],
        },
        {
          id: 4,
          name: "Consumer",
          type: { type: "reference", name: "value", target: 3 },
        },
      ],
      groups: [{ title: "Contracts", children: [2, 4] }],
      symbolIdMap: {
        2: sharedRootSymbol,
        3: sharedMemberSymbol,
        4: {
          packageName: "@croco/consumer",
          packagePath: "src/index.ts",
          qualifiedName: "Consumer",
        },
      },
    };

    prunePreviouslyDocumentedExports(firstModel, seenSymbols, "@croco/shared");
    prunePreviouslyDocumentedExports(secondModel, seenSymbols, "@croco/consumer");

    expect(secondModel.children).toEqual([
      {
        id: 4,
        name: "Consumer",
        type: { type: "reference", name: "value", target: sharedMemberSymbol },
      },
    ]);
    expect(secondModel.groups).toEqual([{ title: "Contracts", children: [4] }]);
    expect(secondModel.symbolIdMap).toEqual({
      4: {
        packageName: "@croco/consumer",
        packagePath: "src/index.ts",
        qualifiedName: "Consumer",
      },
    });
  });
});

function createFakePnpm(): string {
  const root = mkdtempSync(join(tmpdir(), "croco-docs-dev-bin-"));
  TEMP_ROOTS.push(root);
  const implementation = join(root, "pnpm-fake.cjs");
  writeFileSync(
    implementation,
    [
      'const { appendFileSync } = require("node:fs");',
      "appendFileSync(",
      "  process.env.FAKE_DOCS_DEV_LOG,",
      "  JSON.stringify({",
      "    apiOnly: process.env.CROCO_DOCS_API_ONLY ?? null,",
      "    args: process.argv.slice(2),",
      "    buildRoot: process.env.CROCO_DOCS_BUILD_ROOT ?? null,",
      "    cwd: process.cwd(),",
      '  }) + "\\n",',
      ");",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "pnpm"),
    `#!/usr/bin/env node\nrequire(${JSON.stringify(implementation)});\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(root, "pnpm.cmd"), `@node "${implementation}" %*\r\n`);
  return root;
}
