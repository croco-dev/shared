import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIRECT_DIST_ENTRYPOINT_PACKAGES,
  ENTRYPOINT_EXEMPTIONS,
  effectivePublishManifest,
  exportConditionOrderDiagnostics,
  fieldMatchesPath,
  findPackageJsonFiles,
  packageHasSourceEntrypoint,
} from "./package-manifest-contracts.mjs";
import { isBoundedPeerDependencyRange } from "./peer-dependency-range-policy.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultRootDir = resolve(__dirname, "..");
const mode = parseArgs(process.argv.slice(2));
const spawnTimeoutMs = 180_000;
const spawnMaxBufferBytes = 16 * 1024 * 1024;
const nodeBuiltinModules = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

type PackageJson = {
  readonly dependencies?: Record<string, string>;
  readonly name?: string;
  readonly optionalDependencies?: Record<string, string>;
  readonly packageManager?: string;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
  readonly private?: boolean;
  readonly publishConfig?: Record<string, unknown>;
  readonly [key: string]: unknown;
};

type PackageInfo = {
  readonly packageDir: string;
  readonly packagePath: string;
  readonly packageName: string;
  readonly sourceManifest: PackageJson;
};

type PackedPackageInfo = PackageInfo & {
  readonly packedManifest: PackageJson;
  readonly tarballPath: string;
};

type SmokeTarget = {
  readonly fieldName: string;
  readonly kind: "json" | "module";
  readonly specifier: string;
  readonly target: string;
};

type PackageSmokePlan = {
  readonly cjs: SmokeTarget[];
  readonly diagnostics: string[];
  readonly esm: SmokeTarget[];
  readonly types: SmokeTarget[];
};

type PackageSmokeResult = {
  readonly cjsCount: number;
  readonly esmCount: number;
  readonly packageName: string;
  readonly typesCount: number;
};

type PublishArtifactTarget = {
  readonly fieldName: string;
  readonly target: string;
};

type DecoratorMetadataSmokeContract = {
  readonly constructorArity?: number;
  readonly defaults?: Readonly<Record<string, boolean | number | string>>;
  readonly injections?: Readonly<Record<string, number>>;
  readonly memberTypes?: readonly {
    readonly className: string;
    readonly memberName: string;
    readonly packageName?: string;
  }[];
  readonly metadataTypes?: readonly {
    readonly className: string;
    readonly optional?: boolean;
    readonly packageName?: string;
  }[];
  readonly serviceClass: string;
  readonly servicePackage: string;
};

type ExemptionResult = {
  readonly packageName: string;
  readonly reason: string;
};

type RunResult = {
  readonly stderr: string;
  readonly stdout: string;
};

type EsbuildMetafile = {
  readonly outputs?: Readonly<
    Record<
      string,
      {
        readonly inputs?: Readonly<Record<string, { readonly bytesInOutput?: number }>>;
      }
    >
  >;
};

const esbuildPath = createRequire(
  join(defaultRootDir, "packages/esbuild-plugin/package.json"),
).resolve("esbuild/bin/esbuild");

main();

function main(): void {
  const rootDir = mode.rootDir;
  const packRoot = mkdtempSync(join(tmpdir(), "croco-entrypoint-pack-"));
  const consumerRoot = mkdtempSync(join(tmpdir(), "croco-entrypoint-consumer-"));

  try {
    const packageManager = packageManagerFor(rootDir);
    const packageJsonFiles = findPackageJsonFiles(join(rootDir, "packages"));
    const packageIndex = packageIndexFor(packageJsonFiles);
    const diagnostics: string[] = [];
    const packedPackages = new Map<string, PackedPackageInfo>();
    const packageInfos: PackageInfo[] = [];
    const packageResults: PackageSmokeResult[] = [];
    const exemptions: ExemptionResult[] = [];
    let skippedPrivateCount = 0;

    for (const packagePath of packageJsonFiles) {
      const sourceManifest = readPackageJson(packagePath);

      if (sourceManifest.private === true) {
        skippedPrivateCount++;
        continue;
      }

      const packageName = packageNameFor(sourceManifest, packagePath);
      const exemption = ENTRYPOINT_EXEMPTIONS.get(packageName);
      if (exemption) {
        exemptions.push({ packageName, reason: exemption });
        continue;
      }

      if (!packageHasSourceEntrypoint(packagePath)) {
        diagnostics.push(
          `${relative(rootDir, packagePath)}: public package without src/index.ts needs an explicit entrypoint exemption`,
        );
        continue;
      }

      packageInfos.push({
        packageDir: dirname(packagePath),
        packageName,
        packagePath,
        sourceManifest,
      });
      diagnostics.push(...directDistRootPublishFaceDiagnostics(sourceManifest, packageName));
    }

    if (diagnostics.length > 0) {
      printCoverageSummary(packageResults, exemptions, skippedPrivateCount);
      printSmokeViolations(diagnostics);
      process.exitCode = 1;
      return;
    }

    if (mode.buildMissing) {
      buildMissingPackages(rootDir, packageInfos);
    }

    const buildPrerequisiteDiagnostics = buildPrerequisiteDiagnosticsFor(rootDir, packageInfos);
    if (buildPrerequisiteDiagnostics.length > 0) {
      printBuildPrerequisiteFailure(buildPrerequisiteDiagnostics);
      process.exitCode = 1;
      return;
    }

    for (const packageInfo of packageInfos) {
      const graph = collectInternalRuntimeGraph(packageInfo, packageIndex);
      for (const graphPackage of graph) {
        packPackage(graphPackage, packRoot, rootDir, packedPackages);
      }

      const packedPackage = packedPackages.get(packageInfo.packageName);
      if (!packedPackage) {
        throw new Error(`${packageInfo.packageName}: packed tarball was not created`);
      }

      const graphTarballs = graph.map((graphPackage) => {
        const packedGraphPackage = packedPackages.get(graphPackage.packageName);
        if (!packedGraphPackage) {
          throw new Error(`${graphPackage.packageName}: packed tarball was not created`);
        }
        return packedGraphPackage;
      });
      const plan = planPackageSmoke(packedPackage);
      const peerMetadataDiagnostics = packedPeerMetadataDiagnostics(packedPackage);
      const packedExportOrderDiagnostics = exportConditionOrderDiagnostics(
        packedPackage.packedManifest.exports,
        `${packedPackage.packageName}: packed exports`,
      );
      diagnostics.push(...peerMetadataDiagnostics);
      diagnostics.push(...packedExportOrderDiagnostics);
      diagnostics.push(...plan.diagnostics);
      if (
        peerMetadataDiagnostics.length === 0 &&
        packedExportOrderDiagnostics.length === 0 &&
        plan.diagnostics.length === 0
      ) {
        runPackageSmoke(consumerRoot, packedPackage, graphTarballs, packageManager, plan);
      }
      packageResults.push({
        cjsCount: plan.cjs.length,
        esmCount: plan.esm.length,
        packageName: packageInfo.packageName,
        typesCount: plan.types.length,
      });
    }

    printCoverageSummary(packageResults, exemptions, skippedPrivateCount);

    if (diagnostics.length > 0) {
      printSmokeViolations(diagnostics);
      process.exitCode = 1;
      return;
    }

    console.log("");
    console.log(
      `package-entrypoint-smoke: cjs, esm, and typescript consumers resolved for ${packageResults.length} packages`,
    );
  } finally {
    rmSync(packRoot, { force: true, recursive: true });
    rmSync(consumerRoot, { force: true, recursive: true });
  }
}

function packedPeerMetadataDiagnostics(packageInfo: PackedPackageInfo): string[] {
  const diagnostics: string[] = [];
  const sourcePeers = packageInfo.sourceManifest.peerDependencies ?? {};
  const packedPeers = packageInfo.packedManifest.peerDependencies ?? {};

  for (const [dependencyName, packedRange] of Object.entries(packedPeers)) {
    if (!isBoundedPeerDependencyRange(packedRange)) {
      diagnostics.push(
        `${packageInfo.packageName}: packed peerDependencies.${dependencyName} must use a bounded semver range, not ${JSON.stringify(packedRange)}`,
      );
    }
  }

  for (const [dependencyName, sourceRange] of Object.entries(sourcePeers)) {
    const packedRange = packedPeers[dependencyName];
    if (packedRange === undefined) {
      diagnostics.push(
        `${packageInfo.packageName}: packed peerDependencies.${dependencyName} is missing`,
      );
      continue;
    }

    if (sourceRange === "catalog:" || sourceRange.startsWith("workspace:")) {
      continue;
    }

    if (packedRange !== sourceRange) {
      diagnostics.push(
        `${packageInfo.packageName}: packed peerDependencies.${dependencyName} must preserve ${JSON.stringify(sourceRange)}, received ${JSON.stringify(packedRange)}`,
      );
    }
  }

  return diagnostics;
}

