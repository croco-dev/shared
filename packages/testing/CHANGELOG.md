# @croco/testing

## 1.0.0

### Major Changes

- 19bdcd1: Deduplicate QStash retries by verified message identity so each scheduled occurrence shares one durable execution and retry policy.
- 918a960: Reject Problem extensions that could override core fields or fail JSON serialization while preserving nested JSON-safe data. Problem evidence is now immutable after construction, and optional evidence is omitted instead of being emitted as `undefined`.

  Provider HTTP diagnostics now expose `upstreamStatus` instead of the reserved `status` extension. Invitation state uses `invitationStatus`, outbound webhook state uses `deliveryStatus`, and runtime contract mismatch evidence uses `baselineCanonical` and `actualCanonical` instead of `baseline` and `actual`. Consumers that inspect these diagnostic extensions must migrate to the new field names.

### Minor Changes

- 868ea09: Let each Croco application own one isolated DI scope and module lifecycle, retry failed startup from
  the exact pre-attempt provider baseline, inspect one correlated module and dependency graph, and run
  TestKernel without process-global container resets.
  Canonical SaaS templates now bind HTTP application calls to their application-owned runtime, and
  scoped HTTP bootstrap validation ignores unrelated process-global component registrations.
- c1d0ed0: - feat: verify public behavior contracts against executable test evidence
  - test: report generated SaaS bootstrap fidelity against its public route obligations
- cb61f2e: Run bounded deterministic route-contract fuzzing and capability-aware runtime differential checks with replayable failure artifacts, including generated application smoke coverage.
- 2bbb09f: Licensed subscription quantities now converge from committed membership evidence through explicit provider capabilities, versioned reconciliation intents, stale-update protection, and bounded repair scans.
- c008825: Keep accepted Cloudinary uploads addressable across reads, metadata checks, existence checks, and deletion by restricting the provider to the image resource namespace.

  Allow storage provider conformance suites to select a provider-supported upload content type.

  Update Cloudinary Problem metadata for the image-only resource contract.

  Existing video or raw assets uploaded through earlier releases are not reachable through the image-only provider. Operators must inventory and clean up those legacy assets separately through Cloudinary before upgrading.

- c9c1c1d: Provide scoped TestKernel virtual time, seeded IDs and random values, environment snapshots, outbound-call denial, replay metadata, and deterministic leak diagnostics. Retry backoff, task timeouts, and in-memory rate-limit stores can now consume injected time and randomness without global timer or random patches.
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

- 03ea9aa: Plan changed tests from executable assurance artifact impact and record advisory full-suite selection misses before enforcement.
- 00ac668: Require every notification provider to declare its template, idempotency, channel, and outbox capabilities,
  reject contradictory profiles at registration with stable Problems, and preserve the validated profile for
  dispatch and diagnostics. External `NotificationProvider` implementations must add `getCapabilities()` and
  choose every capability value explicitly; no inferred compatibility profile remains.

  Resend and application test providers can verify the same capability contract through the shared notification
  provider conformance suite. The Problems registry now publishes the stable missing-profile, provider-name
  mismatch, and provider-channel mismatch notification codes.

- ba1974d: Billing providers now expose inspectable checkout and usage capability profiles, provider-neutral
  batch usage receipts and customer meter state, and a stable Problem when runtime-selected
  capabilities are unavailable.

  Provider certification can require checkout and usage independently, while Polar explicitly
  declares that usage delivery is not yet supported.

- bf62995: Require stable checkout idempotency keys, coalesce concurrent equivalent tenant requests, replay completed results from a durable idempotency store, reject reused keys with different checkout inputs, and reconcile Polar sessions through provider operation metadata.
- efb33f9: Boot production application definitions in isolated, runner-neutral test kernels with explicit application or adapter fidelity.

  Each kernel now owns its DI instances, event configuration, test transaction evidence, request state, scoped production shutdown hooks, and one-time cleanup lifecycle without replacing the application's production transaction provider. Node and Lambda adapter requests run through their real handler paths without opening a public network port, while the existing lightweight testing app is reported as isolated fidelity.

