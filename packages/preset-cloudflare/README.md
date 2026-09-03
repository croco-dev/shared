# @croco/preset-cloudflare

Cloudflare Workers host and build-target compatibility facade.

`@croco/preset-cloudflare` is host-primary: it binds an application to the Workers
`fetch(request, env, ctx)` lifecycle and creates the corresponding runtime context. It also exposes
a Workers build target for compatibility with existing `preset-*` configuration. HTTP protocol
execution remains separate.

## Public API

- `createCloudflareWorkersHost` - creates the canonical Workers fetch host.
- `createCloudflareBuildTarget` - creates the Workers build target.
- `CloudflareBuildTargetOptions` - canonical build-target options.
- `createWorkerFetchHandler` - deprecated compatibility adapter with the legacy runtime-context shape.
- `createCloudflarePreset` - deprecated compatibility alias for `createCloudflareBuildTarget`.
- `CloudflarePresetOptions` - deprecated compatibility alias for `CloudflareBuildTargetOptions`.
- `createRawHonoWorkerFetchHandler` - explicit compatibility path for raw Hono forwarding.
- Worker fetch and runtime context types.

## Usage

```typescript
import { createCloudflareBuildTarget } from "@croco/preset-cloudflare";

export default createCloudflareBuildTarget({
  entry: "./src/fetch.ts",
});
```

Runtime composition is independent of the build target:

```typescript
import { createApplicationRuntime } from "@croco/framework-module";
import { createCloudflareWorkersHost } from "@croco/preset-cloudflare";
import { createApp } from "@croco/transports-http";

const runtime = createApplicationRuntime();
await runtime.initialize();

const app = runtime.run(() => createApp({ controllers: [] }));
const fetch = runtime.bindHostCallback(createCloudflareWorkersHost(app));

export default { fetch };
```

The preset facade owns the Workers lifecycle, `@croco/transports-http` owns HTTP execution, and
`createCloudflareBuildTarget()` only describes the deployable artifact.

## Verification

```bash
pnpm --filter @croco/preset-cloudflare test
pnpm --filter @croco/preset-cloudflare typecheck
```
