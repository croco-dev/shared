# @croco/billing-core

## 1.0.0

### Major Changes

- 8630cf3: Polar subscription webhooks now persist previous-state evidence and stable per-event delivery intents atomically with subscription transitions, so retries resume only unpublished events before completing the webhook.

  Billing store adapters must implement the new subscription webhook transition and event-intent persistence methods.
  Polar webhook event publishers must now provide idempotent delivery by stable event ID.

### Minor Changes

- 30bad55: Carry an authoritative payment reason on paid-order events so subscription renewals no longer inflate new MRR and explicit reactivations record reactivation MRR.

  `OrderPaidEvent` consumers must now pass a fifth `reason` argument. Use `subscription_create` for initial activation, `subscription_cycle` for renewal, `subscription_reactivation` only when the provider supplies authoritative reactivation evidence, `subscription_update` for plan-change charges, and `one_time` for non-subscription purchases.

  This contract does not support a mixed-version rolling deployment. Pause and drain old consumers, migrate queued/outbox `OrderPaidEvent` payloads with authoritative provider data, deploy compatible producers and consumers together, then resume consumption. Missing or unknown reasons now fail with `metrics-billing/invalid-order-payment-reason`; do not replay legacy payloads until they have been enriched.

- 2bbb09f: Licensed subscription quantities now converge from committed membership evidence through explicit provider capabilities, versioned reconciliation intents, stale-update protection, and bounded repair scans.
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

- ec75eb4: - feat: make cacheable CI failure equivalence measurable
- ba1974d: Billing providers now expose inspectable checkout and usage capability profiles, provider-neutral
  batch usage receipts and customer meter state, and a stable Problem when runtime-selected
  capabilities are unavailable.

  Provider certification can require checkout and usage independently, while Polar explicitly
  declares that usage delivery is not yet supported.

- bf62995: Require stable checkout idempotency keys, coalesce concurrent equivalent tenant requests, replay completed results from a durable idempotency store, reject reused keys with different checkout inputs, and reconcile Polar sessions through provider operation metadata.
- 8c2b316: Subscriptions now pin an explicit immutable plan version, historical pricing returns identified
  versions, and Polar webhooks reject unknown product and price mappings before persistence.

  Existing subscription records require an explicitly selected matching version reference; migration
  never falls back to the latest published version.

- 986ce2d: Release immutable plan versions through optimistic drafts, deterministic review evidence, scheduled or immediate idempotent publication, and audit-ready lifecycle events. Keep generated DI failure coverage aligned with self-registering controllers.
- dda0a50: Add a typed billing gateway composition token and canonical Polar billing application plugin.
- 0e0a46c: Expose deterministic ContractGraph monetization nodes, edges, provider mapping drift input, and actionable structural diagnostics for billable meters, plan versions, entitlements, and provider capabilities.

### Patch Changes

- b278729: - fix: block critical test tooling advisories
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 34b6c3d: Reject conflicting tenant ownership and keep account lookups coherent when an in-memory billing account moves tenants.
- d29c25b: Preserve billing accounts and tenant/customer mappings when immediately canceling a subscription without orders, including lifecycle reconciliation retries.
- 98b1a17: Repeated order saves now update the existing order within its billing account instead of duplicating paid-order history. Custom billing stores must upsert by billing account and order ID to support webhook retries.
- 523ed8a: Preserve mathematical sign and documented rounding direction when Money divides by negative values.
- 67e0cbe: fix: resolve published package types before runtime conditions
- 7721747: Publish direct Polar delinquency webhooks through a durable subscription-transition reservation so overlapping
  notifications across workers emit once, failed publication remains retryable, and later recovery can open a new
  past-due episode.

  Define webhook failure cleanup as an idempotent removal across reserved, completed, and missing
  reservations so persisted recovery state can safely retry transition-latch cleanup.

