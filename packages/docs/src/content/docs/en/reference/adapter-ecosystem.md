---
title: Adapter Ecosystem
description: Official Croco adapter boundaries, priorities, and compatibility criteria.
---

# Adapter Ecosystem

Croco adapters are the boundary between Croco contracts and external runtimes, SDKs, stores,
protocols, or UI tooling. The extension matrix lists current package support. This page defines
what counts as an adapter, which official candidates are prioritized, and what evidence is required
before an adapter can be treated as compatible or certified.

## Adapter Categories

| Category              | Responsibility                                                                                          | Must not own                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Host adapter          | Owns the lifecycle of a Node process/server, Lambda invocation, or Workers fetch event.                 | Protocol execution, domain behavior, or build artifact configuration.                                |
| Transport adapter     | Executes a protocol/application surface and returns its protocol response.                              | Deployment lifecycle, artifact packaging, or domain behavior.                                        |
| Build-target contract | Describes entrypoint, output, format, hooks, and bundling constraints.                                  | Runtime invocation, request handling, or application lifecycle.                                      |
| Provider adapter      | Implements a domain/core contract through a concrete datastore, SaaS provider, or external service SDK. | Contract definitions that belong in `*-core` packages or runtime bootstrap owned by the application. |
| Integration adapter   | Connects cross-cutting systems such as telemetry, analytics, feature flags, and metrics to Croco APIs.  | Business-domain state or transport request conversion.                                               |
| Presentation adapter  | Connects frontend, SSR, build output, generated clients, and edge/frontend runtimes to Croco contracts. | Server-side secrets, provider SDK ownership, or hidden backend API drift.                            |
| Community adapter     | Implements the same contracts outside the first-party package set.                                      | Compatibility claims without named Croco contract, runtime, and conformance evidence.                |

Hosts bind transports, and build targets may package host entrypoints, but the responsibilities do
not overlap. Provider, integration, and presentation adapters may compose with those runtime
boundaries while keeping their own contracts explicit.

The current `preset-*` packages are intentional host-primary compatibility facades: canonical
`create*Host` APIs own lifecycle and canonical `create*BuildTarget` APIs expose build configuration.
Deprecated preset and entry/handler aliases preserve existing consumers. This is a migration of the
public model, not a package rename.

## Official Priorities

Priority indicates product focus, not current maturity. Maturity still comes from
`docs/package-catalog.json` and the reference gates linked from the extension matrix.

| Priority | Adapter surface                                       | Current first-party package or candidate                                                                             | Boundary decision                                                                                                                                             |
| -------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | HTTP transport and Node/Lambda hosts                  | `@croco/transports-http`, `@croco/preset-node`, `@croco/preset-lambda`                                               | HTTP route execution stays in the transport; Node server and Lambda invocation lifecycles use explicit host APIs.                                             |
| P0       | OpenTelemetry app API and Node runtime SDK            | `@croco/telemetry-api`, `@croco/telemetry-sdk-node`                                                                  | Application code records spans through the API package; SDK initialization and Lambda `forceFlush()` stay in the Node SDK/runtime layer.                      |
| P0       | Drizzle-backed transaction and repository persistence | `@croco/tx-drizzle`, `@croco/*-drizzle` providers                                                                    | Drizzle implementations stay outside `*-core` contract packages and must not leak Drizzle types into core contracts.                                          |
| P1       | Cloudflare Workers host and SSR                       | `@croco/preset-cloudflare`, `@croco/transports-cloudflare-workers`, `@croco/frontend-cloudflare`, `@croco/meta-vite` | The preset facade provides the canonical Workers host; the legacy-named transport package remains a compatibility host adapter.                               |
| P1       | OpenAPI and typed RPC artifacts                       | `@croco/openapi-spec`, `@croco/rpc-codegen`                                                                          | Protocol artifacts are generated from server contracts and consumed by clients/tests without hand-maintained drift.                                           |
| P1       | React and React Query consumption                     | `@croco/frontend-react` plus future React Query client adapter                                                       | React packages own hooks/client consumption and cache integration; they must not own server route metadata or provider secrets.                               |
| P1       | Serverless data and workflow providers                | `@croco/*-upstash`, `@croco/*-qstash` packages                                                                       | Upstash/QStash packages adapt serverless storage, rate-limit, task, batch, and trigger behavior to Croco contracts with explicit retry/idempotency semantics. |
| P2       | Express and Fastify transport adapters                | Future `@croco/transports-express` and `@croco/transports-fastify` candidates                                        | Community-compatible targets after the transport contract is stable; adapters own request/response conversion only.                                           |
| P2       | SaaS/vendor providers                                 | Clerk, Better Auth, Polar, PostHog, Resend, Cloudinary, R2, Meilisearch packages                                     | Vendor packages remain provider/integration adapters and must normalize upstream failure into Croco Problems before promotion.                                |
| P2       | Community adapters                                    | External packages targeting Croco contracts                                                                          | Compatibility depends on the community checklist below; naming should not imply first-party support unless the package is owned by `@croco`.                  |

