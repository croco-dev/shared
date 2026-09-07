import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_SMOKE_MATRIX_CASES } from "./create-croco-app-generated-smoke-matrix.mts";
import { collectGeneratedCrocoDependencyNames } from "./create-croco-app-generated-smoke-support.mts";

type WorkspacePackage = {
  readonly dependencies: readonly string[];
  readonly directory: string;
  readonly name: string;
};

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CROCO_PACKAGE_REFERENCE = /@croco\/[a-z0-9-]+/g;
const WORKSPACE_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const CASE_TEMPLATE_ROOTS = {
  "blank-basic": ["blank"],
  "goal-saas-api": ["saas"],
  "goal-spa-backend-split": ["spa-be-split"],
  "goal-worker": ["base-ddd", "addons/web-meta-vite-fullstack"],
  "goal-internal-tool": ["spa-be-split", "admin-console"],
  "graphql-standalone-api": [
    "base-ddd",
    "addons/graphql-standalone",
    "addons/mongodb",
    "addons/redis",
  ],
  "graphql-lambda-api": [
    "base-ddd",
    "addons/graphql-standalone",
    "addons/lambda",
    "addons/mongodb",
    "addons/redis",
  ],
  "trpc-nextjs-vercel-fullstack": [
    "base-ddd",
    "addons/trpc-nextjs",
    "addons/web-trpc",
    "addons/frontend-vercel",
  ],
  "graphql-nextjs-opennext": [
    "base-ddd",
    "addons/graphql-nextjs",
    "addons/web-graphql",
    "addons/frontend-opennext",
  ],
  "trpc-nextjs-docker-frontend": [
    "base-ddd",
    "addons/trpc-nextjs",
    "addons/web-trpc",
    "addons/docker",
  ],
  "graphql-vite-spa-docker": [
    "base-ddd",
    "addons/graphql-standalone",
    "addons/frontend-vite-spa",
    "addons/docker",
  ],
  "graphql-vite-spa-astryx": [
    "base-ddd",
    "addons/graphql-standalone",
    "addons/frontend-vite-spa",
    "addons/ui-astryx-vite-spa",
  ],
  "meta-vite-web": ["base-ddd", "addons/graphql-standalone", "addons/web-meta-vite"],
  "meta-vite-fullstack-workers": ["base-ddd", "addons/web-meta-vite-fullstack"],
  "production-app-starter": ["spa-be-split"],
  "admin-console-starter": ["spa-be-split", "admin-console"],
  "saas-golden-path": ["saas"],
  "saas-cloudflare-profile": ["saas"],
  "saas-lambda-profile": ["saas"],
  "ai-saas-golden-path": ["saas", "ai-saas"],
  "rest-spa-contracts": ["spa-be-split"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const CASE_TEST_PATH_PREFIXES = {
  "blank-basic": [],
  "goal-saas-api": ["saas/apps/"],
  "goal-spa-backend-split": ["spa-be-split/apps/"],
  "goal-worker": [],
  "goal-internal-tool": ["spa-be-split/apps/", "admin-console/apps/"],
  "graphql-standalone-api": [],
  "graphql-lambda-api": ["base-ddd/libs/shared/utils-env/"],
  "trpc-nextjs-vercel-fullstack": [],
  "graphql-nextjs-opennext": [],
  "trpc-nextjs-docker-frontend": [],
  "graphql-vite-spa-docker": [],
  "graphql-vite-spa-astryx": [],
  "meta-vite-web": ["base-ddd/libs/shared/utils-env/"],
  "meta-vite-fullstack-workers": ["base-ddd/libs/shared/utils-env/"],
  "production-app-starter": ["spa-be-split/apps/", "spa-be-split/tests/journeys/"],
  "admin-console-starter": [
    "spa-be-split/apps/",
    "admin-console/apps/",
    "admin-console/tests/journeys/plan-release.spec.ts",
  ],
  "saas-golden-path": ["saas/apps/"],
  "saas-cloudflare-profile": ["saas/apps/"],
  "saas-lambda-profile": ["saas/apps/"],
  "ai-saas-golden-path": ["saas/apps/", "ai-saas/apps/"],
  "rest-spa-contracts": [],
} as const satisfies Readonly<Record<keyof typeof CASE_TEMPLATE_ROOTS, readonly string[]>>;

const CASE_SAAS_PROVIDER_PROFILES = {
  "goal-saas-api": "saas-node-postgres",
  "saas-golden-path": "saas-node-postgres",
  "saas-cloudflare-profile": "saas-cloudflare",
  "saas-lambda-profile": "saas-lambda",
  "ai-saas-golden-path": "saas-node-postgres",
} as const satisfies Partial<Record<keyof typeof CASE_TEMPLATE_ROOTS, string>>;

const CASE_TENANT_MODELS = {
  "goal-saas-api": "org",
  "saas-golden-path": "rls-backed",
  "saas-cloudflare-profile": "workspace",
  "saas-lambda-profile": "shared-schema",
  "ai-saas-golden-path": "single",
} as const satisfies Partial<Record<keyof typeof CASE_TEMPLATE_ROOTS, string>>;

const CASE_ADDITIONAL_DEPENDENCY_SOURCES = {
  "graphql-lambda-api": ["packages/create-croco-app/src/installers/lambda.ts"],
  "graphql-vite-spa-astryx": ["packages/create-croco-app/src/installers/ui-profile.ts"],
} as const satisfies Partial<Record<keyof typeof CASE_TEMPLATE_ROOTS, readonly string[]>>;

export function assertGeneratedSmokeDependencyMapping(rootDir = ROOT_DIR): void {
  const matrixNames = GENERATED_SMOKE_MATRIX_CASES.map(({ name }) => name).sort();
  const mappedNames = Object.keys(CASE_TEMPLATE_ROOTS).sort();
  if (JSON.stringify(matrixNames) !== JSON.stringify(mappedNames)) {
    throw new Error(
      `Generated smoke dependency mapping drift: matrix=${matrixNames.join(", ")} mapping=${mappedNames.join(", ")}`,
    );
  }

  for (const [caseName, templateRoots] of Object.entries(CASE_TEMPLATE_ROOTS)) {
    for (const templateRoot of templateRoots) {
      const absoluteRoot = join(rootDir, "packages", "create-croco-app", "templates", templateRoot);
      if (!existsSync(absoluteRoot)) {
        throw new Error(
          `Generated smoke dependency mapping for ${caseName} references missing template root ${templateRoot}`,
        );
      }
    }
  }

  for (const [caseName, profileName] of Object.entries(CASE_SAAS_PROVIDER_PROFILES)) {
    if (!readSaasProviderProfileReferences(rootDir, profileName).length) {
      throw new Error(
        `Generated smoke dependency mapping for ${caseName} references missing SaaS provider profile ${profileName}`,
      );
    }
  }

  const defaultSaasProfile = readDefaultSourceValue(
    join(rootDir, "packages", "create-croco-app", "src", "saas-provider-profiles.ts"),
    "DEFAULT_SAAS_PROVIDER_PROFILE",
  );
  for (const caseName of ["goal-saas-api", "ai-saas-golden-path"] as const) {
    if (CASE_SAAS_PROVIDER_PROFILES[caseName] !== defaultSaasProfile) {
      throw new Error(
        `Generated smoke dependency mapping for ${caseName} must use default SaaS provider profile ${String(defaultSaasProfile)}`,
      );
    }
  }

  for (const [caseName, tenantModel] of Object.entries(CASE_TENANT_MODELS)) {
    if (!readTenantModelReferences(rootDir, tenantModel).length) {
      throw new Error(
        `Generated smoke dependency mapping for ${caseName} references missing tenant model ${tenantModel}`,
      );
    }
  }

  const defaultTenantModel = readDefaultSourceValue(
    join(rootDir, "packages", "tenant-core", "src", "libs", "TenantModelManifest.ts"),
    "DEFAULT_TENANT_MODEL",
  );
  if (CASE_TENANT_MODELS["goal-saas-api"] !== defaultTenantModel) {
    throw new Error(
      `Generated smoke dependency mapping for goal-saas-api must use default tenant model ${String(defaultTenantModel)}`,
    );
  }

  for (const [caseName, sources] of Object.entries(CASE_ADDITIONAL_DEPENDENCY_SOURCES)) {
    for (const source of sources) {
      if (!existsSync(join(rootDir, source))) {
        throw new Error(
          `Generated smoke dependency mapping for ${caseName} references missing dependency source ${source}`,
        );
      }
    }
  }
}

export function selectGeneratedSmokeCasesForChangedFiles(
  changedFiles: readonly string[],
  rootDir = ROOT_DIR,
): readonly string[] {
  assertGeneratedSmokeDependencyMapping(rootDir);
  const workspacePackages = readWorkspacePackages(rootDir);
  const changedPackages = new Set(
    changedFiles.flatMap((path) => {
      const workspacePackage = workspacePackages.find(
        ({ directory }) => path === directory || path.startsWith(`${directory}/`),
      );
      return workspacePackage ? [workspacePackage.name] : [];
    }),
  );
  if (changedPackages.size === 0) return [];

  const packagesByName = new Map(
    workspacePackages.map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  );
  return Object.entries(CASE_TEMPLATE_ROOTS)
    .filter(([caseName]) => {
      const directDependencies = new Set(
        readGeneratedSmokeCaseDirectDependencies(caseName, rootDir),
      );
      const dependencyClosure = expandDependencyClosure(directDependencies, packagesByName);
      return [...changedPackages].some((packageName) => dependencyClosure.has(packageName));
    })
    .map(([caseName]) => caseName);
}

export function selectGeneratedTestPathsForSmokeCases(
  caseNames: readonly string[],
  generatedTestPaths: readonly string[],
): readonly string[] {
  const selections = caseNames.map((caseName) => {
    const selected = CASE_TEST_PATH_PREFIXES[caseName as keyof typeof CASE_TEST_PATH_PREFIXES];
    if (!selected) throw new Error(`Unknown generated smoke case: ${caseName}`);
    return {
      prefixes: selected.map((prefix) => `packages/create-croco-app/templates/${prefix}`),
      excludesNodeLifecycle:
        caseName === "saas-cloudflare-profile" || caseName === "saas-lambda-profile",
    };
  });
  return generatedTestPaths
    .filter((path) =>
      selections.some(
        ({ prefixes, excludesNodeLifecycle }) =>
          !(
            excludesNodeLifecycle &&
            path ===
              "packages/create-croco-app/templates/saas/apps/api-server/src/tests/node-lifecycle.spec.ts"
          ) &&
          prefixes.some((prefix) =>
            prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix,
          ),
      ),
    )
    .sort();
}

export function readGeneratedSmokeCaseDirectDependencies(
  caseName: string,
  rootDir = ROOT_DIR,
): readonly string[] {
  const templateRoots = CASE_TEMPLATE_ROOTS[caseName as keyof typeof CASE_TEMPLATE_ROOTS];
  if (!templateRoots) {
    throw new Error(`Unknown generated smoke case: ${caseName}`);
  }
  return [
    ...new Set([
      ...templateRoots.flatMap((templateRoot) =>
        readTemplatePackageReferences(
          join(rootDir, "packages", "create-croco-app", "templates", templateRoot),
        ),
      ),
      ...readSaasProviderProfileReferences(
        rootDir,
        CASE_SAAS_PROVIDER_PROFILES[caseName as keyof typeof CASE_SAAS_PROVIDER_PROFILES],
      ),
      ...readTenantModelReferences(
        rootDir,
        CASE_TENANT_MODELS[caseName as keyof typeof CASE_TENANT_MODELS],
      ),
      ...(
        CASE_ADDITIONAL_DEPENDENCY_SOURCES[
          caseName as keyof typeof CASE_ADDITIONAL_DEPENDENCY_SOURCES
        ] ?? []
      ).flatMap((source) => readSourceReferences(join(rootDir, source))),
    ]),
  ].sort();
}

export function assertGeneratedSmokeCaseDependencyMapping(
  caseName: string,
  projectDir: string,
  rootDir = ROOT_DIR,
): void {
  assertGeneratedSmokeDependencyMapping(rootDir);
  const expected = readGeneratedSmokeCaseDirectDependencies(caseName, rootDir);
  const actual = collectGeneratedCrocoDependencyNames(projectDir);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;

  const missing = actual.filter((packageName) => !expected.includes(packageName));
  const extra = expected.filter((packageName) => !actual.includes(packageName));
  throw new Error(
    `Generated smoke dependency mapping drift for ${caseName}: missing=${missing.join(", ") || "none"} extra=${extra.join(", ") || "none"}`,
  );
}

function readSaasProviderProfileReferences(
  rootDir: string,
  profileName: string | undefined,
): readonly string[] {
  if (!profileName) return [];
  const source = readFileSync(
    join(rootDir, "packages", "create-croco-app", "src", "saas-provider-profiles.ts"),
    "utf8",
  );
  const profileStart = source.indexOf(`"${profileName}": {`);
  if (profileStart === -1) return [];
  const nextProfileStart = source.indexOf('\n  "saas-', profileStart + 1);
  const profileEnd =
    nextProfileStart === -1 ? source.indexOf("\n} as const", profileStart) : nextProfileStart;
  const profileSource = source.slice(profileStart, profileEnd);
  const references = new Set<string>();
  const pluginCatalogName = /plugins: ([A-Z][A-Z0-9_]+),/.exec(profileSource)?.[1];
  if (pluginCatalogName) {
    const catalogStart = source.indexOf(`const ${pluginCatalogName} = [`);
    const catalogEnd = source.indexOf(
      "] as const satisfies readonly SaasProviderPluginDefinition[];",
      catalogStart,
    );
    if (catalogStart === -1 || catalogEnd === -1) return [];
    for (const reference of source.slice(catalogStart, catalogEnd).match(CROCO_PACKAGE_REFERENCE) ??
      []) {
      references.add(reference);
    }
  }
  const packagesStart = source.indexOf("packages: [", profileStart);
  const packagesEnd = source.indexOf("],", packagesStart);
  if (
    profileEnd === -1 ||
    packagesStart === -1 ||
    packagesStart >= profileEnd ||
    packagesEnd === -1 ||
    packagesEnd >= profileEnd
  ) {
    return [];
  }
  for (const reference of source.slice(packagesStart, packagesEnd).match(CROCO_PACKAGE_REFERENCE) ??
    []) {
    references.add(reference);
  }
  return [...references];
}

function readTenantModelReferences(
  rootDir: string,
  tenantModel: string | undefined,
): readonly string[] {
  if (!tenantModel) return [];
  const source = readFileSync(
    join(rootDir, "packages", "tenant-core", "src", "libs", "TenantModelManifest.ts"),
    "utf8",
  );
  const modelStart = source.indexOf(`name: "${tenantModel}"`);
  if (modelStart === -1) return [];
  const nextModelStart = source.indexOf("\n    name: ", modelStart + 1);
  const modelEnd =
    nextModelStart === -1 ? source.indexOf("\n} as const", modelStart) : nextModelStart;
  const packagesStart = source.indexOf("requiredPackages: [", modelStart);
  const packagesEnd = source.indexOf("],", packagesStart);
  if (
    modelEnd === -1 ||
    packagesStart === -1 ||
    packagesStart >= modelEnd ||
    packagesEnd === -1 ||
    packagesEnd >= modelEnd
  ) {
    return [];
  }
  return [
    ...new Set(source.slice(packagesStart, packagesEnd).match(CROCO_PACKAGE_REFERENCE) ?? []),
  ];
}

function readSourceReferences(path: string): readonly string[] {
  return [...new Set(readFileSync(path, "utf8").match(CROCO_PACKAGE_REFERENCE) ?? [])];
}

function readDefaultSourceValue(path: string, constantName: string): string | undefined {
  const source = readFileSync(path, "utf8");
  return new RegExp(`export const ${constantName} = "([^"]+)"`).exec(source)?.[1];
}

function readWorkspacePackages(rootDir: string): readonly WorkspacePackage[] {
  const packagesRoot = join(rootDir, "packages");
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packagePath = join(packagesRoot, entry.name, "package.json");
      if (!existsSync(packagePath)) return [];
      const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
      if (typeof manifest.name !== "string") return [];
      const dependencies = WORKSPACE_DEPENDENCY_FIELDS.flatMap((field) => {
        const value = manifest[field];
        return isRecord(value) ? Object.keys(value) : [];
      }).filter((packageName) => packageName.startsWith("@croco/"));
      return [
        {
          dependencies,
          directory: relative(rootDir, dirname(packagePath)).replaceAll("\\", "/"),
          name: manifest.name,
        },
      ];
    });
}

function readTemplatePackageReferences(root: string): readonly string[] {
  const references = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path) continue;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== "package.json.hbs") continue;
      const source = readFileSync(entryPath, "utf8");
      for (const match of source.matchAll(CROCO_PACKAGE_REFERENCE)) {
        const packageName = match[0];
        if (packageName) references.add(packageName);
      }
    }
  }
  return [...references];
}

function expandDependencyClosure(
  directDependencies: ReadonlySet<string>,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
): ReadonlySet<string> {
  const closure = new Set(directDependencies);
  const pending = [...directDependencies];
  while (pending.length > 0) {
    const packageName = pending.pop();
    if (!packageName) continue;
    for (const dependency of packagesByName.get(packageName)?.dependencies ?? []) {
      if (closure.has(dependency)) continue;
      closure.add(dependency);
      pending.push(dependency);
    }
  }
  return closure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
