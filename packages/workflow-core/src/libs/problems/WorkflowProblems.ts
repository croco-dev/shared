import type { ExecutionError } from "@croco/execution-core";
import { Problem, ProblemCategory } from "@croco/problems-core";
import type { SagaExecutionStatus, SagaFailure } from "../saga/types";

export class WorkflowNotFoundProblem extends Problem {
  readonly code = "workflow-core/workflow-not-found";
  readonly category = ProblemCategory.NotFound;

  constructor(workflowName: string) {
    super(undefined, undefined, `Workflow not found: '${workflowName}'`);
  }
}

export class DuplicateWorkflowRegistrationProblem extends Problem {
  constructor(workflowName: string) {
    super(
      "workflow-core/duplicate-workflow-registration",
      ProblemCategory.InternalServerError,
      `Workflow ${workflowName} is already registered`,
      {
        extensions: {
          workflowName,
          retryable: false,
        },
      },
    );
  }
}

export class WorkflowDefinitionProblem extends Problem {
  constructor(workflowName: string, message: string) {
    super(
      "workflow-core/workflow-definition-invalid",
      ProblemCategory.InternalServerError,
      `Workflow '${workflowName}' is invalid: ${message}`,
      {
        extensions: {
          workflowName,
          retryable: false,
        },
      },
    );
  }
}

export class WorkflowExecutionInProgressProblem extends Problem {
  constructor(workflowName: string, executionId: string, status: "pending" | "running") {
    super(
      "workflow-core/workflow-execution-in-progress",
      ProblemCategory.Conflict,
      `Workflow '${workflowName}' execution '${executionId}' is ${status}`,
      { extensions: { workflowName, executionId, workflowStatus: status, retryable: true } },
    );
  }
}

export class WorkflowExecutionFailedProblem extends Problem {
  readonly failure: ExecutionError;

  constructor(workflowName: string, executionId: string, failure: ExecutionError) {
    super(
      "workflow-core/workflow-execution-failed",
      ProblemCategory.InternalServerError,
      `Workflow '${workflowName}' execution '${executionId}' failed: ${failure.message}`,
      {
        extensions: {
          workflowName,
          executionId,
          ...(failure.code === undefined ? {} : { originalFailureCode: failure.code }),
          originalFailureMessage: failure.message,
          retryable: false,
        },
      },
    );
    this.failure = failure;
  }
}

export class WorkflowReplayUnsupportedProblem extends Problem {
  constructor() {
    super(
      "workflow-core/replay-unsupported",
      ProblemCategory.InternalServerError,
      "Execution manager does not support workflow replay",
      {
        extensions: {
          retryable: false,
        },
      },
    );
  }
}

export class SagaDefinitionProblem extends Problem {
  constructor(sagaName: string, message: string) {
    super(
      "workflow-core/saga-definition-invalid",
      ProblemCategory.InternalServerError,
      `Saga '${sagaName}' is invalid: ${message}`,
      {
        extensions: {
          sagaName,
          retryable: false,
        },
      },
    );
  }
}

export class SagaExecutionNotFoundProblem extends Problem {
  readonly code = "workflow-core/saga-execution-not-found";
  readonly category = ProblemCategory.NotFound;

  constructor(executionId: string) {
    super(undefined, undefined, `Saga execution not found: '${executionId}'`, {
      extensions: {
        executionId,
        retryable: false,
      },
    });
  }
}

export class SagaStoreConflictProblem extends Problem {
  constructor(executionId: string, message: string) {
    super("workflow-core/saga-store-conflict", ProblemCategory.Conflict, message, {
      extensions: {
        executionId,
        retryable: false,
      },
    });
  }
}

export class SagaListPaginationProblem extends Problem {
  constructor(field: "limit" | "offset", value: number) {
    const requirement = field === "limit" ? "a positive integer" : "a non-negative integer";
    super(
      "workflow-core/saga-list-pagination-invalid",
      ProblemCategory.BadRequest,
      `Saga list ${field} must be ${requirement}`,
      {
        extensions: {
          field,
          receivedValue: String(value),
          retryable: false,
        },
      },
    );
  }
}

export class SagaReplayProblem extends Problem {
  constructor(executionId: string, message: string) {
    super(
      "workflow-core/saga-replay-invalid",
      ProblemCategory.InternalServerError,
      `Saga execution '${executionId}' cannot be replayed: ${message}`,
      {
        extensions: {
          executionId,
          retryable: false,
        },
      },
    );
  }
}

export class SagaExecutionFailedProblem extends Problem {
  constructor(
    sagaName: string,
    executionId: string,
    failure: SagaFailure,
    options: {
      readonly status: SagaExecutionStatus;
      readonly compensationFailures: readonly SagaFailure[];
    },
  ) {
    super(
      "workflow-core/saga-execution-failed",
      ProblemCategory.InternalServerError,
      `Saga '${sagaName}' failed at execution '${executionId}': ${failure.message}`,
      {
        extensions: {
          sagaName,
          executionId,
          sagaStatus: options.status,
          ...(failure.code === undefined ? {} : { originalFailureCode: failure.code }),
          originalFailureMessage: failure.message,
          compensationFailureCount: options.compensationFailures.length,
          compensationFailures: options.compensationFailures.map((compensationFailure) => ({
            ...(compensationFailure.code === undefined ? {} : { code: compensationFailure.code }),
            message: compensationFailure.message,
            retryable: compensationFailure.retryable,
          })),
          retryable: failure.retryable,
        },
      },
    );
  }
}

export class SagaFinalizationProblem extends Problem {
  constructor(
    sagaName: string,
    executionId: string,
    failure: SagaFailure,
    options: {
      readonly status: SagaExecutionStatus;
    },
  ) {
    super(
      "workflow-core/saga-finalization-failed",
      ProblemCategory.InternalServerError,
      `Saga '${sagaName}' finished every step at execution '${executionId}' but could not persist the finalization status: ${failure.message}`,
      {
        extensions: {
          sagaName,
          executionId,
          sagaStatus: options.status,
          ...(failure.code === undefined ? {} : { originalFailureCode: failure.code }),
          originalFailureMessage: failure.message,
          retryable: true,
        },
      },
    );
  }
}

/**
 * Retry the same idempotency key after the owning execution finishes.
 * Abandoned executions require store-specific reconciliation.
 */
export class SagaExecutionInFlightProblem extends Problem {
  constructor(sagaName: string, executionId: string, status: "pending" | "running") {
    super(
      "workflow-core/saga-execution-in-flight",
      ProblemCategory.Conflict,
      `Saga '${sagaName}' is already in flight at execution '${executionId}' (${status})`,
      {
        extensions: {
          sagaName,
          executionId,
          sagaStatus: status,
          retryable: true,
        },
      },
    );
  }
}
