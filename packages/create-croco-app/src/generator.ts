import { execSync, spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import {
  createTenantModelManifest,
  createTenantModelManifestSchema,
  renderTenantModelPlaybook,
} from "@croco/tenant-core/tenant-model";
import {
  createRuntimeCapabilityManifest,
  stringifyRuntimeCapabilityManifest,
} from "@croco/framework-context";
import type { RuntimeCompositionManifest } from "@croco/framework-context";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderEnvironmentTemplate } from "./environment-template.js";
import { recordStagingCleanupFailure } from "./generation-failure-evidence.js";
import { createGenerationResult } from "./generation-result.js";
import type { GeneratorOptions } from "./types.js";
import { writeGoalManifest } from "./goals.js";
import { mergeInto } from "./helpers/fs.js";
import { rewriteExternalCrocoWorkspaceRanges } from "./helpers/manifest-normalizer.js";
import {
  installAgentRules,
  installDocker,
  installFrontendDeploy,
  installGraphqlNextjs,
  installGraphqlStandalone,
  installLambda,
  installMongodb,
  installRedis,
  installSharedUi,
  installTrpcNextjs,
  installTrpcStandalone,
  installUiProfile,
  installWebGraphql,
  installWebTrpc,
} from "./installers/index.js";
import { PnpmCommandProblem } from "./libs/problems/PnpmCommandProblem.js";
import {
  SAAS_GENERATED_NODE_ENGINE_RANGE,
  SAAS_GENERATED_NODE_VERSION,
  assertSupportedNodeVersion,
  writeGeneratedNodeRuntimeContract,
} from "./node-runtime.js";
import { isSaasPreset, validateResolvedOptions } from "./options.js";
import { getGeneratedAppDependencyRange } from "./package-version.js";
import {
  assertSaasProviderTenantModelCompatibility,
  assertSaasProviderProfileCapabilities,
  createSaasProviderProfileManifest,
  getSaasProviderProfileDefinition,
  getSaasProviderPackageDependencyRange,
  renderGeneratedSaasProviderProfileSource,
  renderSaasDeployNotes,
  renderSaasEnvExample,
  renderSaasSecretsChecklist,
} from "./saas-provider-profiles.js";
import { TEMPLATES_DIR } from "./template-path.js";
import {
  createStagingDirectory,
  publishStagedProject,
  removeOwnedStagingDirectory,
} from "./staging.js";
import type { GenerationResult, GenerationRuntimePlatform } from "./generation-result.js";
import type { SaasProviderProfileManifest } from "./saas-provider-profiles.js";

export type {
  GenerationArtifact,
  GenerationNextStep,
  GenerationResult,
  GenerationRuntimePlatform,
  ResolvedGenerationConfiguration,
} from "./generation-result.js";
export type { AppGoal, GeneratorOptions, TenantModelName } from "./types.js";

export type GeneratorExecutionOptions = {
  readonly outputMode: "human" | "json";
};

const DEFAULT_EXECUTION_OPTIONS: GeneratorExecutionOptions = { outputMode: "human" };

export async function generate(
  targetDir: string,
  options: GeneratorOptions,
  executionOptions: GeneratorExecutionOptions = DEFAULT_EXECUTION_OPTIONS,
): Promise<GenerationResult> {
  assertSupportedNodeVersion();
  validateResolvedOptions(options);

  const resolvedTarget = resolve(targetDir);
  const stagingDir = createStagingDirectory(resolvedTarget);

  try {
    await generateProject(stagingDir, options, executionOptions);
    const result = createGenerationResult(
      resolvedTarget,
      options,
      resolveRuntimeCapabilityPlatform(options),
    );
    publishStagedProject(stagingDir, resolvedTarget);
    return result;
  } catch (primaryError) {
    try {
      removeOwnedStagingDirectory(stagingDir);
    } catch (cleanupError) {
      throw recordStagingCleanupFailure(primaryError, cleanupError);
    }

    throw primaryError;
  }
}

