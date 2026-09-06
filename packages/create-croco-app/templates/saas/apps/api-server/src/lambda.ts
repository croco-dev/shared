import { createLambdaHost } from "@croco/preset-lambda";
import type { LambdaHost } from "@croco/preset-lambda";
import {
  TELEMETRY_RUNTIME_TOKEN,
  TelemetryForceFlushUnsupportedProblem,
} from "@croco/telemetry-sdk-node";
import { createCrocoApp } from "./app";

async function initializeLambdaHost(): Promise<LambdaHost> {
  const app = await createCrocoApp({ hostPlatform: "lambda" });
  const telemetry = app.applicationRuntime.get(TELEMETRY_RUNTIME_TOKEN);
  return app.applicationRuntime.bindHostCallback(
    createLambdaHost(app.getHono(), {
      flush: async () => {
        const result = await telemetry.forceFlush();
        if (result.outcome === "failed") {
          throw result.error;
        }
        if (result.outcome === "unsupported") {
          throw new TelemetryForceFlushUnsupportedProblem();
        }
      },
    }),
  );
}

let hostReady: Promise<LambdaHost> | undefined;

export const handler: LambdaHost = async (event, context) => {
  hostReady ??= initializeLambdaHost();
  const lambdaHost = await hostReady;
  return lambdaHost(event, context);
};
