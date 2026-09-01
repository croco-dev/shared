import { type CrocoBuildTarget, defineCrocoBuildTarget } from "@croco/framework-preset";

export function createLambdaBuildTarget(): CrocoBuildTarget {
  return defineCrocoBuildTarget({
    name: "lambda",
    entry: "./handler.js",
    output: {
      dir: "dist",
      format: "esm",
    },
    hooks: {
      "build:after": async () => {
        console.log("[lambda-build-target] Build complete");
      },
    },
  });
}

/** @deprecated Use `createLambdaBuildTarget`. */
export const createLambdaPreset = createLambdaBuildTarget;

export type {
  LambdaContext,
  LambdaEvent,
  LambdaHandler,
  LambdaHandlerOptions,
  LambdaHost,
  LambdaResponse,
} from "./handler";
export { createLambdaHandler, createLambdaHost } from "./handler";
export type {
  CrocoBuildTarget,
  CrocoBuildTargetConfig,
  CrocoPreset,
  CrocoPresetConfig,
} from "@croco/framework-preset";