## Package Naming

Use package names to expose the boundary:

| Package shape                                                  | Meaning                                                                                                                              | Examples                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `@croco/<domain>-core`                                         | Contract package: types, interfaces, value objects, Problems, and in-memory/test defaults when they are part of the domain contract. | `@croco/storage-core`, `@croco/metering-core`, `@croco/repository-core`   |
| `@croco/<domain>-<provider>`                                   | Provider adapter for a datastore, SaaS provider, or external SDK.                                                                    | `@croco/storage-r2`, `@croco/metering-upstash`, `@croco/billing-polar`    |
| `@croco/transports-<protocol>`                                 | Protocol transport adapter.                                                                                                          | `@croco/transports-http`, `@croco/transports-graphql`                     |
| `@croco/preset-<host>`                                         | Host-primary compatibility facade with separate host and build-target APIs.                                                          | `@croco/preset-node`, `@croco/preset-lambda`, `@croco/preset-cloudflare`  |
| `@croco/frontend-<runtime>` or `@croco/<presentation-runtime>` | Presentation/runtime integration.                                                                                                    | `@croco/frontend-react`, `@croco/frontend-cloudflare`, `@croco/meta-vite` |
| `@croco/<protocol>-codegen` or `<artifact>-spec`               | Generated contract artifact tooling.                                                                                                 | `@croco/rpc-codegen`, `@croco/openapi-spec`                               |

`@croco/transports-cloudflare-workers` predates the host/transport distinction. Its name remains a
compatibility surface, while its catalog role and documentation classify it as a Workers host
adapter. Do not infer a package rename from the canonical naming guidance.

Contract packages must not import provider SDKs, concrete ORM libraries, runtime-only globals, or
adapter packages. For example, `@croco/repository-core` must not import `drizzle-orm`,
`@croco/tx-drizzle`, or Drizzle-specific transaction types. Provider and integration packages may
import their upstream SDKs, but they must keep those types behind Croco contracts unless the type is
part of an explicit public adapter API.

## Runtime Support Vocabulary

Runtime support in the extension matrix uses this vocabulary:

| Column   | Meaning                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| Node     | Long-running Node servers, local CLI/runtime use, and Node-compatible build tools.                              |
| Lambda   | AWS Lambda-style serverless functions where cold start, event conversion, and explicit flush boundaries matter. |
| Workers  | Cloudflare Workers-style fetch runtimes with Worker-safe APIs, env bindings, and isolate-local constraints.     |
| Frontend | Browser, SSR frontend, generated client, or frontend build integration.                                         |

`yes` means the package has an explicit compatibility claim for that runtime. `-` means unsupported
or intentionally unclaimed. A package must not silently degrade when a runtime capability is missing;
it should fail with a deterministic Problem, diagnostic, build-time check, or documented unsupported
state.

## RuntimeCapabilityManifest v1

Runtime compatibility claims are represented by `RuntimeCapabilityManifest` artifacts. Generated
apps write `croco-runtime-capability.manifest.json` with `version:
"croco.runtime-capability.manifest.v1"`, a `platform` of `node`, `lambda`, or
`cloudflare-workers`, the deterministic capability map for that platform, optional `composition`,
and any diagnostics found while comparing route/provider requirements against the manifest.

