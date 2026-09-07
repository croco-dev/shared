import { RateLimitExceededProblem } from "../problems/RateLimitExceededProblem";
import type { RateLimiter } from "../RateLimiter";
import type { KeyContext } from "../RateLimitKeyBuilder";
import type { RateLimitPolicy } from "../types";

export const RATE_LIMIT_METADATA_KEY = Symbol("rateLimit");
export const ROUTE_GUARDS_METADATA_KEY = Symbol.for("croco:rest:guards");

export type RateLimitMetadata = {
  policy: RateLimitPolicy;
  customKey?: (context: unknown) => string;
};

export type GuardContext = KeyContext & {
  set<T>(key: string, value: T): void;
} & (
    | { getHandler(): (...args: unknown[]) => unknown }
    | {
        getClass(): { prototype: object };
        getHandler(): string | symbol;
      }
  );

export class RateLimitGuard {
  constructor(private readonly rateLimiter: RateLimiter) {}

  async canActivate(context: GuardContext): Promise<boolean> {
    const handler = context.getHandler();
    const target =
      typeof handler !== "function" && "getClass" in context
        ? Reflect.get(context.getClass().prototype, handler)
        : handler;
    const metadata = Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, target) as
      | RateLimitMetadata
      | undefined;

    if (!metadata) {
      return true;
    }

    const result = await this.rateLimiter.check(context, metadata.policy);

    context.set("rateLimitResult", result);

    if (!result.success) {
      throw new RateLimitExceededProblem(result);
    }

    return true;
  }
}
