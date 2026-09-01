#!/usr/bin/env node

/**
 * Keeps the root package catalog and package documentation coverage report in sync
 * with package manifests plus the curated group/maturity metadata.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { exit, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import {
  createDefaultCertificationPolicy,
  isCertificationClaimLine,
  parseCertificationPolicy as parseSharedCertificationPolicy,
  type CertificationPolicy as SharedCertificationPolicy,
} from "./certification-policy.mts";

type Mode = "check" | "write";

type Options = {
  readonly mode: Mode;
  readonly rootDir: string;
};

type PackageJson = {
  readonly peerDependencies?: unknown;
  readonly name?: unknown;
  readonly private?: unknown;
  readonly version?: unknown;
};

type RootPackageJson = {
  readonly scripts?: unknown;
};

type PackageInfo = {
  readonly dir: string;
  readonly hasApiDocs: boolean;
  readonly hasReadme: boolean;
  readonly hasTests: boolean;
  readonly name: string;
  readonly peerDependencies: readonly string[];
  readonly private: boolean;
  readonly shortName: string;
  readonly version: string;
};

type PackageRecord = PackageInfo & {
  readonly group: string;
  readonly maturity: MaturityKey;
};

type CatalogMetadata = {
  readonly certification?: unknown;
  readonly extensionMatrix?: unknown;
  readonly schemaVersion?: unknown;
  readonly groups?: unknown;
  readonly maturity?: unknown;
  readonly spine?: unknown;
};

type CatalogGroup = {
  readonly description: string;
  readonly packages: readonly string[];
};

type MaturityConfig = {
  readonly label: string;
  readonly packages: readonly string[];
};

type SpineConfig = {
  readonly description: string;
  readonly label: string;
  readonly packages: readonly string[];
  readonly promotionPackages: readonly string[];
};

type RuntimeKey = (typeof runtimeOrder)[number];

type ExtensionMetadata = {
  readonly adapter: string;
  readonly domain: string;
  readonly features: readonly string[];
  readonly requiredEnv: readonly string[];
  readonly runtimes: readonly RuntimeKey[];
};

type ExtensionRecord = PackageRecord & {
  readonly extension: ExtensionMetadata;
};

type ExtensionMatrixState = {
  readonly groups: readonly string[];
  readonly packages: readonly ExtensionRecord[];
};

type AdapterCategoryKey = (typeof adapterCategoryOrder)[number];

type CertificationStateKey = (typeof certificationStateOrder)[number];

type CertificationEvidenceKey = (typeof certificationEvidenceKeyOrder)[number];

type CertificationEvidenceStatus = (typeof certificationEvidenceStatusOrder)[number];

type CertificationEvidenceItem = {
  readonly artifact: string;
  readonly command: string;
  readonly description: string;
  readonly reason: string;
  readonly status: CertificationEvidenceStatus;
};

type CertificationRecord = {
  readonly adapterCategory: AdapterCategoryKey;
  readonly contract: string;
  readonly evidence: ReadonlyMap<CertificationEvidenceKey, CertificationEvidenceItem>;
  readonly knownGaps: readonly string[];
  readonly packageName: string;
  readonly packageShortName: string;
  readonly packageVersion: string;
  readonly runtimes: readonly RuntimeKey[];
  readonly state: CertificationStateKey;
};

type CertificationCatalogState = {
  readonly policy: CertificationPolicy;
  readonly records: readonly CertificationRecord[];
  readonly recordsByPackage: ReadonlyMap<string, readonly CertificationRecord[]>;
  readonly schemaVersion: number;
};

type CertificationPolicy = SharedCertificationPolicy<MaturityKey>;

type RuntimeProfileCatalog = {
  readonly schemaVersion?: unknown;
  readonly validationCommand?: unknown;
  readonly profiles?: unknown;
};

type DocsBaseline = {
  readonly schemaVersion?: unknown;
  readonly allowedMissingApiDocs?: unknown;
  readonly allowedMissingReadme?: unknown;
  readonly allowedMissingTests?: unknown;
  readonly temporaryProductionApiDocExceptions?: unknown;
};

type Baseline = {
  readonly allowedMissingApiDocs: ReadonlySet<string>;
  readonly allowedMissingReadme: ReadonlySet<string>;
  readonly allowedMissingTests: ReadonlySet<string>;
  readonly temporaryProductionApiDocExceptions: ReadonlyMap<string, string>;
};

type CoverageSet = {
  readonly missingApiDocs: readonly PackageRecord[];
  readonly missingReadme: readonly PackageRecord[];
  readonly missingTests: readonly PackageRecord[];
};

type DocumentedPnpmCommand = {
  readonly name: string;
  readonly requiresRootScript: boolean;
};

type CatalogState = {
  readonly certification: CertificationCatalogState;
  readonly certificationClaimedPackages: ReadonlySet<string>;
  readonly extensionMatrix: ExtensionMatrixState;
  readonly groups: ReadonlyMap<string, CatalogGroup>;
  readonly maturity: ReadonlyMap<MaturityKey, MaturityConfig>;
  readonly packages: readonly PackageRecord[];
  readonly privatePackageCount: number;
  readonly spine: SpineConfig;
  readonly spinePackages: readonly PackageRecord[];
};

const catalogStart = "<!-- CROCO:PACKAGE-CATALOG:START -->";
const catalogEnd = "<!-- CROCO:PACKAGE-CATALOG:END -->";
const readmeCatalogHeading = "## 📦 패키지 카탈로그";
const readmeCatalogNextSection = "---\n\n## 🛠 개발 환경";
const docsDirName = "docs";
const catalogMetadataPath = join(docsDirName, "package-catalog.json");
const docsBaselinePath = join(docsDirName, "package-docs-baseline.json");
const docsReportPath = join(docsDirName, "package-docs-report.md");
const presentationRuntimeProfilesPath = join(
  "packages",
  "presentation-preset",
  "runtime-profiles.json",
);
const publicDocsRootPath = join("packages", "docs", "src", "content", "docs", "en");
const architectureGuidePath = join(publicDocsRootPath, "guides", "architecture.mdx");
const extensionMatrixDocsPath = join(
  "packages",
  "docs",
  "src",
  "content",
  "docs",
  "en",
  "reference",
  "extension-matrix.md",
);
const readmePath = "README.md";
const rootCommandDocsPaths = ["AGENTS.md", "CONTRIBUTING.md", readmePath, "RELEASING.md"] as const;
const pnpmBuiltinCommands = new Set([
  "add",
  "approve-builds",
  "audit",
  "bin",
  "c",
  "cache",
  "cat-file",
  "cat-index",
  "clean",
  "config",
  "create",
  "dedupe",
  "deploy",
  "dlx",
  "env",
  "exec",
  "fetch",
  "find-hash",
  "i",
  "ignored-builds",
  "import",
  "init",
  "install",
  "install-test",
  "it",
  "licenses",
  "link",
  "list",
  "ln",
  "ls",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "patch-remove",
  "prune",
  "publish",
  "rb",
  "rebuild",
  "remove",
  "rm",
  "root",
  "rt",
  "runtime",
  "self-update",
  "stage",
  "store",
  "unlink",
  "up",
  "update",
  "why",
]);
const maturityOrder = ["production", "beta", "alpha", "deprecated"] as const;
const runtimeOrder = ["node", "lambda", "cloudflare-workers", "browser"] as const;
const adapterCategoryOrder = [
  "provider",
  "integration",
  "transport",
  "host",
  "presentation",
  "community",
] as const;
const certificationStateOrder = ["uncertified", "candidate", "certified"] as const;
const certificationEvidenceStatusOrder = ["present", "missing", "not-applicable"] as const;
const certificationEvidenceKeyOrder = [
  "conformance",
  "noCredentialSmoke",
  "liveSmoke",
  "diagnostics",
  "redactionTests",
] as const;
const artifactFormatOrder = ["esm", "cjs", "dual", "neutral"] as const;
const artifactTypeOrder = ["code", "types", "config", "asset"] as const;
const scriptRootDir = dirname(dirname(fileURLToPath(import.meta.url)));

type MaturityKey = (typeof maturityOrder)[number];

const defaultCertificationPolicy: CertificationPolicy =
  createDefaultCertificationPolicy("production");

main();

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = run(options);

    if (result.length > 0) {
      stdout.write("package-docs-check: documentation catalog drift detected.\n");
      for (const violation of result) {
        stdout.write(`- ${violation}\n`);
      }
      exit(1);
    }

    stdout.write("package-docs-check: package catalog and documentation report are in sync.\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdout.write(`package-docs-check: ${message}\n`);
    exit(1);
  }
}

function run(options: Options): string[] {
  const violations: string[] = [];
  validateDocumentedRootScripts(options.rootDir, violations);
  const state = loadCatalogState(options.rootDir, violations);
  validateArchitectureDocs(options.rootDir, state, violations);
  const baseline = loadDocsBaseline(options.rootDir, state.packages, violations);
  const coverage = getCoverageSet(state.packages);
  validateCoverageBaseline(coverage, baseline, violations);
  validatePresentationPresetRuntimeEvidence(options.rootDir, state, violations);

  const generatedCatalog = formatMarkdown(readmePath, generateReadmeCatalog(state));
  const generatedExtensionMatrixDocs = formatMarkdown(
    extensionMatrixDocsPath,
    generateExtensionMatrixDocs(state),
  );
  const generatedReport = formatMarkdown(
    docsReportPath,
    generateDocsReport(state, coverage, baseline),
  );

  if (options.mode === "write") {
    writeReadmeCatalog(options.rootDir, generatedCatalog);
    writeGeneratedFile(
      join(options.rootDir, extensionMatrixDocsPath),
      generatedExtensionMatrixDocs,
    );
    writeGeneratedFile(join(options.rootDir, docsReportPath), generatedReport);
    return violations;
  }

  const readme = readRequiredFile(join(options.rootDir, readmePath));
  const expectedReadme = replaceReadmeCatalog(readme, generatedCatalog);
  if (readme !== expectedReadme) {
    violations.push(`README.md package catalog drift detected; run pnpm docs:catalog:write`);
  }

  const extensionMatrixPath = join(options.rootDir, extensionMatrixDocsPath);
  const currentExtensionMatrix = existsSync(extensionMatrixPath)
    ? readFileSync(extensionMatrixPath, "utf-8")
    : "";
  if (currentExtensionMatrix !== generatedExtensionMatrixDocs) {
    violations.push(`${extensionMatrixDocsPath} drift detected; run pnpm docs:catalog:write`);
  }

  const reportPath = join(options.rootDir, docsReportPath);
  const currentReport = existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : "";
  if (currentReport !== generatedReport) {
    violations.push(`${docsReportPath} drift detected; run pnpm docs:catalog:write`);
  }

  return violations;
}

function validateDocumentedRootScripts(rootDir: string, violations: string[]): void {
  const packageJson = readJsonFile<RootPackageJson>(join(rootDir, "package.json"));
  if (!isRecord(packageJson.scripts)) {
    violations.push("package.json must define a scripts object for documented command validation");
    return;
  }

  const rootScripts = new Set(Object.keys(packageJson.scripts));
  for (const docsPath of rootCommandDocsPaths) {
    const absolutePath = join(rootDir, docsPath);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const content = readFileSync(absolutePath, "utf-8");
    for (const command of collectDocumentedRootPnpmCommands(content)) {
      if (
        (command.requiresRootScript || !pnpmBuiltinCommands.has(command.name)) &&
        !rootScripts.has(command.name)
      ) {
        violations.push(
          `${docsPath}: documented command \`pnpm ${command.name}\` is not defined in package.json#scripts`,
        );
      }
    }
  }
}

function collectDocumentedRootPnpmCommands(markdown: string): readonly DocumentedPnpmCommand[] {
  const commands = new Map<string, boolean>();
  let fencedBlock: { readonly isShell: boolean; readonly lines: string[] } | null = null;

  for (const rawLine of markdown.split("\n")) {
    const line = stripMarkdownContainerPrefix(rawLine);
    const fence = line.match(/^```([^\s`]*)/);
    if (fence) {
      if (fencedBlock) {
        if (fencedBlock.isShell) {
          collectShellPnpmCommands(fencedBlock.lines, commands);
        }
        fencedBlock = null;
      } else {
        fencedBlock = {
          isShell: ["", "bash", "console", "sh", "shell", "zsh"].includes(fence[1]),
          lines: [],
        };
      }
      continue;
    }

    if (fencedBlock) {
      fencedBlock.lines.push(line);
      continue;
    }

    for (const match of rawLine.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
      collectShellPnpmCommands([match[1]], commands);
    }
  }

  if (fencedBlock?.isShell) {
    collectShellPnpmCommands(fencedBlock.lines, commands);
  }

  return [...commands]
    .map(([name, requiresRootScript]) => ({ name, requiresRootScript }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function stripMarkdownContainerPrefix(line: string): string {
  return line.replace(/^\s*(?:>\s*)?(?:[-*+]\s+)?/, "");
}

function collectShellPnpmCommands(lines: readonly string[], commands: Map<string, boolean>): void {
  let workingDirectory: string[] | null = [];

  for (const line of lines) {
    for (const segment of line.split(/&&|\|\||[;|]/)) {
      const commandLine = segment
        .trim()
        .replace(/^\$\s+/, "")
        .split(/\s+#/, 1)[0];
      if (!commandLine || commandLine.startsWith("#")) {
        continue;
      }
      const cdTarget = commandLine.match(/^cd\s+(.+?)\s*$/)?.[1];
      if (cdTarget) {
        workingDirectory = resolveDocumentedWorkingDirectory(workingDirectory, cdTarget);
        continue;
      }

      if (workingDirectory?.length !== 0) {
        continue;
      }

      const pnpmInvocation = commandLine.match(/(?:^|\s)pnpm\s+(.+)$/)?.[1];
      if (!pnpmInvocation) {
        continue;
      }

      const command = resolvePnpmCommand(pnpmInvocation.trim());
      if (command) {
        commands.set(
          command.name,
          command.requiresRootScript || (commands.get(command.name) ?? false),
        );
      }
    }
  }
}

function resolveDocumentedWorkingDirectory(
  currentDirectory: readonly string[] | null,
  rawTarget: string,
): string[] | null {
  const target = rawTarget.replace(/^['"]|['"]$/g, "");
  if (target.includes("git rev-parse --show-toplevel")) {
    return [];
  }
  if (!currentDirectory || target === "-" || target.startsWith("/") || target.startsWith("$")) {
    return null;
  }

  const nextDirectory = [...currentDirectory];
  for (const part of target.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      nextDirectory.pop();
      continue;
    }
    nextDirectory.push(part);
  }
  return nextDirectory;
}

function resolvePnpmCommand(invocation: string): DocumentedPnpmCommand | null {
  const tokens = invocation.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let index = 0;

  while (index < tokens.length && tokens[index].startsWith("-")) {
    const option = tokens[index];
    if (
      ["--dir", "--filter", "--prefix", "--recursive", "-C", "-F", "-r"].includes(option) ||
      /^(?:--dir|--filter|--prefix)=/.test(option)
    ) {
      return null;
    }
    index++;
  }

  const command = tokens[index];
  if (!command || command.startsWith("-")) {
    return null;
  }
  if (command === "run") {
    const scriptName = tokens[index + 1];
    return scriptName ? { name: scriptName, requiresRootScript: true } : null;
  }
  if (command === "t") {
    return { name: "test", requiresRootScript: true };
  }
  return {
    name: command,
    requiresRootScript: !pnpmBuiltinCommands.has(command),
  };
}

function parseArgs(args: readonly string[]): Options {
  let mode: Mode = "check";
  let rootDir = process.cwd();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--check") {
      mode = "check";
      continue;
    }

    if (arg === "--write") {
      mode = "write";
      continue;
    }

    if (arg === "--root") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--root requires a path");
      }
      rootDir = resolve(value);
      index++;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    mode,
    rootDir,
  };
}

function loadCatalogState(rootDir: string, violations: string[]): CatalogState {
  const packages = readPackages(rootDir);
  const publicPackages = packages.filter((pkg) => !pkg.private);
  const metadata = readJsonFile<CatalogMetadata>(join(rootDir, catalogMetadataPath));
  const groups = parseCatalogGroups(metadata.groups, violations);
  const maturity = parseMaturity(metadata.maturity, violations);
  const groupByPackage = validateAssignments("group", groups, publicPackages, violations);
  const maturityByPackage = validateAssignments("maturity", maturity, publicPackages, violations);
  const records = publicPackages.map((pkg) => {
    const group = groupByPackage.get(pkg.shortName) ?? "Unassigned";
    const maturityKey = (maturityByPackage.get(pkg.shortName) ?? "alpha") as MaturityKey;

    return {
      ...pkg,
      group,
      maturity: maturityKey,
    };
  });
  const spine = parseSpine(metadata.spine, records, violations);
  const packageByShortName = new Map(records.map((pkg) => [pkg.shortName, pkg]));
  const spinePackages = spine.packages.flatMap((packageName) => {
    const pkg = packageByShortName.get(packageName);
    return pkg ? [pkg] : [];
  });
  const extensionMatrix = parseExtensionMatrix(
    metadata.extensionMatrix,
    groups,
    records,
    violations,
  );
  const certification = parseCertification(
    metadata.certification,
    records,
    extensionMatrix,
    violations,
  );
  const certificationClaimedPackages = collectCertificationClaimedPackages(rootDir);

  return {
    certification,
    certificationClaimedPackages,
    extensionMatrix,
    groups,
    maturity,
    packages: records,
    privatePackageCount: packages.length - publicPackages.length,
    spine,
    spinePackages,
  };
}

function readPackages(rootDir: string): PackageInfo[] {
  const packagesDir = join(rootDir, "packages");
  const entries = readdirSync(packagesDir, { withFileTypes: true });
  const packages: PackageInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageDir = join(packagesDir, entry.name);
    const packageJsonPath = join(packageDir, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const pkg = readJsonFile<PackageJson>(packageJsonPath);
    if (typeof pkg.name !== "string" || pkg.name.length === 0) {
      throw new Error(`${relative(rootDir, packageJsonPath)} is missing a string name`);
    }

    packages.push({
      dir: entry.name,
      hasApiDocs: existsSync(
        join(rootDir, "packages", "docs", "src", "content", "docs", "api", entry.name),
      ),
      hasReadme: existsSync(join(packageDir, "README.md")),
      hasTests:
        existsSync(join(packageDir, "src", "tests")) ||
        existsSync(join(packageDir, "src", "__tests__")),
      name: pkg.name,
      peerDependencies: readDependencyKeys(pkg.peerDependencies),
      private: pkg.private === true,
      shortName: toShortPackageName(pkg.name),
      version: typeof pkg.version === "string" ? pkg.version : "",
    });
  }

  return packages.sort((left, right) => left.shortName.localeCompare(right.shortName));
}

function parseCatalogGroups(
  value: unknown,
  violations: string[],
): ReadonlyMap<string, CatalogGroup> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    violations.push(`${catalogMetadataPath}: groups must be an object`);
    return new Map();
  }

  const groups = new Map<string, CatalogGroup>();
  for (const [group, config] of Object.entries(value)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      violations.push(`${catalogMetadataPath}: groups.${group} must be an object`);
      continue;
    }

    const description = (config as { readonly description?: unknown }).description;
    const packages = (config as { readonly packages?: unknown }).packages;
    if (typeof description !== "string" || description.length === 0) {
      violations.push(`${catalogMetadataPath}: groups.${group}.description must be a string`);
    }
    if (!isStringArray(packages)) {
      violations.push(`${catalogMetadataPath}: groups.${group}.packages must be a string array`);
      continue;
    }

    groups.set(group, {
      description: typeof description === "string" ? description : "",
      packages,
    });
  }

  return groups;
}

function parseMaturity(
  value: unknown,
  violations: string[],
): ReadonlyMap<MaturityKey, MaturityConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    violations.push(`${catalogMetadataPath}: maturity must be an object`);
    return new Map();
  }

  const maturity = new Map<MaturityKey, MaturityConfig>();
  for (const key of maturityOrder) {
    const config = (value as Record<string, unknown>)[key];
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      violations.push(`${catalogMetadataPath}: maturity.${key} must be an object`);
      continue;
    }

    const label = (config as { readonly label?: unknown }).label;
    const packages = (config as { readonly packages?: unknown }).packages;
    if (typeof label !== "string" || label.length === 0) {
      violations.push(`${catalogMetadataPath}: maturity.${key}.label must be a string`);
    }
    if (!isStringArray(packages)) {
      violations.push(`${catalogMetadataPath}: maturity.${key}.packages must be a string array`);
      continue;
    }

    maturity.set(key, {
      label: typeof label === "string" ? label : key,
      packages,
    });
  }

  return maturity;
}

function parseSpine(
  value: unknown,
  packages: readonly PackageRecord[],
  violations: string[],
): SpineConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    violations.push(`${catalogMetadataPath}: spine must be an object`);
    return {
      description: "",
      label: "Croco 1.0 spine",
      packages: [],
      promotionPackages: [],
    };
  }

  const config = value as Record<string, unknown>;
  const label = readRequiredString(config.label, "spine.label", violations);
  const description = readRequiredString(config.description, "spine.description", violations);
  const packageNames = readRequiredStringArray(config.packages, "spine.packages", violations);
  const promotionPackages = parseSpinePromotionPackages(config.promotion, violations);
  const packageByName = new Map(packages.map((pkg) => [pkg.shortName, pkg]));
  const seen = new Set<string>();

  for (const packageName of packageNames) {
    if (seen.has(packageName)) {
      violations.push(`${catalogMetadataPath}: spine.packages contains duplicate ${packageName}`);
      continue;
    }

    seen.add(packageName);
    const pkg = packageByName.get(packageName);
    if (!pkg) {
      violations.push(
        `${catalogMetadataPath}: spine.packages references missing package ${packageName}`,
      );
      continue;
    }

    if (pkg.maturity === "deprecated") {
      violations.push(`${catalogMetadataPath}: spine package ${packageName} cannot be deprecated`);
    }
  }

  for (const packageName of promotionPackages) {
    if (!packageByName.has(packageName)) {
      violations.push(
        `${catalogMetadataPath}: spine.promotion.packages references missing package ${packageName}`,
      );
      continue;
    }

    if (!seen.has(packageName)) {
      violations.push(
        `${catalogMetadataPath}: spine.promotion.packages.${packageName} is outside spine.packages`,
      );
    }
  }

  return {
    description: description || "Release-critical package set for Croco 1.0.",
    label: label || "Croco 1.0 spine",
    packages: packageNames,
    promotionPackages,
  };
}

function parseSpinePromotionPackages(value: unknown, violations: string[]): readonly string[] {
  if (value === undefined) {
    return [];
  }

  if (!isRecord(value)) {
    violations.push(`${catalogMetadataPath}: spine.promotion must be an object`);
    return [];
  }

  const packages = value.packages;
  if (packages === undefined) {
    return [];
  }

  if (!isRecord(packages)) {
    violations.push(`${catalogMetadataPath}: spine.promotion.packages must be an object`);
    return [];
  }

  return Object.keys(packages).sort((left, right) => left.localeCompare(right));
}

function parseExtensionMatrix(
  value: unknown,
  groups: ReadonlyMap<string, CatalogGroup>,
  packages: readonly PackageRecord[],
  violations: string[],
): ExtensionMatrixState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    violations.push(`${catalogMetadataPath}: extensionMatrix must be an object`);
    return {
      groups: [],
      packages: [],
    };
  }

  const groupValue = (value as { readonly groups?: unknown }).groups;
  const packageValue = (value as { readonly packages?: unknown }).packages;
  if (!isStringArray(groupValue)) {
    violations.push(`${catalogMetadataPath}: extensionMatrix.groups must be a string array`);
  }
  if (!packageValue || typeof packageValue !== "object" || Array.isArray(packageValue)) {
    violations.push(`${catalogMetadataPath}: extensionMatrix.packages must be an object`);
    return {
      groups: isStringArray(groupValue) ? groupValue : [],
      packages: [],
    };
  }

  const extensionGroups = isStringArray(groupValue) ? groupValue : [];
  for (const group of extensionGroups) {
    if (!groups.has(group)) {
      violations.push(
        `${catalogMetadataPath}: extensionMatrix.groups references missing group ${group}`,
      );
    }
  }

  const packageByName = new Map(packages.map((pkg) => [pkg.shortName, pkg]));
  const extensionGroupSet = new Set(extensionGroups);
  const targetPackages = packages.filter((pkg) => extensionGroupSet.has(pkg.group));
  const records: ExtensionRecord[] = [];

  for (const [packageName, metadataValue] of Object.entries(packageValue)) {
    const pkg = packageByName.get(packageName);
    if (!pkg) {
      violations.push(
        `${catalogMetadataPath}: extensionMatrix.packages references missing package ${packageName}`,
      );
      continue;
    }
    if (!extensionGroupSet.has(pkg.group)) {
      violations.push(
        `${catalogMetadataPath}: extensionMatrix.packages.${packageName} is not in an extension group`,
      );
      continue;
    }

    const metadata = parseExtensionMetadata(packageName, metadataValue, violations);
    if (!metadata) {
      continue;
    }

    records.push({
      ...pkg,
      extension: metadata,
    });
  }

  const metadataPackageNames = new Set(records.map((pkg) => pkg.shortName));
  for (const pkg of targetPackages) {
    if (!metadataPackageNames.has(pkg.shortName)) {
      violations.push(
        `${catalogMetadataPath}: extensionMatrix is missing metadata for ${pkg.group} package ${pkg.shortName}`,
      );
    }
  }

  return {
    groups: extensionGroups,
    packages: records.sort(
      (left, right) =>
        extensionGroups.indexOf(left.group) - extensionGroups.indexOf(right.group) ||
        left.extension.domain.localeCompare(right.extension.domain) ||
        left.shortName.localeCompare(right.shortName),
    ),
  };
}

function parseExtensionMetadata(
  packageName: string,
  value: unknown,
  violations: string[],
): ExtensionMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    violations.push(
      `${catalogMetadataPath}: extensionMatrix.packages.${packageName} must be an object`,
    );
    return null;
  }

  const metadata = value as Record<string, unknown>;
  const adapter = readRequiredString(
    metadata.adapter,
    `extensionMatrix.packages.${packageName}.adapter`,
    violations,
  );
  const domain = readRequiredString(
    metadata.domain,
    `extensionMatrix.packages.${packageName}.domain`,
    violations,
  );
  const features = readRequiredStringArray(
    metadata.features,
    `extensionMatrix.packages.${packageName}.features`,
    violations,
  );
  const requiredEnv = readRequiredStringArray(
    metadata.requiredEnv,
    `extensionMatrix.packages.${packageName}.requiredEnv`,
    violations,
  );
  const runtimes = readRuntimeArray(
    metadata.runtimes,
    `extensionMatrix.packages.${packageName}.runtimes`,
    violations,
  );

  if (
    !adapter ||
    !domain ||
    features.length === 0 ||
    requiredEnv.length === 0 ||
    runtimes.length === 0
  ) {
    return null;
  }

  return {
    adapter,
    domain,
    features,
    requiredEnv,
    runtimes,
  };
}

function parseCertification(
  value: unknown,
  packages: readonly PackageRecord[],
  extensionMatrix: ExtensionMatrixState,
  violations: string[],
): CertificationCatalogState {
  if (!isRecord(value)) {
    violations.push(`${catalogMetadataPath}: certification must be an object`);
    return {
      policy: defaultCertificationPolicy,
      records: [],
      recordsByPackage: new Map(),
      schemaVersion: 0,
    };
  }

  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== 1) {
    violations.push(`${catalogMetadataPath}: certification.schemaVersion must be 1`);
  }

  const policy = parseSharedCertificationPolicy({
    catalogMetadataPath,
    defaultRequiredMaturity: "production",
    diagnostics: violations,
    extensionGroups: extensionMatrix.groups,
    policyValue: value.policy,
    validRequiredMaturities: maturityOrder,
  });
  const recordsValue = value.records;
  if (!Array.isArray(recordsValue)) {
    violations.push(`${catalogMetadataPath}: certification.records must be an array`);
    return {
      policy,
      records: [],
      recordsByPackage: new Map(),
      schemaVersion: schemaVersion === 1 ? 1 : 0,
    };
  }

  const packageByFullName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const extensionByShortName = new Map(extensionMatrix.packages.map((pkg) => [pkg.shortName, pkg]));
  const recordKeys = new Set<string>();
  const records: CertificationRecord[] = [];

  for (const [index, recordValue] of recordsValue.entries()) {
    const record = parseCertificationRecord(
      index,
      recordValue,
      packageByFullName,
      extensionByShortName,
      recordKeys,
      violations,
    );
    if (record) {
      records.push(record);
    }
  }

  const recordsByPackage = new Map<string, CertificationRecord[]>();
  for (const record of records) {
    const existing = recordsByPackage.get(record.packageShortName) ?? [];
    recordsByPackage.set(record.packageShortName, [...existing, record]);
  }

  return {
    policy,
    records,
    recordsByPackage,
    schemaVersion: schemaVersion === 1 ? 1 : 0,
  };
}

function parseCertificationRecord(
  index: number,
  value: unknown,
  packageByFullName: ReadonlyMap<string, PackageRecord>,
  extensionByShortName: ReadonlyMap<string, ExtensionRecord>,
  recordKeys: Set<string>,
  violations: string[],
): CertificationRecord | null {
  const label = `certification.records[${index}]`;
  if (!isRecord(value)) {
    violations.push(`${catalogMetadataPath}: ${label} must be an object`);
    return null;
  }

  const packageName = readRequiredString(value.package, `${label}.package`, violations);
  const pkg = packageByFullName.get(packageName);
  if (!pkg) {
    violations.push(
      `${catalogMetadataPath}: ${label}.package references missing package ${packageName}`,
    );
    return null;
  }

  const extension = extensionByShortName.get(pkg.shortName);
  if (!extension) {
    violations.push(
      `${catalogMetadataPath}: ${label}.package ${packageName} must also be listed in extensionMatrix.packages`,
    );
    return null;
  }

  const contract = readRequiredString(value.contract, `${label}.contract`, violations);
  const packageVersion = readRequiredString(
    value.packageVersion,
    `${label}.packageVersion`,
    violations,
  );
  if (packageVersion && packageVersion !== pkg.version) {
    violations.push(
      `${catalogMetadataPath}: ${label}.packageVersion ${packageVersion} must match ${packageName} package.json version ${pkg.version}`,
    );
  }

  const adapterCategory = readAdapterCategory(
    value.adapterCategory,
    `${label}.adapterCategory`,
    violations,
  );
  const expectedAdapterCategory = adapterCategoryForGroup(extension.group);
  if (adapterCategory && expectedAdapterCategory && adapterCategory !== expectedAdapterCategory) {
    violations.push(
      `${catalogMetadataPath}: ${label}.adapterCategory ${adapterCategory} must match extensionMatrix group ${extension.group} (${expectedAdapterCategory})`,
    );
  }

  const runtimes = readRuntimeArray(value.runtimes, `${label}.runtimes`, violations);
  const extensionRuntimes = new Set(extension.extension.runtimes);
  for (const runtime of runtimes) {
    if (!extensionRuntimes.has(runtime)) {
      violations.push(
        `${catalogMetadataPath}: ${label}.runtimes claims ${runtime}, but extensionMatrix.packages.${pkg.shortName}.runtimes does not`,
      );
    }
  }

  const state = readCertificationState(value.state, `${label}.state`, violations);
  const evidence = parseCertificationEvidence(value.evidence, label, violations);
  const knownGaps = readStringArray(value.knownGaps, `${label}.knownGaps`, violations);
  const missingEvidence = [...evidence.entries()].filter(([, item]) => item.status === "missing");
  const missingEvidenceKeys = missingEvidence.map(([key]) => key);

  if (state === "certified" && missingEvidence.length > 0) {
    violations.push(
      `${catalogMetadataPath}: ${label}.state certified cannot have missing evidence: ${missingEvidenceKeys.join(", ")}`,
    );
  }

  if (state === "candidate") {
    const liveSmoke = evidence.get("liveSmoke");
    if (liveSmoke?.status !== "present") {
      violations.push(
        `${catalogMetadataPath}: ${label}.state candidate requires present liveSmoke evidence`,
      );
    }
  }

  const unnamedGaps = missingEvidenceKeys.filter(
    (key) => !knownGaps.some((gap) => gap.includes(key)),
  );
  if (unnamedGaps.length > 0) {
    violations.push(
      `${catalogMetadataPath}: ${label}.knownGaps must name the missing certification gaps: ${unnamedGaps.join(", ")}`,
    );
  }

  const recordKey = [packageName, contract, packageVersion, [...runtimes].sort().join(",")].join(
    "|",
  );
  if (recordKeys.has(recordKey)) {
    violations.push(
      `${catalogMetadataPath}: ${label} duplicates certification record ${recordKey}`,
    );
  }
  recordKeys.add(recordKey);

  if (
    !contract ||
    !packageVersion ||
    !adapterCategory ||
    runtimes.length === 0 ||
    !state ||
    evidence.size !== certificationEvidenceKeyOrder.length
  ) {
    return null;
  }

  return {
    adapterCategory,
    contract,
    evidence,
    knownGaps,
    packageName,
    packageShortName: pkg.shortName,
    packageVersion,
    runtimes,
    state,
  };
}

function parseCertificationEvidence(
  value: unknown,
  recordLabel: string,
  violations: string[],
): ReadonlyMap<CertificationEvidenceKey, CertificationEvidenceItem> {
  const evidence = new Map<CertificationEvidenceKey, CertificationEvidenceItem>();
  if (!isRecord(value)) {
    violations.push(`${catalogMetadataPath}: ${recordLabel}.evidence must be an object`);
    return evidence;
  }

  for (const key of certificationEvidenceKeyOrder) {
    const item = parseCertificationEvidenceItem(
      value[key],
      `${recordLabel}.evidence.${key}`,
      violations,
    );
    if (item) {
      evidence.set(key, item);
    }
  }

  return evidence;
}

function parseCertificationEvidenceItem(
  value: unknown,
  label: string,
  violations: string[],
): CertificationEvidenceItem | null {
  if (!isRecord(value)) {
    violations.push(`${catalogMetadataPath}: ${label} must be an object`);
    return null;
  }

  const status = readCertificationEvidenceStatus(value.status, `${label}.status`, violations);
  const command = readOptionalString(value.command, `${label}.command`, violations);
  const artifact = readOptionalString(value.artifact, `${label}.artifact`, violations);
  const description = readOptionalString(value.description, `${label}.description`, violations);
  const reason = readOptionalString(value.reason, `${label}.reason`, violations);

  if (status === "present" && !command && !artifact) {
    violations.push(
      `${catalogMetadataPath}: ${label} present evidence must include command or artifact`,
    );
  }

  if ((status === "missing" || status === "not-applicable") && !reason) {
    violations.push(`${catalogMetadataPath}: ${label} ${status} evidence must include reason`);
  }

  if (!status) {
    return null;
  }

  return {
    artifact,
    command,
    description,
    reason,
    status,
  };
}

function readAdapterCategory(
  value: unknown,
  key: string,
  violations: string[],
): AdapterCategoryKey | "" {
  if (typeof value !== "string" || !adapterCategoryOrder.includes(value as AdapterCategoryKey)) {
    violations.push(
      `${catalogMetadataPath}: ${key} must be one of ${adapterCategoryOrder.join(", ")}`,
    );
    return "";
  }

  return value as AdapterCategoryKey;
}

function readCertificationState(
  value: unknown,
  key: string,
  violations: string[],
): CertificationStateKey | "" {
  if (
    typeof value !== "string" ||
    !certificationStateOrder.includes(value as CertificationStateKey)
  ) {
    violations.push(
      `${catalogMetadataPath}: ${key} must be one of ${certificationStateOrder.join(", ")}`,
    );
    return "";
  }

  return value as CertificationStateKey;
}

function readCertificationEvidenceStatus(
  value: unknown,
  key: string,
  violations: string[],
): CertificationEvidenceStatus | "" {
  if (
    typeof value !== "string" ||
    !certificationEvidenceStatusOrder.includes(value as CertificationEvidenceStatus)
  ) {
    violations.push(
      `${catalogMetadataPath}: ${key} must be one of ${certificationEvidenceStatusOrder.join(", ")}`,
    );
    return "";
  }

  return value as CertificationEvidenceStatus;
}

function readOptionalString(value: unknown, key: string, violations: string[]): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "string" || value.length === 0) {
    violations.push(`${catalogMetadataPath}: ${key} must be a non-empty string when provided`);
    return "";
  }

  return value;
}

function adapterCategoryForGroup(group: string): AdapterCategoryKey | null {
  switch (group) {
    case "Provider":
      return "provider";
    case "Integration":
      return "integration";
    case "Transport":
      return "transport";
    case "Host":
      return "host";
    case "Presentation":
      return "presentation";
    default:
      return null;
  }
}

function readRequiredString(value: unknown, key: string, violations: string[]): string {
  if (typeof value !== "string" || value.length === 0) {
    violations.push(`${catalogMetadataPath}: ${key} must be a non-empty string`);
    return "";
  }

  return value;
}

function readRequiredStringArray(
  value: unknown,
  key: string,
  violations: string[],
): readonly string[] {
  if (!isStringArray(value) || value.length === 0) {
    violations.push(`${catalogMetadataPath}: ${key} must be a non-empty string array`);
    return [];
  }

  return value;
}

function readStringArray(value: unknown, key: string, violations: string[]): readonly string[] {
  if (!isStringArray(value)) {
    violations.push(`${catalogMetadataPath}: ${key} must be a string array`);
    return [];
  }

  return value;
}

function readRuntimeArray(
  value: unknown,
  key: string,
  violations: string[],
): readonly RuntimeKey[] {
  const runtimes = readRequiredStringArray(value, key, violations);
  const validRuntimes = new Set<string>(runtimeOrder);

  for (const runtime of runtimes) {
    if (!validRuntimes.has(runtime)) {
      violations.push(
        `${catalogMetadataPath}: ${key} contains unsupported runtime ${runtime}; expected one of ${runtimeOrder.join(", ")}`,
      );
    }
  }

  return runtimes.filter((runtime): runtime is RuntimeKey => validRuntimes.has(runtime));
}

function validateAssignments(
  label: string,
  assignments: ReadonlyMap<string, { readonly packages: readonly string[] }>,
  packages: readonly PackageInfo[],
  violations: string[],
): ReadonlyMap<string, string> {
  const actualPackages = new Set(packages.map((pkg) => pkg.shortName));
  const seen = new Map<string, string>();

  for (const [bucket, config] of assignments) {
    for (const packageName of config.packages) {
      if (!actualPackages.has(packageName)) {
        violations.push(
          `${catalogMetadataPath}: ${label} ${bucket} references missing package ${packageName}`,
        );
        continue;
      }

      const previousBucket = seen.get(packageName);
      if (previousBucket) {
        violations.push(
          `${catalogMetadataPath}: package ${packageName} appears in multiple ${label} buckets (${previousBucket}, ${bucket})`,
        );
        continue;
      }

      seen.set(packageName, bucket);
    }
  }

  for (const pkg of packages) {
    if (!seen.has(pkg.shortName)) {
      violations.push(
        `${catalogMetadataPath}: public package ${pkg.shortName} is missing ${label} metadata`,
      );
    }
  }

  return seen;
}

function loadDocsBaseline(
  rootDir: string,
  packages: readonly PackageRecord[],
  violations: string[],
): Baseline {
  const baseline = readJsonFile<DocsBaseline>(join(rootDir, docsBaselinePath));
  const actualPackages = new Set(packages.map((pkg) => pkg.shortName));
  const productionPackages = new Set(
    packages.filter((pkg) => pkg.maturity === "production").map((pkg) => pkg.shortName),
  );
  const allowedMissingReadme = readBaselineArray(
    "allowedMissingReadme",
    baseline.allowedMissingReadme,
    actualPackages,
    violations,
  );
  const allowedMissingApiDocs = readBaselineArray(
    "allowedMissingApiDocs",
    baseline.allowedMissingApiDocs,
    actualPackages,
    violations,
  );
  const allowedMissingTests = readBaselineArray(
    "allowedMissingTests",
    baseline.allowedMissingTests,
    actualPackages,
    violations,
  );
  const temporaryProductionApiDocExceptions = readTemporaryProductionApiDocExceptions(
    baseline.temporaryProductionApiDocExceptions,
    actualPackages,
    productionPackages,
    violations,
  );

  return {
    allowedMissingApiDocs,
    allowedMissingReadme,
    allowedMissingTests,
    temporaryProductionApiDocExceptions,
  };
}

function readBaselineArray(
  key: string,
  value: unknown,
  actualPackages: ReadonlySet<string>,
  violations: string[],
): ReadonlySet<string> {
  if (!isStringArray(value)) {
    violations.push(`${docsBaselinePath}: ${key} must be a string array`);
    return new Set();
  }

  const names = new Set<string>();
  for (const packageName of value) {
    if (!actualPackages.has(packageName)) {
      violations.push(`${docsBaselinePath}: ${key} references missing package ${packageName}`);
      continue;
    }
    names.add(packageName);
  }

  return names;
}

function readTemporaryProductionApiDocExceptions(
  value: unknown,
  actualPackages: ReadonlySet<string>,
  productionPackages: ReadonlySet<string>,
  violations: string[],
): ReadonlyMap<string, string> {
  if (value === undefined) {
    return new Map();
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    violations.push(
      `${docsBaselinePath}: temporaryProductionApiDocExceptions must be an object mapping production package names to non-empty justification strings`,
    );
    return new Map();
  }

  const exceptions = new Map<string, string>();
  for (const [packageName, reason] of Object.entries(value)) {
    if (!actualPackages.has(packageName)) {
      violations.push(
        `${docsBaselinePath}: temporaryProductionApiDocExceptions references missing package ${packageName}`,
      );
      continue;
    }

    if (!productionPackages.has(packageName)) {
      violations.push(
        `${docsBaselinePath}: temporaryProductionApiDocExceptions.${packageName} is only valid for production-ready packages`,
      );
      continue;
    }

    if (typeof reason !== "string" || reason.trim().length === 0) {
      violations.push(
        `${docsBaselinePath}: temporaryProductionApiDocExceptions.${packageName} must include a non-empty justification`,
      );
      continue;
    }

    exceptions.set(packageName, reason.trim());
  }

  return exceptions;
}

function validateCoverageBaseline(
  coverage: CoverageSet,
  baseline: Baseline,
  violations: string[],
): void {
  addUnexpectedCoverageGaps(
    "README",
    coverage.missingReadme,
    baseline.allowedMissingReadme,
    "Add packages/<name>/README.md or add a justified legacy baseline entry.",
    violations,
  );
  validateProductionApiDocsBaseline(coverage.missingApiDocs, baseline, violations);
  addUnexpectedCoverageGaps(
    "API docs",
    coverage.missingApiDocs.filter((pkg) => pkg.maturity !== "production"),
    baseline.allowedMissingApiDocs,
    "Generate packages/docs/src/content/docs/api/<name>/ or add a justified legacy baseline entry.",
    violations,
  );
  addUnexpectedCoverageGaps(
    "tests",
    coverage.missingTests,
    baseline.allowedMissingTests,
    "Add src/tests coverage or add a justified legacy baseline entry.",
    violations,
  );
}

function validatePresentationPresetRuntimeEvidence(
  rootDir: string,
  state: CatalogState,
  violations: string[],
): void {
  const presentationPreset = state.extensionMatrix.packages.find(
    (pkg) => pkg.shortName === "presentation-preset",
  );
  if (!presentationPreset) {
    return;
  }

  const profileCatalogPath = join(rootDir, presentationRuntimeProfilesPath);
  if (!existsSync(profileCatalogPath)) {
    violations.push(
      `${presentationRuntimeProfilesPath}: must exist to prove @croco/presentation-preset runtime claims`,
    );
    return;
  }

  const profileCatalog = readJsonFile<RuntimeProfileCatalog>(profileCatalogPath);
  validateRuntimeProfileCatalog(profileCatalog, presentationPreset.extension.runtimes, violations);
}

function validateRuntimeProfileCatalog(
  profileCatalog: RuntimeProfileCatalog,
  claimedRuntimes: readonly RuntimeKey[],
  violations: string[],
): void {
  if (profileCatalog.schemaVersion !== 1) {
    addRuntimeProfileViolation(
      violations,
      "Generated runtime profile catalog schemaVersion must be 1",
    );
  }
  if (
    typeof profileCatalog.validationCommand !== "string" ||
    profileCatalog.validationCommand.length === 0
  ) {
    addRuntimeProfileViolation(
      violations,
      "Generated runtime profile catalog validationCommand is required",
    );
  }

  const profiles = Array.isArray(profileCatalog.profiles) ? profileCatalog.profiles : [];
  if (profiles.length === 0) {
    addRuntimeProfileViolation(
      violations,
      "Generated runtime profile catalog must define at least one profile",
    );
  }

  const profileNames = new Set<string>();
  const profileRuntimes = new Set<string>();
  for (const [index, profileValue] of profiles.entries()) {
    if (!isRecord(profileValue)) {
      addRuntimeProfileViolation(violations, `profiles[${index}] must be an object`);
      continue;
    }

    validateRuntimeProfile(index, profileValue, profileNames, profileRuntimes, violations);
  }

  for (const runtime of claimedRuntimes) {
    if (!profileRuntimes.has(runtime)) {
      addRuntimeProfileViolation(
        violations,
        `Catalog runtime claim '${runtime}' has no generated runtime profile evidence`,
      );
    }
  }
}

function validateRuntimeProfile(
  index: number,
  profile: Readonly<Record<string, unknown>>,
  profileNames: Set<string>,
  profileRuntimes: Set<string>,
  violations: string[],
): void {
  const name = readRuntimeProfileString(profile, "name", index, violations);
  const runtime = readRuntimeProfileString(profile, "runtime", index, violations);
  readRuntimeProfileString(profile, "packageTestName", index, violations);
  const smokeCase = readRuntimeProfileString(profile, "generatedAppSmokeCase", index, violations);
  const smokeCommand = readRuntimeProfileString(
    profile,
    "generatedAppSmokeCommand",
    index,
    violations,
  );

  if (name) {
    if (profileNames.has(name)) {
      addRuntimeProfileViolation(violations, `Generated runtime profile '${name}' is duplicated`);
    }
    profileNames.add(name);
  }
  if (runtime) {
    if (!runtimeOrder.includes(runtime as RuntimeKey)) {
      addRuntimeProfileViolation(
        violations,
        `Generated runtime profile '${name}' has unsupported runtime '${runtime}'`,
      );
    } else {
      profileRuntimes.add(runtime);
    }
  }
  if (smokeCase && smokeCommand && !smokeCommand.includes(smokeCase)) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${name}' smoke command must include case '${smokeCase}'`,
    );
  }

  const target = profile.target;
  if (!isRecord(target)) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${name || index}' must include deploy target metadata`,
    );
    return;
  }

  validateRuntimeProfileTarget(name || String(index), runtime, target, violations);
}

function validateRuntimeProfileTarget(
  profileName: string,
  runtime: string,
  target: Readonly<Record<string, unknown>>,
  violations: string[],
): void {
  const targetName = readRequiredRuntimeProfileString(
    target.target,
    `Generated runtime profile '${profileName}' deploy target is required`,
    violations,
  );
  if (targetName && runtime && targetName !== runtime) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${profileName}' target '${targetName}' does not match runtime '${runtime}'`,
    );
  }

  if (target.requiredEnvVars !== undefined && !isStringArray(target.requiredEnvVars)) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${profileName}' requiredEnvVars must be a string array`,
    );
  }

  if (target.runtime !== undefined && !isRecord(target.runtime)) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${profileName}' runtime must be an object when provided`,
    );
  }

  if (isRecord(target.runtime)) {
    const nodeVersion = target.runtime.nodeVersion;
    const memory = target.runtime.memory;
    const timeout = target.runtime.timeout;
    if (
      nodeVersion !== undefined &&
      (typeof nodeVersion !== "string" || nodeVersion.length === 0)
    ) {
      addRuntimeProfileViolation(
        violations,
        `Generated runtime profile '${profileName}' runtime.nodeVersion must be non-empty when provided`,
      );
    }
    if (memory !== undefined && (typeof memory !== "number" || memory <= 0)) {
      addRuntimeProfileViolation(
        violations,
        `Generated runtime profile '${profileName}' runtime.memory must be greater than 0 when provided`,
      );
    }
    if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0)) {
      addRuntimeProfileViolation(
        violations,
        `Generated runtime profile '${profileName}' runtime.timeout must be greater than 0 when provided`,
      );
    }
  }

  if (!isRecord(target.output)) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${profileName}' deploy target output is required`,
    );
    return;
  }

  validateRuntimeProfileOutput(profileName, target.output, violations);
}

function validateRuntimeProfileOutput(
  profileName: string,
  output: Readonly<Record<string, unknown>>,
  violations: string[],
): void {
  readRequiredRuntimeProfileString(
    output.presetName,
    `Generated runtime profile '${profileName}' output presetName is required`,
    violations,
  );
  readRequiredRuntimeProfileString(
    output.buildTime,
    `Generated runtime profile '${profileName}' output buildTime is required`,
    violations,
  );

  const format = readRequiredRuntimeProfileString(
    output.format,
    `Generated runtime profile '${profileName}' output format is required`,
    violations,
  );
  if (format && !artifactFormatOrder.includes(format as (typeof artifactFormatOrder)[number])) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${profileName}' output format '${format}' is not supported`,
    );
  }

  const artifactPaths = new Set<string>();
  const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
  if (artifacts.length === 0) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${profileName}' output must define artifacts`,
    );
  }
  for (const [index, artifact] of artifacts.entries()) {
    if (!isRecord(artifact)) {
      addRuntimeProfileViolation(
        violations,
        `Generated runtime profile '${profileName}' artifact[${index}] must be an object`,
      );
      continue;
    }
    validateRuntimeProfileArtifact(profileName, index, artifact, artifactPaths, violations);
  }

  const entries = Array.isArray(output.entries) ? output.entries : [];
  if (entries.length === 0) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${profileName}' output must define entries`,
    );
  }
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      addRuntimeProfileViolation(
        violations,
        `Generated runtime profile '${profileName}' entry[${index}] must be an object`,
      );
      continue;
    }
    validateRuntimeProfileEntry(profileName, index, entry, artifactPaths, violations);
  }
}

function validateRuntimeProfileArtifact(
  profileName: string,
  index: number,
  artifact: Readonly<Record<string, unknown>>,
  artifactPaths: Set<string>,
  violations: string[],
): void {
  const path = readRequiredRuntimeProfileString(
    artifact.path,
    `Generated runtime profile '${profileName}' artifact[${index}].path is required`,
    violations,
  );
  const format = readRequiredRuntimeProfileString(
    artifact.format,
    `Generated runtime profile '${profileName}' artifact[${index}].format is required`,
    violations,
  );
  const type = readRequiredRuntimeProfileString(
    artifact.type,
    `Generated runtime profile '${profileName}' artifact[${index}].type is required`,
    violations,
  );

  if (path) {
    artifactPaths.add(path);
  }
  if (format && !artifactFormatOrder.includes(format as (typeof artifactFormatOrder)[number])) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${profileName}' artifact '${path}' has unsupported format '${format}'`,
    );
  }
  if (type && !artifactTypeOrder.includes(type as (typeof artifactTypeOrder)[number])) {
    addRuntimeProfileViolation(
      violations,
      `Generated runtime profile '${profileName}' artifact '${path}' has unsupported type '${type}'`,
    );
  }
}

function validateRuntimeProfileEntry(
  profileName: string,
  index: number,
  entry: Readonly<Record<string, unknown>>,
  artifactPaths: ReadonlySet<string>,
  violations: string[],
): void {
  readRequiredRuntimeProfileString(
    entry.exportName,
    `Generated runtime profile '${profileName}' entry[${index}].exportName is required`,
    violations,
  );
  const main = readRequiredRuntimeProfileString(
    entry.main,
    `Generated runtime profile '${profileName}' entry[${index}].main is required`,
    violations,
  );
  const types = readRequiredRuntimeProfileString(
    entry.types,
    `Generated runtime profile '${profileName}' entry[${index}].types is required`,
    violations,
  );
  const cjs = typeof entry.cjs === "string" ? entry.cjs : "";

  for (const referencedPath of [main, cjs, types].filter(Boolean)) {
    if (!artifactPaths.has(referencedPath)) {
      addRuntimeProfileViolation(
        violations,
        `Generated runtime profile '${profileName}' entry references '${referencedPath}' but no matching artifact exists`,
      );
    }
  }
}

function readRuntimeProfileString(
  profile: Readonly<Record<string, unknown>>,
  key: string,
  index: number,
  violations: string[],
): string {
  return readRequiredRuntimeProfileString(
    profile[key],
    `Generated runtime profile profiles[${index}].${key} is required`,
    violations,
  );
}

function readRequiredRuntimeProfileString(
  value: unknown,
  message: string,
  violations: string[],
): string {
  if (typeof value !== "string" || value.length === 0) {
    addRuntimeProfileViolation(violations, message);
    return "";
  }

  return value;
}

function addRuntimeProfileViolation(violations: string[], message: string): void {
  violations.push(`${presentationRuntimeProfilesPath}: ${message}`);
}

function validateProductionApiDocsBaseline(
  missingApiDocs: readonly PackageRecord[],
  baseline: Baseline,
  violations: string[],
): void {
  const missingProductionPackages = missingApiDocs.filter((pkg) => pkg.maturity === "production");
  const productionPackageNames = new Set(missingProductionPackages.map((pkg) => pkg.shortName));
  const legacyProductionEntries = [...baseline.allowedMissingApiDocs].filter((packageName) =>
    productionPackageNames.has(packageName),
  );
  const unapprovedProductionGaps = missingProductionPackages.filter(
    (pkg) => !baseline.temporaryProductionApiDocExceptions.has(pkg.shortName),
  );
  const staleTemporaryEntries = [...baseline.temporaryProductionApiDocExceptions.keys()].filter(
    (packageName) => !productionPackageNames.has(packageName),
  );

  if (legacyProductionEntries.length > 0) {
    violations.push(
      `production-ready packages cannot remain in allowedMissingApiDocs: ${legacyProductionEntries.join(", ")}. Generate API docs or move a short-lived, justified exception to temporaryProductionApiDocExceptions.`,
    );
  }

  if (unapprovedProductionGaps.length > 0) {
    violations.push(
      `production-ready packages missing API docs: ${unapprovedProductionGaps.map((pkg) => pkg.name).join(", ")}. Generate packages/docs/src/content/docs/api/<name>/ or add a short-lived, justified temporaryProductionApiDocExceptions entry.`,
    );
  }

  if (staleTemporaryEntries.length > 0) {
    violations.push(
      `temporaryProductionApiDocExceptions entries must match production-ready packages currently missing API docs: ${staleTemporaryEntries.join(", ")}`,
    );
  }
}

function addUnexpectedCoverageGaps(
  label: string,
  missingPackages: readonly PackageRecord[],
  allowedMissingPackages: ReadonlySet<string>,
  guidance: string,
  violations: string[],
): void {
  const unexpected = missingPackages.filter((pkg) => !allowedMissingPackages.has(pkg.shortName));
  if (unexpected.length === 0) {
    return;
  }

  violations.push(
    `new public packages missing ${label}: ${unexpected.map((pkg) => pkg.name).join(", ")}. ${guidance}`,
  );
}

function getCoverageSet(packages: readonly PackageRecord[]): CoverageSet {
  return {
    missingApiDocs: packages.filter((pkg) => !pkg.hasApiDocs),
    missingReadme: packages.filter((pkg) => !pkg.hasReadme),
    missingTests: packages.filter((pkg) => !pkg.hasTests),
  };
}

function validateArchitectureDocs(
  rootDir: string,
  state: CatalogState,
  violations: string[],
): void {
  for (const docsPath of collectMarkdownFiles(rootDir, publicDocsRootPath)) {
    const content = readRequiredFile(join(rootDir, docsPath));
    validateNoStaleLayerCount(docsPath, content, violations);
  }

  const architectureGuideAbsolutePath = join(rootDir, architectureGuidePath);
  if (!existsSync(architectureGuideAbsolutePath)) {
    violations.push(`${architectureGuidePath} must exist and describe the current architecture`);
    return;
  }

  const architectureGuide = readRequiredFile(architectureGuideAbsolutePath);
  validateArchitecturePackageReferences(architectureGuide, state, violations);
  validatePresentationLayerMention(architectureGuide, state, violations);
}

function collectMarkdownFiles(rootDir: string, docsPath: string): string[] {
  const absolutePath = join(rootDir, docsPath);
  if (!existsSync(absolutePath)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    const childPath = join(docsPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(rootDir, childPath));
      continue;
    }

    if (entry.isFile() && /\.(md|mdx)$/.test(entry.name)) {
      files.push(childPath);
    }
  }

  return files.sort();
}

function collectCertificationClaimedPackages(rootDir: string): ReadonlySet<string> {
  const claimedPackages = new Set<string>();

  for (const file of collectMarkdownClaimFiles(rootDir)) {
    const lines = readRequiredFile(join(rootDir, file)).split(/\r?\n/);
    let insideFence = false;

    for (const line of lines) {
      if (isFenceToggle(line)) {
        insideFence = !insideFence;
        continue;
      }

      if (insideFence || !hasCertificationClaim(line)) {
        continue;
      }

      for (const packageName of packageRefsForCertificationClaim(file, line)) {
        claimedPackages.add(packageName);
      }
    }
  }

  return claimedPackages;
}

function collectMarkdownClaimFiles(rootDir: string): readonly string[] {
  const files = new Set<string>();

  if (existsSync(join(rootDir, readmePath))) {
    files.add(readmePath);
  }

  for (const file of collectMarkdownFiles(rootDir, docsDirName)) {
    files.add(file);
  }

  collectPackageReadmes(rootDir, files);

  for (const file of collectMarkdownFiles(rootDir, publicDocsRootPath)) {
    files.add(file);
  }

  return [...files].sort();
}

function collectPackageReadmes(rootDir: string, files: Set<string>): void {
  const packagesDir = join(rootDir, "packages");
  if (!existsSync(packagesDir)) {
    return;
  }

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const readmeFile = join("packages", entry.name, "README.md");
    if (existsSync(join(rootDir, readmeFile))) {
      files.add(toPosixPath(readmeFile));
    }
  }
}

function isFenceToggle(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function hasCertificationClaim(line: string): boolean {
  return isCertificationClaimLine(line);
}

function packageRefsForCertificationClaim(file: string, line: string): readonly string[] {
  const explicitRefs = [...line.matchAll(/@croco\/([a-z0-9-]+)/g)].map((match) => match[1]);
  if (explicitRefs.length > 0) {
    return [...new Set(explicitRefs)];
  }

  const packageReadmeMatch = file.match(/^packages\/([^/]+)\/README\.md$/);
  return packageReadmeMatch ? [packageReadmeMatch[1]] : [];
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function validateNoStaleLayerCount(docsPath: string, content: string, violations: string[]): void {
  const staleLayerPatterns = [
    /\b4-layer\b/i,
    /\b4 layer\b/i,
    /\bfour clear layers\b/i,
    /\bfour layers\b/i,
  ];

  if (staleLayerPatterns.some((pattern) => pattern.test(content))) {
    violations.push(`${docsPath}: must not describe the current architecture as four layers`);
  }
}

function validateArchitecturePackageReferences(
  architectureGuide: string,
  state: CatalogState,
  violations: string[],
): void {
  const actualPackages = new Set(state.packages.map((pkg) => pkg.shortName));
  const packagePrefixes = new Set(state.packages.map((pkg) => `${pkg.shortName.split("-")[0]}-`));
  const packageReferences = collectPackageReferences(architectureGuide, packagePrefixes);

  for (const packageName of packageReferences) {
    if (!actualPackages.has(packageName)) {
      violations.push(
        `${architectureGuidePath}: references package ${packageName} that is not in ${catalogMetadataPath}`,
      );
    }
  }
}

function collectPackageReferences(
  content: string,
  packagePrefixes: ReadonlySet<string>,
): readonly string[] {
  const references = new Set<string>();
  const codeSpanPackageReferencePattern = /`(?:@croco\/)?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g;
  const packageReferencePattern = /(?:@croco\/)?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g;

  for (const match of content.matchAll(codeSpanPackageReferencePattern)) {
    references.add(match[1]);
  }

  for (const match of content.matchAll(packageReferencePattern)) {
    const rawReference = match[0];
    const packageName = match[1];
    if (rawReference.startsWith("@croco/") || hasPackagePrefix(packageName, packagePrefixes)) {
      references.add(packageName);
    }
  }

  return [...references].sort();
}

function hasPackagePrefix(packageName: string, packagePrefixes: ReadonlySet<string>): boolean {
  for (const prefix of packagePrefixes) {
    if (packageName.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function validatePresentationLayerMention(
  architectureGuide: string,
  state: CatalogState,
  violations: string[],
): void {
  const presentationGroup = state.groups.get("Presentation");
  if (!presentationGroup || presentationGroup.packages.length === 0) {
    return;
  }

  if (!/\bPresentation\b/.test(architectureGuide)) {
    violations.push(`${architectureGuidePath}: must include the Presentation layer`);
  }

  const referencesPresentationPackage = presentationGroup.packages.some(
    (packageName) =>
      architectureGuide.includes(packageName) ||
      architectureGuide.includes(`@croco/${packageName}`),
  );
  if (!referencesPresentationPackage) {
    violations.push(
      `${architectureGuidePath}: must reference at least one Presentation package from ${catalogMetadataPath}`,
    );
  }
}

function generateReadmeCatalog(state: CatalogState): string {
  const lines: string[] = [
    catalogStart,
    "",
    readmeCatalogHeading,
    "",
    "> 이 섹션은 `pnpm docs:catalog:write`로 생성됩니다. 패키지 이름과 경로는 `packages/*/package.json`에서 읽고, 그룹/성숙도는 `docs/package-catalog.json`에서 관리합니다.",
    "",
    `현재 카탈로그는 **${state.packages.length}개 public package**를 추적합니다. Private package ${state.privatePackageCount}개는 publish 카탈로그에서 제외됩니다. 문서 커버리지 상세는 [docs/package-docs-report.md](docs/package-docs-report.md)를 확인하세요.`,
    "",
    "### Croco 1.0 Spine",
    "",
    `${state.spine.label}은 ${state.spinePackages.length}개 package를 release-critical compatibility scope로 고정합니다. Source of truth는 \`docs/package-catalog.json\`의 \`spine.packages\`이며, 운영 가이드와 후속 release-gate issue 목록은 [Croco 1.0 Spine](docs/release/croco-1.0-spine.md)에 있습니다.`,
    "",
    "Spine membership is not a maturity claim: production-ready packages already have the strongest evidence gates, beta spine packages are allowed while their 1.0 gates harden, and non-spine beta/alpha packages do not block 1.0 unless they are pulled into a golden path or certified adapter path.",
    "",
    formatSpineStatusSummary(state),
    "",
    ...formatSpineStatusTable(state),
    "",
    ...formatSpinePackageTable(state),
    "",
    "### Package Groups",
    "",
    "| 그룹 | 역할 | 패키지 수 |",
    "| --- | --- | ---: |",
  ];

  for (const [group, config] of state.groups) {
    const count = state.packages.filter((pkg) => pkg.group === group).length;
    lines.push(`| ${group} | ${config.description} | ${count} |`);
  }

  lines.push(
    "",
    "### Maturity Guide",
    "",
    "Adapter 경계와 공식 우선순위, compatibility certification checklist는 [Adapter Ecosystem](packages/docs/src/content/docs/en/reference/adapter-ecosystem.md)에 정의되어 있습니다. 성숙도 승급 기준은 [Provider Maturity Gates](packages/docs/src/content/docs/en/reference/provider-maturity.md)와 [Presentation Runtime Support](packages/docs/src/content/docs/en/reference/presentation-runtime-support.md)에 정의되어 있으며, package test 존재 여부만으로 production-ready나 certified compatibility를 의미하지 않습니다. 1.0 spine은 release scope이고, production-ready는 package evidence state이며, certified adapter는 adapter/runtime/contract별 evidence state입니다.",
    "",
    "| 상태 | 의미 | 전체 public 패키지 수 |",
    "| --- | --- | ---: |",
  );

  for (const maturity of maturityOrder) {
    const config = state.maturity.get(maturity);
    if (!config) {
      continue;
    }
    const count = state.packages.filter((pkg) => pkg.maturity === maturity).length;
    lines.push(`| ${config.label} | ${maturityDescription(maturity)} | ${count} |`);
  }

  lines.push(
    "",
    "### Extension & Adapter Matrix",
    "",
    "> 이 섹션은 `docs/package-catalog.json`의 `extensionMatrix` metadata에서 생성됩니다. 성숙도와 package test 존재 여부는 별도 열로 표시합니다.",
    "",
    "Adapter category definitions, official priorities, package naming rules, minimum compatibility criteria, and the certification checklist live in [Adapter Ecosystem](packages/docs/src/content/docs/en/reference/adapter-ecosystem.md). Certification state is rendered from `docs/package-catalog.json` `certification.records` and is scoped to package, contract, runtime, package version, and evidence status.",
    "",
    formatCertificationPolicySentence(state.certification.policy),
    "",
    "Runtime columns: Node는 장기 실행 서버/CLI, Lambda는 서버리스 함수, Workers는 Cloudflare Workers, Frontend는 browser/SSR frontend integration을 의미합니다.",
  );
  appendExtensionMatrixTables(lines, state, "####");

  for (const maturity of maturityOrder) {
    const config = state.maturity.get(maturity);
    if (!config) {
      continue;
    }

    const packages = state.packages
      .filter((pkg) => pkg.maturity === maturity)
      .sort(
        (left, right) =>
          left.group.localeCompare(right.group) || left.shortName.localeCompare(right.shortName),
      );
    if (packages.length === 0) {
      continue;
    }

    lines.push(
      "",
      `### ${config.label}`,
      "",
      "| 패키지 | 그룹 | 디렉터리 | 문서 |",
      "| --- | --- | --- | --- |",
    );
    for (const pkg of packages) {
      lines.push(
        `| \`${pkg.name}\` | ${pkg.group} | \`packages/${pkg.dir}\` | ${formatDocsStatus(pkg)} |`,
      );
    }
  }

  lines.push(
    "",
    "### Documentation Gate",
    "",
    "- `pnpm docs:catalog:check`는 README 카탈로그, extension matrix reference 문서, 문서 커버리지 리포트 drift를 검증합니다.",
    "- 신규 public package는 `docs/package-catalog.json`에 그룹/성숙도 metadata가 있어야 합니다.",
    "- 신규 public package의 README, API docs, tests 누락은 `docs/package-docs-baseline.json`에 없는 한 실패합니다.",
    "- production-ready package의 API docs 누락은 legacy baseline으로 숨길 수 없고, 생성하거나 짧은 사유가 있는 `temporaryProductionApiDocExceptions`에만 임시로 둘 수 있습니다.",
    "",
    catalogEnd,
    "",
  );

  return lines.join("\n");
}

