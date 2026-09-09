import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCacheStore } from "../libs/InMemoryCacheStore";
import {
  InvalidCacheConfigurationProblem,
  InvalidCacheTtlProblem,
  MAX_CACHE_ENTRIES,
  MAX_CACHE_TIMER_DELAY_MS,
} from "../libs/problems/CacheStoreProblems";

describe("InMemoryCacheStore", () => {
  let cache!: InMemoryCacheStore<string>;

  beforeEach(() => {
    cache = new InMemoryCacheStore<string>({ maxEntries: 1000 });
  });

  async function waitForInFlightLoader(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  describe("get and set", () => {
    it("stores and retrieves a value", async () => {
      await cache.set("key1", "value1");
      const result = await cache.get("key1");
      expect(result).toBe("value1");
    });

    it("returns undefined for non-existent key", async () => {
      const result = await cache.get("nonexistent");
      expect(result).toBeUndefined();
    });

    it("overwrites existing value", async () => {
      await cache.set("key1", "value1");
      await cache.set("key1", "value2");
      const result = await cache.get("key1");
      expect(result).toBe("value2");
    });
  });

  describe("TTL expiration", () => {
    it.each([
      ["negative", -1],
      ["NaN", Number.NaN],
      ["positive infinity", Number.POSITIVE_INFINITY],
      ["negative infinity", Number.NEGATIVE_INFINITY],
    ])("rejects %s TTL before replacing an existing value", async (_label, ttlMs) => {
      await cache.set("key1", "original");

      await expect(cache.set("key1", "replacement", ttlMs)).rejects.toMatchObject({
        code: "cache-core/invalid-ttl",
        extensions: { receivedTtl: String(ttlMs) },
        receivedTtl: String(ttlMs),
      } satisfies Partial<InvalidCacheTtlProblem>);
      expect(await cache.get("key1")).toBe("original");
    });

    it("treats a zero TTL as immediately expired", async () => {
      vi.useFakeTimers();

      try {
        await cache.set("key1", "value1", 0);

        expect(await cache.get("key1")).toBeUndefined();
        expect(cache.getStats().size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not evict an unrelated live entry for a zero TTL write", async () => {
      const boundedCache = new InMemoryCacheStore<string>({ maxEntries: 1 });
      await boundedCache.set("live", "value");

      await boundedCache.set("zero", "discarded", 0);

      expect(await boundedCache.get("live")).toBe("value");
      expect(await boundedCache.get("zero")).toBeUndefined();
      expect(boundedCache.getStats().evictions).toBe(0);
    });

    it("removes an existing value when it is replaced with a zero TTL", async () => {
      await cache.set("key1", "original");

      await cache.set("key1", "replacement", 0);

      expect(await cache.get("key1")).toBeUndefined();
    });

    it("returns undefined after TTL expires", async () => {
      vi.useFakeTimers();

      await cache.set("key1", "value1", 1000);

      let result = await cache.get("key1");
      expect(result).toBe("value1");

      vi.advanceTimersByTime(1001);

      result = await cache.get("key1");
      expect(result).toBeUndefined();

      vi.useRealTimers();
    });

    it("returns true for has() before expiration", async () => {
      vi.useFakeTimers();

      await cache.set("key1", "value1", 1000);

      let exists = await cache.has("key1");
      expect(exists).toBe(true);

      vi.advanceTimersByTime(1001);

      exists = await cache.has("key1");
      expect(exists).toBe(false);

      vi.useRealTimers();
    });

    it("does not expire when TTL is not set", async () => {
      vi.useFakeTimers();

      await cache.set("key1", "value1");

      vi.advanceTimersByTime(10000);

      const result = await cache.get("key1");
      expect(result).toBe("value1");

      vi.useRealTimers();
    });
  });

  describe("delete", () => {
    it("removes a key", async () => {
      await cache.set("key1", "value1");
      await cache.delete("key1");
      const result = await cache.get("key1");
      expect(result).toBeUndefined();
    });

    it("does not throw for non-existent key", async () => {
      await expect(cache.delete("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("has", () => {
    it("returns true for existing key", async () => {
      await cache.set("key1", "value1");
      const exists = await cache.has("key1");
      expect(exists).toBe(true);
    });

    it("returns false for non-existent key", async () => {
      const exists = await cache.has("nonexistent");
      expect(exists).toBe(false);
    });
  });

  describe("clear", () => {
    it("removes all keys", async () => {
      await cache.set("key1", "value1");
      await cache.set("key2", "value2");
      await cache.clear();
      expect(await cache.get("key1")).toBeUndefined();
      expect(await cache.get("key2")).toBeUndefined();
    });
  });

  describe("invalidatePattern", () => {
    it("deletes keys matching wildcard pattern", async () => {
      await cache.set("User:getUser:123", "user1");
      await cache.set("User:getUser:456", "user2");
      await cache.set("Order:getOrder:789", "order1");

      const deleted = await cache.invalidatePattern("User:getUser:*");

      expect(deleted).toBe(2);
      expect(await cache.get("User:getUser:123")).toBeUndefined();
      expect(await cache.get("User:getUser:456")).toBeUndefined();
      expect(await cache.get("Order:getOrder:789")).toBe("order1");
    });

    it("deletes exact match when no wildcard", async () => {
      await cache.set("key1", "value1");
      await cache.set("key2", "value2");

      const deleted = await cache.invalidatePattern("key1");

      expect(deleted).toBe(1);
      expect(await cache.get("key1")).toBeUndefined();
      expect(await cache.get("key2")).toBe("value2");
    });

    it("returns 0 when no keys match", async () => {
      await cache.set("key1", "value1");
      const deleted = await cache.invalidatePattern("nonexistent*");
      expect(deleted).toBe(0);
    });

    it("supports wildcard pattern in the middle of the key", async () => {
      await cache.set("user:profile:1", "profile");
      await cache.set("user:settings:1", "settings");
      await cache.set("order:profile:1", "order");

      const deleted = await cache.invalidatePattern("user:*:1");

      expect(deleted).toBe(2);
      expect(await cache.get("user:profile:1")).toBeUndefined();
      expect(await cache.get("user:settings:1")).toBeUndefined();
      expect(await cache.get("order:profile:1")).toBe("order");
    });
  });

  describe("pruneExpired", () => {
    it("removes expired entries without reads", async () => {
      vi.useFakeTimers();

      await cache.set("expired", "value", 1000);
      await cache.set("active", "value", 5000);

      vi.advanceTimersByTime(1001);

      const deleted = await cache.pruneExpired();

      expect(deleted).toBe(1);
      expect(await cache.get("expired")).toBeUndefined();
      expect(await cache.get("active")).toBe("value");

      vi.useRealTimers();
    });
  });

  describe("capacity management", () => {
    it.each([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      null as unknown as number,
      -1,
      0,
      1.5,
      MAX_CACHE_ENTRIES + 1,
    ])("rejects invalid maxEntries %s before allocating a cleanup timer", (maxEntries) => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      try {
        expect(() => new InMemoryCacheStore({ maxEntries, cleanupIntervalMs: 1 })).toThrow(
          InvalidCacheConfigurationProblem,
        );

        try {
          new InMemoryCacheStore({ maxEntries, cleanupIntervalMs: 1 });
        } catch (error) {
          expect(error).toMatchObject({
            code: "cache-core/invalid-configuration",
            option: "maxEntries",
            value: maxEntries,
          });
        }

        expect(setIntervalSpy).not.toHaveBeenCalled();
      } finally {
        setIntervalSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it.each([1, MAX_CACHE_ENTRIES])("accepts maxEntries boundary %s", (maxEntries) => {
      expect(() => new InMemoryCacheStore({ maxEntries })).not.toThrow();
    });

    it("should apply default maxEntries of 1000 when not set", async () => {
      const defaultCache = new InMemoryCacheStore<string>();

      for (let i = 0; i < 1001; i++) {
        await defaultCache.set(`key${i}`, `value${i}`);
      }

      expect(await defaultCache.get("key0")).toBeUndefined();
      expect(await defaultCache.get("key1000")).toBe("value1000");
    });

    it("should not warn when maxEntries is explicitly set", async () => {
      const boundedCache = new InMemoryCacheStore<string>({ maxEntries: 2 });

      expect(boundedCache).toBeInstanceOf(InMemoryCacheStore);
    });

    it("should evict the oldest entry when maxEntries is exceeded", async () => {
      const boundedCache = new InMemoryCacheStore<string>({ maxEntries: 2 });

      await boundedCache.set("key1", "value1");
      await boundedCache.set("key2", "value2");
      await boundedCache.set("key3", "value3");

      expect(await boundedCache.get("key1")).toBeUndefined();
      expect(await boundedCache.get("key2")).toBe("value2");
      expect(await boundedCache.get("key3")).toBe("value3");
    });

    it("uses true LRU ordering when accessed entries are read", async () => {
      const boundedCache = new InMemoryCacheStore<string>({ maxEntries: 2 });

      await boundedCache.set("key1", "value1");
      await boundedCache.set("key2", "value2");

      expect(await boundedCache.get("key1")).toBe("value1");

      await boundedCache.set("key3", "value3");

      expect(await boundedCache.get("key1")).toBe("value1");
      expect(await boundedCache.get("key2")).toBeUndefined();
      expect(await boundedCache.get("key3")).toBe("value3");
    });

    it("should prune expired entries before evicting active ones on set", async () => {
      vi.useFakeTimers();

      const boundedCache = new InMemoryCacheStore<string>({ maxEntries: 2 });

      await boundedCache.set("expired", "value1", 1000);
      await boundedCache.set("active", "value2");

      vi.advanceTimersByTime(1001);

      await boundedCache.set("fresh", "value3");

      expect(await boundedCache.get("expired")).toBeUndefined();
      expect(await boundedCache.get("active")).toBe("value2");
      expect(await boundedCache.get("fresh")).toBe("value3");

      vi.useRealTimers();
    });
  });

  describe("getOrSet", () => {
    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      "rejects invalid TTL %s before reading cache or calling the loader",
      async (ttlMs) => {
        const loader = vi.fn(async () => "replacement");
        await cache.set("key1", "original");

        await expect(cache.getOrSet("key1", loader, { ttlMs })).rejects.toBeInstanceOf(
          InvalidCacheTtlProblem,
        );
        expect(loader).not.toHaveBeenCalled();
        expect(cache.getStats()).toMatchObject({ hits: 0, misses: 0 });
        expect(await cache.get("key1")).toBe("original");
      },
    );

    it("bypasses an existing value when the requested TTL is zero", async () => {
      const loader = vi.fn(async () => "replacement");
      await cache.set("key1", "original");

      await expect(cache.getOrSet("key1", loader, { ttlMs: 0 })).resolves.toBe("replacement");

      expect(loader).toHaveBeenCalledTimes(1);
      expect(cache.getStats()).toEqual({ hits: 0, misses: 0, evictions: 0, size: 0 });
      expect(await cache.get("key1")).toBeUndefined();
    });

    it("invalidates a same-key in-flight load when the requested TTL is zero", async () => {
      let resolveInFlightLoader!: (value: string) => void;
      const inFlightLoader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveInFlightLoader = resolve;
          }),
      );
      const zeroTtlLoader = vi.fn(async () => "zero-ttl-value");

      const inFlightPromise = cache.getOrSet("key1", inFlightLoader, { ttlMs: 1000 });
      await waitForInFlightLoader();

      await expect(cache.getOrSet("key1", zeroTtlLoader, { ttlMs: 0 })).resolves.toBe(
        "zero-ttl-value",
      );
      resolveInFlightLoader("stale-value");

      await expect(inFlightPromise).resolves.toBeUndefined();
      expect(zeroTtlLoader).toHaveBeenCalledTimes(1);
      expect(await cache.get("key1")).toBeUndefined();
    });

    it("runs concurrent zero-TTL loaders independently", async () => {
      let resolveFirstLoader!: (value: string) => void;
      const firstLoader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveFirstLoader = resolve;
          }),
      );
      const secondLoader = vi.fn(async () => "second-value");

      const firstPromise = cache.getOrSet("key1", firstLoader, { ttlMs: 0 });
      await waitForInFlightLoader();

      await expect(cache.getOrSet("key1", secondLoader, { ttlMs: 0 })).resolves.toBe(
        "second-value",
      );
      resolveFirstLoader("first-value");

      await expect(firstPromise).resolves.toBe("first-value");
      expect(firstLoader).toHaveBeenCalledTimes(1);
      expect(secondLoader).toHaveBeenCalledTimes(1);
      expect(cache.getStats()).toEqual({ hits: 0, misses: 0, evictions: 0, size: 0 });
    });

    it("runs and caches a positive-TTL loader independently from a zero-TTL load", async () => {
      let resolveZeroTtlLoader!: (value: string) => void;
      const zeroTtlLoader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveZeroTtlLoader = resolve;
          }),
      );
      const positiveTtlLoader = vi.fn(async () => "cached-value");

      const zeroTtlPromise = cache.getOrSet("key1", zeroTtlLoader, { ttlMs: 0 });
      await waitForInFlightLoader();

      await expect(cache.getOrSet("key1", positiveTtlLoader, { ttlMs: 1000 })).resolves.toBe(
        "cached-value",
      );
      resolveZeroTtlLoader("zero-ttl-value");

      await expect(zeroTtlPromise).resolves.toBe("zero-ttl-value");
      expect(zeroTtlLoader).toHaveBeenCalledTimes(1);
      expect(positiveTtlLoader).toHaveBeenCalledTimes(1);
      expect(await cache.get("key1")).toBe("cached-value");
    });

    it("returns cached value without calling loader again", async () => {
      const loader = vi.fn(async () => "loaded");

      const first = await cache.getOrSet("key1", loader, { ttlMs: 1000 });
      const second = await cache.getOrSet("key1", loader, { ttlMs: 1000 });

      expect(first).toBe("loaded");
      expect(second).toBe("loaded");
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("uses singleflight for concurrent requests", async () => {
      let resolveLoader!: (value: string) => void;
      const loader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveLoader = resolve;
          }),
      );

      const pending = Promise.all([
        cache.getOrSet("key1", loader),
        cache.getOrSet("key1", loader),
        cache.getOrSet("key1", loader),
      ]);

      await waitForInFlightLoader();

      expect(loader).toHaveBeenCalledTimes(1);

      resolveLoader("loaded");

      await expect(pending).resolves.toEqual(["loaded", "loaded", "loaded"]);
    });

    it("does not cache undefined values", async () => {
      const loader = vi.fn(async () => undefined);

      const first = await cache.getOrSet("key1", loader);
      const second = await cache.getOrSet("key1", loader);

      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it("clear() during getOrSet load: loader completes but value not stored", async () => {
      let resolveLoader!: (value: string) => void;
      const loader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveLoader = resolve;
          }),
      );

      const pendingPromise = cache.getOrSet("key1", loader, { ttlMs: 1000 }) as Promise<string>;

      await waitForInFlightLoader();

      await cache.clear();
      resolveLoader("loaded-value");

      const result = await pendingPromise;

      // clear() 가 inFlightLoads 를 정리하지 않으면 value 가 복원됨
      expect(result).toBeUndefined();
      expect(await cache.get("key1")).toBeUndefined();
    });

    it("delete() during getOrSet load: loader completes but value not stored", async () => {
      let resolveLoader!: (value: string) => void;
      const loader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveLoader = resolve;
          }),
      );

      const pendingPromise = cache.getOrSet("key1", loader, { ttlMs: 1000 }) as Promise<string>;

      await waitForInFlightLoader();

      await cache.delete("key1");
      resolveLoader("loaded-value");

      const result = await pendingPromise;

      // delete() 가 inFlightLoads 를 정리하지 않으면 value 가 복원됨
      expect(result).toBeUndefined();
      expect(await cache.get("key1")).toBeUndefined();
    });

    it("zero TTL set during getOrSet load: loader completes but value not stored", async () => {
      let resolveLoader!: (value: string) => void;
      const loader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveLoader = resolve;
          }),
      );

      const pendingPromise = cache.getOrSet("key1", loader, { ttlMs: 1000 }) as Promise<string>;

      await waitForInFlightLoader();

      await cache.set("key1", "discarded", 0);
      resolveLoader("loaded-value");

      await expect(pendingPromise).resolves.toBeUndefined();
      expect(await cache.get("key1")).toBeUndefined();
    });

    it("invalidatePattern() during getOrSet load: loader completes but value not stored", async () => {
      let resolveLoader!: (value: string) => void;
      const loader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveLoader = resolve;
          }),
      );

      const pendingPromise = cache.getOrSet("key1", loader, { ttlMs: 1000 }) as Promise<string>;

      await waitForInFlightLoader();

      await cache.invalidatePattern("key1");
      resolveLoader("loaded-value");

      const result = await pendingPromise;

      // invalidatePattern() 가 inFlightLoads 를 정리하지 않으면 value 가 복원됨
      expect(result).toBeUndefined();
      expect(await cache.get("key1")).toBeUndefined();
    });

    it("delete() for an unrelated key does not suppress an in-flight getOrSet result", async () => {
      let resolveLoader!: (value: string) => void;
      const loader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveLoader = resolve;
          }),
      );

      const pendingPromise = cache.getOrSet("target", loader, { ttlMs: 1000 }) as Promise<string>;

      await waitForInFlightLoader();

      await cache.delete("other");
      resolveLoader("loaded-value");

      await expect(pendingPromise).resolves.toBe("loaded-value");
      expect(await cache.get("target")).toBe("loaded-value");
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("unmatched invalidatePattern() does not suppress an in-flight getOrSet result", async () => {
      let resolveLoader!: (value: string) => void;
      const loader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveLoader = resolve;
          }),
      );

      const pendingPromise = cache.getOrSet("target", loader, { ttlMs: 1000 }) as Promise<string>;

      await waitForInFlightLoader();

      const deleted = await cache.invalidatePattern("other:*");
      resolveLoader("loaded-value");

      expect(deleted).toBe(0);
      await expect(pendingPromise).resolves.toBe("loaded-value");
      expect(await cache.get("target")).toBe("loaded-value");
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("delete() from the loader prevents stale restoration", async () => {
      const loader = vi.fn(async () => {
        await cache.delete("key1");
        return "loaded-value";
      });

      const result = await cache.getOrSet("key1", loader, { ttlMs: 1000 });

      expect(result).toBeUndefined();
      expect(await cache.get("key1")).toBeUndefined();
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("clear() from the loader prevents stale restoration", async () => {
      await cache.set("other", "other-value");

      const loader = vi.fn(async () => {
        await cache.clear();
        return "loaded-value";
      });

      const result = await cache.getOrSet("key1", loader, { ttlMs: 1000 });

      expect(result).toBeUndefined();
      expect(await cache.get("key1")).toBeUndefined();
      expect(await cache.get("other")).toBeUndefined();
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("matching invalidatePattern() from the loader prevents stale restoration", async () => {
      const loader = vi.fn(async () => {
        await cache.invalidatePattern("key1");
        return "loaded-value";
      });

      const result = await cache.getOrSet("key1", loader, { ttlMs: 1000 });

      expect(result).toBeUndefined();
      expect(await cache.get("key1")).toBeUndefined();
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("removes in-flight state after a loader throws synchronously", async () => {
      const failingLoader = vi.fn((): Promise<string> => {
        throw new Error("loader failed");
      });
      const recoveryLoader = vi.fn(async () => "recovered");

      await expect(cache.getOrSet("key1", failingLoader)).rejects.toThrow("loader failed");

      await expect(cache.getOrSet("key1", recoveryLoader)).resolves.toBe("recovered");
      expect(failingLoader).toHaveBeenCalledTimes(1);
      expect(recoveryLoader).toHaveBeenCalledTimes(1);
      expect(await cache.get("key1")).toBe("recovered");
    });

    it("getOrSet stale overwrite: set before loader completes", async () => {
      const loader = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "loaded-value";
      });

      const pendingPromise = cache.getOrSet("key1", loader, { ttlMs: 1000 }) as Promise<string>;

      await Promise.resolve();

      await cache.set("key1", "newValue");

      const result = await pendingPromise;

      // getOrSet 의 loader 완료 후 현재 캐시 값을 확인하는 로직에 의해 새 값이 유지되어야 함
      expect(result).toBe("newValue");
      expect(await cache.get("key1")).toBe("newValue");
    });

    it.each([
      [99, "intermediate", 0],
      [100, "loaded-value", 1],
      [101, "loaded-value", 1],
    ])(
      "checks a concurrent entry's TTL after loading at %i ms",
      async (elapsedMs, expected, evictions) => {
        vi.useFakeTimers();

        try {
          vi.setSystemTime(0);
          let resolveLoader!: (value: string) => void;
          const loader = vi.fn(
            () =>
              new Promise<string>((resolve) => {
                resolveLoader = resolve;
              }),
          );
          const first = cache.getOrSet("key1", loader, { ttlMs: 1000 });
          const second = cache.getOrSet("key1", loader, { ttlMs: 1000 });
          await waitForInFlightLoader();
          await cache.set("key1", "intermediate", 100);

          vi.setSystemTime(elapsedMs);
          resolveLoader("loaded-value");

          await expect(Promise.all([first, second])).resolves.toEqual([expected, expected]);
          expect(loader).toHaveBeenCalledTimes(1);
          expect(cache.getStats()).toEqual({ hits: 0, misses: 2, evictions, size: 1 });
          expect(await cache.get("key1")).toBe(expected);

          const expiresAt = elapsedMs < 100 ? 100 : elapsedMs + 1000;
          vi.setSystemTime(expiresAt - 1);
          expect(await cache.get("key1")).toBe(expected);
          vi.setSystemTime(expiresAt);
          expect(await cache.get("key1")).toBeUndefined();
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("getOrSet stale overwrite: set after clear", async () => {
      const loader = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "loaded-value";
      });

      const pendingPromise = cache.getOrSet("key1", loader, { ttlMs: 1000 }) as Promise<string>;

      await Promise.resolve();

      await cache.clear();
      await cache.set("key1", "newValue");

      const result = await pendingPromise;

      // clear() 가 generation 을 증가시켰으므로 loader 결과는 저장되지 않음
      expect(result).toBeUndefined();
      // set() 으로 저장한 값은 유지되어야 함
      expect(await cache.get("key1")).toBe("newValue");
    });
  });

  describe("warmup", () => {
    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      "rejects invalid TTL %s before storing any entries",
      async (ttlMs) => {
        await cache.set("existing", "original");

        await expect(
          cache.warmup([
            { key: "valid", value: "new" },
            { key: "existing", value: "replacement", ttlMs },
          ]),
        ).rejects.toBeInstanceOf(InvalidCacheTtlProblem);
        expect(await cache.get("valid")).toBeUndefined();
        expect(await cache.get("existing")).toBe("original");
      },
    );

    it("primes multiple entries with ttl metadata", async () => {
      vi.useFakeTimers();

      await cache.warmup([
        { key: "key1", value: "value1", ttlMs: 1000 },
        { key: "key2", value: "value2" },
      ]);

      expect(await cache.get("key1")).toBe("value1");
      expect(await cache.get("key2")).toBe("value2");

      vi.advanceTimersByTime(1001);

      expect(await cache.get("key1")).toBeUndefined();
      expect(await cache.get("key2")).toBe("value2");

      vi.useRealTimers();
    });
  });

  describe("stats", () => {
    it("tracks hits, misses, evictions, and size", async () => {
      vi.useFakeTimers();

      const boundedCache = new InMemoryCacheStore<string>({ maxEntries: 2 });

      await boundedCache.set("key1", "value1");
      await boundedCache.set("key2", "value2", 1000);

      expect(await boundedCache.get("key1")).toBe("value1");
      expect(await boundedCache.get("missing")).toBeUndefined();

      vi.advanceTimersByTime(1001);

      expect(await boundedCache.get("key2")).toBeUndefined();

      await boundedCache.set("key3", "value3");
      await boundedCache.set("key4", "value4");

      expect(boundedCache.getStats()).toEqual({
        hits: 1,
        misses: 2,
        evictions: 2,
        size: 2,
      });

      vi.useRealTimers();
    });
  });

  describe("periodic cleanup", () => {
    it.each([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      null as unknown as number,
      -1,
      0,
      1.5,
      MAX_CACHE_TIMER_DELAY_MS + 1,
    ])("rejects invalid cleanupIntervalMs %s before allocating a timer", (cleanupIntervalMs) => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      try {
        expect(() => new InMemoryCacheStore({ cleanupIntervalMs })).toThrow(
          InvalidCacheConfigurationProblem,
        );

        try {
          new InMemoryCacheStore({ cleanupIntervalMs });
        } catch (error) {
          expect(error).toMatchObject({
            code: "cache-core/invalid-configuration",
            option: "cleanupIntervalMs",
            value: cleanupIntervalMs,
          });
        }

        expect(setIntervalSpy).not.toHaveBeenCalled();
      } finally {
        setIntervalSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it.each([1, MAX_CACHE_TIMER_DELAY_MS])(
      "accepts cleanupIntervalMs boundary %s without timer clamping",
      (cleanupIntervalMs) => {
        vi.useFakeTimers();

        try {
          const periodicCache = new InMemoryCacheStore({ cleanupIntervalMs });
          periodicCache.close();
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("removes expired entries on cleanup interval without reads", async () => {
      vi.useFakeTimers();

      const periodicCache = new InMemoryCacheStore<string>({
        maxEntries: 10,
        cleanupIntervalMs: 500,
      });

      await periodicCache.set("expiring", "value", 400);

      vi.advanceTimersByTime(500);

      expect(await periodicCache.get("expiring")).toBeUndefined();
      expect(periodicCache.getStats().evictions).toBe(1);

      vi.useRealTimers();
    });
  });
});
