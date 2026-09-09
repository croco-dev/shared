import { type Attributes, context, type Context, type Span, trace } from "@opentelemetry/api";
import { recordError } from "../span.js";
import { getTracer } from "../tracer.js";

export type TraceDecoratorOptions = {
  name?: string;
  attributes?: Attributes;
};

const traceOptionsStore = new WeakMap<object, Map<string | symbol, TraceDecoratorOptions>>();

type TraceableReturn<ReturnType> = ReturnType | Promise<ReturnType> | AsyncIterable<ReturnType>;
type TraceableMethod<Args extends unknown[], ReturnType> = (
  ...args: Args
) => TraceableReturn<ReturnType>;

function isAsyncIterable<ReturnType>(value: unknown): value is AsyncIterable<ReturnType> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

async function finalizeAsyncIterator<ReturnType>(
  iterator: AsyncIterator<ReturnType> | undefined,
  isDone: boolean,
  hasIterationError: boolean,
  spanContext: Context,
  span: Span,
  endSpan: () => void,
): Promise<void> {
  try {
    if (!iterator || isDone) {
      return;
    }

    try {
      const cleanup = iterator.return;
      if (!cleanup) {
        return;
      }

      await context.with(spanContext, () => cleanup.call(iterator));
    } catch (error) {
      recordError(error, span);

      if (!hasIterationError) {
        throw error;
      }
    }
  } finally {
    endSpan();
  }
}

function traceAsyncIterable<ReturnType>(
  iterable: AsyncIterable<ReturnType>,
  span: Span,
): AsyncIterable<ReturnType> {
  let hasStarted = false;
  let hasEnded = false;
  const endSpan = (): void => {
    if (hasEnded) {
      return;
    }

    hasEnded = true;
    span.end();
  };
  const generator: AsyncGenerator<ReturnType, unknown, unknown> = (async function* () {
    const spanContext = trace.setSpan(context.active(), span);
    let iterator: AsyncIterator<ReturnType> | undefined;
    let isDone = false;
    let hasIterationError = false;

    try {
      const activeIterator = iterable[Symbol.asyncIterator]();
      iterator = activeIterator;

      while (true) {
        const result = await context.with(spanContext, () => activeIterator.next());

        if (result.done) {
          isDone = true;
          return;
        }

        yield await context.with(spanContext, async () => result.value);
      }
    } catch (error) {
      hasIterationError = true;
      recordError(error, span);
      throw error;
    } finally {
      await finalizeAsyncIterator(iterator, isDone, hasIterationError, spanContext, span, endSpan);
    }
  })();

  const tracedIterator: AsyncIterableIterator<ReturnType, unknown, unknown> = {
    [Symbol.asyncIterator]() {
      return tracedIterator;
    },
    next(value?: unknown) {
      hasStarted = true;
      return generator.next(value);
    },
    return(value?: unknown) {
      if (!hasStarted) {
        endSpan();
      }

      return generator.return(value);
    },
    throw(error?: unknown) {
      if (!hasStarted) {
        recordError(error, span);
        endSpan();
      }

      return generator.throw(error);
    },
  };

  return {
    [Symbol.asyncIterator]() {
      return tracedIterator;
    },
  };
}

function cloneOptions(options: TraceDecoratorOptions): TraceDecoratorOptions {
  return {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.attributes === undefined ? {} : { attributes: { ...options.attributes } }),
  };
}

function setTraceOptions(
  target: object,
  propertyKey: string | symbol,
  options: TraceDecoratorOptions,
): void {
  const existing = traceOptionsStore.get(target);

  if (existing) {
    existing.set(propertyKey, cloneOptions(options));
    return;
  }

  const map = new Map<string | symbol, TraceDecoratorOptions>();
  map.set(propertyKey, cloneOptions(options));
  traceOptionsStore.set(target, map);
}

/**
 * 메서드 실행을 Span으로 감싸는 데코레이터입니다.
 */
export function Trace<Args extends unknown[] = unknown[], ReturnType = unknown>(
  options: TraceDecoratorOptions = {},
): (
  _target: object,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor,
) => PropertyDescriptor | undefined {
  return (_target, propertyKey, descriptor) => {
    const originalMethod = descriptor.value as TraceableMethod<Args, ReturnType> | undefined;

    if (!originalMethod) {
      return descriptor;
    }

    setTraceOptions(_target, propertyKey, options);

    descriptor.value = function (this: unknown, ...args: Args): TraceableReturn<ReturnType> {
      const span = getTracer().startSpan(options.name ?? String(propertyKey));
      const spanAttributes = options.attributes ?? {};
      const spanContext = trace.setSpan(context.active(), span);

      for (const [key, value] of Object.entries(spanAttributes)) {
        span.setAttribute(key, value as Parameters<Span["setAttribute"]>[1]);
      }

      return context.with(spanContext, () => {
        try {
          const result = originalMethod.apply(this, args);

          if (isAsyncIterable<ReturnType>(result)) {
            return traceAsyncIterable(result, span);
          }

          if (!isPromiseLike(result)) {
            span.end();
            return result;
          }

          return Promise.resolve(result)
            .catch((error) => {
              recordError(error, span);
              throw error;
            })
            .finally(() => {
              span.end();
            });
        } catch (error) {
          recordError(error, span);
          span.end();
          throw error;
        }
      });
    } as (...args: Args) => TraceableReturn<ReturnType>;

    return descriptor;
  };
}

/**
 * 대상 메서드에 등록된 Trace 옵션을 조회합니다.
 */
export function getTraceOptions(
  _target: unknown,
  _propertyKey: string | symbol,
): TraceDecoratorOptions | undefined {
  if (typeof _target !== "object" || _target === null) {
    return undefined;
  }

  const target = _target as object;
  const own = traceOptionsStore.get(target)?.get(_propertyKey);
  if (own) {
    return cloneOptions(own);
  }

  const prototype = Object.getPrototypeOf(target);
  if (!prototype || typeof prototype !== "object") {
    return undefined;
  }

  const inherited = traceOptionsStore.get(prototype as object)?.get(_propertyKey);
  return inherited ? cloneOptions(inherited) : undefined;
}
