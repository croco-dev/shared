# @croco/membership-drizzle

## 1.0.0

### Major Changes

- 5677718: Membership add commands now carry the finite seat capacity enforced by the store's atomic command
  transaction. Custom `MembershipStore` implementations must reject an add whose non-null `maxSeats`
  is already consumed; `null` preserves unlimited membership creation. Drizzle deployments must apply
  `addMembershipSeatOrdinals()` before using the new command path.
- 7dbf433: Require membership changes to use the idempotent command path so owner removal and demotion always preserve the final owner and commit recoverable event intents. Low-level store mutation primitives are now protected adapter hooks rather than application APIs.
- 6542499: Make membership mutations idempotent and atomically persist recoverable domain-event intents. Membership command APIs now require caller-supplied idempotency keys, expose replay state through `addMemberCommand()`, and no longer publish inside the command transaction. Durable delivery requires a persistent store, an idempotent event publisher, and a relay or worker that calls `publishPendingEvents()`.

### Minor Changes

- 239c077: Serialize owner removal, demotion, and ownership transfer so concurrent membership mutations cannot leave a tenant without an owner, including stale role reads and repeatable-read transactions. Custom `MembershipStore` adapters must implement `mutateOwner()` and `transferOwnership()` with a transaction, lock, or compare-and-set and report serialization failures as `conflict`; validation-only `MembershipOwnerGuard` checks are now deprecated for write enforcement.

### Patch Changes

- b278729: - fix: block critical test tooling advisories
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 8522b0c: Keep default package tests deterministic while exposing integration, published-package, and live-resource verification through explicit test lanes.
- e7e390f: Reject non-owner promotion to owner through role updates with RoleHierarchyViolationProblem at the atomic command boundary. Use ownership transfer for existing members; ordinary role changes, owner no-ops, command replay, and last-owner protection remain supported.
- 67e0cbe: fix: resolve published package types before runtime conditions
- 1c843a5: Preserve runtime class-decorator metadata in published ESM and CJS bundles so Croco can resolve concrete constructor dependencies from installed packages.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- Updated dependencies [4ca14ab]
- Updated dependencies [38cba9c]
- Updated dependencies [b278729]
- Updated dependencies [7008727]
- Updated dependencies [868ea09]
- Updated dependencies [239c077]
- Updated dependencies [5677718]
- Updated dependencies [7cdfcae]
- Updated dependencies [9404839]
- Updated dependencies [26f4b9e]
- Updated dependencies [2bbb09f]
- Updated dependencies [2cc5438]
- Updated dependencies [d1a03e6]
- Updated dependencies [4237d35]
- Updated dependencies [7df16bb]
- Updated dependencies [0fa2546]
- Updated dependencies [008f3f0]
- Updated dependencies [500c048]
- Updated dependencies [6489abb]
- Updated dependencies [ec75eb4]
- Updated dependencies [dda0a50]
- Updated dependencies [7d248c5]
- Updated dependencies [9b379dd]
- Updated dependencies [be7408f]
- Updated dependencies [16cc286]
- Updated dependencies [e7e390f]
- Updated dependencies [eed5e70]
- Updated dependencies [cfdc20a]
- Updated dependencies [0b5e89b]
- Updated dependencies [67e0cbe]
- Updated dependencies [e3bb85e]
- Updated dependencies [1c843a5]
- Updated dependencies [45882f1]
- Updated dependencies [f0c328e]
- Updated dependencies [f38d9fa]
- Updated dependencies [efb33f9]
- Updated dependencies [157089a]
- Updated dependencies [5d54fb4]
- Updated dependencies [b68b670]
- Updated dependencies [8aa72a1]
- Updated dependencies [17f67c8]
- Updated dependencies [7dbf433]
- Updated dependencies [3240609]
- Updated dependencies [f141c18]
- Updated dependencies [fccf65b]
- Updated dependencies [6542499]
- Updated dependencies [8c1acbd]
- Updated dependencies [99da854]
- Updated dependencies [e493f8b]
- Updated dependencies [76e734f]
- Updated dependencies [903466a]
  - @croco/framework-context@0.1.0
  - @croco/tx-core@0.1.0
  - @croco/tx-drizzle@0.1.0
  - @croco/membership-core@1.0.0

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
- Updated dependencies [a61dcd4]
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
  - @croco/membership-core@0.0.4
  - @croco/tx-core@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
  - @croco/framework-context@0.0.3
  - @croco/membership-core@0.0.3
  - @croco/tx-core@0.0.3
  - @croco/tx-drizzle@0.0.3
