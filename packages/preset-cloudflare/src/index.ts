import { type CrocoBuildTarget, defineCrocoBuildTarget } from "@croco/framework-preset";

export type CloudflareBuildTargetOptions = {
  readonly name?: string;
  readonly entry?: string;
};

/** @deprecated Use `CloudflareBuildTargetOptions`. */
export type CloudflarePresetOptions = CloudflareBuildTargetOptions;

export function createCloudflareBuildTarget(
  options?: CloudflareBuildTargetOptions,
): CrocoBuildTarget {
  return defineCrocoBuildTarget({
    name: options?.name ?? "cloudflare",
    entry: options?.entry ?? "./fetch.js",
    output: {
      dir: "dist",
      format: "esm",
    },
    hooks: {
      "build:before": (config) => {
        console.log("[cloudflare-build-target] Building for Cloudflare Workers (1MB limit)");
        return config;
      },
    },
  });
}

/** @deprecated Use `createCloudflareBuildTarget`. */
export const createCloudflarePreset = createCloudflareBuildTarget;

export type {
  CloudflareAppFetch,
  CloudflareFetchEnv,
  CloudflareFetchHandler,
  CloudflareRuntimeContext,
  RawHonoFetch,
  WorkerFetchHandlerOptions,
} from "./fetch";
export {
  createCloudflareWorkersHost,
  createRawHonoWorkerFetchHandler,
  createWorkerFetchHandler,
} from "./fetch";
