import type {
  Execution,
  ExecutionInspectionManager,
  ExecutionManager,
  ExecutionReplayManager,
  ReplayExecutionParams,
} from "@croco/execution-core";
import { ExecutionProblems } from "@croco/execution-core";
import { TaskRunner } from "@croco/tasks-core";
import { withSpan } from "@croco/telemetry-api";
import {
  WorkflowDefinitionProblem,
  WorkflowExecutionFailedProblem,
  WorkflowExecutionInProgressProblem,
  WorkflowNotFoundProblem,
  WorkflowReplayUnsupportedProblem,
} from "./problems/WorkflowProblems";
import { WorkflowRegistry } from "./WorkflowRegistry";
import type {
  TypedWorkflowReference,
  TypedWorkflowRunResult,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStepContext,
  WorkflowStepResult,
} from "./types";

type LoggableExecutionManager = ExecutionManager & Pick<ExecutionInspectionManager, "recordLog">;

type ReplayableExecutionManager = ExecutionManager & ExecutionReplayManager;

type TelemetryAttributeValue = string | number | boolean;

type WorkflowTelemetrySpan = {
  setAttribute(name: string, value: TelemetryAttributeValue): void;
  addEvent(name: string, attributes?: Record<string, TelemetryAttributeValue>): void;
};

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown error";
  }
}

function reportFailureRecordError(
  span: WorkflowTelemetrySpan,
  executionId: string,
  workflowError: unknown,
  failureRecordError: unknown,
): void {
  let attachmentFailed = false;
  if (typeof workflowError === "object" && workflowError !== null) {
    try {
      Object.defineProperty(workflowError, "workflowFailureRecordError", {
        configurable: true,
        enumerable: false,
        value: failureRecordError,
      });
    } catch {
      attachmentFailed = true;
    }
  }

  try {
    span.addEvent("workflow.execution.failure_record.failed", {
      "workflow.execution.id": executionId,
      "workflow.error.message": describeError(workflowError),
      "workflow.failure_record.error.message": describeError(failureRecordError),
      ...(attachmentFailed ? { "workflow.failure_record.attachment_failed": true } : {}),
    });
  } catch {
    return;
  }
}

function supportsRecordLog(manager: ExecutionManager): manager is LoggableExecutionManager {
  return typeof (manager as { recordLog?: unknown }).recordLog === "function";
}

function supportsReplay(manager: ExecutionManager): manager is ReplayableExecutionManager {
  return typeof (manager as { replay?: unknown }).replay === "function";
}

function createInvocationId(workflowName: string): string {
  return `${workflowName}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function createStepExecutionIdempotencyKey(
  workflowExecutionId: string,
  stepIndex: number,
  stepName: string,
): string {
  return `workflow-step:${workflowExecutionId}:${stepIndex}:${stepName}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function resolveExecutionIdempotency(
  workflowName: string,
  resolvedKey: string | undefined,
): Promise<{ idempotencyKey?: string; legacyIdempotencyKeys?: readonly string[] }> {
  if (resolvedKey === undefined) return {};

  const scope = JSON.stringify({
    workflowName,
    idempotencyKey: resolvedKey,
    version: 2,
  });
  const fingerprint = await sha256(scope);

  return {
    idempotencyKey: `workflow:v2:${fingerprint}`,
    legacyIdempotencyKeys: [resolvedKey],
  };
}

function toExecutionError(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    retryable: error instanceof Error && "retryable" in error ? Boolean(error.retryable) : false,
    code: error instanceof Error && "code" in error ? String(error.code) : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  };
}

function setWorkflowTelemetryAttributes(
  span: WorkflowTelemetrySpan,
  workflow: WorkflowDefinition,
): void {
  span.setAttribute("workflow.name", workflow.name);
  span.setAttribute("workflow.method", workflow.methodName);
  span.setAttribute("workflow.step.count", workflow.steps.length);
  span.setAttribute("workflow.trigger.count", workflow.triggers.length);

  const triggerTypes = workflow.triggers.map((trigger) => trigger.type).join(",");
  if (triggerTypes.length > 0) {
    span.setAttribute("workflow.trigger.types", triggerTypes);
  }
}

