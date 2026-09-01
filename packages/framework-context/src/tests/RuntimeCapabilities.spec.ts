import { describe, expect, it } from "vitest";

import {
  checkRuntimeCapabilityRequirements,
  createRuntimeCapabilityManifest,
  getRuntimeCapabilitySupport,
  isRuntimeCapabilitySupported,
  stringifyRuntimeCapabilityManifest,
  RUNTIME_CAPABILITY_MANIFEST_VERSION,
  RUNTIME_CAPABILITY_NAMES,
  RUNTIME_CAPABILITY_SUPPORT,
  RUNTIME_CAPABILITY_UNSUPPORTED_DIAGNOSTIC_CODE,
  RUNTIME_PLATFORMS,
} from "../index";

describe("runtime capabilities", () => {
  it("exposes the shared runtime and capability vocabulary", () => {
    expect(RUNTIME_PLATFORMS).toEqual(["node", "lambda", "cloudflare-workers"]);
    expect(RUNTIME_CAPABILITY_NAMES).toEqual([
      "env",
      "filesystem",
      "logger",
      "nodeApi",
      "requestLifecycle",
      "trace",
      "waitUntil",
      "flush",
      "streamingResponse",
      "deadline",
      "abortSignal",
      "shutdown",
    ]);
  });

  it("marks flush as Lambda-only in the shared support matrix", () => {
    expect(RUNTIME_CAPABILITY_SUPPORT.lambda.flush).toBe(true);
    expect(getRuntimeCapabilitySupport("cloudflare-workers").flush).toBe(false);
    expect(isRuntimeCapabilitySupported("node", "flush")).toBe(false);
    expect(
      isRuntimeCapabilitySupported("edge-runtime", "flush", {
        env: true,
        filesystem: false,
        logger: false,
        nodeApi: false,
        requestLifecycle: true,
        trace: false,
        waitUntil: false,
        flush: true,
        streamingResponse: false,
        deadline: false,
        abortSignal: false,
        shutdown: false,
      }),
    ).toBe(true);
  });

  it("marks Node-only platform APIs separately from request lifecycle support", () => {
    expect(RUNTIME_CAPABILITY_SUPPORT.node.filesystem).toBe(true);
    expect(RUNTIME_CAPABILITY_SUPPORT.node.nodeApi).toBe(true);
    expect(RUNTIME_CAPABILITY_SUPPORT.lambda.filesystem).toBe(true);
    expect(RUNTIME_CAPABILITY_SUPPORT.lambda.nodeApi).toBe(true);
    expect(RUNTIME_CAPABILITY_SUPPORT["cloudflare-workers"].filesystem).toBe(false);
    expect(RUNTIME_CAPABILITY_SUPPORT["cloudflare-workers"].nodeApi).toBe(false);
    expect(RUNTIME_CAPABILITY_SUPPORT["cloudflare-workers"].requestLifecycle).toBe(true);
  });

  it("emits deterministic RuntimeCapabilityManifest v1 artifacts", () => {
    const manifest = createRuntimeCapabilityManifest("lambda");

    expect(manifest).toEqual({
      version: RUNTIME_CAPABILITY_MANIFEST_VERSION,
      platform: "lambda",
      capabilities: {
        env: true,
        filesystem: true,
        logger: true,
        nodeApi: true,
        requestLifecycle: true,
        trace: true,
        waitUntil: true,
        flush: true,
        streamingResponse: false,
        deadline: true,
        abortSignal: false,
        shutdown: false,
      },
      diagnostics: [],
    });
    expect(stringifyRuntimeCapabilityManifest(manifest)).toBe(
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  });

  it("records host, transport, and build target as independent composition metadata", () => {
    const manifest = createRuntimeCapabilityManifest("lambda", {
      composition: {
        host: {
          platform: "lambda",
          lifecycle: "invocation",
          packageName: "@croco/preset-lambda",
        },
        transports: [
          {
            protocol: "rpc",
          },
          {
            protocol: "http",
            packageName: "@croco/transports-http",
          },
        ],
        buildTarget: {
          name: "lambda-function",
          format: "esm",
          packageName: "@croco/preset-lambda",
          constraints: ["zip-output", "single-entry"],
        },
      },
    });

    expect(manifest.composition).toEqual({
      host: {
        platform: "lambda",
        lifecycle: "invocation",
        packageName: "@croco/preset-lambda",
      },
      transports: [
        {
          protocol: "http",
          packageName: "@croco/transports-http",
        },
        {
          protocol: "rpc",
        },
      ],
      buildTarget: {
        name: "lambda-function",
        format: "esm",
        packageName: "@croco/preset-lambda",
        constraints: ["single-entry", "zip-output"],
      },
    });
  });

  it("reports unsupported runtime requirements with a stable CROCO diagnostic", () => {
    const manifest = createRuntimeCapabilityManifest("cloudflare-workers", {
      requirements: [
        {
          capability: "nodeApi",
          source: { file: "src/routes/admin.ts", symbol: "AdminController.export" },
        },
      ],
    });

    expect(manifest.diagnostics).toEqual([
      {
        code: RUNTIME_CAPABILITY_UNSUPPORTED_DIAGNOSTIC_CODE,
        severity: "error",
        platform: "cloudflare-workers",
        capability: "nodeApi",
        message: "Runtime platform 'cloudflare-workers' does not support capability 'nodeApi'.",
        source: { file: "src/routes/admin.ts", symbol: "AdminController.export" },
      },
    ]);
    expect(
      checkRuntimeCapabilityRequirements(manifest, [{ capability: "filesystem" }])[0]?.code,
    ).toBe(RUNTIME_CAPABILITY_UNSUPPORTED_DIAGNOSTIC_CODE);
  });
});
