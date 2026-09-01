import { createLambdaHost } from "@croco/preset-lambda";
import type { LambdaHost } from "@croco/preset-lambda";
import { TelemetryForceFlushUnsupportedProblem } from "@croco/telemetry-sdk-node";
import { createCrocoApp } from "./app";
import { telemetry, telemetryReady } from "./telemetry";

const app = createCrocoApp();
const lambdaHost = createLambdaHost(app.getHono(), {
  flush: async () => {
    const result = await telemetry.forceFlush();
    if (result.outcome === "failed") {
      throw result.error;
    }
    if (result.outcome === "unsupported") {
      throw new TelemetryForceFlushUnsupportedProblem();
    }
  },
});

const telemetryAwareLambdaHost: LambdaHost = async (event, context) => {
  await telemetryReady;
  return lambdaHost(event, context);
};

export const handler: LambdaHost =
  app.applicationRuntime.bindHostCallback(telemetryAwareLambdaHost);
