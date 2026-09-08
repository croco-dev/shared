# Architecture Policy Check

`pnpm architecture-policy:check` validates `croco.arch.json` with the
`@croco/architecture-policy` engine. The gate runs through `pnpm check`.

The policy manifest is a build-time contract for package role boundaries:

- canonical package groups `kernel`, `contracts`, `plugins`, `application`, `profiles`, and `tooling`, validated against `docs/package-catalog.json` `packageRoles`;
- forbidden imports from Kernel and Contracts into concrete Plugins, including provider SDK boundaries;
- allowed group edges for generated app packages;
- public entrypoint imports so package consumers do not reach into `src` or `dist` internals;
- deterministic diagnostics with file, line, column, diagnostic code, import specifier, and
  recovery guidance.

This gate is intentionally not a replacement for oxlint, oxfmt, Biome, TypeScript, or
`static-misuse:check`.

| Gate                        | Owns                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `architecture-policy:check` | Croco package groups, layer edges, package manifest dependencies, public entrypoint import boundaries |
| `static-misuse:check`       | Narrow line-oriented misuse patterns that are easier to express as source text checks                 |
| `oxlint` / `oxfmt` / Biome  | Syntax, style, unused symbols, and lint rules that do not need Croco package context                  |
| `typecheck`                 | TypeScript type contracts and emitted declaration compatibility                                       |
| `public-api:check`          | Export snapshot drift for publishable package entrypoints                                             |

Generated SaaS apps receive their own `croco.arch.json` and an
`architecture-policy:check` script:

```bash
croco architecture-policy check --manifest croco.arch.json
```

The generated policy uses the same engine and a generated copy of the canonical role map shipped
with create-croco-app. App entrypoints are Application, provider-rpc is Contracts, and provider
implementations are Plugins. Package names do not infer architectural roles. Missing role metadata
or policy membership that differs from the catalog fails the repository gate; role overrides are
not supported.

`desktop-contracts` is a secondary browser-safety restriction, not a canonical role. The desktop
contract remains Contracts (matched by its explicit package path), while the secondary package
selector activates its stricter runtime and manifest rules. Its manifest dependencies are limited
to problems-core, protocols-core, vitest, and zod. The engine prefers package selectors over path
selectors, so the desktop rules remain active alongside the canonical role consistency check.

Host lifecycle, Transport execution, and Build Target artifacts are separate responsibilities;
roles do not describe request execution order.
