# @croco/framework-logger

## 0.0.5

### Patch Changes

- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 8565d48: Remove case-insensitive sensitive keys from nested log contexts, arrays, child bindings, and Error metadata before serialization.
- 67e0cbe: fix: resolve published package types before runtime conditions
- 1c843a5: Preserve runtime class-decorator metadata in published ESM and CJS bundles so Croco can resolve concrete constructor dependencies from installed packages.
- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- 061d4bc: Create child loggers without allocating discarded Pino transports or worker resources.
- 1d5ed40: Ship the pretty-print transport required when Logger starts outside production.
- Updated dependencies [4ca14ab]
- Updated dependencies [38cba9c]
- Updated dependencies [7008727]
- Updated dependencies [868ea09]
- Updated dependencies [7cdfcae]
- Updated dependencies [9404839]
- Updated dependencies [26f4b9e]
- Updated dependencies [2cc5438]
- Updated dependencies [7df16bb]
- Updated dependencies [0fa2546]
- Updated dependencies [008f3f0]
- Updated dependencies [6489abb]
- Updated dependencies [dda0a50]
- Updated dependencies [7d248c5]
- Updated dependencies [be7408f]
- Updated dependencies [16cc286]
- Updated dependencies [eed5e70]
- Updated dependencies [144b80b]
- Updated dependencies [cfdc20a]
- Updated dependencies [67e0cbe]
- Updated dependencies [e3bb85e]
- Updated dependencies [fb10b5f]
- Updated dependencies [1c843a5]
- Updated dependencies [45882f1]
- Updated dependencies [f0c328e]
- Updated dependencies [efb33f9]
- Updated dependencies [157089a]
- Updated dependencies [5d54fb4]
- Updated dependencies [8aa72a1]
- Updated dependencies [f141c18]
- Updated dependencies [8c1acbd]
- Updated dependencies [99da854]
- Updated dependencies [76e734f]
  - @croco/framework-context@0.1.0
  - @croco/framework-config@1.0.0

## 0.0.4

### Patch Changes

- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- Updated dependencies [ee924c0]
- Updated dependencies [5403360]
- Updated dependencies [e12e825]
- Updated dependencies [6831875]
- Updated dependencies [a61dcd4]
- Updated dependencies [4c7fcd9]
- Updated dependencies [1dc1607]
- Updated dependencies [d707a0c]
- Updated dependencies [aacdad6]
- Updated dependencies [9c2ac20]
- Updated dependencies [de7610e]
- Updated dependencies [14bd9f8]
- Updated dependencies [0618b12]
- Updated dependencies [41ee87a]
- Updated dependencies [c54e7b5]
- Updated dependencies [d1552a5]
  - @croco/framework-context@0.0.4
  - @croco/framework-config@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
  - @croco/framework-context@0.0.3
  - @croco/framework-config@0.0.3
