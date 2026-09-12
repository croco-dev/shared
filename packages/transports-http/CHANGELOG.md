# @croco/transports-http

## 0.1.0

### Minor Changes

- 8bb215f: Make the aggregate `/health` endpoint report registered dependency health with sanitized details and
  a 503 response for failed or timed-out checks, while preserving `/health/live` as dependency-independent
  process liveness.
- 500c048: Compose configured auth, transaction, HTTP, telemetry, and diagnostics plugins through one application-owned module graph with explicit provider replacement and deterministic multi-contribution semantics.
- 7d248c5: Expose host, transport, and build-target composition as separate runtime metadata, bind host callbacks
  to their owning application scope, preserve the legacy Cloudflare handler context, and teach generated
  apps and presentation adapters to use explicit host and build-target entry points. Generated Lambda and
  Cloudflare SaaS apps now advertise commands that validate their actual deployment targets, including a
  Wrangler configuration with explicit Node.js compatibility for the generated Worker composition. Raw
  Hono callbacks must explicitly select raw-Hono dispatch when using the canonical Cloudflare host.

  Generated SaaS hosts await provider initialization and leave telemetry shutdown to the application
  runtime. Lambda and Workers host artifacts do not enable their documentation-only SaaS provider
  composition; invoking those profiles still reports `CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE`.

- efb33f9: Boot production application definitions in isolated, runner-neutral test kernels with explicit application or adapter fidelity.

  Each kernel now owns its DI instances, event configuration, test transaction evidence, request state, scoped production shutdown hooks, and one-time cleanup lifecycle without replacing the application's production transaction provider. Node and Lambda adapter requests run through their real handler paths without opening a public network port, while the existing lightweight testing app is reported as isolated fidelity.

- c5eee6e: Preserve repeated query values for HTTP parameter binding, validate list-valued query and headers consistently, and align generated OpenAPI, RPC client serialization, and CLI templates. Direct query accessors now expose repeated keys as `string[]`, so consumers that require one scalar value must narrow the result.

  Schema-less named `@Query()` parameters retain their generated optional-scalar contract and reject repeated values. Declare an array schema when a controller parameter accepts repeated keys.

### Patch Changes

- 8214d67: - fix: lock operational endpoint contracts
- 5a7fe34: - fix: verify HTTP pipeline conformance
- f3709a6: - fix: lock static asset conformance
- 98001e1: - fix: lock Problem response protocol contracts
- b278729: - fix: block critical test tooling advisories
- 868ea09: Let each Croco application own one isolated DI scope and module lifecycle, retry failed startup from
  the exact pre-attempt provider baseline, inspect one correlated module and dependency graph, and run
  TestKernel without process-global container resets.
  Canonical SaaS templates now bind HTTP application calls to their application-owned runtime, and
  scoped HTTP bootstrap validation ignores unrelated process-global component registrations.
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- cb36e68: - fix: verify REST validation failure matrix
- 26f4b9e: Expose request cancellation signals through runtime context and keep abort-signal capabilities aligned with adapter support.
- 00bfe50: Preserve explicit evidence when optional HTTP diagnostics, telemetry headers, or inspector logging fail.
- 13f74d8: Keep exception-filter selection and fallback responses deterministic when logger, inspector, or tracing diagnostics fail.
- d2e17ce: Keep successful Lambda responses successful when `waitUntil` rejection reporting sinks fail, while preserving separate fallback evidence for the task rejection and logger failure.
- 7df16bb: Register REST controllers with the DI container automatically while preserving explicit component scopes.
  Generated applications now use `@Controller` as the single controller registration convention.
- 3648511: Exception filter outcomes are now an explicit HTTP contract, and failed or invalid filter handling emits stable `CROCO_HTTP_FILTER_001` diagnostic evidence while preserving the original route error.
- f11142a: - fix: verify REST contract runtime parity
- ab4453f: Make the HTTP middleware `failOpen` policy govern rate-limit store outages and emit runtime inspection evidence for the resulting allow or reject decision.
- 8522b0c: Keep default package tests deterministic while exposing integration, published-package, and live-resource verification through explicit test lanes.
- be7408f: Expose fatal logging through the shared `ILogger` and `LOGGER_TOKEN` contract, including child loggers and Error context,
  while keeping generated bootstrap and built-in no-op loggers contract-complete.
