import { Problem, ProblemCategory } from "@croco/problems-core";

export type RlsConfigurationField =
  | "adminRoles"
  | "configKey"
  | "tableName"
  | "tenantColumn"
  | "tenantColumnType";

/** Invalid static configuration for PostgreSQL row-level security helpers. */
export class RlsConfigurationProblem extends Problem {
  readonly code = "tx-drizzle/rls-configuration-invalid";
  readonly category = ProblemCategory.InternalServerError;

  constructor(field: RlsConfigurationField) {
    super(
      "tx-drizzle/rls-configuration-invalid",
      ProblemCategory.InternalServerError,
      `Invalid RLS configuration field: ${field}`,
      { extensions: { field, retryable: false } },
    );
  }
}

export class TenantContextRequiredProblem extends Problem {
  readonly code = "tx-drizzle/tenant-context-required";
  readonly category = ProblemCategory.InternalServerError;
  constructor() {
    super(undefined, undefined, "Tenant context is required");
  }
}

export class RlsExecuteUnsupportedProblem extends Problem {
  readonly code = "tx-drizzle/rls-execute-unsupported";
  readonly category = ProblemCategory.InternalServerError;
  constructor(configKey: string) {
    super(
      undefined,
      undefined,
      `Transaction client does not support execute(), cannot set RLS key '${configKey}'`,
    );
  }
}

export type RlsDebugLoggingPhase = "initialization" | "write";

/**
 * Requested RLS debug logging could not initialize or write its diagnostic event.
 *
 * @example
 * ```typescript
 * try {
 *   await adapter.transaction(runQuery);
 * } catch (problem) {
 *   if (problem instanceof RlsDebugLoggingProblem) {
 *     console.error(problem.extensions?.phase);
 *   }
 * }
 * ```
 */
export class RlsDebugLoggingProblem extends Problem {
  readonly code = "tx-drizzle/rls-debug-logging-failed";
  readonly category = ProblemCategory.InternalServerError;

  constructor(phase: RlsDebugLoggingPhase, cause: unknown) {
    const options = {
      extensions: { phase, retryable: false },
      ...(cause instanceof Error ? { cause } : {}),
    };

    super(
      "tx-drizzle/rls-debug-logging-failed",
      ProblemCategory.InternalServerError,
      `RLS debug logging failed during ${phase}`,
      options,
    );
  }
}

export class SavepointUnsupportedProblem extends Problem {
  readonly code = "tx-drizzle/savepoint-unsupported";
  readonly category = ProblemCategory.InternalServerError;
  constructor() {
    super(
      undefined,
      undefined,
      "Transaction client does not support savepoint(), nested transaction requires client.transaction()",
    );
  }
}
