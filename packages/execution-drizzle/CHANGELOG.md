# @croco/execution-drizzle

## 0.1.0

### Minor Changes

- 6fa6843: Timed-out task attempts now block retry and replay until the abandoned handler settles, an explicit idempotent or fenced contract permits overlap, or an operator records recovery. Croco-managed task results use atomic attempt tokens so stale attempts cannot commit a newer run.
- 25bfb06: Scope every task idempotency key to the task contract, persist canonical request fingerprints, and reject reuse with a
  different execution type or payload. Before deploying `@croco/execution-drizzle`, add
  `executions.request_fingerprint varchar(64) null`, then drain every old task writer before starting the new version.
  Mixed old/new task writers are unsupported because reservation across legacy and scoped keys is not atomic.

### Patch Changes

- b278729: - fix: block critical test tooling advisories
- 269d9df: Execution stores now merge individual checkpoint keys atomically as part of their required contract. Concurrent writes to different keys are preserved. Same-key writes are serialized by the store with the last applied mutation winning, without an invocation-order guarantee.
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 3274572: Clear explicitly undefined optional execution fields in PostgreSQL updates while preserving omitted fields and treating empty updates as no-ops.
- 82a10b8: Enforce persisted task deadlines with atomic lifecycle transitions, restart reconciliation,
  cooperative cancellation, and explicit retry by execution ID.
- 8522b0c: Keep default package tests deterministic while exposing integration, published-package, and live-resource verification through explicit test lanes.
- 67e0cbe: fix: resolve published package types before runtime conditions
- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- 5e886a9: - feat: fence QStash batch continuations with atomic claims and idempotent writer tokens

  Before deploying `@croco/execution-drizzle`, add the nullable continuation column with
  `ALTER TABLE executions ADD COLUMN continuation jsonb;`. Complete this migration before rolling out
  application code that acquires continuation claims.

- ed75f31: Keep recent execution failures and existing recovery replays visible after the execution store's first page, and document the
  Drizzle store's default ordered page boundary.
- 80a2c12: Store execution timeouts above the PostgreSQL 32-bit integer range without changing the `number` API contract. Existing databases must widen `executions.timeout` to `bigint` before deploying this version.
- Updated dependencies [b278729]
- Updated dependencies [269d9df]
- Updated dependencies [7cdfcae]
- Updated dependencies [1084825]
- Updated dependencies [f8c52e7]
- Updated dependencies [82a10b8]
- Updated dependencies [6fa6843]
- Updated dependencies [67e0cbe]
- Updated dependencies [157089a]
- Updated dependencies [5d54fb4]
- Updated dependencies [5e886a9]
- Updated dependencies [918a960]
- Updated dependencies [25bfb06]
- Updated dependencies [ed75f31]
  - @croco/execution-core@0.1.0

## 0.0.4

### Patch Changes

- 6e165ab: Expose a shared Drizzle provider conformance suite and record initial metering and execution provider evidence for schema, transaction, tenant, and deterministic error gates.
- 513188f: Drizzle-backed SaaS adapters now publish shared conformance evidence and redacted readiness diagnostics before beta maturity.
- 3f6dca0: Clear stale completion timestamps and previous-attempt errors when retried executions become active again.
- 595c786: Expose execution inspection logs and explicit failed-execution replay records, with Drizzle persistence for replay links and log history.
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- 9187e8c: Keep retried workflow child executions consistent with completed parent workflows.
- Updated dependencies [3f6dca0]
- Updated dependencies [595c786]
- Updated dependencies [3c29e42]
- Updated dependencies [af9f355]
- Updated dependencies [d707a0c]
- Updated dependencies [9187e8c]
  - @croco/execution-core@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
- Updated dependencies [99f2a6b]
  - @croco/execution-core@0.0.3
