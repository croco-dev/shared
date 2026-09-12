import { Container, Context, type ILogger, LOGGER_TOKEN } from "@croco/framework-context";
import { recordError } from "@croco/telemetry-api";
import type { AuditLogRepository } from "./AuditLogRepository";
import { AUDIT_LOG_REPOSITORY_TOKEN } from "./AuditLogRepositoryToken";
import { hasAuditCoordination, markAuditWrite } from "./auditCoordination";
import { AUDIT_METADATA_KEY } from "./constants";
import { resolveImpersonationContext } from "./impersonationState";
import { AuditableDecoratorProblem } from "./problems/AuditableDecoratorProblem";
import { sanitizeAuditValue } from "./sanitizeAuditValue";
import type { AuditableOptions, AuditLogEntry, AuditParamMetadata } from "./types";

type DecoratedMethod = (...args: unknown[]) => unknown;

function extractDiffFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(payload, "diff");
  } catch {
    return null;
  }

  if (!descriptor || !("value" in descriptor)) {
    return null;
  }

  const diff = descriptor.value;
  if (!diff || typeof diff !== "object") {
    return null;
  }

  const sanitized = sanitizeAuditValue(diff);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return null;
  }
  return sanitized as Record<string, unknown>;
}

function toResourceId(value: unknown, args: unknown[], useFirstArgumentFallback: boolean): string {
  if (value !== undefined && value !== null) {
    return String(value);
  }

  if (useFirstArgumentFallback) {
    const firstArgument = args[0];
    if (firstArgument !== undefined && firstArgument !== null) {
      return String(firstArgument);
    }
  }

  return "unknown";
}

function buildAuditPayload(
  args: unknown[],
  payloadInput: unknown,
  result: unknown,
  errorMessage: string | null,
  includeResult: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    arguments: sanitizeAuditValue(args),
  };

  if (payloadInput !== undefined) {
    payload.input = sanitizeAuditValue(payloadInput);
  }

  if (includeResult && errorMessage === null) {
    payload.result = sanitizeAuditValue(result);
  }

  if (errorMessage !== null) {
    payload.error = sanitizeAuditValue(errorMessage);
  }

  return payload;
}

function getErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "[Unserializable]";
  }
}

type AuditWriteConfig = {
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  diff: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  throwOnError?: boolean;
};

type AuditWriteDependencies = {
  repository: AuditLogRepository;
  logger: ILogger;
};

function safelyRecordError(error: unknown): void {
  try {
    recordError(error);
  } catch {
    return;
  }
}

function safelyWarn(logger: ILogger, message: string, metadata: Record<string, unknown>): void {
  try {
    logger.warn(message, metadata);
  } catch {
    return;
  }
}

function resolveAuditWriteDependencies(): AuditWriteDependencies | undefined {
  try {
    const [repository, logger] = Container.getMany([AUDIT_LOG_REPOSITORY_TOKEN, LOGGER_TOKEN]) as [
      AuditLogRepository,
      ILogger,
    ];

    return { repository, logger };
  } catch (error) {
    safelyRecordError(error);
    return undefined;
  }
}

async function writeAuditLog(
  config: AuditWriteConfig,
  payload: Record<string, unknown>,
  dependencies: AuditWriteDependencies,
): Promise<boolean> {
  const entry: Omit<AuditLogEntry, "id" | "createdAt"> = {
    tenantId: config.tenantId,
    actorId: config.actorId,
    action: config.action,
    resourceType: config.resourceType,
    resourceId: config.resourceId,
    payload,
    diff: config.diff,
    metadata: config.metadata,
  };

  try {
    await dependencies.repository.create(entry);
    return true;
  } catch (error) {
    safelyRecordError(error);
    safelyWarn(dependencies.logger, "[Auditable] Failed to write audit log", {
      error: error instanceof Error ? error.message : String(error),
    });

    if (config.throwOnError) {
      throw error;
    }
    return false;
  }
}

async function writeDecoratorAuditLog(
  config: AuditWriteConfig,
  payload: Record<string, unknown>,
  dependencies: AuditWriteDependencies,
  target: object,
  propertyKey: string | symbol,
): Promise<void> {
  const writePromise = writeAuditLog(config, payload, dependencies);

  if (hasAuditCoordination(target, propertyKey)) {
    if (await writePromise) {
      markAuditWrite(target, propertyKey);
    }
    return;
  }

  if (config.throwOnError) {
    await writePromise;
  } else {
    void writePromise;
  }
}

