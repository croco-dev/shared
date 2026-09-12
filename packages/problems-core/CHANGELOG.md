# @croco/problems-core

## 1.0.0

### Major Changes

- 918a960: Reject Problem extensions that could override core fields or fail JSON serialization while preserving nested JSON-safe data. Problem evidence is now immutable after construction, and optional evidence is omitted instead of being emitted as `undefined`.

  Provider HTTP diagnostics now expose `upstreamStatus` instead of the reserved `status` extension. Invitation state uses `invitationStatus`, outbound webhook state uses `deliveryStatus`, and runtime contract mismatch evidence uses `baselineCanonical` and `actualCanonical` instead of `baseline` and `actual`. Consumers that inspect these diagnostic extensions must migrate to the new field names.

### Minor Changes

- 319d43e: Keep the first Clerk organization tenant claim authoritative under concurrent registration. Custom
  `TenantMappingStore` adapters must replace `set()` with an atomic create-if-absent `claim()` and can
  verify separate clients against the shared conformance suite.
- 2bbb09f: Licensed subscription quantities now converge from committed membership evidence through explicit provider capabilities, versioned reconciliation intents, stale-update protection, and bounded repair scans.
- c9c1c1d: Provide scoped TestKernel virtual time, seeded IDs and random values, environment snapshots, outbound-call denial, replay metadata, and deterministic leak diagnostics. Retry backoff, task timeouts, and in-memory rate-limit stores can now consume injected time and randomness without global timer or random patches.
- 03ea9aa: Plan changed tests from executable assurance artifact impact and record advisory full-suite selection misses before enforcement.

### Patch Changes

- 38cba9c: - fix: enforce full strict contract spine
- 6795b4d: Allow retry templates, orchestrators, and decorated methods to stop before another attempt when their caller aborts, including while a backoff wait is pending. Custom backoff policies and injected sleepers must declare abort support; existing implementations should opt in after forwarding the signal, otherwise cancellation fails before callback invocation with `retry-core/backoff-cancellation-unsupported`.
- fe51253: Align Data Map field export and delete flags with resource capabilities, preserve explicit exclusions for supported handlers, and reject contradictory field declarations with a stable diagnostic.
- 868ea09: Let each Croco application own one isolated DI scope and module lifecycle, retry failed startup from
  the exact pre-attempt provider baseline, inspect one correlated module and dependency graph, and run
  TestKernel without process-global container resets.
  Canonical SaaS templates now bind HTTP application calls to their application-owned runtime, and
  scoped HTTP bootstrap validation ignores unrelated process-global component registrations.
- c1d0ed0: - feat: verify public behavior contracts against executable test evidence
  - test: report generated SaaS bootstrap fidelity against its public route obligations
- d7b2bde: API key rotation now atomically revokes the old credential, replays the same protected replacement for idempotent retries, and durably recovers post-commit rotation events.

  Custom `ApiKeyStore` adapters must implement atomic rotation plus event claim, completion, and release operations. Callers must provide an idempotency key and configure an `ApiKeyRotationProtector`.

  Deploy the rotation schema first, pause rotation traffic, drain every instance using the legacy save-then-revoke path, deploy the new writers, and only then resume rotation. Mixed legacy and atomic rotation writers are not supported.

- 269d9df: Execution stores now merge individual checkpoint keys atomically as part of their required contract. Concurrent writes to different keys are preserved. Same-key writes are serialized by the store with the last applied mutation winning, without an invocation-order guarantee.
- 1380ce5: Preserve concurrent onboarding step completions and emit the overall completion transition once.
- 64af41f: Expose position-consistent tenant credit operations with allocation evidence, permission-safe
  references, audited append-only adjustments, and an in-memory generated admin example.
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- c91a72b: Verify AuthGuard conformance with explicit provider-unavailable Problems, generated REST/GraphQL protected-route smoke coverage, and a patched Better Auth provider dependency.
- 30bad55: Carry an authoritative payment reason on paid-order events so subscription renewals no longer inflate new MRR and explicit reactivations record reactivation MRR.

  `OrderPaidEvent` consumers must now pass a fifth `reason` argument. Use `subscription_create` for initial activation, `subscription_cycle` for renewal, `subscription_reactivation` only when the provider supplies authoritative reactivation evidence, `subscription_update` for plan-change charges, and `one_time` for non-subscription purchases.

  This contract does not support a mixed-version rolling deployment. Pause and drain old consumers, migrate queued/outbox `OrderPaidEvent` payloads with authoritative provider data, deploy compatible producers and consumers together, then resume consumption. Missing or unknown reasons now fail with `metrics-billing/invalid-order-payment-reason`; do not replay legacy payloads until they have been enriched.

- 121b830: Require callers to hold the exact global `impersonation:manage` permission and match the session's original impersonator before ending an impersonation session. Denied termination attempts leave the session unchanged.

  This changes `ImpersonationService.end(sessionId)` to `end(context, sessionId)` so termination can resolve and authorize the caller.

  Custom `ImpersonationStore` implementations must use the atomic `commitEnd(intent, impersonatorId)` operation.
  It returns `committed`, `committed-start-pending`, `session-not-found`, or `actor-mismatch`, and an actor mismatch
  must preserve both the session and its pending lifecycle event intent.

