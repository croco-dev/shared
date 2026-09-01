# @croco/framework-module

`@croco/framework-module` defines the runtime contract for Croco feature modules.
Modules group providers, controllers, lifecycle hooks, and imported modules behind
an explicit boundary.

## Module Contract

```ts
import { CrocoModule, defineCrocoModule } from "@croco/framework-module";

const databaseModule = defineCrocoModule({
  name: "database",
  providers: [{ provide: "database.url", useValue: process.env.DATABASE_URL }],
  exports: ["database.url"],
});

CrocoModule.use({
  name: "users",
  imports: [databaseModule],
  providers: [UserService],
  controllers: [UserController],
  setup: (ctx, execution) => {
    const databaseUrl = ctx.get("database.url");
    execution.signal.throwIfAborted();
  },
  start: async (_ctx, { signal }) => {
    signal.throwIfAborted();
    await warmUserCache({ signal });
  },
  shutdown: async (_ctx, { signal, deadline }) => {
    signal.throwIfAborted();
    await closeUserResources({ signal });
  },
});
```

Supported metadata:

- `name`: stable module identifier used by diagnostics and failure messages.
- `imports`: modules that must initialize first.
- `providers`: tokens, classes, values, classes bound to tokens, or factories owned by the module.
- `exports`: provider tokens visible to direct importers.
- `controllers`: transport-facing controller tokens recorded for diagnostics.
- `setup`, `start`, `shutdown`: lifecycle hooks.

## Isolated Module Runtimes

Use `createModuleRuntime()` when one process hosts multiple applications, test
fixtures, or workers that must not share module names, lifecycle state, or
provider instances:

```ts
import {
  createModuleRuntime,
  defineCrocoModule,
  ModuleDiagnosticsProvider,
} from "@croco/framework-module";

const runtime = createModuleRuntime();

try {
  runtime.use(
    defineCrocoModule({
      name: "app",
      providers: [{ provide: "app.name", useValue: "worker-a" }],
      exports: ["app.name"],
    }),
  );

  const context = await runtime.initialize();
  const appName = context.get("app.name");
  const health = await new ModuleDiagnosticsProvider(runtime).getHealth();
} finally {
  await runtime.dispose();
}
```

Each created runtime owns its registry, initialization and shutdown operations,
diagnostics state, and a named TypeDI container. Resolve runtime providers through
the `ModuleContext` returned by `initialize()` or supplied to lifecycle hooks;
isolated runtimes do not fall back to providers in the process-global TypeDI
container.

`shutdown()` runs lifecycle cleanup and leaves the registered graph reusable.
`reset()` synchronously clears the graph without running shutdown hooks. Call
`shutdown()` first when cleanup is required. An isolated runtime rejects reset
while initialization or shutdown is still active; wait for that operation to
finish before resetting. `dispose()` joins in-flight
initialization or shutdown, runs remaining shutdown hooks once, releases the
owned container even when cleanup fails, and permanently closes the runtime.
Contexts from a graph cleared by `reset()` throw
`ModuleRuntimeStaleContextProblem`; use the context returned when the replacement
graph is initialized. Further runtime or context access after disposal throws
`ModuleRuntimeDisposedProblem`.

The static `CrocoModule` API remains the compatible default-runtime facade for
applications that need only one module graph.

## Application Runtime

`createApplicationRuntime()` is the canonical application-owned composition boundary. It binds one
`ContainerScope` to one module runtime, enters that scope for every lifecycle phase, and lets async
bootstrap work and host callbacks re-enter the same DI runtime explicitly.

```ts
import { createApplicationRuntime, defineCrocoModule } from "@croco/framework-module";

const runtime = createApplicationRuntime({
  modules: [
    defineCrocoModule({
      name: "app",
      providers: [{ provide: "app.name", useValue: "orders" }],
    }),
  ],
});

await runtime.initialize();

const appName = runtime.get("app.name");
const response = await runtime.run(() => handleRequest());
const hostCallback = runtime.bindHostCallback(() => handleRequest());
const graph = runtime.createGraphManifest();

await runtime.dispose();
```

Two application runtimes can reuse module names and provider tokens without sharing registrations or
instances. `createGraphManifest()` returns one deterministic envelope containing the module graph and
the DI graph derived from that runtime's module provider and controller roots. It never uses the
process-global component inventory as an implicit graph source.

Use `bindHostCallback()` at host boundaries that retain a callback, such as a Lambda handler,
Workers `fetch`, or Node request callback. The returned function re-enters the same application-owned
scope before invoking the callback. It also observes the runtime lifecycle: creating or calling the
binding after disposal fails through the runtime or disposed container-scope contract instead of
executing against stale DI state. `run()` remains the direct re-entry API for bootstrap work that is
invoked immediately.