function parseArgs(args: readonly string[]): {
  readonly buildMissing: boolean;
  readonly rootDir: string;
} {
  let buildMissing = false;
  let rootDir = defaultRootDir;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--build-missing") {
      buildMissing = true;
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

  return { buildMissing, rootDir };
}

function buildMissingPackages(rootDir: string, packageInfos: readonly PackageInfo[]): void {
  const missingPackageNames = packageInfos
    .filter((packageInfo) => !packageHasBuildArtifacts(packageInfo))
    .map((packageInfo) => packageInfo.packageName);
  if (missingPackageNames.length === 0) {
    return;
  }

  run(
    "pnpm",
    [
      "turbo",
      "run",
      "build",
      ...missingPackageNames.map((packageName) => `--filter=${packageName}...`),
      "--output-logs=errors-only",
      "--ui=stream",
    ],
    rootDir,
    {
      label: `build ${missingPackageNames.length} missing package entrypoint prerequisite(s)`,
      timeoutMs: 600_000,
    },
  );
}

function buildPrerequisiteDiagnosticsFor(
  rootDir: string,
  packageInfos: readonly PackageInfo[],
): string[] {
  const missingBuildArtifacts = packageInfos.filter(
    (packageInfo) => !packageHasBuildArtifacts(packageInfo),
  );

  if (missingBuildArtifacts.length === 0) {
    return [];
  }

  const shownPackages = missingBuildArtifacts
    .slice(0, 10)
    .map(
      (packageInfo) =>
        `${packageInfo.packageName} (${relative(rootDir, join(packageInfo.packageDir, "dist"))})`,
    );
  const remainingCount = missingBuildArtifacts.length - shownPackages.length;
  const packageList =
    remainingCount > 0
      ? `${shownPackages.join(", ")}, and ${remainingCount} more`
      : shownPackages.join(", ");

  return [
    `${missingBuildArtifacts.length} public package(s) are missing build artifacts under dist.`,
    "Run pnpm build before pnpm package-entrypoints:smoke.",
    `Missing packages: ${packageList}.`,
    ...missingBuildArtifacts.flatMap((packageInfo) =>
      missingPublishArtifacts(packageInfo).map(
        ({ fieldName, target }) =>
          `${packageInfo.packageName}: ${fieldName} points to missing file ${target}`,
      ),
    ),
  ];
}

function packageHasBuildArtifacts(packageInfo: PackageInfo): boolean {
  const requiredArtifacts = publishArtifactTargetsFor(packageInfo);
  return (
    requiredArtifacts.length > 0 &&
    requiredArtifacts.every(({ target }) =>
      existsSync(join(packageInfo.packageDir, target.slice(2))),
    )
  );
}

function missingPublishArtifacts(packageInfo: PackageInfo): PublishArtifactTarget[] {
  return publishArtifactTargetsFor(packageInfo).filter(
    ({ target }) => !existsSync(join(packageInfo.packageDir, target.slice(2))),
  );
}

function publishArtifactTargetsFor(packageInfo: PackageInfo): PublishArtifactTarget[] {
  return publishArtifactTargets(
    effectivePublishManifest(packageInfo.sourceManifest) as Readonly<Record<string, unknown>>,
  );
}

function publishArtifactTargets(
  publishManifest: Readonly<Record<string, unknown>>,
): PublishArtifactTarget[] {
  const targets: PublishArtifactTarget[] = [];
  for (const fieldName of ["main", "module", "types", "typings", "exports", "bin"] as const) {
    collectPublishArtifactTargets(publishManifest[fieldName], fieldName, targets);
  }
  return targets.sort((left, right) => left.fieldName.localeCompare(right.fieldName));
}

