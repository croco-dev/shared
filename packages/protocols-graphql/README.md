# @croco/protocols-graphql

Code-first GraphQL protocol primitives for Croco.

`@croco/protocols-graphql` provides resolver decorators, metadata readers, guards,
interceptors, and GraphQL Problem mapping for Croco GraphQL schemas. It owns protocol
metadata while transports decide how schemas are executed.

## Public API

- GraphQL decorators such as `GraphQLResolver`, `Query`, `Mutation`, `Field`, and
  `ObjectType`.
- Metadata readers for registered resolvers.
- Guard and interceptor contracts plus default guard/interceptor helpers.
- GraphQL Problem mapping utilities.
- Versioned GraphQL contract snapshots and diffs for deterministic SDL and Croco
  resolver metadata review.

Croco-owned GraphQL metadata follows one ownership rule: class decorator metadata is
stored on the resolver constructor, while method decorator metadata is stored on the
resolver prototype. Inherited method metadata is read through the prototype chain;
decorators that extend inherited collections clone them before writing so a derived
resolver cannot mutate its base resolver's contract.

## Usage

```typescript
import { GraphQLResolver, Query } from "@croco/protocols-graphql";

@GraphQLResolver()
class HealthResolver {
  @Query(() => String)
  health(): string {
    return "ok";
  }
}
```

## Resolver Policy

`UseGuards`, `Roles`, and `UseInterceptors` declare method policy that is included in
GraphQL contract snapshots. When the schema is compiled with `SchemaCompiler`, guards
and roles run before the resolver, and interceptors run in declaration order with
onion semantics. Declared providers are resolved through Croco `Container`.

```typescript
import { Roles, UseGuards, UseInterceptors } from "@croco/protocols-graphql";

@GraphQLResolver()
class AccountResolver {
  @Query(() => String)
  @UseGuards(AuthenticatedGuard)
  @Roles("admin")
  @UseInterceptors(AuditInterceptor)
  accountSecret(): string {
    return "authorized";
  }
}
```

## AuthGuard Conformance

`GraphQLAuthGuard` reads `context.headers.authorization` as a Bearer token and writes the
verifier result to `context.user` without reshaping it. Role, scope, tenant, and metadata
fields are preserved when the verifier includes them in the returned user object.

To use `@UseGuards(GraphQLAuthGuard)`, register the guard and its options during application
setup, before schema initialization or container validation:

```typescript
import { Container } from "@croco/framework-context";
import { GRAPHQL_AUTH_GUARD_OPTIONS, GraphQLAuthGuard } from "@croco/protocols-graphql";

Container.set(GRAPHQL_AUTH_GUARD_OPTIONS, {
  verifier: verifyAccessToken,
});
Container.register(GraphQLAuthGuard, "singleton");
```

`verifyAccessToken` is the application's token verifier. The options also accept `headerName`
and `scheme`. Missing options fail DI resolution; direct construction with
`new GraphQLAuthGuard({ verifier: verifyAccessToken })` remains supported.

GraphQL auth failures use protocol-scoped Problem codes: missing headers are
`protocols-graphql/auth-missing-header`, malformed Bearer headers are
`protocols-graphql/auth-invalid-header-format`, invalid or expired tokens are
`protocols-graphql/auth-invalid-token`, and verifier outages are
`protocols-graphql/auth-verifier-unavailable`. Verifier-thrown Croco `Problem`s are
preserved as-is. Public GraphQL fields are represented by not installing the guard for
that resolver/field; unlike auth-core, this package does not read `@Public` route
metadata.

## Problem Error Extensions

`problemToGraphQLError()` maps a Croco `Problem` into a GraphQL error with
`extensions.code`, `extensions.status`, `extensions.title`, `extensions.type`, and
the public-safe fields selected from `problem.extensions` by the shared Croco
Problem response-redaction policy.

Public and safe-message Problems retain their safe detail and the same conservative
extension allowlist used by HTTP. Operator-only Problems use an opaque message and
expose no Problem extensions. Reserved fields and correlation or telemetry fields,
including `requestId`, `traceId`, and `telemetry`, are never forwarded from
`problem.extensions`. Runtime GraphQL errors also never expose `redactionPolicy`.

Unlike HTTP, the helper does not produce an RFC 7807 body or synthesize an `instance`
field. The GraphQL transport retains GraphQL's `errors` envelope and resolver path.

## Contract Snapshots

Use `createGraphQLContractSnapshot()` after schema compilation to persist the stable
SDL plus Croco-specific resolver metadata:

```typescript
import {
  createGraphQLContractSnapshot,
  diffGraphQLContractSnapshots,
  stringifyGraphQLContractSnapshot,
} from "@croco/protocols-graphql";

const snapshot = createGraphQLContractSnapshot(schema, { resolvers: [HealthResolver] });
const diff = diffGraphQLContractSnapshots(baselineSnapshot, snapshot);
```

Snapshots use `croco.graphql-contract.snapshot.v2` and include root operations,
resolver DI scope, method roles, guards, interceptors, and declared
`GraphQLProblemResponse` mappings with the redaction policy derived from the generated
Problem registry. Diffs classify GraphQL schema breaking changes
with `graphql`'s schema comparison utilities and treat resolver metadata changes as
breaking contract drift.

Version 2 adds the derived Problem redaction policy to response metadata. Regenerate existing
version 1 snapshots before comparing them with version 2 output.

## Verification

```bash
pnpm --filter @croco/protocols-graphql test
pnpm --filter @croco/protocols-graphql typecheck
```
