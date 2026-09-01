# @croco/framework-preset

Typed build-target contract for Croco packages and tooling.

`@croco/framework-preset` describes build-time entrypoints, output directories, module formats,
and build hooks. It does not own a Node process, Lambda invocation, Workers fetch lifecycle, or
protocol execution.

A build target may package an entrypoint that starts a host, but the two contracts stay separate:

- a **host** owns the environment lifecycle;
- a **transport** executes an application protocol such as HTTP;
- a **build target** describes the artifact produced for deployment.

## Public API

- `defineCrocoBuildTarget` - creates an immutable build-target object.
- `CrocoBuildTarget`, `CrocoBuildTargetConfig`, `CrocoBuildTargetOverride`, and `HookMap` - canonical
  build-target contract types.
- `defineCrocoPreset`, `CrocoPreset`, `CrocoPresetConfig`, and `CrocoPresetOverride` - deprecated
  compatibility aliases for the build-target contract.

## Usage

```typescript
import { defineCrocoBuildTarget } from "@croco/framework-preset";

export const workerBuildTarget = defineCrocoBuildTarget({
  name: "worker",
  entry: "./fetch.js",
  output: {
    dir: "dist",
    format: "esm",
  },
});

export const commonJsWorkerBuildTarget = workerBuildTarget.extend({
  output: {
    format: "cjs",
  },
});
```

## Verification

```bash
pnpm --filter @croco/framework-preset test
pnpm --filter @croco/framework-preset typecheck
```
