# @croco/workflow-core

Croco-native workflow definitions that connect trigger metadata, task execution, and execution inspection records.

## Features

- `@Workflow` method decorator for declaring a workflow entrypoint.
- Typed workflow definitions built from `taskRef` references with inferred step inputs and results.
- Automatic connection to `@Cron`, `@OnEvent`, and `@OnWebhook` metadata on the same method.
- Task step validation against `@croco/tasks-core` registrations.
- Parent `workflow` execution records with child task executions through `TaskRunner`.
- Optional execution logs, idempotency keys, cancellation, and replay delegation through `@croco/execution-core`.
- `WorkflowDiagnosticsProvider` for exposing registered workflows and workflow execution status through `@croco/diagnostics-core`.
- Telemetry spans and lifecycle events for workflow execution, step execution, reuse, completion, and failure.

## Install

```bash
pnpm add @croco/workflow-core
```

## Usage

```typescript
import { Component } from "@croco/framework-context";
import { Task, taskRef } from "@croco/tasks-core";
import { OnWebhook } from "@croco/triggers-core";
import { defineWorkflow, Workflow, WorkflowRunner } from "@croco/workflow-core";

type BillingPayload = {
  subscriptionId: string;
};

@Component()
class BillingTasks {
  @Task({ name: "billing.fetch-subscription" })
  fetchSubscription(payload: BillingPayload) {
    return { subscriptionId: payload.subscriptionId, plan: "pro" };
  }

  @Task({ name: "billing.sync-entitlements" })
  syncEntitlements(payload: { subscriptionId: string; plan: string }) {
    return { synchronized: payload.subscriptionId };
  }
}

const fetchSubscription = taskRef(BillingTasks, "fetchSubscription", "billing.fetch-subscription");
const syncEntitlements = taskRef(BillingTasks, "syncEntitlements", "billing.sync-entitlements");

const billingWorkflow = defineWorkflow<BillingPayload>({
  name: "billing-webhook",
  idempotencyKey: ({ payload }) => `billing:${payload.subscriptionId}`,
})
  .step(fetchSubscription)
  .step("sync", syncEntitlements, ({ previousResults }) => previousResults[0].result)
  .build();

@Component()
class BillingWorkflows {
  @OnWebhook("/webhooks/billing", "POST")
  @Workflow(billingWorkflow)
  billingWebhook() {}
}

const runner = new WorkflowRunner(executionManager);
const result = await runner.execute(billingWorkflow, { subscriptionId: "sub_123" });

if (!result.reused) {
  result.steps[0].result.plan;
  result.steps[1].result.synchronized;
}
```

`defineWorkflow()` checks each input resolver against the referenced task payload. It also preserves
the ordered step results, so `previousResults` and a non-reused `WorkflowRunner.execute()` result are
inferred from the definition.

### Migrating string definitions

Legacy string task names and string runner execution remain supported migration paths. Existing workflows can
continue to use `steps: ["billing.sync"]` and `runner.execute("billing-webhook", payload)` while each
step is migrated to `taskRef()` and `defineWorkflow()`.

```typescript
@Workflow({
  name: "billing-webhook",
  steps: ["billing.sync"],
})
billingWebhook() {}

await runner.execute("billing-webhook", { subscriptionId: "sub_123" });
```

Retryable workflow failures use the parent execution's `maxAttempts`. If a retryable failure leaves an
idempotent workflow in `retrying`, calling `execute()` again with the same idempotency key resumes the
same parent execution for the next attempt instead of returning it as a reused execution. Typed workflows
persist a versioned fingerprint of the workflow name, ordered step names and task names, input-resolver
presence, and declared workflow/task execution options. Function bodies and JavaScript class or method
names are excluded, so formatting, transpilation, and minification do not invalidate retries when explicit
workflow and task names remain stable. A retry resumes only when this structural fingerprint matches.
For incompatible payload, result, or resolver changes that keep the same structure, use a new explicit
workflow or task name (for example, a version suffix). Runtime fingerprints cannot verify TypeScript types.
Legacy string workflows retain their existing retry behavior.

The structural fingerprint uses `workflow-contract:v2`. Existing typed executions persisted with a v1
fingerprint cannot be safely compared with v2 and are rejected on retry. Drain those retries with the
previous deployment before upgrading; do not rewrite stored fingerprints to bypass the contract check.

## Operations

```typescript
import { DiagnosticsCollector } from "@croco/diagnostics-core";
import { WorkflowDiagnosticsProvider, WorkflowRegistry } from "@croco/workflow-core";

const collector = new DiagnosticsCollector();
collector.registerProvider(
  new WorkflowDiagnosticsProvider(executionManager, WorkflowRegistry.fromMetadata()),
);
```

The provider reports workflow names, trigger types, execution status counts, replay references
(`replayOf`), failure messages, log counts, and the latest log message. It does not include workflow
payloads, results, or structured log data in diagnostics output.
