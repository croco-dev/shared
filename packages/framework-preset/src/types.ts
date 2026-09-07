export type CrocoBuildTargetConfig = {
  readonly name: string;
  readonly entry: string;
  readonly output: {
    readonly dir: string;
    readonly format: "esm" | "cjs" | "dual";
  };
  readonly hooks?: HookMap;
};

export type CrocoBuildTargetOverride = {
  readonly name?: CrocoBuildTargetConfig["name"];
  readonly entry?: CrocoBuildTargetConfig["entry"];
  readonly output?: {
    readonly dir?: CrocoBuildTargetConfig["output"]["dir"];
    readonly format?: CrocoBuildTargetConfig["output"]["format"];
  };
  readonly hooks?: HookMap;
};

export type HookMap = {
  readonly "build:before"?: (
    config: CrocoBuildTargetConfig,
  ) => Promise<CrocoBuildTargetConfig> | CrocoBuildTargetConfig;
  readonly "build:after"?: (result: {
    readonly success: boolean;
    readonly outputDir: string;
  }) => Promise<void> | void;
  readonly "dev:start"?: () => Promise<void> | void;
};

export type CrocoBuildTarget = {
  readonly config: Readonly<CrocoBuildTargetConfig>;
  readonly name: string;
  readonly hooks: Readonly<HookMap>;
  readonly extend: (override: CrocoBuildTargetOverride) => CrocoBuildTarget;
};

/** @deprecated Use `CrocoBuildTargetConfig`. */
export type CrocoPresetConfig = CrocoBuildTargetConfig;

/** @deprecated Use `CrocoBuildTargetOverride`. */
export type CrocoPresetOverride = CrocoBuildTargetOverride;

/** @deprecated Use `CrocoBuildTarget`. */
export type CrocoPreset = CrocoBuildTarget;
