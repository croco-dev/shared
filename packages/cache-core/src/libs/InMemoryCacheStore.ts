import type { ILogger } from "@croco/framework-context";
import { assertValidCacheNumericOption } from "./numericValidation";
import { InvalidCacheTtlProblem } from "./problems/CacheStoreProblems";
import {
  type CacheGetOrSetOptions,
  type CachePattern,
  type CacheStats,
  CacheStore,
  type CacheWarmupEntry,
} from "./CacheStore";

type CacheEntry<V> = {
  value: V;
  expiresAt: number | null;
};

type InFlightLoad<V> = {
  promise: Promise<V | undefined>;
  state: {
    invalidated: boolean;
  };
};

export type InMemoryCacheStoreOptions = {
  /** Positive safe integer. Defaults to 1000. */
  maxEntries?: number;
  /** Integer milliseconds from 1 through 2,147,483,647. Disabled by default. */
  cleanupIntervalMs?: number;
};

const DEFAULT_MAX_ENTRIES = 1000;
const WILDCARD_REGEX = /[.*+?^${}()|[\]\\]/g;

function escapePattern(pattern: string): string {
  return pattern.replace(WILDCARD_REGEX, "\\$&");
}

function createPatternRegex(pattern: CachePattern): RegExp {
  const escapedPattern = escapePattern(pattern).replace(/\\\*/g, ".*");
  return new RegExp(`^${escapedPattern}$`);
}

function assertValidTtl(ttlMs: number | undefined): void {
  if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs < 0)) {
    throw new InvalidCacheTtlProblem(ttlMs);
  }
}