function collectPublishArtifactTargets(
  value: unknown,
  fieldName: string,
  targets: PublishArtifactTarget[],
): void {
  if (typeof value === "string") {
    if (value.startsWith("./dist/")) {
      targets.push({ fieldName, target: value });
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [propertyName, nestedValue] of Object.entries(value)) {
    const nestedFieldName = /^[A-Za-z_$][\w$]*$/.test(propertyName)
      ? `${fieldName}.${propertyName}`
      : `${fieldName}[${JSON.stringify(propertyName)}]`;
    collectPublishArtifactTargets(nestedValue, nestedFieldName, targets);
  }
}

function printBuildPrerequisiteFailure(diagnostics: readonly string[]): void {
  console.log("");
  console.log("Package entrypoint smoke build prerequisite failed:");
  for (const diagnostic of diagnostics) {
    console.log(`- ${diagnostic}`);
  }
}

function printSmokeViolations(diagnostics: readonly string[]): void {
  console.log("");
  console.log("Package entrypoint smoke violations:");
  for (const diagnostic of diagnostics) {
    console.log(`- ${diagnostic}`);
  }
}

function readPackageJson(packagePath: string): PackageJson {
  return JSON.parse(readFileSync(packagePath, "utf-8")) as PackageJson;
}

function packageManagerFor(rootDir: string): string {
  const packageJsonPath = join(rootDir, "package.json");
  const rootManifest = readPackageJson(packageJsonPath);

  if (typeof rootManifest.packageManager !== "string" || rootManifest.packageManager.length === 0) {
    throw new Error(`${packageJsonPath}: packageManager must pin the pnpm version`);
  }

  return rootManifest.packageManager;
}

function packageNameFor(pkg: PackageJson, packagePath: string): string {
  if (typeof pkg.name === "string" && pkg.name.length > 0) {
    return pkg.name;
  }

  throw new Error(`${packagePath}: package name is required`);
}

function packageIndexFor(packageJsonFiles: readonly string[]): ReadonlyMap<string, PackageInfo> {
  const packageIndex = new Map<string, PackageInfo>();

  for (const packagePath of packageJsonFiles) {
    const sourceManifest = readPackageJson(packagePath);
    if (sourceManifest.private === true) {
      continue;
    }

    const packageName = packageNameFor(sourceManifest, packagePath);
    packageIndex.set(packageName, {
      packageDir: dirname(packagePath),
      packageName,
      packagePath,
      sourceManifest,
    });
  }

  return packageIndex;
}

function directDistRootPublishFaceDiagnostics(
  sourceManifest: PackageJson,
  packageName: string,
): string[] {
  if (!DIRECT_DIST_ENTRYPOINT_PACKAGES.has(packageName)) {
    return [];
  }

  const diagnostics: string[] = [];
  pushRootPublishFieldDiagnostic(
    sourceManifest,
    packageName,
    "main",
    "publishConfig.main",
    diagnostics,
  );
  pushRootPublishFieldDiagnostic(
    sourceManifest,
    packageName,
    "types",
    "publishConfig.types",
    diagnostics,
  );
  pushRootPublishFieldDiagnostic(
    sourceManifest,
    packageName,
    "exports",
    "publishConfig.exports",
    diagnostics,
  );

  return diagnostics;
}

function pushRootPublishFieldDiagnostic(
  sourceManifest: PackageJson,
  packageName: string,
  rootFieldName: string,
  publishFieldName: string,
  diagnostics: string[],
): void {
  if (!fieldMatchesPath(sourceManifest, rootFieldName, publishFieldName)) {
    diagnostics.push(`${packageName}: ${rootFieldName} must match ${publishFieldName}`);
  }
}

function runPackageSmoke(
  consumerRoot: string,
  packageInfo: PackedPackageInfo,
  graphPackages: readonly PackedPackageInfo[],
  packageManager: string,
  plan: PackageSmokePlan,
): void {
  const packageSmokeRoot = join(consumerRoot, safeDirectoryName(packageInfo.packageName));
  mkdirSync(packageSmokeRoot, { recursive: true });
  writeConsumerPackageJson(packageSmokeRoot, graphPackages, packageManager);

  const internalPeerTarballs = internalPeerPackagesFor(graphPackages).map(
    (packageInfo) => packageInfo.tarballPath,
  );

  run(
    "pnpm",
    ["add", "--prod", packageInfo.tarballPath, ...internalPeerTarballs, "--ignore-scripts"],
    packageSmokeRoot,
    {
      label: `${packageInfo.packageName}: install packed tarball`,
    },
  );
  console.log(
    `package-entrypoint-smoke: ${packageInfo.packageName} packed tarball installed with node-linker=isolated`,
  );

  writeEsmConsumer(packageSmokeRoot, plan.esm);
  writeCjsConsumer(packageSmokeRoot, plan.cjs);
  writeTypesConsumer(packageSmokeRoot, plan.types);

  if (plan.cjs.length > 0) {
    run("node", [join(packageSmokeRoot, "cjs.cjs")], packageSmokeRoot, {
      label: `${packageInfo.packageName}: cjs entrypoints`,
    });
  }
  if (plan.esm.length > 0) {
    run("node", [join(packageSmokeRoot, "esm.mjs")], packageSmokeRoot, {
      label: `${packageInfo.packageName}: esm entrypoints`,
    });
  }
  if (plan.types.length > 0) {
    run(
      process.execPath,
      [tscPath(), "-p", join(packageSmokeRoot, "tsconfig.json")],
      packageSmokeRoot,
      {
        label: `${packageInfo.packageName}: types entrypoints`,
      },
    );
  }

  if (packageInfo.packageName === "@croco/frontend-vite") {
    runFrontendViteOptionalPeerSmoke(packageSmokeRoot, packageInfo.packageName);
  }

  if (packageInfo.packageName === "@croco/testing-resources") {
    runTestingResourcesOptionalPeerSmoke(packageSmokeRoot, packageInfo.packageName);
  }

  if (packageInfo.packageName === "@croco/framework-logger") {
    runFrameworkLoggerStartupSmoke(packageSmokeRoot);
  }

  const decoratorMetadataContract = decoratorMetadataContractFor(packageInfo.packageName);
  if (decoratorMetadataContract) {
    runDecoratorMetadataSmoke(packageSmokeRoot, graphPackages, decoratorMetadataContract);
  }

  runPublishedBundleSmoke(packageSmokeRoot, packageInfo.packageName);
}

function runPublishedBundleSmoke(smokeRoot: string, packageName: string): void {
  if (packageName === "@croco/problems-core") {
    runPurePackageBundleSmoke(smokeRoot, packageName);
    return;
  }

  if (packageName === "@croco/audit-core") {
    runDecoratorBundleSmoke(smokeRoot);
    return;
  }

  if (packageName === "@croco/ui-astryx") {
    runCssBundleSmoke(smokeRoot);
  }
}

function runPurePackageBundleSmoke(smokeRoot: string, packageName: string): void {
  const entryPath = join(smokeRoot, "pure-bundle-entry.mjs");
  const bundlePath = join(smokeRoot, "pure-bundle.mjs");
  const metafilePath = join(smokeRoot, "pure-bundle-meta.json");
  writeFileSync(
    entryPath,
    `import ${JSON.stringify(packageName)};\nconsole.log("pure bundle ok");\n`,
  );

  runEsbuild(
    smokeRoot,
    [entryPath, "--bundle", `--outfile=${bundlePath}`, `--metafile=${metafilePath}`],
    {
      label: `${packageName}: removable pure package bundle`,
    },
  );

  const metafile = JSON.parse(readFileSync(metafilePath, "utf-8")) as EsbuildMetafile;
  const bundledPackageBytes = bundledBytesForPackage(metafile, packageName);
  if (bundledPackageBytes > 0) {
    throw new Error(
      `${packageName}: unused pure package import contributed ${bundledPackageBytes} byte(s) to the bundle`,
    );
  }

  run("node", [bundlePath], smokeRoot, { label: `${packageName}: execute pure package bundle` });
  console.log(`bundle tree-shaking ok ${packageName}`);
}

function runDecoratorBundleSmoke(smokeRoot: string): void {
  const initializerEntryPath = join(smokeRoot, "metadata-initializer-bundle-entry.mjs");
  const initializerBundlePath = join(smokeRoot, "metadata-initializer-bundle.mjs");
  writeFileSync(
    initializerEntryPath,
    [
      'import "@croco/audit-core";',
      'if (typeof Reflect.getMetadata !== "function") throw new Error("bundled metadata initialization was not retained");',
      'console.log("bundle metadata initialization ok @croco/audit-core");',
      "",
    ].join("\n"),
  );
  runEsbuild(smokeRoot, [initializerEntryPath, "--bundle", `--outfile=${initializerBundlePath}`], {
    label: "@croco/audit-core: metadata initializer bundle",
  });
  run("node", [initializerBundlePath], smokeRoot, {
    label: "@croco/audit-core: execute metadata initializer bundle",
  });
  console.log("bundle metadata initialization ok @croco/audit-core");

  const entryPath = join(smokeRoot, "decorator-bundle-entry.mjs");
  const bundlePath = join(smokeRoot, "decorator-bundle.mjs");
  writeFileSync(
    entryPath,
    [
      'import { AUDIT_PARAM_KEY, Auditable } from "@croco/audit-core";',
      "class AuditBundleService { run(resourceId) { return resourceId; } }",
      'const descriptor = Object.getOwnPropertyDescriptor(AuditBundleService.prototype, "run");',
      'Auditable({ action: "bundle.smoke", resourceIdIndex: 0, resourceType: "bundle" })(AuditBundleService.prototype, "run", descriptor);',
      'const metadata = Reflect.getMetadata?.(AUDIT_PARAM_KEY, AuditBundleService.prototype, "run");',
      'if (metadata?.resourceIdIndex !== 0) throw new Error("bundled @Auditable metadata was not retained");',
      'console.log("bundle decorator metadata ok @croco/audit-core");',
      "",
    ].join("\n"),
  );

  runEsbuild(smokeRoot, [entryPath, "--bundle", `--outfile=${bundlePath}`], {
    label: "@croco/audit-core: decorator metadata bundle",
  });
  run("node", [bundlePath], smokeRoot, {
    label: "@croco/audit-core: execute decorator metadata bundle",
  });
  console.log("bundle decorator metadata ok @croco/audit-core");
}

function runCssBundleSmoke(smokeRoot: string): void {
  const outputRoot = join(smokeRoot, "ui-astryx-bundle");
  const entryPath = join(smokeRoot, "ui-astryx-bundle-entry.mjs");
  const cssPath = join(outputRoot, "ui-astryx-bundle-entry.css");
  const metafilePath = join(smokeRoot, "ui-astryx-bundle-meta.json");
  writeFileSync(
    entryPath,
    'import "@croco/ui-astryx/styles.css";\nconsole.log("ui-astryx bundle ok");\n',
  );

  runEsbuild(
    smokeRoot,
    [entryPath, "--bundle", `--outdir=${outputRoot}`, `--metafile=${metafilePath}`],
    {
      label: "@croco/ui-astryx: retained CSS bundle",
    },
  );
  const metafile = JSON.parse(readFileSync(metafilePath, "utf-8")) as EsbuildMetafile;
  if (
    !existsSync(cssPath) ||
    bundledCssBytes(metafile) === 0 ||
    !bundleIncludesPackageInput(metafile, "@croco/ui-astryx", "/dist/styles.css")
  ) {
    throw new Error("@croco/ui-astryx: bundled CSS entrypoint was not retained");
  }

  run("node", [join(outputRoot, "ui-astryx-bundle-entry.js")], smokeRoot, {
    label: "@croco/ui-astryx: execute CSS consumer bundle",
  });
  console.log("bundle css retained @croco/ui-astryx/styles.css");
}

function bundledCssBytes(metafile: EsbuildMetafile): number {
  return Object.entries(metafile.outputs ?? {}).reduce((total, [outputPath, output]) => {
    if (!outputPath.endsWith(".css")) {
      return total;
    }
    return (
      total +
      Object.values(output.inputs ?? {}).reduce(
        (outputTotal, contribution) => outputTotal + (contribution.bytesInOutput ?? 0),
        0,
      )
    );
  }, 0);
}

function bundleIncludesPackageInput(
  metafile: EsbuildMetafile,
  packageName: string,
  inputSuffix: string,
): boolean {
  const packagePath = `/node_modules/${packageName}/`;
  return Object.values(metafile.outputs ?? {}).some((output) =>
    Object.keys(output.inputs ?? {}).some((input) => {
      const normalizedInput = input.replaceAll("\\", "/");
      return normalizedInput.includes(packagePath) && normalizedInput.endsWith(inputSuffix);
    }),
  );
}

function runEsbuild(
  cwd: string,
  args: readonly string[],
  options: { readonly label: string },
): void {
  run(
    esbuildPath,
    [...args, "--format=esm", "--platform=node", "--tree-shaking=true"],
    cwd,
    options,
  );
}

function bundledBytesForPackage(
  metafile: EsbuildMetafile,
  packageName: string,
  inputSuffix = "",
): number {
  const packagePath = `/node_modules/${packageName}/`;
  return Object.values(metafile.outputs ?? {}).reduce(
    (outputTotal, output) =>
      outputTotal +
      Object.entries(output.inputs ?? {}).reduce((inputTotal, [input, contribution]) => {
        const normalizedInput = input.replaceAll("\\", "/");
        if (!normalizedInput.includes(packagePath) || !normalizedInput.endsWith(inputSuffix)) {
          return inputTotal;
        }
        return inputTotal + (contribution.bytesInOutput ?? 0);
      }, 0),
    0,
  );
}

function runFrameworkLoggerStartupSmoke(packageSmokeRoot: string): void {
  const smokePath = join(packageSmokeRoot, "logger-startup.mjs");
  writeFileSync(
    smokePath,
    [
      'import { Logger } from "@croco/framework-logger";',
      'for (const environment of ["development", "production"]) {',
      "  process.env.NODE_ENV = environment;",
      '  const isProduction = environment === "production";',
      "  const config = {",
      "    isProduction,",
      '    get: (key) => key === "LOG_LEVEL" ? "silent" : undefined,',
      "  };",
      "  new Logger(config);",
      "  console.log(`framework logger ${environment} startup ok`);",
      "}",
      "",
    ].join("\n"),
  );

  run("node", [smokePath], packageSmokeRoot, {
    label: "@croco/framework-logger: development and production startup",
  });
  console.log("framework logger development startup ok");
  console.log("framework logger production startup ok");
}

function safeDirectoryName(packageName: string): string {
  return packageName.replaceAll("/", "__").replaceAll("@", "");
}

function collectInternalRuntimeGraph(
  rootPackage: PackageInfo,
  packageIndex: ReadonlyMap<string, PackageInfo>,
): PackageInfo[] {
  const graph = new Map<string, PackageInfo>();

  function visit(packageInfo: PackageInfo): void {
    if (graph.has(packageInfo.packageName)) {
      return;
    }

    graph.set(packageInfo.packageName, packageInfo);

    for (const dependencyName of internalRuntimeDependencyNames(packageInfo.sourceManifest)) {
      const dependencyPackage = packageIndex.get(dependencyName);
      if (dependencyPackage) {
        visit(dependencyPackage);
      }
    }
  }

  visit(rootPackage);

  return Array.from(graph.values()).sort((left, right) =>
    left.packageName.localeCompare(right.packageName),
  );
}

function internalRuntimeDependencyNames(pkg: PackageJson): string[] {
  const optionalPeers = optionalPeerDependencyNames(pkg.peerDependenciesMeta);

  return Array.from(
    new Set([
      ...dependencyNames(pkg.dependencies),
      ...dependencyNames(pkg.optionalDependencies),
      ...dependencyNames(pkg.peerDependencies).filter((name) => !optionalPeers.has(name)),
    ]),
  ).sort();
}

function installDependencyNames(pkg: PackageJson): string[] {
  return Array.from(
    new Set([
      ...dependencyNames(pkg.dependencies),
      ...dependencyNames(pkg.peerDependencies),
      ...dependencyNames(pkg.optionalDependencies),
    ]),
  ).sort();
}

function dependencyNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value).sort();
}

