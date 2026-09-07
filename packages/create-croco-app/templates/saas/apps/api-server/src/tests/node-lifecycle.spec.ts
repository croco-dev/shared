import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeHostLifecycleProblem } from "../problems";

const lifecycle = vi.hoisted(() => ({
  createCrocoApp: vi.fn(),
  disposeApplicationRuntime: vi.fn(),
  forceFlush: vi.fn(),
  hostClose: vi.fn(),
  hostStart: vi.fn(),
  telemetryShutdown: vi.fn(),
}));

vi.mock("@croco/preset-node", () => ({
  createNodeHost: () => ({
    close: lifecycle.hostClose,
    start: lifecycle.hostStart,
  }),
}));

vi.mock("../app", () => ({
  createCrocoApp: lifecycle.createCrocoApp,
}));

vi.mock("@croco/telemetry-sdk-node", () => ({
  TELEMETRY_RUNTIME_TOKEN: Symbol("telemetry-runtime"),
}));

import { startNodeApplication } from "../index";

describe("Node application lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.forceFlush.mockResolvedValue({ outcome: "completed", flushedSpans: -1 });
    lifecycle.hostClose.mockResolvedValue(undefined);
    lifecycle.hostStart.mockResolvedValue(undefined);
    lifecycle.telemetryShutdown.mockResolvedValue({ outcome: "completed" });
    lifecycle.disposeApplicationRuntime.mockResolvedValue(undefined);
    lifecycle.createCrocoApp.mockResolvedValue({
      applicationRuntime: {
        get: () => ({
          forceFlush: lifecycle.forceFlush,
          shutdown: lifecycle.telemetryShutdown,
        }),
      },
      disposeApplicationRuntime: lifecycle.disposeApplicationRuntime,
      getHono: () => ({ fetch: vi.fn() }),
    });
  });

  it("waits for the production application before starting the host", async () => {
    const app = await lifecycle.createCrocoApp();
    lifecycle.createCrocoApp.mockClear();
    let resolveApplication: (value: typeof app) => void = () => undefined;
    lifecycle.createCrocoApp.mockReturnValue(
      new Promise((resolve) => {
        resolveApplication = resolve;
      }),
    );

    const starting = startNodeApplication();
    await Promise.resolve();

    expect(lifecycle.createCrocoApp).toHaveBeenCalledWith({
      profileMode: "production",
      hostPlatform: "node",
    });
    expect(lifecycle.hostStart).not.toHaveBeenCalled();
    resolveApplication(app);
    const running = await starting;
    expect(lifecycle.hostStart).toHaveBeenCalledOnce();
    await running.close();
  });

  it("preserves asynchronous bootstrap failure without starting the host", async () => {
    const failure = new Error("provider initialization failed");
    lifecycle.createCrocoApp.mockRejectedValue(failure);

    await expect(startNodeApplication()).rejects.toBe(failure);
    expect(lifecycle.hostStart).not.toHaveBeenCalled();
    expect(lifecycle.forceFlush).not.toHaveBeenCalled();
    expect(lifecycle.disposeApplicationRuntime).not.toHaveBeenCalled();
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
      code: "saas-demo/node-host-lifecycle-failed",
      extensions: {
        operation: "start",
        hostFailure: "Error: port already in use",
        cleanupFailures: [
          { phase: "telemetry-force-flush", detail: "Error: telemetry flush failed" },
        ],
      },
    });
    expect(lifecycle.telemetryShutdown).not.toHaveBeenCalled();
    expect(lifecycle.disposeApplicationRuntime).toHaveBeenCalledOnce();
  });

  it("closes the host and runtime once, leaving telemetry shutdown to its plugin owner", async () => {
    const running = await startNodeApplication();

    await Promise.all([running.close(), running.close()]);

    expect(lifecycle.hostClose).toHaveBeenCalledOnce();
    expect(lifecycle.forceFlush).toHaveBeenCalledOnce();
    expect(lifecycle.telemetryShutdown).not.toHaveBeenCalled();
    expect(lifecycle.disposeApplicationRuntime).toHaveBeenCalledOnce();
  });

  it("preserves a host close failure when cleanup also fails", async () => {
    const hostFailure = new Error("server close failed");
    const cleanupFailure = new Error("runtime disposal failed");
    lifecycle.hostClose.mockRejectedValue(hostFailure);
    lifecycle.disposeApplicationRuntime.mockRejectedValue(cleanupFailure);
    const running = await startNodeApplication();

    const failure = await running.close().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(NodeHostLifecycleProblem);
    expect(failure).toMatchObject({
      cause: hostFailure,
      code: "saas-demo/node-host-lifecycle-failed",
      extensions: {
        operation: "close",
        hostFailure: "Error: server close failed",
        cleanupFailures: [
          { phase: "application-runtime-dispose", detail: "Error: runtime disposal failed" },
        ],
      },
    });
    expect(lifecycle.disposeApplicationRuntime).toHaveBeenCalledOnce();
  });
});
