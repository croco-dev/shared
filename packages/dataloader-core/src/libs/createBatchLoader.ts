import { Context } from "@croco/framework-context";
import { BatchLoaderImpl } from "./BatchLoader";
import type { BatchLoader, BatchLoaderOptions } from "./types";

/**
 * Creates a factory that returns a BatchLoader instance.
 * The instance is scoped to the current request context using AsyncLocalStorage.
 *
 * @param options Configuration options for the BatchLoader
 * @returns An object with the same interface as BatchLoader, but delegating to a context-scoped instance
 */
export function createBatchLoader<K, V>(options: BatchLoaderOptions<K, V>): BatchLoader<K, V> {
  let standaloneLoader: BatchLoader<K, V> | undefined;

  const getLoader = (): BatchLoader<K, V> => {
    const contextCache = Context.getCache();

    if (!contextCache) {
      standaloneLoader ??= new BatchLoaderImpl(options);
      return standaloneLoader;
    }

    const staticScope = options.scope ? `:${options.scope}` : "";
    const dynamicScope = options.resolveScope?.();
    const dynamicScopeKey = dynamicScope ? `:scope:${dynamicScope}` : "";

    const cacheKey = `dataloader:${options.name}:v1${staticScope}${dynamicScopeKey}`;

    let loader = contextCache.get(cacheKey) as BatchLoaderImpl<K, V> | undefined;

    if (!loader) {
      loader = new BatchLoaderImpl(options);
      contextCache.set(cacheKey, loader);
    }

    return loader;
  };

  return {
    load: (key: K) => getLoader().load(key),
    loadMany: (keys: K[]) => getLoader().loadMany(keys),
    clear: (key: K) => getLoader().clear(key),
    clearAll: () => getLoader().clearAll(),
    prime: (key: K, value: V | Error) => getLoader().prime(key, value),
  };
}