- 5e886a9: - feat: fence QStash batch continuations with atomic claims and idempotent writer tokens

  Before deploying `@croco/execution-drizzle`, add the nullable continuation column with
  `ALTER TABLE executions ADD COLUMN continuation jsonb;`. Complete this migration before rolling out
  application code that acquires continuation claims.

- f24f196: Provide a runner-neutral ScenarioRuntime for ordered, replayable application failure timelines with virtual time, boundary-level injection, multiplicity assertions, and stable versioned reports. Generated SaaS apps now extend their existing operational catalog with an app-backed checkout commit, response-loss, and idempotent-retry scenario.
- 8c1acbd: Keep committed transaction values successful when after-commit hooks fail, and expose structured degraded delivery
  evidence through `TxManager.runWithOutcome()`. Transactions that schedule after-commit work must now use this
  outcome-returning contract; invitation acceptance returns the committed transaction outcome, and event publication
  rejects non-capturing or late hook registration before delivery work can disappear.
- 8a1dad8: Run optional digest-pinned PostgreSQL and Redis resources before production application bootstrap, inject typed connections into kernel-scoped Croco providers, and retain structured lifecycle, migration, isolation, and cleanup evidence.

  Test kernels now reject rollback-mode evidence for commit-semantic obligations such as after-commit hooks and transactional outbox behavior.

  The generated Problem registry now includes the typed test-resource lifecycle and fidelity diagnostics.

- abb5e10: Publish a runner-neutral `croco.test-evidence/v1` contract, JSON schema, Vitest and Playwright reporters, fidelity validation, flaky-attempt preservation, redaction, and deterministic JSON/Markdown bundles with explicit missing-artifact failures.
- cadc8b7: Provide reusable usage-billing provider conformance coverage for duplicate delivery, bounded partial batches, failure classification, meter state, unavailable capabilities, and opt-in real-provider smoke checks.

### Patch Changes

- 38cba9c: - fix: enforce full strict contract spine
- b278729: - fix: block critical test tooling advisories
- 6795b4d: Allow retry templates, orchestrators, and decorated methods to stop before another attempt when their caller aborts, including while a backoff wait is pending. Custom backoff policies and injected sleepers must declare abort support; existing implementations should opt in after forwarding the signal, otherwise cancellation fails before callback invocation with `retry-core/backoff-cancellation-unsupported`.
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 50c8c7d: Propagate caller cancellation through every asynchronous storage operation, reject pre-aborted calls before provider I/O, and preserve the original abort reason in a stable storage Problem.

  Storage provider conformance now verifies the shared pre-abort contract across adapters.

  Cloudinary server API calls can use a separate validated `apiBaseUrl`, while `uploadBaseUrl` remains scoped to upload intents so server credentials are never redirected to an existing upload proxy.

- 8522b0c: Keep default package tests deterministic while exposing integration, published-package, and live-resource verification through explicit test lanes.
- be7408f: Expose fatal logging through the shared `ILogger` and `LOGGER_TOKEN` contract, including child loggers and Error context,
  while keeping generated bootstrap and built-in no-op loggers contract-complete.