function generateDocsReport(
  state: CatalogState,
  coverage: CoverageSet,
  baseline: Baseline,
): string {
  const lines: string[] = [
    "# Package Documentation Report",
    "",
    "> Generated by `pnpm docs:catalog:write`. Do not edit this file by hand.",
    "",
    "## Summary",
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    `| Public packages | ${state.packages.length} |`,
    `| Private packages skipped | ${state.privatePackageCount} |`,
    `| Missing package README | ${coverage.missingReadme.length} |`,
    `| Missing generated API docs | ${coverage.missingApiDocs.length} |`,
    `| Missing package test directory | ${coverage.missingTests.length} |`,
    `| Extension matrix packages | ${state.extensionMatrix.packages.length} |`,
    `| Certification records | ${state.certification.records.length} |`,
    `| Croco 1.0 spine packages | ${state.spinePackages.length} |`,
    "",
    "New public packages must not add missing README, API docs, or test coverage unless the gap is explicitly listed in `docs/package-docs-baseline.json`. Production-ready packages must have generated API docs unless they have a short-lived justification in `temporaryProductionApiDocExceptions`.",
    "",
    "## Croco 1.0 Spine",
    "",
    `${state.spine.description}`,
    "",
    "Downstream release gates should select this package set from `docs/package-catalog.json` `spine.packages`. Spine membership is independent from maturity: non-spine alpha/beta packages can remain outside the 1.0 blocker set unless a golden path or certified adapter contract explicitly pulls them in.",
    "",
    formatSpineStatusSummary(state),
    "",
    ...formatSpineStatusTable(state),
    "",
    ...formatSpinePackageTable(state),
    "",
    "## Certification Policy",
    "",
    "Certification scope is defined by `docs/package-catalog.json` `certification.policy.scope` and enforced by `pnpm provider-certification:check`.",
    "",
    ...formatCertificationPolicyTable(state.certification.policy),
    "",
    "## Certification Records",
    "",
    "Certification records are validated from `docs/package-catalog.json` `certification.records`. Each row links a package catalog entry to one contract, package version, runtime set, state, evidence checklist, and explicit known gaps.",
    "",
    ...formatCertificationRecords(state.certification.records),
    "",
    "## Missing Package README",
    "",
    ...formatMissingPackages(coverage.missingReadme, baseline.allowedMissingReadme),
    "",
    "## Missing Generated API Docs",
    "",
    ...formatMissingApiDocs(coverage.missingApiDocs, baseline),
    "",
    "## Generated API Docs Backlog By Maturity",
    "",
    ...formatApiDocsBacklogByMaturity(state, coverage.missingApiDocs),
    "",
    "## Missing Test Directory",
    "",
    ...formatMissingPackages(coverage.missingTests, baseline.allowedMissingTests),
    "",
    "## Catalog Metadata",
    "",
    "| Group | Packages |",
    "| --- | ---: |",
  ];

  for (const [group] of state.groups) {
    lines.push(`| ${group} | ${state.packages.filter((pkg) => pkg.group === group).length} |`);
  }

  lines.push("", "| Maturity | Packages |", "| --- | ---: |");
  for (const maturity of maturityOrder) {
    const config = state.maturity.get(maturity);
    if (!config) {
      continue;
    }
    lines.push(
      `| ${config.label} | ${state.packages.filter((pkg) => pkg.maturity === maturity).length} |`,
    );
  }

  lines.push(
    "",
    "## Extension Matrix",
    "",
    "Extension matrix metadata is maintained in `docs/package-catalog.json` and rendered to the root README plus the docs reference page.",
    "",
    "| Group | Packages | Without package tests |",
    "| --- | ---: | ---: |",
  );
  for (const group of state.extensionMatrix.groups) {
    const packages = state.extensionMatrix.packages.filter((pkg) => pkg.group === group);
    lines.push(
      `| ${group} | ${packages.length} | ${packages.filter((pkg) => !pkg.hasTests).length} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function generateExtensionMatrixDocs(state: CatalogState): string {
  const lines: string[] = [
    "---",
    "title: Extension Matrix",
    "description: Official Croco provider and adapter compatibility matrix.",
    "---",
    "",
    "# Extension Matrix",
    "",
    "> Generated by `pnpm docs:catalog:write`. Do not edit this file by hand.",
    "",
    "This page lists Croco provider, integration, transport, host, and presentation adapter compatibility from `docs/package-catalog.json`. Required configuration, runtime support, package peer dependencies, maturity, package test presence, and certification evidence are intentionally separate so users can evaluate production readiness without treating a passing unit test as a maturity or compatibility certification claim.",
    "",
    "Certification state is rendered from `certification.records`. Records are scoped to package, Croco contract, runtime set, package version, and evidence status; missing evidence is shown as an explicit gap.",
    "",
    formatCertificationPolicySentence(state.certification.policy),
    "",
    "Adapter category definitions, official priorities, package naming rules, minimum compatibility criteria, and the certification checklist are defined in [Adapter Ecosystem](../adapter-ecosystem/). Provider promotion criteria are defined in [Provider Maturity Gates](../provider-maturity/). Presentation runtime and promotion criteria are defined in [Presentation Runtime Support](../presentation-runtime-support/).",
    "",
    "Runtime columns: Node covers long-running server and CLI use, Lambda covers serverless functions, Workers covers Cloudflare Workers, and Frontend covers browser or SSR frontend integration.",
  ];

  appendExtensionMatrixTables(lines, state, "##");

  lines.push("");
  return lines.join("\n");
}

function appendExtensionMatrixTables(
  lines: string[],
  state: CatalogState,
  headingPrefix: "##" | "####",
): void {
  for (const group of state.extensionMatrix.groups) {
    const packages = state.extensionMatrix.packages.filter((pkg) => pkg.group === group);
    if (packages.length === 0) {
      continue;
    }

    lines.push(
      "",
      `${headingPrefix} ${group}`,
      "",
      "| Package | Domain | Adapter | Node | Lambda | Workers | Frontend | Required env/config | Peer deps | Features | Maturity | Package tests | Certification |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );

    for (const pkg of packages) {
      const maturity = state.maturity.get(pkg.maturity)?.label ?? pkg.maturity;
      const certificationRecords = state.certification.recordsByPackage.get(pkg.shortName) ?? [];
      lines.push(
        `| \`${pkg.name}\` | ${pkg.extension.domain} | ${pkg.extension.adapter} | ${formatRuntimeSupport(pkg, "node")} | ${formatRuntimeSupport(pkg, "lambda")} | ${formatRuntimeSupport(pkg, "cloudflare-workers")} | ${formatRuntimeSupport(pkg, "browser")} | ${formatList(pkg.extension.requiredEnv)} | ${formatList(pkg.peerDependencies)} | ${formatList(pkg.extension.features)} | ${maturity} | ${formatPackageTestStatus(pkg)} | ${formatCertificationCell(pkg, certificationRecords, state.certification.policy, state.certificationClaimedPackages)} |`,
      );
    }
  }
}

