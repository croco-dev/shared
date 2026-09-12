const EXTERNAL_CROCO_PACKAGE_RANGES = {
  "@croco/access-core": "^0.0.5",
  "@croco/admin-core": "^0.1.0",
  "@croco/admin-ops": "^0.2.0",
  "@croco/admin-react": "^0.2.0",
  "@croco/auth-better-auth": "^1.0.0",
  "@croco/auth-clerk": "^0.1.0",
  "@croco/auth-core": "^0.1.0",
  "@croco/auth-drizzle": "^0.1.0",
  "@croco/billing-core": "^1.0.0",
  "@croco/billing-polar": "^1.0.0",
  "@croco/cli": "^1.0.0",
  "@croco/credits-core": "^0.1.0",
  "@croco/diagnostics-core": "^0.1.0",
  "@croco/engagement-core": "^0.2.0",
  "@croco/entitlements-core": "^0.1.0",
  "@croco/execution-core": "^0.1.0",
  "@croco/events-core": "^0.1.0",
  "@croco/events-inmemory": "^0.1.0",
  "@croco/framework-context": "^0.1.0",
  "@croco/framework-module": "^0.1.0",
  "@croco/framework-logger": "^0.0.5",
  "@croco/frontend-cloudflare": "^0.1.1",
  "@croco/frontend-problems": "^0.1.1",
  "@croco/frontend-react": "^1.0.0",
  "@croco/frontend-vite": "^0.0.5",
  "@croco/health-core": "^1.0.0",
  "@croco/idempotency-core": "^0.1.1",
  "@croco/invitation-core": "^1.0.0",
  "@croco/lifecycle-core": "^0.1.0",
  "@croco/llm-core": "^1.0.0",
  "@croco/llm-metering": "^1.0.0",
  "@croco/membership-core": "^1.0.0",
  "@croco/meta-vite": "^0.0.5",
  "@croco/metering-core": "^0.1.0",
  "@croco/metering-drizzle": "^0.1.0",
  "@croco/metering-upstash": "^0.0.5",
  "@croco/notifications-core": "^0.2.0",
  "@croco/openapi-spec": "^0.1.1",
  "@croco/problems-core": "^1.0.0",
  "@croco/preset-cloudflare": "^0.1.0",
  "@croco/preset-lambda": "^0.1.0",
  "@croco/preset-node": "^0.1.0",
  "@croco/protocols-core": "^0.2.0",
  "@croco/protocols-graphql": "^0.0.5",
  "@croco/protocols-rest": "^0.1.0",
  "@croco/ratelimit-core": "^0.1.0",
  "@croco/repository-core": "^0.1.0",
  "@croco/retry-core": "^0.1.0",
  "@croco/rpc-codegen": "^0.2.0",
  "@croco/storage-core": "^1.0.0",
  "@croco/storage-cloudinary": "^1.0.0",
  "@croco/storage-r2": "^1.0.0",
  "@croco/tasks-core": "^0.1.0",
  "@croco/tasks-qstash": "^0.1.0",
  "@croco/telemetry-api": "^0.1.1",
  "@croco/telemetry-sdk-node": "^0.1.0",
  "@croco/tenant-core": "^0.1.1",
  "@croco/testing": "^1.0.0",
  "@croco/transports-cloudflare-workers": "^0.0.5",
  "@croco/transports-http": "^0.1.0",
  "@croco/triggers-qstash": "^1.0.0",
  "@croco/tx-core": "^0.1.0",
  "@croco/tx-drizzle": "^0.1.0",
  "@croco/ui-astryx": "^0.2.0",
  "@croco/webhooks-core": "^1.0.0",
} as const satisfies Record<string, string>;

export type ExternalCrocoPackageName = keyof typeof EXTERNAL_CROCO_PACKAGE_RANGES;

export type GeneratedAppCrocoVersionSetEntry = {
  readonly packageName: ExternalCrocoPackageName;
  readonly range: string;
};

export type GeneratedAppCrocoVersionSet = {
  readonly policy: "tested-croco-compatibility-train";
  readonly source: string;
  readonly packages: readonly GeneratedAppCrocoVersionSetEntry[];
};

export function getExternalCrocoPackageRange(packageName: string): string | undefined {
  return EXTERNAL_CROCO_PACKAGE_RANGES[packageName as keyof typeof EXTERNAL_CROCO_PACKAGE_RANGES];
}

export function getExternalCrocoPackageRanges(): Readonly<
  Record<ExternalCrocoPackageName, string>
> {
  return EXTERNAL_CROCO_PACKAGE_RANGES;
}

export function getGeneratedAppCrocoVersionSet(): GeneratedAppCrocoVersionSet {
  return {
    policy: "tested-croco-compatibility-train",
    source: "packages/create-croco-app/src/helpers/croco-ranges.ts",
    packages: (
      Object.entries(EXTERNAL_CROCO_PACKAGE_RANGES) as [ExternalCrocoPackageName, string][]
    )
      .map(([packageName, range]) => ({
        packageName,
        range,
      }))
      .sort((left, right) => left.packageName.localeCompare(right.packageName)),
  };
}
