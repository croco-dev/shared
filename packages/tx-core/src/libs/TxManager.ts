import { AsyncLocalStorage } from "node:async_hooks";
import type { TransactionContext } from "@croco/framework-context";
import type { Logger } from "@croco/framework-logger";
import type { TransactionTimeoutSource } from "./problems/TransactionProblems";
import {
  AfterCommitOutcomeRequiredProblem,
  AfterCommitRegistrationClosedProblem,
  AfterCommitHooksProblem,
  DetachedTransactionOperationProblem,
  InvalidTransactionTimeoutProblem,
  MAX_TRANSACTION_TIMEOUT_MS,
  TransactionContextProblem,
  TransactionOutcomeContextProblem,
  TransactionOutcomeUnknownProblem,
  TransactionRollbackConfirmedProblem,
  TransactionTimeoutProblem,
} from "./problems/TransactionProblems";
import type { TxAdapter } from "./TxAdapter";
import type {
  AfterCommitFailure,
  AfterCommitHook,
  AfterCommitOutcome,
  NestingStrategy,
  TxManagerConfig,
  TxRunOptions,
  TxRunOutcome,
} from "./types";

interface TxContext<TClient> {
  activeChildOperationCount: number;
  client: TClient;
  afterCommitHooks: AfterCommitHook[];
  afterCommitRegistrationOpen: boolean;
  capturesAfterCommitOutcome: boolean;
  isRoot: boolean;
  rootGate: RootTransactionGate;
}

interface RootTransactionGate {
  activeNestedOperationCount: number;
  detachedOperationProblem: DetachedTransactionOperationProblem | null;
  registrationOpen: boolean;
}

type NullableTxContext<TClient> = TxContext<TClient> | null;

type TxManagerLogger = Pick<Logger, "error" | "warn">;

type AfterCommitHookFailure = AfterCommitFailure & {
  error: Error;
};

class AfterCommitFailureAggregateError extends Error {
  readonly name = "AfterCommitFailureAggregateError";

  constructor(readonly errors: readonly Error[]) {
    super("Multiple afterCommit hook or reporting failures");
  }
}

const DEFAULT_LOGGER: TxManagerLogger = console;

function assertValidTimeout(timeout: number, source: TransactionTimeoutSource): void {
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TRANSACTION_TIMEOUT_MS) {
    throw new InvalidTransactionTimeoutProblem(source, timeout);
  }
}

function getAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Transaction aborted");
}