function formatSpinePackageTable(state: CatalogState): string[] {
  if (state.spinePackages.length === 0) {
    return ["No spine packages are configured."];
  }

  const lines = ["| Package | Group | Maturity | Directory |", "| --- | --- | --- | --- |"];

  for (const pkg of state.spinePackages) {
    const maturity = state.maturity.get(pkg.maturity)?.label ?? pkg.maturity;
    lines.push(`| \`${pkg.name}\` | ${pkg.group} | ${maturity} | \`packages/${pkg.dir}\` |`);
  }

  return lines;
}

function formatSpineStatusSummary(state: CatalogState): string {
  const status = getSpineStatusCounts(state);

  return `Current 1.0 spine status: ${status.total} spine packages; ${status.production} production-ready, ${status.beta} beta, ${status.alpha} alpha/WIP, ${status.deprecated} deprecated; ${status.betaPromotionRecords} beta promotion records.`;
}

function formatSpineStatusTable(state: CatalogState): string[] {
  const status = getSpineStatusCounts(state);

  return [
    "| Generated status | Count | Source |",
    "| --- | ---: | --- |",
    `| Spine packages | ${status.total} | \`docs/package-catalog.json\` \`spine.packages\` |`,
    `| Production-ready spine packages | ${status.production} | \`maturity.production.packages\` |`,
    `| Beta spine packages | ${status.beta} | \`maturity.beta.packages\` |`,
    `| Alpha/WIP spine packages | ${status.alpha} | \`maturity.alpha.packages\` |`,
    `| Deprecated spine packages | ${status.deprecated} | \`maturity.deprecated.packages\` |`,
    `| Beta promotion records | ${status.betaPromotionRecords} | \`spine.promotion.packages\` |`,
  ];
}

