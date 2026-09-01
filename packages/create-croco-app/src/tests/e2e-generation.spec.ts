import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { preProcessFile } from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { generate } from "../generator.js";
import { getExternalCrocoPackageRange } from "../helpers/croco-ranges.js";
import { mergeInto, replaceGithubExpressions } from "../helpers/fs.js";
import { InvalidCliOptionProblem } from "../libs/problems/InvalidCliOptionProblem.js";
import { InvalidGoalOptionProblem } from "../libs/problems/InvalidGoalOptionProblem.js";
import { normalizeNonInteractiveOptions, parseCliOptions } from "../options.js";
import { getGeneratedAppDependencyRange } from "../package-version.js";
import type { GeneratorOptions, NormalizedGeneratorOptions } from "../types.js";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const SOURCE_FILE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const IMPORT_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_SPECIFIER_PATTERN = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const GENERATED_API_DI_GRAPH_SCRIPT =
  "cross-env NODE_OPTIONS=--import=tsx croco di graph --module src/app.ts --bootstrap createCrocoApp --roots createCrocoDiGraphRoots --write ../../.croco/build/di-graph.manifest.json";
const GENERATED_SAAS_API_DI_GRAPH_SCRIPT =
  "cross-env NODE_OPTIONS=--import=tsx croco di graph --module src/app.ts --bootstrap createCrocoDiGraphApplication --roots createCrocoDiGraphRoots --write ../../.croco/build/di-graph.manifest.json";
const WORKSPACE_ROOT = join(process.cwd(), "..", "..");
const TSX_CLI_PATH = join(
  WORKSPACE_ROOT,
  "node_modules",
  ".pnpm",
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);

type DependencyField = (typeof DEPENDENCY_FIELDS)[number];
type ImportReference = {
  specifier: string;
  typeOnly: boolean;
};
type PackageJson = {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
} & Partial<Record<DependencyField, Record<string, string>>>;

function externalCrocoRange(packageName: string): string {
  const range = getExternalCrocoPackageRange(packageName);

  if (range === undefined) {
    expect(range, packageName).toEqual(expect.any(String));
    return "";
  }

  return range;
}

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function isTextFile(filePath: string): boolean {
  return !readFileSync(filePath).includes(0);
}

function assertNoHandlebarsPlaceholders(projectDir: string): void {
  const filesWithPlaceholders = collectFiles(projectDir)
    .filter(isTextFile)
    .filter((filePath) => {
      const content = readFileSync(filePath, "utf8");
      const contentWithoutGithubExpressions = replaceGithubExpressions(content, () => "");

      return (
        contentWithoutGithubExpressions.includes("{{") ||
        contentWithoutGithubExpressions.includes("}}")
      );
    })
    .map((filePath) => relative(projectDir, filePath));

  expect(filesWithPlaceholders).toEqual([]);
}

function assertNoTailwindReferences(projectDir: string): void {
  const filesWithTailwindReferences = collectFiles(projectDir)
    .filter(isTextFile)
    .filter((filePath) => readFileSync(filePath, "utf8").toLowerCase().includes("tailwind"))
    .map((filePath) => relative(projectDir, filePath));

  expect(filesWithTailwindReferences).toEqual([]);
}

function collectPackageNames(projectDir: string): Set<string> {
  return new Set(
    collectFiles(projectDir)
      .filter((filePath) => filePath.endsWith("package.json"))
      .map((filePath) => JSON.parse(readFileSync(filePath, "utf8")).name as string),
  );
}

function collectDockerPackageFilters(projectDir: string): string[] {
  return collectFiles(projectDir)
    .filter((filePath) => filePath.endsWith("Dockerfile") || filePath.includes("Dockerfile."))
    .flatMap((filePath) => {
      const content = readFileSync(filePath, "utf8");

      return [...content.matchAll(/(?:turbo prune\s+|--filter=)(@[^\s]+)/g)].map(
        (match) => match[1],
      );
    });
}

function assertDockerFiltersMatchPackages(projectDir: string): void {
  const packageNames = collectPackageNames(projectDir);
  const dockerFilters = collectDockerPackageFilters(projectDir);

  expect(dockerFilters.length).toBeGreaterThan(0);
  for (const dockerFilter of dockerFilters) {
    expect(packageNames.has(dockerFilter)).toBe(true);
  }
}

function readSstHandlerPath(projectDir: string): string {
  const sstConfig = readFileSync(join(projectDir, "sst.config.ts"), "utf8");
  const match = sstConfig.match(/handler:\s*["']([^"']+)["']/);
  const handlerPath = match?.[1];

  if (typeof handlerPath !== "string") {
    throw new Error("Generated sst.config.ts is missing an SST function handler path");
  }

  return handlerPath;
}

function assertLambdaHandlerTarget(projectDir: string, expectedHandlerPath: string): void {
  const handlerPath = readSstHandlerPath(projectDir);
  const handlerModulePath = handlerPath.replace(/\.[^.]+$/, ".ts");
  const handlerFilePath = join(projectDir, handlerModulePath);

  expect(handlerPath).toBe(expectedHandlerPath);
  expect(existsSync(handlerFilePath)).toBe(true);
  expect(readFileSync(handlerFilePath, "utf8")).toMatch(
    /\bexport\s+(const|async function|function)\s+handler\b/,
  );
}

function readPackageJson(filePath: string): PackageJson {
  return JSON.parse(readFileSync(filePath, "utf8")) as PackageJson;
}

function runGeneratedProfileCheck(projectDir: string): { status: number | null; output: string } {
  expect(existsSync(TSX_CLI_PATH), TSX_CLI_PATH).toBe(true);
  writeGeneratedProfileCheckRuntimeStub(projectDir);

  const result = spawnSync(
    process.execPath,
    [TSX_CLI_PATH, "src/provider-profile-check.ts", "--mode=manifest"],
    {
      cwd: join(projectDir, "apps", "api-server"),
      encoding: "utf8",
    },
  );

  return {
    status: result.status,
    output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n"),
  };
}