- 67e0cbe: fix: resolve published package types before runtime conditions
- f92404b: Replace Node-only storage bodies with `Uint8Array` and Web `ReadableStream` contracts, preserve provider-native streaming downloads, and expose Node stream conversion through a separate storage-core subpath.
- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- e1ac339: Provider packages can prove stable missing-credential diagnostics, zero live API calls, and secret redaction through one shared conformance contract linked to certification evidence.
- e90e7bc: Enforce deterministic compatibility snapshots for every published export subpath, including conditional code targets and manifest-only assets.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- 4b20808: Generated SaaS apps now verify eight operational failure boundaries and retain deterministic JSON and Markdown recovery evidence for release gates.
- 8c141de: Lock reusable conformance helper entrypoints, case names, and evidence fields as an explicit public testing contract.
- 7e88b45: Reject invalid signed URL expiry values consistently before provider-specific signing and preserve valid expiry values as seconds across every storage adapter.
- Updated dependencies [ff71685]
- Updated dependencies [5f86d80]
- Updated dependencies [8214d67]
- Updated dependencies [5a7fe34]
- Updated dependencies [4ca14ab]
- Updated dependencies [38cba9c]
- Updated dependencies [f3709a6]
- Updated dependencies [98001e1]
- Updated dependencies [b278729]
- Updated dependencies [7008727]
- Updated dependencies [d53e75a]
- Updated dependencies [6795b4d]
- Updated dependencies [8bb215f]
- Updated dependencies [baa5b35]
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
- Updated dependencies [cb36e68]
- Updated dependencies [34b6c3d]
- Updated dependencies [d29c25b]
- Updated dependencies [98b1a17]
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
- Updated dependencies [81ed45b]
- Updated dependencies [26f4b9e]
- Updated dependencies [88c6ce1]
- Updated dependencies [7c632bb]
- Updated dependencies [772a244]
- Updated dependencies [2bbb09f]
- Updated dependencies [00bfe50]
- Updated dependencies [1d12013]
- Updated dependencies [50c8c7d]
- Updated dependencies [d6e9b2d]
- Updated dependencies [dda0a50]
- Updated dependencies [939af32]
- Updated dependencies [3853d82]
- Updated dependencies [935d29f]
- Updated dependencies [583588d]
- Updated dependencies [da978b0]
- Updated dependencies [718ee7d]
- Updated dependencies [2737eaa]
- Updated dependencies [527475f]
- Updated dependencies [b9c981a]
- Updated dependencies [2cc5438]
- Updated dependencies [c008825]
- Updated dependencies [98fcaed]
- Updated dependencies [f647df2]
- Updated dependencies [202fac0]
- Updated dependencies [d1a03e6]
- Updated dependencies [77794c4]
- Updated dependencies [d99ede2]
- Updated dependencies [50db523]
- Updated dependencies [13f74d8]
- Updated dependencies [d2e17ce]
- Updated dependencies [7df16bb]
- Updated dependencies [ea742a4]
- Updated dependencies [7e46a3d]
- Updated dependencies [c1ce071]
- Updated dependencies [8565d48]
- Updated dependencies [639abfe]
- Updated dependencies [0fa2546]
- Updated dependencies [077bb26]
- Updated dependencies [91e7bb6]
- Updated dependencies [008f3f0]
- Updated dependencies [0584573]
- Updated dependencies [e7e4f1c]
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
- Updated dependencies [1b39af2]
- Updated dependencies [1b39af2]
- Updated dependencies [3648511]
- Updated dependencies [dda0a50]
- Updated dependencies [15e39cc]
- Updated dependencies [03ea9aa]
- Updated dependencies [9f681cf]
- Updated dependencies [7d248c5]
- Updated dependencies [00ac668]
- Updated dependencies [9b379dd]
- Updated dependencies [ba1974d]
- Updated dependencies [f11142a]
- Updated dependencies [04ea69c]
- Updated dependencies [558c255]
- Updated dependencies [96b6b80]
- Updated dependencies [523ed8a]
- Updated dependencies [ab4453f]
- Updated dependencies [8522b0c]
- Updated dependencies [be7408f]
- Updated dependencies [969d87e]
- Updated dependencies [6fa6843]
- Updated dependencies [b875cea]
- Updated dependencies [6069742]
- Updated dependencies [210015b]
- Updated dependencies [582b311]
- Updated dependencies [06b597e]
- Updated dependencies [16cc286]
- Updated dependencies [c64b83f]
- Updated dependencies [1255323]
- Updated dependencies [1216b88]
- Updated dependencies [a513c78]
- Updated dependencies [b91d384]
- Updated dependencies [ba6ba75]
- Updated dependencies [05c9c45]
- Updated dependencies [a4eacbf]
- Updated dependencies [76be188]
- Updated dependencies [80ddb00]
- Updated dependencies [d52f81f]
- Updated dependencies [b228e78]
- Updated dependencies [eed5e70]
- Updated dependencies [10f3601]
- Updated dependencies [bf62995]
- Updated dependencies [3bb5093]
- Updated dependencies [6f8080b]
- Updated dependencies [e039e2d]
- Updated dependencies [a90659b]
- Updated dependencies [976a916]
- Updated dependencies [c30879a]
- Updated dependencies [26bcc38]
- Updated dependencies [cfdc20a]
- Updated dependencies [0b5e89b]
- Updated dependencies [afb8544]
- Updated dependencies [7caa3ea]
- Updated dependencies [54f61ee]
- Updated dependencies [3e29376]
- Updated dependencies [1786455]
- Updated dependencies [68eb95a]
- Updated dependencies [3d9e585]
- Updated dependencies [37dab98]
- Updated dependencies [00ec1c5]
- Updated dependencies [a4a5a49]
- Updated dependencies [6d8a31f]
- Updated dependencies [9a03a84]
- Updated dependencies [0ee816f]
- Updated dependencies [67e0cbe]
- Updated dependencies [e3bb85e]
- Updated dependencies [fb10b5f]
- Updated dependencies [a7df589]
- Updated dependencies [8c2b316]
- Updated dependencies [986ce2d]
- Updated dependencies [8630cf3]
- Updated dependencies [31636bb]
- Updated dependencies [edeef70]
- Updated dependencies [7721747]
- Updated dependencies [fcb2c3c]
- Updated dependencies [f92404b]
- Updated dependencies [44fb02d]
- Updated dependencies [1c843a5]
- Updated dependencies [c1dc054]
- Updated dependencies [45882f1]
- Updated dependencies [a8d733b]
- Updated dependencies [425f20a]
- Updated dependencies [2a6e12c]
- Updated dependencies [f0c328e]
- Updated dependencies [c631b69]
- Updated dependencies [20cb828]
- Updated dependencies [796290f]
- Updated dependencies [efb33f9]
- Updated dependencies [157089a]
- Updated dependencies [47b942b]
- Updated dependencies [a458c5c]
- Updated dependencies [8bf1a44]
- Updated dependencies [5d54fb4]
- Updated dependencies [19bdcd1]
- Updated dependencies [16ff048]
- Updated dependencies [061d4bc]
- Updated dependencies [6aaafc8]
- Updated dependencies [badfb5c]
- Updated dependencies [a2353be]
- Updated dependencies [1910ff9]
- Updated dependencies [affa795]
- Updated dependencies [72fbcd0]
- Updated dependencies [f2798d2]
- Updated dependencies [fb810a9]
- Updated dependencies [c7299d2]
- Updated dependencies [0530556]
- Updated dependencies [350833d]
- Updated dependencies [e745cc9]
- Updated dependencies [049b25e]
- Updated dependencies [7328ec4]
- Updated dependencies [d77aedc]
- Updated dependencies [92f606b]
- Updated dependencies [b07fb90]
- Updated dependencies [56f440b]
- Updated dependencies [f5503fd]
- Updated dependencies [54f9a57]
- Updated dependencies [f2094bc]
- Updated dependencies [e4bfcb2]
- Updated dependencies [4505d13]
- Updated dependencies [c5eee6e]
- Updated dependencies [f24f196]
- Updated dependencies [cc8106d]
- Updated dependencies [90133b3]
- Updated dependencies [7d177a1]
- Updated dependencies [a2760e3]
- Updated dependencies [753b3cd]
- Updated dependencies [e97f694]
- Updated dependencies [ab51ace]
- Updated dependencies [5575357]
- Updated dependencies [524f00c]
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
- Updated dependencies [41108e6]
- Updated dependencies [115ed96]
- Updated dependencies [952f2f0]
- Updated dependencies [1b8b1d6]
- Updated dependencies [cd5fffd]
- Updated dependencies [a8bc534]
- Updated dependencies [63a4f8a]
- Updated dependencies [5c7c332]
- Updated dependencies [1a209ad]
- Updated dependencies [b19a904]
- Updated dependencies [95cedd9]
- Updated dependencies [1d5ed40]
- Updated dependencies [847ecbf]
- Updated dependencies [bd95a2c]
- Updated dependencies [422326b]
- Updated dependencies [6f3c5b4]
- Updated dependencies [d49daac]
- Updated dependencies [fa8eea4]
- Updated dependencies [be64cc8]
- Updated dependencies [ae4a089]
- Updated dependencies [ac94fc6]
- Updated dependencies [3a9e51d]
- Updated dependencies [0026f76]
- Updated dependencies [f22f68f]
- Updated dependencies [7c7fbde]
- Updated dependencies [86eb935]
- Updated dependencies [fccf65b]
- Updated dependencies [65f3fdc]
- Updated dependencies [dda0a50]
- Updated dependencies [3cca753]
- Updated dependencies [4fe1d1e]
- Updated dependencies [28c3ab5]
- Updated dependencies [b2eef05]
- Updated dependencies [aa19802]
- Updated dependencies [6754896]
- Updated dependencies [dc6c9bc]
- Updated dependencies [97ba64a]
- Updated dependencies [6542499]
- Updated dependencies [d808f9d]
- Updated dependencies [ea4d1d1]
- Updated dependencies [51d2d51]
- Updated dependencies [7b1505b]
- Updated dependencies [b0eb7c7]
- Updated dependencies [8c1acbd]
- Updated dependencies [aefe86a]
- Updated dependencies [683bd47]
- Updated dependencies [99da854]
- Updated dependencies [746c954]
- Updated dependencies [c80ce21]
- Updated dependencies [589087a]
- Updated dependencies [50d0153]
- Updated dependencies [b8fdd47]
- Updated dependencies [9b96858]
- Updated dependencies [d2539a0]
- Updated dependencies [5f9bddc]
- Updated dependencies [1b201e5]
- Updated dependencies [713cf3b]
- Updated dependencies [8a1dad8]
- Updated dependencies [3bd0a5a]
- Updated dependencies [e030c39]
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
- Updated dependencies [4daea01]
- Updated dependencies [0e0a46c]
- Updated dependencies [a144d94]
- Updated dependencies [4f125b6]
- Updated dependencies [913c441]
- Updated dependencies [377c684]
  - @croco/openapi-spec@0.1.1
  - @croco/llm-core@1.0.0
  - @croco/transports-http@0.1.0
  - @croco/framework-context@0.1.0
  - @croco/events-core@0.1.0
  - @croco/problems-core@1.0.0
  - @croco/telemetry-api@0.1.1
  - @croco/auth-core@0.1.0
  - @croco/billing-core@1.0.0
  - @croco/framework-routes@0.0.5
  - @croco/protocols-core@0.2.0
  - @croco/ratelimit-core@0.1.0
  - @croco/diagnostics-core@0.1.0
  - @croco/events-inmemory@0.1.0
  - @croco/framework-logger@0.0.5
  - @croco/storage-core@1.0.0

