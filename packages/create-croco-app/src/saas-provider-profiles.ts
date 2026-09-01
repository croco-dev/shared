import {
  DEFAULT_TENANT_MODEL,
  createTenantModelManifest,
  getTenantModelDefinition,
  validateTenantModelCompatibility,
  type TenantModelCapabilityName,
  type TenantModelName,
} from "@croco/tenant-core/tenant-model";
import {
  renderSecretPlaceholderPolicyTable,
  renderSecretsChecklistPlaceholderItems,
} from "./secret-placeholder-policy.js";
import { getEnvironmentVariable, renderSaasEnvironmentTemplate } from "./environment-template.js";
import { getGeneratedAppDependencyRange } from "./package-version.js";
import type { EnvironmentVariableName } from "./environment-template.js";

export const SAAS_PROVIDER_PROFILE_CHOICES = [
  "saas-node-postgres",
  "saas-cloudflare",
  "saas-lambda",
] as const;

export const DEFAULT_SAAS_PROVIDER_PROFILE = "saas-node-postgres" satisfies SaasProviderProfileName;
export const SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_VERSION = "croco.saas-provider-profile/v1";
export const SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_ID =
  "https://croco.dev/schemas/saas-provider-profile.v1.json";
export const SUPPORTED_SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_VERSIONS = [
  SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_VERSION,
] as const;
export const SAAS_PROVIDER_PROFILE_MANIFEST_COMPATIBILITY_RULES = [
  "croco.saas-provider-profile/v1 changes must be additive for existing fields.",
  "Removing or renaming provider profile fields requires a new schemaVersion and migration notes.",
  "Generated provider manifest, tenant manifest, provider docs, .env.example, and generated TS source must be committed together.",
] as const;

export type SaasProviderProfileName = (typeof SAAS_PROVIDER_PROFILE_CHOICES)[number];
export type SaasProviderProfileManifestSchemaVersion =
  (typeof SUPPORTED_SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_VERSIONS)[number];

export type SaasProviderCapabilityName =
  | "runtime"
  | "auth"
  | "persistence"
  | "billing"
  | "metering"
  | "storage"
  | "tasks"
  | "telemetry"
  | "webhookVerification";

export type SaasProviderCapabilityRuntimeState =
  | "configured-production-plugin"
  | "fake-local"
  | "unavailable"
  | "documentation-only";

type CapabilityStatus = "configured" | "documented" | "unavailable";

export type SaasProviderPluginDefinition = {
  readonly factoryExport: string;
  readonly pluginName: string;
  readonly packageName: string;
  readonly contractPackages?: readonly string[];
  readonly runtimePackages?: readonly string[];
  readonly developmentPackages?: readonly string[];
  readonly moduleNames: readonly string[];
  readonly maturity: "alpha" | "beta" | "production" | "deprecated";
  readonly capabilities: readonly string[];
  readonly env: readonly EnvironmentVariableName[];
  readonly verification: readonly string[];
  readonly examples: readonly string[];
};

export type SaasProviderEnvVar = {
  name: EnvironmentVariableName;
  description: string;
  requiredForRealProvider: boolean;
  secret: boolean;
  example?: string;
};

export type SaasProviderCapability = {
  capability: SaasProviderCapabilityName;
  provider: string;
  status: CapabilityStatus;
  productionState: SaasProviderCapabilityRuntimeState;
  zeroCredentialState: SaasProviderCapabilityRuntimeState;
  packageName?: string;
  pluginName?: string;
  env: readonly string[];
  notes: string;
};

export type SaasProviderProfileDefinition = {
  name: SaasProviderProfileName;
  displayName: string;
  runtimeTarget: "node" | "cloudflare-workers" | "lambda";
  description: string;
  packages: readonly string[];
  plugins: readonly SaasProviderPluginDefinition[];
  env: readonly SaasProviderEnvVar[];
  capabilities: Record<SaasProviderCapabilityName, SaasProviderCapability>;
  zeroCredentialSmoke: string;
  realProviderSmoke: string;
  deployNotes: readonly string[];
};

export type SaasProviderProfileManifest = {
  schemaVersion: SaasProviderProfileManifestSchemaVersion;
  schema: {
    id: typeof SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_ID;
    version: typeof SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_VERSION;
    supportedVersions: typeof SUPPORTED_SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_VERSIONS;
  };
  profile: {
    name: SaasProviderProfileName;
    displayName: string;
    runtimeTarget: SaasProviderProfileDefinition["runtimeTarget"];
    description: string;
  };
  packages: readonly string[];
  env: {
    required: readonly SaasProviderEnvVar[];
    optional: readonly SaasProviderEnvVar[];
  };
  capabilities: readonly SaasProviderCapability[];
  composition: {
    executable: boolean;
    plugins: readonly SaasProviderPluginDefinition[];
  };
  smoke: {
    zeroCredential: string;
    realProviderOptIn: string;
  };
  compatibility: {
    requiredCapabilities: readonly SaasProviderCapabilityName[];
    rules: typeof SAAS_PROVIDER_PROFILE_MANIFEST_COMPATIBILITY_RULES;
    generatedArtifacts: {
      manifest: "croco-saas-profile.manifest.json";
      tenantModelManifest: "croco-tenant-model.manifest.json";
      tenantModelSchema: "croco-tenant-model.schema.json";
      providerDocs: "docs/provider-profile.md";
      secretsChecklist: "docs/secrets-checklist.md";
      tenantModelPlaybook: "docs/tenant-model-playbook.md";
      envExample: ".env.example";
      source: "apps/api-server/src/generatedSaasProviderProfile.ts";
    };
    migration: {
      requiredForVersionChange: true;
      guidance: readonly string[];
    };
    qualityGates: readonly string[];
  };
  tenantModel: {
    currentModel: TenantModelName;
    defaultModel: TenantModelName;
    manifest: "croco-tenant-model.manifest.json";
    schema: "croco-tenant-model.schema.json";
    playbook: "docs/tenant-model-playbook.md";
    requiredPackages: readonly string[];
    requiredAdapters: readonly string[];
    requiredCapabilities: readonly TenantModelCapabilityName[];
  };
  deployNotes: readonly string[];
};

export class SaasProviderProfileError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SaasProviderProfileError";
    this.code = code;
  }
}

const SAAS_PROVIDER_THIRD_PARTY_PACKAGE_RANGES: Record<string, string> = {
  "@types/pg": "8.20.0",
  "@clerk/backend": "^1.0.0",
  "@polar-sh/sdk": "^0.32.2",
  "@upstash/qstash": "^2.9.0",
  "@upstash/redis": "^1.34.0",
  cloudinary: "^2.10.0",
  pg: "^8.11.0",
};