- 0e658fc: Batch built-in PostgreSQL bulk indexing into bounded set-based writes with transactional rollback and safe partial-failure attribution.
- 34b6c3d: Reject conflicting tenant ownership and keep account lookups coherent when an in-memory billing account moves tenants.
- cb61f2e: Run bounded deterministic route-contract fuzzing and capability-aware runtime differential checks with replayable failure artifacts, including generated application smoke coverage.
- 13cfab4: Bound Node-hosted GraphQL request lifetimes with configurable execution cancellation, stable timeout Problems, and client-disconnect cleanup.
- f05e38e: Bound health transition persistence retries and surface typed exhaustion diagnostics.
- ade3461: Bound lifecycle webhook actions with a configurable timeout and report timeout failures distinctly from network errors.
- e9e2d49: Bound and redact malformed optional JSON response evidence while preserving content type and truncation metadata.
- d0ed66c: Execute bounded retries for classified transient provider failures while preserving abort and streaming replay boundaries.
- 9404839: Reject unsafe runtime inspector retention and redaction limits before collecting operational data.
- 2d74ff8: Bound concurrent telemetry shutdown calls, let timed-out callers rejoin the same teardown, safely reinitialize only after OpenTelemetry global state is released, and keep generated operational failure drills explicit about their telemetry lifecycle.
- b07ae3a: Generate real-browser React component tests, fail-closed MSW API fixtures, Playwright user journeys, and sharded browser CI evidence for production and admin application starters, with the generated frontend failure registered in the shared Problem catalog.
- 5d08b1b: Resolve entitlement and overage policies from immutable subscription plan versions while preserving an explicit legacy plan-ID migration path.
- 99ace13: Add durable billable usage journal contracts, fenced delivery state transitions, bootstrap validation, and backlog diagnostics.
- 08cfa9b: Provide an append-only usage-credit ledger with exact decimal amounts, atomic reservation settlement, deterministic lot allocation and expiry, linked refunds, stable Problems, post-commit events, and a reusable store conformance suite.
- 1084825: Reject continuation lease durations that could expire immediately or exceed supported timer bounds.
- 26f4b9e: Expose request cancellation signals through runtime context and keep abort-signal capabilities aligned with adapter support.
- 88c6ce1: Metering retries now resume an explicit pending-event stage, preserve logical event identities, and recover publication
  failures without recording usage twice.

  Custom `UsageStorage` implementations must declare `replayContract: "idempotent"` and replay the original quota result
  for a repeated idempotency key. Redis clients must explicitly declare multi-key script support.

- 7c632bb: Reject TelemetryRuntime initialization requests that conflict with the singleton runtime's active configuration.
- 772a244: Publish provider-neutral monetization signals, atomic usage-threshold crossings, and opt-in versioned retention recipes with capability diagnostics.
- 1d12013: Only reuse completed workflow executions. Reject concurrent pending or running executions with a conflict Problem, preserve stored failures when a failed or timed-out execution is requested again, and reject other states that cannot be reused. Keep retryable workflow resumption unchanged.
- 50c8c7d: Propagate caller cancellation through every asynchronous storage operation, reject pre-aborted calls before provider I/O, and preserve the original abort reason in a stable storage Problem.

  Storage provider conformance now verifies the shared pre-abort contract across adapters.

  Cloudinary server API calls can use a separate validated `apiBaseUrl`, while `uploadBaseUrl` remains scoped to upload intents so server credentials are never redirected to an existing upload proxy.

- d6e9b2d: Allow callers to cancel every LLM generation, tool, and embedding operation with a shared AbortSignal contract.
- 939af32: Generate deterministic, type-preserving decorator cache keys, make namespace eviction target the matching argument entry,
  and reject unsupported argument graphs with a typed Problem.

  External cache entries created with the previous argument serializer must be repopulated after upgrading. For mutations
  that can invalidate multiple argument-derived entries, use a wildcard `key` or `allEntries: true`.

- 3853d82: - Reject GID prefixes outside the canonical 3-32 character lowercase ASCII alphanumeric grammar.
- 935d29f: Bind search transform option contracts to canonical registration references and reject conflicting adapter IDs without replacing the registered adapter.
- 583588d: Generated Drizzle dependencies now follow the workspace catalog range across DDD and SaaS scaffolds.
- da978b0: Keep `defineIdPrefixes()` registries safe to inspect by replacing the throwing `Id` property with the type-only `IdOf<TEntry>` helper.

  Migrate `typeof Ids.USER.Id` to `IdOf<typeof Ids.USER>`. The retired `gid-core/id-type-only-property` Problem code remains registered as deprecated migration metadata.

- 718ee7d: Compensate partially initialized modules and restore provider state when bootstrap fails.
- 527475f: Expose a side-effect-free root command factory and in-process runner with injectable IO, working directory, environment, and structured exit results.
- 2cc5438: Reject shutdown hook registration after shutdown starts with lifecycle-state diagnostics.
- c008825: Keep accepted Cloudinary uploads addressable across reads, metadata checks, existence checks, and deletion by restricting the provider to the image resource namespace.

  Allow storage provider conformance suites to select a provider-supported upload content type.

  Update Cloudinary Problem metadata for the image-only resource contract.

  Existing video or raw assets uploaded through earlier releases are not reachable through the image-only provider. Operators must inventory and clean up those legacy assets separately through Cloudinary before upgrading.

- 98fcaed: Route document and binary keys to Cloudinary raw resources and video/audio keys to video resources, preserving their namespace across uploads, upload intents, URLs, reads, metadata, and deletion.

  Keep generated Problem registry source references aligned with the Cloudinary upload validation contract.

