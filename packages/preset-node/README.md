# @croco/preset-node

Node host and build-target compatibility facade.

`@croco/preset-node` is host-primary: it owns the lifecycle of a long-running Node HTTP server.
It also exposes a Node build target for compatibility with existing `preset-*` configuration. The
host does not define HTTP routes, and the build target does not start or stop the server.

## Public API

- `createNodeHost` - creates the Node server host with explicit `start()` and `close()` lifecycle
  methods.
- `createNodeBuildTarget` - creates the Node build target.
- `createNodeEntry`, `NodeEntry`, and `NodeEntryOptions` - deprecated compatibility aliases for the
  host API.
- `createNodeServerPreset` - deprecated compatibility alias for `createNodeBuildTarget`.
- `NodeEntryCloseTimeoutProblem` - reports an invalid `close(timeoutMs)` value.
- `NodeEntryLifecycleProblem` - reports a stable lifecycle conflict when an entry is started after closing begins.
- `NodeHost` and `NodeHostOptions` - canonical host types.

`NodeHost.start()` shares concurrent startup work and is idempotent after the server starts.
`NodeHost.close(timeoutMs?)` waits for active startup, shares concurrent shutdown work, and permanently closes
the host. It rejects after 30 seconds by default if the Node server does not finish closing. Create a new host
instead of calling `start()` after closing begins.

## Usage

```typescript
import { createNodeBuildTarget } from "@croco/preset-node";

export default createNodeBuildTarget();
```

For runtime composition, create the HTTP application with `@croco/transports-http`, bind its request
callback to the owning `ApplicationRuntime`, and pass that callback to the Node host:

```typescript
import { createApplicationRuntime } from "@croco/framework-module";
import { createNodeHost } from "@croco/preset-node";
import { createApp } from "@croco/transports-http";

const runtime = createApplicationRuntime();
await runtime.initialize();

const app = runtime.run(() => createApp({ controllers: [] }));
const host = createNodeHost({
  fetch: runtime.bindHostCallback((request) => app.fetch(request)),
});

await host.start();
```

Here `@croco/preset-node` owns the process/server lifecycle and `@croco/transports-http` owns HTTP
execution. `createNodeBuildTarget()` is independent of both runtime objects.

## Verification

```bash
pnpm --filter @croco/preset-node test
pnpm --filter @croco/preset-node typecheck
```
