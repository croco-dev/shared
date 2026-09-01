import type {
  DependencySourceLocation,
  KnownRuntimePlatform,
  RuntimeCapabilities,
  RuntimeCapabilityDiagnostic,
  RuntimeCapabilityManifest,
  RuntimeCapabilityManifestVersion,
  RuntimeCapabilityName,
  RuntimeCapabilityRequirement,
  RuntimeCompositionManifest,
  RuntimePlatform,
} from "./types";

export const RUNTIME_CAPABILITY_MANIFEST_VERSION =
  "croco.runtime-capability.manifest.v1" as const satisfies RuntimeCapabilityManifestVersion;

export const RUNTIME_CAPABILITY_UNSUPPORTED_DIAGNOSTIC_CODE =
  "CROCO_RUNTIME_CAPABILITY_001" as const;

export const RUNTIME_PLATFORMS = [
  "node",
  "lambda",
  "cloudflare-workers",
] as const satisfies readonly KnownRuntimePlatform[];

export const RUNTIME_CAPABILITY_NAMES = [
  "env",
  "filesystem",
  "logger",
  "nodeApi",
  "requestLifecycle",
  "trace",
  "waitUntil",
  "flush",
  "streamingResponse",
  "deadline",
  "abortSignal",
  "shutdown",
] as const satisfies readonly RuntimeCapabilityName[];

