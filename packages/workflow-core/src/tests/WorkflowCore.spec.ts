import {
  type CreateExecutionParams,
  createExecutionJobsOperations,
  type Execution,
  type ExecutionAttemptStore,
  type ExecutionLogEntry,
  type ExecutionLogStore,
  type ExecutionManager,
  ExecutionManagerImpl,
  ExecutionProblems,
  ExecutionStore,
  type ListExecutionsOptions,
} from "@croco/execution-core";
import { Component, Container, MetadataStorage } from "@croco/framework-context";
import { Problem, ProblemCategory } from "@croco/problems-core";
import { Task, TaskRegistry, taskRef } from "@croco/tasks-core";
import { Cron, OnWebhook } from "@croco/triggers-core";
import type { SpanOptions as OtelSpanOptions, Span, Tracer } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Workflow } from "../libs/decorators/Workflow";
import { defineWorkflow } from "../libs/defineWorkflow";
import { WorkflowDiagnosticsProvider } from "../libs/diagnostics/WorkflowDiagnosticsProvider";
import type { WorkflowStepResult } from "../libs/types";
import { WorkflowRegistry } from "../libs/WorkflowRegistry";
import { WorkflowRunner } from "../libs/WorkflowRunner";

class TestWorkflowProblem extends Problem {
  constructor(detail: string) {
    super("workflow-core/test-problem", ProblemCategory.InternalServerError, detail);
  }
}

class InMemoryExecutionStore
  extends ExecutionStore
  implements ExecutionLogStore, ExecutionAttemptStore
{
  private readonly executions = new Map<string, Execution>();
  private idCounter = 0;

  async create(params: CreateExecutionParams): Promise<Execution> {
    if (params.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(params.idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    const execution: Execution = {
      id: `exec-${++this.idCounter}`,
      type: params.type,
      status: "pending",
      payload: params.payload,
      maxAttempts: params.maxAttempts ?? 1,
      timeout: params.timeout,
      scheduledFor: params.scheduledFor,
      idempotencyKey: params.idempotencyKey,
      replayOf: params.replayOf,
      logs: params.logs,
      parentId: params.parentId,
      metadata: params.metadata,
      attempts: 0,
      createdAt: new Date(),
    };

    this.executions.set(execution.id, execution);
    return execution;
  }

  async findById(id: string): Promise<Execution | null> {
    return this.executions.get(id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<Execution | null> {
    for (const execution of this.executions.values()) {
      if (execution.idempotencyKey === key) {
        return execution;
      }
    }
    return null;
  }

  async update(id: string, data: Partial<Execution>): Promise<Execution> {
    const existing = this.executions.get(id);
    if (!existing) {
      throw ExecutionProblems.notFound(`Execution with id '${id}' not found`);
    }

    const updated = { ...existing, ...data };
    this.executions.set(id, updated);
    return updated;
  }

  async mergeCheckpoint(id: string, key: string, value: unknown): Promise<Execution> {
    const execution = this.executions.get(id);
    if (!execution) {
      throw ExecutionProblems.notFound(`Execution with id '${id}' not found`);
    }
    return this.update(id, {
      checkpoints: { ...execution.checkpoints, [key]: value },
    });
  }

  async updateIfStatus(
    id: string,
    expectedStatus: Execution["status"],
    data: Partial<Execution>,
  ): Promise<Execution | null> {
    const existing = this.executions.get(id);
    return existing?.status === expectedStatus ? this.update(id, data) : null;
  }

  async updateIfStatusAndAttempt(
    id: string,
    expectedStatus: Execution["status"],
    expectedAttempt: number,
    data: Partial<Execution>,
  ): Promise<Execution | null> {
    const existing = this.executions.get(id);
    return existing?.status === expectedStatus && existing.attempts === expectedAttempt
      ? this.update(id, data)
      : null;
  }

  async mergeCheckpointIfStatusAndAttempt(
    id: string,
    expectedStatus: Execution["status"],
    expectedAttempt: number,
    key: string,
    value: unknown,
  ): Promise<Execution | null> {
    const existing = this.executions.get(id);
    return existing?.status === expectedStatus && existing.attempts === expectedAttempt
      ? this.mergeCheckpoint(id, key, value)
      : null;
  }

  async appendLogIfStatusAndAttempt(
    id: string,
    expectedStatus: Execution["status"],
    expectedAttempt: number,
    entry: ExecutionLogEntry,
  ): Promise<Execution | null> {
    const existing = this.executions.get(id);
    return existing?.status === expectedStatus && existing.attempts === expectedAttempt
      ? this.appendLog(id, entry)
      : null;
  }

  async listRunning(options: { afterId?: string; limit: number }): Promise<Execution[]> {
    return [...this.executions.values()]
      .filter(
        (execution) =>
          execution.status === "running" &&
          (options.afterId === undefined || execution.id > options.afterId),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, options.limit);
  }

  async appendLog(id: string, entry: ExecutionLogEntry): Promise<Execution> {
    const existing = this.executions.get(id);
    if (!existing) {
      throw ExecutionProblems.notFound(`Execution with id '${id}' not found`);
    }

    return this.update(id, {
      logs: [...(existing.logs ?? []), entry],
    });
  }

  async list(options: ListExecutionsOptions = {}): Promise<Execution[]> {
    let executions = Array.from(this.executions.values());

    if (options.status) {
      executions = executions.filter((execution) => execution.status === options.status);
    }

    if (options.type) {
      executions = executions.filter((execution) => execution.type === options.type);
    }

    if (options.parentId !== undefined) {
      executions = executions.filter((execution) => execution.parentId === options.parentId);
    }

    if (options.replayOf !== undefined) {
      executions = executions.filter((execution) => execution.replayOf === options.replayOf);
    }

    const offset = options.offset ?? 0;
    return executions.slice(offset, options.limit ? offset + options.limit : undefined);
  }

  async delete(id: string): Promise<void> {
    this.executions.delete(id);
  }
}

function getSubscriptionId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("subscriptionId" in payload)) {
    throw new TestWorkflowProblem("subscriptionId is required");
  }

  return String(payload.subscriptionId);
}

function getSharedId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("id" in payload)) {
    throw new TestWorkflowProblem("id is required");
  }

  return String(payload.id);
}

async function waitForWorkflowExecution(manager: ExecutionManagerImpl): Promise<Execution> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [execution] = await manager.list({ type: "workflow" });
    if (execution?.status === "running") {
      return execution;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new TestWorkflowProblem("workflow execution was not started");
}

function createMockSpan() {
  const addEvent = vi.fn();
  const end = vi.fn();
  const recordException = vi.fn();
  const setAttribute = vi.fn();
  const setStatus = vi.fn();

  const span: Span = {
    spanContext: () => ({
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      traceFlags: 1,
      isRemote: false,
    }),
    setAttribute,
    setAttributes: vi.fn(),
    addEvent,
    addLink: vi.fn(),
    addLinks: vi.fn(),
    setStatus,
    updateName: vi.fn(),
    end,
    isRecording: vi.fn(() => true),
    recordException,
  } as unknown as Span;

  return {
    addEvent,
    end,
    recordException,
    setAttribute,
    setStatus,
    span,
  };
}

function createMockTracer(mockSpan: Span): Tracer {
  return {
    startSpan: () => mockSpan,
    startActiveSpan: async <T>(_name: string, fn: (span: Span) => T, _options?: OtelSpanOptions) =>
      fn(mockSpan),
  } as Tracer;
}