export const AUDIT_PARAM_KEY = Symbol("audit:param");

function resolveParameterIndex(
  optionName: "resourceIdIndex" | "payloadIndex",
  index: number | undefined,
  selectableParameterCount: number,
): number | undefined {
  if (index === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(index) || index < 0 || index >= selectableParameterCount) {
    throw new AuditableDecoratorProblem(
      `@Auditable ${optionName} must reference a fixed parameter before the first default or rest parameter; received ${String(index)} for a method with ${selectableParameterCount} selectable parameters. When combining method decorators, place @Auditable closest to the method`,
    );
  }

  return index;
}

function rejectLegacyParameterSelectors(options: AuditableOptions): void {
  const legacyOptions = options as AuditableOptions & {
    resourceIdParam?: unknown;
    payloadParam?: unknown;
  };

  if (legacyOptions.resourceIdParam !== undefined || legacyOptions.payloadParam !== undefined) {
    throw new AuditableDecoratorProblem(
      "@Auditable resourceIdParam and payloadParam are unsupported; migrate to resourceIdIndex and payloadIndex",
    );
  }
}

export function Auditable(options: AuditableOptions): MethodDecorator {
  rejectLegacyParameterSelectors(options);

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const originalMethod = descriptor.value as DecoratedMethod;

    if (typeof originalMethod !== "function") {
      throw new AuditableDecoratorProblem("@Auditable can only be applied to methods");
    }

    const selectableParameterCount = originalMethod.length;
    const paramMetadata: AuditParamMetadata = {
      resourceIdIndex: resolveParameterIndex(
        "resourceIdIndex",
        options.resourceIdIndex,
        selectableParameterCount,
      ),
      payloadIndex: resolveParameterIndex(
        "payloadIndex",
        options.payloadIndex,
        selectableParameterCount,
      ),
    };

    Reflect.defineMetadata(AUDIT_PARAM_KEY, paramMetadata, target, propertyKey);
    const interceptorMetadataTarget = typeof target === "function" ? target : target.constructor;
    Reflect.defineMetadata(
      AUDIT_METADATA_KEY,
      { source: "decorator" },
      interceptorMetadataTarget,
      propertyKey,
    );

    descriptor.value = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const context = Context.get();
      const dependencies = resolveAuditWriteDependencies();
      if (!dependencies && options.throwOnFailure) {
        throw new AuditableDecoratorProblem(
          "@Auditable could not resolve audit write dependencies",
        );
      }

      const payloadInput =
        paramMetadata.payloadIndex !== undefined ? args[paramMetadata.payloadIndex] : undefined;
      const resourceIdValue =
        paramMetadata.resourceIdIndex !== undefined
          ? args[paramMetadata.resourceIdIndex]
          : undefined;
      const impersonation = resolveImpersonationContext(context);
      const activeImpersonation = impersonation.status === "active" ? impersonation.state : null;

      const auditConfig: AuditWriteConfig = {
        tenantId: context?.tenantId ?? "unknown",
        actorId:
          activeImpersonation?.impersonatorId ??
          (impersonation.status === "invalid" ? "unknown" : (context?.user?.id ?? "unknown")),
        action: options.action,
        resourceType: options.resourceType,
        resourceId: toResourceId(
          resourceIdValue,
          args,
          paramMetadata.resourceIdIndex === undefined,
        ),
        diff: extractDiffFromPayload(payloadInput),
        metadata: activeImpersonation
          ? {
              impersonation: true,
              impersonatorId: activeImpersonation.impersonatorId,
              targetUserId: activeImpersonation.targetUserId,
            }
          : impersonation.status === "invalid"
            ? { impersonation: true, invalidImpersonationContext: true }
            : {},
        throwOnError: options.throwOnFailure,
      };

      let result: unknown;
      try {
        result = await originalMethod.apply(this, args);
      } catch (error) {
        const payload = buildAuditPayload(args, payloadInput, null, getErrorMessage(error), false);
        if (dependencies) {
          await writeDecoratorAuditLog(
            auditConfig,
            payload,
            dependencies,
            interceptorMetadataTarget,
            propertyKey,
          );
        }

        throw error;
      }

      const payload = buildAuditPayload(
        args,
        payloadInput,
        result,
        null,
        options.includeResult ?? false,
      );
      if (dependencies) {
        await writeDecoratorAuditLog(
          auditConfig,
          payload,
          dependencies,
          interceptorMetadataTarget,
          propertyKey,
        );
      }

      return result;
    };

    return descriptor;
  };
}
