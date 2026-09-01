const EXTERNAL_CROCO_PACKAGE_RANGES = {
  "@croco/access-core": "^0.0.4",
  "@croco/admin-core": "^0.0.1",
  "@croco/admin-ops": "^0.1.0",
  "@croco/admin-react": "^0.1.0",
  "@croco/auth-better-auth": "^0.0.4",
  "@croco/auth-clerk": "^0.0.4",
  "@croco/auth-core": "^0.0.4",
  "@croco/auth-drizzle": "^0.0.4",
  "@croco/billing-core": "^0.0.4",
  "@croco/billing-polar": "^0.0.4",
  "@croco/cli": "^0.0.4",
  "@croco/credits-core": "^0.0.1",
  "@croco/diagnostics-core": "^0.0.4",
  "@croco/engagement-core": "^0.1.0",
  "@croco/entitlements-core": "^0.0.4",
  "@croco/execution-core": "^0.0.4",
  "@croco/events-core": "^0.0.4",
  "@croco/events-inmemory": "^0.0.4",
  "@croco/framework-context": "^0.0.4",
  "@croco/framework-module": "^0.0.4",
  "@croco/framework-logger": "^0.0.4",
  "@croco/frontend-cloudflare": "^0.1.0",
  "@croco/frontend-problems": "^0.1.0",
  "@croco/frontend-react": "^0.1.0",
  "@croco/frontend-vite": "^0.0.4",
  "@croco/health-core": "^0.0.4",
  "@croco/idempotency-core": "^0.1.0",
  "@croco/invitation-core": "^0.0.4",
  "@croco/lifecycle-core": "^0.0.1",
  "@croco/llm-core": "^0.0.4",
  "@croco/llm-metering": "^0.0.4",
  "@croco/membership-core": "^0.0.4",
  "@croco/meta-vite": "^0.0.4",
  "@croco/metering-core": "^0.0.4",
  "@croco/metering-drizzle": "^0.0.4",
  "@croco/metering-upstash": "^0.0.4",
  "@croco/notifications-core": "^0.1.0",
  "@croco/openapi-spec": "^0.1.0",
  "@croco/problems-core": "^0.0.4",
  "@croco/preset-cloudflare": "^0.0.4",
  "@croco/preset-lambda": "^0.0.4",
  "@croco/preset-node": "^0.0.4",
  "@croco/protocols-core": "^0.1.0",
  "@croco/protocols-graphql": "^0.0.4",
  "@croco/protocols-rest": "^0.0.4",
  "@croco/ratelimit-core": "^0.0.4",
  "@croco/repository-core": "^0.0.4",
  "@croco/retry-core": "^0.0.4",
  "@croco/rpc-codegen": "^0.1.0",
  "@croco/storage-core": "^0.0.4",
  "@croco/storage-cloudinary": "^0.0.4",
  "@croco/storage-r2": "^0.0.4",
  "@croco/tasks-core": "^0.0.4",
  "@croco/tasks-qstash": "^0.0.4",
  "@croco/telemetry-api": "^0.1.0",
  "@croco/telemetry-sdk-node": "^0.0.4",
  "@croco/tenant-core": "^0.1.0",
  "@croco/testing": "^0.0.1",
  "@croco/transports-cloudflare-workers": "^0.0.4",
  "@croco/transports-http": "^0.0.4",
  "@croco/triggers-qstash": "^0.0.4",
  "@croco/tx-core": "^0.0.4",
  "@croco/tx-drizzle": "^0.0.4",
  "@croco/ui-astryx": "^0.1.0",
  "@croco/webhooks-core": "^0.1.0",
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