describe("workflow-core", () => {
  let store!: InMemoryExecutionStore;
  let manager!: ExecutionManagerImpl;

  beforeEach(() => {
    vi.restoreAllMocks();
    Container.reset();
    MetadataStorage.clear();
    TaskRegistry.getInstance().reset();
    store = new InMemoryExecutionStore();
    manager = new ExecutionManagerImpl(store);
  });

  it("collects workflow definitions with cron and webhook trigger metadata", () => {
    @Component()
    class BillingTasks {
      @Task({ name: "billing.refresh" })
      refresh(): void {}
    }

    @Component()
    class BillingWorkflows {
      @Cron("0 * * * *", { name: "hourly-billing-sync" })
      @Workflow({
        name: "billing-sync",
        steps: ["billing.refresh"],
        maxAttempts: 2,
        timeout: 30_000,
      })
      scheduledSync(): void {}

      @OnWebhook("/webhooks/billing", "POST", { auth: true })
      @Workflow({
        name: "billing-webhook",
        steps: ["billing.refresh"],
      })
      billingWebhook(): void {}
    }

    @Component()
    class StaticBillingWorkflows {
      @Workflow({
        steps: ["billing.refresh"],
      })
      static staticSync(): void {}
    }

    Container.set(BillingTasks, new BillingTasks());
    Container.set(BillingWorkflows, new BillingWorkflows());
    const registry = WorkflowRegistry.fromMetadata();

    const scheduled = registry.get("billing-sync");
    const webhook = registry.get("billing-webhook");

    expect(scheduled?.triggers).toEqual([
      expect.objectContaining({ type: "cron", expression: "0 * * * *" }),
    ]);
    expect(webhook?.triggers).toEqual([
      expect.objectContaining({
        type: "webhook",
        path: "/webhooks/billing",
        method: "POST",
      }),
    ]);
    expect(scheduled?.steps).toEqual([{ name: "billing.refresh", task: "billing.refresh" }]);
    expect(registry.get("StaticBillingWorkflows.staticSync")).toEqual(
      expect.objectContaining({
        name: "StaticBillingWorkflows.staticSync",
      }),
    );
  });

  it("executes typed task references while keeping normalized workflow steps name-only", async () => {
    type BillingPayload = { readonly subscriptionId: string };

    @Component()
    class TypedBillingTasks {
      @Task({ name: "billing.typed-fetch" })
      fetch(payload: BillingPayload): { readonly subscriptionId: string; readonly plan: string } {
        return { subscriptionId: payload.subscriptionId, plan: "pro" };
      }

      @Task({ name: "billing.typed-sync" })
      sync(payload: { readonly subscriptionId: string; readonly plan: string }): {
        readonly synchronized: string;
      } {
        return { synchronized: payload.subscriptionId };
      }
    }

    const fetchTask = taskRef(TypedBillingTasks, "fetch", "billing.typed-fetch");
    const syncTask = taskRef(TypedBillingTasks, "sync", "billing.typed-sync");
    const definition = defineWorkflow<BillingPayload>({
      name: "billing-typed",
      idempotencyKey: ({ payload }) => `billing-typed:${payload.subscriptionId}`,
    })
      .step(fetchTask)
      .step("sync-entitlements", syncTask, ({ previousResults }) => previousResults[0].result)
      .build();

    @Component()
    class TypedBillingWorkflows {
      @Workflow(definition)
      synchronize(): void {}
    }

    Container.set(TypedBillingTasks, new TypedBillingTasks());
    Container.set(TypedBillingWorkflows, new TypedBillingWorkflows());
    const registry = WorkflowRegistry.fromMetadata();
    const runner = new WorkflowRunner(manager, registry);

    expect(registry.get(definition.name)?.steps).toEqual([
      { name: "billing.typed-fetch", task: "billing.typed-fetch" },
      {
        name: "sync-entitlements",
        task: "billing.typed-sync",
        input: expect.any(Function),
      },
    ]);

    const result = await runner.execute(definition, { subscriptionId: "sub_123" });

    expect(result).toEqual(
      expect.objectContaining({
        reused: false,
        steps: [
          {
            step: "billing.typed-fetch",
            task: "billing.typed-fetch",
            result: { subscriptionId: "sub_123", plan: "pro" },
          },
          {
            step: "sync-entitlements",
            task: "billing.typed-sync",
            result: { synchronized: "sub_123" },
          },
        ],
        result: {
          workflowName: "billing-typed",
          steps: [
            expect.objectContaining({ task: "billing.typed-fetch" }),
            expect.objectContaining({ task: "billing.typed-sync" }),
          ],
        },
      }),
    );

    const reused = await runner.execute(definition, { subscriptionId: "sub_123" });

    expect(reused).toEqual(
      expect.objectContaining({
        executionId: result.executionId,
        reused: true,
        steps: [],
        result: result.result,
      }),
    );

    const conflictingDefinition = defineWorkflow<BillingPayload>({ name: "billing-typed" })
      .step(fetchTask)
      .build();

    await expect(
      runner.execute(conflictingDefinition, { subscriptionId: "sub_123" }),
    ).rejects.toThrow("typed workflow reference does not match the registered definition");
  });

  it("resumes persisted typed step results after equivalent deployment source changes", async () => {
    type BillingPayload = { readonly subscriptionId: string };
    let syncAttempts = 0;

    class RetryableTypedSyncProblem extends Problem {
      readonly retryable = true;

      constructor() {
        super(
          "workflow-core/test-retryable-typed-sync",
          ProblemCategory.InternalServerError,
          "typed sync retryable outage",
        );
      }
    }

    @Component()
    class TypedRetryTasks {
      @Task({ name: "billing.typed-retry-fetch" })
      fetch(payload: BillingPayload): { readonly subscriptionId: string; readonly plan: string } {
        return { subscriptionId: payload.subscriptionId, plan: "pro" };
      }

      @Task({ name: "billing.typed-retry-sync", maxAttempts: 2 })
      sync(payload: { readonly subscriptionId: string; readonly plan: string }): {
        readonly synchronized: string;
      } {
        syncAttempts += 1;
        if (syncAttempts === 1) {
          throw new RetryableTypedSyncProblem();
        }
        return { synchronized: payload.subscriptionId };
      }
    }

    const fetchTask = taskRef(TypedRetryTasks, "fetch", "billing.typed-retry-fetch");
    const syncTask = taskRef(TypedRetryTasks, "sync", "billing.typed-retry-sync");
    const definition = defineWorkflow<BillingPayload>({
      name: "billing-typed-retry",
      maxAttempts: 2,
      idempotencyKey: ({ payload }) => `billing-typed-retry:${payload.subscriptionId}`,
    })
      .step(fetchTask)
      .step(syncTask, ({ previousResults }) => previousResults[0].result)
      .build();

    @Component()
    class TypedRetryWorkflows {
      @Workflow(definition)
      synchronize(): void {}
    }

    Container.set(TypedRetryTasks, new TypedRetryTasks());
    Container.set(TypedRetryWorkflows, new TypedRetryWorkflows());
    const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

    await expect(runner.execute(definition, { subscriptionId: "sub_123" })).rejects.toThrow(
      "typed sync retryable outage",
    );

    Container.reset();
    MetadataStorage.clear();
    TaskRegistry.getInstance().reset();
    const redeployedFetch = vi.fn();

    @Component()
    class MinifiedTasks {
      @Task({ name: "billing.typed-retry-fetch" })
      a(input: BillingPayload): { readonly subscriptionId: string; readonly plan: string } {
        redeployedFetch();
        const { subscriptionId } = input;
        return { plan: "pro", subscriptionId };
      }

      @Task({ name: "billing.typed-retry-sync", maxAttempts: 2 })
      b(input: { readonly subscriptionId: string; readonly plan: string }): {
        readonly synchronized: string;
      } {
        syncAttempts++;
        const synchronized = input.subscriptionId;
        return { synchronized };
      }
    }

    const redeployedDefinition = defineWorkflow<BillingPayload>({
      name: "billing-typed-retry",
      maxAttempts: 2,
      idempotencyKey: function resolveKey(context) {
        return "billing-typed-retry:" + context.payload.subscriptionId;
      },
    })
      .step(taskRef(MinifiedTasks, "a", "billing.typed-retry-fetch"))
      .step(
        taskRef(MinifiedTasks, "b", "billing.typed-retry-sync"),
        function resolveInput(context) {
          const [completed] = context.previousResults;
          return completed.result;
        },
      )
      .build();

    @Component()
    class MinifiedWorkflows {
      @Workflow(redeployedDefinition)
      c(): void {}
    }

    Container.set(MinifiedTasks, new MinifiedTasks());
    Container.set(MinifiedWorkflows, new MinifiedWorkflows());
    const redeployedRunner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());
    const retried = await redeployedRunner.execute(redeployedDefinition, {
      subscriptionId: "sub_123",
    });
    expect(redeployedFetch).not.toHaveBeenCalled();
    expect(syncAttempts).toBe(2);
    const [workflowExecution] = await manager.list({ type: "workflow" });

    expect(retried).toEqual(
      expect.objectContaining({
        executionId: workflowExecution.id,
        reused: false,
        steps: [
          expect.objectContaining({ result: { subscriptionId: "sub_123", plan: "pro" } }),
          expect.objectContaining({ result: { synchronized: "sub_123" } }),
        ],
      }),
    );
    expect(workflowExecution).toEqual(
      expect.objectContaining({
        status: "completed",
        attempts: 2,
        metadata: expect.objectContaining({
          workflowContractFingerprint: expect.stringMatching(/^workflow-contract:v2:[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it.each([
    "step addition",
    "step removal",
    "step rename",
    "step reorder",
    "task replacement",
    "input resolver presence",
    "task options",
    "workflow options",
    "idempotency resolver kind",
    "legacy v1 fingerprint",
  ])("rejects persisted typed contract drift for %s before starting attempts", async (change) => {
    const fetch = vi.fn((payload: number) => payload + 1);
    const synchronize = vi.fn(() => {
      throw new RetryableStructuralProblem();
    });

    class RetryableStructuralProblem extends Problem {
      readonly retryable = true;

      constructor() {
        super(
          "workflow-core/test-retryable-structural",
          ProblemCategory.InternalServerError,
          "structural retry outage",
        );
      }
    }

    @Component()
    class StructuralTasks {
      @Task({ name: "structural.fetch" })
      fetch(payload: number): number {
        return fetch(payload);
      }

      @Task({ name: "structural.sync", maxAttempts: 2 })
      sync(): number {
        return synchronize();
      }

      @Task({ name: "structural.replacement" })
      replacement(payload: number): number {
        return payload;
      }
    }

    const fetchTask = taskRef(StructuralTasks, "fetch", "structural.fetch");
    const syncTask = taskRef(StructuralTasks, "sync", "structural.sync");
    const replacementTask = taskRef(StructuralTasks, "replacement", "structural.replacement");
    const options = {
      name: "structural-retry",
      maxAttempts: 2,
      idempotencyKey: "structural-retry-key",
    };
    const original = defineWorkflow<number>(options)
      .step("fetch", fetchTask)
      .step("sync", syncTask)
      .build();

    @Component()
    class StructuralWorkflows {
      @Workflow(original)
      run(): void {}
    }

    Container.set(StructuralTasks, new StructuralTasks());
    Container.set(StructuralWorkflows, new StructuralWorkflows());
    const originalRegistry = WorkflowRegistry.fromMetadata();
    const originalRunner = new WorkflowRunner(manager, originalRegistry);
    await expect(originalRunner.execute(original, 1)).rejects.toThrow("structural retry outage");
    const [execution] = await manager.list({ type: "workflow" });
    const priorChildren = await manager.list({ parentId: execution.id });

    const nextOptions = {
      ...options,
      ...(change === "workflow options" ? { maxAttempts: 3 } : {}),
      ...(change === "idempotency resolver kind"
        ? { idempotencyKey: () => "structural-retry-key" }
        : {}),
    };
    const builder = defineWorkflow<number>(nextOptions);
    const changed = (() => {
      switch (change) {
        case "step addition":
          return builder
            .step("fetch", fetchTask)
            .step("sync", syncTask)
            .step("added", fetchTask)
            .build();
        case "step removal":
          return builder.step("fetch", fetchTask).build();
        case "step rename":
          return builder.step("renamed", fetchTask).step("sync", syncTask).build();
        case "step reorder":
          return builder.step("sync", syncTask).step("fetch", fetchTask).build();
        case "task replacement":
          return builder.step("fetch", replacementTask).step("sync", syncTask).build();
        case "input resolver presence":
          return builder
            .step("fetch", fetchTask, ({ payload }) => payload)
            .step("sync", syncTask)
            .build();
        default:
          return builder.step("fetch", fetchTask).step("sync", syncTask).build();
      }
    })();

    MetadataStorage.clear();
    @Component()
    class RedeployedStructuralWorkflows {
      @Workflow(changed)
      run(): void {}
    }
    Container.set(RedeployedStructuralWorkflows, new RedeployedStructuralWorkflows());
    const freshTasks = new TaskRegistry(
      originalRegistry.taskRegistry.getAll().map((task) =>
        change === "task options" && task.name === "structural.sync"
          ? {
              ...task,
              metadata: {
                ...task.metadata,
                options: { ...task.metadata.options, maxAttempts: 3 },
              },
            }
          : task,
      ),
    );
    const freshRegistry = WorkflowRegistry.fromMetadata({ taskRegistry: freshTasks });
    const freshRunner = new WorkflowRunner(manager, freshRegistry);
    if (change === "legacy v1 fingerprint") {
      await store.update(execution.id, {
        metadata: {
          ...execution.metadata,
          workflowContractFingerprint: `workflow-contract:v1:${"0".repeat(64)}`,
        },
      });
    }
    const start = vi.spyOn(manager, "start");
    await expect(
      freshRunner.execute<number, readonly WorkflowStepResult[]>(changed, 1),
    ).rejects.toThrow("has a different typed workflow contract");
    expect(start).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(await manager.get(execution.id)).toEqual(
      expect.objectContaining({ status: "retrying", attempts: 1 }),
    );
    expect(await manager.list({ parentId: execution.id })).toEqual(priorChildren);
  });

  it("rejects typed task references that do not match the registered handler", () => {
    type BillingPayload = { readonly subscriptionId: string };

    @Component()
    class RegisteredBillingTasks {
      @Task({ name: "billing.registered" })
      synchronize(payload: BillingPayload): { readonly synchronized: string } {
        return { synchronized: payload.subscriptionId };
      }
    }

    class ClaimedBillingTasks {
      synchronize(payload: BillingPayload): { readonly claimed: string } {
        return { claimed: payload.subscriptionId };
      }
    }

    const mismatchedTask = taskRef(ClaimedBillingTasks, "synchronize", "billing.registered");
    const definition = defineWorkflow<BillingPayload>({ name: "billing-mismatched-task" })
      .step(mismatchedTask)
      .build();

    @Component()
    class MismatchedBillingWorkflows {
      @Workflow(definition)
      synchronize(): void {}
    }

    Container.set(RegisteredBillingTasks, new RegisteredBillingTasks());
    Container.set(MismatchedBillingWorkflows, new MismatchedBillingWorkflows());

    expect(() => WorkflowRegistry.fromMetadata()).toThrow(
      "task reference 'billing.registered' does not match the registered handler",
    );
  });

  it("runs a scheduled workflow as a parent execution with child task executions", async () => {
    @Component()
    class BillingTasks {
      @Task({
        name: "billing.fetch-subscription",
        maxAttempts: 2,
        timeout: 10_000,
      })
      fetchSubscription(payload: unknown): {
        subscriptionId: string;
        plan: string;
      } {
        return { subscriptionId: getSubscriptionId(payload), plan: "pro" };
      }

      @Task({ name: "billing.sync-entitlements" })
      syncEntitlements(payload: unknown): { synced: string } {
        return { synced: getSubscriptionId(payload) };
      }
    }

    @Component()
    class BillingWorkflows {
      @Cron("*/15 * * * *", { name: "billing-sync" })
      @Workflow({
        name: "billing-sync",
        steps: [
          "billing.fetch-subscription",
          {
            name: "sync-entitlements",
            task: "billing.sync-entitlements",
            input: ({ previousResults }) => previousResults[0]?.result,
          },
        ],
        maxAttempts: 2,
        timeout: 60_000,
      })
      scheduledSync(): void {}
    }

    Container.set(BillingTasks, new BillingTasks());
    Container.set(BillingWorkflows, new BillingWorkflows());
    const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

    const result = await runner.execute("billing-sync", {
      subscriptionId: "sub_123",
    });
    const workflowExecution = await manager.get(result.executionId);
    const childExecutions = await manager.list({
      parentId: result.executionId,
    });

    expect(result.reused).toBe(false);
    expect(workflowExecution).toEqual(
      expect.objectContaining({
        type: "workflow",
        status: "completed",
        maxAttempts: 2,
        timeout: 60_000,
        metadata: expect.objectContaining({
          workflowName: "billing-sync",
          workflowSteps: ["billing.fetch-subscription", "sync-entitlements"],
          workflowTriggers: ["cron"],
        }),
      }),
    );
    expect(workflowExecution.logs?.map((entry) => entry.message)).toEqual([
      "Workflow execution started",
      "Workflow step started",
      "Workflow step completed",
      "Workflow step started",
      "Workflow step completed",
      "Workflow execution completed",
    ]);
    expect(childExecutions).toEqual([
      expect.objectContaining({
        type: "billing.fetch-subscription",
        parentId: result.executionId,
        status: "completed",
        maxAttempts: 2,
        timeout: 10_000,
        idempotencyKey: expect.stringMatching(/^task:v2:[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        type: "billing.sync-entitlements",
        parentId: result.executionId,
        status: "completed",
        idempotencyKey: expect.stringMatching(/^task:v2:[a-f0-9]{64}$/),
        metadata: expect.objectContaining({
          workflowName: "billing-sync",
          workflowExecutionId: result.executionId,
          workflowStep: "sync-entitlements",
        }),
      }),
    ]);
  });

  it("does not collapse repeated workflow steps with the same step name", async () => {
    let handledCount = 0;

    @Component()
    class RepeatedStepTasks {
      @Task({ name: "billing.repeat-step" })
      handle(): { attempt: number } {
        handledCount += 1;
        return { attempt: handledCount };
      }
    }

    @Component()
    class RepeatedStepWorkflows {
      @Workflow({
        name: "billing-repeat-steps",
        steps: ["billing.repeat-step", "billing.repeat-step"],
      })
      repeat(): void {}
    }

    Container.set(RepeatedStepTasks, new RepeatedStepTasks());
    Container.set(RepeatedStepWorkflows, new RepeatedStepWorkflows());
    const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

    const result = await runner.execute("billing-repeat-steps", {});
    const childExecutions = await manager.list({
      parentId: result.executionId,
    });

    expect(handledCount).toBe(2);
    expect(result.steps).toEqual([
      expect.objectContaining({
        step: "billing.repeat-step",
        task: "billing.repeat-step",
        result: { attempt: 1 },
      }),
      expect.objectContaining({
        step: "billing.repeat-step",
        task: "billing.repeat-step",
        result: { attempt: 2 },
      }),
    ]);
    expect(childExecutions).toEqual([
      expect.objectContaining({
        type: "billing.repeat-step",
        status: "completed",
        idempotencyKey: expect.stringMatching(/^task:v2:[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        type: "billing.repeat-step",
        status: "completed",
        idempotencyKey: expect.stringMatching(/^task:v2:[a-f0-9]{64}$/),
      }),
    ]);
    expect(childExecutions[0].idempotencyKey).not.toBe(childExecutions[1].idempotencyKey);
  });

  it("deduplicates idempotent webhook workflows without re-running child tasks", async () => {
    const handledSubscriptions: string[] = [];

    @Component()
    class WebhookTasks {
      @Task({ name: "billing.handle-webhook" })
      handleWebhook(payload: unknown): { handled: string } {
        const subscriptionId = getSubscriptionId(payload);
        handledSubscriptions.push(subscriptionId);
        return { handled: subscriptionId };
      }
    }

    @Component()
    class WebhookWorkflows {
      @OnWebhook("/webhooks/billing", "POST", { auth: true })
      @Workflow({
        name: "billing-webhook",
        steps: ["billing.handle-webhook"],
        idempotencyKey: ({ payload }) => `billing-webhook:${getSubscriptionId(payload)}`,
      })
      webhook(): void {}
    }

    Container.set(WebhookTasks, new WebhookTasks());
    Container.set(WebhookWorkflows, new WebhookWorkflows());
    const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

    const first = await runner.execute("billing-webhook", {
      subscriptionId: "sub_123",
    });
    const second = await runner.execute("billing-webhook", {
      subscriptionId: "sub_123",
    });
    const allExecutions = await manager.list();

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.executionId).toBe(first.executionId);
    expect(handledSubscriptions).toEqual(["sub_123"]);
    expect(allExecutions).toHaveLength(2);
  });

  it.each([
    ["pending", "workflow-core/workflow-execution-in-progress", true, true],
    ["running", "workflow-core/workflow-execution-in-progress", true, true],
    ["failed", "workflow-core/workflow-execution-failed", true, true],
    ["timed_out", "workflow-core/workflow-execution-failed", true, true],
    ["cancelled", "execution/invalid-state-transition", true, true],
    ["failed", "execution/invalid-state-transition", false, true],
    ["timed_out", "execution/invalid-state-transition", false, true],
    ["running", "workflow-core/workflow-execution-in-progress", true, false],
    ["failed", "workflow-core/workflow-execution-failed", true, false],
    ["cancelled", "execution/invalid-state-transition", true, false],
  ] as const)(
    "rejects reuse of a stored %s workflow without mutation",
    async (status, code, hasFailure, idempotent) => {
      @Component()
      class WebhookTasks {
        @Task({ name: "billing.pending-webhook" })
        handleWebhook(): void {}
      }

      @Component()
      class WebhookWorkflows {
        @OnWebhook("/webhooks/billing", "POST", { auth: true })
        @Workflow({
          name: "billing-pending-webhook",
          steps: ["billing.pending-webhook"],
          idempotencyKey: idempotent
            ? ({ payload }) => `billing-webhook:${getSubscriptionId(payload)}`
            : undefined,
        })
        webhook(): void {}
      }

      Container.set(WebhookTasks, new WebhookTasks());
      Container.set(WebhookWorkflows, new WebhookWorkflows());

      const existingExecution: Execution = {
        id: "workflow-existing",
        type: "workflow",
        status,
        error: hasFailure
          ? {
              message: "provider failed",
              code: "provider/failure",
              retryable: true,
              stack: "stored stack",
            }
          : undefined,
        payload: { subscriptionId: "sub_123" },
        attempts: 0,
        maxAttempts: 1,
        createdAt: new Date(),
        idempotencyKey: "billing-webhook:sub_123",
        metadata: {
          workflowName: "billing-pending-webhook",
          workflowInvocationId: "existing-invocation",
        },
      };
      const executionManager = {
        create: vi.fn().mockResolvedValue(existingExecution),
        start: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        cancel: vi.fn(),
        retry: vi.fn(),
        updateProgress: vi.fn(),
        checkpoint: vi.fn(),
        timeout: vi.fn(),
      } as unknown as ExecutionManager;
      const runner = new WorkflowRunner(executionManager, WorkflowRegistry.fromMetadata());

      const mockSpan = createMockSpan();
      vi.spyOn(trace, "getTracer").mockReturnValue(createMockTracer(mockSpan.span));
      await expect(
        runner.execute("billing-pending-webhook", {
          subscriptionId: "sub_123",
        }),
      ).rejects.toMatchObject({
        code,
        ...(code === "workflow-core/workflow-execution-failed"
          ? {
              failure: existingExecution.error,
              extensions: {
                originalFailureCode: "provider/failure",
                originalFailureMessage: "provider failed",
                retryable: false,
              },
            }
          : {}),
      });
      expect(executionManager.start).not.toHaveBeenCalled();
      expect(executionManager.complete).not.toHaveBeenCalled();
      expect(executionManager.fail).not.toHaveBeenCalled();
      expect(mockSpan.setAttribute).not.toHaveBeenCalledWith("workflow.reused", true);
      expect(mockSpan.addEvent).not.toHaveBeenCalledWith(
        "workflow.execution.reused",
        expect.anything(),
      );
    },
  );

  it("does not duplicate child tasks for a running idempotent workflow", async () => {
    let releaseTask!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const handledSubscriptions: string[] = [];

    @Component()
    class WebhookTasks {
      @Task({ name: "billing.slow-webhook" })
      async handleWebhook(payload: unknown): Promise<{ handled: string }> {
        const subscriptionId = getSubscriptionId(payload);
        handledSubscriptions.push(subscriptionId);
        await taskGate;
        return { handled: subscriptionId };
      }
    }

    @Component()
    class WebhookWorkflows {
      @OnWebhook("/webhooks/billing", "POST", { auth: true })
      @Workflow({
        name: "billing-slow-webhook",
        steps: ["billing.slow-webhook"],
        idempotencyKey: ({ payload }) => `billing-webhook:${getSubscriptionId(payload)}`,
      })
      webhook(): void {}
    }

    Container.set(WebhookTasks, new WebhookTasks());
    Container.set(WebhookWorkflows, new WebhookWorkflows());
    const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

    const first = runner.execute("billing-slow-webhook", {
      subscriptionId: "sub_123",
    });
    const started = await waitForWorkflowExecution(manager);
    try {
      await expect(
        runner.execute("billing-slow-webhook", {
          subscriptionId: "sub_123",
        }),
      ).rejects.toMatchObject({ code: "workflow-core/workflow-execution-in-progress" });
    } finally {
      releaseTask();
      await first;
    }
    const allExecutions = await manager.list();
    expect(started.status).toBe("running");
    expect(handledSubscriptions).toEqual(["sub_123"]);
    expect(allExecutions).toHaveLength(2);
  });

  it("re-enters an idempotent workflow when the existing execution is retrying", async () => {
    let attempts = 0;
    const handledSubscriptions: string[] = [];

    class RetryableBillingProviderProblem extends Problem {
      readonly retryable = true;

      constructor() {
        super(
          "workflow-core/test-retryable-billing-provider",
          ProblemCategory.InternalServerError,
          "billing provider retryable outage",
        );
      }
    }

    @Component()
    class WebhookTasks {
      @Task({ name: "billing.retry-webhook", maxAttempts: 2 })
      handleWebhook(payload: unknown): { handled: string; attempt: number } {
        attempts += 1;
        const subscriptionId = getSubscriptionId(payload);
        handledSubscriptions.push(`${subscriptionId}:${attempts}`);

        if (attempts === 1) {
          throw new RetryableBillingProviderProblem();
        }

        return { handled: subscriptionId, attempt: attempts };
      }
    }

    @Component()
    class WebhookWorkflows {
      @OnWebhook("/webhooks/billing", "POST", { auth: true })
      @Workflow({
        name: "billing-retry-webhook",
        steps: ["billing.retry-webhook"],
        maxAttempts: 2,
        idempotencyKey: ({ payload }) => `billing-webhook:${getSubscriptionId(payload)}`,
      })
      webhook(): void {}
    }

    Container.set(WebhookTasks, new WebhookTasks());
    Container.set(WebhookWorkflows, new WebhookWorkflows());
    const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

    await expect(
      runner.execute("billing-retry-webhook", { subscriptionId: "sub_123" }),
    ).rejects.toThrow("billing provider retryable outage");

    const [retryingWorkflow] = await manager.list({ type: "workflow" });
    const retryingChildren = await manager.list({
      parentId: retryingWorkflow.id,
    });

    expect(retryingWorkflow).toEqual(
      expect.objectContaining({
        status: "retrying",
        attempts: 1,
        maxAttempts: 2,
      }),
    );
    expect(retryingChildren).toEqual([
      expect.objectContaining({
        type: "billing.retry-webhook",
        status: "retrying",
        parentId: retryingWorkflow.id,
        attempts: 1,
        idempotencyKey: expect.stringMatching(/^task:v2:[a-f0-9]{64}$/),
      }),
    ]);

    const retried = await runner.execute("billing-retry-webhook", {
      subscriptionId: "sub_123",
    });
    const completedWorkflow = await manager.get(retryingWorkflow.id);
    const childExecutions = await manager.list({
      parentId: retryingWorkflow.id,
    });
    const childJobs = await createExecutionJobsOperations(manager).list({
      parentId: retryingWorkflow.id,
    });

    expect(retried).toEqual(
      expect.objectContaining({
        executionId: retryingWorkflow.id,
        reused: false,
      }),
    );
    expect(completedWorkflow).toEqual(
      expect.objectContaining({
        status: "completed",
        attempts: 2,
      }),
    );
    expect(childExecutions).toEqual([
      expect.objectContaining({
        type: "billing.retry-webhook",
        status: "completed",
        parentId: retryingWorkflow.id,
        attempts: 2,
        error: undefined,
        idempotencyKey: expect.stringMatching(/^task:v2:[a-f0-9]{64}$/),
      }),
    ]);
    expect(childJobs).toEqual(
      expect.objectContaining({
        summary: "healthy",
        attentionCount: 0,
        total: 1,
        jobs: [
          expect.objectContaining({
            status: "completed",
            errorMessage: undefined,
          }),
        ],
      }),
    );
    expect(handledSubscriptions).toEqual(["sub_123:1", "sub_123:2"]);
  });

  it("reuses completed prior step results when retrying a later workflow step", async () => {
    let fetchAttempts = 0;
    let syncAttempts = 0;

    class RetryableEntitlementProviderProblem extends Problem {
      readonly retryable = true;

      constructor() {
        super(
          "workflow-core/test-retryable-entitlement-provider",
          ProblemCategory.InternalServerError,
          "entitlement provider retryable outage",
        );
      }
    }

    @Component()
    class MultiStepBillingTasks {
      @Task({ name: "billing.retry-fetch-subscription", maxAttempts: 2 })
      fetchSubscription(payload: unknown): {
        subscriptionId: string;
        plan: string;
      } {
        fetchAttempts += 1;
        return { subscriptionId: getSubscriptionId(payload), plan: "pro" };
      }

      @Task({ name: "billing.retry-sync-entitlements", maxAttempts: 2 })
      syncEntitlements(payload: unknown): { synced: string; attempt: number } {
        syncAttempts += 1;

        if (syncAttempts === 1) {
          throw new RetryableEntitlementProviderProblem();
        }

        return {
          synced: getSubscriptionId(payload),
          attempt: syncAttempts,
        };
      }
    }

    @Component()
    class MultiStepBillingWorkflows {
      @OnWebhook("/webhooks/billing", "POST", { auth: true })
      @Workflow({
        name: "billing-retry-entitlements",
        steps: [
          "billing.retry-fetch-subscription",
          {
            name: "sync-entitlements",
            task: "billing.retry-sync-entitlements",
            input: ({ previousResults }) => previousResults[0]?.result,
          },
        ],
        maxAttempts: 2,
        idempotencyKey: ({ payload }) => `billing-entitlements:${getSubscriptionId(payload)}`,
      })
      webhook(): void {}
    }

    Container.set(MultiStepBillingTasks, new MultiStepBillingTasks());
    Container.set(MultiStepBillingWorkflows, new MultiStepBillingWorkflows());
    const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

    await expect(
      runner.execute("billing-retry-entitlements", {
        subscriptionId: "sub_123",
      }),
    ).rejects.toThrow("entitlement provider retryable outage");

    const [retryingWorkflow] = await manager.list({ type: "workflow" });
    const retryingChildren = await manager.list({
      parentId: retryingWorkflow.id,
    });

    expect(retryingChildren).toEqual([
      expect.objectContaining({
        type: "billing.retry-fetch-subscription",
        status: "completed",
        attempts: 1,
        result: { subscriptionId: "sub_123", plan: "pro" },
      }),
      expect.objectContaining({
        type: "billing.retry-sync-entitlements",
        status: "retrying",
        attempts: 1,
      }),
    ]);

    const retried = await runner.execute("billing-retry-entitlements", {
      subscriptionId: "sub_123",
    });
    const completedWorkflow = await manager.get(retryingWorkflow.id);
    const completedChildren = await manager.list({
      parentId: retryingWorkflow.id,
    });
    const childJobs = await createExecutionJobsOperations(manager).list({
      parentId: retryingWorkflow.id,
    });

    expect(retried).toEqual(
      expect.objectContaining({
        executionId: retryingWorkflow.id,
        reused: false,
        steps: [
          expect.objectContaining({
            task: "billing.retry-fetch-subscription",
            result: { subscriptionId: "sub_123", plan: "pro" },
          }),
          expect.objectContaining({
            task: "billing.retry-sync-entitlements",
            result: { synced: "sub_123", attempt: 2 },
          }),
        ],
      }),
    );
    expect(completedWorkflow).toEqual(
      expect.objectContaining({
        status: "completed",
        attempts: 2,
      }),
    );
    expect(completedChildren).toEqual([
      expect.objectContaining({
        type: "billing.retry-fetch-subscription",
        status: "completed",
        attempts: 1,
        idempotencyKey: expect.stringMatching(/^task:v2:[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        type: "billing.retry-sync-entitlements",
        status: "completed",
        attempts: 2,
        error: undefined,
        idempotencyKey: expect.stringMatching(/^task:v2:[a-f0-9]{64}$/),
      }),
    ]);
    expect(childJobs).toEqual(
      expect.objectContaining({
        summary: "healthy",
        attentionCount: 0,
        total: 2,
      }),
    );
    expect(fetchAttempts).toBe(1);
    expect(syncAttempts).toBe(2);
  });

  it("does not resume a retrying execution from a different workflow with the same idempotency key", async () => {
    @Component()
    class WebhookTasks {
      @Task({ name: "billing.retry-collision" })
      handleWebhook(): void {}
    }

    @Component()
    class WebhookWorkflows {
      @OnWebhook("/webhooks/billing", "POST", { auth: true })
      @Workflow({
        name: "billing-retry-collision",
        steps: ["billing.retry-collision"],
        maxAttempts: 2,
        idempotencyKey: ({ payload }) => `billing-webhook:${getSubscriptionId(payload)}`,
      })
      webhook(): void {}
    }

    Container.set(WebhookTasks, new WebhookTasks());
    Container.set(WebhookWorkflows, new WebhookWorkflows());

    const existingExecution: Execution = {
      id: "workflow-existing",
      type: "workflow",
      status: "retrying",
      payload: { subscriptionId: "sub_123" },
      attempts: 1,
      maxAttempts: 2,
      createdAt: new Date(),
      idempotencyKey: "billing-webhook:sub_123",
      metadata: {
        workflowName: "other-workflow",
        workflowInvocationId: "existing-invocation",
      },
    };
    const executionManager = {
      create: vi.fn().mockResolvedValue(existingExecution),
      start: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      updateProgress: vi.fn(),
      checkpoint: vi.fn(),
      timeout: vi.fn(),
    } as unknown as ExecutionManager;
    const runner = new WorkflowRunner(executionManager, WorkflowRegistry.fromMetadata());

    await expect(
      runner.execute("billing-retry-collision", {
        subscriptionId: "sub_123",
      }),
    ).rejects.toMatchObject({ code: "execution/invalid-state-transition" });
    expect(executionManager.start).not.toHaveBeenCalled();
  });

  it("creates distinct executions for different workflows sharing the same caller idempotency key", async () => {
    const executedTasks: string[] = [];

    @Component()
    class CrossTasks {
      @Task({ name: "cross.task-a" })
      taskA(): string {
        executedTasks.push("task-a");
        return "result-a";
      }

      @Task({ name: "cross.task-b" })
      taskB(): string {
        executedTasks.push("task-b");
        return "result-b";
      }
    }

    @Component()
    class CrossWorkflows {
      @Workflow({
        name: "cross-workflow-a",
        steps: ["cross.task-a"],
        idempotencyKey: ({ payload }) => `shared:${getSharedId(payload)}`,
      })
      workflowA(): void {}

      @Workflow({
        name: "cross-workflow-b",
        steps: ["cross.task-b"],
        idempotencyKey: ({ payload }) => `shared:${getSharedId(payload)}`,
      })
      workflowB(): void {}
    }

    Container.set(CrossTasks, new CrossTasks());
    Container.set(CrossWorkflows, new CrossWorkflows());
    const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

    const first = await runner.execute("cross-workflow-a", { id: "same" });
    const second = await runner.execute("cross-workflow-b", { id: "same" });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(false);
    expect(first.executionId).not.toBe(second.executionId);
    expect(executedTasks).toEqual(["task-a", "task-b"]);
  });

  it("emits workflow telemetry span attributes and lifecycle events", async () => {
    const mockSpan = createMockSpan();
    vi.spyOn(trace, "getTracer").mockReturnValue(createMockTracer(mockSpan.span));

    @Component()
    class TelemetryTasks {
      @Task({ name: "billing.telemetry" })
      run(payload: unknown): { handled: string } {
        return { handled: getSubscriptionId(payload) };
      }
    }

    @Component()
    class TelemetryWorkflows {
      @Workflow({
        name: "billing-telemetry",
        steps: ["billing.telemetry"],
        idempotencyKey: ({ payload }) => `billing-telemetry:${getSubscriptionId(payload)}`,
      })
      run(): void {}
    }

    Container.set(TelemetryTasks, new TelemetryTasks());
    Container.set(TelemetryWorkflows, new TelemetryWorkflows());
    const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

    await runner.execute("billing-telemetry", { subscriptionId: "sub_123" });

    expect(mockSpan.setAttribute).toHaveBeenCalledWith("workflow.name", "billing-telemetry");
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("workflow.step.count", 1);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("workflow.idempotent", true);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("workflow.reused", false);
    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      "workflow.execution.created",
      expect.objectContaining({
        "workflow.name": "billing-telemetry",
        "workflow.execution.id": expect.any(String),
        "workflow.execution.status": "pending",
      }),
    );
    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      "workflow.execution.started",
      expect.objectContaining({
        "workflow.name": "billing-telemetry",
        "workflow.execution.status": "running",
      }),
    );
    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      "workflow.step.started",
      expect.objectContaining({
        "workflow.step.name": "billing.telemetry",
        "workflow.step.task": "billing.telemetry",
      }),
    );
    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      "workflow.step.completed",
      expect.objectContaining({
        "workflow.step.name": "billing.telemetry",
        "workflow.step.task": "billing.telemetry",
      }),
    );
    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      "workflow.execution.completed",
      expect.objectContaining({
        "workflow.name": "billing-telemetry",
        "workflow.execution.status": "completed",
      }),
    );
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["start", "Workflow execution started", false],
    ["step start", "Workflow step started", false],
    ["step completion", "Workflow step completed", false],
    ["completion", "Workflow execution completed", false],
    ["failure", "Workflow execution failed", true],
  ] as const)(
    "keeps the execution state authoritative when the %s log write fails",
    async (_phase, failedLogMessage, workflowShouldFail) => {
      const mockSpan = createMockSpan();
      vi.spyOn(trace, "getTracer").mockReturnValue(createMockTracer(mockSpan.span));
      const workflowFailure = new TestWorkflowProblem("workflow operation failed");
      const logFailure = new TestWorkflowProblem("execution log store unavailable");

      @Component()
      class LogFailureTasks {
        @Task({ name: "billing.log-failure" })
        run(): { completed: true } {
          if (workflowShouldFail) {
            throw workflowFailure;
          }

          return { completed: true };
        }
      }

      @Component()
      class LogFailureWorkflows {
        @Workflow({
          name: "billing-log-failure",
          steps: ["billing.log-failure"],
        })
        run(): void {}
      }

      Container.set(LogFailureTasks, new LogFailureTasks());
      Container.set(LogFailureWorkflows, new LogFailureWorkflows());
      const recordLog = manager.recordLog.bind(manager);
      vi.spyOn(manager, "recordLog").mockImplementation(async (executionId, params) => {
        if (params.message === failedLogMessage) {
          throw logFailure;
        }

        return recordLog(executionId, params);
      });
      const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

      const executionPromise = runner.execute("billing-log-failure", {});
      if (workflowShouldFail) {
        await expect(executionPromise).rejects.toBe(workflowFailure);
      } else {
        await expect(executionPromise).resolves.toEqual(
          expect.objectContaining({
            reused: false,
            steps: [
              expect.objectContaining({
                step: "billing.log-failure",
                result: { completed: true },
              }),
            ],
          }),
        );
      }

      const [workflowExecution] = await manager.list({ type: "workflow" });
      expect(workflowExecution).toEqual(
        expect.objectContaining({
          status: workflowShouldFail ? "failed" : "completed",
          ...(workflowShouldFail
            ? { error: expect.objectContaining({ message: workflowFailure.message }) }
            : {}),
        }),
      );
      expect(mockSpan.addEvent).toHaveBeenCalledWith("workflow.log.failed", {
        "workflow.execution.id": workflowExecution.id,
        "workflow.log.level": workflowShouldFail ? "error" : "info",
        "workflow.log.message": failedLogMessage,
        "workflow.error.message": logFailure.message,
      });
    },
  );

  it.each([
    ["extensible", new TestWorkflowProblem("billing provider unavailable"), false],
    [
      "non-extensible",
      Object.preventExtensions(new TestWorkflowProblem("billing provider unavailable")),
      true,
    ],
  ] as const)(
    "preserves the %s workflow error when recording the failed execution rejects",
    async (_errorKind, workflowFailure, attachmentFailed) => {
      const mockSpan = createMockSpan();
      vi.spyOn(trace, "getTracer").mockReturnValue(createMockTracer(mockSpan.span));
      const failureRecordError = new TestWorkflowProblem("execution store unavailable");

      @Component()
      class FailureRecordTasks {
        @Task({ name: "billing.failure-record" })
        run(): never {
          throw workflowFailure;
        }
      }

      @Component()
      class FailureRecordWorkflows {
        @Workflow({
          name: "billing-failure-record",
          steps: ["billing.failure-record"],
        })
        run(): void {}
      }

      Container.set(FailureRecordTasks, new FailureRecordTasks());
      Container.set(FailureRecordWorkflows, new FailureRecordWorkflows());
      const fail = manager.fail.bind(manager);
      vi.spyOn(manager, "fail").mockImplementation(async (executionId, error) => {
        const execution = await store.findById(executionId);
        if (execution?.type === "workflow") {
          throw failureRecordError;
        }

        return fail(executionId, error);
      });
      const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

      await expect(runner.execute("billing-failure-record", {})).rejects.toBe(workflowFailure);

      expect(
        Object.getOwnPropertyDescriptor(workflowFailure, "workflowFailureRecordError"),
      ).toEqual(
        attachmentFailed
          ? undefined
          : {
              configurable: true,
              enumerable: false,
              value: failureRecordError,
              writable: false,
            },
      );
      expect(mockSpan.addEvent).toHaveBeenCalledWith("workflow.execution.failure_record.failed", {
        "workflow.execution.id": "exec-1",
        "workflow.error.message": workflowFailure.message,
        "workflow.failure_record.error.message": failureRecordError.message,
        ...(attachmentFailed ? { "workflow.failure_record.attachment_failed": true } : {}),
      });
    },
  );

  it("marks failed workflow executions and allows explicit replay creation", async () => {
    @Component()
    class FailingTasks {
      @Task({ name: "billing.fail" })
      fail(): never {
        throw new TestWorkflowProblem("billing provider unavailable");
      }
    }

    @Component()
    class FailingWorkflows {
      @Workflow({
        name: "billing-failure",
        steps: ["billing.fail"],
      })
      run(): void {}
    }

    Container.set(FailingTasks, new FailingTasks());
    Container.set(FailingWorkflows, new FailingWorkflows());
    const runner = new WorkflowRunner(manager, WorkflowRegistry.fromMetadata());

    await expect(runner.execute("billing-failure", {})).rejects.toThrow(
      "billing provider unavailable",
    );

    const [failedWorkflow] = await manager.list({ type: "workflow" });
    const replay = await runner.replay(failedWorkflow.id, {
      reason: "operator retry after provider recovery",
    });

    expect(failedWorkflow).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          message: "billing provider unavailable",
        }),
      }),
    );
    expect(failedWorkflow.logs?.at(-1)).toEqual(
      expect.objectContaining({
        level: "error",
        message: "Workflow execution failed",
      }),
    );
    expect(replay).toEqual(
      expect.objectContaining({
        type: "workflow",
        status: "pending",
        replayOf: failedWorkflow.id,
        metadata: expect.objectContaining({
          workflowName: "billing-failure",
          replayOf: failedWorkflow.id,
          replayReason: "operator retry after provider recovery",
        }),
      }),
    );
  });

  it("reports registered workflows and execution status through diagnostics", async () => {
    @Component()
    class DiagnosticsTasks {
      @Task({ name: "billing.inspect" })
      inspect(payload: unknown): { inspected: string } {
        return { inspected: getSubscriptionId(payload) };
      }

      @Task({ name: "billing.inspect-failure" })
      fail(): never {
        throw new TestWorkflowProblem("billing diagnostics failure");
      }
    }

    @Component()
    class DiagnosticsWorkflows {
      @Cron("*/30 * * * *")
      @Workflow({
        name: "billing-inspect",
        description: "Inspect billing state",
        steps: ["billing.inspect"],
      })
      inspect(): void {}

      @Workflow({
        name: "billing-inspect-failure",
        steps: ["billing.inspect-failure"],
      })
      fail(): void {}
    }

    Container.set(DiagnosticsTasks, new DiagnosticsTasks());
    Container.set(DiagnosticsWorkflows, new DiagnosticsWorkflows());
    const registry = WorkflowRegistry.fromMetadata();
    const runner = new WorkflowRunner(manager, registry);

    await runner.execute("billing-inspect", { subscriptionId: "sub_123" });
    await expect(runner.execute("billing-inspect-failure", {})).rejects.toThrow(
      "billing diagnostics failure",
    );

    const health = await new WorkflowDiagnosticsProvider(manager, registry).getHealth();

    expect(health.status).toBe("degraded");
    expect(health.component).toBe("workflow");
    expect(health.message).toBe("1 workflow execution(s) need attention");
    expect(health.details).toEqual(
      expect.objectContaining({
        inspectionSupported: true,
        registeredWorkflowCount: 2,
        executionCount: 2,
        attentionExecutionCount: 1,
        executionsByStatus: expect.objectContaining({
          completed: 1,
          failed: 1,
          pending: 0,
        }),
        workflows: expect.arrayContaining([
          expect.objectContaining({
            name: "billing-inspect",
            description: "Inspect billing state",
            stepCount: 1,
            triggerTypes: ["cron"],
          }),
          expect.objectContaining({
            name: "billing-inspect-failure",
            stepCount: 1,
            triggerTypes: [],
          }),
        ]),
        latestExecutions: expect.arrayContaining([
          expect.objectContaining({
            workflowName: "billing-inspect",
            status: "completed",
            logCount: 4,
            latestLog: expect.objectContaining({
              level: "info",
              message: "Workflow execution completed",
            }),
          }),
          expect.objectContaining({
            workflowName: "billing-inspect-failure",
            status: "failed",
            errorMessage: "billing diagnostics failure",
            logCount: 3,
            latestLog: expect.objectContaining({
              level: "error",
              message: "Workflow execution failed",
            }),
          }),
        ]),
      }),
    );
    expect(JSON.stringify(health.details)).not.toContain("sub_123");
  });

  it("paginates diagnostics execution inspection so later failures are not hidden", async () => {
    const baseCreatedAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let index = 0; index < 101; index++) {
      const execution = await manager.create({
        type: "workflow",
        metadata: { workflowName: "historical-workflow" },
      });
      await manager.start(execution.id);
      await manager.complete(execution.id);
      await store.update(execution.id, {
        createdAt: new Date(baseCreatedAt + index * 1000),
      });
    }

    const failedExecution = await manager.create({
      type: "workflow",
      metadata: { workflowName: "late-failure" },
    });
    await manager.start(failedExecution.id);
    await manager.fail(failedExecution.id, {
      message: "late workflow failure",
      retryable: false,
    });
    await store.update(failedExecution.id, {
      createdAt: new Date(baseCreatedAt + 102_000),
    });

    const listWorkflowExecutions = vi.fn((options?: ListExecutionsOptions) =>
      manager.list({ ...options, limit: options?.limit ?? 100 }),
    );
    const pagedExecutionManager = {
      list: listWorkflowExecutions,
    } as unknown as ExecutionManager;
    const health = await new WorkflowDiagnosticsProvider(
      pagedExecutionManager,
      new WorkflowRegistry(),
      {
        executionLimit: 5,
        executionPageSize: 100,
      },
    ).getHealth();

    expect(health.status).toBe("degraded");
    expect(health.details).toEqual(
      expect.objectContaining({
        executionCount: 102,
        attentionExecutionCount: 1,
        executionsByStatus: expect.objectContaining({
          completed: 101,
          failed: 1,
        }),
        latestExecutions: expect.arrayContaining([
          expect.objectContaining({
            workflowName: "late-failure",
            status: "failed",
            errorMessage: "late workflow failure",
          }),
        ]),
      }),
    );
    expect(listWorkflowExecutions).toHaveBeenCalledWith({
      type: "workflow",
      limit: 100,
      offset: 0,
    });
    expect(listWorkflowExecutions).toHaveBeenCalledWith({
      type: "workflow",
      limit: 100,
      offset: 100,
    });
  });

  it("stops diagnostics pagination when its abort signal is cancelled", async () => {
    for (let index = 0; index < 120; index++) {
      const execution = await manager.create({
        type: "workflow",
        metadata: { workflowName: "abortable-workflow" },
      });
      await manager.start(execution.id);
      await manager.complete(execution.id);
    }

    const controller = new AbortController();
    const listWorkflowExecutions = vi.fn(async (options?: ListExecutionsOptions) => {
      const page = await manager.list({
        ...options,
        limit: options?.limit ?? 50,
      });
      controller.abort();
      return page;
    });
    const abortableExecutionManager = {
      list: listWorkflowExecutions,
    } as unknown as ExecutionManager;

    const health = await new WorkflowDiagnosticsProvider(
      abortableExecutionManager,
      new WorkflowRegistry(),
      {
        executionPageSize: 50,
      },
    ).getHealth(controller.signal);

    expect(health.details).toEqual(
      expect.objectContaining({
        executionCount: 50,
      }),
    );
    expect(listWorkflowExecutions).toHaveBeenCalledTimes(1);
    expect(listWorkflowExecutions).toHaveBeenCalledWith({
      type: "workflow",
      limit: 50,
      offset: 0,
    });
  });

  it("degrades diagnostics when execution inspection is unavailable", async () => {
    const executionManager = {
      create: vi.fn(),
      start: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      updateProgress: vi.fn(),
      checkpoint: vi.fn(),
      timeout: vi.fn(),
    } as unknown as ExecutionManager;
    const provider = new WorkflowDiagnosticsProvider(executionManager, new WorkflowRegistry());

    const health = await provider.getHealth();

    expect(health).toEqual(
      expect.objectContaining({
        status: "degraded",
        component: "workflow",
        message: "Workflow execution inspection is not available",
        details: expect.objectContaining({
          inspectionSupported: false,
          registeredWorkflowCount: 0,
          workflows: [],
        }),
      }),
    );
  });
});
