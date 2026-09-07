import { AUTH_PROVIDER_TOKEN } from "@croco/auth-core";
import type { DiagnosticsProvider } from "@croco/diagnostics-core";
import {
  defineCrocoModule,
  defineCrocoPlugin,
  MODULE_CONTRIBUTION_KINDS,
  type PluginFactory,
} from "@croco/framework-module";
import {
  BetterAuthDiagnosticsProvider,
  type BetterAuthDiagnosticsOptions,
} from "./BetterAuthDiagnosticsProvider";
import {
  BetterAuthFactory,
  type BetterAuthConfig,
  type BetterAuthDatabase,
} from "./BetterAuthFactory";
import type { BetterAuthProviderOptions } from "./BetterAuthProvider";
import { BetterAuthProvider } from "./BetterAuthProvider";

export const BETTER_AUTH_MODULE_NAME = "@croco/auth-better-auth/provider";
const BETTER_AUTH_DIAGNOSTICS_CONTRIBUTION_ID = "@croco/auth-better-auth";

export type BetterAuthPluginOptions = BetterAuthConfig & {
  readonly db: BetterAuthDatabase;
  readonly webhookSecret?: string;
  readonly provider?: BetterAuthProviderOptions;
  readonly diagnostics?: BetterAuthDiagnosticsOptions;
};

export const betterAuth: PluginFactory<BetterAuthPluginOptions> = (options) => {
  const config: BetterAuthConfig = Object.freeze({
    baseURL: options.baseURL,
    secret: options.secret,
  });
  const factory = new BetterAuthFactory(options.db, config);
  const provider = new BetterAuthProvider(factory, options.provider);
  const diagnosticsProvider = new BetterAuthDiagnosticsProvider(
    {
      ...config,
      databaseConfigured: true,
      webhookSecret: options.webhookSecret,
    },
    options.diagnostics,
  );

  return defineCrocoPlugin({
    metadata: {
      name: "better-auth",
      packageName: "@croco/auth-better-auth",
      maturity: "production",
      providedContracts: [
        "@croco/auth-core/AuthProvider",
        "@croco/diagnostics-core/DiagnosticsProvider",
      ],
      capabilities: [
        { id: "auth.provider", kind: "single" },
        { id: MODULE_CONTRIBUTION_KINDS.diagnosticsProvider, kind: "multi" },
      ],
      runtimeCompatibility: ["node", "lambda"],
      configuration: [
        {
          key: "db",
          required: true,
          description: "Application-owned Drizzle database client.",
        },
        {
          key: "BETTER_AUTH_URL",
          required: true,
          description: "Public base URL used by Better Auth.",
        },
        {
          key: "BETTER_AUTH_SECRET",
          required: true,
          sensitive: true,
          description: "Secret used by Better Auth to sign and encrypt authentication data.",
        },
        {
          key: "BETTER_AUTH_WEBHOOK_SECRET",
          required: false,
          sensitive: true,
          description: "Optional webhook signing secret reported by readiness diagnostics.",
        },
      ],
      verification: [
        {
          command: "pnpm --filter @croco/auth-better-auth test",
          reference: "packages/auth-better-auth/src/tests/BetterAuthPlugin.spec.ts",
        },
      ],
      examples: ["packages/auth-better-auth/README.md#application-plugin"],
    },
    modules: [
      defineCrocoModule({
        name: BETTER_AUTH_MODULE_NAME,
        providers: [{ provide: AUTH_PROVIDER_TOKEN, useValue: provider }],
        exports: [AUTH_PROVIDER_TOKEN],
        contributions: [
          {
            id: BETTER_AUTH_DIAGNOSTICS_CONTRIBUTION_ID,
            kind: MODULE_CONTRIBUTION_KINDS.diagnosticsProvider,
            order: 100,
            value: diagnosticsProvider satisfies DiagnosticsProvider,
          },
        ],
      }),
    ],
  });
};