- f647df2: - fix(codegen): compile controller contracts with the application TypeScript config
- d1a03e6: Keep committed transaction results successful when deadlines expire during commit responses, run after-commit delivery
  outside transaction timeout semantics, and classify indeterminate post-deadline adapter failures explicitly.
- 77794c4: Aggregate, fetch, and delete billing-cycle usage across every UTC month partition intersecting an inclusive query range, and reject unsafe ranges with a typed validation Problem.
- d99ede2: Compose REST RPC and Meta Vite server actions into one deterministic frontend action manifest while rejecting schema mismatches and conflicting duplicate action identities before output replacement.
- 50db523: Make access decisions authoritative and statically consistent: allow results always carry
  `allowed: true`, while deny and abstain results always carry `allowed: false` across the engine,
  Drizzle provider, guards, and generated SaaS provider.
- 7df16bb: Register REST controllers with the DI container automatically while preserving explicit component scopes.
  Generated applications now use `@Controller` as the single controller registration convention.
- ea742a4: Pass phase-aware cancellation signals and absolute deadlines to module lifecycle hooks, with distinct parent-cancellation, deadline, and invalid-deadline Problems.
- 7e46a3d: Persist credit ledger commands atomically through `TxManager` with PostgreSQL row locking, deterministic
  history, bounded lot processing, durable idempotency, and database-enforced account isolation.
- 0fa2546: Generate deterministic DI graph manifests through the CLI and generated app verification scripts.
- 077bb26: Return stable structural diagnostics and fail-closed capability artifacts for malformed governance resources instead of raw TypeErrors.
- 91e7bb6: Allow in-memory impersonation session expiry to use an instance-scoped clock, reject invalid clock values, and preserve system time by default.
- 0584573: Reject duplicate onboarding definition IDs without replacing the original completion contract.
- 500c048: Compose configured auth, transaction, HTTP, telemetry, and diagnostics plugins through one application-owned module graph with explicit provider replacement and deterministic multi-contribution semantics.
- 09c48b3: Preserve the Problem code alongside the HTTP and body statuses when rejecting mismatched Problem responses.
- 2973efe: Allow hosts to close in-memory event intake, release backpressure waiters, and observe bounded handler drain outcomes through an optional EventBus lifecycle contract and framework shutdown hook.
- daef820: - Reject dynamically constructed ID registries when multiple keys use the same serialized prefix, with the
  duplicate-prefix Problem included in the public registry.
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

- 9b997bb: - fix: deduplicate verified Clerk webhook deliveries through a caller-provided idempotency store
- 6d81e46: Persist tenant-scoped contact endpoints, preferences, suppressions, logical dispatch outcomes, and
  normalized delivery evidence so policy decisions and terminal endpoint invalidation survive restarts.
- ec75eb4: - feat: make cacheable CI failure equivalence measurable
- 101a7f1: Enforce configured impersonation action deny lists and reject missing or malformed configuration with stable diagnostics.
- 7aabe26: Add Customer 360 and campaign delivery operations contracts, accessible console panels, admin-ops timeline and retry console adapters, and generated app example.
- dda0a50: Generate the Node/Postgres SaaS profile as an executable canonical plugin graph, run the selected graph at application bootstrap, release its application-owned PostgreSQL pool through canonical module shutdown, and expose explicit production, local replacement, unavailable, and documentation-only capability states.

  Register stable Problem codes for provider-profile mismatches and unavailable runtimes.

- 15e39cc: Require complete algorithm-specific rate-limit policies while preserving omitted-algorithm fixed-window inputs, and register the internal exhaustive-policy diagnostic.
- 7d248c5: Expose host, transport, and build-target composition as separate runtime metadata, bind host callbacks
  to their owning application scope, preserve the legacy Cloudflare handler context, and teach generated
  apps and presentation adapters to use explicit host and build-target entry points. Generated Lambda and
  Cloudflare SaaS apps now advertise commands that validate their actual deployment targets, including a
  Wrangler configuration with explicit Node.js compatibility for the generated Worker composition. Raw
  Hono callbacks must explicitly select raw-Hono dispatch when using the canonical Cloudflare host.

  Generated SaaS hosts await provider initialization and leave telemetry shutdown to the application
  runtime. Lambda and Workers host artifacts do not enable their documentation-only SaaS provider
  composition; invoking those profiles still reports `CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE`.

- 00ac668: Require every notification provider to declare its template, idempotency, channel, and outbox capabilities,
  reject contradictory profiles at registration with stable Problems, and preserve the validated profile for
  dispatch and diagnostics. External `NotificationProvider` implementations must add `getCapabilities()` and
  choose every capability value explicitly; no inferred compatibility profile remains.

  Resend and application test providers can verify the same capability contract through the shared notification
  provider conformance suite. The Problems registry now publishes the stable missing-profile, provider-name
  mismatch, and provider-channel mismatch notification codes.

- 9b379dd: Fail explicitly when requested RLS debug logging cannot initialize or write, and allow applications to inject the logger used by the adapter.
- ba1974d: Billing providers now expose inspectable checkout and usage capability profiles, provider-neutral
  batch usage receipts and customer meter state, and a stable Problem when runtime-selected
  capabilities are unavailable.

  Provider certification can require checkout and usage independently, while Polar explicitly
  declares that usage delivery is not yet supported.