function getExecutionTelemetryAttributes(
  workflow: WorkflowDefinition,
  execution: Execution,
): Record<string, TelemetryAttributeValue> {
  return {
    "workflow.name": workflow.name,
    "workflow.execution.id": execution.id,
    "workflow.execution.status": execution.status,
    "workflow.execution.attempts": execution.attempts,
    "workflow.execution.max_attempts": execution.maxAttempts,
  };
}

export class WorkflowRunner {
  constructor(
    private readonly executionManager: ExecutionManager,
    private readonly registry: WorkflowRegistry = WorkflowRegistry.fromMetadata(),
    private readonly taskRunner: TaskRunner = new TaskRunner(
      executionManager,
      registry.taskRegistry,
    ),
  ) {}

  async execute<TPayload, TSteps extends readonly WorkflowStepResult[]>(
    workflow: TypedWorkflowReference<TPayload, TSteps>,
    payload: NoInfer<TPayload>,
  ): Promise<TypedWorkflowRunResult<TSteps>>;
  async execute(workflowName: string, payload: unknown): Promise<WorkflowRunResult>;
  async execute(
    workflowOrName: string | TypedWorkflowReference<unknown, readonly WorkflowStepResult[]>,
    payload: unknown,
  ): Promise<WorkflowRunResult> {
    const workflowName = typeof workflowOrName === "string" ? workflowOrName : workflowOrName.name;
    return withSpan(async (span) => this.executeWithTelemetry(workflowOrName, payload, span), {
      name: `workflow:${workflowName}`,
      attributes: {
        "workflow.name": workflowName,
      },
    });
  }