- b875cea: - fix: cover DI request scope in HTTP requests
- 06b597e: Require the fixed Hono release for HTTP, Node, and Lambda consumers so packed packages cannot resolve the affected request-isolation, repeated-header, and audited CORS-header ReDoS ranges.
- a513c78: Generated route modules now resolve declared controllers through Croco DI and invoke their bound handler methods instead of returning placeholder responses.
- ba6ba75: GraphQL Problem errors now apply the shared Croco redaction policy, with declared policy metadata available in GraphQL contract snapshots.
- a4eacbf: Document and verify the HTTP HEAD/GET interaction policy so GET-only routes provide bodyless HEAD responses while explicit HEAD routes remain the ContractGraph/OpenAPI-visible contract.
- 80ddb00: Return JSON handler results with the route's declared successful HTTP status while preserving the default 200 and empty-response 204 behavior.
- d52f81f: Make HTTP middleware short-circuit semantics explicit with a `shortCircuit(reason)` marker, stable middleware diagnostics, and runtime inspection details for short-circuit outcomes.

  The legacy `transports-http/middleware-next-called-multiple-times` compatibility code now maps to the new `CROCO_HTTP_MIDDLEWARE_002` multiple-next diagnostic and is classified as not retryable.

- b228e78: Enforce registry-backed Problem redaction at the HTTP response boundary and document the public extension allowlist.
- eed5e70: Execute global, class, and method HTTP pipes against handler arguments before controller invocation, route pipe failures through the standard Problem flow, and expose pipe stages in request pipeline graphs.
- afb8544: Verify Lambda API Gateway v2 request, response, helper, and malformed-event conformance.
- 7caa3ea: Document and verify API Gateway v2 cookie/header mapping for the Lambda adapter.
- 54f61ee: Guarantee Lambda `waitUntil` drains and handler flush callbacks run when fetch execution fails.
- 3e29376: Preserve API Gateway v2 session and authentication cookies when a Cookie header is also present. Merge both sources by case-sensitive cookie name, preserving the explicit header value on conflicts and the first occurrence within each source. Preserve cookie values without decoding them.
- 1786455: Preserve Lambda response `Set-Cookie` values through the API Gateway v2 `cookies` field.
- 68eb95a: Drain transitively registered Lambda `waitUntil` work before responding, and fail with deterministic outstanding-task diagnostics when the invocation deadline prevents a stable drain.
- 0ee816f: Expose the Node server handle from HTTP listen APIs and verify the Node adapter with real-socket smoke coverage.
- 67e0cbe: fix: resolve published package types before runtime conditions
- e3bb85e: Observe signal shutdown failures and bind graceful HTTP draining to the Node listener lifecycle.
- 1c843a5: Preserve runtime class-decorator metadata in published ESM and CJS bundles so Croco can resolve concrete constructor dependencies from installed packages.
- c1dc054: Preserve sanitized internal-server-error responses when the configured logger throws while reporting the original failure.
- a8d733b: - fix(transports-http): preserve omitted request bodies for schema validation
- 20cb828: Verify and document Problem response correlation metadata for Node and Lambda transports.
- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- 1910ff9: Graceful shutdown callers now join one bounded lifecycle and receive typed phase timeout failures. Shutdown hooks receive an `AbortSignal`; zero-argument hook implementations remain assignable, while callers invoking an extracted configured hook must supply that signal.
  Non-finite timeout options now fail synchronously with a typed configuration Problem before shutdown state or signal listeners are created.
- f2798d2: Make HTTP readiness endpoints execute dedicated readiness indicators, return sanitized detailed failures, and keep generic health and liveness checks independent.
- e745cc9: Redact private Problem details and extensions consistently across REST filters and HTTP transport responses.
- 7328ec4: Reject repeated health and readiness indicator identities across explicit and legacy registration paths before checks run.

  Registration Problems now report only source-safe identity kinds instead of reflecting caller-supplied indicator IDs or names.
  HTTP health registrations validate before mutating adapter state, and duplicate diagnostics no longer reflect registration names.

- f2094bc: Reject W3C `traceparent` headers whose trace ID or parent ID is all zero before installing remote request context.
- 90133b3: Normalize invalid JSON body parsing failures to stable request-validation Problem responses.
- a2760e3: Align generated REST query and header requiredness with runtime validation semantics and verify the minimal production REST golden path across Node fetch, Lambda, OpenAPI, and generated RPC clients.
- e97f694: Duplicate route diagnostics now identify both conflicting controller methods and route decorator source locations.
  The `transports-http/duplicate-route-definition` recovery metadata now marks route conflicts as not retryable until one route decorator is changed.