async function generateProject(
  targetDir: string,
  options: GeneratorOptions,
  executionOptions: GeneratorExecutionOptions,
): Promise<void> {
  const vars = { projectName: options.projectName, scope: options.scope };
  const isLegacyVikeFullstackPreset = options.preset === "ddd-vike-fullstack";

  // Step 2: root workspace baseline + 프리셋 분기
  mergeInto(join(TEMPLATES_DIR, "blank"), targetDir, vars);

  if (options.preset === "saas" || options.preset === "ai-saas") {
    mergeInto(join(TEMPLATES_DIR, "saas"), targetDir, vars);
    if (options.preset === "ai-saas") {
      mergeInto(join(TEMPLATES_DIR, "ai-saas"), targetDir, vars);
    }
    writeSaasProviderProfileArtifacts(targetDir, options);
    if (options.agentRules) {
      installAgentRules(targetDir, vars);
    }
    await finalize(targetDir, options, executionOptions);
    return;
  }

  if (options.preset === "production-app" || options.preset === "admin-console") {
    mergeInto(join(TEMPLATES_DIR, "spa-be-split"), targetDir, vars);
    if (options.preset === "admin-console") {
      mergeInto(join(TEMPLATES_DIR, "admin-console"), targetDir, vars);
    }
    if (options.agentRules) {
      installAgentRules(targetDir, vars);
    }
    await finalize(targetDir, options, executionOptions);
    return;
  }

  if (options.preset !== "blank") {
    mergeInto(join(TEMPLATES_DIR, "base-ddd"), targetDir, {
      ...vars,
      drizzleOrmRange: getGeneratedAppDependencyRange("drizzle-orm"),
    });
  }

  // 이하 단계들은 blank preset에서는 스킵
  if (options.preset === "blank") {
    await finalize(targetDir, options, executionOptions);
    return;
  }

  // Step 3: API + hosting installer
  if (!isLegacyVikeFullstackPreset) {
    if (options.api === "graphql") {
      if (options.apiHosting === "standalone") {
        installGraphqlStandalone(targetDir, vars);
      } else {
        installGraphqlNextjs(targetDir, vars);
      }
    } else if (options.api === "trpc") {
      if (options.apiHosting === "standalone") {
        installTrpcStandalone(targetDir, vars);
      } else {
        installTrpcNextjs(targetDir, vars);
      }
    }
  }

  // Step 4: shared/ui (standalone fullstack or nextjs hosting에서 웹앱 있을 때)
  const hasWebApps = options.webApps.length > 0;
  if (!isLegacyVikeFullstackPreset && hasWebApps && options.preset === "ddd-fullstack") {
    if (options.ui === undefined) {
      installSharedUi(targetDir, vars);
    }
  }

  // Step 5: web addon (standalone hosting + web apps)
  const frontendDeployOwnsWebApp =
    options.frontendDeploy === "cloudflare-meta-vite" || options.frontendDeploy === "vite-spa";
  if (
    !isLegacyVikeFullstackPreset &&
    options.apiHosting === "standalone" &&
    hasWebApps &&
    !frontendDeployOwnsWebApp
  ) {
    for (const webAppName of options.webApps) {
      if (options.api === "graphql") {
        installWebGraphql(targetDir, webAppName, vars);
      } else if (options.api === "trpc") {
        installWebTrpc(targetDir, webAppName, vars);
      }
    }
  }

  // Step 6: backend deploy
  if (!isLegacyVikeFullstackPreset) {
    if (options.backendDeploy === "docker") {
      installDocker(targetDir, {
        ...vars,
        api: options.api,
        ...(options.frontendDeploy === undefined ? {} : { frontendDeploy: options.frontendDeploy }),
        webApps: options.webApps,
      });
    } else if (options.backendDeploy === "lambda") {
      installLambda(targetDir, { ...vars, api: options.api });
    }
  }

  // Step 7: frontend deploy
  if (options.frontendDeploy === "cloudflare-meta-vite" && isLegacyVikeFullstackPreset) {
    installFrontendDeploy(targetDir, undefined, {
      ...vars,
      preset: options.preset,
      frontendDeploy: options.frontendDeploy,
    });
  } else if (options.frontendDeploy && hasWebApps) {
    for (const webAppName of options.webApps) {
      installFrontendDeploy(targetDir, webAppName, {
        ...vars,
        preset: options.preset,
        frontendDeploy: options.frontendDeploy,
      });
      if (options.frontendDeploy === "vite-spa" && options.ui !== undefined) {
        installUiProfile(targetDir, webAppName, {
          ...vars,
          frontendDeploy: options.frontendDeploy,
          ui: options.ui,
        });
      }
    }
  }

  // Step 8: DB addons
  if (options.db.includes("mongodb")) {
    installMongodb(targetDir, vars);
  }
  if (options.db.includes("redis")) {
    installRedis(targetDir, vars);
  }

  // Step 9: agent-rules
  if (options.agentRules) {
    installAgentRules(targetDir, vars);
  }

  await finalize(targetDir, options, executionOptions);
}