When present, `composition.host` records platform and lifecycle, `composition.transports` records
protocols independently, and `composition.buildTarget` records artifact format/output/constraints.
The manifest is evidence, not executable composition: it does not start a host, execute a transport,
or run a build.

The shared capability vocabulary is owned by `@croco/framework-context` and includes environment
bindings, filesystem access, Node APIs, request lifecycle hooks, tracing, `waitUntil`, flush,
streaming response, deadline, abort signal, and shutdown support. Use
`createRuntimeCapabilityManifest(platform)` to emit a manifest and
`checkRuntimeCapabilityRequirements()` or the runtime-policy manifest comparison helpers to validate
route, service, event-handler, or provider requirements before deployment.

Unsupported capability use must fail visibly. Build-time comparisons emit
`CROCO_RUNTIME_CAPABILITY_001` diagnostics, and runtime hook validation in `@croco/transports-http`
throws `RuntimeCapabilityProblem` with `diagnosticCode`, `platform`, and `capability` extensions.
The recovery path is to choose a runtime that supports the capability, remove the requirement, or
move the behavior behind an adapter that declares the supported runtime boundary.

## Compatibility Certification

Compatibility certification is an evidence record for one package version, one Croco contract, and
one or more runtime claims. It is not a marketing label for a whole package family. A certified
adapter must show which contract it implements, which runtimes it supports, how failures surface,
and which commands prove the claim.

Certification has three states:

| State       | Meaning                                                                                                               | Allowed public claim                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Uncertified | The adapter exists, but one or more checklist areas have no current evidence.                                         | May be listed as alpha or experimental, but must not claim official compatibility.    |
| Candidate   | The adapter has package metadata, docs, and package tests, but conformance, diagnostics, or runtime smoke is missing. | May claim compatibility work in progress for named runtimes and known gaps.           |
| Certified   | Every checklist item has current evidence for the named contract and runtime set.                                     | May claim Croco compatibility for the named contract, runtime set, and version range. |

The certification source of truth for first-party packages is `docs/package-catalog.json` plus the
evidence linked from package README, tests, docs, and release notes. The extension matrix renders the
runtime and maturity metadata, but maturity alone is not certification.
`pnpm provider-certification:check` enforces this record in CI before a provider, integration,
transport, host, or presentation package can remain production-ready with a certification claim.
The catalog policy marks production-ready extension packages and public Croco compatibility claims as
`certified-required`, pre-production tracking records as `candidate-optional`, and extension packages
without those triggers as `not-applicable`. A record may use `state: "candidate"` only after
present live-smoke evidence is recorded.

### Certification Checklist

| Gate                     | Required artifact                                                                                                                                                                    | Verification command or evidence                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Contract boundary        | README names the Croco contract, adapter category, owned boundary, and unsupported boundaries. Core packages do not import provider/runtime SDKs.                                    | `pnpm dependency-boundaries:check`, package manifest normalization, and package README review.                          |
| Runtime claim            | `docs/package-catalog.json` lists only runtimes with explicit support and docs describe unsupported runtimes.                                                                        | `pnpm docs:catalog:check` plus tests for unsupported runtime or option failures where the adapter can detect them.      |
| Conformance behavior     | Shared conformance suite is used when one exists; otherwise package tests cover the public adapter contract directly.                                                                | Package test command for the adapter and conformance harness output, for example `pnpm --filter <pkg> test`.            |
| Failure model            | Missing config, invalid input, not-found, retryable upstream failure, terminal upstream failure, timeout, and unsupported feature paths map to stable Croco Problems or diagnostics. | Focused regression tests that assert Problem code/category or diagnostic code, not generic `Error` text.                |
| Telemetry boundary       | Adapter emits spans/events through `@croco/telemetry-api` without initializing SDK globals inside provider packages; Lambda-like paths document flush.                               | Package tests or smoke output covering span/event hooks and docs review for the flush boundary.                         |
| Diagnostics and secrets  | Readiness/config diagnostics expose required env, peers, stores, bindings, or clients without leaking secret values.                                                                 | Diagnostics tests, redaction tests, or documented no-secret readiness output.                                           |
| Runtime smoke            | No-credential smoke proves the default runtime path. Live-provider smoke is optional, env-gated, and skips clearly when credentials are absent.                                      | CI smoke command, generated-app smoke, or documented local smoke command with skip behavior.                            |
| Release and docs hygiene | README, generated API docs, extension matrix metadata, public API snapshot when applicable, and changeset are updated with behavior changes.                                         | `pnpm docs:catalog:check`, `pnpm public-api:check`, `pnpm changeset-required:check -- --base origin/trunk --head HEAD`. |

