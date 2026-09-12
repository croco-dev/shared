# @croco/telemetry-api

## 0.1.1

### Patch Changes

- 38cba9c: - fix: enforce full strict contract spine
- b278729: - fix: block critical test tooling advisories
- 7cdfcae: Declare audited package side effects so bundlers remove pure imports while preserving required initialization and CSS.
- b9c981a: - fix: end async-iterable spans and record cleanup failures when iterator cancellation rejects
- 157089a: Remove package-local registry publish commands so releases can only write through the protected Changesets workflow.
- 5d54fb4: declare Apache-2.0 license across all publishable package manifests and ship LICENSE in published packages
- 63a4f8a: OpenTelemetry runtime dependencies now use the patched Jaeger propagation train so malformed propagation headers cannot trigger the known denial-of-service path.
- 847ecbf: Align 1.0 spine package manifests with the checked source-root entrypoint policy and direct-dist exceptions.
- 7c7fbde: Expose asynchronous frontend telemetry sink completion and rejection to direct bridge callers.
- dc6c9bc: Preserve synchronous return values from @Trace methods and end their spans immediately. Promise results remain traced until settlement, and synchronous exceptions retain their identity and error recording.
- 9123362: - fix: treat valid unsampled span contexts as valid

## 0.1.0

### Minor Changes

- 9d6ef7c: Generated frontend RPC clients can propagate browser correlation headers and emit provider-neutral request, Problem, external failure, cancel, retry, and mutation lifecycle telemetry events through a browser-safe telemetry bridge.

### Patch Changes

- d707a0c: Published package manifests now declare the Croco framework GitHub repository metadata required for npm provenance verification.

## 0.0.3

### Patch Changes

- 99f2a6b: fix: align CommonJS package export maps with emitted dist files