function getSpineStatusCounts(state: CatalogState): {
  readonly alpha: number;
  readonly beta: number;
  readonly betaPromotionRecords: number;
  readonly deprecated: number;
  readonly production: number;
  readonly total: number;
} {
  const promotionPackages = new Set(state.spine.promotionPackages);
  const betaSpinePackages = state.spinePackages.filter((pkg) => pkg.maturity === "beta");

  return {
    alpha: state.spinePackages.filter((pkg) => pkg.maturity === "alpha").length,
    beta: betaSpinePackages.length,
    betaPromotionRecords: betaSpinePackages.filter((pkg) => promotionPackages.has(pkg.shortName))
      .length,
    deprecated: state.spinePackages.filter((pkg) => pkg.maturity === "deprecated").length,
    production: state.spinePackages.filter((pkg) => pkg.maturity === "production").length,
    total: state.spinePackages.length,
  };
}

function formatMissingPackages(
  packages: readonly PackageRecord[],
  allowedMissingPackages: ReadonlySet<string>,
): string[] {
  if (packages.length === 0) {
    return ["None."];
  }

  return packages.map((pkg) => {
    const baseline = allowedMissingPackages.has(pkg.shortName) ? "legacy baseline" : "new gap";
    return `- \`${pkg.name}\` (\`packages/${pkg.dir}\`) — ${baseline}`;
  });
}

