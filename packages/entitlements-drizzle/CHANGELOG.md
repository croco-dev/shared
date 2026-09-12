# @croco/entitlements-drizzle

## 0.1.0

### Minor Changes

- 5d08b1b: Resolve entitlement and overage policies from immutable subscription plan versions while preserving an explicit legacy plan-ID migration path.

### Patch Changes

- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 1f6522c: Persist subscription cancel and resume commands before provider I/O, carry stable provider idempotency keys,
  use revision-fenced local reconciliation, durably retry cancellation event delivery through an
  event-ID-idempotent publisher contract, expose bounded
  reconciliation APIs, and project provider-applied lifecycle state into entitlement reads until local state
  converges.

  Stale commands cannot overwrite replacement subscriptions, while lifecycle deltas rebase onto newer snapshots
  of the same external subscription and persist their local outcome. Canceled or revoked subscriptions no longer
  grant a current entitlement plan. Polar lifecycle mutations now forward command keys and verify already-applied
  cancellation targets, while the billing provider conformance suite requires distinct lifecycle idempotency
  evidence.

  The generated SaaS demo leaves lifecycle event delivery unconfigured until an application supplies a durable,
  event-ID-idempotent publisher.

- 67e0cbe: fix: resolve published package types before runtime conditions
- 1c843a5: Preserve runtime class-decorator metadata in published ESM and CJS bundles so Croco can resolve concrete constructor dependencies from installed packages.
- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- db03f5b: Reject duplicate or semantically invalid legacy entitlement rules before evaluation while preserving meter-derived legacy quotas, and diagnose existing PostgreSQL conflicts before enforcing one legacy rule per plan and feature.
- Updated dependencies [4ca14ab]
- Updated dependencies [38cba9c]
- Updated dependencies [b278729]
- Updated dependencies [7008727]
- Updated dependencies [868ea09]
- Updated dependencies [7cdfcae]
- Updated dependencies [30bad55]
- Updated dependencies [34b6c3d]
- Updated dependencies [d29c25b]
- Updated dependencies [98b1a17]
- Updated dependencies [9404839]
- Updated dependencies [5d08b1b]
- Updated dependencies [26f4b9e]
- Updated dependencies [2bbb09f]
- Updated dependencies [2cc5438]
- Updated dependencies [d1a03e6]
- Updated dependencies [7df16bb]
- Updated dependencies [0fa2546]
- Updated dependencies [008f3f0]
- Updated dependencies [500c048]
- Updated dependencies [6489abb]
- Updated dependencies [1f6522c]
- Updated dependencies [ec75eb4]
- Updated dependencies [dda0a50]
- Updated dependencies [7d248c5]
- Updated dependencies [9b379dd]
- Updated dependencies [ba1974d]
- Updated dependencies [523ed8a]
- Updated dependencies [be7408f]
- Updated dependencies [16cc286]
- Updated dependencies [eed5e70]
- Updated dependencies [bf62995]
- Updated dependencies [cfdc20a]
- Updated dependencies [0b5e89b]
- Updated dependencies [67e0cbe]
- Updated dependencies [e3bb85e]
- Updated dependencies [8c2b316]
- Updated dependencies [986ce2d]
- Updated dependencies [8630cf3]
- Updated dependencies [7721747]
- Updated dependencies [1c843a5]
- Updated dependencies [45882f1]
- Updated dependencies [f0c328e]
- Updated dependencies [f38d9fa]
- Updated dependencies [efb33f9]
- Updated dependencies [157089a]
- Updated dependencies [5d54fb4]
- Updated dependencies [b68b670]
- Updated dependencies [8aa72a1]
- Updated dependencies [3240609]
- Updated dependencies [f141c18]
- Updated dependencies [fccf65b]
- Updated dependencies [dda0a50]
- Updated dependencies [b2eef05]
- Updated dependencies [6754896]
- Updated dependencies [8c1acbd]
- Updated dependencies [99da854]
- Updated dependencies [e493f8b]
- Updated dependencies [5f9bddc]
- Updated dependencies [76e734f]
- Updated dependencies [db03f5b]
- Updated dependencies [e91643e]
- Updated dependencies [0e0a46c]
  - @croco/framework-context@0.1.0
  - @croco/tx-drizzle@0.1.0
  - @croco/billing-core@1.0.0
  - @croco/entitlements-core@0.1.0

## 0.0.4

### Patch Changes

- 513188f: Drizzle-backed SaaS adapters now publish shared conformance evidence and redacted readiness diagnostics before beta maturity.
- 40b024d: Keep published package entrypoints importable by generating advertised declaration files, declaring public runtime and type dependencies on the install surface, deferring Clerk webhook peer loading until webhook handling is used, preserving concrete customer health injection tokens in built output, no longer advertising CommonJS entrypoints that cannot load ESM-only peers, and keeping the migration CLI parser behind binary execution.
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- Updated dependencies [ee924c0]
- Updated dependencies [5403360]
- Updated dependencies [e12e825]
- Updated dependencies [6831875]
- Updated dependencies [513188f]
- Updated dependencies [9c1bc2e]
- Updated dependencies [a61dcd4]
- Updated dependencies [29bad18]
- Updated dependencies [4c7fcd9]
- Updated dependencies [1dc1607]
- Updated dependencies [d707a0c]
- Updated dependencies [9c2ac20]
- Updated dependencies [de7610e]
- Updated dependencies [14bd9f8]
- Updated dependencies [0618b12]
- Updated dependencies [41ee87a]
- Updated dependencies [c54e7b5]
- Updated dependencies [d1552a5]
- Updated dependencies [844234f]
  - @croco/framework-context@0.0.4
  - @croco/tx-drizzle@0.0.4
  - @croco/entitlements-core@0.0.4
  - @croco/billing-core@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
  - @croco/framework-context@0.0.3
  - @croco/billing-core@0.0.3
  - @croco/entitlements-core@0.0.3
  - @croco/tx-drizzle@0.0.3
