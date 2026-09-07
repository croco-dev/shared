import { TransactionRollbackConfirmedProblem } from "@croco/tx-core";
import type { TxAdapter } from "@croco/tx-core";
import { SavepointUnsupportedProblem } from "./problems/TxDrizzleProblems";
import type { DrizzleDb, DrizzleTx, InferTxClient, InferTxOptions } from "./types";

export interface DrizzleTxAdapterOptions {
  /** Disable savepoints for drivers whose transaction method does not support nested execution. */
  supportsSavepoint?: boolean;

  /**
   * Optional hook invoked when a transaction connection is invalidated or aborted
   * with active in-flight operations, ensuring the socket is discarded/destroyed
   * and never returned to the connection pool in a tainted state.
   */
  onConnectionInvalidate?: (client: unknown, reason: Error) => void | Promise<void>;

  /**
   * Maximum time in milliseconds to wait for in-flight socket operations to settle
   * after an abort signal fires before considering the connection permanently stuck.
   * @default 5000
   */
  operationDrainTimeoutMs?: number;
}

function getAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Transaction aborted");
  (error as { cause?: unknown }).cause = signal.reason;
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }
}

function isExecutionPromise(value: unknown): value is Promise<unknown> {
  if (value instanceof Promise) {
    return true;
  }
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function" &&
    typeof (value as { catch?: unknown }).catch === "function"
  ) {
    if ("toSQL" in (value as object) || "dialect" in (value as object)) {
      return false;
    }
    return true;
  }
  return false;
}

function extractRawClient(client: unknown): unknown {
  if (client === null || typeof client !== "object") {
    return client;
  }
  const withSession = client as { session?: { client?: unknown }; client?: unknown };
  return withSession.session?.client ?? withSession.client ?? client;
}

const CLIENT_STATE_KEY = Symbol.for("@croco/tx-drizzle/client-state");

interface ClientState {
  coordinatorStack: TxAbortCoordinator[];
  taintedReason: Error | null;
  releaseWrapped: boolean;
}

function getClientState(rawClient: unknown): ClientState | undefined {
  if (rawClient && (typeof rawClient === "object" || typeof rawClient === "function")) {
    return (rawClient as Record<string | symbol, unknown>)[CLIENT_STATE_KEY] as
      | ClientState
      | undefined;
  }
  return undefined;
}

function getOrCreateClientState(rawClient: unknown): ClientState | undefined {
  if (rawClient && (typeof rawClient === "object" || typeof rawClient === "function")) {
    const record = rawClient as Record<string | symbol, unknown>;
    let state = record[CLIENT_STATE_KEY] as ClientState | undefined;
    if (!state) {
      state = {
        coordinatorStack: [],
        taintedReason: null,
        releaseWrapped: false,
      };
      record[CLIENT_STATE_KEY] = state;
    }
    return state;
  }
  return undefined;
}

class TxAbortCoordinator {
  private readonly activeOperations = new Set<Promise<unknown>>();
  private taintedReason: Error | null = null;
  private isCleanedUp = false;
  private drainPromise: Promise<boolean> | null = null;

  constructor(
    private readonly rawClient: unknown,
    readonly isRoot: boolean,
    private readonly options?: DrizzleTxAdapterOptions,
  ) {}

  trackOperation<T>(promise: Promise<T>): Promise<T> {
    const untyped = promise as Promise<unknown>;
    this.activeOperations.add(untyped);
    untyped.catch(() => undefined);
    promise
      .finally(() => {
        this.activeOperations.delete(untyped);
      })
      .catch(() => undefined);
    return promise;
  }

  hasActiveOperations(): boolean {
    return this.activeOperations.size > 0;
  }