function optionalPeerDependencyNames(value: unknown): ReadonlySet<string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Set();
  }

  return new Set(
    Object.entries(value)
      .filter(([, meta]) =>
        Boolean(meta && typeof meta === "object" && "optional" in meta && meta.optional === true),
      )
      .map(([dependencyName]) => dependencyName)
      .sort(),
  );
}

function packPackage(
  packageInfo: PackageInfo,
  packRoot: string,
  rootDir: string,
  packedPackages: Map<string, PackedPackageInfo>,
): void {
  if (packedPackages.has(packageInfo.packageName)) {
    return;
  }

  run("pnpm", ["pack", "--pack-destination", packRoot], packageInfo.packageDir, {
    label: `${packageInfo.packageName}: pnpm pack`,
  });

  const tarballPath = findTarball(packRoot, packageInfo.packageName, rootDir);
  const packedManifest = readPackedJson(tarballPath, "package/package.json", rootDir);
  packedPackages.set(packageInfo.packageName, {
    ...packageInfo,
    packedManifest,
    tarballPath,
  });
}

function findTarball(packRoot: string, packageName: string, rootDir: string): string {
  const matches = readdirSync(packRoot)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => join(packRoot, entry))
    .filter((tarballPath) => {
      try {
        return readPackedJson(tarballPath, "package/package.json", rootDir).name === packageName;
      } catch {
        return false;
      }
    })
    .sort();

  const tarballPath = matches.at(-1);
  if (!tarballPath) {
    throw new Error(`${packageName}: missing packed tarball`);
  }

  return tarballPath;
}

function readPackedJson(tarballPath: string, entryPath: string, rootDir: string): PackageJson {
  return JSON.parse(readPackedFile(tarballPath, entryPath, rootDir)) as PackageJson;
}

function readPackedFile(tarballPath: string, entryPath: string, rootDir: string): string {
  const extractRoot = mkdtempSync(join(tmpdir(), "croco-packed-file-"));

  try {
    run("tar", ["-xf", tarballPath, "-C", extractRoot, entryPath], rootDir, {
      label: `${tarballPath}: extract ${entryPath}`,
    });
    return readFileSync(join(extractRoot, entryPath), "utf-8");
  } finally {
    rmSync(extractRoot, { force: true, recursive: true });
  }
}

