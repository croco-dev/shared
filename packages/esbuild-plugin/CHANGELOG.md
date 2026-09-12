# @croco/esbuild-plugin

## 0.0.5

### Patch Changes

- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- 2737eaa: Keep published runtime peer compatibility on the dependency versions Croco verifies, and reject unbounded future dependency trains.
- b3c018b: Emit valid registry imports for TSX components by deriving decorated export
  symbol names from scanner output instead of the file basename, and normalize
  both `.ts` and `.tsx` module suffixes in generated import paths.
- 67e0cbe: fix: resolve published package types before runtime conditions
- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- 7b0afc7: Preserve TSX parsing when the Croco plugin injects metadata or component imports into JSX entry points.
- a75563f: Require TypeScript 6 consumers while preserving Croco 1.x legacy decorator metadata and generated application
  compiler settings.

## 0.0.4

### Patch Changes

- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