function formatMissingApiDocs(packages: readonly PackageRecord[], baseline: Baseline): string[] {
  if (packages.length === 0) {
    return ["None."];
  }

  return packages.map((pkg) => {
    const temporaryReason = baseline.temporaryProductionApiDocExceptions.get(pkg.shortName);
    const status = temporaryReason
      ? `temporary production exception: ${temporaryReason}`
      : baseline.allowedMissingApiDocs.has(pkg.shortName)
        ? "legacy baseline"
        : "new gap";

    return `- \`${pkg.name}\` (\`packages/${pkg.dir}\`) — ${status}`;
  });
}

function formatApiDocsBacklogByMaturity(
  state: CatalogState,
  packages: readonly PackageRecord[],
): string[] {
  const lines = ["| Maturity | Missing API docs |", "| --- | ---: |"];

  for (const maturity of maturityOrder) {
    const config = state.maturity.get(maturity);
    if (!config) {
      continue;
    }

    lines.push(
      `| ${config.label} | ${packages.filter((pkg) => pkg.maturity === maturity).length} |`,
    );
  }

  return lines;
}

function formatCertificationRecords(records: readonly CertificationRecord[]): string[] {
  if (records.length === 0) {
    return ["No certification records configured."];
  }

  const lines = [
    "| Package | State | Contract | Runtimes | Version | Evidence | Known gaps |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const record of records) {
    lines.push(
      `| \`${record.packageName}\` | ${record.state} | \`${escapeMarkdownTableCell(record.contract)}\` | ${formatList(record.runtimes)} | \`${record.packageVersion}\` | ${formatCertificationEvidenceList(record)} | ${formatList(record.knownGaps.map(escapeMarkdownTableCell))} |`,
    );
  }

  return lines;
}

