# AI Agent Rules Index

This project uses structured AI agent rules to maintain code quality and consistency.

## Croco Package Roles

Croco's authoritative package roles are defined by `packageRoles` in the framework repository's
`docs/package-catalog.json`: Kernel, Contracts, Plugins, Application, Profiles, and Tooling.
Generated app modules and composition roots are Application code. Provider, protocol, transport, host,
integration, and presentation are Plugin subtypes, not sequential runtime layers. Keep domain,
runtime support, and maturity separate from role; do not infer role from a package name.

Application code selects Profiles and Plugins. Plugins depend on Contracts and Kernel primitives;
Contracts and Kernel must not import concrete Plugins. `tx-drizzle` is a provider Plugin and
`telemetry-api` is Contracts. `presentation-preset` is Profiles; `framework-preset` is build-target
Tooling. Hosts own environment lifecycle, Transports execute protocols, and Build Targets describe
artifacts without starting a host or executing a transport.

## Rule Files

| File                     | Scope    | Description                   |
| ------------------------ | -------- | ----------------------------- |
| 000-core-architecture    | Global   | DDD architecture constraints  |
| 100-client-development   | Frontend | React/Next.js guidelines      |
| 110-frontend-performance | Frontend | Performance optimization      |
| 200-server-development   | Backend  | API design patterns           |
| 210-backend-performance  | Backend  | Database/caching optimization |
| 300-package-management   | Global   | pnpm workspace rules          |
| 400-code-quality         | Global   | TypeScript/naming conventions |
| 410-backend-testing      | Tests    | Vitest patterns               |
| 500-styling-system       | UI       | Tailwind/component library    |

## Usage

Rules in `.cursor/rules/` are used by Cursor IDE.
Rules in `.agent/rules/` are used by other AI coding agents.
