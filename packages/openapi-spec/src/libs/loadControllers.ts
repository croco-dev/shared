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
import type { Constructor } from "@croco/protocols-core";
import type { z } from "zod";

type Controller = Constructor;

class NoRestControllersFoundProblem extends Problem {
  constructor(glob: string) {
    super(
      "openapi-spec/no-rest-controllers-found",
      ProblemCategory.BadRequest,
      getNoRestControllersFoundMessage(glob),
    );
  }
}

class ControllerTypeScriptDiagnosticsProblem extends Problem {
  readonly diagnostics: readonly ControllerTypeScriptDiagnostic[];

  constructor(glob: string, diagnostics: readonly ControllerTypeScriptDiagnostic[]) {
    super(
      "openapi-spec/controller-typescript-diagnostics",
      ProblemCategory.ValidationError,
      formatControllerTypeScriptDiagnostics("openapi-spec", glob, diagnostics),
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

export type LoadControllersOptions = {
  readonly tsconfigPath?: string;
};

export async function loadControllers(
  glob: string,
  options: LoadControllersOptions = {},
): Promise<Controller[]> {
  const { controllers } = await loadRestControllerSources({
    controllers: glob,
    problems: REST_CONTROLLER_SOURCE_PROBLEMS,
    ...(options.tsconfigPath ? { tsconfigPath: options.tsconfigPath } : {}),
    beforeEmit: async (sourcePaths) =>
      extendApplicationZodRuntimes(sourcePaths, (namespace) =>
        extendZodWithOpenApi(namespace as typeof z),
      ),
  });
  return [...controllers];
}
