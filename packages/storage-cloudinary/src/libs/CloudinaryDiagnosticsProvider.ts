import type { DiagnosticsProvider, HealthStatus } from "@croco/diagnostics-core";
import { Problem, ProblemCategory } from "@croco/problems-core";
import type { CloudinaryConfig } from "./types";
import {
  CLOUDINARY_UPLOAD_SIGNATURE_VALIDITY_SECONDS,
  isValidCloudinaryUploadIntentTtl,
} from "./uploadIntentTtl";

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export type CloudinaryStorageErrorContext = {
  readonly provider: "cloudinary";
  readonly operation: string;
  readonly key?: string;
  readonly status?: number;
  readonly upstreamCode?: string;
  readonly retryable?: boolean;
};

export type CloudinaryReadinessCheckContext = {
  readonly config: CloudinaryConfig;
  readonly signal?: AbortSignal;
};

export type CloudinaryReadinessCheckResult = {
  readonly message?: string;
  readonly details?: Record<string, unknown>;
};

export type CloudinaryDiagnosticsOptions = {
  readonly readinessCheck?: (
    context: CloudinaryReadinessCheckContext,
  ) => Promise<CloudinaryReadinessCheckResult | void>;
};

export type CloudinaryConfigKey = "apiKey" | "apiSecret" | "cloudName";

export class CloudinaryMissingConfigProblem extends Problem {
  constructor(configKey: CloudinaryConfigKey, operation = "configuration") {
    super(
      "storage-cloudinary/missing-config",
      ProblemCategory.InternalServerError,
      `Cloudinary configuration is missing required value '${configKey}'`,
      {
        extensions: {
          provider: "cloudinary",
          operation,
          configKey,
        },
      },
    );
  }
}

export class CloudinaryValidationProblem extends Problem {
  constructor(
    context: CloudinaryStorageErrorContext,
    detail = "Cloudinary storage request validation failed",
  ) {
    super(
      "storage-cloudinary/validation-failed",
      ProblemCategory.ValidationError,
      `${detail} during ${context.operation}`,
      {
        extensions: toCloudinaryStorageExtensions(context),
      },
    );
  }
}

export class CloudinaryRetryableUpstreamProblem extends Problem {
  constructor(context: CloudinaryStorageErrorContext) {
    super(
      "storage-cloudinary/retryable-upstream",
      ProblemCategory.InternalServerError,
      `Cloudinary upstream request failed retryably during ${context.operation}`,
      {
        extensions: {
          ...toCloudinaryStorageExtensions(context),
          retryable: true,
        },
      },
    );
  }
}

export class CloudinaryTerminalUpstreamProblem extends Problem {
  constructor(context: CloudinaryStorageErrorContext) {
    super(
      "storage-cloudinary/terminal-upstream",
      ProblemCategory.InternalServerError,
      `Cloudinary upstream request failed terminally during ${context.operation}`,
      {
        extensions: {
          ...toCloudinaryStorageExtensions(context),
          retryable: false,
        },
      },
    );
  }
}

export class CloudinaryDiagnosticsProvider implements DiagnosticsProvider {
  readonly name = "storage-cloudinary";

  constructor(
    private readonly config: Partial<CloudinaryConfig>,
    private readonly options: CloudinaryDiagnosticsOptions = {},
  ) {}

  async getHealth(signal?: AbortSignal): Promise<HealthStatus> {
    const baseDetails = this.createSafeConfigDetails();
    let validConfig: CloudinaryConfig;

    try {
      validConfig = validateCloudinaryConfig(this.config);
    } catch (error) {
      const problem =
        error instanceof Problem
          ? error
          : normalizeCloudinaryStorageError(error, { operation: "configuration" });

      return {
        status: "unhealthy",
        component: this.name,
        message: problem.detail,
        details: {
          ...baseDetails,
          liveCheck: "not_started",
          problemCode: problem.code,
          problemStatus: problem.status,
        },
        lastChecked: new Date().toISOString(),
      };
    }

    if (!this.options.readinessCheck) {
      return {
        status: "healthy",
        component: this.name,
        message:
          "Cloudinary configuration is present; live upstream readiness check is not configured",
        details: {
          ...baseDetails,
          liveCheck: "not_configured",
        },
        lastChecked: new Date().toISOString(),
      };
    }

    try {
      const result = await this.options.readinessCheck({ config: validConfig, signal });

      return {
        status: "healthy",
        component: this.name,
        message: result?.message ?? "Cloudinary readiness check passed",
        details: {
          ...baseDetails,
          liveCheck: "passed",
          ...(result?.details && { readiness: sanitizeDiagnosticValue(result.details) }),
        },
        lastChecked: new Date().toISOString(),
      };
    } catch (error) {
      const problem = normalizeCloudinaryStorageError(error, { operation: "readiness" });

      return {
        status: "degraded",
        component: this.name,
        message: problem.detail,
        details: {
          ...baseDetails,
          liveCheck: "failed",
          problemCode: problem.code,
          problemStatus: problem.status,
        },
        lastChecked: new Date().toISOString(),
      };
    }
  }

  private createSafeConfigDetails(): Record<string, unknown> {
    return {
      provider: "cloudinary",
      hasCloudName: isNonEmptyString(this.config.cloudName),
      hasApiKey: isNonEmptyString(this.config.apiKey),
      hasApiSecret: isNonEmptyString(this.config.apiSecret),
      secure: this.config.secure ?? true,
      hasUploadBaseUrl: isNonEmptyString(this.config.uploadBaseUrl),
      acceptedResourceTypes: ["image", "video", "raw"],
      metadataSupport: {
        contentType: "format-only",
        customMetadata: "required",
      },
    };
  }
}

