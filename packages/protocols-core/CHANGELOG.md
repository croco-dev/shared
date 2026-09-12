# @croco/protocols-core

## 0.2.0

### Minor Changes

- 0e0a46c: Expose deterministic ContractGraph monetization nodes, edges, provider mapping drift input, and actionable structural diagnostics for billable meters, plan versions, entitlements, and provider capabilities.

### Patch Changes

- b278729: - fix: block critical test tooling advisories
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- cb61f2e: Run bounded deterministic route-contract fuzzing and capability-aware runtime differential checks with replayable failure artifacts, including generated application smoke coverage.
- 81ed45b: Preserve parameter-decorator input schemas when route contracts omit body, path, or query schemas, while keeping explicitly declared contract schemas authoritative.
- c1ce071: Reject malformed persisted ContractGraph snapshot members before narrowing while preserving coherent historical v1 artifact shapes.
- 639abfe: Compile the fail-closed DesktopWire schema subset into deterministic descriptors and reject invalid wire values.
- 67e0cbe: fix: resolve published package types before runtime conditions
- 44fb02d: Preserve normalized route entitlement requirements across generated admin resources, actions, and client bindings, require their fingerprints in admin consumer coverage, and keep generated Problem source metadata aligned.
- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- 54f9a57: Reject Zod records with non-string key schemas from JSON-safe contract descriptors.
- c5eee6e: Preserve repeated query values for HTTP parameter binding, validate list-valued query and headers consistently, and align generated OpenAPI, RPC client serialization, and CLI templates. Direct query accessors now expose repeated keys as `string[]`, so consumers that require one scalar value must narrow the result.

  Schema-less named `@Query()` parameters retain their generated optional-scalar contract and reject repeated values. Declare an array schema when a controller parameter accepts repeated keys.

- a2760e3: Align generated REST query and header requiredness with runtime validation semantics and verify the minimal production REST golden path across Node fetch, Lambda, OpenAPI, and generated RPC clients.
- c11a9b4: Preserve named catch-all matching and parameter extraction when routes are registered from generated tables, and
  keep published Problem registry source locations synchronized with the shared route compiler import.
- 7f7ccee: Enforce HTTP body limits against actual streamed bytes while preserving accepted bodies for downstream parsers across Node and Lambda adapters. Publish canonical 413 Payload Too Large contracts for `transports-http/request-body-too-large` and the existing `transports-graphql/request-body-too-large` Problem across registries and transports, while marking the HTTP status as runtime-configurable when `bodyLimitMiddleware.statusCode` overrides its 413 default.
- fa8eea4: Generated OpenAPI and RPC contract paths now run strict ContractGraph schema checks by default, fail generated app scripts on strict ContractGraph diagnostics, and keep legacy compatibility behavior behind explicit opt-out flags.
- aa19802: Resolve relative route contract paths under their controller prefix while preserving existing full paths without duplicate prefixes. ContractGraph accepts both forms and HTTP routing uses the resolved path.
- ea4d1d1: Resolve `@Raw()` controller parameters to the tRPC procedure context without dropping their argument positions.
- 7b1505b: Resolve declared tRPC controller parameter locations through typed request envelopes.
- 377c684: Bind parameters from refined, transformed, and piped object route contracts without decorator evaluation failures. Wrapped contracts validate once per request and inject their parsed output, preserving handler types and cross-field validation.

  RPC generation reports unsupported transformed path schemas with the JSON-safety diagnostic before checking path field bindings.

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
- Updated dependencies [2973efe]
- Updated dependencies [daef820]
- Updated dependencies [1f6522c]
- Updated dependencies [9b997bb]
- Updated dependencies [6d81e46]
- Updated dependencies [ec75eb4]
- Updated dependencies [101a7f1]
- Updated dependencies [7aabe26]
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

## 0.1.0

### Minor Changes

- 779fa6f: Expose a documented ContractGraph v1 JSON snapshot schema and make the OpenAPI CLI validate the canonical contract graph before emitting specs.

### Patch Changes

- d281518: - fix: close package docs coverage gaps
- ea14bd4: - Align route contract Problem response coverage with generated recovery cookbook links.
- 73e430a: Contract Graph routes can now generate deterministic admin resource configs with typed client bindings, preserved declared Problem metadata, and explicit diagnostics for ambiguous route shapes.
- 2631037: OpenAPI and RPC codegen now discover exported REST controllers by metadata and ignore co-located helper classes.
- 529c7fd: Contract graph snapshots now include consumer coverage reports, OpenAPI/RPC generation verifies every graph route, generated RPC clients expose route metadata, and generated app CI contract scripts write `contract-graph.coverage.json`.
- f3951f3: REST route contracts can now drive controller decorators directly through contract-aware HTTP method, parameter, body, and response helpers. Contract graphs preserve route contract identity/source locations and report drift when controller bindings or response metadata diverge from the contract. The SPA split starter template now uses contract-first REST routes for its generated OpenAPI/RPC contract path.
- 6148ed3: Expose a canonical REST contract graph with route diagnostics and add a contract check path before OpenAPI and RPC client generation.
- 988f072: Add deterministic contract graph snapshots and drift gates for contract-first release checks.
- 9c1bc2e: Entitlement guard requirements are now emitted as route contract metadata and OpenAPI extensions, with explicit guard status and evidence.
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

- 48ce207: ProblemRegistry manifests can declare package-owned Problem contracts, and ContractGraph can reference those declarations.
- 6c26eb4: REST contracts can now declare route-specific Problem responses, carry them through contract snapshots and OpenAPI output, and generate RPC clients with typed success/problem/external result branches for exhaustive Problem handling.
- 9a2040b: Generated contract workflows now emit a schema-versioned `.croco/manifest` bundle, validate it through the Project Map drift gate and `croco doctor`, and reference it from generated OpenAPI and RPC outputs.
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- 1489bfa: Generated RPC clients now expose declared REST header parameters as typed inputs and send them as request headers.
- d215344: Route schemas can now be declared once with `defineRouteSchema`, infer controller DTO types from that schema, and feed the same request and response schema references into validation metadata, contract graphs, OpenAPI emission, and generated RPC client types.
- a3458cc: ContractGraph snapshots, OpenAPI generation, and RPC codegen now share a JSON-safe Zod schema descriptor and fail unsupported contract schemas with the same diagnostic code.
- f8e4056: Generated app REST routes now declare schema-backed contract decorators, and protocols-core is included in the staged strict contract typecheck gate.
- bb59160: - Generated REST contract gates can now run strict schema diagnostics that fail before RPC/OpenAPI
  generation when routes omit response, body, path, query, or header schemas.
- d314bd4: - fix: validate route Problem response contracts through typed declarations
- Updated dependencies [1dc1607]
- Updated dependencies [8c5b00c]
- Updated dependencies [48ce207]
- Updated dependencies [6c26eb4]
- Updated dependencies [f8842d3]
- Updated dependencies [d707a0c]
  - @croco/problems-core@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