function formatCertificationEvidenceList(record: CertificationRecord): string {
  return certificationEvidenceKeyOrder
    .map((key) => {
      const item = record.evidence.get(key);
      return item ? `${key}: ${formatCertificationEvidenceItem(item)}` : `${key}: missing record`;
    })
    .join("<br>");
}

function formatCertificationEvidenceItem(item: CertificationEvidenceItem): string {
  const details = [item.command, item.artifact, item.description, item.reason]
    .filter(Boolean)
    .map(escapeMarkdownTableCell);
  return details.length > 0 ? `${item.status} (${details.join("; ")})` : item.status;
}

function formatCertificationPolicySentence(policy: CertificationPolicy): string {
  return `Certification policy: extension packages in ${formatInlineList(policy.scope.extensionGroups)} require a certified record when maturity is \`${policy.scope.requiredMaturity}\` or when public docs make a Croco compatibility claim; candidate records require present liveSmoke evidence, and extension packages without those triggers render as not-applicable until candidate evidence is recorded.`;
}

function formatCertificationPolicyTable(policy: CertificationPolicy): readonly string[] {
  return [
    "| Policy field | Value |",
    "| --- | --- |",
    `| Extension groups in scope | ${formatList(policy.scope.extensionGroups)} |`,
    `| Certified record required when | Extension package maturity is \`${policy.scope.requiredMaturity}\`, or public docs make a Croco compatibility claim. |`,
    `| \`certified-required\` | ${escapeMarkdownTableCell(policy.scope.states["certified-required"])} |`,
    `| \`candidate-optional\` | ${escapeMarkdownTableCell(policy.scope.states["candidate-optional"])} |`,
    `| \`not-applicable\` | ${escapeMarkdownTableCell(policy.scope.states["not-applicable"])} |`,
  ];
}

