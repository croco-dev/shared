# @croco/rpc-codegen

Generated RPC clients for Croco route contracts.

`@croco/rpc-codegen` reads route metadata or contract graphs and emits typed RPC client
files. Generated clients preserve request, response, Problem, query-key, and optional
React Query contracts without hand-maintained glue code.

## Public API

- `generateClientFiles` - emits client files from route definitions.
- `generateClientFilesFromContractGraph` - emits client files from a contract graph.
- `createFrontendActionManifestFromRoutes` and `createFrontendActionManifestFromContractGraph` -
  emit the shared frontend action manifest for generated REST RPC routes.
- `loadContractGraph` and `loadRoutes` - load generator inputs.
- Generator option and Problem-runtime types.

## Usage

```typescript
import { generateClientFilesFromContractGraph } from "@croco/rpc-codegen";
import { createMetaViteFrontendActionManifestFromRegistry } from "@croco/meta-vite";

const metaViteManifest = createMetaViteFrontendActionManifestFromRegistry({
  serverActionRegistry,
});

await generateClientFilesFromContractGraph(graph, "./src/generated/rpc", {
  frontendActionManifestPath: "./src/generated/frontend-action-manifest.json",
  frontendActionManifestInputs: [{ source: "@croco/meta-vite", manifest: metaViteManifest }],
});
```

Each successful generation records its owned output paths and created directories in
`.croco-rpc-codegen.json`. Later generations remove only stale paths recorded by that manifest,
including newly empty generated directories, and preserve every unrelated file under the output
directory. Generation validates the complete client contract and ownership manifest before it
changes the previous output.

This call is the single manifest writer for the workspace: RPC routes are added automatically and
the supplied Meta Vite manifest contributes registered server actions. Do not run a second writer
against the same destination. Schema mismatches and conflicting duplicate action IDs fail before
the destination is replaced.

The manifest is a stable `croco.frontend-action-manifest.v1` artifact. It lets humans, CI, and
LLM tooling inspect which generated client actions exist, which REST contract each one calls, the
generated input/output type references, declared Problems, access metadata, entitlements, and
mutation invalidation hints.

When REST RPC is the only manifest producer, the CLI can generate and check the artifact directly:

```bash
croco-rpc-codegen \
  --controllers "src/controllers/**/*.ts" \
  --out src/generated/rpc \
  --frontend-action-manifest src/generated/frontend-action-manifest.json
```

```bash
croco-rpc-codegen \
  --controllers "src/controllers/**/*.ts" \
  --frontend-action-manifest src/generated/frontend-action-manifest.json \
  --frontend-action-manifest-check
```

For a composed manifest, CI must reconstruct the same producer set used by generation before checking drift:

```typescript
import { createMetaViteFrontendActionManifestFromRegistry } from "@croco/meta-vite";
import {
  checkFrontendActionManifestFile,
  mergeFrontendActionManifests,
} from "@croco/presentation-preset";
import { createFrontendActionManifestFromContractGraph } from "@croco/rpc-codegen";

const expected = mergeFrontendActionManifests([
  {
    source: "@croco/meta-vite",
    manifest: createMetaViteFrontendActionManifestFromRegistry({ serverActionRegistry }),
  },
  { source: "@croco/rpc-codegen", manifest: createFrontendActionManifestFromContractGraph(graph) },
]);
const drift = await checkFrontendActionManifestFile(
  expected,
  "./src/generated/frontend-action-manifest.json",
);

if (!drift.ok) {
  process.exitCode = 1;
}
```

Every generated domain exports a client factory for instance-scoped transport policy. `baseUrl`
preserves its path prefix when joining procedure paths and normalizes slashes at the join. For example,
`https://api.example.com/api/v1/` with `/users` requests `https://api.example.com/api/v1/users`.
`fetch` replaces the global implementation for every domain method,
`headers` supplies shared headers, and `request` supplies default `RequestInit` fields such as
credentials or cache policy. The existing static client export remains available and behaves like
`createUserClient()` with no configuration.

```typescript
import { createUserClient } from "./generated/rpc";

const userClient = createUserClient({
  baseUrl: "https://api.example.com",
  fetch: authenticatedFetch,
  headers: { "x-client-version": "web-1" },
  request: { credentials: "include" },
});

await userClient.getUser(
  { path: { id: "user-1" } },
  {
    headers: { "x-request-id": "request-1" },
    request: { cache: "no-store" },
    signal,
  },
);
```

Request initialization applies client defaults first and per-request overrides second while route
method and body fields remain generator-owned. Headers merge case-insensitively in this order:
client defaults, generated route headers, telemetry headers, then explicit per-request headers.

Generated clients also accept telemetry defaults in the factory or an optional
`RpcClientRequestOptions` argument per call. Browser apps can pass a provider-neutral telemetry
bridge from `@croco/telemetry-api` to attach correlation headers and record request lifecycle events.

```typescript
import { createFrontendTelemetryBridge } from "@croco/telemetry-api";
import { userClient } from "./generated/rpc";

const telemetry = createFrontendTelemetryBridge({
  sink: {
    record: (event) => {
      console.debug(event.kind, event.routeId, event.durationMs);
    },
  },
});

const result = await userClient.getUserResult(
  { path: { id: "user-1" } },
  { telemetry, correlationId: telemetry.correlationId },
);
```

Generated `*Result` methods resolve rejected `fetch` calls, including fetch-stage cancellation, as
`{ ok: false, kind: "external", error }`. Those failures have no `response`; HTTP-backed external
failures continue to include one. Once a response exists, response-body cancellation rejects with
the original `AbortError`. The equivalent throwing methods preserve the rejected `fetch` error.

Generated query arrays are serialized as repeated query keys. Generated header arrays accept
readonly arrays and serialize them as comma-separated header values, matching Croco HTTP runtime
validation and OpenAPI parameter serialization.

The generated runtime records `rpc.request.*` events for start, retry attempts, success, declared
Problems, external failures, and cancellations. Non-GET routes also emit `rpc.mutation.*` lifecycle
events. Event payloads are limited to route metadata, status, latency, correlation ids, and stable
Problem metadata; request bodies, query values, raw headers, response bodies, credentials, and
Problem `detail`/`instance` fields are intentionally not emitted.

Generated React Query hooks and mutation factories expose the same path through `options.rpc`:

```typescript
useGetUser({ path: { id: "user-1" } }, { rpc: { telemetry } });
useCreateUser({ rpc: { telemetry } });
```

React Query option factories can bind to a configured client instance while the existing static
factories continue to use the generated static client:

```typescript
import { createUserClient, userRpc } from "./generated/rpc";

const userClient = createUserClient({ baseUrl: "https://api.example.com" });
const userQueries = userRpc.createUserQueries(userClient);
const userMutations = userRpc.createUserMutations(userClient);
```

## Verification

```bash
pnpm --filter @croco/rpc-codegen test
pnpm --filter @croco/rpc-codegen typecheck
```
