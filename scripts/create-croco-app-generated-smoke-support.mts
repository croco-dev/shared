import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

export const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type DependencyField = (typeof dependencyFields)[number];

const workspacePackageDependencyFields = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const satisfies readonly DependencyField[];

export type PackageJson = {
  readonly name?: unknown;
  readonly scripts?: unknown;
  readonly version?: unknown;
} & Partial<Record<DependencyField, unknown>>;

export type WorkspacePackage = {
  readonly name: string;
  readonly packageDir: string;
  readonly version: string;
  readonly dependencyNames: readonly string[];
};

export type ExternalCrocoRangeException = {
  readonly range: string;
  readonly reason: string;
};

export type ExternalCrocoRangeExceptions = Readonly<Record<string, ExternalCrocoRangeException>>;

const skippedPackageJsonDirectories = new Set([".turbo", "coverage", "dist", "node_modules"]);

const generatedLintToolchains = {
  biome: {
    command: "biome lint .",
    configFile: "biome.json",
    dependency: "@biomejs/biome",
  },
  oxlint: {
    command: "oxlint .",
    configFile: ".oxlintrc.json",
    dependency: "oxlint",
  },
} as const;

export function assertGeneratedTemplateLintContracts(templatesDir: string): void {
  const templates = readdirSync(templatesDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(templatesDir, entry.name, "package.json.hbs")),
    )
    .map((entry) => entry.name)
    .sort();
  let expectedLinter: keyof typeof generatedLintToolchains | undefined;

  for (const template of templates) {
    const templateDir = join(templatesDir, template);
    const manifestPath = join(templateDir, "package.json.hbs");
    const manifest = readPackageJson(manifestPath);
    const lintCommand = readStringProperty(manifest.scripts, "lint");

    if (lintCommand === undefined) {
      throw new Error(`${manifestPath}: generated template is missing a lint script`);
    }

    const linter = lintCommand.trim().split(/\s+/, 1)[0];
    if (!isGeneratedLintToolchain(linter)) {
      throw new Error(
        `${manifestPath}: lint script uses unsupported linter ${linter ?? "<empty>"}`,
      );
    }
    if (expectedLinter !== undefined && linter !== expectedLinter) {
      throw new Error(
        `${manifestPath}: generated template linter ${linter} does not match ${expectedLinter}`,
      );
    }
    expectedLinter = linter;

    const toolchain = generatedLintToolchains[linter];
    if (lintCommand.trim() !== toolchain.command) {
      throw new Error(
        `${manifestPath}: lint script must be exactly ${toolchain.command}, received ${lintCommand}`,
      );
    }
    const configPath = join(templateDir, toolchain.configFile);
    if (!existsSync(configPath)) {
      throw new Error(`${manifestPath}: lint script requires missing config ${configPath}`);
    }

    const version = readStringProperty(manifest.devDependencies, toolchain.dependency);
    if (version === undefined) {
      throw new Error(
        `${manifestPath}: lint script requires ${toolchain.dependency} in devDependencies`,
      );
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(
        `${manifestPath}: ${toolchain.dependency} must use an exact version, received ${version}`,
      );
    }
  }
}

