import { Context } from "@croco/framework-context";
import { describe, expect, it, vi } from "vitest";
import { createBatchLoader } from "../libs/createBatchLoader";

describe("createBatchLoader outside a request context", () => {
  it("batches load and loadMany calls and retains cached results across dispatches", async () => {
    expect(Context.getCache()).toBeUndefined();
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((key) => key * 2));
    const loader = createBatchLoader({ name: "standalone", batchFn });

    expect(await Promise.all([loader.load(1), loader.loadMany([2, 1])])).toEqual([2, [4, 2]]);
    expect(batchFn).toHaveBeenCalledExactlyOnceWith([1, 2]);
    expect(await loader.loadMany([1, 2])).toEqual([2, 4]);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it("retains primed values and clears individual keys and the entire cache", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((key) => key * 2));
    const loader = createBatchLoader({ name: "standalone", batchFn });
    loader.prime(1, 10);
    loader.prime(2, 20);
    expect(await loader.loadMany([1, 2])).toEqual([10, 20]);
    expect(batchFn).not.toHaveBeenCalled();

    loader.clear(1);
    expect(await loader.loadMany([1, 2])).toEqual([2, 20]);
    expect(batchFn).toHaveBeenLastCalledWith([1]);
    loader.clearAll();
    expect(await loader.loadMany([1, 2])).toEqual([2, 4]);
    expect(batchFn).toHaveBeenLastCalledWith([1, 2]);
    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("isolates standalone instances even when factories have the same name", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((key) => key * 2));
    const first = createBatchLoader({ name: "shared-name", batchFn });
    const second = createBatchLoader({ name: "shared-name", batchFn });
    first.prime(1, 10);
    expect(await first.load(1)).toBe(10);
    expect(await second.load(1)).toBe(2);
    second.clearAll();
    expect(await first.load(1)).toBe(10);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it("isolates overlapping request caches from each other and the standalone cache", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((key) => key * 2));
    const loader = createBatchLoader({ name: "standalone", batchFn });
    loader.prime(1, 10);
    await Promise.all(
      [20, 30].map((value) =>
        Context.run({ requestId: String(value) }, async () => {
          expect(await loader.load(1)).toBe(2);
          loader.prime(1, value);
          await Promise.resolve();
          expect(await loader.load(1)).toBe(value);
          loader.clearAll();
        }),
      ),
    );
    expect(await loader.load(1)).toBe(10);
    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("still batches with caching disabled without retaining results", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((key) => key * 2));
    const loader = createBatchLoader({ name: "uncached", batchFn, cache: false });
    expect(await Promise.all([loader.load(1), loader.load(2)])).toEqual([2, 4]);
    expect(batchFn).toHaveBeenCalledExactlyOnceWith([1, 2]);
    expect(await loader.load(1)).toBe(2);
    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("retries rejected batches using the retained instance", async () => {
    const failure = new Error("batch failed");
    const batchFn = vi
      .fn<(keys: readonly number[]) => Promise<number[]>>()
      .mockRejectedValueOnce(failure)
      .mockImplementation(async (keys) => keys.map((key) => key * 2));
    const loader = createBatchLoader({ name: "retry", batchFn });
    expect(await loader.loadMany([1, 2])).toEqual([failure, failure]);
    expect(await loader.loadMany([1, 2])).toEqual([2, 4]);
    expect(await loader.load(1)).toBe(2);
    expect(batchFn).toHaveBeenCalledTimes(2);
  });
});