- ab51ace: Separate route contract client inputs, parsed handler inputs, handler return values, and wire response outputs while preserving existing helper aliases. HTTP routes now parse handler returns through their response schema before serialization, and generated RPC clients project request and response schemas according to their lifecycle direction.
- 5575357: Use runtime-aware trusted client identity when building rate limit keys.
- 524f00c: Runtime fetch paths now preserve provided execution context options so Node, Lambda, and Cloudflare Workers capability behavior can be verified against the shared runtime capability manifest.
- c11a9b4: Preserve named catch-all matching and parameter extraction when routes are registered from generated tables, and
  keep published Problem registry source locations synchronized with the shared route compiler import.
- 5e64d94: Reject unsafe operational diagnostics response limits before endpoint registration with the stable `transports-http/diagnostics-invalid-configuration` Problem.
- 7f7ccee: Enforce HTTP body limits against actual streamed bytes while preserving accepted bodies for downstream parsers across Node and Lambda adapters. Publish canonical 413 Payload Too Large contracts for `transports-http/request-body-too-large` and the existing `transports-graphql/request-body-too-large` Problem across registries and transports, while marking the HTTP status as runtime-configurable when `bodyLimitMiddleware.statusCode` overrides its 413 default.
- a8bc534: - fix: prevent static-file middleware bypasses on Croco Node adapter paths
- 1a209ad: Validate HTTP security middleware through explicit capability metadata instead of source text.
- f22f68f: Apply decorated rate limits to HTTP controller methods by resolving named handlers and sharing request context values and rate limit results with guards.
- 4fe1d1e: Lambda request bodies preserve binary bytes when Base64 contains whitespace, URL-safe characters, or omitted padding, while malformed encodings still fail validation.
- 6754896: EntitlementGuard evaluates the framework Context or request tenant when principal and user tenant claims are absent. Conflicting tenant sources still fail before entitlement evaluation. Applications must validate tenant selection and organization membership before injecting these values; the guard checks tenant entitlements, not membership.

  HTTP pipelines reject conflicting request and HTTP context tenants before invoking guards, including AccessGuard-only routes. Request access remains available to exception filters; matching tenants and existing HTTP tenant injection remain supported.

- d808f9d: Resolve `@User()`, `@CurrentPrincipal()`, and `@CurrentApiKey()` controller parameter decorators from request auth properties.
- 377c684: Bind parameters from refined, transformed, and piped object route contracts without decorator evaluation failures. Wrapped contracts validate once per request and inject their parsed output, preserving handler types and cross-field validation.

  RPC generation reports unsupported transformed path schemas with the JSON-safety diagnostic before checking path field bindings.