async function executeWithTimeout<T>(
  operation: () => Promise<T>,
  timeout: number,
  controller: AbortController,
): Promise<T> {
  const timeoutHandle = setTimeout(() => {
    controller.abort(new TransactionTimeoutProblem(timeout));
  }, timeout);

  try {
    return await operation();
  } catch (error) {
    if (controller.signal.aborted) {
      const abortReason = getAbortReason(controller.signal);
      if (error instanceof TransactionRollbackConfirmedProblem && error.cause === abortReason) {
        throw abortReason;
      }

      const cause = error instanceof Error ? error : new Error(String(error));
      throw new TransactionOutcomeUnknownProblem(timeout, cause);
    }

    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * AsyncLocalStorage 기반으로 현재 트랜잭션 컨텍스트를 관리하는 매니저입니다.
 */
export class TxManager<TClient, TOptions = unknown> implements TransactionContext {
  private readonly als = new AsyncLocalStorage<NullableTxContext<TClient>>();
  private readonly defaultNesting: NestingStrategy;
  private readonly defaultTimeout: number | undefined;
  private readonly logger: TxManagerLogger;

  constructor(adapter: TxAdapter<TClient, TOptions>, config?: TxManagerConfig);
  constructor(
    private readonly adapter: TxAdapter<TClient, TOptions>,
    config: TxManagerConfig = {},
    logger: TxManagerLogger = DEFAULT_LOGGER,
  ) {
    if (config.defaultTimeout !== undefined) {
      assertValidTimeout(config.defaultTimeout, "default");
    }

    this.defaultNesting = config.defaultNesting ?? "join";
    this.defaultTimeout = config.defaultTimeout;
    this.logger = logger;
  }

  async run<T>(fn: () => Promise<T>, runOptions?: TxRunOptions<TOptions>): Promise<T> {
    if (runOptions?.timeout !== undefined) {
      assertValidTimeout(runOptions.timeout, "run");
    }

    const nesting = runOptions?.nesting ?? this.defaultNesting;
    const options = runOptions?.options;
    const timeout = runOptions?.timeout ?? this.defaultTimeout;
    const currentContext = this.als.getStore();

    if (!currentContext) {
      const outcome = await this.executeRootWithOutcome(fn, options, timeout, false);
      return outcome.value;
    }

    return this.executeTrackedNestedOperation(currentContext, () =>
      nesting === "join"
        ? this.executeJoined(currentContext, fn)
        : this.executeNested(currentContext, fn, options, timeout),
    );
  }

  async runWithOutcome<T>(
    fn: () => Promise<T>,
    runOptions?: TxRunOptions<TOptions>,
  ): Promise<TxRunOutcome<T>> {
    if (runOptions?.timeout !== undefined) {
      assertValidTimeout(runOptions.timeout, "run");
    }

    if (this.als.getStore()) {
      throw new TransactionOutcomeContextProblem();
    }

    const options = runOptions?.options;
    const timeout = runOptions?.timeout ?? this.defaultTimeout;
    return this.executeRootWithOutcome(fn, options, timeout, true);
  }

  private async executeRootWithOutcome<T>(
    fn: () => Promise<T>,
    options?: TOptions,
    timeout?: number,
    capturesAfterCommitOutcome = true,
  ): Promise<TxRunOutcome<T>> {
    const afterCommitHooks: AfterCommitHook[] = [];
    const controller = new AbortController();
    const rootGate: RootTransactionGate = {
      activeNestedOperationCount: 0,
      detachedOperationProblem: null,
      registrationOpen: true,
    };

    const executeTransaction = (): Promise<T> => {
      return this.adapter.transaction(
        async (client) => {
          const context: TxContext<TClient> = {
            activeChildOperationCount: 0,
            client,
            afterCommitHooks,
            afterCommitRegistrationOpen: true,
            capturesAfterCommitOutcome,
            isRoot: true,
            rootGate,
          };

          try {
            const result = await this.setupContext(context, fn);
            this.assertNoDetachedOperations(context, true);
            return result;
          } finally {
            context.afterCommitRegistrationOpen = false;
            rootGate.registrationOpen = false;
          }
        },
        options,
        controller.signal,
      );
    };

    const value =
      timeout === undefined
        ? await executeTransaction()
        : await executeWithTimeout(executeTransaction, timeout, controller);

    const afterCommit =
      afterCommitHooks.length === 0
        ? ({ status: "succeeded", hookCount: 0 } as const)
        : await this.setupContext(null, () => this.executeAfterCommitHooks(afterCommitHooks));

    return { status: "committed", value, afterCommit };
  }

  private async executeNested<T>(
    currentContext: TxContext<TClient>,
    fn: () => Promise<T>,
    options?: TOptions,
    timeout?: number,
  ): Promise<T> {
    if (!this.adapter.supportsSavepoint(currentContext.client)) {
      this.warnSavepointNotSupported();
      return this.executeJoined(currentContext, fn);
    }

    const nestedHooks: AfterCommitHook[] = [];
    let shouldMergeNestedHooks = false;
    const controller = new AbortController();

    const executeSavepoint = async (): Promise<T> => {
      const result = await this.adapter.savepoint(
        currentContext.client,
        async (nestedClient) => {
          const nestedContext: TxContext<TClient> = {
            activeChildOperationCount: 0,
            client: nestedClient,
            afterCommitHooks: nestedHooks,
            afterCommitRegistrationOpen: true,
            capturesAfterCommitOutcome: currentContext.capturesAfterCommitOutcome,
            isRoot: false,
            rootGate: currentContext.rootGate,
          };

          try {
            const nestedResult = await this.setupContext(nestedContext, fn);
            this.assertNoDetachedOperations(nestedContext);
            shouldMergeNestedHooks = true;
            return nestedResult;
          } finally {
            nestedContext.afterCommitRegistrationOpen = false;
            if (
              nestedContext.activeChildOperationCount > 0 &&
              !nestedContext.rootGate.detachedOperationProblem
            ) {
              nestedContext.rootGate.detachedOperationProblem =
                new DetachedTransactionOperationProblem(nestedContext.activeChildOperationCount);
            }
          }
        },
        options,
        controller.signal,
      );

      if (
        shouldMergeNestedHooks &&
        currentContext.rootGate.registrationOpen &&
        currentContext.afterCommitRegistrationOpen &&
        currentContext.rootGate.detachedOperationProblem === null
      ) {
        currentContext.afterCommitHooks.push(...nestedHooks);
      }

      return result;
    };

    if (timeout !== undefined) {
      return executeWithTimeout(executeSavepoint, timeout, controller);
    }

    return executeSavepoint();
  }

  private async executeJoined<T>(
    currentContext: TxContext<TClient>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const joinedContext: TxContext<TClient> = {
      activeChildOperationCount: 0,
      client: currentContext.client,
      afterCommitHooks: currentContext.afterCommitHooks,
      afterCommitRegistrationOpen: true,
      capturesAfterCommitOutcome: currentContext.capturesAfterCommitOutcome,
      isRoot: false,
      rootGate: currentContext.rootGate,
    };

    try {
      const result = await this.setupContext(joinedContext, fn);
      this.assertNoDetachedOperations(joinedContext);
      return result;
    } finally {
      joinedContext.afterCommitRegistrationOpen = false;
      if (
        joinedContext.activeChildOperationCount > 0 &&
        !joinedContext.rootGate.detachedOperationProblem
      ) {
        joinedContext.rootGate.detachedOperationProblem = new DetachedTransactionOperationProblem(
          joinedContext.activeChildOperationCount,
        );
      }
    }
  }

  private async executeTrackedNestedOperation<T>(
    parentContext: TxContext<TClient>,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!parentContext.afterCommitRegistrationOpen || !parentContext.rootGate.registrationOpen) {
      const problem =
        parentContext.rootGate.detachedOperationProblem ??
        new DetachedTransactionOperationProblem(1);
      parentContext.rootGate.detachedOperationProblem = problem;
      throw problem;
    }

    parentContext.activeChildOperationCount += 1;
    parentContext.rootGate.activeNestedOperationCount += 1;
    try {
      return await operation();
    } finally {
      parentContext.activeChildOperationCount -= 1;
      parentContext.rootGate.activeNestedOperationCount -= 1;
    }
  }

  private assertNoDetachedOperations(context: TxContext<TClient>, includeRootGate = false): void {
    if (context.rootGate.detachedOperationProblem) {
      throw context.rootGate.detachedOperationProblem;
    }

    const activeOperationCount = includeRootGate
      ? context.rootGate.activeNestedOperationCount
      : context.activeChildOperationCount;
    if (activeOperationCount === 0) {
      return;
    }

    const problem = new DetachedTransactionOperationProblem(activeOperationCount);
    context.rootGate.detachedOperationProblem = problem;
    throw problem;
  }

  private async setupContext<T>(
    context: NullableTxContext<TClient>,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.als.run(context, fn);
  }

  getClient(): TClient | null {
    const context = this.als.getStore();
    if (!context?.afterCommitRegistrationOpen || !context.rootGate.registrationOpen) {
      return null;
    }
    return context.client;
  }

  isInTransaction(): boolean {
    const context = this.als.getStore();
    return Boolean(context?.afterCommitRegistrationOpen && context.rootGate.registrationOpen);
  }

  canRegisterAfterCommit(): boolean {
    const context = this.als.getStore();
    return Boolean(
      context?.capturesAfterCommitOutcome &&
      context.afterCommitRegistrationOpen &&
      context.rootGate.registrationOpen,
    );
  }

  onAfterCommit(hook: AfterCommitHook): void {
    const context = this.als.getStore();
    if (!context) {
      throw new TransactionContextProblem();
    }
    if (!context.capturesAfterCommitOutcome) {
      throw new AfterCommitOutcomeRequiredProblem();
    }
    if (!context.afterCommitRegistrationOpen || !context.rootGate.registrationOpen) {
      throw new AfterCommitRegistrationClosedProblem();
    }
    context.afterCommitHooks.push(hook);
  }

  private async executeAfterCommitHooks(hooks: AfterCommitHook[]): Promise<AfterCommitOutcome> {
    const failures: AfterCommitHookFailure[] = [];
    const errors: Error[] = [];

    for (const [hookIndex, hook] of hooks.entries()) {
      try {
        await hook();
      } catch (error) {
        const normalizedError = this.normalizeError(error);
        errors.push(normalizedError);
        failures.push({
          error: normalizedError,
          ...this.describeFailure(normalizedError, "hook", hookIndex),
        });
        try {
          this.safeLog("error", "AfterCommit hook failed:", { error: normalizedError });
        } catch (reportingError) {
          const normalizedReportingError = this.normalizeError(reportingError);
          errors.push(normalizedReportingError);
          failures.push({
            error: normalizedReportingError,
            ...this.describeFailure(normalizedReportingError, "reporting", hookIndex),
          });
        }
      }
    }

    if (failures.length > 0) {
      const diagnostics = failures.map(({ error: _error, ...failure }) => failure);
      const [firstError] = errors;
      if (!firstError) {
        return { status: "succeeded", hookCount: hooks.length };
      }
      const cause = errors.length === 1 ? firstError : new AfterCommitFailureAggregateError(errors);
      return {
        status: "failed",
        hookCount: hooks.length,
        failures: diagnostics,
        problem: new AfterCommitHooksProblem(diagnostics, cause),
      };
    }

    return { status: "succeeded", hookCount: hooks.length };
  }

  private normalizeError(error: unknown): Error {
    try {
      if (error instanceof Error) {
        return error;
      }
    } catch {
      return new Error("Unknown afterCommit failure");
    }

    try {
      return new Error(String(error));
    } catch {
      return new Error("Unknown afterCommit failure");
    }
  }

  private describeFailure(
    error: Error,
    phase: AfterCommitFailure["phase"],
    hookIndex: number,
  ): AfterCommitFailure {
    const name = this.readErrorString(error, "name") ?? "Error";
    const message = this.readErrorString(error, "message") ?? "Unknown afterCommit failure";
    const code = this.readErrorString(error, "code");
    return {
      phase,
      hookIndex,
      name,
      message,
      ...(code === undefined ? {} : { code }),
    };
  }

  private readErrorString(
    error: Error,
    property: "code" | "message" | "name",
    fallback?: string,
  ): string | undefined {
    try {
      const value = (error as unknown as Record<string, unknown>)[property];
      return typeof value === "string" ? value : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Suspend current transaction context and run function outside of it.
   * Used for REQUIRES_NEW propagation to ensure clean transaction state.
   */
  async suspend<T>(fn: () => Promise<T>): Promise<T> {
    return this.als.run(null, fn);
  }

  private warnSavepointNotSupported(): void {
    this.safeLog(
      "warn",
      "Savepoint nesting requested but adapter does not support savepoint. Falling back to join.",
    );
  }

  private safeLog(level: "error" | "warn", message: string, meta?: Record<string, unknown>): void {
    const formattedMessage = `[TxManager] ${message}`;

    if (meta) {
      this.logger[level](formattedMessage, meta);
      return;
    }

    this.logger[level](formattedMessage);
  }
}