function formatCertificationCell(
  pkg: ExtensionRecord,
  records: readonly CertificationRecord[],
  policy: CertificationPolicy,
  claimedPackages: ReadonlySet<string>,
): string {
  if (records.length === 0) {
    if (
      pkg.maturity === policy.scope.requiredMaturity ||
      (policy.scope.claimRequiresCertified && claimedPackages.has(pkg.shortName))
    ) {
      return "certified-required<br>missing certification record";
    }

    return "not-applicable<br>not required until production-ready or compatibility claim";
  }

  return records.map(formatCertificationRecordCell).join("<br><br>");
}

function formatCertificationRecordCell(record: CertificationRecord): string {
  return [
    `${record.state} (${record.packageVersion})`,
    escapeMarkdownTableCell(record.contract),
    formatList(record.runtimes),
    formatCertificationGapSummary(record),
  ].join("<br>");
}

function formatCertificationGapSummary(record: CertificationRecord): string {
  const missing = certificationEvidenceKeyOrder.filter(
    (key) => record.evidence.get(key)?.status === "missing",
  );

  if (missing.length === 0) {
    return "evidence complete";
  }

  return `missing: ${missing.join(", ")}`;
}

function formatRuntimeSupport(pkg: ExtensionRecord, runtime: RuntimeKey): string {
  return pkg.extension.runtimes.includes(runtime) ? "yes" : "-";
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join("<br>") : "-";
}