function writeSaasProviderProfileArtifacts(
  targetDir: string,
  options: Extract<GeneratorOptions, { preset: "saas" | "ai-saas" }>,
): void {
  const profile = getSaasProviderProfileDefinition(options.saasProviderProfile);
  const tenantModel = options.tenantModel;
  assertSaasProviderProfileCapabilities(profile);
  assertSaasProviderTenantModelCompatibility(profile, tenantModel);

  const manifest = createSaasProviderProfileManifest(profile, tenantModel);
  const tenantModelManifest = createTenantModelManifest(tenantModel);
  const tenantModelSchema = createTenantModelManifestSchema();
  const tenantModelPlaybook = renderTenantModelPlaybook(tenantModelManifest);
  const providerProfileDocs = renderSaasDeployNotes(manifest);
  const providerEnvExample = renderSaasEnvExample(manifest);
  const providerSecretsChecklist = renderSaasSecretsChecklist(manifest);
  const docsDir = join(targetDir, "docs");
  const apiServerSrcDir = join(targetDir, "apps", "api-server", "src");

  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    join(targetDir, "croco-saas-profile.manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(
    join(targetDir, "croco-tenant-model.manifest.json"),
    `${JSON.stringify(tenantModelManifest, null, 2)}\n`,
  );
  writeFileSync(
    join(targetDir, "croco-tenant-model.schema.json"),
    `${JSON.stringify(tenantModelSchema, null, 2)}\n`,
  );
  writeFileSync(
    join(targetDir, "croco-runtime-policy.manifest.json"),
    `${JSON.stringify(createRuntimePolicyManifest(manifest), null, 2)}\n`,
  );
  writeFileSync(
    join(targetDir, "croco.arch.json"),
    `${JSON.stringify(createArchitecturePolicyManifest(options), null, 2)}\n`,
  );
  writeFileSync(join(targetDir, ".env.example"), providerEnvExample);
  writeFileSync(join(docsDir, "provider-profile.md"), providerProfileDocs);
  writeFileSync(join(docsDir, "tenant-model-playbook.md"), tenantModelPlaybook);
  writeFileSync(join(docsDir, "secrets-checklist.md"), providerSecretsChecklist);
  writeFileSync(
    join(apiServerSrcDir, "generatedSaasProviderProfile.ts"),
    renderGeneratedSaasProviderProfileSource({
      manifest,
      providerProfileDocs,
      providerEnvExample,
      providerSecretsChecklist,
    }),
  );
  writeFileSync(
    join(apiServerSrcDir, "generatedTenantModel.ts"),
    [
      `export const generatedTenantModelManifest = ${JSON.stringify(tenantModelManifest, null, 2)} as const;`,
      `export const generatedTenantModelManifestSchema = ${JSON.stringify(tenantModelSchema, null, 2)} as const;`,
      `export const generatedTenantModelPlaybook = ${JSON.stringify(tenantModelPlaybook)} as const;`,
      "",
    ].join("\n"),
  );
  writeSaasProviderPackageDependencies(targetDir, manifest);
}

