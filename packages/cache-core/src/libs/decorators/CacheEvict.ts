import type { CacheStore } from "../CacheStore";
import { createCacheKey } from "../cacheKey";
import { CacheDecoratorConfigProblem } from "../problems/CacheDecoratorProblems";

export interface CacheEvictOptions<V = unknown> {
  store: CacheStore<string, V>;
  namespace?: string;
  key?: string;
  allEntries?: boolean;
}

function resolveEvictionPrefix(options: CacheEvictOptions<unknown>, methodName: string): string {
  if (options.namespace === undefined) {
    throw new CacheDecoratorConfigProblem(
      `@CacheEvict requires "namespace" when neither "key" nor "allEntries: true" is provided (method: ${methodName})`,
    );
  }

  return `${options.namespace}:${methodName}`;
}

export function CacheEvict<V = unknown>(options: CacheEvictOptions<V>): MethodDecorator {
  return (
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    const methodName = String(propertyKey);
    const prefix =
      options.key === undefined && options.allEntries !== true
        ? resolveEvictionPrefix(options, methodName)
        : undefined;

    descriptor.value = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const argumentKey = prefix === undefined ? undefined : createCacheKey(prefix, args);
      const result = await originalMethod.apply(this, args);

      if (options.allEntries === true) {
        if (options.namespace === undefined) {
          await options.store.clear();
        } else {
          await options.store.invalidatePattern(`${options.namespace}:*`);
        }
        return result;
      }

      if (options.key !== undefined) {
        if (options.key.includes("*")) {
          await options.store.invalidatePattern(options.key);
        } else {
          await options.store.delete(options.key);
        }

        return result;
      }

      if (argumentKey !== undefined) {
        await options.store.delete(argumentKey);
      }

      return result;
    };

    return descriptor;
  };
}