- 04ea69c: Fail closed with a stable Problem when an execution adapter cannot provide a valid route metadata target.
- 558c255: Reject module registration while the registry is initializing, initialized, or shutting down with an actionable lifecycle conflict Problem, while preserving reset-based graph replacement.
- 96b6b80: Require email invitation creation idempotency keys and keep invitations non-accepting until claimed event and notification phases complete, so acknowledgement loss, retries, and concurrent requests reuse one invitation and token without exposing contradictory pending state. Replay tokens are application-encrypted in Drizzle, and notification delivery can now require provider-level idempotency support. Custom invitation stores must implement the new atomic creation, claim, activation, and cleanup methods; Drizzle consumers must apply the included creation-intent migration and configure a token cipher before deploying.
- 969d87e: Persist an indeterminate action-dispatch boundary before lifecycle adapters run, retain ambiguous finalization evidence for reconciliation, prevent automatic replay after external actions may have completed, and surface reconciliation-required runs distinctly in operator consoles.
- 6fa6843: Timed-out task attempts now block retry and replay until the abandoned handler settles, an explicit idempotent or fenced contract permits overlap, or an operator records recovery. Croco-managed task results use atomic attempt tokens so stale attempts cannot commit a newer run.
- 6069742: Keep gross revenue retention within 0–100 and reject negative or non-finite churn and contraction amounts with a public validation Problem.
- 210015b: - chore: regenerate problem-code-registry after source line shifts
- 1255323: Read stored Cloudflare Images through the authenticated base blob API instead of a delivery variant.
- 1216b88: Reject duplicate tRPC domain and procedure registrations with diagnostics for both source routes.
- b91d384: Reject tenant-scoped governance resources that omit an identifier-backed tenant field, while preserving documented custom identifier overrides in Data Map artifacts.
- ba6ba75: GraphQL Problem errors now apply the shared Croco redaction policy, with declared policy metadata available in GraphQL contract snapshots.
- 05c9c45: Convert every Node GraphQL request-boundary failure into a complete redacted Problem response with phase-specific diagnostics.
- 76be188: Expose optional, required, and parser-validated page data hooks so missing or unvalidated hydration data is explicit at each call site.
- d52f81f: Make HTTP middleware short-circuit semantics explicit with a `shortCircuit(reason)` marker, stable middleware diagnostics, and runtime inspection details for short-circuit outcomes.

  The legacy `transports-http/middleware-next-called-multiple-times` compatibility code now maps to the new `CROCO_HTTP_MIDDLEWARE_002` multiple-next diagnostic and is classified as not retryable.

- b228e78: Enforce registry-backed Problem redaction at the HTTP response boundary and document the public extension allowlist.
- eed5e70: Execute global, class, and method HTTP pipes against handler arguments before controller invocation, route pipe failures through the standard Problem flow, and expose pipe stages in request pipeline graphs.
- 10f3601: Record commit-stage failures as non-retryable so repeated keys never re-run completed handler side effects, and expose
  `idempotency-core/execution-indeterminate` for the resulting recovery state.
- bf62995: Require stable checkout idempotency keys, coalesce concurrent equivalent tenant requests, replay completed results from a durable idempotency store, reject reused keys with different checkout inputs, and reconcile Polar sessions through provider operation metadata.
- 3bb5093: Honor idempotent tenant mapping registration and report conflicting remaps as a stable Problem.
- 6f8080b: Reject ambiguous in-memory event concurrency and backpressure timeout values before publishing events.
- e039e2d: Keep in-memory lifecycle claims and run evidence stable when callers mutate stored inputs or returned results, and
  report unsupported action metadata through a typed lifecycle Problem without retaining a partial snapshot.
- c30879a: Allow callers to create, diagnose, shut down, reset, and dispose isolated module runtimes without sharing module names, lifecycle state, provider instances, or process-global provider fallbacks, while keeping `CrocoModule` as the compatible default-runtime facade.
- 26bcc38: Keep in-memory onboarding progress immutable from caller-owned save inputs, loaded status snapshots, and successful completion results, and reject metadata that cannot become an independent snapshot with a stable Problem.
- 0b5e89b: Make bulk repository reads return explicit keyed partial results, and reject duplicate, unexpected, unkeyed, or identity-mismatched batch entries before they can be assigned to callers.

  Custom `ReadRepository` and `AbstractDrizzleRepository` implementations must return `{ key, value }` entries from `findByIds`; omit entries for missing IDs.

- 3d9e585: Expose version-aware lifecycle automation operations, redacted dry-run evidence, run diagnosis, and audited controls in admin React surfaces and the generated admin console.
- 37dab98: Keep PostgreSQL, Redis, and container drivers out of the default runtime and TypeScript install paths while live
  resources report the exact opt-in dependency command when a required driver is missing.
- 00ec1c5: Make Node entry startup and shutdown linearizable so concurrent lifecycle calls cannot leak server listeners.
- a4a5a49: Load migration files from relative, absolute, spaced, and Windows filesystem directories through file URLs.
- 6d8a31f: Generate deterministic least-authority preload bridges for each local desktop window profile.
- 9a03a84: Prevent failed success hooks from retrying an already successful callback, and expose the committed callback state through `RetrySuccessHookProblem`.
- fb10b5f: Validate only explicitly selected runtime environment presets, keep the default `env` app-only, and expose the previous all-integration configuration as `fullEnv` and `fullRuntimeEnvPresets`.
- a7df589: Add durable outbound tenant webhook events, endpoint deliveries, signed attempts, bounded retry and replay policies, secret rotation verification, SSRF-oriented URL validation, in-memory stores, a fake transport, and persistent-store conformance contracts.
- 8c2b316: Subscriptions now pin an explicit immutable plan version, historical pricing returns identified
  versions, and Polar webhooks reject unknown product and price mappings before persistence.

  Existing subscription records require an explicitly selected matching version reference; migration
  never falls back to the latest published version.

