import {
  GENERATED_NODE_ENGINE_RANGE,
  GENERATED_NODE_VERSION,
  SAAS_GENERATED_NODE_ENGINE_RANGE,
  SAAS_GENERATED_NODE_VERSION,
} from "./node-runtime.js";
import { isSaasPreset } from "./options.js";
import type { GeneratorOptions } from "./types.js";

export type GenerationRuntimePlatform = "node" | "lambda" | "cloudflare-workers";

type ResolvedGenerationConfigurationFor<T extends GeneratorOptions> = T extends GeneratorOptions
  ? {
      readonly [K in keyof T]: T[K] extends readonly unknown[] ? Readonly<T[K]> : T[K];
    } & {
      readonly runtimePlatform: GenerationRuntimePlatform;
    }
  : never;

export type ResolvedGenerationConfiguration = ResolvedGenerationConfigurationFor<GeneratorOptions>;

export type GenerationArtifact = {
  readonly kind:
    | "project-manifest"
    | "node-runtime"
    | "application-intent"
    | "runtime-capability"
    | "provider-profile"
    | "tenant-model"
    | "tenant-model-schema"
    | "runtime-policy"
    | "architecture-policy";
  readonly path: string;
};

export type GenerationNextStep = {
  readonly command: "pnpm";
  readonly args: readonly string[];
  readonly cwd: string;
};

export type GenerationResult = {
  readonly ok: true;
  readonly code: "create-croco-app/project-created";
  readonly targetDir: string;
  readonly projectName: string;
  readonly preset: GeneratorOptions["preset"];
  readonly packageManager: "pnpm";
  readonly nodeRequirement: string;
  readonly nodeRecovery: string;
  readonly configuration: ResolvedGenerationConfiguration;
  readonly artifacts: readonly GenerationArtifact[];
  readonly postActions: {
    readonly git: "initialized" | "skipped";
    readonly dependencies: "installed" | "skipped";
  };
  readonly nextSteps: readonly GenerationNextStep[];
};

export function createGenerationResult(
  targetDir: string,
  options: GeneratorOptions,
  runtimePlatform: GenerationRuntimePlatform,
): GenerationResult {
  const saasPreset = isSaasPreset(options.preset);
  const nodeRequirement = saasPreset
    ? SAAS_GENERATED_NODE_ENGINE_RANGE
    : GENERATED_NODE_ENGINE_RANGE;
  const nodeVersion = saasPreset ? SAAS_GENERATED_NODE_VERSION : GENERATED_NODE_VERSION;

  return {
    ok: true,
    code: "create-croco-app/project-created",
    targetDir,
    projectName: options.projectName,
    preset: options.preset,
    packageManager: "pnpm",
    nodeRequirement,
    nodeRecovery: `Run nvm install ${nodeVersion} && nvm use ${nodeVersion}.`,
    configuration: createResolvedGenerationConfiguration(options, runtimePlatform),
    artifacts: createGenerationArtifacts(options),
    postActions: {
      git: options.initGit ? "initialized" : "skipped",
      dependencies: options.installDeps ? "installed" : "skipped",
    },
    nextSteps: createGenerationNextSteps(targetDir, options, runtimePlatform),
  };
}

function createResolvedGenerationConfiguration<T extends GeneratorOptions>(
  options: T,
  runtimePlatform: GenerationRuntimePlatform,
): ResolvedGenerationConfigurationFor<T> {
  return {
    projectName: options.projectName,
    scope: options.scope,
    ...(options.goal ? { goal: options.goal } : {}),
    preset: options.preset,
    webApps: [...options.webApps],
    ...(options.api ? { api: options.api } : {}),
    apiHosting: options.apiHosting,
    ...(options.backendDeploy ? { backendDeploy: options.backendDeploy } : {}),
    ...(options.frontendDeploy ? { frontendDeploy: options.frontendDeploy } : {}),
    ...(options.ui ? { ui: options.ui } : {}),
    ...(options.preset === "saas" || options.preset === "ai-saas"
      ? {
          saasProviderProfile: options.saasProviderProfile,
          tenantModel: options.tenantModel,
        }
      : {}),
    db: [...options.db],
    agentRules: options.agentRules,
    installDeps: options.installDeps,
    initGit: options.initGit,
    runtimePlatform,
  } as ResolvedGenerationConfigurationFor<T>;
}

function createGenerationArtifacts(options: GeneratorOptions): GenerationArtifact[] {
  const artifacts: GenerationArtifact[] = [
    { kind: "project-manifest", path: "package.json" },
    { kind: "node-runtime", path: ".nvmrc" },
    { kind: "runtime-capability", path: "croco-runtime-capability.manifest.json" },
  ];

  if (options.goal) {
    artifacts.push({ kind: "application-intent", path: "croco.app.json" });
  }

  if (isSaasPreset(options.preset)) {
    artifacts.push(
      { kind: "provider-profile", path: "croco-saas-profile.manifest.json" },
      { kind: "tenant-model", path: "croco-tenant-model.manifest.json" },
      { kind: "tenant-model-schema", path: "croco-tenant-model.schema.json" },
      { kind: "runtime-policy", path: "croco-runtime-policy.manifest.json" },
      { kind: "architecture-policy", path: "croco.arch.json" },
    );
  }

  return artifacts;
}

function createGenerationNextSteps(
  targetDir: string,
  options: GeneratorOptions,
  runtimePlatform: GenerationRuntimePlatform,
): GenerationNextStep[] {
  const commands: GenerationNextStep[] = [];

  if (!options.installDeps) {
    commands.push({ command: "pnpm", args: ["install"], cwd: targetDir });
  }

  const nextScript = isSaasPreset(options.preset)
    ? runtimePlatform === "node"
      ? "dev:api"
      : runtimePlatform === "lambda"
        ? "build:lambda"
        : "build:worker"
    : "dev";

  commands.push({ command: "pnpm", args: [nextScript], cwd: targetDir });

  return commands;
}
