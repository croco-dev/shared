import { createLambdaHost } from "@croco/preset-lambda";
import type { LambdaHost } from "@croco/preset-lambda";
import { TelemetryForceFlushUnsupportedProblem, TelemetryRuntime } from "@croco/telemetry-sdk-node";
import { createCrocoApp } from "./app";
import { createTelemetryConfig, readEnv } from "./env";

const telemetry = TelemetryRuntime.getInstance();
const env = readEnv();
const telemetryReady = telemetry.init(createTelemetryConfig({ ...env, NODE_ENV: "production" }));
const app = createCrocoApp();
const lambdaHost = createLambdaHost(app.getHono(), {
  flush: async () => {
    const flush = await telemetry.forceFlush();
    if (flush.outcome === "failed") {
      throw flush.error;
    }
    if (flush.outcome === "unsupported") {
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