- 1c843a5: Preserve runtime class-decorator metadata in published ESM and CJS bundles so Croco can resolve concrete constructor dependencies from installed packages.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- b2eef05: Cancellation events retain the pinned plan version so churn metrics can be recorded after immediate cancellation deletes the subscription. Older events without a plan version continue to use the stored subscription.
- 5f9bddc: Polar webhook retries now acknowledge duplicates only through the typed billing-store contract, while unrelated reservation failures remain retriable without exposing storage details.
- Updated dependencies [4ca14ab]
- Updated dependencies [38cba9c]
- Updated dependencies [b278729]
- Updated dependencies [7008727]
- Updated dependencies [0aa0bf1]
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
- Updated dependencies [b9c981a]
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
- Updated dependencies [2973efe]
- Updated dependencies [daef820]
- Updated dependencies [1f6522c]
- Updated dependencies [9b997bb]
- Updated dependencies [6d81e46]
- Updated dependencies [ec75eb4]
- Updated dependencies [101a7f1]
- Updated dependencies [7aabe26]
- Updated dependencies [1b39af2]
- Updated dependencies [dda0a50]
- Updated dependencies [15e39cc]
- Updated dependencies [03ea9aa]
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
- Updated dependencies [9da1a20]
- Updated dependencies [f467d6b]
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
- Updated dependencies [5d54fb4]
- Updated dependencies [19bdcd1]
- Updated dependencies [16ff048]
- Updated dependencies [6aaafc8]
- Updated dependencies [badfb5c]
- Updated dependencies [a2353be]
- Updated dependencies [affa795]
- Updated dependencies [72fbcd0]
- Updated dependencies [fb810a9]
- Updated dependencies [de05220]
- Updated dependencies [28f6ac8]
- Updated dependencies [c7299d2]
- Updated dependencies [0530556]
- Updated dependencies [350833d]
- Updated dependencies [c29208d]
- Updated dependencies [049b25e]
- Updated dependencies [7328ec4]
- Updated dependencies [d77aedc]
- Updated dependencies [92f606b]
- Updated dependencies [b07fb90]
- Updated dependencies [56f440b]
- Updated dependencies [f5503fd]
- Updated dependencies [e4bfcb2]
- Updated dependencies [4505d13]
- Updated dependencies [f24f196]
- Updated dependencies [cc8106d]
- Updated dependencies [753b3cd]
- Updated dependencies [ab51ace]
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
- Updated dependencies [63a4f8a]
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
- Updated dependencies [7c7fbde]
- Updated dependencies [86eb935]
- Updated dependencies [fccf65b]
- Updated dependencies [65f3fdc]
- Updated dependencies [3cca753]
- Updated dependencies [28c3ab5]
- Updated dependencies [dc6c9bc]
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
- Updated dependencies [d2539a0]
- Updated dependencies [1b201e5]
- Updated dependencies [713cf3b]
- Updated dependencies [8a1dad8]
- Updated dependencies [3bd0a5a]
- Updated dependencies [abb5e10]
- Updated dependencies [57b786f]
- Updated dependencies [facdc89]
- Updated dependencies [87e0994]
- Updated dependencies [87a375e]
- Updated dependencies [3f61772]
- Updated dependencies [4afb5cf]
- Updated dependencies [62885fe]
- Updated dependencies [525847a]
- Updated dependencies [b65ed66]
- Updated dependencies [76e734f]
- Updated dependencies [7e88b45]
- Updated dependencies [9123362]
- Updated dependencies [70fd27f]
- Updated dependencies [8e19e13]
- Updated dependencies [6d10475]
- Updated dependencies [0e0a46c]
- Updated dependencies [a144d94]
- Updated dependencies [913c441]
- Updated dependencies [377c684]
  - @croco/framework-context@0.1.0
  - @croco/events-core@0.1.0
  - @croco/idempotency-core@0.1.1
  - @croco/problems-core@1.0.0
  - @croco/telemetry-api@0.1.1

## 0.0.4

### Patch Changes

- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- Updated dependencies [2ceb6c4]
- Updated dependencies [ee924c0]
- Updated dependencies [5403360]
- Updated dependencies [e12e825]
- Updated dependencies [6831875]
- Updated dependencies [38727f9]
- Updated dependencies [b524ca3]
- Updated dependencies [a61dcd4]
- Updated dependencies [9d6ef7c]
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
- Updated dependencies [ac9118b]
  - @croco/events-core@0.0.4
  - @croco/framework-context@0.0.4
  - @croco/telemetry-api@0.1.0
  - @croco/problems-core@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
  - @croco/events-core@0.0.3
  - @croco/framework-context@0.0.3
  - @croco/problems-core@0.0.3
  - @croco/telemetry-api@0.0.3
