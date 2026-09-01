import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeHostLifecycleProblem } from "../problems";

const lifecycle = vi.hoisted(() => ({
  disposeApplicationRuntime: vi.fn(),
  forceFlush: vi.fn(),
  hostClose: vi.fn(),
  hostStart: vi.fn(),
  telemetryInit: vi.fn(),
  telemetryShutdown: vi.fn(),
}));

vi.mock("@croco/preset-node", () => ({
  createNodeHost: () => ({
    close: lifecycle.hostClose,
    start: lifecycle.hostStart,
  }),
}));

vi.mock("@croco/telemetry-sdk-node", () => ({
  TelemetryRuntime: {
    getInstance: () => ({
      forceFlush: lifecycle.forceFlush,
      init: lifecycle.telemetryInit,
      shutdown: lifecycle.telemetryShutdown,
    }),
  },
}));

vi.mock("../app", () => ({
  createCrocoApp: () => ({
    disposeApplicationRuntime: lifecycle.disposeApplicationRuntime,
    getHono: () => ({ fetch: vi.fn() }),
  }),
}));

vi.mock("../env", () => ({
  createTelemetryConfig: () => ({}),
  readEnv: () => ({ PORT: 3000 }),
}));

import { startNodeApplication } from "../index";

describe("Node application lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.forceFlush.mockResolvedValue({ outcome: "completed", flushedSpans: -1 });
    lifecycle.hostClose.mockResolvedValue(undefined);
    lifecycle.hostStart.mockResolvedValue(undefined);
    lifecycle.telemetryInit.mockResolvedValue(undefined);
    lifecycle.telemetryShutdown.mockResolvedValue({ outcome: "completed" });
    lifecycle.disposeApplicationRuntime.mockResolvedValue(undefined);
  });

  it("preserves a host start failure when cleanup also fails", async () => {
    const hostFailure = new Error("port already in use");
    const cleanupFailure = new Error("telemetry flush failed");
    lifecycle.hostStart.mockRejectedValue(hostFailure);
    lifecycle.forceFlush.mockRejectedValue(cleanupFailure);

    const failure = await startNodeApplication().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(NodeHostLifecycleProblem);
    expect(failure).toMatchObject({
      cause: hostFailure,
      code: "starter/node-host-lifecycle-failed",
      extensions: {
        operation: "start",
        hostFailure: "Error: port already in use",
        cleanupFailures: [
          { phase: "telemetry-force-flush", detail: "Error: telemetry flush failed" },
        ],
      },
    });
    expect(lifecycle.telemetryShutdown).toHaveBeenCalledOnce();
    expect(lifecycle.disposeApplicationRuntime).toHaveBeenCalledOnce();
  });

  it("preserves a host close failure when cleanup also fails", async () => {
    const hostFailure = new Error("server close failed");
    const cleanupFailure = new Error("telemetry shutdown failed");
    lifecycle.hostClose.mockRejectedValue(hostFailure);
    lifecycle.telemetryShutdown.mockRejectedValue(cleanupFailure);
    const running = await startNodeApplication();

    const failure = await running.close().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(NodeHostLifecycleProblem);
    expect(failure).toMatchObject({
      cause: hostFailure,
      code: "starter/node-host-lifecycle-failed",
      extensions: {
        operation: "close",
        hostFailure: "Error: server close failed",
        cleanupFailures: [
          { phase: "telemetry-shutdown", detail: "Error: telemetry shutdown failed" },
        ],
      },
    });
    expect(lifecycle.disposeApplicationRuntime).toHaveBeenCalledOnce();
  });
});