  async waitForActiveOperations(
    timeoutMs: number = this.options?.operationDrainTimeoutMs ?? 5000,
  ): Promise<boolean> {
    if (this.activeOperations.size === 0) {
      return true;
    }

    const deadline = Date.now() + timeoutMs;
    while (this.activeOperations.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }

      const current = Array.from(this.activeOperations);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(remaining, 500));
        timer.unref?.();
      });

      try {
        await Promise.race([Promise.allSettled(current), timeoutPromise]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }

    return true;
  }

  drainOnAbort(signal: AbortSignal): Promise<boolean> {
    if (this.drainPromise) {
      return this.drainPromise;
    }
    this.drainPromise = (async () => {
      const reason = getAbortReason(signal);
      this.markTainted(reason);
      this.cancelDriverWork();

      if (this.hasActiveOperations()) {
        const drainedCleanly = await this.waitForActiveOperations();
        if (!drainedCleanly) {
          this.markTainted(reason, true);
          this.forceDestroyHungSocket();
          return false;
        }
      }
      return true;
    })();
    return this.drainPromise;
  }

  markTainted(reason: Error, force = false): void {
    if (this.taintedReason && !force) {
      return;
    }
    this.taintedReason = reason;

    if (this.isRoot || force) {
      const state = getClientState(this.rawClient);
      if (state) {
        state.taintedReason = reason;
      }

      if (this.options?.onConnectionInvalidate) {
        try {
          const hookResult = this.options.onConnectionInvalidate(this.rawClient, reason);
          if (
            hookResult !== null &&
            typeof hookResult === "object" &&
            typeof (hookResult as { catch?: unknown }).catch === "function"
          ) {
            (hookResult as Promise<unknown>).catch((hookError) => {
              void hookError;
            });
          }
        } catch (hookError) {
          void hookError;
        }
      }
    }
  }

  forceDestroyHungSocket(): void {
    if (!this.rawClient || typeof this.rawClient !== "object") {
      return;
    }

    const destroyable = this.rawClient as {
      destroy?: () => void;
      end?: () => void;
      connection?: { stream?: { destroy?: () => void } };
      stream?: { destroy?: () => void };
    };

    try {
      if (typeof destroyable.destroy === "function") {
        destroyable.destroy();
      } else if (typeof destroyable.stream?.destroy === "function") {
        destroyable.stream.destroy();
      } else if (typeof destroyable.connection?.stream?.destroy === "function") {
        destroyable.connection.stream.destroy();
      } else if (typeof destroyable.end === "function") {
        destroyable.end();
      }
    } catch (destroyError) {
      void destroyError;
    }
  }

  getTaintedReason(): Error | null {
    return this.taintedReason;
  }

  cancelDriverWork(): void {
    if (this.isCleanedUp || !this.rawClient || typeof this.rawClient !== "object") {
      return;
    }

    const client = this.rawClient as {
      cancel?: () => void;
      cancelQuery?: () => void;
    };

    try {
      if (typeof client.cancelQuery === "function") {
        client.cancelQuery();
      } else if (typeof client.cancel === "function" && client.cancel.length === 0) {
        client.cancel();
      }
    } catch (driverError) {
      void driverError;
    }
  }

  guardConnectionRelease(): void {
    if (!this.rawClient || typeof this.rawClient !== "object") {
      return;
    }

    const state = getOrCreateClientState(this.rawClient);
    if (!state) {
      return;
    }

    state.coordinatorStack.push(this);

    const clientWithRelease = this.rawClient as {
      release?: (err?: unknown) => unknown;
    };

    if (typeof clientWithRelease.release === "function" && !state.releaseWrapped) {
      const originalRelease = clientWithRelease.release.bind(this.rawClient);
      state.releaseWrapped = true;

      clientWithRelease.release = (err?: unknown) => {
        const currentState = getClientState(this.rawClient);
        const taint = currentState?.taintedReason ?? null;

        if (currentState) {
          currentState.taintedReason = null;
          currentState.coordinatorStack = [];
        }

        if (taint) {
          return originalRelease(err ?? taint);
        }
        return originalRelease(err);
      };
    }
  }

  cleanup(): void {
    this.isCleanedUp = true;
    const state = getClientState(this.rawClient);
    if (state) {
      const index = state.coordinatorStack.indexOf(this);
      if (index !== -1) {
        state.coordinatorStack.splice(index, 1);
      }
    }
  }
}

function createAbortGuardedValue<TValue>(
  value: TValue,
  signal: AbortSignal | undefined,
  cache: WeakMap<object, unknown>,
  coordinator: TxAbortCoordinator,
): TValue {
  if (!signal || value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }

  if (cache.has(value)) {
    return cache.get(value) as TValue;
  }

  const guarded = new Proxy(value as object, {
    get(target, property, receiver) {
      const propValue = Reflect.get(target, property, receiver);

      if (typeof propValue !== "function") {
        return createAbortGuardedValue(propValue, signal, cache, coordinator);
      }

      return (...args: unknown[]) => {
        throwIfAborted(signal);
        const result = propValue.apply(target, args);

        if (isExecutionPromise(result)) {
          if (result instanceof Promise) {
            coordinator.trackOperation(result);
            return result;
          }

          const thenable = result as {
            then: (onfulfilled?: unknown, onrejected?: unknown) => Promise<unknown>;
            catch?: (onrejected?: unknown) => Promise<unknown>;
            finally?: (onfinally?: unknown) => Promise<unknown>;
          };
          const originalThen = thenable.then.bind(result);
          let trackedPromise: Promise<unknown> | null = null;

          const executeOnce = (): Promise<unknown> => {
            if (!trackedPromise) {
              trackedPromise = originalThen();
              coordinator.trackOperation(trackedPromise);
            }
            return trackedPromise;
          };

          return new Proxy(result as object, {
            get(pTarget, property, pReceiver) {
              if (property === "then") {
                return (onFulfilled?: unknown, onRejected?: unknown) => {
                  throwIfAborted(signal);
                  return executeOnce().then(
                    onFulfilled as ((v: unknown) => unknown) | undefined,
                    onRejected as ((e: unknown) => unknown) | undefined,
                  );
                };
              }
              if (property === "catch") {
                return (onRejected?: unknown) => {
                  throwIfAborted(signal);
                  return executeOnce().catch(onRejected as ((e: unknown) => unknown) | undefined);
                };
              }
              if (property === "finally") {
                return (onFinally?: unknown) => {
                  return executeOnce().finally(onFinally as (() => void) | undefined);
                };
              }
              return Reflect.get(pTarget, property, pReceiver);
            },
          });
        }

        return createAbortGuardedValue(result, signal, cache, coordinator);
      };
    },
  });

  cache.set(value, guarded);

  return guarded as TValue;
}

