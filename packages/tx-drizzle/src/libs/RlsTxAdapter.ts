import { Container, type ILogger, LOGGER_TOKEN } from "@croco/framework-context";
import { Logger } from "@croco/framework-logger";
import type { TxAdapter } from "@croco/tx-core";
import { sql } from "drizzle-orm";
import { createDrizzleTxAdapter } from "./DrizzleTxAdapter";
import {
  RlsDebugLoggingProblem,
  RlsExecuteUnsupportedProblem,
  TenantContextRequiredProblem,
} from "./problems/TxDrizzleProblems";
import { validateRlsConfigKey } from "./RlsSql";
import type { DrizzleDb, InferTxClient, InferTxOptions } from "./types";

export interface RlsTenantProvider {
  getTenantId(): string | null;
}

export type RlsLogger = Pick<ILogger, "error" | "info">;

export interface RlsOptions {
  /**
   * The configuration parameter name to use for RLS.
   * @default 'app.current_tenant'
   */
  configKey?: string;
  /**
   * If true, logs when RLS variable is set.
   * @default false
   */
  debug?: boolean;
  /**
   * Logger used for RLS diagnostics. When omitted, the framework logger is resolved from the container.
   * Debug-enabled adapters fail during creation if neither source provides a usable logger.
   */
  logger?: RlsLogger;
}

type ExecutableTransactionClient = {
  execute(query: unknown): Promise<unknown>;
};

function supportsExecute(client: unknown): client is ExecutableTransactionClient {
  if (typeof client !== "object" || client === null || !("execute" in client)) {
    return false;
  }

  const executableClient = client as { execute?: unknown };
  return typeof executableClient.execute === "function";
}

function getTenantIdOrThrow(tenantProvider: RlsTenantProvider): string {
  const tenantId = tenantProvider.getTenantId();

  if (!tenantId) {
    throw new TenantContextRequiredProblem();
  }

  return tenantId;
}

function isRlsLogger(value: unknown): value is RlsLogger {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const logger = value as Partial<Record<keyof RlsLogger, unknown>>;
  return typeof logger.error === "function" && typeof logger.info === "function";
}

function resolveLogger(options: RlsOptions): RlsLogger | null {
  if (isRlsLogger(options.logger)) {
    return options.logger;
  }

  let logger: unknown;
  try {
    logger = Container.getOptional(LOGGER_TOKEN) ?? Container.get(Logger);
  } catch (cause) {
    if (options.debug) {
      throw new RlsDebugLoggingProblem("initialization", cause);
    }

    return null;
  }

  if (isRlsLogger(logger)) {
    return logger;
  }

  if (options.debug) {
    throw new RlsDebugLoggingProblem("initialization", undefined);
  }

  return null;
}

function logUnsupportedExecute(
  logger: RlsLogger | null,
  problem: RlsExecuteUnsupportedProblem,
): void {
  if (!logger) {
    return;
  }

  const reportLoggingFailure = (loggingFailure: unknown): void => {
    let fallbackResult: unknown;
    try {
      fallbackResult = console.error("[RlsTxAdapter] Failed to log unsupported execute problem", {
        loggingFailure,
        problem,
      });
    } catch {
      return;
    }

    void Promise.resolve(fallbackResult).catch(() => undefined);
  };

  let loggingResult: unknown;
  try {
    loggingResult = logger.error(`[RlsTxAdapter] ${problem.detail}`);
  } catch (loggingFailure) {
    reportLoggingFailure(loggingFailure);
    return;
  }

  void Promise.resolve(loggingResult).catch(reportLoggingFailure);
}

export function createRlsTxAdapter<TDb extends DrizzleDb>(
  db: TDb,
  tenantProvider: RlsTenantProvider,
  options: RlsOptions = {},
): TxAdapter<InferTxClient<TDb>, InferTxOptions<TDb>> {
  const configKey = validateRlsConfigKey(options.configKey ?? "app.current_tenant");
  const baseAdapter = createDrizzleTxAdapter(db);
  const logger = resolveLogger(options);

  return {
    async transaction<T>(
      fn: (client: InferTxClient<TDb>) => Promise<T>,
      txOptions?: InferTxOptions<TDb>,
      signal?: AbortSignal,
    ): Promise<T> {
      const tenantId = getTenantIdOrThrow(tenantProvider);

      return baseAdapter.transaction(
        async (tx) => {
          // Drizzle transaction client usually has .execute
          if (!supportsExecute(tx)) {
            const problem = new RlsExecuteUnsupportedProblem(configKey);
            logUnsupportedExecute(logger, problem);
            throw problem;
          }

          if (options.debug) {
            try {
              await logger?.info(`[RlsTxAdapter] Setting ${configKey} = '${tenantId}'`);
            } catch (cause) {
              throw new RlsDebugLoggingProblem("write", cause);
            }
          }

          await tx.execute(sql`select set_config(${configKey}, ${tenantId}, true)`);

          return fn(tx);
        },
        txOptions,
        signal,
      );
    },

    async savepoint<T>(
      client: InferTxClient<TDb>,
      fn: (client: InferTxClient<TDb>) => Promise<T>,
      txOptions?: InferTxOptions<TDb>,
      signal?: AbortSignal,
    ): Promise<T> {
      // Nested transactions inherit RLS settings from the parent.
      return baseAdapter.savepoint(client, fn, txOptions, signal);
    },

    supportsSavepoint(client) {
      return baseAdapter.supportsSavepoint(client);
    },
  };
}