function writeGeneratedProfileCheckRuntimeStub(projectDir: string): void {
  const tenantCoreStubDir = join(
    projectDir,
    "apps",
    "api-server",
    "node_modules",
    "@croco",
    "tenant-core",
  );
  mkdirSync(tenantCoreStubDir, { recursive: true });
  writeFileSync(
    join(tenantCoreStubDir, "package.json"),
    `${JSON.stringify(
      {
        type: "module",
        exports: {
          "./tenant-model": "./tenant-model.mjs",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(tenantCoreStubDir, "tenant-model.mjs"),
    [
      "export function validateTenantModelCompatibility() {",
      "  return { ok: true, diagnostics: [] };",
      "}",
      "",
    ].join("\n"),
  );
}

function expectGeneratedProfileCheckPass(projectDir: string): void {
  const result = runGeneratedProfileCheck(projectDir);

  expect(result.output).toContain("SaaS provider profile manifest check passed");
  expect(result.status).toBe(0);
}

function expectGeneratedProfileCheckFailureAfterWrite(
  projectDir: string,
  relativePath: string,
  update: (source: string) => string,
  diagnosticCode: string,
): void {
  const artifactPath = join(projectDir, relativePath);
  const original = readFileSync(artifactPath, "utf8");

  try {
    writeFileSync(artifactPath, update(original));
    const result = runGeneratedProfileCheck(projectDir);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(diagnosticCode);
  } finally {
    writeFileSync(artifactPath, original);
  }
}

function toPackageName(specifier: string): string | undefined {
  if (
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:")
  ) {
    return undefined;
  }

  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function toTypesPackageName(packageName: string): string {
  if (!packageName.startsWith("@")) {
    return `@types/${packageName}`;
  }

  const [scope, name] = packageName.split("/");

  return `@types/${scope.slice(1)}__${name}`;
}

function collectBarePackageImports(filePath: string): string[] {
  const imports = preProcessFile(readFileSync(filePath, "utf8"), true, true)
    .importedFiles.map(({ fileName }) => toPackageName(fileName))
    .filter((packageName): packageName is string => packageName !== undefined);

  return [...new Set(imports)];
}

function collectImportReferences(content: string): ImportReference[] {
  return [
    ...[...content.matchAll(IMPORT_SPECIFIER_PATTERN)].map((match) => ({
      specifier: match[2],
      typeOnly: match[1] !== undefined,
    })),
    ...[...content.matchAll(DYNAMIC_IMPORT_SPECIFIER_PATTERN)].map((match) => ({
      specifier: match[1],
      typeOnly: false,
    })),
  ];
}

function assertViteConfigImportsDeclared(packageDir: string): void {
  const packageJson = readPackageJson(join(packageDir, "package.json"));
  const declaredDependencies = new Set(
    DEPENDENCY_FIELDS.flatMap((field) => Object.keys(packageJson[field] ?? {})),
  );
  const importedPackages = collectBarePackageImports(join(packageDir, "vite.config.ts"));
  const missingPackages = importedPackages.filter(
    (packageName) => !declaredDependencies.has(packageName),
  );

  expect(importedPackages).not.toEqual([]);
  expect(missingPackages).toEqual([]);
}

function assertSourceBareImportsDeclared(packageDir: string): void {
  const packageJson = readPackageJson(join(packageDir, "package.json"));
  const declaredDependencies = new Set(
    DEPENDENCY_FIELDS.flatMap((field) => Object.keys(packageJson[field] ?? {})),
  );
  const missingDependencies = collectFiles(join(packageDir, "src"))
    .filter((filePath) => SOURCE_FILE_EXTENSIONS.has(extname(filePath)))
    .flatMap((filePath) =>
      collectImportReferences(readFileSync(filePath, "utf8")).flatMap((reference) => {
        const packageName = toPackageName(reference.specifier);

        if (packageName === undefined) {
          return [];
        }

        if (
          declaredDependencies.has(packageName) ||
          (reference.typeOnly && declaredDependencies.has(toTypesPackageName(packageName)))
        ) {
          return [];
        }

        return [
          {
            filePath: relative(packageDir, filePath),
            packageName,
          },
        ];
      }),
    );

  expect(missingDependencies).toEqual([]);
}

function assertBrowserWorkflowUsesImmutableActions(workflow: string): void {
  const remoteActions = workflow
    .split("\n")
    .flatMap((line) => line.match(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/)?.[1] ?? [])
    .filter((reference) => !reference.startsWith("./") && !reference.startsWith("docker://"));

  expect(new Set(remoteActions)).toEqual(
    new Set([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    ]),
  );
  for (const reference of remoteActions) {
    expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/i);
  }
}

function assertBrowserWorkflowUsesLeastPrivilege(workflow: string): void {
  const parsedWorkflow = parseYaml(workflow) as {
    permissions?: Record<string, unknown>;
    jobs?: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }>;
  };
  const checkoutSteps = Object.values(parsedWorkflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).filter((step) => step.uses?.toLowerCase().startsWith("actions/checkout@")),
  );

  expect(parsedWorkflow.permissions).toEqual({ contents: "read" });
  for (const job of Object.values(parsedWorkflow.jobs ?? {})) {
    expect(job).not.toHaveProperty("permissions");
  }
  expect(checkoutSteps.length).toBeGreaterThan(0);
  for (const checkoutStep of checkoutSteps) {
    expect(checkoutStep.uses).toMatch(/^actions\/checkout@/);
    expect(checkoutStep.with?.["persist-credentials"]).toBe(false);
  }
}

function assertBrowserWorkflowVerifiesContractsWithoutCodegen(workflow: string): void {
  expect(workflow).toMatch(
    /contracts:[\s\S]*pnpm contract:verify[\s\S]*component:[\s\S]*needs: contracts[\s\S]*journey:[\s\S]*needs: contracts/,
  );
  expect(workflow).not.toContain("pnpm codegen");
}

function assertAllSourceBareImportsDeclared(projectDir: string): void {
  const packageDirs = collectFiles(projectDir)
    .filter((filePath) => filePath.endsWith("package.json"))
    .map((filePath) => filePath.slice(0, -"package.json".length - 1))
    .filter((packageDir) => existsSync(join(packageDir, "src")));

  for (const packageDir of packageDirs) {
    assertSourceBareImportsDeclared(packageDir);
  }
}

function assertStylexNextWebApp(webDir: string): void {
  const packageJson = readPackageJson(join(webDir, "package.json"));
  const globalsCss = readFileSync(join(webDir, "src", "app", "globals.css"), "utf8");
  const pageSource = readFileSync(join(webDir, "src", "app", "page.tsx"), "utf8");

  expect(packageJson.dependencies?.["@stylexjs/stylex"]).toBe("^0.19.0");
  expect(packageJson.devDependencies?.["@stylexjs/babel-plugin"]).toBe("^0.19.0");
  expect(packageJson.devDependencies?.["@stylexjs/postcss-plugin"]).toBe("^0.19.0");
  expect(packageJson.dependencies?.["tailwindcss"]).toBeUndefined();
  expect(packageJson.devDependencies?.["tailwindcss"]).toBeUndefined();
  expect(packageJson.dependencies?.["@tailwindcss/postcss"]).toBeUndefined();
  expect(packageJson.devDependencies?.["@tailwindcss/postcss"]).toBeUndefined();
  expect(existsSync(join(webDir, "babel.config.js"))).toBe(true);
  expect(existsSync(join(webDir, "postcss.config.js"))).toBe(true);
  expect(existsSync(join(webDir, "tailwind.config.ts"))).toBe(false);
  expect(existsSync(join(webDir, "tailwind.config.js"))).toBe(false);
  expect(existsSync(join(webDir, "tailwind.config.cjs"))).toBe(false);
  expect(existsSync(join(webDir, "tailwind.config.mjs"))).toBe(false);
  expect(globalsCss).toContain("@stylex");
  expect(globalsCss).not.toContain("tailwind");
  expect(pageSource).toContain("@stylexjs/stylex");
  expect(pageSource).toContain("stylex.props");
}

function assertMetaViteBrowserBuildEntrypoint(packageDir: string, buildScript: string): void {
  const packageJson = readPackageJson(join(packageDir, "package.json"));
  const indexHtml = readFileSync(join(packageDir, "index.html"), "utf8");
  const viteConfig = readFileSync(join(packageDir, "vite.config.ts"), "utf8");

  expect(packageJson.scripts?.build).toBe(buildScript);
  expect(existsSync(join(packageDir, "index.html"))).toBe(true);
  expect(indexHtml).toContain('src="/src/client.tsx"');
  expect(indexHtml).toContain("data-croco-hydration-root");
  expect(existsSync(join(packageDir, "src", "client.tsx"))).toBe(true);
  expect(existsSync(join(packageDir, "src", "main.tsx"))).toBe(false);
  expect(viteConfig).toContain("from '@vitejs/plugin-react'");
  expect(viteConfig).toContain("defineConfig");
  expect(viteConfig).toContain("react()");
  expect(viteConfig).toContain("crocoMetaVitePlugin()");
  expect(viteConfig).toContain("manifest: 'manifest.json'");
  expect(viteConfig).toContain("outDir: 'dist/client'");
}

function assertNoExternalCrocoWorkspaceRanges(projectDir: string): void {
  const manifests = collectFiles(projectDir)
    .filter((filePath) => basename(filePath) === "package.json")
    .map((filePath) => ({
      filePath,
      packageJson: readPackageJson(filePath),
    }));
  const generatedPackageNames = new Set(
    manifests
      .map(({ packageJson }) => packageJson.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const externalWorkspaceRanges = manifests.flatMap(({ filePath, packageJson }) =>
    DEPENDENCY_FIELDS.flatMap((field) =>
      Object.entries(packageJson[field] ?? {})
        .filter(
          ([packageName, range]) =>
            packageName.startsWith("@croco/") &&
            range.startsWith("workspace:") &&
            !generatedPackageNames.has(packageName),
        )
        .map(([packageName, range]) => ({
          filePath: relative(projectDir, filePath),
          packageName,
          range,
        })),
    ),
  );

  expect(externalWorkspaceRanges).toEqual([]);
}

describe("E2E: generate()", () => {
  it("preserves GitHub expressions containing closing braces inside quoted strings", () => {
    const sourceDir = join(testDir, "github-expression-source");
    const outputDir = join(testDir, "github-expression-output");
    const expression = '${{ contains("}}", matrix.value) }}';
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "workflow.yml"),
      `name: {{projectName}}\ncondition: ${expression}\n`,
    );

    mergeInto(sourceDir, outputDir, { projectName: "generated" });

    expect(readFileSync(join(outputDir, "workflow.yml"), "utf8")).toBe(
      `name: generated\ncondition: ${expression}\n`,
    );
    assertNoHandlebarsPlaceholders(outputDir);
    expect(replaceGithubExpressions(expression, () => "__EXPRESSION__")).toBe("__EXPRESSION__");
  });

  let testDir: string;

  beforeEach(() => {
    testDir = `/tmp/croco-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("generates blank project", { timeout: 120_000 }, async () => {
    const options: GeneratorOptions = {
      projectName: "my-blank",
      scope: "@test",
      preset: "blank",
      webApps: [],
      apiHosting: "standalone",
      db: [],
      agentRules: false,
      installDeps: false,
      initGit: false,
    };

    await generate(testDir, options);

    expect(existsSync(join(testDir, "package.json"))).toBe(true);
    expect(existsSync(join(testDir, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(testDir, "turbo.json"))).toBe(true);
    expect(existsSync(join(testDir, "tsconfig.json"))).toBe(true);
    expect(readPackageJson(join(testDir, "package.json")).engines?.node).toBe(">=22");
    expect(readFileSync(join(testDir, ".nvmrc"), "utf8")).toBe("22\n");
    const readme = readFileSync(join(testDir, "README.md"), "utf8");
    expect(readme).toContain("Blank Croco workspace");
    expect(readme).toContain("pnpm install");
    expect(readme).toContain("pnpm dev");
    expect(readme).toContain("pnpm typecheck");
    expect(readme).toContain("expected success state");
    expect(readme).toContain("Recovery");
    expect(readme).toContain("Dependency installation and builds require Node.js >=22");
    expect(readme).toContain(
      "browser and Cloudflare Workers outputs still deploy without a Node.js runtime",
    );
    expect(readme).toContain("nvm install 22");
    expect(
      JSON.parse(readFileSync(join(testDir, "croco-runtime-capability.manifest.json"), "utf8")),
    ).toMatchObject({
      platform: "node",
      composition: {
        host: { platform: "node", lifecycle: "process" },
        transports: [],
        buildTarget: { name: "workspace" },
      },
    });
  });

  it("rejects mismatched goal generator options before creating the target directory", async () => {
    const options: NormalizedGeneratorOptions = {
      projectName: "mismatched-goal",
      scope: "@test",
      goal: "saas-api",
      preset: "production-app",
      webApps: [],
      apiHosting: "standalone",
      db: [],
      agentRules: false,
      installDeps: false,
      initGit: false,
    };

    let error: unknown;
    try {
      await generate(testDir, options as GeneratorOptions);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(InvalidGoalOptionProblem);
    expect(error).toMatchObject({
      code: "create-croco-app/invalid-goal-option",
    });
    expect(existsSync(testDir)).toBe(false);
  });

  it("rejects escaping web app paths before creating any directory", async () => {
    const targetDir = join(testDir, "workspace");
    const outsideDir = join(testDir, "outside");
    const options: GeneratorOptions = {
      projectName: "secure-fullstack",
      scope: "@test",
      preset: "ddd-fullstack",
      webApps: ["../../outside"],
      api: "trpc",
      apiHosting: "standalone",
      db: [],
      agentRules: false,
      installDeps: false,
      initGit: false,
    };

    let error: unknown;
    try {
      await generate(targetDir, options);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(InvalidCliOptionProblem);
    expect(error).toMatchObject({ code: "create-croco-app/invalid-cli-option" });
    expect(existsSync(testDir)).toBe(false);
    expect(existsSync(targetDir)).toBe(false);
    expect(existsSync(outsideDir)).toBe(false);
  });

  it(
    "generates ddd-fullstack with graphql standalone + docker + postgres",
    { timeout: 120_000 },
    async () => {
      const options: GeneratorOptions = {
        projectName: "my-fullstack",
        scope: "@test",
        preset: "ddd-fullstack",
        webApps: ["web"],
        api: "graphql",
        apiHosting: "standalone",
        backendDeploy: "docker",
        db: ["postgres"],
        agentRules: false,
        installDeps: false,
        initGit: false,
      };

      await generate(testDir, options);

      // Base DDD structure
      expect(existsSync(join(testDir, "package.json"))).toBe(true);
      expect(existsSync(join(testDir, "pnpm-workspace.yaml"))).toBe(true);
      expect(existsSync(join(testDir, "libs", "shared"))).toBe(true);

      // GraphQL standalone API
      expect(existsSync(join(testDir, "apps", "graphql-api"))).toBe(true);

      // Web app (web-graphql addon)
      expect(existsSync(join(testDir, "apps", "web"))).toBe(true);
      assertStylexNextWebApp(join(testDir, "apps", "web"));

      // Docker files
      expect(existsSync(join(testDir, "docker-compose.yml"))).toBe(true);
      expect(existsSync(join(testDir, ".dockerignore"))).toBe(true);
      const apiDockerfileContent = readFileSync(
        join(testDir, "apps", "graphql-api", "Dockerfile"),
        "utf8",
      );
      const graphqlPackageJson = readPackageJson(
        join(testDir, "apps", "graphql-api", "package.json"),
      );
      const graphqlSchemaContent = readFileSync(
        join(testDir, "apps", "graphql-api", "src", "schema.ts"),
        "utf8",
      );
      const webDockerfileContent = readFileSync(join(testDir, "web", "Dockerfile"), "utf8");
      const composeContent = readFileSync(join(testDir, "docker-compose.yml"), "utf8");

      expect(graphqlPackageJson.dependencies?.["@apollo/server"]).toBe("^4.12.2");
      expect(graphqlPackageJson.dependencies?.["@as-integrations/aws-lambda"]).toBeUndefined();
      expect(graphqlPackageJson.dependencies?.["@croco/protocols-graphql"]).toBe(
        externalCrocoRange("@croco/protocols-graphql"),
      );
      expect(graphqlPackageJson.dependencies?.["apollo-server"]).toBeUndefined();
      expect(graphqlPackageJson.scripts?.["contract:check"]).toBe(
        "tsx src/graphql-contract.ts --check",
      );
      expect(graphqlPackageJson.scripts?.["contract:snapshot"]).toBe(
        "tsx src/graphql-contract.ts --write",
      );
      expect(graphqlPackageJson.scripts?.build).toBe(
        "pnpm contract:check && tsup src/index.ts --format cjs --clean",
      );
      expect(graphqlPackageJson.scripts?.typecheck).toBe("pnpm contract:check && tsc --noEmit");
      expect(
        existsSync(join(testDir, "apps", "graphql-api", "graphql-contract.snapshot.json")),
      ).toBe(true);
      expect(existsSync(join(testDir, "apps", "graphql-api", "src", "graphql-contract.ts"))).toBe(
        true,
      );
      expect(graphqlSchemaContent).toContain("function hasRequiredRole");
      expect(graphqlSchemaContent).toContain("hasRequiredRole(resolverData.context, roles)");
      assertSourceBareImportsDeclared(join(testDir, "apps", "graphql-api"));
      expect(apiDockerfileContent).toContain("turbo prune @test/graphql-api --docker");
      expect(apiDockerfileContent).toContain("pnpm turbo build --filter=@test/graphql-api");
      expect(apiDockerfileContent).toContain('CMD ["node", "apps/graphql-api/dist/index.js"]');
      expect(webDockerfileContent).toContain("turbo prune @test/web --docker");
      expect(webDockerfileContent).toContain("pnpm turbo build --filter=@test/web");
      expect(composeContent).toContain("dockerfile: apps/graphql-api/Dockerfile");
      expect(composeContent).toContain('"4000:4000"');
      expect(existsSync(join(testDir, "apps", "api", "Dockerfile"))).toBe(false);
      assertDockerFiltersMatchPackages(testDir);
      assertNoHandlebarsPlaceholders(testDir);
      assertNoTailwindReferences(testDir);
      assertNoExternalCrocoWorkspaceRanges(testDir);
    },
  );

  it("generates ddd-fullstack with trpc nextjs + vercel", { timeout: 120_000 }, async () => {
    const options: GeneratorOptions = {
      projectName: "my-trpc",
      scope: "@test",
      preset: "ddd-fullstack",
      webApps: ["web"],
      api: "trpc",
      apiHosting: "nextjs",
      frontendDeploy: "vercel",
      db: [],
      agentRules: false,
      installDeps: false,
      initGit: false,
    };

    await generate(testDir, options);

    // tRPC nextjs: Next.js 앱에 tRPC 내장
    expect(existsSync(join(testDir, "apps", "web"))).toBe(true);
    const webTsconfig = JSON.parse(
      readFileSync(join(testDir, "apps", "web", "tsconfig.json"), "utf8"),
    ) as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(webTsconfig.compilerOptions?.moduleResolution).toBe("bundler");
    // Vercel config
    expect(existsSync(join(testDir, "apps", "web", "vercel.json"))).toBe(true);
  });

  it(
    "generates ddd-fullstack with Cloudflare Meta Vite declared config imports",
    { timeout: 120_000 },
    async () => {
      const options: GeneratorOptions = {
        projectName: "my-meta-vite",
        scope: "@test",
        preset: "ddd-fullstack",
        webApps: ["web"],
        api: "graphql",
        apiHosting: "standalone",
        frontendDeploy: "cloudflare-meta-vite",
        db: [],
        agentRules: false,
        installDeps: false,
        initGit: false,
      };

      await generate(testDir, options);

      const webDir = join(testDir, "apps", "web");
      const packageJson = readPackageJson(join(webDir, "package.json"));
      const runtimeCapabilityManifest = JSON.parse(
        readFileSync(join(testDir, "croco-runtime-capability.manifest.json"), "utf8"),
      );

      expect(packageJson.dependencies?.["@croco/meta-vite"]).toBe(
        externalCrocoRange("@croco/meta-vite"),
      );
      expect(packageJson.dependencies?.["@croco/problems-core"]).toBe(
        externalCrocoRange("@croco/problems-core"),
      );
      expect(packageJson.scripts?.build).toBe("vite build --outDir dist/client");
      expect(packageJson.scripts?.preview).toBe("vite preview --outDir dist/client");
      expect(packageJson.scripts?.["presentation:smoke"]).toBe(
        "tsx src/smoke/presentationSmoke.ts",
      );
      expect(packageJson.devDependencies?.["happy-dom"]).toBe("^20.10.6");
      expect(packageJson.devDependencies?.tsx).toBe("^4.20.3");
      expect(existsSync(join(webDir, "src", "smoke", "presentationSmoke.ts"))).toBe(true);
      expect(runtimeCapabilityManifest).toMatchObject({
        platform: "node",
        composition: {
          host: { platform: "node", lifecycle: "process", packageName: "@apollo/server" },
          transports: [{ protocol: "graphql", packageName: "@apollo/server" }],
          buildTarget: {
            name: "node-application",
            format: "cjs",
            outputDirectory: "apps/graphql-api/dist",
          },
        },
      });
      assertMetaViteBrowserBuildEntrypoint(webDir, "vite build --outDir dist/client");
      assertViteConfigImportsDeclared(webDir);
      assertSourceBareImportsDeclared(webDir);
      assertNoHandlebarsPlaceholders(testDir);
      assertNoExternalCrocoWorkspaceRanges(testDir);
    },
  );

  it(
    "generates ddd-vike-fullstack with secure worker bootstrap middleware",
    { timeout: 120_000 },
    async () => {
      const options: GeneratorOptions = {
        projectName: "my-vike-fullstack",
        scope: "@test",
        preset: "ddd-vike-fullstack",
        webApps: ["web"],
        frontendDeploy: "cloudflare-meta-vite",
        apiHosting: "standalone",
        db: [],
        agentRules: false,
        installDeps: false,
        initGit: false,
      };

      await generate(testDir, options);

      const workerContent = readFileSync(join(testDir, "api-worker", "src", "index.ts"), "utf8");
      const workerPackageJson = readPackageJson(join(testDir, "api-worker", "package.json"));
      const workspaceConfig = readFileSync(join(testDir, "pnpm-workspace.yaml"), "utf8");
      const workerWranglerConfig = readFileSync(
        join(testDir, "api-worker", "wrangler.toml"),
        "utf8",
      );
      const ssrWorkerDir = join(testDir, "ssr-worker");
      const ssrWorkerPackageJson = readPackageJson(join(ssrWorkerDir, "package.json"));

      expect(workerContent).not.toContain('securityValidation: "off"');
      expect(workerContent).toContain("securityHeadersMiddleware()");
      expect(workerContent).toContain("WEB_ORIGIN?: string");
      expect(workerContent).toContain("corsMiddleware({ origins: [webOrigin] })");
      expect(workerContent).toContain("bodyLimitMiddleware({ limit: mb(1) })");
      expect(workerContent).toContain("rateLimitHttpMiddleware({");
      expect(workerContent).toContain('trustedProxyHeaders: ["x-forwarded-for"]');
      const apiFetchContent = readFileSync(
        join(ssrWorkerDir, "src", "helpers", "apiFetch.ts"),
        "utf8",
      );
      expect(apiFetchContent).toContain(
        'headers.set("X-Forwarded-For", request.headers.get("cf-connecting-ip") ?? "");',
      );
      expect(apiFetchContent).not.toContain('request.headers.get("x-forwarded-for")');
      expect(workerContent).toMatch(
        /new Set\(\[\s*"\/health",\s*"\/health\/live",\s*"\/health\/ready",\s*"\/ready",?\s*\]\)/,
      );
      expect(workerContent).toContain(
        "skip: (ctx) => OPERATIONAL_RATE_LIMIT_BYPASS_PATHS.has(ctx.req.path)",
      );
      expect(workerPackageJson.dependencies?.["@croco/ratelimit-core"]).toBe(
        externalCrocoRange("@croco/ratelimit-core"),
      );
      expect(workspaceConfig).toContain("onlyBuiltDependencies:");
      expect(workspaceConfig).toContain("- workerd");
      expect(workerWranglerConfig).not.toMatch(/^\s*\[build\]\s*$/m);
      expect(ssrWorkerPackageJson.dependencies?.["@croco/meta-vite"]).toBe(
        externalCrocoRange("@croco/meta-vite"),
      );
      expect(ssrWorkerPackageJson.dependencies?.["@croco/problems-core"]).toBe(
        externalCrocoRange("@croco/problems-core"),
      );
      expect(ssrWorkerPackageJson.scripts?.build).toBe(
        "vite build --outDir dist/client && vite build --ssr src/index.ts --outDir dist --emptyOutDir false",
      );
      expect(ssrWorkerPackageJson.scripts?.preview).toBe("vite preview --outDir dist/client");
      expect(ssrWorkerPackageJson.scripts?.["presentation:smoke"]).toBe(
        "tsx src/smoke/presentationSmoke.ts",
      );
      expect(ssrWorkerPackageJson.devDependencies?.["happy-dom"]).toBe("^20.10.6");
      expect(ssrWorkerPackageJson.devDependencies?.tsx).toBe("^4.20.3");
      expect(existsSync(join(ssrWorkerDir, "src", "smoke", "presentationSmoke.ts"))).toBe(true);
      assertMetaViteBrowserBuildEntrypoint(
        ssrWorkerDir,
        "vite build --outDir dist/client && vite build --ssr src/index.ts --outDir dist --emptyOutDir false",
      );
      assertSourceBareImportsDeclared(join(testDir, "api-worker"));
      assertViteConfigImportsDeclared(ssrWorkerDir);
      assertSourceBareImportsDeclared(ssrWorkerDir);
      assertNoHandlebarsPlaceholders(testDir);
      assertNoExternalCrocoWorkspaceRanges(testDir);
    },
  );

  it("generates ddd-api with graphql + lambda + mongodb", { timeout: 120_000 }, async () => {
    const options: GeneratorOptions = {
      projectName: "my-api",
      scope: "@test",
      preset: "ddd-api",
      webApps: [],
      api: "graphql",
      apiHosting: "standalone",
      backendDeploy: "lambda",
      db: ["mongodb"],
      agentRules: false,
      installDeps: false,
      initGit: false,
    };

    await generate(testDir, options);

    // GraphQL API
    expect(existsSync(join(testDir, "apps", "graphql-api"))).toBe(true);
    const handlerContent = readFileSync(
      join(testDir, "apps", "graphql-api", "src", "handler.ts"),
      "utf8",
    );
    const telemetryFlushContent = readFileSync(
      join(testDir, "apps", "graphql-api", "src", "telemetryFlush.ts"),
      "utf8",
    );
    const schemaContent = readFileSync(
      join(testDir, "apps", "graphql-api", "src", "schema.ts"),
      "utf8",
    );
    const packageJson = readPackageJson(join(testDir, "apps", "graphql-api", "package.json"));
    const runtimeCapabilityManifest = JSON.parse(
      readFileSync(join(testDir, "croco-runtime-capability.manifest.json"), "utf8"),
    );
    const databasePackageJson = readPackageJson(
      join(testDir, "libs", "shared", "provider-database", "package.json"),
    );

    expect(handlerContent).toContain('from "@croco/telemetry-sdk-node";');
    expect(handlerContent).toContain('from "@apollo/server";');
    expect(handlerContent).toContain('from "@as-integrations/aws-lambda";');
    expect(handlerContent).toContain('import type { APIGatewayProxyHandlerV2 } from "aws-lambda";');
    expect(handlerContent).toContain(
      'import { createGraphQLContext, createSchema } from "./schema.js";',
    );
    expect(handlerContent).toContain('import type { GraphQLAuthContext } from "./schema.js";');
    expect(handlerContent).toContain("const telemetryReady = telemetry.init(");
    expect(handlerContent).toContain(
      "const lambdaHandlerPromise: Promise<APIGatewayProxyHandlerV2>",
    );
    expect(handlerContent).toContain("await telemetryReady;");
    expect(handlerContent).toContain("const lambdaHandler = await lambdaHandlerPromise;");
    expect(handlerContent).toContain("return runWithTelemetryFlush(");
    expect(packageJson.dependencies?.["@croco/problems-core"]).toBe(
      externalCrocoRange("@croco/problems-core"),
    );
    expect(telemetryFlushContent).toContain('result.outcome === "failed"');
    expect(telemetryFlushContent).toContain('result.outcome === "unsupported"');
    expect(telemetryFlushContent).toContain("new LambdaTelemetryBoundaryProblem(");
    expect(handlerContent).toContain(
      "context: async ({ event }) => createGraphQLContext(event.headers),",
    );
    expect(schemaContent).toContain(
      "export async function createSchema(options: CreateSchemaOptions = {})",
    );
    expect(schemaContent).toContain("function hasRequiredRole");
    expect(schemaContent).toContain("hasRequiredRole(resolverData.context, roles)");
    expect(schemaContent).toContain('const AUTH_TOKEN_ENV = "GRAPHQL_AUTH_TOKEN";');
    expect(schemaContent).not.toContain("generated-smoke-token");
    expect(packageJson.dependencies?.["@apollo/server"]).toBe("^4.12.2");
    expect(packageJson.dependencies?.["@as-integrations/aws-lambda"]).toBe("^3.1.0");
    expect(packageJson.devDependencies?.["@types/aws-lambda"]).toBe("^8.10.146");
    expect(packageJson.dependencies?.["apollo-server"]).toBeUndefined();
    expect(packageJson.dependencies?.["@croco/protocols-graphql"]).toBe(
      externalCrocoRange("@croco/protocols-graphql"),
    );
    expect(packageJson.dependencies?.["@croco/telemetry-sdk-node"]).toBe(
      externalCrocoRange("@croco/telemetry-sdk-node"),
    );
    expect(packageJson.dependencies?.["@test/provider-database"]).toBe("workspace:*");
    expect(databasePackageJson.dependencies?.["drizzle-orm"]).toBe(
      getGeneratedAppDependencyRange("drizzle-orm"),
    );
    expect(packageJson.scripts?.["contract:check"]).toBe("tsx src/graphql-contract.ts --check");
    expect(packageJson.scripts?.["contract:snapshot"]).toBe("tsx src/graphql-contract.ts --write");
    expect(packageJson.scripts?.build).toBe(
      "pnpm contract:check && tsup src/handler.ts --format cjs --clean",
    );
    expect(packageJson.scripts?.typecheck).toBe("pnpm contract:check && tsc --noEmit");
    expect(runtimeCapabilityManifest).toMatchObject({
      platform: "lambda",
      composition: {
        host: {
          platform: "lambda",
          lifecycle: "invocation",
          packageName: "@as-integrations/aws-lambda",
        },
        transports: [{ protocol: "graphql", packageName: "@apollo/server" }],
      },
    });
    expect(schemaContent).toContain('from "./resolvers/health.resolver.js";');
    expect(existsSync(join(testDir, "apps", "graphql-api", "graphql-contract.snapshot.json"))).toBe(
      true,
    );
    expect(existsSync(join(testDir, "apps", "graphql-api", "src", "graphql-contract.ts"))).toBe(
      true,
    );
    assertSourceBareImportsDeclared(join(testDir, "apps", "graphql-api"));
    assertNoExternalCrocoWorkspaceRanges(testDir);

    // Lambda SST
    expect(existsSync(join(testDir, "sst.config.ts"))).toBe(true);
    assertLambdaHandlerTarget(testDir, "apps/graphql-api/src/handler.handler");
    // MongoDB provider
    expect(existsSync(join(testDir, "libs", "shared", "provider-mongodb"))).toBe(true);
    expect(existsSync(join(testDir, "libs", "shared", "utils-env", "tsconfig.json"))).toBe(true);
    expect(existsSync(join(testDir, "libs", "shared", "provider-mongodb", "tsconfig.json"))).toBe(
      true,
    );
  });

  it("generates ddd-api with trpc + lambda handler target", { timeout: 120_000 }, async () => {
    const options: GeneratorOptions = {
      projectName: "my-trpc-api",
      scope: "@test",
      preset: "ddd-api",
      webApps: [],
      api: "trpc",
      apiHosting: "standalone",
      backendDeploy: "lambda",
      db: [],
      agentRules: false,
      installDeps: false,
      initGit: false,
    };

    await generate(testDir, options);

    expect(existsSync(join(testDir, "sst.config.ts"))).toBe(true);
    assertLambdaHandlerTarget(testDir, "apps/api/src/handler.handler");
  });

  it(
    "generates production app starter with operational defaults",
    { timeout: 120_000 },
    async () => {
      const options: GeneratorOptions = {
        projectName: "my-production-app",
        scope: "@test",
        preset: "production-app",
        webApps: [],
        apiHosting: "standalone",
        db: [],
        agentRules: false,
        installDeps: false,
        initGit: false,
      };

      await generate(testDir, options);

      const rootPackageJson = readPackageJson(join(testDir, "package.json"));
      const apiPackageJson = readPackageJson(join(testDir, "apps", "api-server", "package.json"));
      const consolePackageJson = readPackageJson(
        join(testDir, "apps", "console-web", "package.json"),
      );
      const rpcPackageJson = readPackageJson(
        join(testDir, "libs", "shared", "provider-rpc", "package.json"),
      );
      const readme = readFileSync(join(testDir, "README.md"), "utf8");
      const workspaceConfig = readFileSync(join(testDir, "pnpm-workspace.yaml"), "utf8");
      const apiUsersSource = readFileSync(
        join(testDir, "apps", "api-server", "src", "users.ts"),
        "utf8",
      );
      const apiAppSource = readFileSync(
        join(testDir, "apps", "api-server", "src", "app.ts"),
        "utf8",
      );
      const clientSource = readFileSync(
        join(testDir, "apps", "console-web", "src", "api", "client.ts"),
        "utf8",
      );
      const viteConfig = readFileSync(
        join(testDir, "apps", "console-web", "vite.config.ts"),
        "utf8",
      );
      const browserWorkflow = readFileSync(
        join(testDir, ".github", "workflows", "browser-tests.yml"),
        "utf8",
      );

      expect(rootPackageJson.scripts).toMatchObject({
        dev: "turbo dev",
        "dev:smoke":
          "pnpm --filter @test/api-server dev:smoke && pnpm --filter @test/console-web dev:smoke",
        lint: "biome lint .",
        test: "turbo test",
        "test:browser:install": "pnpm --filter @test/console-web test:browser:install",
        "test:component": "pnpm --filter @test/console-web test:component",
        "test:journey": "playwright test",
        "test:ci": "pnpm test:component && pnpm test:journey",
        typecheck: "turbo typecheck",
        "di:graph": "pnpm --filter @test/api-server di:graph",
        "di:check": "croco di check .croco/build/di-graph.manifest.json",
        "di:assert": "node scripts/assert-di-graph.mjs .croco/build/di-graph.manifest.json",
        doctor: "croco doctor --json",
        "di:verify": expect.stringMatching(
          /^pnpm di:check && pnpm di:assert && pnpm project-map:check && pnpm doctor$/,
        ),
      });
      expect(rootPackageJson.scripts?.["contract:client"]).toContain(
        "--problem-runtime frontend-problems",
      );
      expect(rootPackageJson.scripts?.["contract:client"]).toContain(
        "--manifest-bundle .croco/manifest",
      );
      expect(rootPackageJson.scripts?.["contract:client"]).toContain("--strict-schemas");
      expect(apiPackageJson.scripts).toMatchObject({
        "di:graph": GENERATED_API_DI_GRAPH_SCRIPT,
        "dev:smoke": "tsx src/dev-smoke.ts",
        build: "tsup src/index.ts src/lambda.ts --format cjs --clean",
        test: "vitest run",
      });
      expect(apiPackageJson.devDependencies?.["cross-env"]).toBe("^10.1.0");
      expect(apiAppSource).toContain("createCrocoDiGraphRoots");
      expect(apiAppSource).toContain(
        "function createControllerList(options: CreateCrocoAppOptions = {})",
      );
      expect(apiAppSource).toMatch(
        /export function createCrocoDiGraphRoots\(\s*options: CreateCrocoAppOptions = {},\s*\): readonly Constructor\[\]/,
      );
      expect(apiAppSource).toContain("return createControllerList(options);");
      expect(apiAppSource).toContain("const appControllers = createControllerList(options);");
      expect(apiPackageJson.dependencies).toMatchObject({
        "@croco/events-core": externalCrocoRange("@croco/events-core"),
        "@croco/events-inmemory": externalCrocoRange("@croco/events-inmemory"),
        "@croco/problems-core": externalCrocoRange("@croco/problems-core"),
        "@croco/protocols-rest": externalCrocoRange("@croco/protocols-rest"),
        "@croco/repository-core": externalCrocoRange("@croco/repository-core"),
        "@croco/retry-core": externalCrocoRange("@croco/retry-core"),
        "@croco/telemetry-api": externalCrocoRange("@croco/telemetry-api"),
        "@croco/telemetry-sdk-node": externalCrocoRange("@croco/telemetry-sdk-node"),
        "@croco/transports-http": externalCrocoRange("@croco/transports-http"),
      });
      expect(consolePackageJson.dependencies).toMatchObject({
        "@croco/frontend-problems": externalCrocoRange("@croco/frontend-problems"),
      });
      expect(consolePackageJson.scripts).toMatchObject({
        test: "pnpm test:component",
        "test:browser:install": "playwright install chromium",
        "test:component": "vitest run --config vitest.config.ts",
      });
      expect(consolePackageJson.devDependencies).toMatchObject({
        "@vitest/browser-playwright": "4.1.8",
        msw: "2.15.0",
        playwright: "1.62.0",
        vitest: "4.1.8",
        "vitest-browser-react": "2.2.0",
      });
      expect(rpcPackageJson.dependencies).toMatchObject({
        "@croco/frontend-problems": externalCrocoRange("@croco/frontend-problems"),
        "@croco/problems-core": externalCrocoRange("@croco/problems-core"),
      });
      expect(existsSync(join(testDir, "apps", "api-server", "src", "lambda.ts"))).toBe(true);
      expect(existsSync(join(testDir, "apps", "api-server", "src", "env.ts"))).toBe(true);
      expect(existsSync(join(testDir, "apps", "api-server", "src", "problems.ts"))).toBe(true);
      expect(existsSync(join(testDir, "apps", "api-server", "src", "dev-smoke.ts"))).toBe(true);
      expect(existsSync(join(testDir, "sst.config.ts"))).toBe(true);
      assertLambdaHandlerTarget(testDir, "apps/api-server/src/lambda.handler");
      expect(apiUsersSource).toContain("RetryTemplate");
      expect(apiUsersSource).toContain("EventPublisher");
      expect(apiUsersSource).toContain("InMemoryEventBus");
      expect(apiUsersSource).toContain("Repository");
      expect(apiAppSource).toContain("HttpExceptionFilter");
      expect(apiAppSource).toContain("globalFilters: [HttpExceptionFilter]");
      expect(clientSource).toContain("handleJsonResponse");
      expect(clientSource).toContain('const DEFAULT_API_BASE_PATH = "/api/"');
      expect(viteConfig).toContain("path.replace(/^\\/api/, '')");
      expect(browserWorkflow).toContain("shard=${{ matrix.shard }}/2");
      expect(browserWorkflow).toContain("playwright merge-reports");
      assertBrowserWorkflowUsesImmutableActions(browserWorkflow);
      assertBrowserWorkflowUsesLeastPrivilege(browserWorkflow);
      assertBrowserWorkflowVerifiesContractsWithoutCodegen(browserWorkflow);
      expect(workspaceConfig).toContain("msw: true");
      expect(workspaceConfig).toMatch(/onlyBuiltDependencies:[\s\S]*- msw/);
      for (const relativePath of [
        "apps/console-web/vitest.config.ts",
        "apps/console-web/public/mockServiceWorker.js",
        "apps/console-web/src/tests/ProblemNotice.spec.tsx",
        "apps/console-web/src/test/browser.ts",
        "apps/console-web/src/test/server.ts",
        "playwright.config.ts",
        "tests/journeys/create-user.spec.ts",
        "tests/journeys/problem-rendering.spec.ts",
        ".github/workflows/browser-tests.yml",
      ]) {
        expect(existsSync(join(testDir, relativePath))).toBe(true);
      }
      expect(readme).toContain("운영형 앱 스타터");
      expect(readme).toContain("비범위");
      expect(readme).toContain("HttpExceptionFilter");
      expect(readme).toContain("TelemetryRuntime.forceFlush");
      assertNoHandlebarsPlaceholders(testDir);
      assertNoExternalCrocoWorkspaceRanges(testDir);
      assertAllSourceBareImportsDeclared(testDir);
    },
  );

  it(
    "generates admin console preset with generated-client workflow",
    { timeout: 120_000 },
    async () => {
      const options: GeneratorOptions = {
        projectName: "my-admin-console",
        scope: "@test",
        preset: "admin-console",
        webApps: [],
        apiHosting: "standalone",
        db: [],
        agentRules: false,
        installDeps: false,
        initGit: false,
      };

      await generate(testDir, options);

      const rootPackageJson = readPackageJson(join(testDir, "package.json"));
      const apiPackageJson = readPackageJson(join(testDir, "apps", "api-server", "package.json"));
      const consolePackageJson = readPackageJson(
        join(testDir, "apps", "console-web", "package.json"),
      );
      const rpcPackageJson = readPackageJson(
        join(testDir, "libs", "shared", "provider-rpc", "package.json"),
      );
      const readme = readFileSync(join(testDir, "README.md"), "utf8");
      const appSource = readFileSync(join(testDir, "apps", "api-server", "src", "app.ts"), "utf8");
      const webSource = readFileSync(
        join(testDir, "apps", "console-web", "src", "App.tsx"),
        "utf8",
      );
      const viteConfig = readFileSync(
        join(testDir, "apps", "console-web", "vite.config.ts"),
        "utf8",
      );
      const browserWorkflow = readFileSync(
        join(testDir, ".github", "workflows", "browser-tests.yml"),
        "utf8",
      );

      expect(rootPackageJson.scripts).toMatchObject({
        "admin:smoke":
          "pnpm contract:client && pnpm --filter @test/api-server admin:smoke && pnpm --filter @test/console-web admin:smoke",
        typecheck: "pnpm contract:client && turbo typecheck",
        build: "pnpm contract:client && turbo build",
        "test:browser:install": "pnpm --filter @test/console-web test:browser:install",
        "test:component": "pnpm --filter @test/console-web test:component",
        "test:journey": "playwright test",
        "test:ci": "pnpm contract:client && pnpm test:component && pnpm test:journey",
        "contract:client": expect.stringContaining(
          "apps/api-server/src/{controllers/**/*.ts,admin.ts,users.ts,problems.ts}",
        ),
        "di:graph": "pnpm --filter @test/api-server di:graph",
        "di:check": "croco di check .croco/build/di-graph.manifest.json",
        "di:assert": "node scripts/assert-di-graph.mjs .croco/build/di-graph.manifest.json",
        doctor: "croco doctor --json",
        "di:verify": expect.stringMatching(
          /^pnpm di:check && pnpm di:assert && pnpm project-map:check && pnpm doctor$/,
        ),
      });
      expect(rootPackageJson.scripts?.["contract:client"]).toContain(
        "--problem-runtime frontend-problems",
      );
      expect(rootPackageJson.scripts?.["contract:client"]).toContain(
        "--manifest-bundle .croco/manifest",
      );
      expect(rootPackageJson.scripts?.["contract:client"]).toContain("--strict-schemas");
      expect(apiPackageJson.scripts).toMatchObject({
        "di:graph": GENERATED_API_DI_GRAPH_SCRIPT,
        "admin:smoke":
          "tsx src/dev-smoke.ts && tsx src/webhook-smoke.ts && vitest run src/tests/CreditOperations.spec.ts",
      });
      expect(apiPackageJson.devDependencies?.["cross-env"]).toBe("^10.1.0");
      expect(consolePackageJson.dependencies).toMatchObject({
        "@croco/admin-core": externalCrocoRange("@croco/admin-core"),
        "@croco/admin-ops": externalCrocoRange("@croco/admin-ops"),
        "@croco/admin-react": externalCrocoRange("@croco/admin-react"),
        "@croco/events-core": externalCrocoRange("@croco/events-core"),
      });
      expect(apiPackageJson.dependencies).toMatchObject({
        "@croco/admin-core": externalCrocoRange("@croco/admin-core"),
        "@croco/credits-core": externalCrocoRange("@croco/credits-core"),
        "@croco/webhooks-core": externalCrocoRange("@croco/webhooks-core"),
      });
      expect(consolePackageJson.scripts).toMatchObject({
        "admin:smoke": "pnpm dev:smoke",
        test: "pnpm test:component",
        "test:browser:install": "playwright install chromium",
        "test:component": "vitest run --config vitest.config.ts",
      });
      for (const relativePath of [
        "apps/console-web/vitest.config.ts",
        "apps/console-web/public/mockServiceWorker.js",
        "apps/api-server/src/tests/CreditOperations.spec.ts",
        "apps/console-web/src/tests/ProblemNotice.spec.tsx",
        "apps/console-web/src/test/browser.ts",
        "apps/console-web/src/test/server.ts",
        "playwright.config.ts",
        "tests/journeys/create-user.spec.ts",
        "tests/journeys/problem-rendering.spec.ts",
        ".github/workflows/browser-tests.yml",
      ]) {
        expect(existsSync(join(testDir, relativePath))).toBe(true);
      }
      expect(rpcPackageJson.dependencies).toMatchObject({
        "@croco/frontend-problems": externalCrocoRange("@croco/frontend-problems"),
        "@croco/problems-core": externalCrocoRange("@croco/problems-core"),
      });
      expect(appSource).toContain("AdminController");
      expect(appSource).toContain("createCrocoDiGraphRoots");
      expect(appSource).toContain(
        "function createControllerList(options: CreateCrocoAppOptions = {})",
      );
      expect(appSource).toContain(
        "export function createCrocoDiGraphRoots(options: CreateCrocoAppOptions = {})",
      );
      expect(appSource).toContain("return createControllerList(options);");
      expect(appSource).toContain("const appControllers = createControllerList(options);");
      expect(viteConfig).toContain("'/admin': 'http://localhost:3000'");
      expect(browserWorkflow).toContain("shard=${{ matrix.shard }}/2");
      expect(browserWorkflow).toContain("playwright merge-reports");
      assertBrowserWorkflowUsesImmutableActions(browserWorkflow);
      assertBrowserWorkflowUsesLeastPrivilege(browserWorkflow);
      assertBrowserWorkflowVerifiesContractsWithoutCodegen(browserWorkflow);
      expect(webSource).toContain("import { adminClient, type adminRpc }");
      expect(webSource).toContain("adminClient");
      expect(webSource).toContain("adminRpc.ListUsersOutput");
      expect(webSource).toContain("query: { tenantId: selectedTenantId }");
      expect(webSource).toContain("admin-console/invite-failed");
      expect(webSource).toContain("Probe Missing User");
      expect(webSource).toContain("Operations");
      expect(webSource).toContain("TenantWorkspaceDemo");
      expect(webSource).toContain("CreditOperationsDemo");
      expect(webSource).toContain("LifecycleAutomationDemo");
      expect(webSource).toContain("key={selectedTenantId}");
      const lifecycleAutomationSource = readFileSync(
        join(testDir, "apps", "console-web", "src", "LifecycleAutomationDemo.tsx"),
        "utf8",
      );
      const creditOperationsSource = readFileSync(
        join(testDir, "apps", "api-server", "src", "creditOperations.ts"),
        "utf8",
      );
      const creditOperationsSmokeSource = readFileSync(
        join(testDir, "apps", "api-server", "src", "tests", "CreditOperations.spec.ts"),
        "utf8",
      );
      expect(creditOperationsSource).toContain("InMemoryCreditLedgerStore");
      expect(creditOperationsSource).toContain("reserveCredits");
      expect(creditOperationsSource).toContain("commitCredits");
      expect(creditOperationsSource).toContain("refresh-ledger");
      expect(creditOperationsSource).toContain("retry-event-publication");
      expect(creditOperationsSource).toContain('"change-input"');
      expect(creditOperationsSource).toContain("new URLSearchParams");
      expect(creditOperationsSource).toContain("expireCredits");
      expect(creditOperationsSource).toContain("refundCredits");
      expect(creditOperationsSource).toContain("executeCreditOperationsAction");
      expect(creditOperationsSmokeSource).toContain("replayed: true");
      expect(creditOperationsSmokeSource).toContain("credits-core/duplicate-conflict");
      expect(creditOperationsSmokeSource).toContain("credits-core/stale-ledger-position");
      expect(creditOperationsSmokeSource).toContain("credits-core/event-publication-failed");
      expect(creditOperationsSmokeSource.match(/clock: \(\) => now/g)).toHaveLength(4);
      expect(lifecycleAutomationSource).toContain("demo-activate-customer-risk");
      expect(lifecycleAutomationSource).toContain("cooldown-suppression");
      expect(lifecycleAutomationSource).toContain("demo-pause-customer-risk");
      expect(lifecycleAutomationSource).toContain("demo-resume-customer-risk");
      expect(lifecycleAutomationSource).toContain("Only safe condition evidence");
      const tenantWorkspaceSource = readFileSync(
        join(testDir, "apps", "console-web", "src", "TenantWorkspaceDemo.tsx"),
        "utf8",
      );
      const webhookReliabilitySource = readFileSync(
        join(testDir, "apps", "console-web", "src", "WebhookReliabilityDemo.tsx"),
        "utf8",
      );
      const webhookSmokeSource = readFileSync(
        join(testDir, "apps", "api-server", "src", "webhook-smoke.ts"),
        "utf8",
      );
      expect(tenantWorkspaceSource).toContain("createInMemoryTenantBusinessSource");
      expect(tenantWorkspaceSource).toContain("createTenantWorkspaceSourceLoadingSnapshot");
      expect(tenantWorkspaceSource).toContain("TenantBusinessWorkspace");
      expect(tenantWorkspaceSource).toContain("engagement/customer-360");
      expect(tenantWorkspaceSource).toContain("fake-provider-unavailable");
      expect(tenantWorkspaceSource).toContain("Run audited action");
      expect(tenantWorkspaceSource).toContain("lastActionEvidence");
      expect(webhookReliabilitySource).toContain("WebhookReliabilityConsole");
      expect(webhookReliabilitySource).toContain("acceptance-unknown");
      expect(webhookSmokeSource).toContain("FakeOutboundWebhookTransport");
      expect(webhookSmokeSource).toContain("permanent 4xx");
      expect(existsSync(join(testDir, "apps", "api-server", "src", "admin.ts"))).toBe(true);
      expect(
        existsSync(join(testDir, "apps", "api-server", "src", "controllers", "AdminController.ts")),
      ).toBe(true);
      expect(
        existsSync(join(testDir, "apps", "api-server", "src", "tests", "AdminConsole.spec.ts")),
      ).toBe(true);
      expect(readme).toContain("Croco admin console starter");
      expect(readme).toContain("Recovery States");
      expect(readme).toContain("not a marketing landing page");
      assertNoHandlebarsPlaceholders(testDir);
      assertNoExternalCrocoWorkspaceRanges(testDir);
      assertAllSourceBareImportsDeclared(testDir);
    },
  );

  it("generates SaaS preset with runnable demo smoke commands", { timeout: 120_000 }, async () => {
    const options: GeneratorOptions = {
      projectName: "my-saas",
      scope: "@test",
      preset: "saas",
      saasProviderProfile: "saas-cloudflare",
      tenantModel: "workspace",
      webApps: [],
      apiHosting: "standalone",
      db: [],
      agentRules: false,
      installDeps: false,
      initGit: false,
    };

    await generate(testDir, options);

    const rootPackageJson = readPackageJson(join(testDir, "package.json"));
    const apiPackageJson = readPackageJson(join(testDir, "apps", "api-server", "package.json"));
    const rpcPackageJson = readPackageJson(
      join(testDir, "libs", "shared", "provider-rpc", "package.json"),
    );
    const failureDrillSource = readFileSync(
      join(testDir, "apps", "api-server", "src", "demo", "failure-drill-smoke.ts"),
      "utf8",
    );
    const scenarioSource = readFileSync(
      join(testDir, "apps", "api-server", "src", "demo", "scenario.ts"),
      "utf8",
    );
    const readme = readFileSync(join(testDir, "README.md"), "utf8");

    expect(rootPackageJson.engines?.node).toBe(">=22.5");
    expect(readFileSync(join(testDir, ".nvmrc"), "utf8")).toBe("22.5\n");
    expect(readme).toContain("Dependency installation and builds require Node.js >=22.5");
    expect(readme).toContain("nvm use 22.5");

    expect(rootPackageJson.scripts).toMatchObject({
      typecheck: "turbo typecheck",
      build: "turbo build",
      test: "turbo test",
      "demo:seed": "pnpm --filter @test/api-server demo:seed",
      "profile:check": "pnpm --filter @test/api-server profile:check",
      "architecture-policy:check": "croco architecture-policy check --manifest croco.arch.json",
      "runtime-policy:check":
        "croco runtime-policy check --manifest croco-runtime-policy.manifest.json",
      "project-map:write":
        'croco project map --controllers "apps/api-server/src/controllers/**/*.ts" --runtime-policy croco-runtime-policy.manifest.json --provider-profile croco-saas-profile.manifest.json --out croco.project-map.json --manifest-bundle .croco/manifest',
      "project-map:check":
        'croco project map --controllers "apps/api-server/src/controllers/**/*.ts" --runtime-policy croco-runtime-policy.manifest.json --provider-profile croco-saas-profile.manifest.json --check --manifest croco.project-map.json --manifest-bundle .croco/manifest',
      "di:graph": "pnpm --filter @test/api-server di:graph",
      "di:check": "croco di check .croco/build/di-graph.manifest.json",
      "di:assert": "node scripts/assert-di-graph.mjs .croco/build/di-graph.manifest.json",
      doctor: "croco doctor --json",
      "di:verify": expect.stringMatching(
        /^pnpm di:check && pnpm di:assert && pnpm project-map:check && pnpm doctor$/,
      ),
      "profile:smoke:real": "pnpm --filter @test/api-server profile:smoke:real",
      "demo:smoke":
        "pnpm profile:check && pnpm architecture-policy:check && pnpm runtime-policy:check && pnpm contract:check && pnpm --filter @test/api-server demo:smoke && pnpm --filter @test/api-server ops:smoke && pnpm --filter @test/api-server jobs:smoke",
      "demo:scenario":
        "pnpm exec croco generate usage-dashboard --no-page && pnpm --filter @test/api-server demo:scenario",
      "ops:smoke": "pnpm --filter @test/api-server ops:smoke",
      "jobs:smoke": "pnpm --filter @test/api-server jobs:smoke",
      "failure-drill:smoke": "pnpm --filter @test/api-server failure-drill:smoke",
      "failure-drill:integration": "pnpm --filter @test/api-server failure-drill:integration",
    });
    expect(apiPackageJson.dependencies).toMatchObject({
      "@croco/tenant-core": externalCrocoRange("@croco/tenant-core"),
      "@croco/auth-core": externalCrocoRange("@croco/auth-core"),
      "@croco/access-core": externalCrocoRange("@croco/access-core"),
      "@croco/billing-core": externalCrocoRange("@croco/billing-core"),
      "@croco/billing-polar": externalCrocoRange("@croco/billing-polar"),
      "@croco/idempotency-core": externalCrocoRange("@croco/idempotency-core"),
      "@croco/metering-core": externalCrocoRange("@croco/metering-core"),
      "@croco/entitlements-core": externalCrocoRange("@croco/entitlements-core"),
      "@croco/execution-core": externalCrocoRange("@croco/execution-core"),
      "@croco/health-core": externalCrocoRange("@croco/health-core"),
      "@croco/framework-context": externalCrocoRange("@croco/framework-context"),
      "@croco/framework-module": externalCrocoRange("@croco/framework-module"),
      "@croco/diagnostics-core": externalCrocoRange("@croco/diagnostics-core"),
      "@croco/llm-core": externalCrocoRange("@croco/llm-core"),
      "@croco/llm-metering": externalCrocoRange("@croco/llm-metering"),
      "@croco/problems-core": externalCrocoRange("@croco/problems-core"),
      "@croco/protocols-core": externalCrocoRange("@croco/protocols-core"),
      "@croco/ratelimit-core": externalCrocoRange("@croco/ratelimit-core"),
      "@croco/telemetry-api": externalCrocoRange("@croco/telemetry-api"),
      "@croco/telemetry-sdk-node": externalCrocoRange("@croco/telemetry-sdk-node"),
    });
    expect(apiPackageJson.dependencies?.["@croco/testing"]).toBeUndefined();
    expect(rpcPackageJson.dependencies).toMatchObject({
      "@croco/problems-core": externalCrocoRange("@croco/problems-core"),
    });
    expect(apiPackageJson.scripts).toMatchObject({
      "di:graph": GENERATED_SAAS_API_DI_GRAPH_SCRIPT,
      "profile:check": "tsx src/provider-profile-check.ts --mode=manifest",
      "profile:smoke:real": "tsx src/provider-profile-check.ts --mode=real-provider",
    });
    expect(apiPackageJson.devDependencies?.["cross-env"]).toBe("^10.1.0");
    expect(apiPackageJson.devDependencies?.typedi).toBe("^0.10.0");
    expect(apiPackageJson.devDependencies?.["@croco/cli"]).toMatch(/^\^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(apiPackageJson.devDependencies?.["@croco/testing"]).toBe("^0.0.1");
    expect(apiPackageJson.scripts?.["ops:smoke"]).toBe("tsx src/demo/ops-smoke.ts");
    expect(apiPackageJson.scripts?.["jobs:smoke"]).toBe("tsx src/demo/jobs-smoke.ts");
    expect(apiPackageJson.scripts?.["demo:scenario"]).toBe("tsx src/demo/scenario.ts");
    expect(apiPackageJson.scripts?.["demo:usage-recover"]).toBe("tsx src/demo/usage-recover.ts");
    expect(apiPackageJson.scripts?.["failure-drill:smoke"]).toBe(
      "tsx src/demo/failure-drill-smoke.ts",
    );
    expect(apiPackageJson.scripts?.["failure-drill:integration"]).toBe(
      "tsx src/provider-profile-check.ts --mode=real-provider",
    );
    expect(existsSync(join(testDir, "apps", "api-server", "src", "saasDemo.ts"))).toBe(true);
    expect(
      existsSync(join(testDir, "apps", "api-server", "src", "controllers", "monetization.ts")),
    ).toBe(true);
    expect(existsSync(join(testDir, "apps", "api-server", "src", "providerProfiles.ts"))).toBe(
      true,
    );
    expect(
      existsSync(join(testDir, "apps", "api-server", "src", "provider-profile-check.ts")),
    ).toBe(true);
    expect(failureDrillSource).toContain("assertSaasSmokeContract(snapshot)");
    expect(scenarioSource).toContain("croco.saas-golden-path.scenario/v1");
    expect(scenarioSource).toContain("UsageDashboardRuntime");
    expect(scenarioSource).toContain("createUsageDashboardService");
    expect(scenarioSource).toContain("lifecycle");
    expect(scenarioSource).toContain("quotaFailureCode");
    expect(readme).toContain("pnpm demo:scenario");
    expect(readme).toContain("ci-reports/saas-golden-path/scenario.json");
    expect(readme).toContain("CROCO_BILLING_METER_UNBOUND");
    expect(readme).toContain("CROCO_BILLING_PROVIDER_CAPABILITY_MISSING");
    expect(readme).toContain("provider-accepted usage");
    expect(
      existsSync(join(testDir, "apps", "api-server", "src", "generatedSaasProviderProfile.ts")),
    ).toBe(true);
    expect(existsSync(join(testDir, "apps", "api-server", "src", "generatedTenantModel.ts"))).toBe(
      true,
    );
    expect(existsSync(join(testDir, "croco-saas-profile.manifest.json"))).toBe(true);
    expect(existsSync(join(testDir, "croco-tenant-model.manifest.json"))).toBe(true);
    expect(existsSync(join(testDir, "croco-tenant-model.schema.json"))).toBe(true);
    expect(existsSync(join(testDir, "croco.arch.json"))).toBe(true);
    expect(existsSync(join(testDir, "croco-runtime-policy.manifest.json"))).toBe(true);
    expect(existsSync(join(testDir, "croco-runtime-capability.manifest.json"))).toBe(true);
    expect(existsSync(join(testDir, ".env.example"))).toBe(true);
    expect(existsSync(join(testDir, "docs", "provider-profile.md"))).toBe(true);
    expect(existsSync(join(testDir, "docs", "tenant-model-playbook.md"))).toBe(true);
    expect(existsSync(join(testDir, "docs", "secrets-checklist.md"))).toBe(true);
    const profileManifest = JSON.parse(
      readFileSync(join(testDir, "croco-saas-profile.manifest.json"), "utf8"),
    );
    const tenantModelManifest = JSON.parse(
      readFileSync(join(testDir, "croco-tenant-model.manifest.json"), "utf8"),
    );
    const tenantModelSchema = JSON.parse(
      readFileSync(join(testDir, "croco-tenant-model.schema.json"), "utf8"),
    );
    const runtimePolicyManifest = JSON.parse(
      readFileSync(join(testDir, "croco-runtime-policy.manifest.json"), "utf8"),
    );
    const runtimeCapabilityManifest = JSON.parse(
      readFileSync(join(testDir, "croco-runtime-capability.manifest.json"), "utf8"),
    );
    const architecturePolicyManifest = JSON.parse(
      readFileSync(join(testDir, "croco.arch.json"), "utf8"),
    );
    const envExample = readFileSync(join(testDir, ".env.example"), "utf8");
    const providerProfileDocs = readFileSync(join(testDir, "docs", "provider-profile.md"), "utf8");
    const secretsChecklist = readFileSync(join(testDir, "docs", "secrets-checklist.md"), "utf8");
    const tenantModelPlaybook = readFileSync(
      join(testDir, "docs", "tenant-model-playbook.md"),
      "utf8",
    );
    const generatedProfileSource = readFileSync(
      join(testDir, "apps", "api-server", "src", "generatedSaasProviderProfile.ts"),
      "utf8",
    );
    const generatedTenantModelSource = readFileSync(
      join(testDir, "apps", "api-server", "src", "generatedTenantModel.ts"),
      "utf8",
    );

    expect(profileManifest).toMatchObject({
      schemaVersion: "croco.saas-provider-profile/v1",
      schema: {
        id: "https://croco.dev/schemas/saas-provider-profile.v1.json",
        version: "croco.saas-provider-profile/v1",
        supportedVersions: ["croco.saas-provider-profile/v1"],
      },
      profile: {
        name: "saas-cloudflare",
        runtimeTarget: "cloudflare-workers",
      },
      smoke: {
        zeroCredential: "pnpm demo:smoke",
        realProviderOptIn: "SAAS_PROVIDER_PROFILE=saas-cloudflare pnpm profile:smoke:real",
      },
      tenantModel: {
        currentModel: "workspace",
        defaultModel: "org",
        manifest: "croco-tenant-model.manifest.json",
        schema: "croco-tenant-model.schema.json",
        playbook: "docs/tenant-model-playbook.md",
        requiredAdapters: [
          "TenantManager",
          "MembershipManager",
          "InvitationManager",
          "WorkspaceSelectionAdapter",
        ],
      },
    });
    expect(profileManifest).toMatchInlineSnapshot(`
      {
        "capabilities": [
          {
            "capability": "runtime",
            "env": [
              "CLOUDFLARE_ACCOUNT_ID",
            ],
            "notes": "Cloudflare Workers covers runtime.",
            "packageName": "@croco/transports-cloudflare-workers",
            "productionState": "documentation-only",
            "provider": "Cloudflare Workers",
            "status": "documented",
            "zeroCredentialState": "documentation-only",
          },
          {
            "capability": "auth",
            "env": [
              "CLERK_SECRET_KEY",
            ],
            "notes": "Clerk covers auth.",
            "packageName": "@croco/auth-clerk",
            "productionState": "documentation-only",
            "provider": "Clerk",
            "status": "documented",
            "zeroCredentialState": "documentation-only",
          },
          {
            "capability": "persistence",
            "env": [],
            "notes": "Application-defined Worker persistence covers persistence.",
            "productionState": "documentation-only",
            "provider": "Application-defined Worker persistence",
            "status": "documented",
            "zeroCredentialState": "documentation-only",
          },
          {
            "capability": "billing",
            "env": [
              "POLAR_ACCESS_TOKEN",
              "POLAR_WEBHOOK_SECRET",
              "POLAR_PRODUCT_ID_TEAM",
            ],
            "notes": "Polar covers billing.",
            "packageName": "@croco/billing-polar",
            "productionState": "documentation-only",
            "provider": "Polar",
            "status": "documented",
            "zeroCredentialState": "documentation-only",
          },
          {
            "capability": "metering",
            "env": [
              "UPSTASH_REDIS_REST_URL",
              "UPSTASH_REDIS_REST_TOKEN",
            ],
            "notes": "Upstash Redis covers metering.",
            "packageName": "@croco/metering-upstash",
            "productionState": "documentation-only",
            "provider": "Upstash Redis",
            "status": "documented",
            "zeroCredentialState": "documentation-only",
          },
          {
            "capability": "storage",
            "env": [
              "R2_BUCKET",
            ],
            "notes": "Cloudflare R2 covers storage.",
            "packageName": "@croco/storage-r2",
            "productionState": "documentation-only",
            "provider": "Cloudflare R2",
            "status": "documented",
            "zeroCredentialState": "documentation-only",
          },
          {
            "capability": "tasks",
            "env": [
              "UPSTASH_QSTASH_TOKEN",
              "UPSTASH_QSTASH_CURRENT_SIGNING_KEY",
              "UPSTASH_QSTASH_NEXT_SIGNING_KEY",
            ],
            "notes": "QStash covers tasks.",
            "packageName": "@croco/tasks-qstash",
            "productionState": "documentation-only",
            "provider": "QStash",
            "status": "documented",
            "zeroCredentialState": "documentation-only",
          },
          {
            "capability": "telemetry",
            "env": [
              "TELEMETRY_ENABLED",
              "OTEL_EXPORTER_OTLP_ENDPOINT",
            ],
            "notes": "OpenTelemetry fetch export covers telemetry.",
            "packageName": "@croco/telemetry-api",
            "productionState": "documentation-only",
            "provider": "OpenTelemetry fetch export",
            "status": "documented",
            "zeroCredentialState": "documentation-only",
          },
          {
            "capability": "webhookVerification",
            "env": [
              "POLAR_WEBHOOK_SECRET",
              "UPSTASH_QSTASH_CURRENT_SIGNING_KEY",
              "UPSTASH_QSTASH_NEXT_SIGNING_KEY",
            ],
            "notes": "Polar + QStash signatures covers webhookVerification.",
            "productionState": "documentation-only",
            "provider": "Polar + QStash signatures",
            "status": "documented",
            "zeroCredentialState": "documentation-only",
          },
        ],
        "compatibility": {
          "generatedArtifacts": {
            "envExample": ".env.example",
            "manifest": "croco-saas-profile.manifest.json",
            "providerDocs": "docs/provider-profile.md",
            "secretsChecklist": "docs/secrets-checklist.md",
            "source": "apps/api-server/src/generatedSaasProviderProfile.ts",
            "tenantModelManifest": "croco-tenant-model.manifest.json",
            "tenantModelPlaybook": "docs/tenant-model-playbook.md",
            "tenantModelSchema": "croco-tenant-model.schema.json",
          },
          "migration": {
            "guidance": [
              "Keep v1 changes additive unless generated app consumers cannot safely read the new shape.",
              "Bump schemaVersion only with release notes, migration guidance, and croco doctor support for the new version.",
              "Run profile:check, croco doctor, and generated app smoke checks before accepting a manifest version change.",
            ],
            "requiredForVersionChange": true,
          },
          "qualityGates": [
            "profile:check",
            "croco doctor --json",
            "demo:smoke",
          ],
          "requiredCapabilities": [
            "runtime",
            "auth",
            "persistence",
            "billing",
            "metering",
            "storage",
            "tasks",
            "telemetry",
            "webhookVerification",
          ],
          "rules": [
            "croco.saas-provider-profile/v1 changes must be additive for existing fields.",
            "Removing or renaming provider profile fields requires a new schemaVersion and migration notes.",
            "Generated provider manifest, tenant manifest, provider docs, .env.example, and generated TS source must be committed together.",
          ],
        },
        "composition": {
          "executable": false,
          "plugins": [],
        },
        "deployNotes": [
          "Keep generated smoke local; use pnpm profile:smoke:real only after Worker secrets are bound.",
          "Verify Polar and QStash signatures before Worker handlers mutate billing, metering, or task state.",
          "Flush telemetry through the Worker request lifecycle instead of AWS exec-wrapper style boot hooks.",
          "Run pnpm profile:check in CI and fail deployment when runtimeTarget or required capabilities drift.",
        ],
        "env": {
          "optional": [
            {
              "description": "Opt-in local HTTP demo endpoints.",
              "example": "false",
              "name": "SAAS_DEMO_ENDPOINTS_ENABLED",
              "requiredForRealProvider": false,
              "secret": false,
            },
            {
              "description": "Runtime environment used for production defaults and telemetry sampling.",
              "example": "development",
              "name": "NODE_ENV",
              "requiredForRealProvider": false,
              "secret": false,
            },
            {
              "description": "Port used by the generated Node API server.",
              "example": "3000",
              "name": "PORT",
              "requiredForRealProvider": false,
              "secret": false,
            },
            {
              "description": "Browser origin allowed by the generated API CORS policy.",
              "example": "http://localhost:5173",
              "name": "WEB_ORIGIN",
              "requiredForRealProvider": false,
              "secret": false,
            },
            {
              "description": "Enable OpenTelemetry exporter wiring.",
              "example": "true",
              "name": "TELEMETRY_ENABLED",
              "requiredForRealProvider": false,
              "secret": false,
            },
            {
              "description": "OTLP endpoint used by telemetry init and flush.",
              "example": "http://localhost:4318",
              "name": "OTEL_EXPORTER_OTLP_ENDPOINT",
              "requiredForRealProvider": false,
              "secret": false,
            },
            {
              "description": "Optional trace-specific OTLP endpoint that overrides the shared OTLP endpoint.",
              "example": "http://localhost:4318/v1/traces",
              "name": "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
              "requiredForRealProvider": false,
              "secret": false,
            },
          ],
          "required": [
            {
              "description": "Selected generated provider profile name.",
              "name": "SAAS_PROVIDER_PROFILE",
              "requiredForRealProvider": true,
              "secret": false,
            },
            {
              "description": "Cloudflare account id for Workers and R2.",
              "name": "CLOUDFLARE_ACCOUNT_ID",
              "requiredForRealProvider": true,
              "secret": true,
            },
            {
              "description": "Cloudflare deploy token.",
              "name": "CLOUDFLARE_API_TOKEN",
              "requiredForRealProvider": true,
              "secret": true,
            },
            {
              "description": "R2 bucket name for object storage.",
              "name": "R2_BUCKET",
              "requiredForRealProvider": true,
              "secret": false,
            },
            {
              "description": "Clerk backend secret key.",
              "name": "CLERK_SECRET_KEY",
              "requiredForRealProvider": true,
              "secret": true,
            },
            {
              "description": "Polar API access token.",
              "name": "POLAR_ACCESS_TOKEN",
              "requiredForRealProvider": true,
              "secret": true,
            },
            {
              "description": "Polar webhook signature secret.",
              "name": "POLAR_WEBHOOK_SECRET",
              "requiredForRealProvider": true,
              "secret": true,
            },
            {
              "description": "Polar product id for the team plan.",
              "name": "POLAR_PRODUCT_ID_TEAM",
              "requiredForRealProvider": true,
              "secret": false,
            },
            {
              "description": "Upstash Redis REST URL for metering state.",
              "name": "UPSTASH_REDIS_REST_URL",
              "requiredForRealProvider": true,
              "secret": true,
            },
            {
              "description": "Upstash Redis REST token.",
              "name": "UPSTASH_REDIS_REST_TOKEN",
              "requiredForRealProvider": true,
              "secret": true,
            },
            {
              "description": "QStash token for task delivery.",
              "name": "UPSTASH_QSTASH_TOKEN",
              "requiredForRealProvider": true,
              "secret": true,
            },
            {
              "description": "Current QStash webhook signing key.",
              "name": "UPSTASH_QSTASH_CURRENT_SIGNING_KEY",
              "requiredForRealProvider": true,
              "secret": true,
            },
            {
              "description": "Next QStash webhook signing key.",
              "name": "UPSTASH_QSTASH_NEXT_SIGNING_KEY",
              "requiredForRealProvider": true,
              "secret": true,
            },
          ],
        },
        "packages": [
          "@croco/preset-cloudflare",
          "@croco/transports-cloudflare-workers",
          "@croco/auth-clerk",
          "@croco/billing-polar",
          "@croco/metering-upstash",
          "@croco/storage-r2",
          "@croco/tasks-qstash",
          "@croco/triggers-qstash",
          "@clerk/backend",
          "@polar-sh/sdk",
          "@upstash/qstash",
          "@upstash/redis",
        ],
        "profile": {
          "description": "Cloudflare Workers profile with Clerk auth, Polar billing, Upstash metering/tasks, R2 storage, and explicit Worker runtime limits.",
          "displayName": "Cloudflare SaaS",
          "name": "saas-cloudflare",
          "runtimeTarget": "cloudflare-workers",
        },
        "schema": {
          "id": "https://croco.dev/schemas/saas-provider-profile.v1.json",
          "supportedVersions": [
            "croco.saas-provider-profile/v1",
          ],
          "version": "croco.saas-provider-profile/v1",
        },
        "schemaVersion": "croco.saas-provider-profile/v1",
        "smoke": {
          "realProviderOptIn": "SAAS_PROVIDER_PROFILE=saas-cloudflare pnpm profile:smoke:real",
          "zeroCredential": "pnpm demo:smoke",
        },
        "tenantModel": {
          "currentModel": "workspace",
          "defaultModel": "org",
          "manifest": "croco-tenant-model.manifest.json",
          "playbook": "docs/tenant-model-playbook.md",
          "requiredAdapters": [
            "TenantManager",
            "MembershipManager",
            "InvitationManager",
            "WorkspaceSelectionAdapter",
          ],
          "requiredCapabilities": [
            "tenant-context",
            "tenant-identity",
            "membership",
            "workspace-selection",
            "migration-plan",
          ],
          "requiredPackages": [
            "@croco/tenant-core",
            "@croco/membership-core",
            "@croco/invitation-core",
          ],
          "schema": "croco-tenant-model.schema.json",
        },
      }
    `);
    expect(tenantModelManifest).toMatchObject({
      schemaVersion: "croco.tenant-model/v1",
      currentModel: "workspace",
      defaultModel: "org",
      selected: {
        name: "workspace",
        tenantKey: "workspaceId",
      },
      schema: {
        file: "croco-tenant-model.schema.json",
        version: "croco.tenant-model/v1",
      },
      migration: {
        from: "org",
        to: "workspace",
        risk: "low",
      },
    });
    expect(tenantModelManifest).toMatchInlineSnapshot(`
      {
        "compatibility": {
          "currentVersion": "croco.tenant-model/v1",
          "generatedArtifacts": {
            "manifest": "croco-tenant-model.manifest.json",
            "playbook": "docs/tenant-model-playbook.md",
            "schema": "croco-tenant-model.schema.json",
            "source": "apps/api-server/src/generatedTenantModel.ts",
          },
          "migration": {
            "guidance": [
              "Bump schemaVersion only when existing tenant manifest consumers cannot safely read the new shape.",
              "Ship migration guidance before generated apps start emitting the new tenant manifest version.",
              "Run profile:check and croco doctor on generated apps before accepting the version change.",
            ],
            "requiredForVersionChange": true,
          },
          "rules": [
            "croco.tenant-model/v1 changes must be additive for existing fields.",
            "Removing or renaming tenant model fields requires a new schemaVersion and migration notes.",
            "Generated croco-tenant-model.manifest.json, croco-tenant-model.schema.json, docs/tenant-model-playbook.md, and generatedTenantModel.ts must be committed together.",
          ],
          "schemaId": "https://croco.dev/schemas/tenant-model-manifest.v1.json",
          "supportedVersions": [
            "croco.tenant-model/v1",
          ],
        },
        "currentModel": "workspace",
        "defaultModel": "org",
        "diagnostics": [
          {
            "code": "tenant-core/tenant-model-manual-migration-required",
            "message": "Moving historical rows between workspaces can change entitlement and audit semantics.",
            "recovery": "Write an explicit migration runbook, backfill evidence, and rollback plan before changing production tenant isolation.",
            "severity": "warning",
          },
        ],
        "migration": {
          "from": "org",
          "manualSteps": [
            "Inventory existing tenant-owned resources before changing the manifest from 'org' to 'workspace'.",
            "Choose a deterministic default workspace for each existing organization.",
            "Backfill workspace ids onto tenant-owned resources before exposing workspace switching.",
            "Keep an audit trail for rows moved between workspaces.",
            "Run generated contract checks and tenant isolation fixtures before accepting writes in the new model.",
            "Commit the updated croco-tenant-model.manifest.json and docs/tenant-model-playbook.md together.",
          ],
          "risk": "low",
          "to": "workspace",
          "warnings": [
            {
              "code": "tenant-core/tenant-model-manual-migration-required",
              "message": "Moving historical rows between workspaces can change entitlement and audit semantics.",
              "recovery": "Write an explicit migration runbook, backfill evidence, and rollback plan before changing production tenant isolation.",
            },
          ],
        },
        "models": [
          {
            "displayName": "Single tenant",
            "isolation": "none",
            "migrationHints": [
              "Create one tenant record that represents the current deployment.",
              "Backfill future tenant-owned rows with that tenant id before enabling scoped queries.",
            ],
            "name": "single",
            "requiredAdapters": [
              "TenantManager",
            ],
            "requiredCapabilities": [
              "tenant-context",
              "migration-plan",
            ],
            "requiredPackages": [
              "@croco/tenant-core",
            ],
            "schemaHints": [
              "Do not add tenant discriminator columns to domain tables.",
              "Keep admin-only data export available so the app can move to an org or workspace model later.",
            ],
            "summary": "One logical tenant for the whole application. Use this while product-market fit matters more than tenant administration.",
            "supportedRuntimeTargets": [
              "node",
              "cloudflare-workers",
              "lambda",
            ],
            "tenantKey": "none",
            "unsafeMigrationWarnings": [],
          },
          {
            "displayName": "Organization",
            "isolation": "membership",
            "migrationHints": [
              "Create organization records for each existing account owner or billing account.",
              "Backfill memberships before enforcing tenant-required routes.",
              "Run cross-tenant leak fixtures before removing single-tenant fallbacks.",
            ],
            "name": "org",
            "requiredAdapters": [
              "TenantManager",
              "MembershipManager",
              "InvitationManager",
            ],
            "requiredCapabilities": [
              "tenant-context",
              "tenant-identity",
              "membership",
              "migration-plan",
            ],
            "requiredPackages": [
              "@croco/tenant-core",
              "@croco/membership-core",
              "@croco/invitation-core",
            ],
            "schemaHints": [
              "Create an organizations table or provider-backed organization mapping.",
              "Store membership and invitation records by organization id.",
              "Bind request context from an explicit organization selector, auth claim, header, or route segment.",
            ],
            "summary": "A SaaS organization owns memberships, invitations, billing, and default tenant context for most B2B apps.",
            "supportedRuntimeTargets": [
              "node",
              "cloudflare-workers",
              "lambda",
            ],
            "tenantKey": "organizationId",
            "unsafeMigrationWarnings": [
              "Do not infer organization ownership only from email domains without an explicit admin review.",
            ],
          },
          {
            "displayName": "Workspace",
            "isolation": "membership",
            "migrationHints": [
              "Choose a deterministic default workspace for each existing organization.",
              "Backfill workspace ids onto tenant-owned resources before exposing workspace switching.",
              "Keep an audit trail for rows moved between workspaces.",
            ],
            "name": "workspace",
            "requiredAdapters": [
              "TenantManager",
              "MembershipManager",
              "InvitationManager",
              "WorkspaceSelectionAdapter",
            ],
            "requiredCapabilities": [
              "tenant-context",
              "tenant-identity",
              "membership",
              "workspace-selection",
              "migration-plan",
            ],
            "requiredPackages": [
              "@croco/tenant-core",
              "@croco/membership-core",
              "@croco/invitation-core",
            ],
            "schemaHints": [
              "Create workspaces beneath organizations or accounts.",
              "Persist the active workspace id separately from user authentication state.",
              "Scope feature flags, entitlement checks, and generated RPC clients to the active workspace.",
            ],
            "summary": "A user can belong to multiple workspaces inside an organization. Use this when collaboration spaces need isolated configuration or data.",
            "supportedRuntimeTargets": [
              "node",
              "cloudflare-workers",
              "lambda",
            ],
            "tenantKey": "workspaceId",
            "unsafeMigrationWarnings": [
              "Moving historical rows between workspaces can change entitlement and audit semantics.",
            ],
          },
          {
            "displayName": "Shared schema",
            "isolation": "tenant-column",
            "migrationHints": [
              "Classify every table as global, tenant-owned, or join data before adding columns.",
              "Backfill tenant ids in a locked or dual-write phase.",
              "Fail reads and writes that omit tenant predicates.",
            ],
            "name": "shared-schema",
            "requiredAdapters": [
              "TenantContextProvider",
              "TenantFilteredRepository",
            ],
            "requiredCapabilities": [
              "tenant-context",
              "tenant-identity",
              "tenant-discriminator",
              "tenant-query-filter",
              "migration-plan",
            ],
            "requiredPackages": [
              "@croco/tenant-core",
              "@croco/tx-core",
            ],
            "schemaHints": [
              "Add a non-null tenant id column to every tenant-owned table.",
              "Index tenant id with hot-path lookup keys.",
              "Require repository/query helpers to prove tenant predicates before execution.",
            ],
            "summary": "All tenants share the same database schema and every tenant-owned table carries a tenant discriminator column.",
            "supportedRuntimeTargets": [
              "node",
              "cloudflare-workers",
              "lambda",
            ],
            "tenantKey": "tenantId",
            "unsafeMigrationWarnings": [
              "A nullable tenant discriminator is an unsafe intermediate state unless writes are frozen.",
              "Global tables must be explicitly marked global instead of silently skipping tenant checks.",
            ],
          },
          {
            "displayName": "RLS-backed",
            "isolation": "postgres-rls",
            "migrationHints": [
              "Add tenant id columns and indexes before enabling RLS.",
              "Create policies in report-only or locked maintenance windows first.",
              "Verify adapter-provided TenantRlsEvidence matches the active tenant before release.",
            ],
            "name": "rls-backed",
            "requiredAdapters": [
              "TenantContextProvider",
              "DrizzleTenantSession",
              "TenantRlsEvidence",
            ],
            "requiredCapabilities": [
              "tenant-context",
              "tenant-identity",
              "tenant-discriminator",
              "tenant-query-filter",
              "postgres-rls",
              "migration-plan",
            ],
            "requiredPackages": [
              "@croco/tenant-core",
              "@croco/tx-core",
              "@croco/tx-drizzle",
              "drizzle-orm",
            ],
            "schemaHints": [
              "Use Postgres tables with non-null tenant id columns for tenant-owned rows.",
              "Set the current tenant through a transaction-scoped database setting before queries run.",
              "Enable and force RLS policies before treating the provider as production-ready.",
            ],
            "summary": "Postgres row-level security enforces tenant isolation in the database in addition to application-level tenant context.",
            "supportedRuntimeTargets": [
              "node",
            ],
            "tenantKey": "tenantId",
            "unsafeMigrationWarnings": [
              "Do not enable RLS without proving every write path sets the current tenant database setting.",
              "Do not deploy RLS-backed mode on runtimes without a Postgres transaction boundary.",
            ],
          },
        ],
        "qualityGates": [
          "profile:check",
          "contract:verify",
          "demo:smoke",
        ],
        "schema": {
          "file": "croco-tenant-model.schema.json",
          "version": "croco.tenant-model/v1",
        },
        "schemaVersion": "croco.tenant-model/v1",
        "selected": {
          "displayName": "Workspace",
          "isolation": "membership",
          "migrationHints": [
            "Choose a deterministic default workspace for each existing organization.",
            "Backfill workspace ids onto tenant-owned resources before exposing workspace switching.",
            "Keep an audit trail for rows moved between workspaces.",
          ],
          "name": "workspace",
          "requiredAdapters": [
            "TenantManager",
            "MembershipManager",
            "InvitationManager",
            "WorkspaceSelectionAdapter",
          ],
          "requiredCapabilities": [
            "tenant-context",
            "tenant-identity",
            "membership",
            "workspace-selection",
            "migration-plan",
          ],
          "requiredPackages": [
            "@croco/tenant-core",
            "@croco/membership-core",
            "@croco/invitation-core",
          ],
          "schemaHints": [
            "Create workspaces beneath organizations or accounts.",
            "Persist the active workspace id separately from user authentication state.",
            "Scope feature flags, entitlement checks, and generated RPC clients to the active workspace.",
          ],
          "summary": "A user can belong to multiple workspaces inside an organization. Use this when collaboration spaces need isolated configuration or data.",
          "supportedRuntimeTargets": [
            "node",
            "cloudflare-workers",
            "lambda",
          ],
          "tenantKey": "workspaceId",
          "unsafeMigrationWarnings": [
            "Moving historical rows between workspaces can change entitlement and audit semantics.",
          ],
        },
      }
    `);
    expect(tenantModelSchema).toMatchInlineSnapshot(`
      {
        "$id": "https://croco.dev/schemas/tenant-model-manifest.v1.json",
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {
          "compatibility": {
            "required": [
              "schemaId",
              "currentVersion",
              "supportedVersions",
              "rules",
              "generatedArtifacts",
              "migration",
            ],
            "type": "object",
          },
          "currentModel": {
            "enum": [
              "single",
              "org",
              "workspace",
              "shared-schema",
              "rls-backed",
            ],
          },
          "defaultModel": {
            "const": "org",
          },
          "migration": {
            "required": [
              "from",
              "to",
              "risk",
              "manualSteps",
              "warnings",
            ],
            "type": "object",
          },
          "models": {
            "minItems": 5,
            "type": "array",
          },
          "schemaVersion": {
            "const": "croco.tenant-model/v1",
          },
          "selected": {
            "required": [
              "name",
              "displayName",
              "summary",
              "tenantKey",
              "isolation",
              "requiredPackages",
              "requiredAdapters",
              "requiredCapabilities",
              "supportedRuntimeTargets",
              "schemaHints",
              "migrationHints",
              "unsafeMigrationWarnings",
            ],
            "type": "object",
          },
        },
        "required": [
          "schemaVersion",
          "currentModel",
          "defaultModel",
          "selected",
          "models",
          "migration",
          "compatibility",
        ],
        "title": "Croco Tenant Model Manifest",
        "type": "object",
      }
    `);
    expect(tenantModelManifest.models.map((model: { name: string }) => model.name)).toEqual([
      "single",
      "org",
      "workspace",
      "shared-schema",
      "rls-backed",
    ]);
    expect(tenantModelSchema.properties.currentModel).toEqual({
      enum: ["single", "org", "workspace", "shared-schema", "rls-backed"],
    });
    expect(runtimePolicyManifest).toMatchObject({
      schemaVersion: "croco.runtime-policy/v1",
      runtime: {
        platform: "cloudflare-workers",
        source: {
          file: "croco-saas-profile.manifest.json",
          symbol: "saas-cloudflare",
        },
      },
      table: {
        plans: [],
      },
    });
    expect(runtimeCapabilityManifest).toMatchObject({
      version: "croco.runtime-capability.manifest.v1",
      platform: "cloudflare-workers",
      composition: {
        host: {
          platform: "cloudflare-workers",
          lifecycle: "fetch",
        },
        transports: [
          {
            protocol: "http",
            packageName: "@croco/transports-http",
          },
        ],
        buildTarget: {
          name: "cloudflare-worker",
          format: "esm",
          outputDirectory: "apps/api-server/dist",
          constraints: ["no-node-builtins", "web-standard-apis"],
        },
      },
      capabilities: {
        env: true,
        filesystem: false,
        logger: true,
        nodeApi: false,
        requestLifecycle: true,
        trace: true,
        waitUntil: true,
        flush: false,
        streamingResponse: true,
        deadline: false,
        abortSignal: true,
        shutdown: false,
      },
      diagnostics: [],
    });
    expect(architecturePolicyManifest).toMatchObject({
      schemaVersion: "croco.architecture-policy/v1",
      policyName: "my-saas-generated-app",
      packageRoots: ["apps", "libs"],
      rules: {
        allowedGroupImports: expect.arrayContaining([
          expect.objectContaining({
            id: "generated-app-layer-edges",
            allowPackages: ["@test/provider-rpc"],
          }),
        ]),
        publicEntrypoints: expect.objectContaining({
          id: "generated-app-public-entrypoints",
        }),
      },
    });
    expect(profileManifest.packages).toEqual(
      expect.arrayContaining([
        "@croco/transports-cloudflare-workers",
        "@croco/auth-clerk",
        "@croco/billing-polar",
        "@croco/metering-upstash",
        "@croco/storage-r2",
        "@croco/tasks-qstash",
      ]),
    );
    for (const packageName of [
      ...(profileManifest.packages as string[]),
      ...(profileManifest.tenantModel.requiredPackages as string[]),
    ]) {
      expect(apiPackageJson.dependencies?.[packageName], packageName).toEqual(expect.any(String));
    }
    expect(apiPackageJson.dependencies).toMatchObject({
      "@croco/preset-cloudflare": externalCrocoRange("@croco/preset-cloudflare"),
      "@croco/auth-clerk": externalCrocoRange("@croco/auth-clerk"),
      "@croco/billing-polar": externalCrocoRange("@croco/billing-polar"),
      "@croco/metering-upstash": externalCrocoRange("@croco/metering-upstash"),
      "@croco/storage-r2": externalCrocoRange("@croco/storage-r2"),
      "@croco/tasks-qstash": externalCrocoRange("@croco/tasks-qstash"),
      "@croco/triggers-qstash": externalCrocoRange("@croco/triggers-qstash"),
      "@clerk/backend": "^1.0.0",
      "@polar-sh/sdk": "^0.32.2",
      "@upstash/qstash": "^2.9.0",
      "@upstash/redis": "^1.34.0",
    });
    expect(profileManifest.compatibility.requiredCapabilities).toEqual([
      "runtime",
      "auth",
      "persistence",
      "billing",
      "metering",
      "storage",
      "tasks",
      "telemetry",
      "webhookVerification",
    ]);
    expect(envExample).toContain("# SAAS_PROVIDER_PROFILE=saas-cloudflare");
    expect(envExample).toContain("# CLOUDFLARE_ACCOUNT_ID=<croco-secret:CLOUDFLARE_ACCOUNT_ID>");
    expect(envExample).toContain("# R2_BUCKET=<croco-config:R2_BUCKET>");
    expect(existsSync(join(testDir, ".env"))).toBe(false);
    expect(providerProfileDocs).toContain("Capability Matrix");
    expect(providerProfileDocs).toContain("Manifest Contract");
    expect(providerProfileDocs).toContain("Schema version: `croco.saas-provider-profile/v1`");
    expect(providerProfileDocs).toContain("Policy version: `croco.secret-placeholder-policy/v1`");
    expect(providerProfileDocs).toContain("`<croco-secret:CLOUDFLARE_API_TOKEN>`");
    expect(secretsChecklist).toContain("`<croco-secret:CLOUDFLARE_API_TOKEN>`");
    expect(secretsChecklist).toContain("`<croco-config:R2_BUCKET>`");
    expect(providerProfileDocs).toContain("Tenant model: `workspace`");
    expect(providerProfileDocs).toContain("QStash");
    expect(tenantModelPlaybook).toContain("Current model: `workspace`");
    expect(tenantModelPlaybook).toContain("## Manifest Versioning");
    expect(tenantModelPlaybook).toContain("Current version: `croco.tenant-model/v1`");
    expect(tenantModelPlaybook).toContain("Tenant model migration: org -> workspace");
    expect(tenantModelPlaybook).toContain("tenant-core/tenant-model-runtime-incompatible");
    expect(generatedProfileSource).toContain("saas-cloudflare");
    expect(generatedProfileSource).toContain("generatedSaasProviderProfileDocs");
    expect(generatedProfileSource).toContain("generatedSaasProviderProfileEnvExample");
    expect(generatedProfileSource).toContain("generatedSaasProviderSecretsChecklist");
    expect(generatedProfileSource).toContain(JSON.stringify(providerProfileDocs));
    expect(generatedProfileSource).toContain(JSON.stringify(envExample));
    expect(generatedProfileSource).toContain(JSON.stringify(secretsChecklist));
    const providerProfileCheckSource = readFileSync(
      join(testDir, "apps", "api-server", "src", "provider-profile-check.ts"),
      "utf8",
    );
    expect(providerProfileCheckSource).toContain("CROCO_SAAS_PROFILE_VERSION_UNSUPPORTED");
    expect(providerProfileCheckSource).toContain("CROCO_SAAS_PROFILE_ENV_EXAMPLE_DRIFT");
    expect(providerProfileCheckSource).toContain("CROCO_SAAS_PROFILE_SECRETS_CHECKLIST_DRIFT");
    expect(providerProfileCheckSource).toContain("CROCO_TENANT_MODEL_VERSION_UNSUPPORTED");
    expect(generatedTenantModelSource).toContain("generatedTenantModelManifest");
    expect(generatedTenantModelSource).toContain('"workspace"');
    expectGeneratedProfileCheckPass(testDir);
    expectGeneratedProfileCheckFailureAfterWrite(
      testDir,
      "docs/provider-profile.md",
      (source) => `${source}\n`,
      "CROCO_SAAS_PROFILE_DOCS_DRIFT",
    );
    expectGeneratedProfileCheckFailureAfterWrite(
      testDir,
      ".env.example",
      (source) => `${source}\n`,
      "CROCO_SAAS_PROFILE_ENV_EXAMPLE_DRIFT",
    );
    expectGeneratedProfileCheckFailureAfterWrite(
      testDir,
      "docs/secrets-checklist.md",
      (source) => `${source}\n`,
      "CROCO_SAAS_PROFILE_SECRETS_CHECKLIST_DRIFT",
    );
    expectGeneratedProfileCheckFailureAfterWrite(
      testDir,
      "croco-saas-profile.manifest.json",
      (source) =>
        source.replace(
          '"displayName": "Cloudflare SaaS"',
          '"displayName": "Cloudflare SaaS Drift"',
        ),
      "CROCO_SAAS_PROFILE_MANIFEST_DRIFT",
    );
    expectGeneratedProfileCheckFailureAfterWrite(
      testDir,
      "croco-tenant-model.schema.json",
      (source) =>
        source.replace(
          '"title": "Croco Tenant Model Manifest"',
          '"title": "Drifted Tenant Model Manifest"',
        ),
      "CROCO_TENANT_MODEL_SCHEMA_DRIFT",
    );
    expectGeneratedProfileCheckFailureAfterWrite(
      testDir,
      "docs/tenant-model-playbook.md",
      (source) => `${source}\n`,
      "CROCO_TENANT_MODEL_PLAYBOOK_DRIFT",
    );
    expectGeneratedProfileCheckPass(testDir);
    expect(
      existsSync(join(testDir, "apps", "api-server", "src", "demo", "saasSmokeContract.ts")),
    ).toBe(true);
    expect(existsSync(join(testDir, "apps", "api-server", "src", "demo", "ops-smoke.ts"))).toBe(
      true,
    );
    expect(
      existsSync(join(testDir, "apps", "api-server", "src", "controllers", "SaasController.ts")),
    ).toBe(true);
    expect(
      existsSync(
        join(testDir, "apps", "api-server", "src", "controllers", "OperationsController.ts"),
      ),
    ).toBe(true);
    expect(
      existsSync(join(testDir, "apps", "api-server", "src", "controllers", "JobsController.ts")),
    ).toBe(true);
    expect(
      existsSync(join(testDir, "apps", "api-server", "src", "tests", "SaasDemo.spec.ts")),
    ).toBe(true);
    expect(existsSync(join(testDir, "libs", "shared", "provider-rpc"))).toBe(true);
    assertNoHandlebarsPlaceholders(testDir);
    assertNoExternalCrocoWorkspaceRanges(testDir);
    assertAllSourceBareImportsDeclared(testDir);
  });

  it.each([
    {
      profile: "saas-node-postgres" as const,
      platform: "node",
      lifecycle: "process",
      hostPackage: "@croco/preset-node",
      entry: "./src/index.ts",
      build: "tsup src/index.ts --format esm,cjs --clean --dts",
      buildFormat: "dual",
      source: "index.ts",
      canonicalHost: "createNodeHost",
    },
    {
      profile: "saas-lambda" as const,
      platform: "lambda",
      lifecycle: "invocation",
      hostPackage: "@croco/preset-lambda",
      entry: "./src/lambda.ts",
      build: "tsup src/lambda.ts --format cjs --clean --dts",
      buildFormat: "cjs",
      source: "lambda.ts",
      canonicalHost: "createLambdaHost",
    },
    {
      profile: "saas-cloudflare" as const,
      platform: "cloudflare-workers",
      lifecycle: "fetch",
      hostPackage: "@croco/preset-cloudflare",
      entry: "./src/worker.ts",
      build: "tsup src/worker.ts --format esm --platform browser --clean --dts",
      buildFormat: "esm",
      source: "worker.ts",
      canonicalHost: "createCloudflareWorkersHost",
    },
  ])(
    "emits a deployable $profile host artifact that matches runtime composition metadata",
    { timeout: 120_000 },
    async ({
      profile,
      platform,
      lifecycle,
      hostPackage,
      entry,
      build,
      buildFormat,
      source,
      canonicalHost,
    }) => {
      const options: GeneratorOptions = {
        projectName: `my-${profile}`,
        scope: "@test",
        preset: "saas",
        saasProviderProfile: profile,
        tenantModel: "workspace",
        webApps: [],
        apiHosting: "standalone",
        db: [],
        agentRules: false,
        installDeps: false,
        initGit: false,
      };

      await generate(testDir, options);

      const apiPackageJson = readPackageJson(join(testDir, "apps", "api-server", "package.json"));
      const hostSource = readFileSync(join(testDir, "apps", "api-server", "src", source), "utf8");
      const runtimeCapabilityManifest = JSON.parse(
        readFileSync(join(testDir, "croco-runtime-capability.manifest.json"), "utf8"),
      );

      expect(apiPackageJson.main).toBe(entry);
      expect(apiPackageJson.scripts?.build).toBe(build);
      expect(apiPackageJson.dependencies?.[hostPackage]).toBeDefined();
      expect(hostSource).toContain(canonicalHost);
      for (const candidate of ["index.ts", "lambda.ts", "worker.ts"]) {
        expect(existsSync(join(testDir, "apps", "api-server", "src", candidate))).toBe(
          candidate === source,
        );
      }
      expect(existsSync(join(testDir, "apps", "api-server", "src", "telemetry.ts"))).toBe(
        platform !== "cloudflare-workers",
      );
      expect(runtimeCapabilityManifest).toMatchObject({
        platform,
        composition: {
          host: { platform, lifecycle, packageName: hostPackage },
          transports: [{ protocol: "http", packageName: "@croco/transports-http" }],
          buildTarget: {
            format: buildFormat,
            outputDirectory: "apps/api-server/dist",
          },
        },
      });
    },
  );

  it("rejects incompatible SaaS provider and tenant model combinations before generation", async () => {
    const options: GeneratorOptions = {
      projectName: "my-incompatible-saas",
      scope: "@test",
      preset: "saas",
      saasProviderProfile: "saas-cloudflare",
      tenantModel: "rls-backed",
      webApps: [],
      apiHosting: "standalone",
      db: [],
      agentRules: false,
      installDeps: false,
      initGit: false,
    };

    await expect(generate(testDir, options)).rejects.toThrow(
      "CROCO_TENANT_MODEL_COMPATIBILITY_FAILED",
    );
    expect(existsSync(join(testDir, "croco-tenant-model.manifest.json"))).toBe(false);
  });

  it(
    "generates a goal-first SaaS API app with manifest evidence",
    { timeout: 120_000 },
    async () => {
      const options = normalizeNonInteractiveOptions(
        parseCliOptions("my-saas-api", {
          goal: "saas-api",
          scope: "@test",
          install: false,
          git: false,
          agentRules: false,
        }),
      );

      await generate(testDir, options);

      const rootPackageJson = readPackageJson(join(testDir, "package.json"));
      const manifest = JSON.parse(readFileSync(join(testDir, "croco.app.json"), "utf8")) as {
        schemaVersion?: unknown;
        projectName?: unknown;
        scope?: unknown;
        goal?: unknown;
        preset?: unknown;
        runtimeTarget?: unknown;
        protocol?: unknown;
        providers?: unknown;
        storage?: unknown;
        auth?: unknown;
        billing?: unknown;
        telemetry?: unknown;
        deploymentPreset?: unknown;
        qualityGates?: unknown;
        tenantModel?: unknown;
      };
      const tenantModelManifest = JSON.parse(
        readFileSync(join(testDir, "croco-tenant-model.manifest.json"), "utf8"),
      ) as {
        currentModel?: unknown;
        defaultModel?: unknown;
      };
      const runtimeCapabilityManifest = JSON.parse(
        readFileSync(join(testDir, "croco-runtime-capability.manifest.json"), "utf8"),
      ) as {
        version?: unknown;
        platform?: unknown;
        capabilities?: Record<string, unknown>;
        diagnostics?: unknown;
      };
      const providerProfileManifest = JSON.parse(
        readFileSync(join(testDir, "croco-saas-profile.manifest.json"), "utf8"),
      ) as {
        packages: string[];
        env: { required: { name: string }[]; optional: { name: string }[] };
        capabilities: {
          capability: string;
          productionState: string;
          zeroCredentialState: string;
        }[];
        composition: {
          executable: boolean;
          plugins: {
            factoryExport: string;
            packageName: string;
            contractPackages?: string[];
            runtimePackages?: string[];
            developmentPackages?: string[];
            env: string[];
          }[];
        };
      };
      const generatedProfileSource = readFileSync(
        join(testDir, "apps", "api-server", "src", "generatedSaasProviderProfile.ts"),
        "utf8",
      );
      const envExample = readFileSync(join(testDir, ".env.example"), "utf8");
      const apiPackageJson = readPackageJson(join(testDir, "apps", "api-server", "package.json"));

      expect(rootPackageJson.scripts).toMatchObject({
        typecheck: "turbo typecheck",
        build: "turbo build",
        test: "turbo test",
        "contract:verify":
          "pnpm contract:check && pnpm contract:diff && pnpm project-map:check && pnpm contract:openapi:check && pnpm contract:client:check && pnpm --filter @test/provider-rpc typecheck",
        "di:graph": "pnpm --filter @test/api-server di:graph",
        "di:check": "croco di check .croco/build/di-graph.manifest.json",
        "di:assert": "node scripts/assert-di-graph.mjs .croco/build/di-graph.manifest.json",
        doctor: "croco doctor --json",
        "di:verify": expect.stringMatching(
          /^pnpm di:check && pnpm di:assert && pnpm project-map:check && pnpm doctor$/,
        ),
        "demo:smoke":
          "pnpm profile:check && pnpm architecture-policy:check && pnpm runtime-policy:check && pnpm contract:check && pnpm --filter @test/api-server demo:smoke && pnpm --filter @test/api-server ops:smoke && pnpm --filter @test/api-server jobs:smoke",
      });
      expect(rootPackageJson.scripts?.["contract:client"]).toContain("--strict-schemas");
      expect(rootPackageJson.scripts?.["contract:openapi"]).toContain("--strict-schemas");
      expect(rootPackageJson.scripts?.["contract:client:check"]).toContain("--output-check");
      expect(rootPackageJson.scripts?.["contract:openapi:check"]).toContain("--output-check");
      expect(rootPackageJson.scripts?.codegen).toBe(
        "pnpm project-map:write && pnpm contract:openapi && pnpm contract:client",
      );
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        projectName: "my-saas-api",
        scope: "@test",
        goal: "saas-api",
        preset: "saas",
        runtimeTarget: "node",
        protocol: "rest",
        providers: [
          "in-memory-tenant",
          "in-memory-metering",
          "in-memory-events",
          "better-auth",
          "drizzle-transaction",
          "polar-billing",
          "qstash-tasks",
          "cloudinary-storage",
          "node-telemetry",
        ],
        storage: ["cloudinary"],
        auth: "better-auth",
        billing: "polar",
        tenantModel: "org",
        telemetry: "opentelemetry-otlp",
        deploymentPreset: "node-api",
        qualityGates: [
          "install",
          "typecheck",
          "build",
          "test",
          "contract:verify",
          "demo:smoke",
          "failure-drill:smoke",
        ],
      });
      expect(tenantModelManifest).toMatchObject({
        currentModel: "org",
        defaultModel: "org",
      });
      expect(runtimeCapabilityManifest).toMatchObject({
        version: "croco.runtime-capability.manifest.v1",
        platform: "node",
        composition: {
          host: {
            platform: "node",
            lifecycle: "process",
          },
          transports: [
            {
              protocol: "http",
              packageName: "@croco/transports-http",
            },
          ],
          buildTarget: {
            name: "node-application",
            format: "dual",
            outputDirectory: "apps/api-server/dist",
          },
        },
        capabilities: {
          env: true,
          filesystem: true,
          logger: true,
          nodeApi: true,
          requestLifecycle: true,
          trace: true,
          waitUntil: false,
          flush: false,
          streamingResponse: true,
          deadline: false,
          abortSignal: true,
          shutdown: false,
        },
        diagnostics: [],
      });
      expect(providerProfileManifest.composition).toMatchObject({
        executable: true,
        plugins: expect.arrayContaining([
          expect.objectContaining({ factoryExport: "betterAuth" }),
          expect.objectContaining({ factoryExport: "drizzleTransaction" }),
          expect.objectContaining({ factoryExport: "polarBilling" }),
          expect.objectContaining({ factoryExport: "qstashTasks" }),
          expect.objectContaining({ factoryExport: "cloudinaryStorage" }),
          expect.objectContaining({ factoryExport: "nodeTelemetry" }),
          expect.objectContaining({ factoryExport: "httpTransport" }),
        ]),
      });
      const declaredEnv = new Set(
        [...providerProfileManifest.env.required, ...providerProfileManifest.env.optional].map(
          (entry) => entry.name,
        ),
      );
      for (const pluginDefinition of providerProfileManifest.composition.plugins) {
        for (const packageName of [
          pluginDefinition.packageName,
          ...(pluginDefinition.contractPackages ?? []),
          ...(pluginDefinition.runtimePackages ?? []),
        ]) {
          expect(providerProfileManifest.packages).toContain(packageName);
          expect(apiPackageJson.dependencies?.[packageName]).toEqual(expect.any(String));
        }
        for (const packageName of pluginDefinition.developmentPackages ?? []) {
          expect(providerProfileManifest.packages).toContain(packageName);
          expect(apiPackageJson.dependencies?.[packageName]).toBeUndefined();
          expect(apiPackageJson.devDependencies?.[packageName]).toEqual(expect.any(String));
        }
        for (const envName of pluginDefinition.env) {
          expect(declaredEnv).toContain(envName);
        }
      }
      expect(providerProfileManifest.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "auth",
            productionState: "configured-production-plugin",
            zeroCredentialState: "fake-local",
          }),
          expect.objectContaining({
            capability: "metering",
            productionState: "unavailable",
            zeroCredentialState: "unavailable",
          }),
          expect.objectContaining({
            capability: "telemetry",
            productionState: "configured-production-plugin",
            zeroCredentialState: "unavailable",
          }),
          expect.objectContaining({
            capability: "webhookVerification",
            productionState: "documentation-only",
            zeroCredentialState: "documentation-only",
          }),
        ]),
      );
      expect(generatedProfileSource).toContain(
        "generatedSaasProviderProfileManifest.composition.plugins.map",
      );
      expect(generatedProfileSource).toContain(
        "new Pool({ connectionString: config.databaseUrl })",
      );
      expect(generatedProfileSource).toContain("drizzle(databasePool)");
      expect(generatedProfileSource).toContain("shutdown: () => databasePool.end()");
      expect(generatedProfileSource).toContain("databasePool === undefined ? drizzle.mock()");
      expect(generatedProfileSource).toContain(
        'qstashDestinationUrl: "https://example.test/tasks"',
      );
      expect(generatedProfileSource).not.toContain(
        'qstashDestinationUrl: "http://localhost:3000/tasks"',
      );
      expect(envExample).toContain("# UPSTASH_QSTASH_DESTINATION_URL=https://example.test/tasks");
      expect(envExample).not.toContain(
        "# UPSTASH_QSTASH_DESTINATION_URL=http://localhost:3000/tasks",
      );
      expect(generatedProfileSource).toContain(
        'enabled: options.mode === "production" && env.TELEMETRY_ENABLED !== "false"',
      );
      expect(generatedProfileSource).toContain(
        'trace: { enabled: options.mode === "production" && env.TELEMETRY_ENABLED !== "false"',
      );
      expect(generatedProfileSource).toContain("providerReplacements:");
      expect(generatedProfileSource).toContain("CROCO_SAAS_PROFILE_GRAPH_DRIFT");
      expect(generatedProfileSource).toContain("replacementOwners.has(contribution.moduleName)");
      assertNoHandlebarsPlaceholders(testDir);
      assertNoExternalCrocoWorkspaceRanges(testDir);
      assertAllSourceBareImportsDeclared(testDir);
    },
  );

  it(
    "generates AI SaaS preset with tenant-metered AI smoke commands",
    { timeout: 120_000 },
    async () => {
      const options: GeneratorOptions = {
        projectName: "my-ai-saas",
        scope: "@test",
        preset: "ai-saas",
        saasProviderProfile: "saas-node-postgres",
        tenantModel: "org",
        webApps: [],
        apiHosting: "standalone",
        db: [],
        agentRules: false,
        installDeps: false,
        initGit: false,
      };

      await generate(testDir, options);

      const rootPackageJson = readPackageJson(join(testDir, "package.json"));
      const apiPackageJson = readPackageJson(join(testDir, "apps", "api-server", "package.json"));
      const appSource = readFileSync(join(testDir, "apps", "api-server", "src", "app.ts"), "utf8");
      const aiControllerSource = readFileSync(
        join(testDir, "apps", "api-server", "src", "controllers", "AiController.ts"),
        "utf8",
      );
      const failureDrillSource = readFileSync(
        join(testDir, "apps", "api-server", "src", "demo", "failure-drill-smoke.ts"),
        "utf8",
      );

      expect(rootPackageJson.scripts).toMatchObject({
        "ai:smoke": "pnpm --filter @test/api-server ai:smoke",
        "demo:scenario":
          "pnpm exec croco generate usage-dashboard --no-page && pnpm --filter @test/api-server demo:scenario",
        "demo:smoke":
          "pnpm profile:check && pnpm architecture-policy:check && pnpm runtime-policy:check && pnpm contract:check && pnpm --filter @test/api-server demo:smoke && pnpm --filter @test/api-server ops:smoke && pnpm --filter @test/api-server jobs:smoke && pnpm --filter @test/api-server ai:smoke",
        "jobs:smoke": "pnpm --filter @test/api-server jobs:smoke",
        "failure-drill:smoke": "pnpm --filter @test/api-server failure-drill:smoke",
        "failure-drill:integration": "pnpm --filter @test/api-server failure-drill:integration",
        "di:graph": "pnpm --filter @test/api-server di:graph",
        "di:check": "croco di check .croco/build/di-graph.manifest.json",
        "di:assert": "node scripts/assert-di-graph.mjs .croco/build/di-graph.manifest.json",
        doctor: "croco doctor --json",
        "di:verify": expect.stringMatching(
          /^pnpm di:check && pnpm di:assert && pnpm project-map:check && pnpm doctor$/,
        ),
      });
      expect(rootPackageJson.scripts?.["contract:client"]).toContain("--strict-schemas");
      expect(rootPackageJson.scripts?.["contract:openapi"]).toContain("--strict-schemas");
      expect(apiPackageJson.dependencies).toMatchObject({
        "@croco/billing-polar": externalCrocoRange("@croco/billing-polar"),
        "@croco/llm-core": externalCrocoRange("@croco/llm-core"),
        "@croco/llm-metering": externalCrocoRange("@croco/llm-metering"),
        "drizzle-orm": getGeneratedAppDependencyRange("drizzle-orm"),
        "@croco/framework-context": externalCrocoRange("@croco/framework-context"),
        "@croco/framework-module": externalCrocoRange("@croco/framework-module"),
        "@croco/lifecycle-core": externalCrocoRange("@croco/lifecycle-core"),
        "@croco/metering-core": externalCrocoRange("@croco/metering-core"),
        "@croco/protocols-rest": externalCrocoRange("@croco/protocols-rest"),
        "@croco/telemetry-api": externalCrocoRange("@croco/telemetry-api"),
        "@croco/tenant-core": externalCrocoRange("@croco/tenant-core"),
      });
      expect(apiPackageJson.dependencies?.["@croco/testing"]).toBeUndefined();
      expect(apiPackageJson.devDependencies?.["@croco/testing"]).toBe("^0.0.1");
      expect(apiPackageJson.devDependencies?.["cross-env"]).toBe("^10.1.0");
      expect(apiPackageJson.scripts?.["ai:smoke"]).toBe("tsx src/demo/ai-smoke.ts");
      expect(apiPackageJson.scripts?.["demo:scenario"]).toBe("tsx src/demo/scenario.ts");
      expect(apiPackageJson.scripts?.["demo:usage-recover"]).toBe("tsx src/demo/usage-recover.ts");
      expect(apiPackageJson.scripts?.["jobs:smoke"]).toBe("tsx src/demo/jobs-smoke.ts");
      expect(appSource).toContain("createApplicationRuntime");
      expect(appSource).toContain("applicationRuntime");
      expect(appSource).toContain("AI_SAAS_RUNTIME_TOKEN");
      const aiRuntimeSource = readFileSync(
        join(testDir, "apps", "api-server", "src", "aiSaas.ts"),
        "utf8",
      );
      expect(aiRuntimeSource).toContain('new Token<AiSaasRuntime>("AiSaasRuntime")');
      expect(appSource).toContain("registerRuntimeScopedProviders(runtimeState.current)");
      expect(appSource).toContain("createAiSaasRuntime(runtime)");
      expect(appSource).toContain("runtime.bindHostCallback");
      expect(appSource).not.toContain("Container.has(LOGGER_TOKEN)");
      expect(aiControllerSource).toContain("getAiSaasRuntime()");
      expect(aiControllerSource).not.toMatch(/defaultAiSaasRuntime|defaultSaasRuntime/);
      expect(apiPackageJson.scripts?.["di:graph"]).toBe(GENERATED_SAAS_API_DI_GRAPH_SCRIPT);
      expect(apiPackageJson.scripts?.["failure-drill:smoke"]).toBe(
        "tsx src/demo/failure-drill-smoke.ts",
      );
      expect(failureDrillSource).toContain("assertSaasSmokeContract(snapshot)");
      expect(appSource).toMatch(/AiController/);
      expect(appSource).toContain("createCrocoDiGraphRoots");
      expect(appSource).toMatch(
        /\[\s*OperationsController,\s*JobsController,\s*SaasController,\s*AiController,?\s*\]/,
      );
      expect(existsSync(join(testDir, "README.md"))).toBe(true);
      expect(existsSync(join(testDir, "apps", "api-server", "src", "aiSaas.ts"))).toBe(true);
      expect(existsSync(join(testDir, "apps", "api-server", "src", "aiProblems.ts"))).toBe(true);
      expect(
        existsSync(join(testDir, "apps", "api-server", "src", "controllers", "AiController.ts")),
      ).toBe(true);
      expect(
        existsSync(join(testDir, "apps", "api-server", "src", "controllers", "aiSchemas.ts")),
      ).toBe(true);
      expect(
        existsSync(join(testDir, "apps", "api-server", "src", "demo", "aiSmokeContract.ts")),
      ).toBe(true);
      expect(existsSync(join(testDir, "apps", "api-server", "src", "demo", "ai-smoke.ts"))).toBe(
        true,
      );
      expect(
        existsSync(join(testDir, "apps", "api-server", "src", "tests", "AiSaas.spec.ts")),
      ).toBe(true);
      assertNoHandlebarsPlaceholders(testDir);
      assertNoExternalCrocoWorkspaceRanges(testDir);
      assertAllSourceBareImportsDeclared(testDir);
    },
  );

  it(
    "preserves generated workspace dependencies when the app scope is @croco",
    { timeout: 120_000 },
    async () => {
      const options: GeneratorOptions = {
        projectName: "croco-scoped-api",
        scope: "@croco",
        preset: "ddd-api",
        webApps: [],
        api: "graphql",
        apiHosting: "standalone",
        db: [],
        agentRules: false,
        installDeps: false,
        initGit: false,
      };

      await generate(testDir, options);

      const packageJson = readPackageJson(join(testDir, "apps", "graphql-api", "package.json"));

      expect(packageJson.dependencies?.["@croco/telemetry-sdk-node"]).toBe(
        externalCrocoRange("@croco/telemetry-sdk-node"),
      );
      expect(packageJson.dependencies?.["@croco/protocols-graphql"]).toBe(
        externalCrocoRange("@croco/protocols-graphql"),
      );
      expect(packageJson.dependencies?.["@croco/provider-database"]).toBe("workspace:*");
      assertNoExternalCrocoWorkspaceRanges(testDir);
    },
  );
});