function formatInlineList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function formatPackageTestStatus(pkg: PackageRecord): string {
  return pkg.hasTests ? "has package tests" : "no package tests";
}

function writeReadmeCatalog(rootDir: string, generatedCatalog: string): void {
  const readmeFilePath = join(rootDir, readmePath);
  const readme = readRequiredFile(readmeFilePath);
  writeGeneratedFile(readmeFilePath, replaceReadmeCatalog(readme, generatedCatalog));
}

function replaceReadmeCatalog(readme: string, generatedCatalog: string): string {
  const markerStartIndex = readme.indexOf(catalogStart);
  const markerEndIndex = readme.indexOf(catalogEnd);

  if (markerStartIndex !== -1 && markerEndIndex !== -1 && markerEndIndex > markerStartIndex) {
    const afterMarker = markerEndIndex + catalogEnd.length;
    return `${readme.slice(0, markerStartIndex)}${generatedCatalog}${readme.slice(afterMarker).replace(/^\n+/, "\n")}`;
  }

  const headingIndex = readme.indexOf(readmeCatalogHeading);
  const nextSectionIndex = readme.indexOf(readmeCatalogNextSection, headingIndex);

  if (headingIndex === -1 || nextSectionIndex === -1) {
    throw new Error(
      `README.md must contain ${readmeCatalogHeading} before ${readmeCatalogNextSection}`,
    );
  }

  return `${readme.slice(0, headingIndex).trimEnd()}\n\n${generatedCatalog}${readme.slice(nextSectionIndex)}`;
}

function writeGeneratedFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
}

function formatMarkdown(filePath: string, content: string): string {
  const localOxfmtPath = join(scriptRootDir, "node_modules", ".bin", "oxfmt");
  const hasLocalOxfmt = existsSync(localOxfmtPath);
  const result = spawnSync(
    hasLocalOxfmt ? localOxfmtPath : "pnpm",
    hasLocalOxfmt
      ? ["--stdin-filepath", filePath]
      : ["exec", "oxfmt", "--stdin-filepath", filePath],
    {
      cwd: scriptRootDir,
      encoding: "utf-8",
      input: content,
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `oxfmt failed for ${filePath}`);
  }

  return result.stdout;
}

function formatDocsStatus(pkg: PackageRecord): string {
  const labels = [];
  if (pkg.hasReadme) {
    labels.push("README");
  }
  if (pkg.hasApiDocs) {
    labels.push("API");
  }
  if (pkg.hasTests) {
    labels.push("tests");
  }

  return labels.length > 0 ? labels.join(", ") : "report gap";
}

function maturityDescription(maturity: MaturityKey): string {
  switch (maturity) {
    case "production":
      return "안정화, 적극 사용 권장";
    case "beta":
      return "기능 완성, 실사용 검증 중";
    case "alpha":
      return "개발 중, 사용 시 주의 필요";
    case "deprecated":
      return "대체 패키지 존재, 마이그레이션 권장";
  }
}

function toShortPackageName(packageName: string): string {
  return packageName.replace(/^@croco\//, "");
}

function readDependencyKeys(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readRequiredFile(filePath)) as T;
}

function readRequiredFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`${filePath} does not exist`);
  }

  return readFileSync(filePath, "utf-8");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