function packedFileExists(tarballPath: string, entryPath: string, rootDir: string): boolean {
  const result = spawnSync("tar", ["-tf", tarballPath, entryPath], {
    cwd: rootDir,
    encoding: "utf-8",
    maxBuffer: spawnMaxBufferBytes,
    stdio: "pipe",
    timeout: spawnTimeoutMs,
  });

  if (result.error) {
    throw new Error(
      [
        `${tarballPath}: check ${entryPath} failed`,
        `${result.error.name}: ${result.error.message}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.status === 0;
}

function writeConsumerPackageJson(
  consumerRoot: string,
  graphPackages: readonly PackedPackageInfo[],
  packageManager: string,
): void {
  const overrides = Object.fromEntries(
    graphPackages.map((packageInfo) => [
      packageInfo.packageName,
      `file:${packageInfo.tarballPath}`,
    ]),
  );

  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "croco-package-entrypoint-smoke-consumer",
        packageManager,
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumerRoot, "pnpm-workspace.yaml"),
    `${JSON.stringify(
      {
        packages: [],
        overrides,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumerRoot, ".npmrc"),
    [
      "node-linker=isolated",
      "hoist=false",
      "auto-install-peers=true",
      "link-workspace-packages=false",
      "",
    ].join("\n"),
  );
}

function directInternalPeerDependencyNames(packageInfo: PackageInfo): string[] {
  const optionalPeers = optionalPeerDependencyNames(
    packageInfo.sourceManifest.peerDependenciesMeta,
  );

  return dependencyNames(packageInfo.sourceManifest.peerDependencies).filter(
    (dependencyName) => !optionalPeers.has(dependencyName) && dependencyName.startsWith("@croco/"),
  );
}

function internalPeerPackagesFor(graphPackages: readonly PackedPackageInfo[]): PackedPackageInfo[] {
  const packageIndex = new Map(
    graphPackages.map((packageInfo) => [packageInfo.packageName, packageInfo]),
  );
  const peerPackages = new Map<string, PackedPackageInfo>();

  for (const packageInfo of graphPackages) {
    for (const dependencyName of directInternalPeerDependencyNames(packageInfo)) {
      const peerPackage = packageIndex.get(dependencyName);
      if (peerPackage) {
        peerPackages.set(peerPackage.packageName, peerPackage);
      }
    }
  }

  return Array.from(peerPackages.values()).sort((left, right) =>
    left.packageName.localeCompare(right.packageName),
  );
}

function planPackageSmoke(packageInfo: PackedPackageInfo): PackageSmokePlan {
  const diagnostics: string[] = [];
  const packageName = packageNameFor(packageInfo.packedManifest, packageInfo.packagePath);
  const publishManifest = packageInfo.packedManifest;
  const exportsValue = publishManifest.exports;
  const exportEntries = collectExportEntries(packageName, exportsValue, diagnostics);
  const esm: SmokeTarget[] = [];
  const cjs: SmokeTarget[] = [];
  const types: SmokeTarget[] = [];

  if (exportEntries.length === 0) {
    pushStringTarget(packageName, publishManifest.main, "main", packageInfo, diagnostics, esm);
    pushStringTarget(packageName, publishManifest.types, "types", packageInfo, diagnostics, types);
  } else {
    for (const entry of exportEntries) {
      pushConditionalTarget(
        entry.specifier,
        entry.value,
        `${entry.fieldName}.import`,
        "import",
        packageInfo,
        diagnostics,
        esm,
      );
      pushConditionalTarget(
        entry.specifier,
        entry.value,
        `${entry.fieldName}.require`,
        "require",
        packageInfo,
        diagnostics,
        cjs,
      );
      pushConditionalTarget(
        entry.specifier,
        entry.value,
        `${entry.fieldName}.types`,
        "types",
        packageInfo,
        diagnostics,
        types,
      );
    }
  }

  if (esm.length === 0) {
    diagnostics.push(`${packageName}: no ESM import target found in the publish contract`);
  }

  if (types.length === 0) {
    diagnostics.push(`${packageName}: no declaration target found in the publish contract`);
  }

  for (const target of types) {
    validateDeclaredTypeDependencies(packageInfo, target, diagnostics);
  }
  for (const target of [...esm, ...cjs]) {
    validateDeclaredRuntimeDependencies(packageInfo, target, diagnostics);
  }

  return { cjs, diagnostics, esm, types };
}

function validateDeclaredRuntimeDependencies(
  packageInfo: PackedPackageInfo,
  target: SmokeTarget,
  diagnostics: string[],
): void {
  if (target.kind === "json") {
    return;
  }

  const declaredDependencies = new Set(installDependencyNames(packageInfo.packedManifest));
  const runtimeContent = stripTemplateLiterals(
    stripComments(
      readPackedFile(
        packageInfo.tarballPath,
        `package/${target.target.slice(2)}`,
        packageInfo.packageDir,
      ),
    ),
  );
  const packageName = packageInfo.packageName;
  const undeclaredDependencies = new Set<string>();

  for (const specifier of collectRuntimeImportSpecifiers(runtimeContent)) {
    const dependencyName = packageNameFromSpecifier(specifier);

    if (
      !dependencyName ||
      dependencyName === packageName ||
      nodeBuiltinModules.has(dependencyName) ||
      declaredDependencies.has(dependencyName)
    ) {
      continue;
    }

    undeclaredDependencies.add(dependencyName);
  }

  for (const dependencyName of Array.from(undeclaredDependencies).sort()) {
    diagnostics.push(
      `${packageName}: ${target.fieldName} imports undeclared runtime dependency ${dependencyName}`,
    );
  }
}

function validateDeclaredTypeDependencies(
  packageInfo: PackedPackageInfo,
  target: SmokeTarget,
  diagnostics: string[],
): void {
  const declaredDependencies = new Set(installDependencyNames(packageInfo.packedManifest));
  const declarationContent = stripComments(
    readPackedFile(
      packageInfo.tarballPath,
      `package/${target.target.slice(2)}`,
      packageInfo.packageDir,
    ),
  );
  const packageName = packageInfo.packageName;
  const undeclaredDependencies = new Set<string>();

  for (const specifier of collectDeclarationImportSpecifiers(declarationContent)) {
    const dependencyName = packageNameFromSpecifier(specifier);

    if (
      !dependencyName ||
      dependencyName === packageName ||
      nodeBuiltinModules.has(dependencyName) ||
      declaredDependencies.has(dependencyName) ||
      declaredDependencies.has(typeDeclarationPackageNameFor(dependencyName))
    ) {
      continue;
    }

    undeclaredDependencies.add(dependencyName);
  }

  for (const dependencyName of Array.from(undeclaredDependencies).sort()) {
    diagnostics.push(
      `${packageName}: ${target.fieldName} imports undeclared type dependency ${dependencyName}`,
    );
  }
}

function collectDeclarationImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const importDeclarationPattern =
    /^\s*import(?:\s+type)?(?:\s+[^;]*?\s+from)?\s*["']([^"']+)["']/gm;
  const exportDeclarationPattern = /^\s*export(?:\s+type)?\s+[^;]*?\s+from\s*["']([^"']+)["']/gm;
  const importTypePattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const pattern of [importDeclarationPattern, exportDeclarationPattern, importTypePattern]) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }

  return Array.from(specifiers).sort();
}

function collectRuntimeImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const importDeclarationPattern = /^\s*import(?:\s+[^;]*?\s+from)?\s*["']([^"']+)["']/gm;
  const exportDeclarationPattern = /^\s*export\s+[^;]*?\s+from\s*["']([^"']+)["']/gm;
  const importCallPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const requireCallPattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const pattern of [
    importDeclarationPattern,
    exportDeclarationPattern,
    importCallPattern,
    requireCallPattern,
  ]) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }

  return Array.from(specifiers).sort();
}

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function stripTemplateLiterals(content: string): string {
  let stripped = "";
  let inTemplate = false;
  let escaped = false;

  for (const character of content) {
    if (!inTemplate) {
      if (character === "`") {
        inTemplate = true;
        stripped += " ";
        continue;
      }

      stripped += character;
      continue;
    }

    if (escaped) {
      escaped = false;
      stripped += character === "\n" ? "\n" : " ";
      continue;
    }

    if (character === "\\") {
      escaped = true;
      stripped += " ";
      continue;
    }

    if (character === "`") {
      inTemplate = false;
      stripped += " ";
      continue;
    }

    stripped += character === "\n" ? "\n" : " ";
  }

  return stripped;
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return undefined;
  }

  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    if (!scope || !name) {
      return specifier;
    }

    return `${scope}/${name}`;
  }

  return specifier.split("/")[0];
}

function typeDeclarationPackageNameFor(packageName: string): string {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.slice(1).split("/");
    if (!scope || !name) {
      return `@types/${packageName.slice(1)}`;
    }

    return `@types/${scope}__${name}`;
  }

  return `@types/${packageName}`;
}

function collectExportEntries(
  packageName: string,
  exportsValue: unknown,
  diagnostics: string[],
): Array<{
  readonly fieldName: string;
  readonly specifier: string;
  readonly value: unknown;
}> {
  if (!exportsValue) {
    return [];
  }

  if (typeof exportsValue === "string") {
    return [
      {
        fieldName: "exports",
        specifier: packageName,
        value: exportsValue,
      },
    ];
  }

  if (typeof exportsValue !== "object" || Array.isArray(exportsValue)) {
    diagnostics.push(`${packageName}: exports must be a string or object`);
    return [];
  }

  return Object.entries(exportsValue).map(([exportPath, value]) => ({
    fieldName: `exports["${exportPath}"]`,
    specifier: specifierFor(packageName, exportPath),
    value,
  }));
}

function specifierFor(packageName: string, exportPath: string): string {
  if (exportPath === ".") {
    return packageName;
  }

  if (exportPath.startsWith("./")) {
    return `${packageName}/${exportPath.slice(2)}`;
  }

  return `${packageName}/${exportPath}`;
}