export const REQUIRED_SAAS_PROVIDER_CAPABILITIES = [
  "runtime",
  "auth",
  "persistence",
  "billing",
  "metering",
  "storage",
  "tasks",
  "telemetry",
  "webhookVerification",
] as const satisfies readonly SaasProviderCapabilityName[];

const SAAS_NODE_POSTGRES_PLUGINS = [
  plugin({
    factoryExport: "httpTransport",
    pluginName: "transports-http",
    packageName: "@croco/transports-http",
    moduleNames: ["transports-http"],
    maturity: "production",
    capabilities: ["http.transport"],
    env: ["PORT", "WEB_ORIGIN"],
    verification: ["pnpm --filter @croco/transports-http test"],
    examples: ["packages/transports-http/README.md"],
  }),
  plugin({
    factoryExport: "betterAuth",
    pluginName: "better-auth",
    packageName: "@croco/auth-better-auth",
    contractPackages: ["@croco/auth-core"],
    moduleNames: ["@croco/auth-better-auth/provider"],
    maturity: "production",
    capabilities: ["auth.provider"],
    env: ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"],
    verification: ["pnpm --filter @croco/auth-better-auth test"],
    examples: ["packages/auth-better-auth/README.md#application-plugin"],
  }),
  plugin({
    factoryExport: "drizzleTransaction",
    pluginName: "drizzle-transaction",
    packageName: "@croco/tx-drizzle",
    contractPackages: ["@croco/tx-core"],
    runtimePackages: ["drizzle-orm", "pg"],
    developmentPackages: ["@types/pg"],
    moduleNames: ["@croco/tx-drizzle/transaction"],
    maturity: "production",
    capabilities: ["transaction.manager"],
    env: ["DATABASE_URL"],
    verification: ["pnpm --filter @croco/tx-drizzle test"],
    examples: ["packages/tx-drizzle/README.md#application-plugin"],
  }),
  plugin({
    factoryExport: "polarBilling",
    pluginName: "polar-billing",
    packageName: "@croco/billing-polar",
    contractPackages: ["@croco/billing-core"],
    moduleNames: ["@croco/billing-polar/gateway"],
    maturity: "beta",
    capabilities: ["billing.gateway"],
    env: ["POLAR_ACCESS_TOKEN", "POLAR_WEBHOOK_SECRET", "POLAR_PRODUCT_ID_TEAM"],
    verification: ["pnpm --filter @croco/billing-polar test"],
    examples: ["packages/billing-polar/README.md#canonical-module-plugin"],
  }),
  plugin({
    factoryExport: "qstashTasks",
    pluginName: "qstash-tasks",
    packageName: "@croco/tasks-qstash",
    contractPackages: ["@croco/tasks-core"],
    moduleNames: ["@croco/tasks-qstash/dispatcher"],
    maturity: "alpha",
    capabilities: ["tasks.dispatcher"],
    env: ["UPSTASH_QSTASH_TOKEN", "UPSTASH_QSTASH_DESTINATION_URL"],
    verification: ["pnpm --filter @croco/tasks-qstash test"],
    examples: ["packages/tasks-qstash/README.md#canonical-module-plugin"],
  }),
  plugin({
    factoryExport: "cloudinaryStorage",
    pluginName: "cloudinary-storage",
    packageName: "@croco/storage-cloudinary",
    contractPackages: ["@croco/storage-core"],
    moduleNames: ["@croco/storage-cloudinary/provider"],
    maturity: "production",
    capabilities: ["storage.provider"],
    env: ["CLOUDINARY_URL"],
    verification: ["pnpm --filter @croco/storage-cloudinary test"],
    examples: ["packages/storage-cloudinary/README.md#application-plugin"],
  }),
  plugin({
    factoryExport: "nodeTelemetry",
    pluginName: "node-telemetry",
    packageName: "@croco/telemetry-sdk-node",
    moduleNames: ["@croco/telemetry-sdk-node"],
    maturity: "production",
    capabilities: ["telemetry.runtime"],
    env: ["TELEMETRY_ENABLED", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"],
    verification: ["pnpm --filter @croco/telemetry-sdk-node test"],
    examples: ["packages/telemetry-sdk-node/README.md#canonical-module-plugin"],
  }),
] as const satisfies readonly SaasProviderPluginDefinition[];

const GENERATED_SAAS_TENANT_MODEL_PACKAGES = [
  "@croco/tenant-core",
  "@croco/membership-core",
  "@croco/invitation-core",
  "@croco/tx-core",
] as const;

const commonEnv = [
  envVar("SAAS_PROVIDER_PROFILE", true),
  envVar("SAAS_DEMO_ENDPOINTS_ENABLED", false, "false"),
  envVar("NODE_ENV", false),
  envVar("PORT", false),
  envVar("WEB_ORIGIN", false),
  envVar("TELEMETRY_ENABLED", false, "true"),
  envVar("OTEL_EXPORTER_OTLP_ENDPOINT", false),
  envVar("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", false),
] as const;

export const SAAS_PROVIDER_PROFILES = {
  "saas-node-postgres": {
    name: "saas-node-postgres",
    displayName: "Node/Postgres SaaS",
    runtimeTarget: "node",
    description:
      "Node API profile with Postgres-backed domain state, Polar billing, Upstash queues, Cloudinary storage, and OTLP telemetry.",
    packages: [
      "@croco/preset-node",
      ...new Set(
        SAAS_NODE_POSTGRES_PLUGINS.flatMap((pluginDefinition) => [
          pluginDefinition.packageName,
          ...(pluginDefinition.contractPackages ?? []),
          ...(pluginDefinition.runtimePackages ?? []),
          ...(pluginDefinition.developmentPackages ?? []),
        ]),
      ),
    ],
    plugins: SAAS_NODE_POSTGRES_PLUGINS,
    env: deriveExecutableProfileEnv(SAAS_NODE_POSTGRES_PLUGINS, [
      envVar("UPSTASH_QSTASH_CURRENT_SIGNING_KEY", true),
      envVar("UPSTASH_QSTASH_NEXT_SIGNING_KEY", true),
    ]),
    capabilities: capabilities({
      runtime: capability("runtime", "Node HTTP", "configured", "@croco/transports-http", ["PORT"]),
      auth: executableCapability("auth", "Better Auth + Drizzle", "better-auth", "fake-local"),
      persistence: executableCapability(
        "persistence",
        "Drizzle transaction boundary",
        "drizzle-transaction",
        "fake-local",
      ),
      billing: executableCapability("billing", "Polar", "polar-billing", "fake-local"),
      metering: capability(
        "metering",
        "Application-defined metering adapter",
        "unavailable",
        undefined,
        [],
      ),
      storage: executableCapability("storage", "Cloudinary", "cloudinary-storage", "fake-local"),
      tasks: executableCapability("tasks", "QStash", "qstash-tasks", "fake-local"),
      telemetry: executableCapability(
        "telemetry",
        "OpenTelemetry SDK Node",
        "node-telemetry",
        "unavailable",
      ),
      webhookVerification: capability(
        "webhookVerification",
        "Polar + QStash signatures",
        "documented",
        undefined,
        [
          "POLAR_WEBHOOK_SECRET",
          "UPSTASH_QSTASH_CURRENT_SIGNING_KEY",
          "UPSTASH_QSTASH_NEXT_SIGNING_KEY",
        ],
      ),
    }),
    zeroCredentialSmoke: "pnpm demo:smoke",
    realProviderSmoke: "SAAS_PROVIDER_PROFILE=saas-node-postgres pnpm profile:smoke:real",
    deployNotes: [
      "Start the Node API after TelemetryRuntime.init() resolves and call forceFlush() before process shutdown.",
      "Verify Polar webhooks with POLAR_WEBHOOK_SECRET before mutating billing or entitlement state.",
      "Verify QStash signatures before queue/task handlers accept delivery.",
      "Run pnpm profile:check in CI to detect manifest drift before deployment.",
    ],
  },
  "saas-cloudflare": {
    name: "saas-cloudflare",
    displayName: "Cloudflare SaaS",
    runtimeTarget: "cloudflare-workers",
    description:
      "Cloudflare Workers profile with Clerk auth, Polar billing, Upstash metering/tasks, R2 storage, and explicit Worker runtime limits.",
    packages: [
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
    plugins: [],
    env: [
      ...commonEnv,
      envVar("CLOUDFLARE_ACCOUNT_ID", true),
      envVar("CLOUDFLARE_API_TOKEN", true),
      envVar("R2_BUCKET", true),
      envVar("CLERK_SECRET_KEY", true),
      envVar("POLAR_ACCESS_TOKEN", true),
      envVar("POLAR_WEBHOOK_SECRET", true),
      envVar("POLAR_PRODUCT_ID_TEAM", true),
      envVar("UPSTASH_REDIS_REST_URL", true),
      envVar("UPSTASH_REDIS_REST_TOKEN", true),
      envVar("UPSTASH_QSTASH_TOKEN", true),
      envVar("UPSTASH_QSTASH_CURRENT_SIGNING_KEY", true),
      envVar("UPSTASH_QSTASH_NEXT_SIGNING_KEY", true),
    ],
    capabilities: capabilities({
      runtime: capability(
        "runtime",
        "Cloudflare Workers",
        "documented",
        "@croco/transports-cloudflare-workers",
        ["CLOUDFLARE_ACCOUNT_ID"],
      ),
      auth: capability("auth", "Clerk", "documented", "@croco/auth-clerk", ["CLERK_SECRET_KEY"]),
      persistence: capability(
        "persistence",
        "Application-defined Worker persistence",
        "documented",
        undefined,
        [],
      ),
      billing: capability("billing", "Polar", "documented", "@croco/billing-polar", [
        "POLAR_ACCESS_TOKEN",
        "POLAR_WEBHOOK_SECRET",
        "POLAR_PRODUCT_ID_TEAM",
      ]),
      metering: capability("metering", "Upstash Redis", "documented", "@croco/metering-upstash", [
        "UPSTASH_REDIS_REST_URL",
        "UPSTASH_REDIS_REST_TOKEN",
      ]),
      storage: capability("storage", "Cloudflare R2", "documented", "@croco/storage-r2", [
        "R2_BUCKET",
      ]),
      tasks: capability("tasks", "QStash", "documented", "@croco/tasks-qstash", [
        "UPSTASH_QSTASH_TOKEN",
        "UPSTASH_QSTASH_CURRENT_SIGNING_KEY",
        "UPSTASH_QSTASH_NEXT_SIGNING_KEY",
      ]),
      telemetry: capability(
        "telemetry",
        "OpenTelemetry fetch export",
        "documented",
        "@croco/telemetry-api",
        ["TELEMETRY_ENABLED", "OTEL_EXPORTER_OTLP_ENDPOINT"],
      ),
      webhookVerification: capability(
        "webhookVerification",
        "Polar + QStash signatures",
        "documented",
        undefined,
        [
          "POLAR_WEBHOOK_SECRET",
          "UPSTASH_QSTASH_CURRENT_SIGNING_KEY",
          "UPSTASH_QSTASH_NEXT_SIGNING_KEY",
        ],
      ),
    }),
    zeroCredentialSmoke: "pnpm demo:smoke",
    realProviderSmoke: "SAAS_PROVIDER_PROFILE=saas-cloudflare pnpm profile:smoke:real",
    deployNotes: [
      "Keep generated smoke local; use pnpm profile:smoke:real only after Worker secrets are bound.",
      "Verify Polar and QStash signatures before Worker handlers mutate billing, metering, or task state.",
      "Flush telemetry through the Worker request lifecycle instead of AWS exec-wrapper style boot hooks.",
      "Run pnpm profile:check in CI and fail deployment when runtimeTarget or required capabilities drift.",
    ],
  },
  "saas-lambda": {
    name: "saas-lambda",
    displayName: "Lambda SaaS",
    runtimeTarget: "lambda",
    description:
      "AWS Lambda profile with Clerk auth, Polar billing, Upstash metering/tasks, Cloudinary storage, and explicit init/flush telemetry.",
    packages: [
      "@croco/preset-lambda",
      "@croco/auth-clerk",
      "@croco/billing-polar",
      "@croco/metering-upstash",
      "@croco/storage-cloudinary",
      "@croco/tasks-qstash",
      "@croco/triggers-qstash",
      "@croco/telemetry-sdk-node",
      "@clerk/backend",
      "@polar-sh/sdk",
      "@upstash/qstash",
      "@upstash/redis",
      "cloudinary",
    ],
    plugins: [],
    env: [
      ...commonEnv,
      envVar("AWS_REGION", true),
      envVar("CLERK_SECRET_KEY", true),
      envVar("POLAR_ACCESS_TOKEN", true),
      envVar("POLAR_WEBHOOK_SECRET", true),
      envVar("POLAR_PRODUCT_ID_TEAM", true),
      envVar("UPSTASH_REDIS_REST_URL", true),
      envVar("UPSTASH_REDIS_REST_TOKEN", true),
      envVar("UPSTASH_QSTASH_TOKEN", true),
      envVar("UPSTASH_QSTASH_CURRENT_SIGNING_KEY", true),
      envVar("UPSTASH_QSTASH_NEXT_SIGNING_KEY", true),
      envVar("CLOUDINARY_URL", true),
    ],
    capabilities: capabilities({
      runtime: capability("runtime", "AWS Lambda", "documented", "@croco/preset-lambda", [
        "AWS_REGION",
      ]),
      auth: capability("auth", "Clerk", "documented", "@croco/auth-clerk", ["CLERK_SECRET_KEY"]),
      persistence: capability(
        "persistence",
        "Application-defined Lambda persistence",
        "documented",
        undefined,
        [],
      ),
      billing: capability("billing", "Polar", "documented", "@croco/billing-polar", [
        "POLAR_ACCESS_TOKEN",
        "POLAR_WEBHOOK_SECRET",
        "POLAR_PRODUCT_ID_TEAM",
      ]),
      metering: capability("metering", "Upstash Redis", "documented", "@croco/metering-upstash", [
        "UPSTASH_REDIS_REST_URL",
        "UPSTASH_REDIS_REST_TOKEN",
      ]),
      storage: capability("storage", "Cloudinary", "documented", "@croco/storage-cloudinary", [
        "CLOUDINARY_URL",
      ]),
      tasks: capability("tasks", "QStash", "documented", "@croco/tasks-qstash", [
        "UPSTASH_QSTASH_TOKEN",
        "UPSTASH_QSTASH_CURRENT_SIGNING_KEY",
        "UPSTASH_QSTASH_NEXT_SIGNING_KEY",
      ]),
      telemetry: capability(
        "telemetry",
        "OpenTelemetry SDK Node",
        "documented",
        "@croco/telemetry-sdk-node",
        ["TELEMETRY_ENABLED", "OTEL_EXPORTER_OTLP_ENDPOINT"],
      ),
      webhookVerification: capability(
        "webhookVerification",
        "Polar + QStash signatures",
        "documented",
        undefined,
        [
          "POLAR_WEBHOOK_SECRET",
          "UPSTASH_QSTASH_CURRENT_SIGNING_KEY",
          "UPSTASH_QSTASH_NEXT_SIGNING_KEY",
        ],
      ),
    }),
    zeroCredentialSmoke: "pnpm demo:smoke",
    realProviderSmoke: "SAAS_PROVIDER_PROFILE=saas-lambda pnpm profile:smoke:real",
    deployNotes: [
      "Initialize TelemetryRuntime at module scope and call forceFlush() in the Lambda handler finally block.",
      "Do not rely on AWS_LAMBDA_EXEC_WRAPPER; generated Croco Lambda apps own telemetry init timing.",
      "Verify Polar and QStash webhook signatures before enqueueing or mutating state.",
      "Run pnpm profile:check before packaging and pnpm profile:smoke:real only with real-provider env loaded.",
    ],
  },
} as const satisfies Record<SaasProviderProfileName, SaasProviderProfileDefinition>;

export function getSaasProviderProfileDefinition(
  name: SaasProviderProfileName = DEFAULT_SAAS_PROVIDER_PROFILE,
): SaasProviderProfileDefinition {
  return SAAS_PROVIDER_PROFILES[name];
}

export function createSaasProviderProfileManifest(
  profile: SaasProviderProfileDefinition,
  tenantModel: TenantModelName = DEFAULT_TENANT_MODEL,
): SaasProviderProfileManifest {
  const tenantModelManifest = createTenantModelManifest(tenantModel);

  return {
    schemaVersion: SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_VERSION,
    schema: {
      id: SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_ID,
      version: SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_VERSION,
      supportedVersions: SUPPORTED_SAAS_PROVIDER_PROFILE_MANIFEST_SCHEMA_VERSIONS,
    },
    profile: {
      name: profile.name,
      displayName: profile.displayName,
      runtimeTarget: profile.runtimeTarget,
      description: profile.description,
    },
    packages: profile.packages,
    env: {
      required: profile.env.filter((entry) => entry.requiredForRealProvider),
      optional: profile.env.filter((entry) => !entry.requiredForRealProvider),
    },
    capabilities: REQUIRED_SAAS_PROVIDER_CAPABILITIES.map(
      (capabilityName) => profile.capabilities[capabilityName],
    ),
    composition: {
      executable: profile.plugins.length > 0,
      plugins: profile.plugins,
    },
    smoke: {
      zeroCredential: profile.zeroCredentialSmoke,
      realProviderOptIn: profile.realProviderSmoke,
    },
    compatibility: {
      requiredCapabilities: REQUIRED_SAAS_PROVIDER_CAPABILITIES,
      rules: SAAS_PROVIDER_PROFILE_MANIFEST_COMPATIBILITY_RULES,
      generatedArtifacts: {
        manifest: "croco-saas-profile.manifest.json",
        tenantModelManifest: "croco-tenant-model.manifest.json",
        tenantModelSchema: "croco-tenant-model.schema.json",
        providerDocs: "docs/provider-profile.md",
        secretsChecklist: "docs/secrets-checklist.md",
        tenantModelPlaybook: "docs/tenant-model-playbook.md",
        envExample: ".env.example",
        source: "apps/api-server/src/generatedSaasProviderProfile.ts",
      },
      migration: {
        requiredForVersionChange: true,
        guidance: [
          "Keep v1 changes additive unless generated app consumers cannot safely read the new shape.",
          "Bump schemaVersion only with release notes, migration guidance, and croco doctor support for the new version.",
          "Run profile:check, croco doctor, and generated app smoke checks before accepting a manifest version change.",
        ],
      },
      qualityGates: ["profile:check", "croco doctor --json", "demo:smoke"],
    },
    tenantModel: {
      currentModel: tenantModelManifest.currentModel,
      defaultModel: tenantModelManifest.defaultModel,
      manifest: "croco-tenant-model.manifest.json",
      schema: "croco-tenant-model.schema.json",
      playbook: "docs/tenant-model-playbook.md",
      requiredPackages: tenantModelManifest.selected.requiredPackages,
      requiredAdapters: tenantModelManifest.selected.requiredAdapters,
      requiredCapabilities: tenantModelManifest.selected.requiredCapabilities,
    },
    deployNotes: profile.deployNotes,
  };
}

export function assertSaasProviderProfileCapabilities(profile: {
  name: string;
  capabilities: Partial<Record<SaasProviderCapabilityName, SaasProviderCapability>>;
}): void {
  const missingCapabilities = REQUIRED_SAAS_PROVIDER_CAPABILITIES.filter(
    (capabilityName) => profile.capabilities[capabilityName] === undefined,
  );

  if (missingCapabilities.length > 0) {
    throw new SaasProviderProfileError(
      "CROCO_SAAS_PROFILE_CAPABILITY_MISSING",
      `${profile.name} lacks ${missingCapabilities.join(", ")}`,
    );
  }
}

export function getSaasProviderPackageDependencyRange(packageName: string): string {
  if (packageName.startsWith("@croco/")) {
    return "workspace:*";
  }

  if (packageName === "drizzle-orm") {
    return getGeneratedAppDependencyRange(packageName);
  }

  const range = SAAS_PROVIDER_THIRD_PARTY_PACKAGE_RANGES[packageName];
  if (range === undefined) {
    throw new SaasProviderProfileError("CROCO_SAAS_PROFILE_PACKAGE_RANGE_MISSING", packageName);
  }

  return range;
}

export function assertSaasProviderTenantModelCompatibility(
  profile: SaasProviderProfileDefinition,
  tenantModel: TenantModelName = DEFAULT_TENANT_MODEL,
): void {
  const result = validateTenantModelCompatibility({
    tenantModel,
    providerProfileName: profile.name,
    runtimeTarget: profile.runtimeTarget,
    packages: [...profile.packages, ...GENERATED_SAAS_TENANT_MODEL_PACKAGES],
  });

  if (result.ok) return;

  throw new SaasProviderProfileError(
    "CROCO_TENANT_MODEL_COMPATIBILITY_FAILED",
    [
      `${profile.name} cannot use tenant model '${tenantModel}'`,
      ...result.diagnostics.map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message}`),
    ].join("\n"),
  );
}

export function renderSaasEnvExample(manifest: SaasProviderProfileManifest): string {
  return renderSaasEnvironmentTemplate(manifest);
}

export type RenderGeneratedSaasProviderProfileSourceOptions = {
  readonly manifest: SaasProviderProfileManifest;
  readonly providerProfileDocs: string;
  readonly providerEnvExample: string;
  readonly providerSecretsChecklist: string;
};

export function renderGeneratedSaasProviderProfileSource(
  options: RenderGeneratedSaasProviderProfileSourceOptions,
): string {
  const constants = [
    `export const generatedSaasProviderProfileManifest = ${JSON.stringify(options.manifest, null, 2)} as const;`,
    `export const generatedSaasProviderProfileDocs = ${JSON.stringify(options.providerProfileDocs)} as const;`,
    `export const generatedSaasProviderProfileEnvExample = ${JSON.stringify(options.providerEnvExample)} as const;`,
    `export const generatedSaasProviderSecretsChecklist = ${JSON.stringify(options.providerSecretsChecklist)} as const;`,
  ];

  if (!options.manifest.composition.executable) {
    return [
      'import type { ApplicationRuntime, CrocoApplicationDefinition } from "@croco/framework-module";',
      'import type { AppConfig } from "@croco/transports-http";',
      "",
      ...constants,
      "",
      "class GeneratedSaasProviderProfileError extends Error {",
      "  readonly code: string;",
      '  constructor(code: string, detail: string) { super(`${code}: ${detail}`); this.name = "GeneratedSaasProviderProfileError"; this.code = code; }',
      "}",
      "",
      'export type GeneratedSaasProfileMode = "production" | "zero-credential";',
      "",
      "export function createGeneratedSaasApplicationDefinition(_options?: unknown): CrocoApplicationDefinition {",
      '  throw new GeneratedSaasProviderProfileError("CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE", generatedSaasProviderProfileManifest.profile.name);',
      "}",
      "",
      "export function createGeneratedSaasHttpAppConfig(_runtime: ApplicationRuntime, _mode: GeneratedSaasProfileMode): AppConfig {",
      '  throw new GeneratedSaasProviderProfileError("CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE", generatedSaasProviderProfileManifest.profile.name);',
      "}",
      "",
      "export function assertGeneratedSaasProfileGraph(_graph?: unknown, _mode?: GeneratedSaasProfileMode): never {",
      '  throw new GeneratedSaasProviderProfileError("CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE", generatedSaasProviderProfileManifest.profile.name);',
      "}",
      "",
    ].join("\n");
  }

  if (options.manifest.profile.name !== "saas-node-postgres") {
    throw new SaasProviderProfileError(
      "CROCO_SAAS_PROFILE_RENDERER_MISSING",
      `${options.manifest.profile.name} is executable but has no source renderer`,
    );
  }

  return [
    'import { AUTH_PROVIDER_TOKEN, type AuthProvider } from "@croco/auth-core";',
    'import { BETTER_AUTH_MODULE_NAME, betterAuth } from "@croco/auth-better-auth";',
    'import { BILLING_GATEWAY_TOKEN, type BillingGateway } from "@croco/billing-core";',
    'import { POLAR_BILLING_MODULE_NAME, polarBilling } from "@croco/billing-polar";',
    'import type { DiagnosticsProvider } from "@croco/diagnostics-core";',
    'import type { ILogger } from "@croco/framework-context";',
    'import { defineCrocoApplication, MODULE_CONTRIBUTION_KINDS, type ApplicationProviderReplacement, type ApplicationRuntimeGraphManifest, type CrocoApplicationDefinition, type CrocoPlugin } from "@croco/framework-module";',
    'import { CLOUDINARY_STORAGE_MODULE_NAME, cloudinaryStorage } from "@croco/storage-cloudinary";',
    'import { STORAGE_PROVIDER_TOKEN, type StorageProvider } from "@croco/storage-core";',
    'import { TASK_DISPATCHER_TOKEN, type TaskDispatcher } from "@croco/tasks-core";',
    'import { QSTASH_TASKS_MODULE_NAME, qstashTasks } from "@croco/tasks-qstash";',
    'import { nodeTelemetry } from "@croco/telemetry-sdk-node";',
    'import { createHttpAppConfig, httpTransport, type AppConfig, type HttpTransportPluginOptions } from "@croco/transports-http";',
    'import { DRIZZLE_TRANSACTION_MODULE_NAME, drizzleTransaction } from "@croco/tx-drizzle";',
    'import { TxManager } from "@croco/tx-core";',
    'import type { ApplicationRuntime } from "@croco/framework-module";',
    'import { drizzle } from "drizzle-orm/node-postgres";',
    'import { Pool } from "pg";',
    "",
    ...constants,
    "",
    "class GeneratedSaasProviderProfileError extends Error {",
    "  readonly code: string;",
    '  constructor(code: string, detail: string) { super(`${code}: ${detail}`); this.name = "GeneratedSaasProviderProfileError"; this.code = code; }',
    "}",
    "",
    'export type GeneratedSaasProfileMode = "production" | "zero-credential";',
    "",
    "export type GeneratedSaasLocalProviders = {",
    "  readonly auth: AuthProvider;",
    "  readonly billing: BillingGateway;",
    "  readonly storage: StorageProvider;",
    "  readonly tasks: TaskDispatcher;",
    "  readonly transaction: TxManager<unknown>;",
    "};",
    "",
    "export type GeneratedSaasApplicationOptions = {",
    "  readonly mode: GeneratedSaasProfileMode;",
    "  readonly logger: ILogger;",
    "  readonly http: HttpTransportPluginOptions;",
    "  readonly localProviders?: GeneratedSaasLocalProviders;",
    "  readonly env?: Readonly<Record<string, string | undefined>>;",
    "};",
    "",
    "export function createGeneratedSaasApplicationDefinition(",
    "  options: GeneratedSaasApplicationOptions,",
    "): CrocoApplicationDefinition {",
    "  const env = options.env ?? process.env;",
    "  const config = readProfileConfiguration(options.mode, env);",
    "  const databasePool = config.databaseUrl === undefined ? undefined : new Pool({ connectionString: config.databaseUrl });",
    "  const database = databasePool === undefined ? drizzle.mock() : drizzle(databasePool);",
    "  const imports = generatedSaasProviderProfileManifest.composition.plugins.map(",
    "    (pluginDefinition): CrocoPlugin => {",
    "      switch (pluginDefinition.factoryExport) {",
    '        case "httpTransport":',
    "          return httpTransport(options.http);",
    '        case "betterAuth":',
    "          return betterAuth({ db: database, baseURL: config.betterAuthUrl, secret: config.betterAuthSecret });",
    '        case "drizzleTransaction":',
    "          return drizzleTransaction({ db: database, ...(databasePool === undefined ? {} : { shutdown: () => databasePool.end() }) });",
    '        case "polarBilling":',
    "          return polarBilling({ accessToken: config.polarAccessToken, environment: config.polarEnvironment, webhookSecret: config.polarWebhookSecret, logger: options.logger });",
    '        case "qstashTasks":',
    "          return qstashTasks({ token: config.qstashToken, destinationUrl: config.qstashDestinationUrl });",
    '        case "cloudinaryStorage":',
    "          return cloudinaryStorage(parseCloudinaryUrl(config.cloudinaryUrl));",
    '        case "nodeTelemetry":',
    '          return nodeTelemetry({ serviceName: "saas-api-server", environment: env.NODE_ENV ?? "development", enabled: options.mode === "production" && env.TELEMETRY_ENABLED !== "false", trace: { enabled: options.mode === "production" && env.TELEMETRY_ENABLED !== "false" && (env.TELEMETRY_ENABLED === "true" || config.otlpEndpoint !== undefined), exporterUrl: config.otlpEndpoint } });',
    "        default:",
    "          return unsupportedPluginFactory(pluginDefinition);",
    "      }",
    "    },",
    "  );",
    "",
    "  return defineCrocoApplication({",
    "    name: generatedSaasProviderProfileManifest.profile.name,",
    "    imports,",
    "    providerReplacements:",
    '      options.mode === "zero-credential"',
    "        ? createZeroCredentialReplacements(requireLocalProviders(options.localProviders))",
    "        : [],",
    "  });",
    "}",
    "",
    "function unsupportedPluginFactory(pluginDefinition: never): never {",
    '  throw new GeneratedSaasProviderProfileError("CROCO_SAAS_PROFILE_PLUGIN_FACTORY_UNSUPPORTED", String(pluginDefinition));',
    "}",
    "",
    "export function createGeneratedSaasHttpAppConfig(runtime: ApplicationRuntime, mode: GeneratedSaasProfileMode): AppConfig {",
    "  const config = createHttpAppConfig(runtime);",
    '  if (mode === "production" || config.diagnostics === undefined) return config;',
    "  const replacementOwners = new Set(runtime.createGraphManifest().providerReplacements.flatMap((replacement) => replacement.replaces));",
    '  const unavailableOwners = new Set<string>(generatedSaasProviderProfileManifest.capabilities.flatMap((capability) => { if (capability.zeroCredentialState !== "unavailable" || !("pluginName" in capability)) return []; return generatedSaasProviderProfileManifest.composition.plugins.filter((plugin) => plugin.pluginName === capability.pluginName).flatMap((plugin) => plugin.moduleNames); }));',
    "  const replacedDiagnostics = new Set(runtime.getContributions<DiagnosticsProvider>(MODULE_CONTRIBUTION_KINDS.diagnosticsProvider).filter((contribution) => replacementOwners.has(contribution.moduleName) || unavailableOwners.has(contribution.moduleName)).map((contribution) => contribution.value));",
    "  return { ...config, diagnostics: { ...config.diagnostics, providers: (config.diagnostics.providers ?? []).filter((provider) => !replacedDiagnostics.has(provider)) } };",
    "}",
    "",
    "export function assertGeneratedSaasProfileGraph(",
    "  graph: ApplicationRuntimeGraphManifest,",
    "  mode: GeneratedSaasProfileMode,",
    "): void {",
    "  const expectedPlugins = generatedSaasProviderProfileManifest.composition.plugins",
    "    .map(({ pluginName, packageName, maturity, capabilities, moduleNames }) => ({ pluginName, packageName, maturity, capabilities: [...capabilities].sort(), moduleNames: [...moduleNames].sort() }))",
    "    .sort((left, right) => left.pluginName.localeCompare(right.pluginName));",
    "  const expectedCapabilities = new Map<string, readonly string[]>(expectedPlugins.map((plugin) => [plugin.pluginName, plugin.capabilities]));",
    "  const actualPlugins = graph.plugins",
    '    .map((plugin) => ({ pluginName: plugin.name, packageName: plugin.packageName, maturity: plugin.maturity, capabilities: plugin.capabilities.map((capability) => capability.id).filter((id) => expectedCapabilities.get(plugin.name)?.includes(id) === true).sort(), moduleNames: graph.moduleGraph.modules.filter((module) => module.name === plugin.packageName || module.name.startsWith(`${plugin.packageName}/`) || (plugin.packageName === "@croco/transports-http" && module.name === "transports-http")).map((module) => module.name).sort() }))',
    "    .sort((left, right) => left.pluginName.localeCompare(right.pluginName));",
    '  const expectedReplacementOwners = mode === "zero-credential"',
    "    ? expectedPlugins.flatMap((plugin) => replacementOwnerForPlugin(plugin.pluginName)).sort()",
    "    : [];",
    "  const actualReplacementOwners = graph.providerReplacements.flatMap((replacement) => replacement.replaces).sort();",
    "",
    "  if (JSON.stringify(actualPlugins) !== JSON.stringify(expectedPlugins) || JSON.stringify(actualReplacementOwners) !== JSON.stringify(expectedReplacementOwners)) {",
    '    throw new GeneratedSaasProviderProfileError("CROCO_SAAS_PROFILE_GRAPH_DRIFT", generatedSaasProviderProfileManifest.profile.name);',
    "  }",
    "}",
    "",
    "function createZeroCredentialReplacements(local: GeneratedSaasLocalProviders): readonly ApplicationProviderReplacement[] {",
    "  const hasFactory = (factoryExport: string): boolean => generatedSaasProviderProfileManifest.composition.plugins.some((plugin) => plugin.factoryExport === factoryExport);",
    "  return [",
    '    ...(hasFactory("betterAuth") ? [{ provider: { provide: AUTH_PROVIDER_TOKEN, useValue: local.auth }, replaces: [BETTER_AUTH_MODULE_NAME] }] : []),',
    '    ...(hasFactory("drizzleTransaction") ? [{ provider: { provide: TxManager, useValue: local.transaction }, replaces: [DRIZZLE_TRANSACTION_MODULE_NAME] }] : []),',
    '    ...(hasFactory("polarBilling") ? [{ provider: { provide: BILLING_GATEWAY_TOKEN, useValue: local.billing }, replaces: [POLAR_BILLING_MODULE_NAME] }] : []),',
    '    ...(hasFactory("qstashTasks") ? [{ provider: { provide: TASK_DISPATCHER_TOKEN, useValue: local.tasks }, replaces: [QSTASH_TASKS_MODULE_NAME] }] : []),',
    '    ...(hasFactory("cloudinaryStorage") ? [{ provider: { provide: STORAGE_PROVIDER_TOKEN, useValue: local.storage }, replaces: [CLOUDINARY_STORAGE_MODULE_NAME] }] : []),',
    "  ];",
    "}",
    "",
    "function replacementOwnerForPlugin(pluginName: string): readonly string[] {",
    "  switch (pluginName) {",
    '    case "better-auth": return [BETTER_AUTH_MODULE_NAME];',
    '    case "drizzle-transaction": return [DRIZZLE_TRANSACTION_MODULE_NAME];',
    '    case "polar-billing": return [POLAR_BILLING_MODULE_NAME];',
    '    case "qstash-tasks": return [QSTASH_TASKS_MODULE_NAME];',
    '    case "cloudinary-storage": return [CLOUDINARY_STORAGE_MODULE_NAME];',
    "    default: return [];",
    "  }",
    "}",
    "",
    "function requireLocalProviders(providers: GeneratedSaasLocalProviders | undefined): GeneratedSaasLocalProviders {",
    '  if (providers === undefined) throw new GeneratedSaasProviderProfileError("CROCO_SAAS_PROFILE_LOCAL_PROVIDERS_REQUIRED", "zero-credential mode requires explicit local providers");',
    "  return providers;",
    "}",
    "",
    "function readProfileConfiguration(mode: GeneratedSaasProfileMode, env: Readonly<Record<string, string | undefined>>) {",
    '  if (mode === "zero-credential") {',
    '    return { databaseUrl: undefined, betterAuthUrl: "http://localhost:3000", betterAuthSecret: "zero-credential-better-auth-secret-32", polarAccessToken: "zero-credential-polar-token", polarEnvironment: "sandbox" as const, polarWebhookSecret: "zero-credential-polar-webhook", qstashToken: "zero-credential-qstash-token", qstashDestinationUrl: "https://example.test/tasks", cloudinaryUrl: "cloudinary://zero-key:zero-secret@zero-cloud", otlpEndpoint: undefined };',
    "  }",
    "  return {",
    '    databaseUrl: requireEnv(env, "DATABASE_URL"),',
    '    betterAuthUrl: requireEnv(env, "BETTER_AUTH_URL"),',
    '    betterAuthSecret: requireEnv(env, "BETTER_AUTH_SECRET"),',
    '    polarAccessToken: requireEnv(env, "POLAR_ACCESS_TOKEN"),',
    '    polarEnvironment: env.NODE_ENV === "production" ? "production" as const : "sandbox" as const,',
    '    polarWebhookSecret: requireEnv(env, "POLAR_WEBHOOK_SECRET"),',
    '    qstashToken: requireEnv(env, "UPSTASH_QSTASH_TOKEN"),',
    '    qstashDestinationUrl: requireEnv(env, "UPSTASH_QSTASH_DESTINATION_URL"),',
    '    cloudinaryUrl: requireEnv(env, "CLOUDINARY_URL"),',
    "    otlpEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT,",
    "  };",
    "}",
    "",
    "function requireEnv(env: Readonly<Record<string, string | undefined>>, key: string): string {",
    "  const value = env[key];",
    '  if (value === undefined || value.length === 0 || value.startsWith("<")) throw new GeneratedSaasProviderProfileError("CROCO_SAAS_PROFILE_ENV_MISSING", key);',
    "  return value;",
    "}",
    "",
    "function parseCloudinaryUrl(value: string) {",
    "  const url = new URL(value);",
    '  if (url.protocol !== "cloudinary:" || !url.hostname || !url.username || !url.password) throw new GeneratedSaasProviderProfileError("CROCO_SAAS_PROFILE_CLOUDINARY_URL_INVALID", "CLOUDINARY_URL must be cloudinary://api-key:api-secret@cloud-name");',
    "  return { cloudName: url.hostname, apiKey: decodeURIComponent(url.username), apiSecret: decodeURIComponent(url.password), secure: true };",
    "}",
    "",
  ].join("\n");
}

export function renderSaasSecretsChecklist(manifest: SaasProviderProfileManifest): string {
  const requiredSecrets = manifest.env.required.filter((entry) => entry.secret);
  const nonSecretConfig = manifest.env.required.filter((entry) => !entry.secret);

  return [
    `# ${manifest.profile.displayName} Secrets Checklist`,
    "",
    "## Placeholder Policy",
    "",
    renderSecretPlaceholderPolicyTable(manifest),
    "",
    "## Required Secrets",
    "",
    ...renderSecretsChecklistPlaceholderItems(manifest, requiredSecrets),
    "",
    "## Required Non-Secret Config",
    "",
    ...renderSecretsChecklistPlaceholderItems(manifest, nonSecretConfig),
    "",
    "## Real-Provider Smoke",
    "",
    `Run \`${manifest.smoke.realProviderOptIn}\` only after the required values above are loaded.`,
    "",
  ].join("\n");
}

export function renderSaasDeployNotes(manifest: SaasProviderProfileManifest): string {
  const tenantModel = getTenantModelDefinition(manifest.tenantModel.currentModel);

  return [
    `# ${manifest.profile.displayName} Deploy Notes`,
    "",
    "## Manifest Contract",
    "",
    `Schema id: \`${manifest.schema.id}\``,
    `Schema version: \`${manifest.schemaVersion}\``,
    `Supported versions: \`${manifest.schema.supportedVersions.join(", ")}\``,
    "",
    "Compatibility rules:",
    ...manifest.compatibility.rules.map((rule) => `- ${rule}`),
    "",
    "Generated artifacts:",
    ...Object.entries(manifest.compatibility.generatedArtifacts).map(
      ([label, file]) => `- ${label}: \`${file}\``,
    ),
    "",
    "Version migration guidance:",
    ...manifest.compatibility.migration.guidance.map((step) => `- ${step}`),
    "",
    "Quality gates:",
    ...manifest.compatibility.qualityGates.map((gate) => `- \`${gate}\``),
    "",
    "## Placeholder Policy",
    "",
    renderSecretPlaceholderPolicyTable(manifest),
    "",
    "Generated `.env.example`, provider docs, and secrets checklists must use these safe values. Load real provider credentials from deployment secrets only.",
    "",
    `Runtime target: \`${manifest.profile.runtimeTarget}\``,
    `Tenant model: \`${tenantModel.name}\` (${tenantModel.displayName})`,
    "",
    "## Provider Packages",
    "",
    ...manifest.packages.map((packageName) => `- ${packageName}`),
    "",
    "## Capability Matrix",
    "",
    "| Capability | Provider | Package | Production | Zero credential | Env |",
    "| --- | --- | --- | --- | --- | --- |",
    ...manifest.capabilities.map(
      (capability) =>
        `| ${capability.capability} | ${capability.provider} | ${capability.packageName ?? "-"} | ${capability.productionState} | ${capability.zeroCredentialState} | ${capability.env.length > 0 ? capability.env.join(", ") : "-"} |`,
    ),
    "",
    "## Executable Composition",
    "",
    ...(manifest.composition.executable
      ? manifest.composition.plugins.map(
          (pluginDefinition) =>
            `- \`${pluginDefinition.factoryExport}()\` from \`${pluginDefinition.packageName}\` (${pluginDefinition.maturity}; modules: ${pluginDefinition.moduleNames.join(", ")})`,
        )
      : [
          "- No executable composition is available for this profile; its capabilities are documentation-only or unavailable.",
        ]),
    "",
    "## Tenant Model",
    "",
    tenantModel.summary,
    "",
    `Playbook: \`${manifest.tenantModel.playbook}\``,
    `Manifest: \`${manifest.tenantModel.manifest}\``,
    "",
    "## Deployment Notes",
    "",
    ...manifest.deployNotes.map((note) => `- ${note}`),
    "",
  ].join("\n");
}

export function formatSaasProviderProfileChoices(): string {
  return SAAS_PROVIDER_PROFILE_CHOICES.join("|");
}

function envVar(
  name: EnvironmentVariableName,
  requiredForRealProvider: boolean,
  example?: string,
): SaasProviderEnvVar {
  const variable = getEnvironmentVariable(name, example);
  const resolvedExample = variable.example;
  const base = {
    name,
    description: variable.description,
    requiredForRealProvider,
    secret: variable.secret,
  };

  return resolvedExample === undefined ? base : { ...base, example: resolvedExample };
}

function capability(
  capabilityName: SaasProviderCapabilityName,
  provider: string,
  status: CapabilityStatus,
  packageName: string | undefined,
  env: readonly string[],
): SaasProviderCapability {
  const runtimeState: SaasProviderCapabilityRuntimeState =
    status === "configured"
      ? "configured-production-plugin"
      : status === "documented"
        ? "documentation-only"
        : "unavailable";
  const base = {
    capability: capabilityName,
    provider,
    status,
    productionState: runtimeState,
    zeroCredentialState: runtimeState,
    env,
    notes: `${provider} covers ${capabilityName}.`,
  };
  return packageName === undefined ? base : { ...base, packageName };
}

function executableCapability(
  capabilityName: SaasProviderCapabilityName,
  provider: string,
  pluginName: string,
  zeroCredentialState: SaasProviderCapabilityRuntimeState,
): SaasProviderCapability {
  const pluginDefinition = SAAS_NODE_POSTGRES_PLUGINS.find(
    (candidate) => candidate.pluginName === pluginName,
  );
  if (pluginDefinition === undefined) {
    throw new SaasProviderProfileError("CROCO_SAAS_PROFILE_PLUGIN_MISSING", pluginName);
  }

  return {
    capability: capabilityName,
    provider,
    status: "configured",
    productionState: "configured-production-plugin",
    zeroCredentialState,
    packageName: pluginDefinition.packageName,
    pluginName: pluginDefinition.pluginName,
    env: pluginDefinition.env,
    notes: `${provider} is provided by ${pluginDefinition.factoryExport}().`,
  };
}

function plugin(definition: SaasProviderPluginDefinition): SaasProviderPluginDefinition {
  return definition;
}

function deriveExecutableProfileEnv(
  plugins: readonly SaasProviderPluginDefinition[],
  additional: readonly SaasProviderEnvVar[],
): readonly SaasProviderEnvVar[] {
  const entries = new Map<EnvironmentVariableName, SaasProviderEnvVar>(
    commonEnv.map((entry) => [entry.name, entry]),
  );

  for (const pluginDefinition of plugins) {
    for (const name of pluginDefinition.env) {
      if (!entries.has(name)) {
        entries.set(name, envVar(name, true));
      }
    }
  }
  for (const entry of additional) {
    entries.set(entry.name, entry);
  }

  return [...entries.values()];
}

function capabilities(
  entries: Record<SaasProviderCapabilityName, SaasProviderCapability>,
): Record<SaasProviderCapabilityName, SaasProviderCapability> {
  return entries;
}