function isGeneratedLintToolchain(
  value: string | undefined,
): value is keyof typeof generatedLintToolchains {
  return value !== undefined && Object.hasOwn(generatedLintToolchains, value);
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const propertyValue = Reflect.get(value, property);
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

export function createWorkspacePackageIndex(
  rootDir: string,
): ReadonlyMap<string, WorkspacePackage> {
  const index = new Map<string, WorkspacePackage>();

  for (const packageJsonPath of findPackageJsonFiles(join(rootDir, "packages"))) {
    const packageJson = readPackageJson(packageJsonPath);

    if (typeof packageJson.name !== "string" || !packageJson.name.startsWith("@croco/")) {
      continue;
    }

    if (typeof packageJson.version !== "string") {
      throw new Error(`${packageJsonPath}: ${packageJson.name} is missing a string version`);
    }

    if (index.has(packageJson.name)) {
      throw new Error(`Duplicate workspace package name ${packageJson.name}`);
    }

    index.set(packageJson.name, {
      name: packageJson.name,
      packageDir: dirname(packageJsonPath),
      version: packageJson.version,
      dependencyNames: collectCrocoDependencyNames(packageJson, workspacePackageDependencyFields),
    });
  }

  return index;
}

export function collectGeneratedCrocoDependencyNames(projectDir: string): readonly string[] {
  const manifests = readProjectManifests(projectDir);
  const generatedPackageNames = new Set(
    manifests
      .map(({ packageJson }) => packageJson.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const dependencies = new Set<string>();

  for (const { packageJson } of manifests) {
    for (const dependencyName of collectCrocoDependencyNames(packageJson)) {
      if (!generatedPackageNames.has(dependencyName)) {
        dependencies.add(dependencyName);
      }
    }
  }

  return [...dependencies].sort();
}

export function resolveLocalCrocoPackagesForGeneratedProject(
  projectDir: string,
  workspacePackageIndex: ReadonlyMap<string, WorkspacePackage>,
  externalRangeExceptions: ExternalCrocoRangeExceptions = {},
): readonly WorkspacePackage[] {
  const resolvedPackages = new Map<string, WorkspacePackage>();
  const resolvingPackages = new Set<string>();

  function resolvePackage(packageName: string, referenceSource: string): void {
    if (externalRangeExceptions[packageName]) {
      return;
    }

    const workspacePackage = workspacePackageIndex.get(packageName);
    if (!workspacePackage) {
      throw new Error(
        `${referenceSource} references ${packageName}, but it is not a local @croco workspace package and has no explicit generated-smoke external exception`,
      );
    }

    if (resolvedPackages.has(packageName) || resolvingPackages.has(packageName)) {
      return;
    }

    resolvingPackages.add(packageName);
    resolvedPackages.set(packageName, workspacePackage);

    for (const dependencyName of workspacePackage.dependencyNames) {
      resolvePackage(dependencyName, `${workspacePackage.name} package.json`);
    }

    resolvingPackages.delete(packageName);
  }

  for (const dependencyName of collectGeneratedCrocoDependencyNames(projectDir)) {
    resolvePackage(dependencyName, "Generated project package.json");
  }

  return [...resolvedPackages.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function rewriteExternalCrocoRanges(
  projectDir: string,
  rangeOverrides: Readonly<Record<string, string>>,
  externalRangeExceptions: ExternalCrocoRangeExceptions = {},
): void {
  const manifests = readProjectManifests(projectDir);
  const generatedPackageNames = new Set(
    manifests
      .map(({ packageJson }) => packageJson.name)
      .filter((name): name is string => typeof name === "string"),
  );

  for (const manifest of manifests) {
    let changed = false;

    for (const field of dependencyFields) {
      const dependencies = manifest.packageJson[field];

      if (!isDependencyMap(dependencies)) {
        continue;
      }

      for (const packageName of Object.keys(dependencies)) {
        if (!packageName.startsWith("@croco/") || generatedPackageNames.has(packageName)) {
          continue;
        }

        const replacementRange =
          rangeOverrides[packageName] ?? externalRangeExceptions[packageName]?.range;
        if (replacementRange === undefined) {
          throw new Error(
            `Generated smoke dependency ${packageName} is missing a local tarball override or explicit external exception`,
          );
        }

        if (dependencies[packageName] !== replacementRange) {
          dependencies[packageName] = replacementRange;
          changed = true;
        }
      }
    }

    if (changed) {
      writeFileSync(manifest.path, `${JSON.stringify(manifest.packageJson, null, 2)}\n`);
    }
  }
}

export function writePnpmWorkspaceOverrides(
  projectDir: string,
  rangeOverrides: Readonly<Record<string, string>>,
): void {
  const workspacePath = join(projectDir, "pnpm-workspace.yaml");
  const existingContent = existsSync(workspacePath)
    ? readFileSync(workspacePath, "utf8")
    : `packages:\n  - "apps/**/*"\n  - "libs/**/*"\n`;
  const contentWithoutOverrides = removeTopLevelYamlBlock(existingContent, "overrides").trimEnd();
  const overrides = {
    ...readPnpmWorkspaceOverrides(existingContent),
    ...rangeOverrides,
  };
  const overrideLines = Object.entries(overrides)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([packageName, range]) =>
        `  ${toYamlDoubleQuotedScalar(packageName)}: ${toYamlDoubleQuotedScalar(range)}`,
    );

  writeFileSync(
    workspacePath,
    `${contentWithoutOverrides}\n\n${["overrides:", ...overrideLines].join("\n")}\n`,
  );
}

function readPnpmWorkspaceOverrides(content: string): Readonly<Record<string, string>> {
  const workspace = parseYaml(content) as unknown;
  if (!isRecord(workspace) || !isRecord(workspace.overrides)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(workspace.overrides).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function readProjectManifests(projectDir: string): readonly {
  readonly path: string;
  readonly packageJson: PackageJson;
}[] {
  return findPackageJsonFiles(projectDir).map((path) => ({
    path,
    packageJson: readPackageJson(path),
  }));
}

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function collectCrocoDependencyNames(
  packageJson: PackageJson,
  fields: readonly DependencyField[] = dependencyFields,
): readonly string[] {
  const dependencies = new Set<string>();

  for (const field of fields) {
    const dependencyMap = packageJson[field];

    if (!isDependencyMap(dependencyMap)) {
      continue;
    }

    for (const packageName of Object.keys(dependencyMap)) {
      if (packageName.startsWith("@croco/")) {
        dependencies.add(packageName);
      }
    }
  }

  return [...dependencies].sort();
}

function findPackageJsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (skippedPackageJsonDirectories.has(entry.name)) {
        return [];
      }

      return findPackageJsonFiles(entryPath);
    }

    return entry.name === "package.json" ? [entryPath] : [];
  });
}

function isDependencyMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((dependencyRange) => typeof dependencyRange === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeTopLevelYamlBlock(content: string, key: string): string {
  const lines = content.split(/\r?\n/);
  const blockStartIndex = lines.findIndex((line) => line.trim() === `${key}:`);

  if (blockStartIndex === -1) {
    return content;
  }

  let blockEndIndex = blockStartIndex + 1;
  while (
    blockEndIndex < lines.length &&
    (lines[blockEndIndex] === "" || /^\s/.test(lines[blockEndIndex]))
  ) {
    blockEndIndex += 1;
  }

  return [...lines.slice(0, blockStartIndex), ...lines.slice(blockEndIndex)].join("\n");
}

function toYamlDoubleQuotedScalar(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
