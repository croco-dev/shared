import type {
  LambdaContext,
  LambdaEvent,
  LambdaHandler,
  LambdaHandlerOptions as TransportLambdaHandlerOptions,
  LambdaResponse,
} from "@croco/transports-http";
import { CrocoLambdaAdapter } from "@croco/transports-http";
import { Hono } from "hono";

export type LambdaHandlerOptions = TransportLambdaHandlerOptions;
export type { LambdaContext, LambdaEvent, LambdaHandler, LambdaResponse };
export type LambdaHost = LambdaHandler;

export function createLambdaHost(
  honoApp: Hono | { readonly fetch: (req: Request) => Promise<Response> },
  options: LambdaHandlerOptions = {},
): LambdaHandler {
  if (honoApp instanceof Hono) {
    return new CrocoLambdaAdapter(honoApp).createHandler(options);
  }

  const hono = new Hono();
  hono.all("/*", (c) => honoApp.fetch(c.req.raw));

  return new CrocoLambdaAdapter(hono).createHandler(options);
}

/** @deprecated Use `createLambdaHost`. */
export const createLambdaHandler = createLambdaHost;
