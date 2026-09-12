# @croco/events-core

## 0.1.0

### Minor Changes

- 2973efe: Allow hosts to close in-memory event intake, release backpressure waiters, and observe bounded handler drain outcomes through an optional EventBus lifecycle contract and framework shutdown hook.
- 0530556: Keep completed generation output recoverable when completion-event delivery fails, expose the failure as non-retryable model work, and allow the stable event intent to be retried independently with optional durable intent tracking.

  Keep QStash delivery identity API documentation aligned with the verification input and callback contracts.

- e4bfcb2: Remove the inert `EventOrdering` and `EventReplay` contract families so `@croco/events-core` no longer advertises configuration that no Croco runtime executes. There is no drop-in Croco replacement; consumers with custom ordering or replay implementations must define and verify both the contracts and behavior in their adapter packages.
- 8c1acbd: Keep committed transaction values successful when after-commit hooks fail, and expose structured degraded delivery
  evidence through `TxManager.runWithOutcome()`. Transactions that schedule after-commit work must now use this
  outcome-returning contract; invitation acceptance returns the committed transaction outcome, and event publication
  rejects non-capturing or late hook registration before delivery work can disappear.
- d2539a0: Require event handlers to declare an event parameter compatible with the event passed to `RegisterEventHandler`.

### Patch Changes

- 38cba9c: - fix: enforce full strict contract spine
- 868ea09: Let each Croco application own one isolated DI scope and module lifecycle, retry failed startup from
  the exact pre-attempt provider baseline, inspect one correlated module and dependency graph, and run
  TestKernel without process-global container resets.
  Canonical SaaS templates now bind HTTP application calls to their application-owned runtime, and
  scoped HTTP bootstrap validation ignores unrelated process-global component registrations.
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 08cfa9b: Provide an append-only usage-credit ledger with exact decimal amounts, atomic reservation settlement, deterministic lot allocation and expiry, linked refunds, stable Problems, post-commit events, and a reusable store conformance suite.
- 88c6ce1: Metering retries now resume an explicit pending-event stage, preserve logical event identities, and recover publication
  failures without recording usage twice.

  Custom `UsageStorage` implementations must declare `replayContract: "idempotent"` and replay the original quota result
  for a repeated idempotency key. Redis clients must explicitly declare multi-key script support.

- 1b39af2: Expose dropped event publishes as a distinct statistics and diagnostics counter.
- 67e0cbe: fix: resolve published package types before runtime conditions
- efb33f9: Boot production application definitions in isolated, runner-neutral test kernels with explicit application or adapter fidelity.

  Each kernel now owns its DI instances, event configuration, test transaction evidence, request state, scoped production shutdown hooks, and one-time cleanup lifecycle without replacing the application's production transaction provider. Node and Lambda adapter requests run through their real handler paths without opening a public network port, while the existing lightweight testing app is reported as isolated fidelity.

- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- cc8106d: Retain exhausted event handling and handler initialization failures in an opt-in dead-letter queue. Replay only the failed handler with the original event identity and an explicit handler ID that survives rebuilds. DLQ snapshots isolate supported mutable data and reject unsupported values; invalid backpressure strategies fail before execution.
- 57b786f: Generate default domain event identities as UUID v4 values to prevent high-volume event collisions and false duplicate handling.
- 3f61772: Reject serialized events with missing or malformed required identities before reconstruction.
- Updated dependencies [4ca14ab]
- Updated dependencies [38cba9c]
- Updated dependencies [7008727]
- Updated dependencies [6795b4d]
- Updated dependencies [fe51253]
- Updated dependencies [868ea09]
- Updated dependencies [c1d0ed0]
- Updated dependencies [d7b2bde]
- Updated dependencies [319d43e]
- Updated dependencies [269d9df]
- Updated dependencies [1380ce5]
- Updated dependencies [64af41f]
- Updated dependencies [7cdfcae]
- Updated dependencies [c91a72b]
- Updated dependencies [30bad55]
- Updated dependencies [121b830]
- Updated dependencies [ba1c12d]
- Updated dependencies [0e658fc]
- Updated dependencies [34b6c3d]
- Updated dependencies [cb61f2e]
- Updated dependencies [13cfab4]
- Updated dependencies [f05e38e]
- Updated dependencies [ade3461]
- Updated dependencies [e9e2d49]
- Updated dependencies [d0ed66c]
- Updated dependencies [9404839]
- Updated dependencies [2d74ff8]
- Updated dependencies [b07ae3a]
- Updated dependencies [5d08b1b]
- Updated dependencies [99ace13]
- Updated dependencies [08cfa9b]
- Updated dependencies [1084825]
- Updated dependencies [26f4b9e]
- Updated dependencies [88c6ce1]
- Updated dependencies [7c632bb]
- Updated dependencies [772a244]
- Updated dependencies [2bbb09f]
- Updated dependencies [1d12013]
- Updated dependencies [50c8c7d]
- Updated dependencies [d6e9b2d]
- Updated dependencies [939af32]
- Updated dependencies [3853d82]
- Updated dependencies [935d29f]
- Updated dependencies [583588d]
- Updated dependencies [da978b0]
- Updated dependencies [718ee7d]
- Updated dependencies [527475f]
- Updated dependencies [2cc5438]
- Updated dependencies [c008825]
- Updated dependencies [98fcaed]
- Updated dependencies [f647df2]
- Updated dependencies [d1a03e6]
- Updated dependencies [77794c4]
- Updated dependencies [d99ede2]
- Updated dependencies [50db523]
- Updated dependencies [7df16bb]
- Updated dependencies [ea742a4]
- Updated dependencies [7e46a3d]
- Updated dependencies [0fa2546]
- Updated dependencies [077bb26]
- Updated dependencies [91e7bb6]
- Updated dependencies [008f3f0]
- Updated dependencies [0584573]
- Updated dependencies [500c048]
- Updated dependencies [c9c1c1d]
- Updated dependencies [09c48b3]
- Updated dependencies [6489abb]
- Updated dependencies [cd98718]
- Updated dependencies [2973efe]
- Updated dependencies [daef820]
- Updated dependencies [1f6522c]
- Updated dependencies [9b997bb]
- Updated dependencies [6d81e46]
- Updated dependencies [ec75eb4]
- Updated dependencies [101a7f1]
- Updated dependencies [7aabe26]
- Updated dependencies [3648511]
- Updated dependencies [dda0a50]
- Updated dependencies [15e39cc]
- Updated dependencies [03ea9aa]
- Updated dependencies [9f681cf]
- Updated dependencies [7d248c5]
- Updated dependencies [00ac668]
- Updated dependencies [9b379dd]
- Updated dependencies [ba1974d]
- Updated dependencies [04ea69c]
- Updated dependencies [558c255]
- Updated dependencies [96b6b80]
- Updated dependencies [be7408f]
- Updated dependencies [969d87e]
- Updated dependencies [6fa6843]
- Updated dependencies [6069742]
- Updated dependencies [210015b]
- Updated dependencies [16cc286]
- Updated dependencies [1255323]
- Updated dependencies [1216b88]
- Updated dependencies [b91d384]
- Updated dependencies [ba6ba75]
- Updated dependencies [05c9c45]
- Updated dependencies [76be188]
- Updated dependencies [d52f81f]
- Updated dependencies [b228e78]
- Updated dependencies [eed5e70]
- Updated dependencies [10f3601]
- Updated dependencies [bf62995]
- Updated dependencies [3bb5093]
- Updated dependencies [6f8080b]
- Updated dependencies [e039e2d]
- Updated dependencies [c30879a]
- Updated dependencies [26bcc38]
- Updated dependencies [cfdc20a]
- Updated dependencies [0b5e89b]
- Updated dependencies [3d9e585]
- Updated dependencies [37dab98]
- Updated dependencies [00ec1c5]
- Updated dependencies [a4a5a49]
- Updated dependencies [6d8a31f]
- Updated dependencies [9a03a84]
- Updated dependencies [67e0cbe]
- Updated dependencies [e3bb85e]
- Updated dependencies [fb10b5f]
- Updated dependencies [a7df589]
- Updated dependencies [8c2b316]
- Updated dependencies [986ce2d]
- Updated dependencies [8630cf3]
- Updated dependencies [31636bb]
- Updated dependencies [f92404b]
- Updated dependencies [44fb02d]
- Updated dependencies [1c843a5]
- Updated dependencies [45882f1]
- Updated dependencies [a8d733b]
- Updated dependencies [2a6e12c]
- Updated dependencies [f0c328e]
- Updated dependencies [796290f]
- Updated dependencies [efb33f9]
- Updated dependencies [157089a]
- Updated dependencies [47b942b]
- Updated dependencies [a458c5c]
- Updated dependencies [8bf1a44]
- Updated dependencies [5d54fb4]
- Updated dependencies [19bdcd1]
- Updated dependencies [16ff048]
- Updated dependencies [6aaafc8]
- Updated dependencies [badfb5c]
- Updated dependencies [a2353be]
- Updated dependencies [affa795]
- Updated dependencies [72fbcd0]
- Updated dependencies [fb810a9]
- Updated dependencies [c7299d2]
- Updated dependencies [0530556]
- Updated dependencies [350833d]
- Updated dependencies [049b25e]
- Updated dependencies [7328ec4]
- Updated dependencies [d77aedc]
- Updated dependencies [92f606b]
- Updated dependencies [b07fb90]
- Updated dependencies [56f440b]
- Updated dependencies [f5503fd]
- Updated dependencies [4505d13]
- Updated dependencies [f24f196]
- Updated dependencies [cc8106d]
- Updated dependencies [753b3cd]
- Updated dependencies [ab51ace]
- Updated dependencies [dc2c367]
- Updated dependencies [c11a9b4]
- Updated dependencies [8aa72a1]
- Updated dependencies [037c3c4]
- Updated dependencies [5e64d94]
- Updated dependencies [344995f]
- Updated dependencies [c0c9679]
- Updated dependencies [286a5ad]
- Updated dependencies [918a960]
- Updated dependencies [44c16c9]
- Updated dependencies [f141c18]
- Updated dependencies [7f7ccee]
- Updated dependencies [25bfb06]
- Updated dependencies [5feb5b8]
- Updated dependencies [f0f20c2]
- Updated dependencies [605d41d]
- Updated dependencies [6234fdf]
- Updated dependencies [115ed96]
- Updated dependencies [952f2f0]
- Updated dependencies [b19a904]
- Updated dependencies [95cedd9]
- Updated dependencies [847ecbf]
- Updated dependencies [bd95a2c]
- Updated dependencies [422326b]
- Updated dependencies [6f3c5b4]
- Updated dependencies [fa8eea4]
- Updated dependencies [be64cc8]
- Updated dependencies [ae4a089]
- Updated dependencies [ac94fc6]
- Updated dependencies [3a9e51d]
- Updated dependencies [0026f76]
- Updated dependencies [86eb935]
- Updated dependencies [fccf65b]
- Updated dependencies [65f3fdc]
- Updated dependencies [3cca753]
- Updated dependencies [28c3ab5]
- Updated dependencies [97ba64a]
- Updated dependencies [6542499]
- Updated dependencies [d808f9d]
- Updated dependencies [51d2d51]
- Updated dependencies [7b1505b]
- Updated dependencies [b0eb7c7]
- Updated dependencies [8c1acbd]
- Updated dependencies [683bd47]
- Updated dependencies [99da854]
- Updated dependencies [c80ce21]
- Updated dependencies [589087a]
- Updated dependencies [50d0153]
- Updated dependencies [b8fdd47]
- Updated dependencies [9b96858]
- Updated dependencies [1b201e5]
- Updated dependencies [713cf3b]
- Updated dependencies [8a1dad8]
- Updated dependencies [3bd0a5a]
- Updated dependencies [e030c39]
- Updated dependencies [abb5e10]
- Updated dependencies [facdc89]
- Updated dependencies [87e0994]
- Updated dependencies [87a375e]
- Updated dependencies [4afb5cf]
- Updated dependencies [62885fe]
- Updated dependencies [525847a]
- Updated dependencies [b65ed66]
- Updated dependencies [76e734f]
- Updated dependencies [7e88b45]
- Updated dependencies [70fd27f]
- Updated dependencies [8e19e13]
- Updated dependencies [6d10475]
- Updated dependencies [0e0a46c]
- Updated dependencies [a144d94]
- Updated dependencies [913c441]
- Updated dependencies [377c684]
  - @croco/framework-context@0.1.0
  - @croco/problems-core@1.0.0
  - @croco/diagnostics-core@0.1.0