### Official Adapter Minimum

First-party adapters may enter the extension matrix before certification, but the minimum bar for a
new official adapter package is:

- package README with install, runtime support, configuration, unsupported features, and a minimal
  usage example;
- package tests for success, invalid input, missing config, upstream/provider failure, and
  unsupported runtime or option cases that can be detected locally;
- extension matrix metadata for adapter category, domain, features, required env/config, peer
  dependencies, runtime claims, maturity, and package test presence;
- deterministic Problem or diagnostic codes for missing configuration and provider/runtime failures;
- no-credential smoke or generated-app smoke for any runtime that executes Croco routes, handlers,
  clients, or framework bootstrap;
- release hygiene through generated API docs, public API snapshot updates when exports change, and
  changesets for publishable behavior.

This minimum is intentionally lower than production-ready maturity. Production-ready still requires
the provider, presentation, transport, host, or integration-specific maturity gates linked from the
extension matrix.

### Badge and Metadata Policy

Compatibility badges are allowed only when they point to the certification evidence. A badge or
README statement should include the Croco contract, adapter package version or version range, runtime
set, and a link to the passing conformance or smoke evidence. Suggested wording:

```text
Croco compatible: <contract> on <runtime list>, verified against <version range>
```

Community packages should keep the same evidence shape in their own README. They may reference the
Croco checklist, but they should not use `@croco/*` naming or "official" wording unless the package
is owned and released by the Croco organization.

## Minimum Compatibility Criteria

An adapter is not compatible just because it compiles. First-party and community adapters should
meet these checks before claiming official support for a runtime:

| Area              | Minimum evidence                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract boundary | The package names the Croco contract it implements and keeps provider/runtime types out of core contracts.                                                                                   |
| Test coverage     | Package tests cover success, invalid input, missing config, upstream/provider failure, and unsupported runtime or option cases. Shared conformance suites are required where one exists.     |
| Runtime smoke     | A no-credential smoke or generated-app smoke proves the claimed runtime path. Live-provider smoke must be optional, env-gated, and skip safely when credentials are absent.                  |
| Problem handling  | Missing config, validation failures, not-found cases, retryable upstream failures, terminal upstream failures, and unsupported features map to deterministic Croco Problem codes/categories. |
| Telemetry         | Adapter spans/events use `@croco/telemetry-api` conventions without initializing SDK globals inside provider packages. Lambda-like runtimes document the flush boundary.                     |
| Diagnostics       | Safe readiness/config diagnostics expose whether required env, peers, stores, bindings, or provider clients are available without leaking secrets.                                           |
| Release docs      | README, generated API docs, extension matrix metadata, maturity gate notes, and changesets are updated when publishable behavior changes.                                                    |

## Community Compatibility

Community adapters should publish a short compatibility statement with:

- the target Croco package and version range;
- the adapter category and package boundary it owns;
- runtime support using the Node/Lambda/Workers/Frontend vocabulary;
- required env, peer dependencies, and secret-handling rules;
- conformance or smoke commands users can run locally;
- Problem mapping and telemetry behavior;
- known unsupported features and recovery path.

Community packages should avoid `@croco/*` naming unless they are first-party packages owned by the
Croco organization. The preferred naming pattern is `<ecosystem>-croco-<domain>-<provider>` or an
organization-scoped equivalent that clearly points back to the Croco contract it implements.
