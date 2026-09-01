import { TelemetryRuntime } from "@croco/telemetry-sdk-node";

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

export const telemetry = TelemetryRuntime.getInstance();
export const telemetryReady = telemetry.init({
  serviceName: "saas-api-server",
  environment: process.env.NODE_ENV ?? "development",
  enabled: process.env.TELEMETRY_ENABLED !== "false",
  trace: {
    enabled: process.env.TELEMETRY_ENABLED === "true" || otlpEndpoint !== undefined,
    exporterUrl: otlpEndpoint,
  },
});
