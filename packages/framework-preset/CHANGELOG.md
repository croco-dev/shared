# @croco/framework-preset

## 0.1.0

### Minor Changes

- 7d248c5: Expose host, transport, and build-target composition as separate runtime metadata, bind host callbacks
  to their owning application scope, preserve the legacy Cloudflare handler context, and teach generated
  apps and presentation adapters to use explicit host and build-target entry points. Generated Lambda and
  Cloudflare SaaS apps now advertise commands that validate their actual deployment targets, including a
  Wrangler configuration with explicit Node.js compatibility for the generated Worker composition. Raw
  Hono callbacks must explicitly select raw-Hono dispatch when using the canonical Cloudflare host.

  Generated SaaS hosts await provider initialization and leave telemetry shutdown to the application
  runtime. Lambda and Workers host artifacts do not enable their documentation-only SaaS provider
  composition; invoking those profiles still reports `CROCO_SAAS_PROFILE_RUNTIME_UNAVAILABLE`.

- 48d775c: Allow presets to override individual output fields while preserving the remaining output configuration.

### Patch Changes

- b278729: - fix: block critical test tooling advisories
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 67e0cbe: fix: resolve published package types before runtime conditions
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages

## 0.0.4

### Patch Changes

- d281518: - fix: close package docs coverage gaps
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