- 986ce2d: Release immutable plan versions through optimistic drafts, deterministic review evidence, scheduled or immediate idempotent publication, and audit-ready lifecycle events. Keep generated DI failure coverage aligned with self-registering controllers.
- 8630cf3: Polar subscription webhooks now persist previous-state evidence and stable per-event delivery intents atomically with subscription transitions, so retries resume only unpublished events before completing the webhook.

  Billing store adapters must implement the new subscription webhook transition and event-intent persistence methods.
  Polar webhook event publishers must now provide idempotent delivery by stable event ID.

- 31636bb: Deliver durable, idempotent billable usage to Polar through explicit typed meter bindings and bounded journal workers.
- f92404b: Replace Node-only storage bodies with `Uint8Array` and Web `ReadableStream` contracts, preserve provider-native streaming downloads, and expose Node stream conversion through a separate storage-core subpath.
- 44fb02d: Preserve normalized route entitlement requirements across generated admin resources, actions, and client bindings, require their fingerprints in admin consumer coverage, and keep generated Problem source metadata aligned.
- 1c843a5: Preserve runtime class-decorator metadata in published ESM and CJS bundles so Croco can resolve concrete constructor dependencies from installed packages.
- a8d733b: - fix(transports-http): preserve omitted request bodies for schema validation
- 2a6e12c: Preserve validated forward and backward cursor directions in parsed pagination parameters, and reject invalid or offset-mode direction input with stable diagnostics.
- 796290f: Require deprecated Problem registry entries to include a deprecation reason, migration guidance, and either an active replacement Problem code or an explicit no-replacement reason. Registry checks now fail incomplete lifecycle metadata, and generated recovery cookbook entries surface no-replacement guidance for deprecated Problem codes.
- efb33f9: Boot production application definitions in isolated, runner-neutral test kernels with explicit application or adapter fidelity.

  Each kernel now owns its DI instances, event configuration, test transaction evidence, request state, scoped production shutdown hooks, and one-time cleanup lifecycle without replacing the application's production transaction provider. Node and Lambda adapter requests run through their real handler paths without opening a public network port, while the existing lightweight testing app is reported as isolated fidelity.

- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- 47b942b: tRPC procedures now execute declared Croco guards, interceptors, and filters, and expose redacted Problem details with stable Croco code and status fields. The Problem registry now includes the tRPC guard-denial code.
- a458c5c: Generate a deterministic SaaS metered-overage path with durable provider delivery, duplicate acknowledgement, version-pinned entitlement evidence, billing drift diagnostics, and deployment-time monetization contract canaries.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- 19bdcd1: Deduplicate QStash retries by verified message identity so each scheduled occurrence shares one durable execution and retry policy.
- 16ff048: Reject invalid revoke tuples before provider calls and return 401 for unauthenticated access checks. AccessGuard uses the current request Context user when the request has no user.

  Include `access-core/unauthorized` in the generated Problem code registry.

- 6aaafc8: Reject invalid visibility leases before outbox claim state can change.
- badfb5c: Contain synchronous and asynchronous PostHog identify and group failures with redacted operation-specific diagnostics.
- a2353be: Initialize each application's Zod OpenAPI runtime before evaluating RPC controller schemas, sharing the existing CommonJS and ESM initialization with OpenAPI generation.

  Keep generated Problem source locations aligned with the controller loaders.

- affa795: Return signed multipart fields from direct-upload intents so clients can upload to the requested Cloudinary public ID without receiving the API secret.

  Refresh generated Problem source locations for the corrected provider implementation.

- 72fbcd0: Detect stale committed OpenAPI and RPC outputs without rewriting them, make generated app contract verification use the read-only checks, and scaffold Next.js applications with the patched 15.5.21 release.
- fb810a9: - fix: keep domain auto-join membership and event delivery recoverable
- c7299d2: Persist impersonation lifecycle event intents atomically with session start and end transitions, preserve per-session delivery order across replay, expose pending-event diagnostics, and require lifecycle event publishers to deduplicate by stable event identity.

  Custom impersonation stores must implement the new atomic transition and ordered event-intent methods. Applications must provide an `ImpersonationLifecycleEventPublisher` when constructing `ImpersonationService`.

- 0530556: Keep completed generation output recoverable when completion-event delivery fails, expose the failure as non-retryable model work, and allow the stable event intent to be retried independently with optional durable intent tracking.

  Keep QStash delivery identity API documentation aligned with the verification input and callback contracts.

- 350833d: Persist health scores with stable transition event intents, retry unpublished transitions from their original snapshots, and require event publishers to deduplicate by event identity.
- 049b25e: Reject canceled Meilisearch mutations with operation and resource context instead of reporting success.
- 7328ec4: Reject repeated health and readiness indicator identities across explicit and legacy registration paths before checks run.

  Registration Problems now report only source-safe identity kinds instead of reflecting caller-supplied indicator IDs or names.
  HTTP health registrations validate before mutating adapter state, and duplicate diagnostics no longer reflect registration names.

