import { TelemetryRuntime } from "@croco/telemetry-sdk-node";
import { createNodeHost } from "@croco/preset-node";
import type { NodeHost, NodeHostOptions } from "@croco/preset-node";
import { createCrocoApp } from "./app";
import type { RuntimeOwnedCrocoApp } from "./app";
import { createTelemetryConfig, readEnv } from "./env";

const telemetry = TelemetryRuntime.getInstance();

export type RunningNodeApplication = {
  readonly app: RuntimeOwnedCrocoApp;
  readonly host: NodeHost;
  readonly close: () => Promise<void>;
};

export async function startNodeApplication(
  options: NodeHostOptions = {},
): Promise<RunningNodeApplication> {
  const env = readEnv();
  await telemetry.init(createTelemetryConfig(env));

  const app = createCrocoApp();
  const host = createNodeHost(app.getHono(), { port: env.PORT, ...options });
  try {
    await host.start();
  } catch (error) {
    await app.disposeApplicationRuntime();
    throw error;
  }

  let closePromise: Promise<void> | undefined;

  return {
    app,
    host,
    close: () => {
      closePromise ??= (async () => {
        try {
          await host.close();
        } finally {
          await app.disposeApplicationRuntime();
        }
      })();

      return closePromise;
    },
  };
}

function reportFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const running = await startNodeApplication();
  const shutdown = () => {
    void running.close().catch(reportFatal);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) {
  void main().catch(reportFatal);
}
