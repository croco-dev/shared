import { Problem, ProblemCategory } from "@croco/problems-core";

export type ApplicationCleanupFailure = {
  readonly phase: "telemetry-force-flush" | "telemetry-shutdown" | "application-runtime-dispose";
  readonly cause: unknown;
};

export type ApplicationCleanupDiagnostic = {
  readonly phase: ApplicationCleanupFailure["phase"];
  readonly detail: string;
};

export class ApplicationCleanupProblem extends Problem {
  readonly code = "starter/application-cleanup-failed";
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

export class NodeHostLifecycleProblem extends Problem {
  readonly code = "starter/node-host-lifecycle-failed";
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

function describeFailure(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}