- d77aedc: Reject distinct module definitions that share a name before lifecycle execution while preserving identity-based deduplication for repeated references to the same definition.
- 92f606b: Reject outbox message ID reuse across idempotency keys with a stable conflict Problem while preserving the original message and lookup indexes.
- b07fb90: - reject duplicate searchable index declarations with deterministic source evidence before auto-sync event processing
  - expose the searchable index conflict code through the generated Problem registry contract
- 56f440b: Reject malformed relation tuples before access providers can persist them.
- f5503fd: Reject Problem responses whose body status does not match the HTTP status before exposing typed or generic Problem failures.
- 4505d13: - feat: render typed email content from optional React Email components
- f24f196: Provide a runner-neutral ScenarioRuntime for ordered, replayable application failure timelines with virtual time, boundary-level injection, multiplicity assertions, and stable versioned reports. Generated SaaS apps now extend their existing operational catalog with an app-backed checkout commit, response-loss, and idempotent-retry scenario.
- cc8106d: Retain exhausted event handling and handler initialization failures in an opt-in dead-letter queue. Replay only the failed handler with the original event identity and an explicit handler ID that survives rebuilds. DLQ snapshots isolate supported mutable data and reject unsupported values; invalid backpressure strategies fail before execution.
- 753b3cd: Keep scaffold destinations untouched until generation, Git initialization, dependency installation, and lockfile validation succeed, report machine-readable retry commands after failures, and keep the generated Problem registry synchronized with the new scaffold failure locations.
- ab51ace: Separate route contract client inputs, parsed handler inputs, handler return values, and wire response outputs while preserving existing helper aliases. HTTP routes now parse handler returns through their response schema before serialization, and generated RPC clients project request and response schemas according to their lifecycle direction.
- c11a9b4: Preserve named catch-all matching and parameter extraction when routes are registered from generated tables, and
  keep published Problem registry source locations synchronized with the shared route compiler import.
- 037c3c4: Reject unsafe in-memory cache capacity and cleanup interval values before allocating runtime resources.
- 5e64d94: Reject unsafe operational diagnostics response limits before endpoint registration with the stable `transports-http/diagnostics-invalid-configuration` Problem.
- 344995f: Reject unsafe GraphQL request body limits during server initialization with the stable `transports-graphql/body-limit-invalid-configuration` Problem, while preserving an inclusive byte boundary for buffered and streamed requests.
- c0c9679: Reject timeout values that Node.js would clamp before health or diagnostics checks are registered.
- 286a5ad: Reject outbox idempotency-key reuse when the canonical event request differs, including concurrent in-memory and Drizzle appends.
- 44c16c9: Restrict QStash schedule cleanup to canonical schedules carrying the exact namespace ownership label, preserve legacy schedules for migration, and require explicit owned-orphan cleanup mode.
- 7f7ccee: Enforce HTTP body limits against actual streamed bytes while preserving accepted bodies for downstream parsers across Node and Lambda adapters. Publish canonical 413 Payload Too Large contracts for `transports-http/request-body-too-large` and the existing `transports-graphql/request-body-too-large` Problem across registries and transports, while marking the HTTP status as runtime-configurable when `bodyLimitMiddleware.statusCode` overrides its 413 default.
- 25bfb06: Scope every task idempotency key to the task contract, persist canonical request fingerprints, and reject reuse with a
  different execution type or payload. Before deploying `@croco/execution-drizzle`, add
  `executions.request_fingerprint varchar(64) null`, then drain every old task writer before starting the new version.
  Mixed old/new task writers are unsupported because reservation across legacy and scoped keys is not atomic.
- 5feb5b8: Redact unknown internal error messages while preserving declared Croco Problem contracts for tRPC clients, and keep
  generated Problem source metadata aligned with the tRPC adapter.
- f0f20c2: - fix(workflow-core): classify final saga completion store failures distinctly from business step failures so successful work is never compensated
  - chore(problems-core): register the workflow-core saga finalization problem code

- 605d41d: Reject same-key saga requests with `SagaExecutionInFlightProblem` (HTTP 409) while the existing execution is pending or running, including step compensation. Completed results remain reusable, and failed or compensated executions retain their stored failure response.
- 6234fdf: Isolate `@AiMetered` service bindings per execution scope, fail closed when metering is not configured, and require explicit disabled mode for unmetered calls.
- 115ed96: Expose one `SearchOperationOptions.signal` contract across search, document, bulk, and index-management I/O. Built-in adapters now reject pre-aborted work before provider access, and Meilisearch forwards the caller signal through requests and task polling with stable cancellation evidence.
- 952f2f0: Apply validated equality filters, requested sorting, and parameterized limit and offset values across every PostgreSQL search strategy while preserving mandatory tenant isolation and deterministic pagination.
- b19a904: Expose deterministic main registration metadata and versioned semantic handshakes so main, preload, and renderer artifacts can detect graph drift before command execution.
- 95cedd9: Give OpenAPI and RPC generators one REST controller source loader, normalize decorator and parameter locations to project-relative paths, and preserve generator-specific TypeScript diagnostic Problems.
- 847ecbf: Align 1.0 spine package manifests with the checked source-root entrypoint policy and direct-dist exceptions.
- bd95a2c: Register health and readiness indicators with stable explicit IDs, reject duplicate IDs within each namespace, and return disposable lifecycle handles.

  The legacy indicator-only registration overloads remain available but are deprecated because they cannot provide stable component IDs.

