import { EventEmitter } from "node:events";
import { serve } from "@hono/node-server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNodeBuildTarget,
  createNodeEntry,
  createNodeHost,
  createNodeServerPreset,
} from "../index";

vi.mock("@hono/node-server", () => ({
  serve: vi.fn((_options, callback?: () => void) => {
    callback?.();

    const server = new EventEmitter();
    return Object.assign(server, {
      close: vi.fn((closeCallback?: (error?: Error) => void) => closeCallback?.()),
    });
  }),
}));

function createTestServer(close = vi.fn((callback?: (error?: Error) => void) => callback?.())) {
  return Object.assign(new EventEmitter(), { close }) as unknown as ReturnType<typeof serve>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createNodeServerPreset", () => {
  it("exposes separate canonical host and build-target entry points", () => {
    expect(createNodeServerPreset).toBe(createNodeBuildTarget);
    expect(createNodeEntry).toBe(createNodeHost);
  });

  it("returns a node preset", () => {
    const preset = createNodeServerPreset();

    expect(preset.name).toBe("node");
    expect(preset.config.name).toBe("node");
  });

  it("uses the Node entry point", () => {
    const preset = createNodeServerPreset();

    expect(preset.config.entry).toBe("./entry.js");
  });
});

describe("createNodeEntry", () => {
  it("creates a server lifecycle object", () => {
    const entry = createNodeEntry({ fetch: vi.fn() });

    expect(entry.server).toBeNull();
    expect(typeof entry.start).toBe("function");
    expect(typeof entry.close).toBe("function");
  });

  it("starts the server with node server options", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const entry = createNodeEntry({ fetch }, { port: 0, hostname: "127.0.0.1" });

    await entry.start();

    expect(serve).toHaveBeenCalledWith(
      {
        fetch,
        port: 0,
        hostname: "127.0.0.1",
      },
      expect.any(Function),
    );
    expect(entry.server).toBeDefined();
  });

  it("uses default node server options", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const entry = createNodeEntry({ fetch });

    await entry.start();

    expect(serve).toHaveBeenCalledWith(
      {
        fetch,
        port: 3000,
        hostname: "0.0.0.0",
      },
      expect.any(Function),
    );
  });

  it("closes the server lifecycle object", async () => {
    const close = vi.fn((callback?: () => void) => callback?.());
    vi.mocked(serve).mockImplementationOnce((_options, callback) => {
      callback?.({ address: "127.0.0.1", family: "IPv4", port: 3000 });

      return createTestServer(close);
    });
    const entry = createNodeEntry({ fetch: vi.fn(async () => new Response("ok")) });

    await entry.start();
    await entry.close();

    expect(close).toHaveBeenCalledWith(expect.any(Function));
    expect(entry.server).toBeNull();
  });

  it("shares one in-flight start and keeps repeated starts idempotent", async () => {
    let finishStart: (() => void) | undefined;
    const server = createTestServer();
    vi.mocked(serve).mockImplementationOnce((_options, callback) => {
      finishStart = () => callback?.({ address: "127.0.0.1", family: "IPv4", port: 3000 });
      return server;
    });
    const entry = createNodeEntry({ fetch: vi.fn() });

    const first = entry.start();
    const second = entry.start();

    expect(second).toBe(first);
    expect(serve).toHaveBeenCalledTimes(1);
    finishStart?.();
    await first;
    await entry.start();
    expect(serve).toHaveBeenCalledTimes(1);
    await entry.close();
  });

  it("allows retry after a startup failure", async () => {
    const failedServer = createTestServer();
    const startedServer = createTestServer();
    vi.mocked(serve)
      .mockImplementationOnce(() => failedServer)
      .mockImplementationOnce((_options, callback) => {
        callback?.({ address: "127.0.0.1", family: "IPv4", port: 3000 });
        return startedServer;
      });
    const entry = createNodeEntry({ fetch: vi.fn() });

    const failedStart = entry.start();
    const cause = new Error("address unavailable");
    failedServer.emit("error", cause);

    await expect(failedStart).rejects.toMatchObject({
      code: "preset-node/lifecycle-io-failed",
      cause,
      extensions: { operation: "start" },
    });
    expect(entry.server).toBeNull();
    await expect(entry.start()).resolves.toBeUndefined();
    expect(entry.server).toBe(startedServer);
    expect(serve).toHaveBeenCalledTimes(2);
    await entry.close();
  });

  it("maps synchronous server startup failures to a lifecycle I/O Problem", async () => {
    const cause = new Error("serve failed");
    vi.mocked(serve).mockImplementationOnce(() => {
      throw cause;
    });
    const entry = createNodeEntry({ fetch: vi.fn() });

    await expect(entry.start()).rejects.toMatchObject({
      code: "preset-node/lifecycle-io-failed",
      cause,
      extensions: { operation: "start" },
    });
    expect(entry.server).toBeNull();
  });

  it("waits for startup before sharing one close and rejects start after close begins", async () => {
    let finishStart: (() => void) | undefined;
    const close = vi.fn((callback?: (error?: Error) => void) => callback?.());
    const server = createTestServer(close);
    vi.mocked(serve).mockImplementationOnce((_options, callback) => {
      finishStart = () => callback?.({ address: "127.0.0.1", family: "IPv4", port: 3000 });
      return server;
    });
    const entry = createNodeEntry({ fetch: vi.fn() });

    const start = entry.start();
    const firstClose = entry.close();
    const secondClose = entry.close();

    expect(secondClose).toBe(firstClose);
    expect(close).not.toHaveBeenCalled();
    await expect(entry.start()).rejects.toMatchObject({
      code: "preset-node/lifecycle-conflict",
      extensions: { operation: "start", state: "closing" },
    });

    finishStart?.();
    await start;
    await firstClose;

    expect(close).toHaveBeenCalledTimes(1);
    expect(entry.server).toBeNull();
    await expect(entry.start()).rejects.toMatchObject({
      code: "preset-node/lifecycle-conflict",
      extensions: { operation: "start", state: "closed" },
    });
  });

  it("keeps start fenced after close fails and allows close to be retried", async () => {
    const cause = new Error("server was already stopped");
    const close = vi
      .fn<(callback?: (error?: Error) => void) => void>()
      .mockImplementationOnce((callback) => callback?.(cause))
      .mockImplementationOnce((callback) => callback?.());
    const server = createTestServer(close);
    vi.mocked(serve).mockImplementationOnce((_options, callback) => {
      callback?.({ address: "127.0.0.1", family: "IPv4", port: 3000 });
      return server;
    });
    const entry = createNodeEntry({ fetch: vi.fn() });

    await entry.start();
    await expect(entry.close()).rejects.toMatchObject({
      code: "preset-node/lifecycle-io-failed",
      cause,
      extensions: { operation: "close" },
    });
    await expect(entry.start()).rejects.toMatchObject({
      code: "preset-node/lifecycle-conflict",
      extensions: { operation: "start", state: "closing" },
    });
    await expect(entry.close()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(2);
    expect(entry.server).toBeNull();
  });

  it("maps synchronous server close failures and allows close to be retried", async () => {
    const cause = new Error("close failed");
    const close = vi
      .fn<(callback?: (error?: Error) => void) => void>()
      .mockImplementationOnce(() => {
        throw cause;
      })
      .mockImplementationOnce((callback) => callback?.());
    const server = createTestServer(close);
    vi.mocked(serve).mockImplementationOnce((_options, callback) => {
      callback?.({ address: "127.0.0.1", family: "IPv4", port: 3000 });
      return server;
    });
    const entry = createNodeEntry({ fetch: vi.fn() });

    await entry.start();
    await expect(entry.close()).rejects.toMatchObject({
      code: "preset-node/lifecycle-io-failed",
      cause,
      extensions: { operation: "close" },
    });
    await expect(entry.start()).rejects.toMatchObject({
      code: "preset-node/lifecycle-conflict",
      extensions: { operation: "start", state: "closing" },
    });
    await expect(entry.close()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(2);
    expect(entry.server).toBeNull();
  });

  it("times out a stalled close while preserving the lifecycle fence", async () => {
    vi.useFakeTimers();
    let finishClose: (() => void) | undefined;
    const close = vi.fn((callback?: (error?: Error) => void) => {
      finishClose = () => callback?.();
    });
    const server = createTestServer(close);
    vi.mocked(serve).mockImplementationOnce((_options, callback) => {
      callback?.({ address: "127.0.0.1", family: "IPv4", port: 3000 });
      return server;
    });
    const entry = createNodeEntry({ fetch: vi.fn() });

    try {
      await entry.start();
      const stalledClose = entry.close(50);
      const stalledCloseResult = expect(stalledClose).rejects.toMatchObject({
        code: "preset-node/lifecycle-io-failed",
        cause: expect.objectContaining({ message: "Node server close timed out after 50ms." }),
        extensions: { operation: "close" },
      });

      await vi.advanceTimersByTimeAsync(50);
      await stalledCloseResult;
      await expect(entry.start()).rejects.toMatchObject({
        code: "preset-node/lifecycle-conflict",
        extensions: { operation: "start", state: "closing" },
      });

      const retriedClose = entry.close(100);
      expect(close).toHaveBeenCalledTimes(1);
      finishClose?.();
      await expect(retriedClose).resolves.toBeUndefined();
      expect(entry.server).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an invalid close timeout without changing lifecycle state", async () => {
    const close = vi.fn((callback?: (error?: Error) => void) => callback?.());
    const server = createTestServer(close);
    vi.mocked(serve).mockImplementationOnce((_options, callback) => {
      callback?.({ address: "127.0.0.1", family: "IPv4", port: 3000 });
      return server;
    });
    const entry = createNodeEntry({ fetch: vi.fn() });

    await entry.start();
    await expect(entry.close(0)).rejects.toMatchObject({
      code: "preset-node/invalid-close-timeout",
      status: 400,
      extensions: { timeoutMs: 0 },
    });
    await expect(entry.start()).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    await expect(entry.close()).resolves.toBeUndefined();
    await expect(entry.close(0)).rejects.toMatchObject({
      code: "preset-node/invalid-close-timeout",
      status: 400,
      extensions: { timeoutMs: 0 },
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(entry.server).toBeNull();
  });

  it("rejects an invalid close timeout while idle without fencing start", async () => {
    const entry = createNodeEntry({ fetch: vi.fn() });

    await expect(entry.close(0)).rejects.toMatchObject({
      code: "preset-node/invalid-close-timeout",
      status: 400,
      extensions: { timeoutMs: 0 },
    });
    await expect(entry.start()).resolves.toBeUndefined();
    await entry.close();
  });
});