function createRuntimePolicyManifest(
  manifest: SaasProviderProfileManifest,
): Record<string, unknown> {
  return {
    schemaVersion: "croco.runtime-policy/v1",
    runtime: {
      platform: manifest.profile.runtimeTarget,
      source: {
        file: "croco-saas-profile.manifest.json",
        symbol: manifest.profile.name,
      },
    },
    table: {
      plans: [],
    },
  };
}

function createArchitecturePolicyManifest(options: GeneratorOptions): Record<string, unknown> {
  return {
    schemaVersion: "croco.architecture-policy/v1",
    policyName: `${options.projectName}-generated-app`,
    packageRoots: ["apps", "libs"],
    include: [
      "apps/*/src/**/*.ts",
      "apps/*/src/**/*.tsx",
      "libs/shared/*/src/**/*.ts",
      "libs/shared/*/src/**/*.tsx",
    ],
    ignore: [
      "apps/*/src/**/__tests__/**",
      "apps/*/src/**/tests/**",
      "apps/*/src/**/*.spec.ts",
      "apps/*/src/**/*.spec.tsx",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      "libs/shared/*/src/**/__tests__/**",
      "libs/shared/*/src/**/tests/**",
      "libs/shared/*/src/**/*.spec.ts",
      "libs/shared/*/src/**/*.spec.tsx",
      "libs/shared/*/src/**/*.test.ts",
      "libs/shared/*/src/**/*.test.tsx",
    ],
    packageGroups: {
      app: {
        description: "Generated application entrypoints.",
        paths: ["apps/*"],
      },
      "provider-contract": {
        description: "Generated RPC provider contract package.",
        packages: [`${options.scope}/provider-rpc`],
      },
      provider: {
        description: "Generated provider adapter packages.",
        paths: ["libs/shared/provider-*"],
      },
      framework: {
        description: "Croco framework and domain contracts.",
        packages: [
          "@croco/*-core",
          "@croco/diagnostics-core",
          "@croco/framework-*",
          "@croco/llm-metering",
          "@croco/problems-core",
          "@croco/telemetry-api",
          "@croco/tx-core",
        ],
      },
      protocols: {
        description: "Croco protocol and generated contract tooling.",
        packages: ["@croco/openapi-spec", "@croco/protocols-*", "@croco/rpc-codegen"],
      },
      transports: {
        description: "Croco runtime transports used by the generated app.",
        packages: ["@croco/transports-*"],
      },
      integrations: {
        description: "Concrete provider/runtime integrations selected by the profile.",
        packages: [
          "@croco/*-drizzle",
          "@croco/*-qstash",
          "@croco/*-upstash",
          "@croco/auth-better-auth",
          "@croco/auth-clerk",
          "@croco/billing-polar",
          "@croco/storage-*",
          "@croco/telemetry-sdk-node",
          "@croco/triggers-qstash",
          "@croco/tx-drizzle",
        ],
      },
      tooling: {
        description: "Build-time generated app tooling.",
        packages: ["@croco/cli"],
      },
    },
    rules: {
      allowedGroupImports: [
        {
          id: "generated-app-layer-edges",
          description:
            "Generated app packages can depend on Croco contracts, selected adapters, and the generated provider-rpc contract, but provider packages must not import app entrypoints.",
          fromGroups: ["app"],
          allowGroups: [
            "framework",
            "protocols",
            "transports",
            "integrations",
            "provider-contract",
            "tooling",
          ],
          allowPackages: [`${options.scope}/provider-rpc`],
          allowExternal: true,
          message:
            "Generated app entrypoints can import Croco contracts, selected adapters, and provider-rpc only.",
          recovery:
            "Move shared provider code into libs/shared and expose app-facing types through the provider-rpc package.",
        },
        {
          id: "generated-provider-layer-edges",
          fromGroups: ["provider", "provider-contract"],
          allowGroups: ["framework", "protocols"],
          allowExternal: true,
          message: "Generated provider packages cannot import app entrypoints.",
          recovery:
            "Keep provider packages reusable by depending only on Croco contracts, protocols, and external SDKs.",
        },
      ],
      publicEntrypoints: {
        id: "generated-app-public-entrypoints",
        description:
          "Generated app packages import declared package entrypoints instead of source internals.",
        includePackages: ["@croco/*", `${options.scope}/*`],
        ignoreImports: [
          {
            paths: [
              "apps/*/src/**/__tests__/**",
              "apps/*/src/**/tests/**",
              "apps/*/src/**/*.spec.ts",
              "apps/*/src/**/*.spec.tsx",
              "apps/*/src/**/*.test.ts",
              "apps/*/src/**/*.test.tsx",
              "libs/shared/*/src/**/__tests__/**",
              "libs/shared/*/src/**/tests/**",
              "libs/shared/*/src/**/*.spec.ts",
              "libs/shared/*/src/**/*.spec.tsx",
              "libs/shared/*/src/**/*.test.ts",
              "libs/shared/*/src/**/*.test.tsx",
            ],
            specifiers: ["@croco/*/src/**", `${options.scope}/*/src/**`],
          },
        ],
        message: "Generated app code must import declared public package entrypoints.",
        recovery:
          "Export the required type or runtime surface from the package entrypoint before consuming it.",
      },
    },
  };
}

