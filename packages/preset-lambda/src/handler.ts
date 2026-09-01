import type {
  LambdaContext,
  LambdaEvent,
  LambdaHandler,
  LambdaHandlerOptions as TransportLambdaHandlerOptions,
  LambdaResponse,
  RuntimeContextInit,
} from "@croco/transports-http";
import { CrocoLambdaAdapter, getRuntimeContextInitFromEnv } from "@croco/transports-http";
import { Hono } from "hono";

export type LambdaHandlerOptions = TransportLambdaHandlerOptions;
export type { LambdaContext, LambdaEvent, LambdaHandler, LambdaResponse };
export type LambdaHost = LambdaHandler;
export type LambdaFetchApplication = {
  readonly fetch: (request: Request, runtimeContext?: RuntimeContextInit) => Promise<Response>;
};

export function createLambdaHost(
  honoApp: Hono | LambdaFetchApplication,
  options: LambdaHandlerOptions = {},
): LambdaHandler {
  if (honoApp instanceof Hono) {
    return new CrocoLambdaAdapter(honoApp).createHandler(options);
  }

  const hono = new Hono();
  hono.all("/*", (c) => honoApp.fetch(c.req.raw, getRuntimeContextInitFromEnv(c.env)));

  return new CrocoLambdaAdapter(hono).createHandler(options);
}

/** @deprecated Use `createLambdaHost`. */
export const createLambdaHandler = createLambdaHost;