- 422326b: - fix: isolate in-memory idempotency snapshots from caller mutation
- 6f3c5b4: Require link invitation and resend commands to carry an idempotency key so retries preserve one token and event identity after delivery failures. Drizzle deployments must apply the exported creation-intent migration and configure a 32-byte invitation token-cipher key before upgrading.
- fa8eea4: Generated OpenAPI and RPC contract paths now run strict ContractGraph schema checks by default, fail generated app scripts on strict ContractGraph diagnostics, and keep legacy compatibility behavior behind explicit opt-out flags.
- be64cc8: Reject usage values outside the positive safe-integer range before idempotency or storage, fail closed when Redis contains an invalid or unsafe accumulated value, encode LLM USD cost meters and generated app quotas as integer nanodollars, and widen PostgreSQL metering integers to BIGINT so every adapter preserves the same contract.
- ae4a089: Reject repeated scalar pagination query parameters with one stable Problem across plain records and URLSearchParams while preserving single values and defaults, and register the new Problem code in the public registry.
- ac94fc6: Reject empty required strings and invalid HTTP status values when parsing external Problem Details JSON.
- 3a9e51d: - fix: reject invalid saga list limits and offsets before store queries
- 0026f76: Return canonical generation artifacts, resolved configuration, post-action status, and next commands from the public programmatic generator.
- 86eb935: Expose Polar usage mapping and validation failures as explicitly non-retryable provider Problems, with matching generated registry source metadata.
- fccf65b: Allow RLS policies to compare text tenant identifiers with tenantColumnType: "text", while preserving the default UUID cast and rejecting unsupported column types.

  Keep generated RLS Problem source locations aligned with the expanded configuration field type.

- 65f3fdc: Reject non-finite and negative in-memory cache TTLs before mutation, define zero as immediate expiration, and register
  the new cache TTL validation Problem.
- 3cca753: Resolve GraphQLAuthGuard options through GRAPHQL_AUTH_GUARD_OPTIONS so registered guards used by @UseGuards can authenticate resolver requests.

  Keep generated GraphQL authentication Problem source references aligned with the guard implementation.

- 28c3ab5: Usage flush rejects storage without deletion support and requires repositories to declare durable idempotent persistence. Custom MeterRepository implementations must enforce uniqueness for tenantId, meterId and idempotencyKey before declaring replayContract as idempotent. Retries after deletion failures preserve one persisted usage record per identity.
- 97ba64a: Create Cloudflare Images direct-upload intents with the supported v2 multipart contract, bounded expiry, and caller-key identity validation.

  Refresh generated Problem source locations for the corrected provider implementation.

- 6542499: Make membership mutations idempotent and atomically persist recoverable domain-event intents. Membership command APIs now require caller-supplied idempotency keys, expose replay state through `addMemberCommand()`, and no longer publish inside the command transaction. Durable delivery requires a persistent store, an idempotent event publisher, and a relay or worker that calls `publishPendingEvents()`.
- d808f9d: Resolve `@User()`, `@CurrentPrincipal()`, and `@CurrentApiKey()` controller parameter decorators from request auth properties.
- 51d2d51: Run every tRPC procedure in an isolated Croco request context and resolve registered controllers and lifecycle providers through request-aware dependency injection.
- 7b1505b: Resolve declared tRPC controller parameter locations through typed request envelopes.
- b0eb7c7: Ignore client-controlled forwarding headers by default and resolve audit client IPs only through an explicit trusted-proxy hop policy.
- 8c1acbd: Keep committed transaction values successful when after-commit hooks fail, and expose structured degraded delivery
  evidence through `TxManager.runWithOutcome()`. Transactions that schedule after-commit work must now use this
  outcome-returning contract; invitation acceptance returns the committed transaction outcome, and event publication
  rejects non-capturing or late hook registration before delivery work can disappear.
- 683bd47: Expose a trace-only telemetry contract by removing the unimplemented metrics and logs facades and their reserved configuration. Consumers should remove metrics and logs options and stop branching on the deprecated `TELEMETRY_SIGNAL_UNSUPPORTED` Problem code. Generated applications now emit trace-only configuration, and packed consumer coverage verifies the published trace types and the complete initialization, flush, and shutdown lifecycle.
- 99da854: Execute method-form `@OnShutdown()` hooks once on the resolved service instance and reject unsupported decorator targets with stable diagnostics.
- c80ce21: Define typed, deterministic meter descriptors and validate billable usage envelopes before recording usage.

  Billing-required meters now require stable event identities, declared dimensions retain literal value domains, and
  COUNT meters can be used directly with `@Metered`. The existing string-based recording API remains available as a
  compatibility path.

  When adopting typed usage envelopes with `@croco/metering-drizzle`, configure both the `eventId` and `dimensions`
  column mappings and apply the exported migration for the selected dialect before recording typed fields.

- 589087a: Document and verify typed audience snapshots and one-shot campaign broadcasts, including packed ESM/CJS consumers and a credential-free generated SaaS smoke path.
- 50d0153: Generate window-scoped renderer clients whose inputs, results, Problems, events, and cancellation options are fixed by the desktop contract graph.
- b8fdd47: Provide typed, inspectable customer-message contracts with explicit decorator-bound renderer registration.
- 9b96858: Resolve tenant-scoped recipients and dispatch typed engagement messages with deterministic execution identities and explicit suppression outcomes.
- 1b201e5: Represent malformed successful JSON responses as typed external failures while preserving the HTTP response and parse cause.
- 713cf3b: Derive typed task references from decorator metadata so `TaskRunner.execute` rejects incompatible payloads at compile
  time, infers awaited handler results, and fails explicitly when reference and registry identities drift.
