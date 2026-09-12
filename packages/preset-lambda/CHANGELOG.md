# @croco/preset-lambda

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

### Patch Changes

- b278729: - fix: block critical test tooling advisories
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- bf9a514: Lambda preset handlers can now flush telemetry before returning, and `croco doctor` detects preset handlers that omit the flush boundary.
- 06b597e: Require the fixed Hono release for HTTP, Node, and Lambda consumers so packed packages cannot resolve the affected request-isolation, repeated-header, and audited CORS-header ReDoS ranges.
- 67e0cbe: fix: resolve published package types before runtime conditions
- e90e7bc: Enforce deterministic compatibility snapshots for every published export subpath, including conditional code targets and manifest-only assets.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- Updated dependencies [8214d67]
- Updated dependencies [5a7fe34]
- Updated dependencies [f3709a6]
- Updated dependencies [98001e1]
- Updated dependencies [b278729]
- Updated dependencies [8bb215f]
- Updated dependencies [868ea09]
- Updated dependencies [7cdfcae]
- Updated dependencies [cb36e68]
- Updated dependencies [26f4b9e]
- Updated dependencies [00bfe50]
- Updated dependencies [13f74d8]
- Updated dependencies [d2e17ce]
- Updated dependencies [7df16bb]
- Updated dependencies [500c048]
- Updated dependencies [3648511]
- Updated dependencies [7d248c5]
- Updated dependencies [f11142a]
- Updated dependencies [ab4453f]
- Updated dependencies [8522b0c]
- Updated dependencies [be7408f]
- Updated dependencies [b875cea]
- Updated dependencies [06b597e]
- Updated dependencies [a513c78]
- Updated dependencies [ba6ba75]
- Updated dependencies [a4eacbf]
- Updated dependencies [80ddb00]
- Updated dependencies [d52f81f]
- Updated dependencies [b228e78]
- Updated dependencies [eed5e70]
- Updated dependencies [afb8544]
- Updated dependencies [7caa3ea]
- Updated dependencies [54f61ee]
- Updated dependencies [3e29376]
- Updated dependencies [1786455]
- Updated dependencies [68eb95a]
- Updated dependencies [0ee816f]
- Updated dependencies [67e0cbe]
- Updated dependencies [e3bb85e]
- Updated dependencies [1c843a5]
- Updated dependencies [c1dc054]
- Updated dependencies [a8d733b]
- Updated dependencies [20cb828]
- Updated dependencies [efb33f9]
- Updated dependencies [157089a]
- Updated dependencies [5d54fb4]
- Updated dependencies [1910ff9]
- Updated dependencies [f2798d2]
- Updated dependencies [e745cc9]
- Updated dependencies [7328ec4]
- Updated dependencies [f2094bc]
- Updated dependencies [c5eee6e]
- Updated dependencies [90133b3]
- Updated dependencies [a2760e3]
- Updated dependencies [e97f694]
- Updated dependencies [ab51ace]
- Updated dependencies [5575357]
- Updated dependencies [524f00c]
- Updated dependencies [c11a9b4]
- Updated dependencies [5e64d94]
- Updated dependencies [7f7ccee]
- Updated dependencies [a8bc534]
- Updated dependencies [1a209ad]
- Updated dependencies [f22f68f]
- Updated dependencies [4fe1d1e]
- Updated dependencies [48d775c]
- Updated dependencies [6754896]
- Updated dependencies [d808f9d]
- Updated dependencies [377c684]
  - @croco/transports-http@0.1.0
  - @croco/framework-preset@0.1.0

## 0.0.4

### Patch Changes

- d281518: - fix: close package docs coverage gaps
- 6c0bfda: Preset factories no longer advertise runtime options that they cannot apply; Node server options remain on `createNodeEntry`, where they affect server startup.
- b6449cc: HTTP runtime packages now require a patched Hono range so production dependency audits do not include known high-severity Hono advisories.
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- Updated dependencies [4d8f094]
- Updated dependencies [6769a7f]
- Updated dependencies [d281518]
- Updated dependencies [51b0f14]
- Updated dependencies [a77425f]
- Updated dependencies [6148ed3]
- Updated dependencies [ee924c0]
- Updated dependencies [5403360]
- Updated dependencies [da861c8]
- Updated dependencies [e108899]
- Updated dependencies [c0c7215]
- Updated dependencies [42bc50e]
- Updated dependencies [9f7e769]
- Updated dependencies [000e999]
- Updated dependencies [8a85c6a]
- Updated dependencies [9556d22]
- Updated dependencies [f40eb63]
- Updated dependencies [b6449cc]
- Updated dependencies [d707a0c]
- Updated dependencies [58b689a]
- Updated dependencies [eeebc70]
- Updated dependencies [9c2ac20]
- Updated dependencies [de7610e]
- Updated dependencies [14bd9f8]
- Updated dependencies [0618b12]
- Updated dependencies [41ee87a]
- Updated dependencies [7442f1c]
- Updated dependencies [bc5594d]
  - @croco/transports-http@0.0.4
  - @croco/framework-preset@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
  - @croco/transports-http@0.0.3
  - @croco/framework-preset@0.0.3
