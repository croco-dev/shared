import { Problem, ProblemCategory } from "@croco/problems-core";

export type ApplicationCleanupFailure = {
  readonly phase: "telemetry-force-flush" | "application-runtime-dispose";
  readonly cause: unknown;
};

export type ApplicationCleanupDiagnostic = {
  readonly phase: ApplicationCleanupFailure["phase"];
  readonly detail: string;
};

export class ApplicationCleanupProblem extends Problem {
  readonly code = "saas-demo/application-cleanup-failed";
  readonly category = ProblemCategory.InternalServerError;
  readonly cleanupFailures: readonly ApplicationCleanupDiagnostic[];

  constructor(failures: readonly ApplicationCleanupFailure[]) {
    const cleanupFailures = failures.map(({ phase, cause }) => ({
      phase,
      detail: describeFailure(cause),
    }));
    const firstCause = failures.find(({ cause }) => cause instanceof Error)?.cause;

    super(undefined, undefined, "Application lifecycle cleanup failed.", {
      extensions: { cleanupFailures },
      ...(firstCause instanceof Error ? { cause: firstCause } : {}),
    });
    this.cleanupFailures = cleanupFailures;
  }
}

export class ApplicationBootstrapProblem extends Problem {
  readonly code = "saas-demo/application-bootstrap-failed";
  readonly category = ProblemCategory.InternalServerError;

  constructor(bootstrapFailure: unknown, cleanupFailure: unknown) {
    super(undefined, undefined, "Application bootstrap and runtime disposal both failed.", {
      extensions: {
        bootstrapFailure: describeFailure(bootstrapFailure),
        cleanupFailures: [
          {
            phase: "application-runtime-dispose",
            detail: describeFailure(cleanupFailure),
          },
        ],
      },
      ...(bootstrapFailure instanceof Error ? { cause: bootstrapFailure } : {}),
    });
  }
}

export class NodeHostLifecycleProblem extends Problem {
  readonly code = "saas-demo/node-host-lifecycle-failed";
  readonly category = ProblemCategory.InternalServerError;

  constructor(operation: "start" | "close", hostFailure: unknown, cleanupFailure: unknown) {
    const cleanupFailures =
      cleanupFailure instanceof ApplicationCleanupProblem
        ? cleanupFailure.cleanupFailures
        : [{ phase: "application-runtime-dispose", detail: describeFailure(cleanupFailure) }];

    super(undefined, undefined, `Node host ${operation} and application cleanup both failed.`, {
      extensions: {
        operation,
        hostFailure: describeFailure(hostFailure),
        cleanupFailures,
      },
      ...(hostFailure instanceof Error ? { cause: hostFailure } : {}),
    });
  }
}

export class DemoEndpointDisabledProblem extends Problem {
  readonly code = "saas-demo/demo-endpoint-disabled";
  readonly category = ProblemCategory.Forbidden;

  constructor() {
    super(
      undefined,
      undefined,
      "SaaS demo endpoints require SAAS_DEMO_ENDPOINTS_ENABLED=true and remain disabled in production.",
    );
  }
}

export class InvalidPortProblem extends Problem {
  readonly code = "saas-demo/invalid-port";
  readonly category = ProblemCategory.ValidationError;

  constructor(value: string | undefined) {
    super(
      undefined,
      undefined,
      `PORT must be an integer between 1 and 65535. Received: ${value ?? "unset"}.`,
    );
  }
}

export class SaasProviderProfileMismatchProblem extends Problem {
  readonly code = "CROCO_SAAS_PROFILE_MISMATCH";
  readonly category = ProblemCategory.ValidationError;

  constructor(generatedProfile: string, requestedProfile: string) {
    super(
      undefined,
      undefined,
      `CROCO_SAAS_PROFILE_MISMATCH: generated ${generatedProfile}, requested ${requestedProfile}`,
    );
  }
}

export class SaasProviderProfileRuntimeUnavailableProblem extends Problem {
  readonly code = "CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE";
  readonly category = ProblemCategory.NotImplemented;

  constructor(profileName: string) {
    super(undefined, undefined, `CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE: ${profileName}`);
  }
}

export class InvalidJobsQueryProblem extends Problem {
  readonly code = "saas-demo/invalid-jobs-query";
  readonly category = ProblemCategory.ValidationError;

  constructor(name: string, value: string) {
    super(undefined, undefined, `Invalid jobs ${name}: ${value}.`);
  }
}

export class JobNotFoundProblem extends Problem {
  readonly code = "saas-demo/job-not-found";
  readonly category = ProblemCategory.NotFound;

  constructor(jobId: string) {
    super(undefined, undefined, `Job ${jobId} not found.`);
  }
}

export class TenantAlreadyExistsProblem extends Problem {
  readonly code = "saas-demo/tenant-already-exists";
  readonly category = ProblemCategory.Conflict;

  constructor(tenantId: string) {
    super(undefined, undefined, `Tenant ${tenantId} already exists.`);
  }
}

export class TenantNotFoundProblem extends Problem {
  readonly code = "saas-demo/tenant-not-found";
  readonly category = ProblemCategory.NotFound;

  constructor(tenantId: string) {
    super(undefined, undefined, `Tenant ${tenantId} not found.`);
  }
}

export class SaasDemoSmokeProblem extends Problem {
  readonly code = "saas-demo/smoke-failed";
  readonly category = ProblemCategory.InternalServerError;

  constructor(failures: readonly string[]) {
    super(undefined, undefined, `SaaS demo smoke failed: ${failures.join("; ")}`);
  }
}

export class SaasBillableUsageProblem extends Problem {
  readonly code = "saas-demo/billable-usage-failed";
  readonly category = ProblemCategory.InternalServerError;

  constructor(message: string) {
    super(undefined, undefined, message);
  }
}

export class SqliteFixtureStateProblem extends Problem {
  readonly code = "saas-demo/sqlite-fixture-state-invalid";
  readonly category = ProblemCategory.InternalServerError;

  constructor() {
    super(undefined, undefined, "SQLite fixture state must be an object.");
  }
}

function describeFailure(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}
