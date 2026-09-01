import { createNodeHost } from "@croco/preset-node";
import type { NodeHost, NodeHostOptions } from "@croco/preset-node";
import { createCrocoApp } from "./app";
import type { RuntimeOwnedCrocoApp } from "./app";
import {
  ApplicationCleanupProblem,
  InvalidPortProblem,
  NodeHostLifecycleProblem,
} from "./problems";
import type { ApplicationCleanupFailure } from "./problems";
import { telemetry, telemetryReady } from "./telemetry";

export type RunningNodeApplication = {
  readonly app: RuntimeOwnedCrocoApp;
  readonly host: NodeHost;
  readonly close: () => Promise<void>;
};

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidPortProblem(value);
  }

  return port;
}

async function shutdownApplication(app: RuntimeOwnedCrocoApp): Promise<void> {
  const cleanupFailures: ApplicationCleanupFailure[] = [];

  try {
    const flush = await telemetry.forceFlush();
    if (flush.outcome === "failed") {
      cleanupFailures.push({ phase: "telemetry-force-flush", cause: flush.error });
    }
  } catch (cause) {
    cleanupFailures.push({ phase: "telemetry-force-flush", cause });
  }

  try {
    await telemetry.shutdown();
  } catch (cause) {
    cleanupFailures.push({ phase: "telemetry-shutdown", cause });
  }

  try {
    await app.disposeApplicationRuntime();
  } catch (cause) {
    cleanupFailures.push({ phase: "application-runtime-dispose", cause });
  }

  if (cleanupFailures.length > 0) {
    throw new ApplicationCleanupProblem(cleanupFailures);
  }
}

async function rethrowHostFailureAfterCleanup(
  operation: "start" | "close",
  hostFailure: unknown,
  app: RuntimeOwnedCrocoApp,
): Promise<never> {
  try {
    await shutdownApplication(app);
  } catch (cleanupFailure) {
    throw new NodeHostLifecycleProblem(operation, hostFailure, cleanupFailure);
  }

  throw hostFailure;
}

export async function startNodeApplication(
  options: NodeHostOptions = {},
): Promise<RunningNodeApplication> {
  await telemetryReady;
  const port = parsePort(process.env.PORT);
  const app = await createCrocoApp({ profileMode: "production", hostPlatform: "node" });
  const host = createNodeHost(app.getHono(), { port, ...options });
  try {
    await host.start();
  } catch (error) {
    await rethrowHostFailureAfterCleanup("start", error, app);
  }

  let closePromise: Promise<void> | undefined;

  return {
    app,
    host,
    close: () => {
      closePromise ??= (async () => {
        try {
          await host.close();
        } catch (error) {
          await rethrowHostFailureAfterCleanup("close", error, app);
        }

        await shutdownApplication(app);
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