Initialization is transactional. A failed attempt compensates entered modules, restores the exact
pre-attempt DI baseline, invalidates captured module contexts, and permits an explicit retry. If
compensation itself fails, the runtime is disposed because a clean retry can no longer be proven.
`dispose()` always shuts modules down before disposing the DI scope. The static `Container` and
`CrocoModule` APIs remain compatibility/default-runtime surfaces; new application composition should
use `ApplicationRuntime` and explicit `run()` re-entry instead of relying on ambient global state.

## Provider Visibility

Providers are private to the owning module unless their token appears in
`exports`. A module can resolve its own providers and the exported providers of
its direct imports. Accessing a known but non-exported provider throws
`ModuleProviderVisibilityProblem`.

Module-scoped contexts also reject undeclared class providers. Register class
providers in the module's `providers` metadata, or export them from an imported
module, before resolving them through `ctx.get`.
Token-backed TypeDI classes should be declared as
`{ provide: Token, useClass: ServiceClass }`; exporting a token alone does not
make global `@Service(token)` class metadata part of the module contract.

## Provider Ownership

Each provider token has exactly one declaring module. Croco validates the complete
module graph before provider factories, lifecycle hooks, or global TypeDI
registration run. If unrelated modules declare the same string, symbol, TypeDI
token, or class token, initialization throws `ModuleProviderOwnershipProblem`
with every owner in deterministic name order. Importing an exported provider
grants read access and does not create another owner.

Module metadata is snapshotted when the module is registered. Later mutations to
source `imports`, `providers`, `exports`, or `controllers` arrays do not change
the graph that initialization validates and executes.

`ModuleContext.set()` may only bind a token already listed in the current
module's `providers`. Imported providers are read-only, undeclared writes fail
before container mutation, and the root context returned by initialization does
not have provider-write authority. Use a token-only provider declaration when a
lifecycle hook supplies the value:

```ts
const ConfigToken = Symbol("config");

defineCrocoModule({
  name: "config",
  providers: [ConfigToken],
  exports: [ConfigToken],
  setup: (ctx) => ctx.set(ConfigToken, loadConfig()),
});
```

This package intentionally records controllers but does not bind them to an HTTP,
GraphQL, RPC, or worker transport. Transport packages decide how controller
tokens become routes or handlers.

## Lifecycle Semantics

Initialization is dependency ordered:

1. imported module providers and `setup`
2. importer providers and `setup`
3. imported module `start`
4. importer `start`

Shutdown runs in reverse dependency order. Lifecycle failures are wrapped in
`ModuleLifecycleProblem` with `moduleName` and `phase` extensions. Circular
imports throw `ModuleCircularDependencyProblem`.

Every lifecycle hook receives its existing `ModuleContext` as the first argument
and a shared execution contract as the second argument. The execution contract
contains the current `phase`, the same context as `moduleContext`, a child
`AbortSignal`, and the absolute Unix-millisecond `deadline` when the operation
has one. Existing one-argument hooks remain compatible; add the second argument
when migrating a hook to cooperative cancellation.

```ts
const controller = new AbortController();
const deadline = Date.now() + 30_000;

await runtime.initialize({ signal: controller.signal, deadline });
await runtime.shutdown({ signal: controller.signal, deadline });
```

The runtime composes the parent signal and deadline for each hook. The first
observed cancellation source wins, and a hook that settles after its signal
aborts is not recorded as successful. Parent cancellation rejects with
`ModuleLifecycleCancelledProblem`; deadline expiry rejects with
`ModuleLifecycleDeadlineExceededProblem`; user hook failures remain
`ModuleLifecycleProblem`. Invalid deadlines fail before lifecycle work with
`InvalidModuleLifecycleDeadlineProblem`. If a hook throws its own error after
cancellation was observed, the cancellation or deadline remains the operation
result and its `hookFailure` extension preserves the distinct
`framework-module/lifecycle-failed` evidence.

Cancellation is cooperative. Croco aborts the hook signal but awaits the hook's
actual settlement so an orphaned hook cannot mutate module providers after
rollback. Hooks should pass the signal into cancellable I/O and stop promptly
when it aborts. Initialization rollback and direct shutdown still attempt every
applicable cleanup hook in reverse order, including hooks entered after the
operation signal has already aborted.

Concurrent `initialize()` or `shutdown()` calls join the existing Promise. The
caller that creates the operation owns its signal and deadline; later callers
cannot replace the active operation's cancellation contract.

Shutdown attempts every initialized module even when individual hooks fail or
the operation is cancelled, then rejects with the first lifecycle execution
Problem and exposes every ordered failure through its `cleanupFailures`
extension. Active runtime state is reset after all hooks complete, including
failed shutdown attempts.

If `setup` or `start` fails, initialization calls `shutdown` for every module
whose setup phase was entered, including the failing module, in reverse
dependency order. Cleanup continues after individual shutdown failures. The
original `ModuleLifecycleProblem` remains the rejected error and exposes any
cleanup errors through its ordered `cleanupFailures` extension. Provider
registrations and overwritten container values are restored to their exact
pre-attempt state, so callers can retry initialization explicitly.

