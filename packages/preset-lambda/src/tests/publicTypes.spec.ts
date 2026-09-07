import type { Hono } from "hono";
import { describe, expectTypeOf, it } from "vitest";

import type {
  LambdaHandler,
  LambdaHandlerOptions,
  LambdaFetchApplication,
  LambdaHost,
  createLambdaBuildTarget,
  createLambdaHandler,
  createLambdaHost,
  createLambdaPreset,
} from "../index";

type LambdaApp = Hono | LambdaFetchApplication;

describe("public types", () => {
  it("does not expose no-op Lambda preset options", () => {
    expectTypeOf<typeof createLambdaBuildTarget>().parameters.toEqualTypeOf<[]>();
    expectTypeOf<typeof createLambdaPreset>().parameters.toEqualTypeOf<[]>();
  });

  it("exposes the transport Lambda handler options", () => {
    expectTypeOf<typeof createLambdaHost>().parameters.toEqualTypeOf<
      [LambdaApp, LambdaHandlerOptions?]
    >();
    expectTypeOf<typeof createLambdaHost>().returns.toEqualTypeOf<LambdaHost>();
    expectTypeOf<typeof createLambdaHandler>().parameters.toEqualTypeOf<
      [LambdaApp, LambdaHandlerOptions?]
    >();
    expectTypeOf<typeof createLambdaHandler>().returns.toEqualTypeOf<LambdaHandler>();
  });
});