export class InMemoryCacheStore<V = unknown> extends CacheStore<string, V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly inFlightLoads = new Map<string, InFlightLoad<V>>();
  private readonly maxEntries: number;
  private readonly stats: Omit<CacheStats, "size"> = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };
  private readonly cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    options: InMemoryCacheStoreOptions = { maxEntries: DEFAULT_MAX_ENTRIES },
    logger?: ILogger,
  ) {
    super();

    void logger;
    const maxEntries = options.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : options.maxEntries;
    assertValidCacheNumericOption("maxEntries", maxEntries);

    const cleanupIntervalMs = options.cleanupIntervalMs;
    if (cleanupIntervalMs !== undefined) {
      assertValidCacheNumericOption("cleanupIntervalMs", cleanupIntervalMs);
    }

    this.maxEntries = maxEntries;

    if (cleanupIntervalMs !== undefined) {
      this.cleanupTimer = setInterval(() => {
        this.pruneExpiredSync();
      }, cleanupIntervalMs);

      this.cleanupTimer.unref?.();
    }
  }

  async get(key: string): Promise<V | undefined> {
    const entry = this.store.get(key);

    if (entry === undefined) {
      this.stats.misses++;
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.deleteEntry(key);
      this.stats.misses++;
      return undefined;
    }

    this.touch(key, entry);
    this.stats.hits++;
    return entry.value;
  }

  async set(key: string, value: V, ttlMs?: number): Promise<void> {
    assertValidTtl(ttlMs);
    this.pruneExpiredSync();
    this.store.delete(key);

    if (ttlMs === 0) {
      this.invalidateInFlightLoad(key);
      return;
    }

    this.store.set(key, {
      value,
      expiresAt: ttlMs === undefined ? null : Date.now() + ttlMs,
    });
    this.evictOverflow();
  }

  async delete(key: string): Promise<void> {
    this.invalidateInFlightLoad(key);
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const entry = this.store.get(key);

    if (entry === undefined) {
      return false;
    }

    if (this.isExpired(entry)) {
      this.deleteEntry(key);
      return false;
    }

    this.touch(key, entry);
    return true;
  }

  async clear(): Promise<void> {
    this.store.clear();
    for (const inFlight of this.inFlightLoads.values()) {
      inFlight.state.invalidated = true;
      inFlight.promise.catch(() => {
        // inFlight 가 reject 되어도 inFlightLoads 에서 제거
      });
    }
    this.inFlightLoads.clear();
  }

  close(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
    }
  }

  async invalidatePattern(pattern: CachePattern): Promise<number> {
    const matcher = createPatternRegex(pattern);
    let deletedCount = 0;

    for (const key of Array.from(this.store.keys())) {
      if (!matcher.test(key)) {
        continue;
      }

      this.deleteEntry(key);
      deletedCount++;
    }

    for (const key of Array.from(this.inFlightLoads.keys())) {
      if (matcher.test(key)) {
        this.invalidateInFlightLoad(key);
      }
    }

    return deletedCount;
  }

  async pruneExpired(): Promise<number> {
    return this.pruneExpiredSync();
  }

  async getOrSet(
    key: string,
    loader: () => Promise<V | undefined>,
    options: CacheGetOrSetOptions = {},
  ): Promise<V | undefined> {
    assertValidTtl(options.ttlMs);

    if (options.ttlMs === 0) {
      this.pruneExpiredSync();
      this.store.delete(key);
      this.invalidateInFlightLoad(key);
      return loader();
    }

    const cachedValue = await this.get(key);
    if (cachedValue !== undefined) {
      return cachedValue;
    }

    const pending = this.inFlightLoads.get(key);
    if (pending !== undefined) {
      return pending.promise;
    }

    const loadState = {
      invalidated: false,
    };
    let resolveLoad!: (value: V | undefined | PromiseLike<V | undefined>) => void;
    let rejectLoad!: (reason?: unknown) => void;

    const loadPromise = new Promise<V | undefined>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });

    this.inFlightLoads.set(key, {
      promise: loadPromise,
      state: loadState,
    });

    void (async () => {
      try {
        const loadedValue = await loader();

        if (loadedValue !== undefined) {
          // Store was cleared/deleted during load — don't restore
          if (loadState.invalidated) {
            resolveLoad(undefined);
            return;
          }

          // 현재 캐시 값을 먼저 확인하여 늦은 loader 결과가 새 값으로 덮어쓰는지 확인
          const currentEntry = this.store.get(key);
          if (currentEntry !== undefined && !this.isExpired(currentEntry)) {
            // 다른 set()이 저장한 값이 아직 유효하면 유지
            resolveLoad(currentEntry.value);
            return;
          }

          await this.set(key, loadedValue, options.ttlMs);
        }

        resolveLoad(loadedValue);
      } catch (error) {
        rejectLoad(error);
      } finally {
        if (this.inFlightLoads.get(key)?.state === loadState) {
          this.inFlightLoads.delete(key);
        }
      }
    })();

    return loadPromise;
  }

  async warmup(entries: ReadonlyArray<CacheWarmupEntry<string, V>>): Promise<void> {
    for (const entry of entries) {
      assertValidTtl(entry.ttlMs);
    }

    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.ttlMs);
    }
  }

  getStats(): CacheStats {
    return {
      ...this.stats,
      size: this.store.size,
    };
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    return entry.expiresAt !== null && Date.now() >= entry.expiresAt;
  }

  private touch(key: string, entry: CacheEntry<V>): void {
    this.store.delete(key);
    this.store.set(key, entry);
  }

  private deleteEntry(key: string): void {
    if (this.store.delete(key)) {
      this.stats.evictions++;
    }
  }

  private invalidateInFlightLoad(key: string): void {
    const inFlight = this.inFlightLoads.get(key);
    if (inFlight === undefined) {
      return;
    }

    inFlight.state.invalidated = true;
    inFlight.promise.catch(() => {
      // inFlight 가 reject 되어도 inFlightLoads 에서 제거
    });
    this.inFlightLoads.delete(key);
  }

  private pruneExpiredSync(): number {
    let deletedCount = 0;

    for (const [key, entry] of this.store.entries()) {
      if (!this.isExpired(entry)) {
        continue;
      }

      this.deleteEntry(key);
      deletedCount++;
    }

    return deletedCount;
  }

  private evictOverflow(): void {
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;

      if (oldestKey === undefined) {
        return;
      }

      this.deleteEntry(oldestKey);
    }
  }
}