## 0.0.4

### Patch Changes

- 2ceb6c4: - Stabilize parallel EventPublisher validation under CI timer variance.
- 38727f9: Reset active event bus subscriptions on bus replacement so restart resolves handlers against the current lifecycle.
- b524ca3: Deserialized events now preserve the serialized event id and occurrence timestamp across event-field and fromPayload reconstruction paths.
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- ac9118b: Add a first-class Croco application testing harness with HTTP, event dispatch, request context, transaction, and telemetry helpers, and generate an API sample test that uses it.
- Updated dependencies [4d8f094]
- Updated dependencies [6769a7f]
- Updated dependencies [d281518]
- Updated dependencies [0b43229]
- Updated dependencies [ee924c0]
- Updated dependencies [5403360]
- Updated dependencies [e12e825]
- Updated dependencies [6831875]
- Updated dependencies [9cd8667]
- Updated dependencies [2f0dae2]
- Updated dependencies [ddfc6d1]
- Updated dependencies [a61dcd4]
- Updated dependencies [4c7fcd9]
- Updated dependencies [1dc1607]
- Updated dependencies [8c5b00c]
- Updated dependencies [48ce207]
- Updated dependencies [6c26eb4]
- Updated dependencies [f8842d3]
- Updated dependencies [d707a0c]
- Updated dependencies [9c2ac20]
- Updated dependencies [de7610e]
- Updated dependencies [14bd9f8]
- Updated dependencies [0618b12]
- Updated dependencies [41ee87a]
- Updated dependencies [c54e7b5]
- Updated dependencies [d1552a5]
- Updated dependencies [3ca4a69]
  - @croco/diagnostics-core@0.0.4
  - @croco/framework-context@0.0.4
  - @croco/problems-core@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: add self-diagnosing subsystem (@croco/diagnostics-core)
- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
  - @croco/diagnostics-core@0.0.3
  - @croco/framework-context@0.0.3
  - @croco/problems-core@0.0.3