## 0.0.1

### Patch Changes

- 6769a7f: - fix: enforce core coverage spine baseline
- ca4c15a: - Expose shared auth provider conformance coverage with readiness diagnostics for Better Auth and Clerk adapters.
- 5403360: HTTP apps now expose a DI bootstrap validation policy that fails fast by default, with explicit warn/off migration modes for legacy unregistered providers.
- 6e165ab: Expose a shared Drizzle provider conformance suite and record initial metering and execution provider evidence for schema, transaction, tenant, and deterministic error gates.
- 513188f: Drizzle-backed SaaS adapters now publish shared conformance evidence and redacted readiness diagnostics before beta maturity.
- f8842d3: - Generated SaaS and AI SaaS apps now include failure drill smoke scripts backed by deterministic `@croco/testing` scenarios for Problem, recovery, telemetry, and audit evidence.
- 15482d7: LLM usage governance now has provider conformance coverage, versioned pricing registries, quota enforcement, and generated SaaS smoke evidence.
- 0ee7f3e: Provide the first-party OpenAI LLM provider with mocked conformance coverage, deterministic Problem normalization, telemetry events, metering-compatible usage mapping, env-gated live smoke verification, and abort-aware LLM provider conformance.
- 9fb9db9: Add billing provider conformance coverage, Polar readiness diagnostics, and stable Polar gateway failure Problems.
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- 0352ccb: Add provider conformance matrix profiles for required and optional adapter capabilities.
- f27c1dd: Storage providers now share a conformance suite that verifies object lifecycle, metadata, key validation, and URL behavior.
- 14bd9f8: - Runtime capability manifests can now be emitted and compared for Node, Lambda, and Cloudflare Workers with deterministic `RuntimeCapabilityManifest v1` output.
  - Unsupported runtime capability use now carries the stable `CROCO_RUNTIME_CAPABILITY_001` diagnostic context.
  - Generated apps now write `croco-runtime-capability.manifest.json`, and doctor/smoke checks validate the manifest for supported runtime targets.
