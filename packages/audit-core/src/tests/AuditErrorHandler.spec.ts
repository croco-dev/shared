import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditErrorHandler, fireAndForgetWithRetry } from "../libs/AuditErrorHandler";

vi.mock("@croco/framework-context", () => ({
  Container: { get: () => ({ error: vi.fn() }) },
  LOGGER_TOKEN: Symbol("logger"),
}));
vi.mock("@croco/telemetry-api", () => ({ recordError: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AuditErrorHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cancels a pending backoff immediately without retrying or reporting exhaustion", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("write failed"));
    const onExhausted = vi.fn();
    const result = fireAndForgetWithRetry(operation, { baseDelayMs: 30000, onExhausted });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    result.abort();
    result.abort();
    expect(vi.getTimerCount()).toBe(0);
    await expect(result.promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60000);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("does not schedule a retry when an in-flight operation fails after abort", async () => {
    const pending = deferred<string>();
    const operation = vi.fn(() => pending.promise);
    const onExhausted = vi.fn();
    const result = fireAndForgetWithRetry(operation, { onExhausted });
    result.abort();
    pending.reject(new Error("write failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(result.promise).resolves.toBeUndefined();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("preserves a successful in-flight operation after abort", async () => {
    const pending = deferred<string>();
    const result = fireAndForgetWithRetry(() => pending.promise);
    result.abort();
    pending.resolve("written");
    await expect(result.promise).resolves.toBe("written");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips operations for an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn();
    await expect(
      new AuditErrorHandler().executeWithRetry(operation, "test", controller.signal),
    ).resolves.toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the abort listener when a backoff completes normally", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("retry"))
      .mockResolvedValue("written");
    const promise = new AuditErrorHandler().executeWithRetry(operation, "test", controller.signal);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("written");
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0][1]);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not report exhaustion when the final in-flight attempt is aborted", async () => {
    const pending = deferred<void>();
    const onExhausted = vi.fn();
    const result = fireAndForgetWithRetry(() => pending.promise, { maxRetries: 1, onExhausted });
    result.abort();
    pending.reject(new Error("write failed"));
    await expect(result.promise).resolves.toBeUndefined();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("preserves exponential retries and returns the successful result", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValue("written");
    const result = fireAndForgetWithRetry(operation);
    await vi.advanceTimersByTimeAsync(999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result.promise).resolves.toBe("written");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports the last error once after exhausting uninterrupted retries", async () => {
    const error = new Error("write failed");
    const operation = vi.fn().mockRejectedValue(error);
    const onExhausted = vi.fn();
    const promise = new AuditErrorHandler({ onExhausted }).executeWithRetry(operation, "test");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledExactlyOnceWith(error, 3);
  });
});
