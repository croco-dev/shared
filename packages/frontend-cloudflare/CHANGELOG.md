# @croco/frontend-cloudflare

## 0.1.1

### Patch Changes

- b278729: - fix: block critical test tooling advisories
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 7d248c5: Expose host, transport, and build-target composition as separate runtime metadata, bind host callbacks
  to their owning application scope, preserve the legacy Cloudflare handler context, and teach generated
  apps and presentation adapters to use explicit host and build-target entry points. Generated Lambda and
  Cloudflare SaaS apps now advertise commands that validate their actual deployment targets, including a
  Wrangler configuration with explicit Node.js compatibility for the generated Worker composition. Raw
  Hono callbacks must explicitly select raw-Hono dispatch when using the canonical Cloudflare host.

  Generated SaaS hosts await provider initialization and leave telemetry shutdown to the application
  runtime. Lambda and Workers host artifacts do not enable their documentation-only SaaS provider
  composition; invoking those profiles still reports `CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE`.

- 67e0cbe: fix: resolve published package types before runtime conditions
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- 80cf10b: Return redacted Problem responses with stable diagnostic codes and correlation evidence when Cloudflare API or SSR boundaries fail, and expose a failure reporter for asset, API, and render failures.
- 5223568: Preserve mutation request bodies for API and SSR handlers by limiting static asset lookups to GET and HEAD requests.
- Updated dependencies [ffebb2d]
- Updated dependencies [b278729]
- Updated dependencies [696c76b]
- Updated dependencies [7cdfcae]
- Updated dependencies [d99ede2]
- Updated dependencies [8522b0c]
- Updated dependencies [67e0cbe]
- Updated dependencies [47a4fd9]
- Updated dependencies [7c006af]
- Updated dependencies [e90e7bc]
- Updated dependencies [5d54fb4]
- Updated dependencies [e07a323]
  - @croco/meta-vite@0.0.5

## 0.1.0

### Minor Changes

- f81bcf7: `@croco/frontend-cloudflare` now has beta Worker SSR evidence for service-binding API routing, assets fallback, streaming `Response` preservation, Cloudflare RuntimeContext propagation, and deterministic failure behavior. The generated Cloudflare meta-vite fullstack profile now exports a real Worker SSR handler and smoke-tests the Worker boundary.

### Patch Changes

- 40b024d: Keep published package entrypoints importable by generating advertised declaration files, declaring public runtime and type dependencies on the install surface, deferring Clerk webhook peer loading until webhook handling is used, preserving concrete customer health injection tokens in built output, no longer advertising CommonJS entrypoints that cannot load ESM-only peers, and keeping the migration CLI parser behind binary execution.
- ea92d63: Presentation and Cloudflare Worker packages now have generated-app smoke and API reference evidence for their beta runtime claims.
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- Updated dependencies [dc6723d]
- Updated dependencies [1cd17aa]
- Updated dependencies [1e60ada]
- Updated dependencies [ac40099]
- Updated dependencies [b257dc8]
- Updated dependencies [9f0f082]
- Updated dependencies [81eb35b]
- Updated dependencies [0fdb088]
- Updated dependencies [72eed06]
- Updated dependencies [7bf4452]
- Updated dependencies [40b024d]
- Updated dependencies [d707a0c]
  - @croco/meta-vite@0.0.4

## 0.0.3

### Patch Changes

- Updated dependencies [99f2a6b]
  - @croco/meta-vite@0.0.3