- Updated dependencies [4ca14ab]
- Updated dependencies [38cba9c]
- Updated dependencies [b278729]
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
- Updated dependencies [81ed45b]
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
- Updated dependencies [da9925f]
- Updated dependencies [d99ede2]
- Updated dependencies [50db523]
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
- Updated dependencies [ab4453f]
- Updated dependencies [be7408f]
- Updated dependencies [969d87e]
- Updated dependencies [6fa6843]
- Updated dependencies [6069742]
- Updated dependencies [210015b]
- Updated dependencies [582b311]
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
- Updated dependencies [a90659b]
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
- Updated dependencies [edeef70]
- Updated dependencies [f92404b]
- Updated dependencies [44fb02d]
- Updated dependencies [1c843a5]
- Updated dependencies [45882f1]
- Updated dependencies [a8d733b]
- Updated dependencies [2a6e12c]
- Updated dependencies [f0c328e]
- Updated dependencies [c631b69]
- Updated dependencies [796290f]
- Updated dependencies [efb33f9]
- Updated dependencies [157089a]
- Updated dependencies [df8d018]
- Updated dependencies [47b942b]
- Updated dependencies [a458c5c]
- Updated dependencies [8bf1a44]
- Updated dependencies [5d54fb4]
- Updated dependencies [19bdcd1]
- Updated dependencies [16ff048]
- Updated dependencies [061d4bc]
- Updated dependencies [6aaafc8]
- Updated dependencies [badfb5c]
- Updated dependencies [20eccc9]
- Updated dependencies [a2353be]
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
- Updated dependencies [33d4b2f]
- Updated dependencies [f5503fd]
- Updated dependencies [54f9a57]
- Updated dependencies [e4bfcb2]
- Updated dependencies [65f9c8a]
- Updated dependencies [4505d13]
- Updated dependencies [c5eee6e]
- Updated dependencies [f24f196]
- Updated dependencies [cc8106d]
- Updated dependencies [0efaa4f]
- Updated dependencies [7d177a1]
- Updated dependencies [a2760e3]
- Updated dependencies [753b3cd]
- Updated dependencies [ab51ace]
- Updated dependencies [5575357]
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
- Updated dependencies [1d5ed40]
- Updated dependencies [847ecbf]
- Updated dependencies [bd95a2c]
- Updated dependencies [422326b]
- Updated dependencies [6f3c5b4]
- Updated dependencies [5306098]
- Updated dependencies [6cb0a5c]
- Updated dependencies [fa8eea4]
- Updated dependencies [be64cc8]
- Updated dependencies [ae4a089]
- Updated dependencies [ac94fc6]
- Updated dependencies [3a9e51d]
- Updated dependencies [0026f76]
- Updated dependencies [f22f68f]
- Updated dependencies [86eb935]
- Updated dependencies [fccf65b]
- Updated dependencies [65f3fdc]
- Updated dependencies [3cca753]
- Updated dependencies [28c3ab5]
- Updated dependencies [aa19802]
- Updated dependencies [97ba64a]
- Updated dependencies [6542499]
- Updated dependencies [d808f9d]
- Updated dependencies [ea4d1d1]
- Updated dependencies [51d2d51]
- Updated dependencies [7b1505b]
- Updated dependencies [b0eb7c7]
- Updated dependencies [8c1acbd]
- Updated dependencies [683bd47]
- Updated dependencies [99da854]
- Updated dependencies [746c954]
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
- Updated dependencies [70fd27f]
- Updated dependencies [8e19e13]
- Updated dependencies [6d10475]
- Updated dependencies [0e0a46c]
- Updated dependencies [a144d94]
- Updated dependencies [4f125b6]
- Updated dependencies [913c441]
- Updated dependencies [377c684]
  - @croco/framework-context@0.1.0
  - @croco/events-core@0.1.0
  - @croco/problems-core@1.0.0
  - @croco/framework-module@0.1.0
  - @croco/protocols-core@0.2.0
  - @croco/protocols-rest@0.1.0
  - @croco/ratelimit-core@0.1.0
  - @croco/diagnostics-core@0.1.0
  - @croco/framework-logger@0.0.5
  - @croco/health-core@1.0.0

## 0.0.4

### Patch Changes

- 4d8f094: - Generated REST/Lambda and Cloudflare worker apps now bootstrap with the required HTTP security middleware instead of disabling security validation.
  - Missing required HTTP security middleware now fails with `CROCO_HTTP_SECURITY_001` while preserving the previous slash-form code as `legacyCode`.
- 6769a7f: - fix: enforce core coverage spine baseline
- 51b0f14: - fix: make benchmark gate evidence enforce-ready
- a77425f: - Expand strict contract typecheck coverage to REST, OpenAPI, RPC codegen, and HTTP transport package configs.
- 6148ed3: Expose a canonical REST contract graph with route diagnostics and add a contract check path before OpenAPI and RPC client generation.
- ee924c0: Expose an opt-in local Dev Inspector that shows redacted request runtime timelines, DI snapshots, event handling, retry attempts, and Problem outcomes.
- 5403360: HTTP apps now expose a DI bootstrap validation policy that fails fast by default, with explicit warn/off migration modes for legacy unregistered providers.
- da861c8: Expose instance-bound graceful shutdown controllers so multiple HTTP apps in one process can shut down independently without sharing request rejection state.
- e108899: HTTP compression middleware now returns encoded response bytes whenever it advertises `Content-Encoding`, while preserving threshold, content type, and error-response skip behavior.
- c0c7215: Return the canonical `@croco/health-core` readiness contract from HTTP health endpoints.

  `/ready` and `/health/ready` now return `{ status: "up" | "down", results: [...] }` instead of the previous transport-local `{ status: "ok" | "error", checks: ... }` body shape.