function pushConditionalTarget(
  specifier: string,
  value: unknown,
  fieldName: string,
  condition: "import" | "require" | "types",
  packageInfo: PackedPackageInfo,
  diagnostics: string[],
  targets: SmokeTarget[],
): void {
  if (typeof value === "string") {
    if (isStaticAssetTargetPath(value)) {
      if (condition === "import") {
        validateStaticAssetTarget(value, fieldName, packageInfo, diagnostics);
      }
      return;
    }

    if (condition === "types" && isJsonTargetPath(value)) {
      return;
    }

    pushStringTarget(specifier, value, fieldName, packageInfo, diagnostics, targets);
    return;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(
      `${packageNameFor(packageInfo.sourceManifest, packageInfo.packagePath)}: ${fieldName} must be a string`,
    );
    return;
  }

  const target = (value as Record<string, unknown>)[condition];
  if (target === undefined && condition === "require") {
    return;
  }
  if (condition === "types" && target && typeof target === "object" && !Array.isArray(target)) {
    const importTarget = (target as Record<string, unknown>).import;
    pushStringTarget(
      specifier,
      importTarget,
      `${fieldName}.import`,
      packageInfo,
      diagnostics,
      targets,
    );
    return;
  }
  if (typeof target === "string" && isStaticAssetTargetPath(target)) {
    validateStaticAssetTarget(target, fieldName, packageInfo, diagnostics);
    return;
  }
  if (condition === "types" && typeof target === "string" && isJsonTargetPath(target)) {
    return;
  }

  pushStringTarget(specifier, target, fieldName, packageInfo, diagnostics, targets);
}

function validateStaticAssetTarget(
  target: string,
  fieldName: string,
  packageInfo: PackedPackageInfo,
  diagnostics: string[],
): void {
  const packageName = packageNameFor(packageInfo.packedManifest, packageInfo.packagePath);

  if (!target.startsWith("./")) {
    diagnostics.push(`${packageName}: ${fieldName} must be a relative package file path`);
    return;
  }

  if (
    !packedFileExists(packageInfo.tarballPath, `package/${target.slice(2)}`, packageInfo.packageDir)
  ) {
    diagnostics.push(`${packageName}: ${fieldName} points to missing file ${target}`);
  }
}

function pushStringTarget(
  specifier: string,
  target: unknown,
  fieldName: string,
  packageInfo: PackedPackageInfo,
  diagnostics: string[],
  targets: SmokeTarget[],
): void {
  const packageName = packageNameFor(packageInfo.packedManifest, packageInfo.packagePath);

  if (typeof target !== "string") {
    diagnostics.push(`${packageName}: ${fieldName} must be a string`);
    return;
  }

  if (!target.startsWith("./")) {
    diagnostics.push(`${packageName}: ${fieldName} must be a relative package file path`);
    return;
  }

  if (
    !packedFileExists(packageInfo.tarballPath, `package/${target.slice(2)}`, packageInfo.packageDir)
  ) {
    diagnostics.push(`${packageName}: ${fieldName} points to missing file ${target}`);
    return;
  }

  targets.push({
    fieldName,
    kind: isJsonTargetPath(target) ? "json" : "module",
    specifier,
    target,
  });
}

function isJsonTargetPath(target: string): boolean {
  return target.endsWith(".json");
}

function isStaticAssetTargetPath(target: string): boolean {
  return target.endsWith(".css");
}

function writeEsmConsumer(smokeRoot: string, targets: readonly SmokeTarget[]): void {
  writeFileSync(
    join(smokeRoot, "esm.mjs"),
    [
      'process.env.SKIP_ENV_VALIDATION = "true";',
      "const targets = [",
      ...targets.map(
        (target) =>
          `  ${JSON.stringify({ json: target.kind === "json", specifier: target.specifier })},`,
      ),
      "];",
      "for (const target of targets) {",
      "  if (target.json) {",
      '    await import(target.specifier, { with: { type: "json" } });',
      "  } else {",
      "    await import(target.specifier);",
      "  }",
      "  console.log(`esm ok ${target.specifier}`);",
      "}",
      "",
    ].join("\n"),
  );
}

function writeCjsConsumer(smokeRoot: string, targets: readonly SmokeTarget[]): void {
  writeFileSync(
    join(smokeRoot, "cjs.cjs"),
    [
      'process.env.SKIP_ENV_VALIDATION = "true";',
      'const { createRequire } = require("node:module");',
      "const requireFromSmoke = createRequire(__filename);",
      "const targets = [",
      ...targets.map((target) => `  ${JSON.stringify(target.specifier)},`),
      "];",
      "for (const target of targets) {",
      "  requireFromSmoke(target);",
      "  console.log(`cjs ok ${target}`);",
      "}",
      "",
    ].join("\n"),
  );
}

