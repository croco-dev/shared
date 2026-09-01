import { type CrocoBuildTarget, defineCrocoBuildTarget } from "@croco/framework-preset";

export function createNodeBuildTarget(): CrocoBuildTarget {
  return defineCrocoBuildTarget({
    name: "node",
    entry: "./entry.js",
    output: {
      dir: "dist",
      format: "dual",
    },
    hooks: {
      "dev:start": async () => {
        console.log("[node-build-target] Dev server starting...");
      },
    },
  });
}

/** @deprecated Use `createNodeBuildTarget`. */
export const createNodeServerPreset = createNodeBuildTarget;

export type { NodeEntry, NodeEntryOptions, NodeHost, NodeHostOptions } from "./entry";
export { createNodeEntry, createNodeHost } from "./entry";
export {
  NodeEntryCloseTimeoutProblem,
  NodeEntryLifecycleIoProblem,
  NodeEntryLifecycleProblem,
} from "./problems";
export type {
  CrocoBuildTarget,
  CrocoBuildTargetConfig,
  CrocoPreset,
  CrocoPresetConfig,
} from "@croco/framework-preset";