- 42bc50e: HTTP telemetry middleware now records and logs degraded setup failures while preserving fallback request handling.
- 9f7e769: Fix Lambda event/context helpers to read the Lambda execution env from the Hono context passed through Croco raw route parameters.
- 000e999: HTTP request telemetry now wraps controller execution, Problem responses include trace/request metadata, middleware short-circuit responses keep their intended status, and Lambda handlers can run an explicit flush callback before returning.
- 8a85c6a: Formalize HTTP operational endpoint contracts and diagnostics exposure policy while routing HTTP readiness execution through `@croco/health-core`.
- 9556d22: Add CI-oriented operational checks with token-guarded diagnostics smoke coverage and app-provided diagnostics provider registration.
- f40eb63: Expose canonical operations endpoints and add `croco ops status` for machine-readable and human-readable runtime status checks.
- b6449cc: HTTP runtime packages now require a patched Hono range so production dependency audits do not include known high-severity Hono advisories.
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- 58b689a: HTTP rate-limit outcome skip flags now refund successful limiter checks so skipped success or failure responses do not consume quota, with core and Upstash stores exposing the matching refund contract.
- eeebc70: Rate-limit 429 Problem responses now include retry and quota headers when headers are enabled.
- 9c2ac20: Expose deterministic request pipeline execution graphs with middleware, guard, policy, interceptor, handler, and filter phases.
- de7610e: Runtime context capability support is now exposed as a shared type-level matrix, and unsupported runtime/capability combinations fail typecheck or runtime context creation instead of degrading silently.
- 14bd9f8: - Runtime capability manifests can now be emitted and compared for Node, Lambda, and Cloudflare Workers with deterministic `RuntimeCapabilityManifest v1` output.
  - Unsupported runtime capability use now carries the stable `CROCO_RUNTIME_CAPABILITY_001` diagnostic context.
  - Generated apps now write `croco-runtime-capability.manifest.json`, and doctor/smoke checks validate the manifest for supported runtime targets.
- 0618b12: Runtime capability support now includes explicit filesystem, Node API, and request lifecycle flags for Node, Lambda, and Cloudflare Workers request contexts.
- 41ee87a: Expose a request-scoped `RuntimeContext` contract for Node, AWS Lambda, and Cloudflare Workers runtime metadata.
- 7442f1c: `CrocoApp.listen()` now installs its Node server adapter dependency in production installs.
- bc5594d: Declare zod as a runtime dependency so exported ParamResolver declarations resolve in clean installs.
- Updated dependencies [4d8f094]
- Updated dependencies [6769a7f]
- Updated dependencies [d281518]
- Updated dependencies [ea14bd4]
- Updated dependencies [2ceb6c4]
- Updated dependencies [73e430a]
- Updated dependencies [a77425f]
- Updated dependencies [2631037]
- Updated dependencies [529c7fd]
- Updated dependencies [f3951f3]
- Updated dependencies [6148ed3]
- Updated dependencies [779fa6f]
- Updated dependencies [988f072]
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
- Updated dependencies [a61dcd4]
- Updated dependencies [8a85c6a]
- Updated dependencies [4c7fcd9]
- Updated dependencies [1dc1607]
- Updated dependencies [8c5b00c]
- Updated dependencies [48ce207]
- Updated dependencies [6c26eb4]
- Updated dependencies [f8842d3]
- Updated dependencies [9a2040b]
- Updated dependencies [955b02e]
- Updated dependencies [d707a0c]
- Updated dependencies [d117fca]
- Updated dependencies [58b689a]
- Updated dependencies [cac7e99]
- Updated dependencies [aacdad6]
- Updated dependencies [9c2ac20]
- Updated dependencies [1489bfa]
- Updated dependencies [de7610e]
- Updated dependencies [14bd9f8]
- Updated dependencies [0618b12]
- Updated dependencies [41ee87a]
- Updated dependencies [c54e7b5]
- Updated dependencies [d215344]
- Updated dependencies [a3458cc]
- Updated dependencies [d1552a5]
- Updated dependencies [3ca4a69]
- Updated dependencies [f8e4056]
- Updated dependencies [bb59160]
- Updated dependencies [ac9118b]
- Updated dependencies [d314bd4]
- Updated dependencies [83ac49f]
  - @croco/diagnostics-core@0.0.4
  - @croco/protocols-core@0.1.0
  - @croco/events-core@0.0.4
  - @croco/protocols-rest@0.0.4
  - @croco/framework-context@0.0.4
  - @croco/health-core@0.0.4
  - @croco/problems-core@0.0.4
  - @croco/framework-logger@0.0.4
  - @croco/ratelimit-core@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: add self-diagnosing subsystem (@croco/diagnostics-core)
- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
- 99f2a6b: fix: resolve component singleton DI and HTTP telemetry status mapping bugs
- 99f2a6b: raise runtime dependency floors to patched security releases
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
  - @croco/diagnostics-core@0.0.3
  - @croco/events-core@0.0.3
  - @croco/framework-context@0.0.3
  - @croco/framework-logger@0.0.3
  - @croco/problems-core@0.0.3
  - @croco/protocols-core@0.0.3
  - @croco/protocols-rest@0.0.3
  - @croco/ratelimit-core@0.0.3