- 0618b12: Runtime capability support now includes explicit filesystem, Node API, and request lifecycle flags for Node, Lambda, and Cloudflare Workers request contexts.
- ac9118b: Add a first-class Croco application testing harness with HTTP, event dispatch, request context, transaction, and telemetry helpers, and generate an API sample test that uses it.
- 817218a: All Upstash Redis and QStash adapters now run reusable conformance coverage with redacted provider Problems and no-credential default test paths.
- Updated dependencies [4d8f094]
- Updated dependencies [6769a7f]
- Updated dependencies [d281518]
- Updated dependencies [2ceb6c4]
- Updated dependencies [51b0f14]
- Updated dependencies [a77425f]
- Updated dependencies [8b28607]
- Updated dependencies [2a9d5b0]
- Updated dependencies [2631037]
- Updated dependencies [529c7fd]
- Updated dependencies [6148ed3]
- Updated dependencies [779fa6f]
- Updated dependencies [0b43229]
- Updated dependencies [ee924c0]
- Updated dependencies [5403360]
- Updated dependencies [e12e825]
- Updated dependencies [6831875]
- Updated dependencies [9cd8667]
- Updated dependencies [2f0dae2]
- Updated dependencies [ddfc6d1]
- Updated dependencies [9c1bc2e]
- Updated dependencies [38727f9]
- Updated dependencies [b524ca3]
- Updated dependencies [4e39dc6]
- Updated dependencies [a61dcd4]
- Updated dependencies [9d6ef7c]
- Updated dependencies [0b49816]
- Updated dependencies [da861c8]
- Updated dependencies [e108899]
- Updated dependencies [c0c7215]
- Updated dependencies [42bc50e]
- Updated dependencies [9f7e769]
- Updated dependencies [15482d7]
- Updated dependencies [6ab7784]
- Updated dependencies [000e999]
- Updated dependencies [2977874]
- Updated dependencies [9ae8ab8]
- Updated dependencies [8a85c6a]
- Updated dependencies [9556d22]
- Updated dependencies [f40eb63]
- Updated dependencies [a61dcd4]
- Updated dependencies [4c7fcd9]
- Updated dependencies [1dc1607]
- Updated dependencies [8c5b00c]
- Updated dependencies [48ce207]
- Updated dependencies [6c26eb4]
- Updated dependencies [f8842d3]
- Updated dependencies [b6449cc]
- Updated dependencies [9a2040b]
- Updated dependencies [d707a0c]
- Updated dependencies [58b689a]
- Updated dependencies [eeebc70]
- Updated dependencies [cac7e99]
- Updated dependencies [aacdad6]
- Updated dependencies [9c2ac20]
- Updated dependencies [de7610e]
- Updated dependencies [14bd9f8]
- Updated dependencies [0618b12]
- Updated dependencies [41ee87a]
- Updated dependencies [c54e7b5]
- Updated dependencies [a3458cc]
- Updated dependencies [d1552a5]
- Updated dependencies [3ca4a69]
- Updated dependencies [0e7dd10]
- Updated dependencies [bb59160]
- Updated dependencies [ac9118b]
- Updated dependencies [7442f1c]
- Updated dependencies [bc5594d]
  - @croco/diagnostics-core@0.0.4
  - @croco/transports-http@0.0.4
  - @croco/openapi-spec@0.1.0
  - @croco/storage-core@0.0.4
  - @croco/events-core@0.0.4
  - @croco/framework-context@0.0.4
  - @croco/events-inmemory@0.0.4
  - @croco/telemetry-api@0.1.0
  - @croco/llm-core@0.0.4
  - @croco/problems-core@0.0.4
  - @croco/auth-core@0.0.4
  - @croco/billing-core@0.0.4
  - @croco/framework-logger@0.0.4
  - @croco/ratelimit-core@0.0.4

## 0.0.0

Initial package placeholder. Published versions are managed by Changesets.
