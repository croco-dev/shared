import { createApplicationRuntime } from "@croco/framework-module";
import { createCloudflareWorkersHost } from "@croco/preset-cloudflare";
import {
  createSlidingWindowPolicy,
  RateLimiter,
  RateLimitKeyBuilder,
  SlidingWindowInMemoryStore,
} from "@croco/ratelimit-core";
import {
  bodyLimitMiddleware,
  corsMiddleware,
  createApp,
  createRuntimeAwareRateLimitClientIdentityPolicy,
  mb,
  rateLimitHttpMiddleware,
  securityHeadersMiddleware,
} from "@croco/transports-http";

const DEFAULT_WEB_ORIGIN = "http://localhost:5173";
const OPERATIONAL_RATE_LIMIT_BYPASS_PATHS = new Set([
  "/health",
  "/health/live",
  "/health/ready",
  "/ready",
]);

// Cloudflare Workers isolates do not share in-memory state. Replace this with a Durable Objects or KV-backed
// store before relying on rate limits for production-wide enforcement.
const rateLimiter = new RateLimiter(
  new SlidingWindowInMemoryStore(),
  new RateLimitKeyBuilder(["ip"]),
);

type ApiWorkerEnv = Record<string, unknown> & {
  WEB_ORIGIN?: string;
};

type ApiWorkerHandler = ReturnType<typeof createCloudflareWorkersHost>;

let cachedWebOrigin: string | undefined;
let cachedHandler: ApiWorkerHandler | undefined;
const applicationRuntime = createApplicationRuntime();

function getWebOrigin(env: ApiWorkerEnv): string {
  return typeof env.WEB_ORIGIN === "string" && env.WEB_ORIGIN.length > 0
    ? env.WEB_ORIGIN
    : DEFAULT_WEB_ORIGIN;
}

function getApiWorkerHandler(env: ApiWorkerEnv): ApiWorkerHandler {
  const webOrigin = getWebOrigin(env);

  if (cachedHandler && cachedWebOrigin === webOrigin) {
    return cachedHandler;
  }

  const app = applicationRuntime.run(() =>
    createApp({
      controllers: [],
      middlewares: [
        securityHeadersMiddleware(),
        corsMiddleware({ origins: [webOrigin] }),
        bodyLimitMiddleware({ limit: mb(1) }),
        rateLimitHttpMiddleware({
          rateLimiter,
          policy: createSlidingWindowPolicy("api", 100, 60_000),
          clientIdentity: createRuntimeAwareRateLimitClientIdentityPolicy({
            trustedProxyHeaders: ["x-forwarded-for"],
          }),
          skip: (ctx) => OPERATIONAL_RATE_LIMIT_BYPASS_PATHS.has(ctx.req.path),
        }),
      ],
    }),
  );

  cachedWebOrigin = webOrigin;
  cachedHandler = applicationRuntime.bindHostCallback(createCloudflareWorkersHost(app));
  return cachedHandler;
}

const worker: ExportedHandler<ApiWorkerEnv> = {
  fetch(request, env, ctx) {
    return getApiWorkerHandler(env)(request, env, ctx);
  },
};

export default worker;
