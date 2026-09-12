# @croco/framework-context

## 0.1.0

### Minor Changes

- 868ea09: Let each Croco application own one isolated DI scope and module lifecycle, retry failed startup from
  the exact pre-attempt provider baseline, inspect one correlated module and dependency graph, and run
  TestKernel without process-global container resets.
  Canonical SaaS templates now bind HTTP application calls to their application-owned runtime, and
  scoped HTTP bootstrap validation ignores unrelated process-global component registrations.
- 9404839: Reject unsafe runtime inspector retention and redaction limits before collecting operational data.
- 7df16bb: Register REST controllers with the DI container automatically while preserving explicit component scopes.
  Generated applications now use `@Controller` as the single controller registration convention.
- 6489abb: Expose a shared versioned application intent contract and make `croco doctor` report malformed, unsupported, or workspace-drifted `croco.app.json` manifests while custom workspaces remain explicitly skipped.
- dda0a50: Generate the Node/Postgres SaaS profile as an executable canonical plugin graph, run the selected graph at application bootstrap, release its application-owned PostgreSQL pool through canonical module shutdown, and expose explicit production, local replacement, unavailable, and documentation-only capability states.

  Register stable Problem codes for provider-profile mismatches and unavailable runtimes.

- 7d248c5: Expose host, transport, and build-target composition as separate runtime metadata, bind host callbacks
  to their owning application scope, preserve the legacy Cloudflare handler context, and teach generated
  apps and presentation adapters to use explicit host and build-target entry points. Generated Lambda and
  Cloudflare SaaS apps now advertise commands that validate their actual deployment targets, including a
  Wrangler configuration with explicit Node.js compatibility for the generated Worker composition. Raw
  Hono callbacks must explicitly select raw-Hono dispatch when using the canonical Cloudflare host.

  Generated SaaS hosts await provider initialization and leave telemetry shutdown to the application
  runtime. Lambda and Workers host artifacts do not enable their documentation-only SaaS provider
  composition; invoking those profiles still reports `CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE`.

- be7408f: Expose fatal logging through the shared `ILogger` and `LOGGER_TOKEN` contract, including child loggers and Error context,
  while keeping generated bootstrap and built-in no-op loggers contract-complete.
- eed5e70: Execute global, class, and method HTTP pipes against handler arguments before controller invocation, route pipe failures through the standard Problem flow, and expose pipe stages in request pipeline graphs.
- efb33f9: Boot production application definitions in isolated, runner-neutral test kernels with explicit application or adapter fidelity.

  Each kernel now owns its DI instances, event configuration, test transaction evidence, request state, scoped production shutdown hooks, and one-time cleanup lifecycle without replacing the application's production transaction provider. Node and Lambda adapter requests run through their real handler paths without opening a public network port, while the existing lightweight testing app is reported as isolated fidelity.

- 8c1acbd: Keep committed transaction values successful when after-commit hooks fail, and expose structured degraded delivery
  evidence through `TxManager.runWithOutcome()`. Transactions that schedule after-commit work must now use this
  outcome-returning contract; invitation acceptance returns the committed transaction outcome, and event publication
  rejects non-capturing or late hook registration before delivery work can disappear.

### Patch Changes

- 4ca14ab: - test: keep framework-context runtime options behavior-tested
- 38cba9c: - fix: enforce full strict contract spine
- 7008727: - fix: lock framework-context compatibility groups
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 26f4b9e: Expose request cancellation signals through runtime context and keep abort-signal capabilities aligned with adapter support.
- 2cc5438: Reject shutdown hook registration after shutdown starts with lifecycle-state diagnostics.
- 0fa2546: Generate deterministic DI graph manifests through the CLI and generated app verification scripts.
- 008f3f0: Reject ambiguous module provider ownership before shared container mutation, require lifecycle writes to use locally declared providers, and keep symbol provider identities consistent between module and context containers.
- 16cc286: Keep dependency graph source locations diagnostic-only with stable token IDs and explicit generated-code source metadata.
- cfdc20a: Make every concurrent `ShutdownManager.shutdown()` caller wait for and observe the same hook completion, failure, or timeout result.
- 67e0cbe: fix: resolve published package types before runtime conditions
- e3bb85e: Observe signal shutdown failures and bind graceful HTTP draining to the Node listener lifecycle.
- 1c843a5: Preserve runtime class-decorator metadata in published ESM and CJS bundles so Croco can resolve concrete constructor dependencies from installed packages.
- 45882f1: Preserve property symbol identity and keep empty-string member metadata separate from class metadata.
- f0c328e: Preserve original request failure identity when the error lifecycle hook fails, while reporting the hook failure through
  request diagnostics.
- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- 8aa72a1: Lock runtime inspector redaction coverage for request snapshots and scrub cookie, database URL, and connection string assignments in diagnostic messages.
- f141c18: Contain logger failures during shutdown timeouts so callers still receive the typed timeout result and outstanding hooks are aborted.
- 99da854: Execute method-form `@OnShutdown()` hooks once on the resolved service instance and reject unsupported decorator targets with stable diagnostics.
- 76e734f: Reject non-finite and non-positive shutdown timeouts before changing manager state.
- Updated dependencies [38cba9c]
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
- Updated dependencies [969d87e]
- Updated dependencies [6fa6843]
- Updated dependencies [6069742]
- Updated dependencies [210015b]
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
- Updated dependencies [0b5e89b]
- Updated dependencies [3d9e585]
- Updated dependencies [37dab98]
- Updated dependencies [00ec1c5]
- Updated dependencies [a4a5a49]
- Updated dependencies [6d8a31f]
- Updated dependencies [9a03a84]
- Updated dependencies [fb10b5f]
- Updated dependencies [a7df589]
- Updated dependencies [8c2b316]
- Updated dependencies [986ce2d]
- Updated dependencies [8630cf3]
- Updated dependencies [31636bb]
- Updated dependencies [f92404b]
- Updated dependencies [44fb02d]
- Updated dependencies [1c843a5]
- Updated dependencies [a8d733b]
- Updated dependencies [2a6e12c]
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
- Updated dependencies [037c3c4]
- Updated dependencies [5e64d94]
- Updated dependencies [344995f]
- Updated dependencies [c0c9679]
- Updated dependencies [286a5ad]
- Updated dependencies [918a960]
- Updated dependencies [44c16c9]
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
  - @croco/problems-core@1.0.0
  - @croco/diagnostics-core@0.1.0

## 0.0.4

### Patch Changes

- ee924c0: Expose an opt-in local Dev Inspector that shows redacted request runtime timelines, DI snapshots, event handling, retry attempts, and Problem outcomes.
- 5403360: HTTP apps now expose a DI bootstrap validation policy that fails fast by default, with explicit warn/off migration modes for legacy unregistered providers.
- e12e825: Expose deterministic DI and module graph manifests with pre-start diagnostics, and add `croco di check` for CI manifest validation.
- 6831875: DI resolution failures now expose stable Croco Problems with provider-selection traces, and singleton components fail before capturing request-scoped dependencies.
- a61dcd4: Container removal now unregisters constructor component metadata so validation and later resolution honor removed components.
- 4c7fcd9: Expose an explicit runtime policy model for route, service, and event-handler timeout, retry, and tracing policies.
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

- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- 9c2ac20: Expose deterministic request pipeline execution graphs with middleware, guard, policy, interceptor, handler, and filter phases.
- de7610e: Runtime context capability support is now exposed as a shared type-level matrix, and unsupported runtime/capability combinations fail typecheck or runtime context creation instead of degrading silently.
- 14bd9f8: - Runtime capability manifests can now be emitted and compared for Node, Lambda, and Cloudflare Workers with deterministic `RuntimeCapabilityManifest v1` output.
  - Unsupported runtime capability use now carries the stable `CROCO_RUNTIME_CAPABILITY_001` diagnostic context.
  - Generated apps now write `croco-runtime-capability.manifest.json`, and doctor/smoke checks validate the manifest for supported runtime targets.
- 0618b12: Runtime capability support now includes explicit filesystem, Node API, and request lifecycle flags for Node, Lambda, and Cloudflare Workers request contexts.
- 41ee87a: Expose a request-scoped `RuntimeContext` contract for Node, AWS Lambda, and Cloudflare Workers runtime metadata.
- c54e7b5: Runtime policy capability requirements can now be checked against typed runtime presets before app execution.
- d1552a5: Reject conflicting explicit ShutdownManager timeout configuration with a typed Problem while preserving reset-based listener isolation.
- Updated dependencies [4d8f094]
- Updated dependencies [6769a7f]
- Updated dependencies [d281518]
- Updated dependencies [0b43229]
- Updated dependencies [9cd8667]
- Updated dependencies [2f0dae2]
- Updated dependencies [ddfc6d1]
- Updated dependencies [1dc1607]
- Updated dependencies [8c5b00c]
- Updated dependencies [48ce207]
- Updated dependencies [6c26eb4]
- Updated dependencies [f8842d3]
- Updated dependencies [d707a0c]
- Updated dependencies [14bd9f8]
- Updated dependencies [3ca4a69]
  - @croco/diagnostics-core@0.0.4
  - @croco/problems-core@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: add self-diagnosing subsystem (@croco/diagnostics-core)
- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
- 99f2a6b: fix: resolve component singleton DI and HTTP telemetry status mapping bugs
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
  - @croco/diagnostics-core@0.0.3
  - @croco/problems-core@0.0.3