  private async executeWithTelemetry(
    workflowReference: string | TypedWorkflowReference<unknown, readonly WorkflowStepResult[]>,
    payload: unknown,
    span: WorkflowTelemetrySpan,
  ): Promise<WorkflowRunResult> {
    const workflow = this.getWorkflow(workflowReference);
    setWorkflowTelemetryAttributes(span, workflow);

    const workflowContractFingerprint =
      typeof workflowReference === "string"
        ? undefined
        : await this.createWorkflowContractFingerprint(workflow);

    const resolvedKey = this.resolveIdempotencyKey(workflow, payload);
    const idempotency = await resolveExecutionIdempotency(workflow.name, resolvedKey);
    const invocationId = idempotency.idempotencyKey ? createInvocationId(workflow.name) : undefined;
    const execution = await this.executionManager.create({
      type: "workflow",
      payload,
      maxAttempts: workflow.options.maxAttempts,
      timeout: workflow.options.timeout,
      idempotencyKey: idempotency.idempotencyKey,
      ...(idempotency.legacyIdempotencyKeys === undefined
        ? {}
        : { legacyIdempotencyKeys: idempotency.legacyIdempotencyKeys }),
      metadata: {
        workflowName: workflow.name,
        workflowMethod: workflow.methodName,
        workflowSteps: workflow.steps.map((step) => step.name),
        workflowTriggers: workflow.triggers.map((trigger) => trigger.type),
        ...(workflowContractFingerprint !== undefined ? { workflowContractFingerprint } : {}),
        ...(invocationId !== undefined ? { workflowInvocationId: invocationId } : {}),
      },
    });
    const executionAttributes = getExecutionTelemetryAttributes(workflow, execution);
    const canResumeRetryingExecution =
      execution.status === "retrying" && execution.metadata?.workflowName === workflow.name;
    if (
      canResumeRetryingExecution &&
      workflowContractFingerprint !== undefined &&
      execution.metadata?.workflowContractFingerprint !== workflowContractFingerprint
    ) {
      throw new WorkflowDefinitionProblem(
        workflow.name,
        `retrying execution '${execution.id}' has a different typed workflow contract`,
      );
    }
    span.setAttribute("workflow.execution.id", execution.id);
    span.setAttribute("workflow.idempotent", idempotency.idempotencyKey !== undefined);

    if (
      !canResumeRetryingExecution &&
      (execution.status !== "pending" ||
        (idempotency.idempotencyKey !== undefined &&
          execution.metadata?.workflowInvocationId !== invocationId))
    ) {
      if (execution.status === "pending" || execution.status === "running") {
        throw new WorkflowExecutionInProgressProblem(workflow.name, execution.id, execution.status);
      }
      if (
        (execution.status === "failed" || execution.status === "timed_out") &&
        execution.error !== undefined
      ) {
        throw new WorkflowExecutionFailedProblem(workflow.name, execution.id, execution.error);
      }
      if (execution.status !== "completed") {
        throw ExecutionProblems.invalidStateTransition(
          `Workflow '${workflow.name}' execution '${execution.id}' in '${execution.status}' status cannot be reused`,
        );
      }
      span.setAttribute("workflow.reused", true);
      span.addEvent("workflow.execution.reused", executionAttributes);
      return {
        executionId: execution.id,
        workflow,
        steps: [],
        result: execution.result,
        reused: true,
      };
    }

    span.addEvent("workflow.execution.created", executionAttributes);

    const running = await this.executionManager.start(execution.id);
    span.setAttribute("workflow.reused", false);
    span.addEvent("workflow.execution.started", getExecutionTelemetryAttributes(workflow, running));
    const steps: WorkflowStepResult[] = [];

    await this.recordLog(span, running.id, "info", "Workflow execution started", {
      workflowName: workflow.name,
    });

    try {
      for (const [stepIndex, step] of workflow.steps.entries()) {
        const stepAttributes = {
          "workflow.name": workflow.name,
          "workflow.execution.id": running.id,
          "workflow.step.name": step.name,
          "workflow.step.task": step.task,
        };
        span.addEvent("workflow.step.started", stepAttributes);
        await this.recordLog(span, running.id, "info", "Workflow step started", {
          step: step.name,
          task: step.task,
        });

        let result: unknown;
        try {
          result = await this.taskRunner.execute(
            step.task,
            this.resolveStepInput(workflow, running, payload, step, steps),
            {
              parentId: running.id,
              idempotencyKey: createStepExecutionIdempotencyKey(running.id, stepIndex, step.name),
              metadata: {
                workflowName: workflow.name,
                workflowExecutionId: running.id,
                workflowStep: step.name,
              },
            },
          );
        } catch (error) {
          span.addEvent("workflow.step.failed", {
            ...stepAttributes,
            "workflow.error.message": error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        span.addEvent("workflow.step.completed", stepAttributes);

        steps.push({
          step: step.name,
          task: step.task,
          result,
        });

        await this.recordLog(span, running.id, "info", "Workflow step completed", {
          step: step.name,
          task: step.task,
        });
      }

      const result = {
        workflowName: workflow.name,
        steps,
      };
      const completed = await this.executionManager.complete(running.id, result);
      span.addEvent(
        "workflow.execution.completed",
        getExecutionTelemetryAttributes(workflow, completed),
      );
      await this.recordLog(span, running.id, "info", "Workflow execution completed", {
        workflowName: workflow.name,
      });

      return {
        executionId: completed.id,
        workflow,
        steps,
        result,
        reused: false,
      };
    } catch (error) {
      await this.recordLog(span, running.id, "error", "Workflow execution failed", {
        workflowName: workflow.name,
        error: error instanceof Error ? error.message : String(error),
      });
      let failed: Execution;
      try {
        failed = await this.executionManager.fail(running.id, toExecutionError(error));
      } catch (failureRecordError) {
        reportFailureRecordError(span, running.id, error, failureRecordError);
        throw error;
      }
      span.addEvent("workflow.execution.failed", {
        ...getExecutionTelemetryAttributes(workflow, failed),
        "workflow.error.message": error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async cancel(executionId: string, reason?: string): Promise<Execution> {
    return this.executionManager.cancel(executionId, reason);
  }

  async replay(executionId: string, params?: ReplayExecutionParams): Promise<Execution> {
    if (!supportsReplay(this.executionManager)) {
      throw new WorkflowReplayUnsupportedProblem();
    }

    return this.executionManager.replay(executionId, params);
  }

  private getWorkflow(
    reference: string | TypedWorkflowReference<unknown, readonly WorkflowStepResult[]>,
  ): WorkflowDefinition {
    const name = typeof reference === "string" ? reference : reference.name;
    const workflow =
      typeof reference === "string"
        ? this.registry.get(reference)
        : this.registry.getByReference(reference);
    if (!workflow) {
      throw new WorkflowNotFoundProblem(name);
    }
    return workflow;
  }

  private resolveIdempotencyKey(
    workflow: WorkflowDefinition,
    payload: unknown,
  ): string | undefined {
    const resolver = workflow.options.idempotencyKey;

    if (typeof resolver === "function") {
      return resolver({ workflow, payload });
    }

    return resolver;
  }

  private async createWorkflowContractFingerprint(workflow: WorkflowDefinition): Promise<string> {
    const steps = workflow.steps.map((step) => {
      const task = this.registry.taskRegistry.get(step.task);
      if (task === undefined) {
        throw new WorkflowDefinitionProblem(
          workflow.name,
          `step '${step.name}' references unknown task '${step.task}'`,
        );
      }

      const target = task.target as { readonly prototype?: object };
      const prototype = target.prototype as Record<string, unknown> | undefined;
      const handler = prototype?.[task.methodName];
      if (typeof handler !== "function") {
        throw new WorkflowDefinitionProblem(
          workflow.name,
          `step '${step.name}' task '${step.task}' has no callable registered handler`,
        );
      }

      return {
        name: step.name,
        task: step.task,
        input: step.input !== undefined,
        options: {
          maxAttempts: task.metadata.options?.maxAttempts ?? null,
          timeout: task.metadata.options?.timeout ?? null,
          idempotencyKey: task.metadata.options?.idempotencyKey ?? null,
          timeoutRetry: task.metadata.options?.timeoutRetry ?? null,
        },
      };
    });
    const contract = JSON.stringify({
      version: 2,
      name: workflow.name,
      maxAttempts: workflow.options.maxAttempts ?? null,
      timeout: workflow.options.timeout ?? null,
      idempotencyResolver:
        typeof workflow.options.idempotencyKey === "function"
          ? { kind: "resolver" }
          : { kind: "static", key: workflow.options.idempotencyKey ?? null },
      steps,
    });

    return `workflow-contract:v2:${await sha256(contract)}`;
  }

  private resolveStepInput(
    workflow: WorkflowDefinition,
    workflowExecution: Execution,
    payload: unknown,
    step: WorkflowDefinition["steps"][number],
    previousResults: readonly WorkflowStepResult[],
  ): unknown {
    if (!step.input) {
      return payload;
    }

    const context: WorkflowStepContext = {
      workflow,
      workflowExecutionId: workflowExecution.id,
      payload,
      step,
      previousResults,
    };

    return step.input(context);
  }

  private async recordLog(
    span: WorkflowTelemetrySpan,
    executionId: string,
    level: "info" | "error",
    message: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!supportsRecordLog(this.executionManager)) {
      return;
    }

    try {
      await this.executionManager.recordLog(executionId, {
        level,
        message,
        data,
      });
    } catch (error) {
      span.addEvent("workflow.log.failed", {
        "workflow.execution.id": executionId,
        "workflow.log.level": level,
        "workflow.log.message": message,
        "workflow.error.message": error instanceof Error ? error.message : String(error),
      });
    }
  }
}