function writeSaasProviderPackageDependencies(
  targetDir: string,
  manifest: SaasProviderProfileManifest,
): void {
  const packageJsonPath = join(targetDir, "apps", "api-server", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = packageJson.dependencies ?? {};
  const devDependencies = packageJson.devDependencies ?? {};
  const developmentPackages = new Set(
    manifest.composition.plugins.flatMap(
      (pluginDefinition) => pluginDefinition.developmentPackages ?? [],
    ),
  );

  for (const packageName of [...manifest.packages, ...manifest.tenantModel.requiredPackages]) {
    if (developmentPackages.has(packageName)) {
      delete dependencies[packageName];
      devDependencies[packageName] ??= getSaasProviderPackageDependencyRange(packageName);
    } else {
      dependencies[packageName] ??= getSaasProviderPackageDependencyRange(packageName);
    }
  }
  packageJson.dependencies = dependencies;
  packageJson.devDependencies = devDependencies;
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function finalize(
  targetDir: string,
  options: GeneratorOptions,
  executionOptions: GeneratorExecutionOptions,
): Promise<void> {
  rewriteExternalCrocoWorkspaceRanges(targetDir);
  const saasPreset = isSaasPreset(options.preset);
  writeGeneratedNodeRuntimeContract(
    targetDir,
    saasPreset ? SAAS_GENERATED_NODE_ENGINE_RANGE : undefined,
    saasPreset ? SAAS_GENERATED_NODE_VERSION : undefined,
  );
  writeGoalManifest(targetDir, options);
  writeRuntimeCapabilityManifest(targetDir, options);

  if (!saasPreset) {
    const scaffold =
      options.preset === "blank"
        ? "blank"
        : options.preset === "production-app"
          ? "production-app"
          : options.preset === "admin-console"
            ? "admin-console"
            : "ddd";
    const hasWebApps = options.webApps.length > 0;
    const frontendDeployOwnsWebApp =
      options.frontendDeploy === "cloudflare-meta-vite" || options.frontendDeploy === "vite-spa";
    const nextjsApiClient =
      options.preset === "ddd-fullstack" &&
      hasWebApps &&
      (options.apiHosting === "nextjs" || !frontendDeployOwnsWebApp);

    writeFileSync(
      join(targetDir, ".env.example"),
      renderEnvironmentTemplate({
        scaffold,
        graphqlAuth:
          options.preset !== "ddd-vike-fullstack" &&
          options.api === "graphql" &&
          options.apiHosting === "standalone",
        nextjsApiClient,
        viteApiClient: options.frontendDeploy === "vite-spa" && hasWebApps,
        workerRuntime:
          options.preset === "ddd-vike-fullstack" &&
          options.frontendDeploy === "cloudflare-meta-vite",
      }),
    );
  }

  // Step 10: git init
  if (options.initGit) {
    execSync("git init", { cwd: targetDir, stdio: "ignore" });
  }

  // Step 11: pnpm install
  if (options.installDeps) {
    await installPnpmDependencies(targetDir, executionOptions);
  }
}

function writeRuntimeCapabilityManifest(targetDir: string, options: GeneratorOptions): void {
  const platform = resolveRuntimeCapabilityPlatform(options);
  const manifest = createRuntimeCapabilityManifest(platform, {
    composition: createGeneratedRuntimeComposition(options, platform),
  });

  writeFileSync(
    join(targetDir, "croco-runtime-capability.manifest.json"),
    stringifyRuntimeCapabilityManifest(manifest),
  );
}

function createGeneratedRuntimeComposition(
  options: GeneratorOptions,
  platform: GenerationRuntimePlatform,
): RuntimeCompositionManifest<GenerationRuntimePlatform> {
  const transports =
    options.preset === "blank"
      ? []
      : [
          { protocol: "http", packageName: "@croco/transports-http" },
          ...(options.api === "graphql"
            ? [{ protocol: "graphql", packageName: "@croco/transports-graphql" }]
            : []),
          ...(options.api === "trpc" ? [{ protocol: "rpc" }] : []),
        ];

  if (platform === "lambda") {
    return {
      host: { platform, lifecycle: "invocation" },
      transports,
      buildTarget: {
        name: "lambda-function",
        format: "cjs",
        outputDirectory: "dist",
      },
    };
  }

  if (platform === "cloudflare-workers") {
    return {
      host: { platform, lifecycle: "fetch" },
      transports,
      buildTarget: {
        name: "cloudflare-worker",
        format: "esm",
        outputDirectory: "dist",
        constraints: ["no-node-builtins", "web-standard-apis"],
      },
    };
  }

  if (options.preset === "blank") {
    return {
      host: { platform, lifecycle: "process" },
      transports,
      buildTarget: { name: "workspace" },
    };
  }

  return {
    host: { platform, lifecycle: "process" },
    transports,
    buildTarget: {
      name: "node-application",
      format: isSaasPreset(options.preset) ? "dual" : "cjs",
      outputDirectory: "dist",
    },
  };
}

function resolveRuntimeCapabilityPlatform(options: GeneratorOptions): GenerationRuntimePlatform {
  if (options.saasProviderProfile) {
    return getSaasProviderProfileDefinition(options.saasProviderProfile).runtimeTarget;
  }

  if (options.backendDeploy === "lambda") {
    return "lambda";
  }

  if (options.frontendDeploy === "cloudflare-meta-vite") {
    return "cloudflare-workers";
  }

  return "node";
}

async function installPnpmDependencies(
  targetDir: string,
  executionOptions: GeneratorExecutionOptions,
): Promise<void> {
  await runPnpmCommand(
    "availability-check",
    "pnpm --version",
    targetDir,
    executionOptions,
    "ignore",
  );
  await runPnpmCommand(
    "dependency-install",
    "pnpm install --no-frozen-lockfile",
    targetDir,
    executionOptions,
    "inherit",
  );
  await runPnpmCommand(
    "lockfile-validation",
    "pnpm install --lockfile-only --frozen-lockfile",
    targetDir,
    executionOptions,
    "inherit",
  );
}

function runPnpmCommand(
  stage: ConstructorParameters<typeof PnpmCommandProblem>[0],
  command: string,
  targetDir: string,
  executionOptions: GeneratorExecutionOptions,
  humanStdio: "ignore" | "inherit",
): Promise<void> {
  const jsonMode = executionOptions.outputMode === "json";
  const spawnOptions: SpawnOptions = {
    cwd: targetDir,
    shell: true,
    stdio: jsonMode ? ["ignore", "ignore", "ignore"] : ["ignore", humanStdio, humanStdio],
  };

  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, spawnOptions);
    let settled = false;

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      rejectCommand(new PnpmCommandProblem(stage, command, error));
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;

      if (code === 0) {
        resolveCommand();
        return;
      }

      const exitDetail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      rejectCommand(
        new PnpmCommandProblem(stage, command, new Error(`${command} failed with ${exitDetail}`)),
      );
    });
  });
}
