---
"@croco/protocols-graphql": patch
"@croco/problems-core": patch
---

Resolve GraphQLAuthGuard options through GRAPHQL_AUTH_GUARD_OPTIONS so registered guards used by @UseGuards can authenticate resolver requests.

Keep generated GraphQL authentication Problem source references aligned with the guard implementation.
