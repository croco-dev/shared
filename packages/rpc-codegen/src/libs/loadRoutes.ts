import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { Problem, ProblemCategory } from "@croco/problems-core";
import {
  CONTROLLER_TYPESCRIPT_DIAGNOSTIC_CODE,
  type ControllerTypeScriptDiagnostic,
  extendApplicationZodRuntimes,
  formatControllerTypeScriptDiagnostics,
  getNoRestControllersFoundMessage,
  loadRestControllerSources,
  type RestControllerSourceProblems,
} from "@croco/protocol-codegen";
import {
  type BuildContractGraphOptions,
  buildContractGraph,
  type ContractDiagnostic,
  type ContractGraph,
  type ContractMonetizationInput,
  isContractMonetizationDefinition,
  type RouteIR,
} from "@croco/protocols-core";
import type { z } from "zod";

export type LoadContractGraphOptions = BuildContractGraphOptions & {
  readonly tsconfigPath?: string;
};

class NoRestControllersFoundProblem extends Problem {
  constructor(glob: string) {
    super(
      "rpc-codegen/no-rest-controllers-found",
      ProblemCategory.BadRequest,
      getNoRestControllersFoundMessage(glob),
    );
  }
}

class ControllerTypeScriptDiagnosticsProblem extends Problem {
  readonly diagnostics: readonly ControllerTypeScriptDiagnostic[];

  constructor(glob: string, diagnostics: readonly ControllerTypeScriptDiagnostic[]) {
    super(
      "rpc-codegen/controller-typescript-diagnostics",
      ProblemCategory.ValidationError,
      formatControllerTypeScriptDiagnostics("rpc-codegen", glob, diagnostics),
      {
        extensions: {
          crocoCode: CONTROLLER_TYPESCRIPT_DIAGNOSTIC_CODE,
          diagnostics,
        },
      },
    );
    this.diagnostics = diagnostics;
  }
}

const REST_CONTROLLER_SOURCE_PROBLEMS = {
  noControllersFound: (glob) => new NoRestControllersFoundProblem(glob),
  controllerTypeScriptDiagnostics: (glob, diagnostics) =>
    new ControllerTypeScriptDiagnosticsProblem(glob, diagnostics),
} satisfies RestControllerSourceProblems;

export async function loadRoutes(
  glob: string,
  options: LoadContractGraphOptions = {},
): Promise<RouteIR[]> {
  return [...(await loadContractGraph(glob, options)).routes];
}

export async function loadContractGraph(
  glob: string,
  options: LoadContractGraphOptions = {},
): Promise<ContractGraph> {
  const { tsconfigPath, ...contractOptions } = options;
  const { controllers, modules } = await loadRestControllerSources({
    controllers: glob,
    problems: REST_CONTROLLER_SOURCE_PROBLEMS,
    ...(tsconfigPath ? { tsconfigPath } : {}),
    beforeEmit: async (sourcePaths) =>
      extendApplicationZodRuntimes(sourcePaths, (namespace) =>
        extendZodWithOpenApi(namespace as typeof z),
      ),
  });
  const monetizationInputs: ContractMonetizationInput[] = [];
  const monetizationDiagnostics: ContractDiagnostic[] = [];

  for (const { moduleExports } of modules) {
    monetizationInputs.push(
      ...Object.values(moduleExports)
        .filter(isContractMonetizationDefinition)
        .map((definition) => definition.input),
    );
    for (const exported of Object.values(moduleExports)) {
      if (
        isMonetizationDefinitionCandidate(exported) &&
        !isContractMonetizationDefinition(exported)
      ) {
        monetizationDiagnostics.push({
          code: "CROCO_BILLING_DESCRIPTOR_INVALID",
          severity: "error",
          target: "monetization",
          message:
            "An exported croco.contract-monetization.v1 definition has an invalid typed input shape.",
          recoveryAction:
            "Create the executable artifact with defineContractMonetization() and valid typed descriptors.",
        });
      }
    }
  }

  const monetization = mergeMonetizationInputs(
    ...(contractOptions.monetization ? [contractOptions.monetization] : []),
    ...monetizationInputs,
  );
  return buildContractGraph(controllers, {
    ...contractOptions,
    ...(monetization ? { monetization } : {}),
    ...(monetizationDiagnostics.length > 0 ? { monetizationDiagnostics } : {}),
  });
}

function isMonetizationDefinitionCandidate(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "croco.contract-monetization.v1"
  );
}

function mergeMonetizationInputs(
  ...inputs: readonly ContractMonetizationInput[]
): ContractMonetizationInput | undefined {
  if (inputs.length === 0) return undefined;
  return {
    meters: inputs.flatMap((input) => input.meters ?? []),
    planVersions: inputs.flatMap((input) => input.planVersions ?? []),
    entitlementSets: inputs.flatMap((input) => input.entitlementSets ?? []),
    providers: inputs.flatMap((input) => input.providers ?? []),
    subscriptionMappings: inputs.flatMap((input) => input.subscriptionMappings ?? []),
  };
}
