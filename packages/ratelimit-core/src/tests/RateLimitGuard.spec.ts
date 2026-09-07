import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GuardContext,
  RATE_LIMIT_METADATA_KEY,
  RateLimitGuard,
  type RateLimitMetadata,
} from "../libs/guards/RateLimitGuard";
import { RateLimit } from "../libs/decorators/RateLimit";
import { RateLimitExceededProblem } from "../libs/problems/RateLimitExceededProblem";
import type { RateLimiter } from "../libs/RateLimiter";
import type { RateLimitPolicy, RateLimitResult } from "../libs/types";

describe("RateLimitGuard", () => {
  let guard!: RateLimitGuard;
  let mockRateLimiter!: RateLimiter;

  const policy: RateLimitPolicy = {
    name: "test-policy",
    algorithm: "sliding",
    limit: 10,
    windowMs: 60000,
  };

  const successResult: RateLimitResult = {
    success: true,
    degraded: false,
    limit: 10,
    remaining: 9,
    resetAtMs: Date.now() + 60000,
  };

  const failedResult: RateLimitResult = {
    success: false,
    degraded: false,
    limit: 10,
    remaining: 0,
    resetAtMs: Date.now() + 60000,
  };

  const createContext = (handler: () => void, data: Record<string, unknown> = {}): GuardContext => {
    const store = new Map<string, unknown>();
    return {
      getHandler: () => handler,
      get: <T>(key: string): T | undefined => data[key] as T | undefined,
      set: <T>(key: string, value: T): void => {
        store.set(key, value);
      },
    };
  };

  beforeEach(() => {
    mockRateLimiter = {
      check: vi.fn().mockResolvedValue(successResult),
    } as unknown as RateLimiter;
    guard = new RateLimitGuard(mockRateLimiter);
  });

  it("should allow request when no metadata present", async () => {
    const handler = () => {};
    const context = createContext(handler);

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(mockRateLimiter.check).not.toHaveBeenCalled();
  });

  it("should allow request within rate limit", async () => {
    const handler = () => {};
    const metadata: RateLimitMetadata = { policy };
    Reflect.defineMetadata(RATE_LIMIT_METADATA_KEY, metadata, handler);
    const context = createContext(handler);

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(mockRateLimiter.check).toHaveBeenCalledWith(context, policy);
  });

  it("should throw RateLimitExceededProblem when limit exceeded", async () => {
    vi.mocked(mockRateLimiter.check).mockResolvedValue(failedResult);
    const handler = () => {};
    const metadata: RateLimitMetadata = { policy };
    Reflect.defineMetadata(RATE_LIMIT_METADATA_KEY, metadata, handler);
    const context = createContext(handler);

    await expect(guard.canActivate(context)).rejects.toThrow(RateLimitExceededProblem);
  });

  it("should store rate limit result in context", async () => {
    const handler = () => {};
    const metadata: RateLimitMetadata = { policy };
    Reflect.defineMetadata(RATE_LIMIT_METADATA_KEY, metadata, handler);

    const store = new Map<string, unknown>();
    const context: GuardContext = {
      getHandler: () => handler,
      get: () => undefined,
      set: <T>(key: string, value: T) => {
        store.set(key, value);
      },
    };

    await guard.canActivate(context);

    expect(store.get("rateLimitResult")).toEqual(successResult);
  });

  it.each(["limited", Symbol("limited")])("should resolve named handler %s", async (name) => {
    class Controller {
      @RateLimit({ limit: 1, window: "1m" })
      [name]() {}
    }
    const context = {
      ...createContext(() => {}),
      getClass: () => Controller,
      getHandler: () => name,
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockRateLimiter.check).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ limit: 1, windowMs: 60000 }),
    );
    vi.mocked(mockRateLimiter.check).mockResolvedValue(failedResult);
    await expect(guard.canActivate(context)).rejects.toThrow(RateLimitExceededProblem);
  });

  it("should use inherited metadata without applying it to an undecorated override", async () => {
    class Parent {
      @RateLimit({ limit: 1 })
      limited() {}
    }
    class Child extends Parent {}
    class Override extends Parent {
      override limited() {}
    }
    const context = {
      ...createContext(() => {}),
      getClass: () => Child,
      getHandler: () => "limited",
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockRateLimiter.check).toHaveBeenCalledOnce();
    vi.mocked(mockRateLimiter.check).mockClear();
    await expect(guard.canActivate({ ...context, getClass: () => Override })).resolves.toBe(true);
    expect(mockRateLimiter.check).not.toHaveBeenCalled();
  });

  it("should allow an undecorated named handler without consuming quota", async () => {
    class Controller {
      plain() {}
    }
    const context = {
      ...createContext(() => {}),
      getClass: () => Controller,
      getHandler: () => "plain",
    };
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockRateLimiter.check).not.toHaveBeenCalled();
  });

  it("should preserve function handlers on contexts that also expose a class", async () => {
    const handler = () => {};
    Reflect.defineMetadata(RATE_LIMIT_METADATA_KEY, { policy }, handler);
    const getClass = vi.fn(() => class Controller {});
    const context = { ...createContext(handler), getClass };
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockRateLimiter.check).toHaveBeenCalledWith(context, policy);
    expect(getClass).not.toHaveBeenCalled();
  });
});
