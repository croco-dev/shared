import { Container, LOGGER_TOKEN } from "@croco/framework-context";
import { recordError } from "@croco/telemetry-api";

type AuditErrorHandlerConfig = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onExhausted?: (error: Error, attempt: number) => void;
};

const DEFAULT_CONFIG: AuditErrorHandlerConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

function calculateBackoff(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = baseDelay * 2 ** (attempt - 1);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, maxDelay);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export class AuditErrorHandler {
  private config: AuditErrorHandlerConfig;

  constructor(config: Partial<AuditErrorHandlerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: string,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      if (signal?.aborted) {
        return undefined;
      }
      try {
        return await operation();
      } catch (error) {
        if (signal?.aborted) {
          return undefined;
        }
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          const delay = calculateBackoff(attempt, this.config.baseDelayMs, this.config.maxDelayMs);
          await sleep(delay, signal);
        }
      }
    }

    if (lastError) {
      this.handleExhausted(lastError, context, this.config.maxRetries);
    }
    return undefined;
  }

  private handleExhausted(error: Error, context: string, attempts: number): void {
    recordError(error);

    try {
      const logger = Container.get(LOGGER_TOKEN);
      logger.error("[AuditErrorHandler] Audit operation failed after retries", {
        context,
        attempts,
        error: error.message,
      });
    } catch (loggerError) {
      console.error(
        "[AuditErrorHandler] Failed to log audit failure (logger unavailable):",
        loggerError,
      );
    }

    if (this.config.onExhausted) {
      try {
        this.config.onExhausted(error, attempts);
      } catch (callbackError) {
        try {
          const logger = Container.get(LOGGER_TOKEN);
          logger.error("[AuditErrorHandler] onExhausted callback failed:", callbackError as Error);
        } catch {
          // Logger DI is unavailable; fallback to console.error so the error is not lost.
          // eslint-disable-next-line no-console
          console.error("[AuditErrorHandler] onExhausted callback failed:", callbackError);
        }
      }
    }
  }
}

export type FireAndForgetResult<T> = {
  promise: Promise<T | undefined>;
  abort: () => void;
};

export function fireAndForgetWithRetry<T>(
  operation: () => Promise<T>,
  config?: Partial<AuditErrorHandlerConfig>,
): FireAndForgetResult<T> {
  const handler = new AuditErrorHandler(config);
  const controller = new AbortController();
  const promise = handler.executeWithRetry(operation, "audit-log-write", controller.signal);
  const abort = (): void => controller.abort();

  return { promise, abort };
}