- 8a1dad8: Run optional digest-pinned PostgreSQL and Redis resources before production application bootstrap, inject typed connections into kernel-scoped Croco providers, and retain structured lifecycle, migration, isolation, and cleanup evidence.

  Test kernels now reject rollback-mode evidence for commit-semantic obligations such as after-commit hooks and transactional outbox behavior.

  The generated Problem registry now includes the typed test-resource lifecycle and fidelity diagnostics.

- 3bd0a5a: Bind event and webhook declarations to serializable typed references that reject incompatible handlers and unsupported HTTP methods during typechecking.
- abb5e10: Publish a runner-neutral `croco.test-evidence/v1` contract, JSON schema, Vitest and Playwright reporters, fidelity validation, flaky-attempt preservation, redaction, and deterministic JSON/Markdown bundles with explicit missing-artifact failures.
- facdc89: Reject invalid chunk sizes with one shared typed diagnostic before local or QStash batch execution can mutate state.
- 87e0994: - reject blank and duplicate batch step names before checkpoint execution with stable typed diagnostics
  - validate structurally supplied QStash steps against the shared batch step identity contract before claiming execution state
- 87a375e: Reject invalid carrying-capacity lookback periods with a typed diagnostic before reading or persisting metric data.
- 4afb5cf: Reject non-finite and out-of-range health score, weight, threshold, usage, and limit inputs with stable Problems before they affect status, trend, or persistence decisions.
- 62885fe: Reject invalid idempotency TTLs before reservation state changes.
- 525847a: Reject invalid invitation expiry durations before token generation, persistence, notification, or event side effects.
  Email and link invitations now require a positive integer day count that produces a finite expiration date.
- b65ed66: Reject invalid retry, circuit-breaker, Lambda deadline, and Redis TTL numeric configuration before state or I/O side effects.
  `INVALID_RETRY_CONFIGURATION` is now a non-retryable `ValidationError` (HTTP 422 instead of 500) and exposes only
  the option name, constraint, and string-form received value as diagnostic metadata.
- 76e734f: Reject non-finite and non-positive shutdown timeouts before changing manager state.
- 7e88b45: Reject invalid signed URL expiry values consistently before provider-specific signing and preserve valid expiry values as seconds across every storage adapter.
- 70fd27f: Reject invalid session durations, malformed blocked action configuration, and blank required reasons before impersonation session side effects.
- 8e19e13: Reject unsafe BatchSpanProcessor timeout, queue, and export batch tuning before telemetry startup with a typed field-level configuration Problem.
- 6d10475: Reject unsafe Cloudinary upload base URLs during provider construction so direct-upload intents cannot expose embedded URL credentials.

  Refresh generated Problem source locations for the corrected provider implementation.

- 0e0a46c: Expose deterministic ContractGraph monetization nodes, edges, provider mapping drift input, and actionable structural diagnostics for billable meters, plan versions, entitlements, and provider capabilities.
- a144d94: Expose immutable lifecycle rule versions, audited optimistic activation transitions, side-effect-free dry runs, and exact version evidence on production runs and diagnostics.
- 913c441: Add tenant-scoped outbound webhook operations contracts, accessible reliability views, structural timeline and retry adapters, and a generated fake-transport admin smoke.
- 377c684: Bind parameters from refined, transformed, and piped object route contracts without decorator evaluation failures. Wrapped contracts validate once per request and inject their parsed output, preserving handler types and cross-field validation.

  RPC generation reports unsupported transformed path schemas with the JSON-safety diagnostic before checking path field bindings.

## 0.0.4

### Patch Changes

- 1dc1607: Expose deterministic Problem code registry metadata, enforce globally unique public Problem codes, and link declared API failure surfaces to the generated recovery cookbook.

  Problem codes that previously collided now use package-scoped identifiers so every public code can be looked up deterministically:
  - `FORBIDDEN` -> `access-core/forbidden`
  - `MIDDLEWARE_EXECUTION_ERROR` -> `framework-context/context-middleware-execution-error`
  - `RATE_LIMIT_EXCEEDED` -> `llm-core/rate-limit-exceeded`
  - `cloudflare/images-null-result` for upload-intent null results -> `cloudflare/images-upload-intent-null-result`
  - `AUTH_*` REST guard codes -> `protocols-rest/auth-*`
  - `AUTH_*` GraphQL guard codes -> `protocols-graphql/auth-*`
  - `storage/invalid-upload-intent-ttl` in Cloudinary -> `storage-cloudinary/invalid-upload-intent-ttl`
  - `triggers-core/duplicate-trigger-metadata` for target-level duplicate method entries -> `triggers-core/duplicate-trigger-metadata-entry`

  Consumers that branch on exact Problem code strings should update those handlers to the package-scoped codes.

- 8c5b00c: Expose the generated Problem registry and typed Croco Problem unions with lifecycle metadata for active and deprecated public Problem codes.
- 48ce207: ProblemRegistry manifests can declare package-owned Problem contracts, and ContractGraph can reference those declarations.
- 6c26eb4: REST contracts can now declare route-specific Problem responses, carry them through contract snapshots and OpenAPI output, and generate RPC clients with typed success/problem/external result branches for exhaustive Problem handling.
- f8842d3: - Local workspace test resolution now uses a development export condition that avoids dist-clean races while keeping published imports dist-backed.
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