async function runAbortableCallback<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  coordinator: TxAbortCoordinator,
): Promise<T> {
  if (!signal) {
    return operation();
  }

  throwIfAborted(signal);

  let abortListener: (() => void) | undefined;

  const abortCleanupPromise = new Promise<never>((_, reject) => {
    abortListener = async () => {
      try {
        await coordinator.drainOnAbort(signal);
      } finally {
        reject(getAbortReason(signal));
      }
    };

    signal.addEventListener("abort", abortListener, { once: true });
  });
  abortCleanupPromise.catch(() => undefined);

  try {
    const operationPromise = (async () => {
      try {
        const val = await operation();
        if (signal.aborted) {
          await coordinator.drainOnAbort(signal);
          throw getAbortReason(signal);
        }
        return val;
      } catch (error) {
        if (signal.aborted) {
          await coordinator.drainOnAbort(signal);
          throw getAbortReason(signal);
        }
        throw error;
      }
    })();
    operationPromise.catch(() => undefined);

    const result = await Promise.race([operationPromise, abortCleanupPromise]);

    throwIfAborted(signal);
    return result;
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function createAbortableCallback<TClient, T>(
  fn: (client: TClient) => Promise<T>,
  signal: AbortSignal | undefined,
  isRoot: boolean,
  options?: DrizzleTxAdapterOptions,
): (client: TClient) => Promise<T> {
  if (!signal) {
    return fn;
  }

  return async (client) => {
    const rawClient = extractRawClient(client);
    const coordinator = new TxAbortCoordinator(rawClient, isRoot, options);
    coordinator.guardConnectionRelease();

    const cache = new WeakMap<object, unknown>();
    const guardedClient = createAbortGuardedValue(client, signal, cache, coordinator);

    try {
      return await runAbortableCallback(async () => fn(guardedClient), signal, coordinator);
    } finally {
      coordinator.cleanup();
    }
  };
}

function classifyAdapterFailure(error: unknown, signal?: AbortSignal): never {
  if (error instanceof TransactionRollbackConfirmedProblem) {
    throw error;
  }

  if (
    signal?.aborted &&
    (error === signal.reason ||
      (error !== null &&
        typeof error === "object" &&
        (error as { cause?: unknown }).cause === signal.reason))
  ) {
    throw new TransactionRollbackConfirmedProblem(getAbortReason(signal));
  }

  throw error;
}

export function createDrizzleTxAdapter<TDb extends DrizzleDb>(
  db: TDb,
  adapterOptions?: DrizzleTxAdapterOptions,
): TxAdapter<InferTxClient<TDb>, InferTxOptions<TDb>> {
  type TClient = InferTxClient<TDb>;
  type TOptions = InferTxOptions<TDb>;

  return {
    async transaction<T>(
      fn: (client: TClient) => Promise<T>,
      options?: TOptions,
      signal?: AbortSignal,
    ): Promise<T> {
      throwIfAborted(signal);

      try {
        return (await db.transaction(
          createAbortableCallback(fn, signal, true, adapterOptions) as (tx: unknown) => Promise<T>,
          options,
        )) as T;
      } catch (error) {
        classifyAdapterFailure(error, signal);
      }
    },

    async savepoint<T>(
      client: TClient,
      fn: (client: TClient) => Promise<T>,
      options?: TOptions,
      signal?: AbortSignal,
    ): Promise<T> {
      const txClient = client as unknown as DrizzleTx<TClient, TOptions>;

      if (
        adapterOptions?.supportsSavepoint === false ||
        typeof txClient?.transaction !== "function"
      ) {
        throw new SavepointUnsupportedProblem();
      }

      throwIfAborted(signal);

      try {
        return (await txClient.transaction(
          createAbortableCallback(fn, signal, false, adapterOptions) as (tx: unknown) => Promise<T>,
          options,
        )) as T;
      } catch (error) {
        classifyAdapterFailure(error, signal);
      }
    },

    supportsSavepoint(client?: TClient): boolean {
      if (adapterOptions?.supportsSavepoint === false) {
        return false;
      }

      return (
        client === undefined ||
        typeof (client as unknown as DrizzleTx<TClient, TOptions>)?.transaction === "function"
      );
    },
  };
}
