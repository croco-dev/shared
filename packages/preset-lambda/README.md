# @croco/preset-lambda

AWS Lambda host and build-target compatibility facade.

`@croco/preset-lambda` is host-primary: it adapts an HTTP application to the Lambda invocation
lifecycle. It also exposes a Lambda build target for compatibility with existing `preset-*`
configuration. HTTP route execution remains owned by `@croco/transports-http`.

## Public API

- `createLambdaHost` - creates the Lambda invocation host and accepts transport
  `LambdaHandlerOptions`, including the invocation-end `flush` boundary.
- `createLambdaBuildTarget` - creates the Lambda build target.
- `createLambdaHandler` - deprecated compatibility alias for `createLambdaHost`.
- `createLambdaPreset` - deprecated compatibility alias for `createLambdaBuildTarget`.
- Lambda event, context, handler, options, and response types.

## Usage

```typescript
import { createLambdaBuildTarget } from "@croco/preset-lambda";

export default createLambdaBuildTarget();
```

Connect `TelemetryRuntime.forceFlush()` through the handler options so queued telemetry is exported
before the Lambda invocation returns. A rejected `flush` callback rejects the handler instead of
hiding an observability failure behind a successful response.

```typescript
import { createApplicationRuntime } from "@croco/framework-module";
import { createLambdaHost } from "@croco/preset-lambda";
import { TelemetryForceFlushUnsupportedProblem, TelemetryRuntime } from "@croco/telemetry-sdk-node";
import { createApp } from "@croco/transports-http";

const telemetry = TelemetryRuntime.getInstance();
const runtime = createApplicationRuntime();
await runtime.initialize();

const app = runtime.run(() => createApp({ controllers: [] }));

const lambdaHost = createLambdaHost(app, {
  flush: async () => {
    const result = await telemetry.forceFlush();
    if (result.outcome === "failed") {
      throw result.error;
    }
    if (result.outcome === "unsupported") {
      throw new TelemetryForceFlushUnsupportedProblem();
    }
  },
});

export const handler = runtime.bindHostCallback(lambdaHost);
```

`bindHostCallback()` re-enters the application-owned DI scope for every invocation and rejects access
after the runtime is disposed. The Lambda host owns invocation conversion and flushing; the HTTP app
continues to own protocol execution.

See [`@croco/transports-http`](../transports-http/README.md#앱-생성과-lambda-host-연결) for the
complete telemetry initialization and flush pattern.

## Verification

```bash
pnpm --filter @croco/preset-lambda test
pnpm --filter @croco/preset-lambda typecheck
```