Module registration is accepted only while the registry is idle. Calls made during
initialization, after initialization, or while shutdown is running fail with
`ModuleRegistrationConflictProblem` before changing the registered graph. Call
`CrocoModule.shutdown()` or `CrocoModule.reset()` before registering a new graph.

## Dynamic Modules, Hosts, And Build Targets

Dynamic modules should return `ModuleOptions` from a factory and can be wrapped
with `defineCrocoModule` for a stable, frozen public contract:

```ts
export function createCacheModule(options: CacheOptions) {
  return defineCrocoModule({
    name: "cache",
    providers: [{ provide: CacheOptionsToken, useValue: options }, CacheService],
    exports: [CacheService],
  });
}
```

`@croco/preset-lambda`, `@croco/preset-node`, and `@croco/preset-cloudflare` are host-primary
compatibility facades. Their canonical `create*Host` APIs own the environment lifecycle, while their
`create*BuildTarget` APIs describe build output through `@croco/framework-preset`. These packages
retain deprecated preset and entry/handler aliases for compatibility; those aliases do not combine
host lifecycle with build-time configuration.

Modules own provider visibility and application lifecycle inside a host. Protocol transports such
as `@croco/transports-http` execute routes inside that application scope. Bind the host's callback
with `ApplicationRuntime.bindHostCallback()` so each invocation re-enters the owning scope and cannot
outlive runtime disposal.

## Plugin module factories

A Croco plugin is a package-owned typed factory that returns canonical modules. It does not own a
registry or lifecycle separate from `ApplicationRuntime`.

```ts
import {
  createApplicationRuntime,
  defineCrocoApplication,
  defineCrocoModule,
  defineCrocoPlugin,
  type PluginFactory,
} from "@croco/framework-module";

type AuthPluginOptions = { readonly secretKey: string };

const authPlugin: PluginFactory<AuthPluginOptions> = (options) =>
  defineCrocoPlugin({
    metadata: {
      name: "example-auth",
      packageName: "@example/auth",
      maturity: "beta",
      providedContracts: ["@croco/auth-core/AuthProvider"],
      capabilities: [{ id: "auth.provider", kind: "single" }],
      runtimeCompatibility: ["node", "lambda"],
      configuration: [{ key: "secretKey", required: true, sensitive: true }],
      verification: [{ command: "pnpm test", reference: "src/tests/AuthPlugin.spec.ts" }],
      examples: ["README.md"],
    },
    modules: [
      defineCrocoModule({
        name: "example-auth",
        providers: [{ provide: AuthProviderToken, useFactory: () => createAuth(options) }],
        exports: [AuthProviderToken],
      }),
    ],
  });

const application = defineCrocoApplication({
  imports: [authPlugin({ secretKey }), OrdersModule],
});
const runtime = createApplicationRuntime(application);
await runtime.initialize();
```

Plugin metadata is configuration evidence, not a secret store. Record required option or environment
names and whether they are sensitive; never include configured secret values. The runtime graph
reports plugin contracts, capabilities, runtime compatibility, maturity, configuration requirements,
verification commands, and example references before application work begins.

### Single-owner replacement

Provider tokens retain deterministic single ownership. Two modules that declare the same token fail
before provider factories or lifecycle hooks execute. An application can replace the exact declared
owner set explicitly:

```ts
defineCrocoApplication({
  imports: [primaryAuth, fallbackAuth],
  providerReplacements: [
    {
      provider: { provide: AuthProviderToken, useValue: applicationAuth },
      replaces: ["primary-auth", "fallback-auth"],
    },
  ],
});
```

The `replaces` list must match every actual owner exactly. Missing, extra, or duplicate replacement
declarations fail before startup; import order never chooses a winner.

The replacement is registered through an application-owned context after the exact owners' imported
dependencies complete setup and before any owner provider or setup hook runs. Replacement factories
and classes may resolve exports from those declared imports, so dependency order comes from module
imports rather than the order of `defineCrocoApplication()` entries.

### Multi-contribution identity and order

Use `ModuleOptions.contributions` for intentionally aggregated surfaces. The built-in contribution
kinds cover HTTP controllers/routes/middleware, diagnostics providers, lifecycle resources, and
event/task/trigger handlers. Consuming packages may define additional typed string kinds.

Every contribution requires a stable `kind` and `id`. `order` defaults to `0`; resolution sorts by
`order`, then `id`, then module name. Reusing the same `kind` + `id` anywhere in one application graph,
including twice in one module, fails before startup. Values are read through
`ApplicationRuntime.getContributions()` or `ModuleContext.getContributions()` and remain under the
owning module lifecycle.

The static `CrocoModule` facade, direct `Container.set()`, package-specific global setters, raw HTTP
arrays, and direct telemetry singleton initialization remain compatibility paths for existing
applications. They do not emit canonical plugin metadata or contribution identity. New profiles,
generated composition roots, and first-party examples should use plugin factories inside
`defineCrocoApplication()` and migrate lifecycle work into module hooks.