function writeTypesConsumer(smokeRoot: string, targets: readonly SmokeTarget[]): void {
  writeFileSync(
    join(smokeRoot, "types.ts"),
    targets
      .flatMap((target, index) => [
        `import type * as Package${index} from ${JSON.stringify(target.specifier)};`,
        `type Package${index}Entrypoint = typeof Package${index};`,
        `declare const package${index}: Package${index}Entrypoint | undefined;`,
        `void package${index};`,
        "",
      ])
      .join("\n"),
  );
  writeFileSync(
    join(smokeRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2022",
        },
        include: ["types.ts"],
      },
      null,
      2,
    )}\n`,
  );
}

function decoratorMetadataContractFor(
  packageName: string,
): DecoratorMetadataSmokeContract | undefined {
  if (packageName === "@croco/auth-better-auth") {
    return {
      constructorArity: 1,
      injections: { factory: 0 },
      metadataTypes: [
        { className: "BetterAuthFactory", packageName: "@croco/auth-better-auth" },
        { className: "Object" },
      ],
      serviceClass: "BetterAuthProvider",
      servicePackage: "@croco/auth-better-auth",
    };
  }

  if (packageName === "@croco/features-posthog") {
    return {
      injections: { posthogClient: 0 },
      metadataTypes: [{ className: "PostHogClient", packageName: "@croco/integrations-posthog" }],
      serviceClass: "PostHogFeatureManager",
      servicePackage: "@croco/features-posthog",
    };
  }

  if (packageName === "@croco/metering-core") {
    return {
      defaults: { cacheTtlMs: 60_000 },
      injections: { repository: 0 },
      metadataTypes: [
        { className: "MeterRepository", packageName: "@croco/metering-core" },
        { className: "Number" },
        { className: "Object", optional: true },
      ],
      serviceClass: "MeterRegistry",
      servicePackage: "@croco/metering-core",
    };
  }

  if (packageName === "@croco/llm-core") {
    return {
      memberTypes: [{ className: "Function", memberName: "generate" }],
      serviceClass: "LlmService",
      servicePackage: "@croco/llm-core",
    };
  }

  return undefined;
}

function runDecoratorMetadataSmoke(
  smokeRoot: string,
  graphPackages: readonly PackedPackageInfo[],
  contract: DecoratorMetadataSmokeContract,
): void {
  const directDependencyTarballs = graphPackages
    .filter(
      (packageInfo) =>
        packageInfo.packageName === "@croco/framework-context" ||
        [...(contract.metadataTypes ?? []), ...(contract.memberTypes ?? [])].some(
          (metadataType) => metadataType.packageName === packageInfo.packageName,
        ),
    )
    .filter((packageInfo) => packageInfo.packageName !== contract.servicePackage)
    .map((packageInfo) => packageInfo.tarballPath);
  if (directDependencyTarballs.length > 0) {
    run("pnpm", ["add", "--prod", ...directDependencyTarballs, "--ignore-scripts"], smokeRoot, {
      label: `${contract.servicePackage}: install decorator metadata smoke dependencies`,
    });
  }

  const contractJson = JSON.stringify(contract);
  writeFileSync(
    join(smokeRoot, "decorator-metadata.cjs"),
    [
      `const contract = ${contractJson};`,
      'const { Container } = require("@croco/framework-context");',
      "const serviceModule = require(contract.servicePackage);",
      "const metadataModules = Object.fromEntries([...(contract.metadataTypes ?? []), ...(contract.memberTypes ?? [])].filter((type) => type.packageName).map((type) => [type.packageName, require(type.packageName)]));",
      'verifyDecoratorMetadata("cjs", Container, serviceModule, metadataModules, contract);',
      decoratorMetadataVerificationSource(),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(smokeRoot, "decorator-metadata.mjs"),
    [
      `const contract = ${contractJson};`,
      'const { Container } = await import("@croco/framework-context");',
      "const serviceModule = await import(contract.servicePackage);",
      "const metadataModules = Object.fromEntries(await Promise.all([...(contract.metadataTypes ?? []), ...(contract.memberTypes ?? [])].filter((type) => type.packageName).map(async (type) => [type.packageName, await import(type.packageName)])));",
      'verifyDecoratorMetadata("esm", Container, serviceModule, metadataModules, contract);',
      decoratorMetadataVerificationSource(),
      "",
    ].join("\n"),
  );

  run("node", [join(smokeRoot, "decorator-metadata.cjs")], smokeRoot, {
    label: `${contract.servicePackage}: cjs decorator metadata and implicit DI`,
  });
  console.log(`cjs decorator metadata and implicit DI ok ${contract.servicePackage}`);
  run("node", [join(smokeRoot, "decorator-metadata.mjs")], smokeRoot, {
    label: `${contract.servicePackage}: esm decorator metadata and implicit DI`,
  });
  console.log(`esm decorator metadata and implicit DI ok ${contract.servicePackage}`);
}

function decoratorMetadataVerificationSource(): string {
  return [
    "function verifyDecoratorMetadata(format, Container, serviceModule, metadataModules, contract) {",
    "  const Service = serviceModule[contract.serviceClass];",
    "  const resolveType = (type) => type.packageName ? metadataModules[type.packageName][type.className] : globalThis[type.className];",
    "  const expectedParamTypes = contract.metadataTypes?.map(resolveType);",
    "  if (expectedParamTypes) {",
    '    const paramTypes = Reflect.getMetadata?.("design:paramtypes", Service);',
    "    const requiredParamTypeCount = contract.metadataTypes.findIndex((type) => type.optional);",
    "    const minimumParamTypeCount = requiredParamTypeCount === -1 ? expectedParamTypes.length : requiredParamTypeCount;",
    "    if (!Array.isArray(paramTypes) || paramTypes.length < minimumParamTypeCount || paramTypes.length > expectedParamTypes.length || paramTypes.some((value, index) => value !== expectedParamTypes[index])) {",
    '      const actual = Array.isArray(paramTypes) ? paramTypes.map((value) => value?.name ?? typeof value).join(", ") : "missing";',
    '      const expected = contract.metadataTypes.map((type) => `${type.className}${type.optional ? "?" : ""}`).join(", ");',
    "      throw new Error(`[${format}] ${contract.serviceClass} design:paramtypes expected [${expected}], received [${actual}]`);",
    "    }",
    "  }",
    "  for (const memberType of contract.memberTypes ?? []) {",
    '    const designType = Reflect.getMetadata?.("design:type", Service.prototype, memberType.memberName);',
    "    const expectedType = resolveType(memberType);",
    "    if (designType !== expectedType) {",
    '      throw new Error(`[${format}] ${contract.serviceClass}.${memberType.memberName} design:type expected ${memberType.className}, received ${designType?.name ?? "missing"}`);',
    "    }",
    "  }",
    "  if (!expectedParamTypes) {",
    "    return;",
    "  }",
    "  if (contract.constructorArity !== undefined && Service.length !== contract.constructorArity) {",
    "    throw new Error(`[${format}] ${contract.serviceClass} expected constructor arity ${contract.constructorArity}, received ${Service.length}`);",
    "  }",
    "  const injectedValues = Object.fromEntries(Object.entries(contract.injections ?? {}).map(([field, metadataIndex]) => {",
    "    const Dependency = expectedParamTypes[metadataIndex];",
    "    const dependency = Object.create(Dependency.prototype);",
    "    Container.set(Dependency, dependency);",
    "    return [field, dependency];",
    "  }));",
    "  const service = Container.get(Service);",
    "  for (const [field, dependency] of Object.entries(injectedValues)) {",
    "    if (service[field] !== dependency) {",
    "      throw new Error(`[${format}] Container.get(${contract.serviceClass}) did not inject the registered ${expectedParamTypes[contract.injections[field]].name}`);",
    "    }",
    "  }",
    "  for (const [field, expected] of Object.entries(contract.defaults ?? {})) {",
    "    if (!Object.is(service[field], expected)) {",
    "      throw new Error(`[${format}] Container.get(${contract.serviceClass}) expected default ${field}=${expected}, received ${String(service[field])}`);",
    "    }",
    "  }",
    "  Container.reset();",
    "  console.log(`${format} decorator metadata and implicit DI ok ${contract.servicePackage}`);",
    "}",
  ].join("\n");
}

function runFrontendViteOptionalPeerSmoke(smokeRoot: string, packageName: string): void {
  removeCloudflareVitePlugin(smokeRoot);

  writeFileSync(
    join(smokeRoot, "frontend-vite-optional-peer.cjs"),
    [
      `const { crocoVitePlugin } = require("${packageName}");`,
      "const plugins = crocoVitePlugin({ cloudflare: false });",
      "if (!Array.isArray(plugins) || plugins.length !== 0) {",
      '  throw new Error("cloudflare: false should not create Cloudflare plugin options");',
      "}",
      'console.log("frontend-vite optional peer cjs ok");',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(smokeRoot, "frontend-vite-optional-peer.mjs"),
    [
      `const { crocoVitePlugin, MissingCloudflareVitePluginProblem } = await import("${packageName}");`,
      "const plugins = crocoVitePlugin({ cloudflare: false });",
      "if (!Array.isArray(plugins) || plugins.length !== 0) {",
      '  throw new Error("cloudflare: false should not create Cloudflare plugin options");',
      "}",
      "try {",
      "  await Promise.all(crocoVitePlugin());",
      "} catch (error) {",
      "  if (error instanceof MissingCloudflareVitePluginProblem && error.message.includes('Install \"@cloudflare/vite-plugin\"')) {",
      '    console.log("frontend-vite optional peer esm ok");',
      "    process.exit(0);",
      "  }",
      "  throw error;",
      "}",
      'throw new Error("default Cloudflare plugin unexpectedly resolved without @cloudflare/vite-plugin");',
      "",
    ].join("\n"),
  );

  run("node", [join(smokeRoot, "frontend-vite-optional-peer.cjs")], smokeRoot, {
    label: `${packageName}: frontend-vite optional peer cjs`,
  });
  run("node", [join(smokeRoot, "frontend-vite-optional-peer.mjs")], smokeRoot, {
    label: `${packageName}: frontend-vite optional peer esm`,
  });

  installBrokenCloudflareVitePlugin(smokeRoot);
  writeFileSync(
    join(smokeRoot, "frontend-vite-nested-error.mjs"),
    [
      `const { crocoVitePlugin } = await import("${packageName}");`,
      "try {",
      "  await Promise.all(crocoVitePlugin());",
      "} catch (error) {",
      "  if (!(error instanceof Error)) {",
      "    throw new Error('expected an Error from the broken Cloudflare plugin');",
      "  }",
      "  if (!error.message.includes('cloudflare-plugin-transitive-missing')) {",
      "    throw new Error(`expected nested missing dependency diagnostic, got: ${error.message}`);",
      "  }",
      "  if (error.message.includes('Install \"@cloudflare/vite-plugin\"')) {",
      "    throw new Error(`nested Cloudflare plugin errors must not be rewritten: ${error.message}`);",
      "  }",
      '  console.log("frontend-vite nested error ok");',
      "  process.exit(0);",
      "}",
      'throw new Error("broken Cloudflare plugin unexpectedly resolved");',
      "",
    ].join("\n"),
  );
  run("node", [join(smokeRoot, "frontend-vite-nested-error.mjs")], smokeRoot, {
    label: `${packageName}: frontend-vite nested peer error`,
  });
}

function runTestingResourcesOptionalPeerSmoke(smokeRoot: string, packageName: string): void {
  const strictTypesPath = join(smokeRoot, "testing-resources-strict-types.ts");
  const liveTypesPath = join(smokeRoot, "testing-resources-live-types.ts");
  const strictTsconfigPath = join(smokeRoot, "testing-resources-strict-tsconfig.json");
  writeFileSync(
    strictTypesPath,
    [
      `import { postgresResource, redisResource, type PostgresTestConnection, type RedisTestConnection } from ${JSON.stringify(packageName)};`,
      'const postgres = postgresResource({ mode: "commit" });',
      "const redis = redisResource();",
      "declare const postgresConnection: PostgresTestConnection;",
      "declare const redisConnection: RedisTestConnection;",
      "void postgres;",
      "void redis;",
      "void postgresConnection.query;",
      "void postgresConnection.pool.on;",
      "void redisConnection.client.hgetall;",
      "void redisConnection.client.pipeline;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    strictTsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["DOM", "ESNext"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          typeRoots: [join(defaultRootDir, "node_modules", "@types")],
          types: ["node"],
        },
        include: [liveTypesPath, strictTypesPath],
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, [tscPath(), "-p", strictTsconfigPath], smokeRoot, {
    label: `${packageName}: strict types without optional peers`,
  });

  const smokePath = join(smokeRoot, "testing-resources-optional-peers.mjs");
  writeFileSync(
    smokePath,
    [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      'for (const dependency of ["ioredis", "pg", "testcontainers"]) {',
      "  try {",
      "    require.resolve(dependency);",
      "  } catch (error) {",
      '    if (error instanceof Error && error.code === "MODULE_NOT_FOUND") {',
      "      continue;",
      "    }",
      "    throw error;",
      "  }",
      "  throw new Error(`${dependency} must not be installed for the base testing-resources path`);",
      "}",
      `const { postgresResource, redisResource, TestResourceMissingDependencyProblem } = await import(${JSON.stringify(packageName)});`,
      'const context = { register() {}, testId: "packed", workerId: "packed" };',
      "const cases = [",
      '  [postgresResource({ mode: "commit" }), "pnpm add -D pg@8.22.0 testcontainers@12.0.4"],',
      '  [redisResource(), "pnpm add -D ioredis@5.11.1 testcontainers@12.0.4"],',
      "];",
      "for (const [resource, installCommand] of cases) {",
      "  try {",
      "    await resource.start(context);",
      "  } catch (error) {",
      "    if (",
      "      error instanceof TestResourceMissingDependencyProblem &&",
      '      error.code === "testing-resources/missing-live-dependency" &&',
      "      error.message.includes(installCommand)",
      "    ) {",
      "      continue;",
      "    }",
      "    throw error;",
      "  }",
      '  throw new Error("live resource unexpectedly started without its optional peers");',
      "}",
      'console.log("testing-resources base install excludes live drivers and preserves actionable failures");',
      "",
    ].join("\n"),
  );

  run("node", [smokePath], smokeRoot, {
    label: `${packageName}: optional live-resource peers`,
  });

  run("pnpm", ["add", "--prod", "testcontainers@12.0.4", "--ignore-scripts"], smokeRoot, {
    label: `${packageName}: install container runtime without resource drivers`,
  });
  const missingDriverPath = join(smokeRoot, "testing-resources-missing-drivers.mjs");
  writeFileSync(
    missingDriverPath,
    [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      'for (const dependency of ["ioredis", "pg"]) {',
      "  try {",
      "    require.resolve(dependency);",
      "  } catch (error) {",
      '    if (error instanceof Error && error.code === "MODULE_NOT_FOUND") {',
      "      continue;",
      "    }",
      "    throw error;",
      "  }",
      "  throw new Error(`${dependency} must remain absent after installing only testcontainers`);",
      "}",
      `const { postgresResource, redisResource, TestResourceMissingDependencyProblem } = await import(${JSON.stringify(packageName)});`,
      'const context = { register() {}, testId: "packed", workerId: "packed" };',
      "const cases = [",
      '  [postgresResource({ mode: "commit" }), "pg", "pnpm add -D pg@8.22.0 testcontainers@12.0.4"],',
      '  [redisResource(), "ioredis", "pnpm add -D ioredis@5.11.1 testcontainers@12.0.4"],',
      "];",
      "for (const [resource, dependency, installCommand] of cases) {",
      "  try {",
      "    await resource.start(context);",
      "  } catch (error) {",
      "    if (",
      "      error instanceof TestResourceMissingDependencyProblem &&",
      '      error.code === "testing-resources/missing-live-dependency" &&',
      "      error.extensions?.dependency === dependency &&",
      "      error.extensions?.installCommand === installCommand",
      "    ) {",
      "      continue;",
      "    }",
      "    throw error;",
      "  }",
      "  throw new Error(`${dependency} resource unexpectedly started without its driver`);",
      "}",
      'console.log("testing-resources reports each missing resource driver before Docker startup");',
      "",
    ].join("\n"),
  );
  run("node", [missingDriverPath], smokeRoot, {
    label: `${packageName}: missing resource drivers with testcontainers installed`,
  });

  run(
    "pnpm",
    ["add", "--prod", "@types/pg@8.20.0", "ioredis@5.11.1", "pg@8.22.0", "--ignore-scripts"],
    smokeRoot,
    {
      label: `${packageName}: install live peers and PostgreSQL types`,
    },
  );
  writeFileSync(
    liveTypesPath,
    [
      'import { Redis } from "ioredis";',
      'import { Pool, type PoolClient } from "pg";',
      `import type { PostgresTestConnection, RedisTestConnection } from ${JSON.stringify(packageName)};`,
      'declare const postgresClient: NonNullable<PostgresTestConnection["client"]>;',
      'declare const postgresPool: PostgresTestConnection["pool"];',
      "declare const pgClient: PoolClient;",
      "const canonicalPostgresClient: PoolClient = postgresClient;",
      "const canonicalPostgresPool: Pool = postgresPool;",
      'const connectionPostgresClient: NonNullable<PostgresTestConnection["client"]> = pgClient;',
      'const connectionPostgresPool: PostgresTestConnection["pool"] = new Pool();',
      'declare const redisClient: RedisTestConnection["client"];',
      "const canonicalRedisClient: Redis = redisClient;",
      'const connectionRedisClient: RedisTestConnection["client"] = new Redis();',
      "void canonicalPostgresClient;",
      "void canonicalPostgresPool;",
      "void canonicalRedisClient;",
      "void connectionPostgresClient;",
      "void connectionPostgresPool;",
      "void connectionRedisClient;",
      "",
    ].join("\n"),
  );
  run(process.execPath, [tscPath(), "-p", strictTsconfigPath], smokeRoot, {
    label: `${packageName}: canonical live types`,
  });
}

function removeCloudflareVitePlugin(smokeRoot: string): void {
  rmSync(join(smokeRoot, "node_modules", "@cloudflare", "vite-plugin"), {
    force: true,
    recursive: true,
  });
}

function installBrokenCloudflareVitePlugin(smokeRoot: string): void {
  const packageDir = join(smokeRoot, "node_modules", "@cloudflare", "vite-plugin");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        exports: {
          ".": "./dist/index.mjs",
        },
        name: "@cloudflare/vite-plugin",
        type: "module",
        version: "0.0.0-smoke",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(packageDir, "dist", "index.mjs"),
    [
      "import 'cloudflare-plugin-transitive-missing';",
      "",
      "export function cloudflare() {",
      "  return [];",
      "}",
      "",
    ].join("\n"),
  );
}

function printCoverageSummary(
  packageResults: readonly PackageSmokeResult[],
  exemptions: readonly ExemptionResult[],
  skippedPrivateCount: number,
): void {
  console.log("package-entrypoint-smoke: checked packages");
  for (const result of packageResults) {
    console.log(
      `✓ ${result.packageName}: esm ${result.esmCount}, cjs ${result.cjsCount}, types ${result.typesCount}`,
    );
  }

  console.log("");
  console.log("package-entrypoint-smoke: exemptions");
  if (exemptions.length === 0) {
    console.log("- none");
  } else {
    for (const exemption of exemptions) {
      console.log(`- ${exemption.packageName}: ${exemption.reason}`);
    }
  }

  console.log("");
  console.log(
    `package-entrypoint-smoke: summary checked=${packageResults.length} exempt=${exemptions.length} skippedPrivate=${skippedPrivateCount}`,
  );
}

function tscPath(): string {
  return join(defaultRootDir, "node_modules", "typescript", "lib", "tsc.js");
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  options: {
    readonly expectedExitCode?: number;
    readonly label: string;
    readonly timeoutMs?: number;
  },
): RunResult {
  const expectedExitCode = options.expectedExitCode ?? 0;
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, DATABASE_URL: "" },
    maxBuffer: spawnMaxBufferBytes,
    stdio: "pipe",
    timeout: options.timeoutMs ?? spawnTimeoutMs,
  });

  if (result.error || result.status !== expectedExitCode) {
    throw new Error(
      [
        `${options.label}: ${command} ${args.map((arg) => relativeArg(cwd, arg)).join(" ")} failed`,
        `Expected exit code: ${expectedExitCode}`,
        `Actual exit code: ${result.status ?? "null"}`,
        result.error ? `${result.error.name}: ${result.error.message}` : undefined,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return {
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function relativeArg(cwd: string, arg: string): string {
  if (arg.startsWith(cwd)) {
    return relative(cwd, arg);
  }

  return arg;
}