export function validateCloudinaryConfig(config: Partial<CloudinaryConfig>): CloudinaryConfig {
  if (!isNonEmptyString(config.cloudName)) {
    throw new CloudinaryMissingConfigProblem("cloudName");
  }

  if (!isNonEmptyString(config.apiKey)) {
    throw new CloudinaryMissingConfigProblem("apiKey");
  }

  if (!isNonEmptyString(config.apiSecret)) {
    throw new CloudinaryMissingConfigProblem("apiSecret");
  }

  validateUploadIntentTtl(config.ttl);

  return config as CloudinaryConfig;
}

export function normalizeCloudinaryStorageError(
  error: unknown,
  options: {
    readonly operation: string;
    readonly key?: string;
    readonly status?: number;
    readonly upstreamCode?: string;
  },
): Problem {
  if (error instanceof Problem) {
    return error;
  }

  const context = createCloudinaryStorageErrorContext(error, options);

  if (isNotFoundError(context, error)) {
    return new CloudinaryTerminalUpstreamProblem(context);
  }

  if (isValidationError(context)) {
    return new CloudinaryValidationProblem(context);
  }

  if (isRetryableCloudinaryStorageError(error, context)) {
    return new CloudinaryRetryableUpstreamProblem(context);
  }

  return new CloudinaryTerminalUpstreamProblem(context);
}

export function isRetryableCloudinaryStorageError(
  error: unknown,
  knownContext?: CloudinaryStorageErrorContext,
): boolean {
  const context =
    knownContext ?? createCloudinaryStorageErrorContext(error, { operation: "unknown" });

  if (context.status !== undefined) {
    if (context.status === 404) {
      return false;
    }

    if (TRANSIENT_HTTP_STATUSES.has(context.status)) {
      return true;
    }
  }

  if (context.upstreamCode && TRANSIENT_ERROR_CODES.has(context.upstreamCode)) {
    return true;
  }

  const message = getCloudinaryErrorMessage(error, "").toLowerCase();

  return [
    "connection reset",
    "connect timeout",
    "econnreset",
    "fetch failed",
    "network error",
    "rate limit",
    "socket hang up",
    "temporarily unavailable",
    "timed out",
    "timeout",
    "too many requests",
    "try again",
  ].some((pattern) => message.includes(pattern));
}

export function getCloudinaryErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  const record = asRecord(error);
  const message = record?.message;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }

  const nestedMessage = asRecord(record?.error)?.message;
  if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
    return nestedMessage;
  }

  return fallback;
}

function createCloudinaryStorageErrorContext(
  error: unknown,
  options: {
    readonly operation: string;
    readonly key?: string;
    readonly status?: number;
    readonly upstreamCode?: string;
  },
): CloudinaryStorageErrorContext {
  const record = asRecord(error);
  const extensions = asRecord(record?.extensions);
  const nestedError = asRecord(record?.error);
  const status = firstNumber(
    options.status,
    record?.status,
    record?.http_code,
    record?.statusCode,
    nestedError?.status,
    nestedError?.http_code,
    nestedError?.statusCode,
    extensions?.status,
  );
  const upstreamCode = firstString(
    options.upstreamCode,
    extensions?.upstreamCode,
    record?.code,
    record?.name,
    nestedError?.code,
    nestedError?.name,
    typeof record?.error === "string" ? record.error : undefined,
    nestedError?.message,
  );

  return {
    provider: "cloudinary",
    operation: options.operation,
    ...(options.key !== undefined && { key: options.key }),
    ...(status !== undefined && { status }),
    ...(upstreamCode !== undefined && { upstreamCode }),
  };
}

function isNotFoundError(context: CloudinaryStorageErrorContext, error: unknown): boolean {
  return (
    context.status === 404 ||
    getCloudinaryErrorMessage(error, "").toLowerCase().includes("not found")
  );
}

function isValidationError(context: CloudinaryStorageErrorContext): boolean {
  return (
    context.status === 400 ||
    context.status === 401 ||
    context.status === 403 ||
    context.status === 422
  );
}

function toCloudinaryStorageExtensions(
  context: CloudinaryStorageErrorContext,
): Record<string, unknown> {
  return {
    provider: context.provider,
    operation: context.operation,
    ...(context.key !== undefined && { key: context.key }),
    ...(context.status !== undefined && { upstreamStatus: context.status }),
    ...(context.upstreamCode !== undefined && { upstreamCode: context.upstreamCode }),
    ...(context.retryable !== undefined && { retryable: context.retryable }),
  };
}

function validateUploadIntentTtl(value: unknown): void {
  if (value === undefined || isValidCloudinaryUploadIntentTtl(value)) {
    return;
  }

  throw new CloudinaryValidationProblem(
    {
      provider: "cloudinary",
      operation: "configuration",
      upstreamCode: "invalid-ttl",
    },
    `Cloudinary configuration 'ttl' must be an integer between 1 and ${CLOUDINARY_UPLOAD_SIGNATURE_VALIDITY_SECONDS}`,
  );
}

const SENSITIVE_DIAGNOSTIC_KEY =
  /(authorization|password|secret|token|api[-_]?key|access[-_]?token)/i;

function sanitizeDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
    };
  }

  if (typeof value === "object" && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_DIAGNOSTIC_KEY.test(key)
        ? "[redacted]"
        : sanitizeDiagnosticValue(nestedValue);
    }
    return sanitized;
  }

  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function firstNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (isNonEmptyString(value)) {
      return value;
    }
  }

  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