export const RUNTIME_CAPABILITY_SUPPORT = {
  node: {
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
  lambda: {
    env: true,
    filesystem: true,
    logger: true,
    nodeApi: true,
    requestLifecycle: true,
    trace: true,
    waitUntil: true,
    flush: true,
    streamingResponse: false,
    deadline: true,
    abortSignal: false,
    shutdown: false,
  },
  "cloudflare-workers": {
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
} as const satisfies Record<KnownRuntimePlatform, RuntimeCapabilities>;

export type RuntimeCapabilitySupport = RuntimeCapabilities;

export type RuntimeCapabilitySupportMatrix = typeof RUNTIME_CAPABILITY_SUPPORT;

export type RuntimeCapabilitySupportForPlatform<TPlatform extends RuntimePlatform> =
  TPlatform extends KnownRuntimePlatform
    ? RuntimeCapabilitySupportMatrix[TPlatform]
    : RuntimeCapabilitySupport;

export type RuntimeCapabilitiesForPlatform<TPlatform extends RuntimePlatform> =
  TPlatform extends RuntimePlatform
    ? {
        readonly [TCapability in RuntimeCapabilityName]: RuntimeCapabilitySupportForPlatform<TPlatform>[TCapability] extends false
          ? false
          : boolean;
      }
    : never;

export type RuntimeCapabilityOverridesFor<TPlatform extends RuntimePlatform> = Partial<
  RuntimeCapabilitiesForPlatform<TPlatform>
>;

export type SupportedRuntimeCapabilityName<TPlatform extends RuntimePlatform> = {
  readonly [TCapability in RuntimeCapabilityName]: RuntimeCapabilitySupportForPlatform<TPlatform>[TCapability] extends false
    ? never
    : TCapability;
}[RuntimeCapabilityName];

export type UnsupportedRuntimeCapabilityName<TPlatform extends RuntimePlatform> = Exclude<
  RuntimeCapabilityName,
  SupportedRuntimeCapabilityName<TPlatform>
>;

export function isKnownRuntimePlatform(
  platform: RuntimePlatform,
): platform is KnownRuntimePlatform {
  return RUNTIME_PLATFORMS.includes(platform as KnownRuntimePlatform);
}

export function getRuntimeCapabilitySupport<TPlatform extends KnownRuntimePlatform>(
  platform: TPlatform,
): RuntimeCapabilitiesForPlatform<TPlatform> {
  return RUNTIME_CAPABILITY_SUPPORT[
    platform
  ] as unknown as RuntimeCapabilitiesForPlatform<TPlatform>;
}

export function createRuntimeCapabilityManifest<TPlatform extends KnownRuntimePlatform>(
  platform: TPlatform,
  options: {
    readonly composition?: RuntimeCompositionManifest<TPlatform>;
    readonly requirements?: readonly RuntimeCapabilityRequirement[];
  } = {},
): RuntimeCapabilityManifest {
  return createRuntimeCapabilityManifestFromSupport(
    platform,
    getRuntimeCapabilitySupport(platform),
    {
      ...(options.composition ? { composition: options.composition } : {}),
      ...(options.requirements ? { requirements: options.requirements } : {}),
    },
  );
}

export function createRuntimeCapabilityManifestFromSupport(
  platform: RuntimePlatform,
  capabilities: RuntimeCapabilitySupport,
  options: {
    readonly composition?: RuntimeCompositionManifest;
    readonly requirements?: readonly RuntimeCapabilityRequirement[];
  } = {},
): RuntimeCapabilityManifest {
  const manifest: RuntimeCapabilityManifest = {
    version: RUNTIME_CAPABILITY_MANIFEST_VERSION,
    platform,
    capabilities: normalizeRuntimeCapabilities(capabilities),
    diagnostics: [],
    ...(options.composition
      ? { composition: normalizeRuntimeCompositionManifest(options.composition) }
      : {}),
  };

  return {
    ...manifest,
    diagnostics: checkRuntimeCapabilityRequirements(manifest, options.requirements ?? []),
  };
}

export function checkRuntimeCapabilityRequirements(
  manifest: Pick<RuntimeCapabilityManifest, "platform" | "capabilities">,
  requirements: readonly RuntimeCapabilityRequirement[],
): readonly RuntimeCapabilityDiagnostic[] {
  return requirements
    .filter((requirement) => !manifest.capabilities[requirement.capability])
    .map((requirement) =>
      createRuntimeCapabilityDiagnostic(
        manifest.platform,
        requirement.capability,
        requirement.source,
      ),
    )
    .sort(compareRuntimeCapabilityDiagnostics);
}

export function createRuntimeCapabilityDiagnostic(
  platform: RuntimePlatform,
  capability: RuntimeCapabilityName,
  source?: DependencySourceLocation,
): RuntimeCapabilityDiagnostic {
  return {
    code: RUNTIME_CAPABILITY_UNSUPPORTED_DIAGNOSTIC_CODE,
    severity: "error",
    platform,
    capability,
    message: `Runtime platform '${platform}' does not support capability '${capability}'.`,
    ...(source ? { source } : {}),
  };
}

export function stringifyRuntimeCapabilityManifest(manifest: RuntimeCapabilityManifest): string {
  return `${JSON.stringify(normalizeRuntimeCapabilityManifest(manifest), null, 2)}\n`;
}

export function isRuntimeCapabilitySupported(
  platform: RuntimePlatform,
  capability: RuntimeCapabilityName,
  capabilitySupport?: RuntimeCapabilitySupport,
): boolean {
  const support = isKnownRuntimePlatform(platform)
    ? RUNTIME_CAPABILITY_SUPPORT[platform]
    : capabilitySupport;

  return support?.[capability] ?? false;
}

function normalizeRuntimeCapabilityManifest(
  manifest: RuntimeCapabilityManifest,
): RuntimeCapabilityManifest {
  return {
    version: RUNTIME_CAPABILITY_MANIFEST_VERSION,
    platform: manifest.platform,
    capabilities: normalizeRuntimeCapabilities(manifest.capabilities),
    diagnostics: [...manifest.diagnostics].sort(compareRuntimeCapabilityDiagnostics),
    ...(manifest.composition
      ? { composition: normalizeRuntimeCompositionManifest(manifest.composition) }
      : {}),
  };
}

function normalizeRuntimeCompositionManifest(
  composition: RuntimeCompositionManifest,
): RuntimeCompositionManifest {
  return {
    host: { ...composition.host },
    transports: [...composition.transports]
      .map((transport) => ({ ...transport }))
      .sort(
        (left, right) =>
          left.protocol.localeCompare(right.protocol) ||
          (left.packageName ?? "").localeCompare(right.packageName ?? ""),
      ),
    buildTarget: {
      ...composition.buildTarget,
      ...(composition.buildTarget.constraints
        ? { constraints: [...composition.buildTarget.constraints].sort() }
        : {}),
    },
  };
}

function normalizeRuntimeCapabilities(capabilities: RuntimeCapabilitySupport): RuntimeCapabilities {
  return Object.fromEntries(
    RUNTIME_CAPABILITY_NAMES.map((capability) => [capability, capabilities[capability]]),
  ) as RuntimeCapabilities;
}

function compareRuntimeCapabilityDiagnostics(
  left: RuntimeCapabilityDiagnostic,
  right: RuntimeCapabilityDiagnostic,
): number {
  return (
    left.platform.localeCompare(right.platform) ||
    left.capability.localeCompare(right.capability) ||
    formatRuntimeCapabilityDiagnosticSource(left.source).localeCompare(
      formatRuntimeCapabilityDiagnosticSource(right.source),
    )
  );
}

function formatRuntimeCapabilityDiagnosticSource(
  source: DependencySourceLocation | undefined,
): string {
  if (!source) {
    return "";
  }

  return [source.file, source.line, source.column].filter((part) => part !== undefined).join(":");
}
