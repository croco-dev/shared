import type {
  CrocoBuildTarget,
  CrocoBuildTargetConfig,
  CrocoBuildTargetOverride,
  HookMap,
} from "./types";

const EMPTY_HOOKS: Readonly<HookMap> = Object.freeze({});

export function defineCrocoBuildTarget(config: CrocoBuildTargetConfig): CrocoBuildTarget {
  const hooks = Object.freeze(config.hooks ?? EMPTY_HOOKS);
  const buildTargetConfig = Object.freeze({
    ...config,
    output: Object.freeze({ ...config.output }),
    hooks,
  });

  return Object.freeze({
    config: buildTargetConfig,
    name: buildTargetConfig.name,
    hooks,
    extend: (override: CrocoBuildTargetOverride): CrocoBuildTarget => {
      return defineCrocoBuildTarget({
        ...buildTargetConfig,
        ...override,
        output: {
          ...buildTargetConfig.output,
          ...override.output,
        },
        hooks: { ...buildTargetConfig.hooks, ...override.hooks },
      });
    },
  });
}

/** @deprecated Use `defineCrocoBuildTarget`. */
export const defineCrocoPreset = defineCrocoBuildTarget;

export type {
  CrocoBuildTarget,
  CrocoBuildTargetConfig,
  CrocoBuildTargetOverride,
  CrocoPreset,
  CrocoPresetConfig,
  CrocoPresetOverride,
  HookMap,
} from "./types";
