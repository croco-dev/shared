# @croco/framework-routes

## 0.0.5

### Patch Changes

- b278729: - fix: block critical test tooling advisories
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- c64b83f: Generated route registration now accepts `@All()` controllers and binds them through the adapter's all-method registration path.
- a513c78: Generated route modules now resolve declared controllers through Croco DI and invoke their bound handler methods instead of returning placeholder responses.
- 67e0cbe: fix: resolve published package types before runtime conditions
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- c11a9b4: Preserve named catch-all matching and parameter extraction when routes are registered from generated tables, and
  keep published Problem registry source locations synchronized with the shared route compiler import.
- Updated dependencies [4ca14ab]
- Updated dependencies [38cba9c]
- Updated dependencies [b278729]
- Updated dependencies [7008727]
- Updated dependencies [868ea09]
- Updated dependencies [7cdfcae]
- Updated dependencies [c91a72b]
- Updated dependencies [cb61f2e]
- Updated dependencies [9404839]
- Updated dependencies [81ed45b]
- Updated dependencies [26f4b9e]
- Updated dependencies [2cc5438]
- Updated dependencies [7df16bb]
- Updated dependencies [c1ce071]
- Updated dependencies [639abfe]
- Updated dependencies [0fa2546]
- Updated dependencies [008f3f0]
- Updated dependencies [6489abb]
- Updated dependencies [3648511]
- Updated dependencies [dda0a50]
- Updated dependencies [7d248c5]
- Updated dependencies [be7408f]
- Updated dependencies [16cc286]
- Updated dependencies [eed5e70]
- Updated dependencies [a90659b]
- Updated dependencies [cfdc20a]
- Updated dependencies [67e0cbe]
- Updated dependencies [e3bb85e]
- Updated dependencies [44fb02d]
- Updated dependencies [1c843a5]
- Updated dependencies [45882f1]
- Updated dependencies [f0c328e]
- Updated dependencies [efb33f9]
- Updated dependencies [157089a]
- Updated dependencies [df8d018]
- Updated dependencies [5d54fb4]
- Updated dependencies [20eccc9]
- Updated dependencies [e745cc9]
- Updated dependencies [33d4b2f]
- Updated dependencies [54f9a57]
- Updated dependencies [65f9c8a]
- Updated dependencies [c5eee6e]
- Updated dependencies [a2760e3]
- Updated dependencies [ab51ace]
- Updated dependencies [c11a9b4]
- Updated dependencies [8aa72a1]
- Updated dependencies [f141c18]
- Updated dependencies [7f7ccee]
- Updated dependencies [5306098]
- Updated dependencies [6cb0a5c]
- Updated dependencies [fa8eea4]
- Updated dependencies [aa19802]
- Updated dependencies [ea4d1d1]
- Updated dependencies [7b1505b]
- Updated dependencies [8c1acbd]
- Updated dependencies [99da854]
- Updated dependencies [76e734f]
- Updated dependencies [0e0a46c]
- Updated dependencies [377c684]
  - @croco/framework-context@0.1.0
  - @croco/protocols-core@0.2.0
  - @croco/protocols-rest@0.1.0

## 0.0.4

### Patch Changes

- d281518: - fix: close package docs coverage gaps
- 6607359: Expose a typed framework manifest artifact for generated Croco app structure.
- 7a8de8c: Exclude internal test fixture build output from published package artifacts while keeping build-time route generation intact.
- be5b2cd: Generate an explicit HTTP controller route registration table and fail generation when the table has duplicate or missing route registrations.
- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.
- 0ae5c7d: Generate an LLM-readable project intent map alongside route registration artifacts.
- Updated dependencies [d281518]
- Updated dependencies [ea14bd4]
- Updated dependencies [73e430a]
- Updated dependencies [a77425f]
- Updated dependencies [2631037]
- Updated dependencies [529c7fd]
- Updated dependencies [f3951f3]
- Updated dependencies [6148ed3]
- Updated dependencies [779fa6f]
- Updated dependencies [988f072]
- Updated dependencies [ee924c0]
- Updated dependencies [5403360]
- Updated dependencies [e12e825]
- Updated dependencies [6831875]
- Updated dependencies [9c1bc2e]
- Updated dependencies [a61dcd4]
- Updated dependencies [4c7fcd9]
- Updated dependencies [1dc1607]
- Updated dependencies [48ce207]
- Updated dependencies [6c26eb4]
- Updated dependencies [9a2040b]
- Updated dependencies [955b02e]
- Updated dependencies [d707a0c]
- Updated dependencies [d117fca]
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
- Updated dependencies [f8e4056]
- Updated dependencies [bb59160]
- Updated dependencies [d314bd4]
- Updated dependencies [83ac49f]
  - @croco/protocols-core@0.1.0
  - @croco/protocols-rest@0.0.4
  - @croco/framework-context@0.0.4

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
- Updated dependencies [99f2a6b]
  - @croco/framework-context@0.0.3
  - @croco/protocols-rest@0.0.3
