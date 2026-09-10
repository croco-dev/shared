import "reflect-metadata";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Zod from "zod";
import { loadContractGraph, loadRoutes } from "../libs/loadRoutes";

let tempRoot: string;
let sourceDir: string;

const LOAD_ROUTES_TIMEOUT_MS = 120_000;
const SHARED_FIXTURE_ROOT = new URL(
  "../../../../scripts/fixtures/protocol-codegen/",
  import.meta.url,
);

describe("loadRoutes", () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-load-routes-"));
    sourceDir = path.join(tempRoot, "src");
    fs.mkdirSync(sourceDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it(
    "extracts exported controllers while ignoring co-located helper classes",
    async () => {
      fs.writeFileSync(path.join(sourceDir, "UsersController.ts"), getMixedControllerSource());

      const routes = await loadRoutes(path.join(sourceDir, "*.ts"));

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        controllerName: "UsersController",
        methodName: "listUsers",
        httpMethod: "GET",
        path: "/users",
      });
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "evaluates OpenAPI schemas with each application's Zod runtime before extracting routes",
    async () => {
      const workspaceRequire = createRequire(import.meta.url);
      const zodRoot = path.dirname(workspaceRequire.resolve("zod/package.json"));
      const openapiRoot = path.dirname(
        workspaceRequire.resolve("@asteasolutions/zod-to-openapi/package.json"),
      );
      const esmRuntimes: (typeof Zod)[] = [];
      for (const name of ["first", "second"]) {
        const applicationRoot = path.join(tempRoot, name);
        const controllerPath = path.join(applicationRoot, "src", "UsersController.ts");
        fs.mkdirSync(path.dirname(controllerPath), { recursive: true });
        fs.cpSync(zodRoot, path.join(applicationRoot, "node_modules", "zod"), { recursive: true });
        fs.symlinkSync(
          openapiRoot,
          path.join(applicationRoot, "node_modules", "openapi-types"),
          "dir",
        );
        fs.writeFileSync(
          controllerPath,
          getMixedControllerSource()
            .replace(
              "import 'reflect-metadata';",
              `import { z } from 'zod';
import type {} from 'openapi-types';
export const schema = z.object({ id: z.string().openapi({ example: 'user-1' }) }).openapi('User');
schema.parse({ id: 'user-1' });`,
            )
            .replace("@Controller('/users')", `@Controller('/${name}')`),
        );
        const applicationZod = createRequire(controllerPath)("zod") as typeof Zod;
        expect(applicationZod.z.string().openapi).toBeUndefined();
        const packageJson = JSON.parse(
          fs.readFileSync(path.join(zodRoot, "package.json"), "utf8"),
        ) as {
          exports: { ".": { import: string } };
        };
        const esmZod = (await import(
          pathToFileURL(
            path.join(applicationRoot, "node_modules", "zod", packageJson.exports["."].import),
          ).href
        )) as typeof Zod;
        expect(esmZod.z.string().openapi).toBeUndefined();
        esmRuntimes.push(esmZod);
      }

      const routes = await loadRoutes(path.join(tempRoot, "*", "src", "*.ts"));

      expect(routes.map((route) => route.path).sort()).toEqual(["/first", "/second"]);
      expect(routes.every((route) => route.methodName === "listUsers")).toBe(true);
      for (const { z } of esmRuntimes) {
        expect(z.string().openapi({ example: "user-1" }).parse("user-1")).toBe("user-1");
      }
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "loads the canonical contract graph for exported controllers",
    async () => {
      fs.writeFileSync(path.join(sourceDir, "UsersController.ts"), getMixedControllerSource());

      const graph = await loadContractGraph(path.join(sourceDir, "*.ts"));

      expect(graph.controllers).toEqual([
        {
          name: "UsersController",
          path: "/users",
          guards: [],
          roles: [],
          routeIds: ["UsersController.listUsers"],
        },
      ]);
      expect(graph.routes[0]).toMatchObject({
        routeId: "UsersController.listUsers",
        operationId: "UsersController_listUsers",
        path: "/users",
      });
      expect(graph.diagnostics).toEqual([]);
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "discovers executable monetization definitions beside controllers",
    async () => {
      fs.writeFileSync(
        path.join(sourceDir, "UsersController.ts"),
        `${getMixedControllerSource()}\nexport const monetization = { kind: "croco.contract-monetization.v1", input: { meters: [{ key: "api.calls", aggregation: "COUNT", unit: "request", billing: "required" }] } };`,
      );

      const graph = await loadContractGraph(path.join(sourceDir, "*.ts"));

      expect(graph.monetization?.nodes).toContainEqual(
        expect.objectContaining({ kind: "meter", key: "api.calls" }),
      );
      expect(graph.diagnostics).toContainEqual(
        expect.objectContaining({ code: "CROCO_BILLING_METER_UNBOUND" }),
      );
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "reports malformed executable monetization definitions without crashing verification",
    async () => {
      fs.writeFileSync(
        path.join(sourceDir, "UsersController.ts"),
        `${getMixedControllerSource()}\nexport const monetization = { kind: "croco.contract-monetization.v1", input: { meters: 42 } };`,
      );

      const graph = await loadContractGraph(path.join(sourceDir, "*.ts"));

      expect(graph.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "CROCO_BILLING_DESCRIPTOR_INVALID",
          recoveryAction: expect.any(String),
        }),
      );
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "normalizes shared decorator and parameter source locations",
    async () => {
      const controllerPath = path.join(sourceDir, "LocatedController.ts");

      fs.writeFileSync(controllerPath, readSharedFixture("LocatedController.ts.fixture"));

      const graph = await loadContractGraph(path.join(sourceDir, "*.ts"), {
        strictSchemas: true,
      });
      const routeDiagnostic = graph.diagnostics.find(
        (diagnostic) => diagnostic.code === "contract-route-missing-response-schema",
      );
      const paramDiagnostic = graph.diagnostics.find(
        (diagnostic) => diagnostic.code === "contract-route-missing-named-param-schema",
      );

      expect(routeDiagnostic?.sourceLocation).toEqual({
        path: "LocatedController.ts",
        line: 60,
        column: 3,
      });
      expect(paramDiagnostic?.sourceLocation).toEqual({
        path: "LocatedController.ts",
        line: 61,
        column: 11,
      });
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "keeps emitted decorator source locations scoped to each source file",
    async () => {
      const firstDir = path.join(sourceDir, "first");
      const secondDir = path.join(sourceDir, "second");
      const firstControllerPath = path.join(firstDir, "DuplicateController.ts");
      const secondControllerPath = path.join(secondDir, "DuplicateController.ts");

      fs.mkdirSync(firstDir, { recursive: true });
      fs.mkdirSync(secondDir, { recursive: true });
      fs.writeFileSync(firstControllerPath, getDuplicateControllerSource("/first"));
      fs.writeFileSync(secondControllerPath, getDuplicateControllerSource("/second"));

      const routes = await loadRoutes(path.join(sourceDir, "**/*.ts"));
      const sourceLocationByPath = new Map(
        routes.map((route) => [route.path, route.sourceLocation?.path]),
      );

      expect(sourceLocationByPath.get("/first")).toBe("first/DuplicateController.ts");
      expect(sourceLocationByPath.get("/second")).toBe("second/DuplicateController.ts");
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "resolves controller imports from the nearest project node_modules",
    async () => {
      writeProtocolsRestFixture(tempRoot);
      fs.writeFileSync(
        path.join(sourceDir, "ImportedController.ts"),
        getImportedControllerSource(),
      );

      const routes = await loadRoutes(path.join(sourceDir, "*.ts"));

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        controllerName: "ImportedController",
        methodName: "list",
        httpMethod: "GET",
        path: "/imported",
      });
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "preserves local imports outside the controller glob during contract loading",
    async () => {
      const controllersDir = path.join(sourceDir, "controllers");
      const tsconfigPath = path.join(tempRoot, "tsconfig.json");

      fs.mkdirSync(controllersDir, { recursive: true });
      fs.writeFileSync(
        tsconfigPath,
        JSON.stringify({
          compilerOptions: {
            experimentalDecorators: true,
            module: "CommonJS",
            target: "ES2020",
          },
          include: ["src/controllers/**/*.ts", "src/ImportedUserDto.ts"],
        }),
      );
      fs.writeFileSync(path.join(sourceDir, "ImportedUserDto.ts"), getLocalSupportSource());
      fs.writeFileSync(
        path.join(controllersDir, "LocalImportController.ts"),
        getControllerImportingLocalSupportSource(),
      );

      const routes = await loadRoutes(path.join(controllersDir, "*.ts"), { tsconfigPath });

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        controllerName: "LocalImportController",
        methodName: "list",
        httpMethod: "GET",
        path: "/local-imports",
        sourceLocation: { path: "LocalImportController.ts" },
      });
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "loads runtime path aliases with an explicit NodeNext application config",
    async () => {
      const tsconfigPath = path.join(tempRoot, "tsconfig.codegen.json");
      fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ type: "module" }));
      fs.writeFileSync(
        tsconfigPath,
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            experimentalDecorators: true,
            module: "NodeNext",
            moduleResolution: "NodeNext",
            paths: { "@app/*": ["src/*"] },
            target: "ES2022",
          },
        }),
      );
      fs.writeFileSync(
        path.join(sourceDir, "paths.ts"),
        "export const controllerPath = '/aliased';\n",
      );
      fs.writeFileSync(
        path.join(sourceDir, "AliasedController.ts"),
        getMixedControllerSource()
          .replace("import 'reflect-metadata';", "import { controllerPath } from '@app/paths';")
          .replace("@Controller('/users')", "@Controller(controllerPath)"),
      );

      const routes = await loadRoutes(path.join(sourceDir, "*Controller.ts"), { tsconfigPath });

      expect(routes).toContainEqual(expect.objectContaining({ path: "/aliased" }));
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "fails before importing emitted controllers when controller TypeScript has errors",
    async () => {
      const controllerPath = path.join(sourceDir, "BrokenController.ts");
      fs.writeFileSync(controllerPath, readSharedFixture("BrokenController.ts.fixture"));

      await expectControllerTypeScriptDiagnostics(
        loadRoutes(path.join(sourceDir, "*.ts")),
        controllerPath,
        "rpc-codegen/controller-typescript-diagnostics",
        "rpc-codegen",
      );
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "fails clearly when matched files export no controllers",
    async () => {
      fs.writeFileSync(path.join(sourceDir, "Helper.ts"), "export class Helper {}\n");

      await expectNoRestControllersFound(loadRoutes(path.join(sourceDir, "*.ts")));
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );

  it(
    "fails clearly when no files match the controller glob",
    async () => {
      await expectNoRestControllersFound(loadRoutes(path.join(sourceDir, "*.ts")));
    },
    LOAD_ROUTES_TIMEOUT_MS,
  );
});

async function expectNoRestControllersFound(result: Promise<unknown>): Promise<void> {
  await expect(result).rejects.toMatchObject({
    code: "rpc-codegen/no-rest-controllers-found",
    detail: expect.stringContaining("No exported REST controllers found"),
    status: 400,
    title: "Bad Request",
    type: "about:blank",
  });
}

async function expectControllerTypeScriptDiagnostics(
  result: Promise<unknown>,
  controllerPath: string,
  code: string,
  generatorName: string,
): Promise<void> {
  try {
    await result;
  } catch (error) {
    expect(error).toMatchObject({
      code,
      status: 422,
      title: "Validation Error",
      extensions: {
        crocoCode: "CROCO_BUILD_003",
        diagnostics: [
          expect.objectContaining({
            crocoCode: "CROCO_BUILD_003",
            tsCode: "TS2322",
            file: controllerPath,
            line: expect.any(Number),
            column: expect.any(Number),
          }),
        ],
      },
    });
    expect(error).toMatchObject({
      detail: expect.stringContaining(
        `${generatorName} refused to load controller contract sources`,
      ),
    });
    expect(error).toMatchObject({
      detail: expect.stringContaining("CROCO_BUILD_003 TS2322"),
    });
    expect(error).toMatchObject({
      detail: expect.stringMatching(/BrokenController\.ts:\d+:\d+/),
    });
    return;
  }

  throw new Error("Expected controller TypeScript diagnostics to reject contract loading.");
}

function readSharedFixture(name: string): string {
  return fs.readFileSync(new URL(name, SHARED_FIXTURE_ROOT), "utf8");
}

function writeProtocolsRestFixture(projectDir: string): void {
  const packageDir = path.join(projectDir, "node_modules", "@croco", "protocols-rest");

  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@croco/protocols-rest", main: "index.js" }),
  );
  fs.writeFileSync(path.join(packageDir, "index.js"), getProtocolsRestFixtureSource());
  fs.writeFileSync(path.join(packageDir, "index.d.ts"), getProtocolsRestFixtureTypes());
}

function getImportedControllerSource(): string {
  return `import { Controller, Get } from '@croco/protocols-rest';

@Controller('/imported')
export class ImportedController {
  @Get('/')
  list() {
    return [];
  }
}
`;
}

function getLocalSupportSource(): string {
  return `export class ImportedUserDto {
  readonly id = 'user-1';
}
`;
}

function getControllerImportingLocalSupportSource(): string {
  return `import 'reflect-metadata';
import { ImportedUserDto } from '../ImportedUserDto';

const REST_CONTROLLER_KEY = Symbol.for('croco:rest:controller');
const REST_ROUTES_KEY = Symbol.for('croco:rest:routes');

declare namespace Reflect {
  function defineMetadata(metadataKey: unknown, metadataValue: unknown, target: object): void;
  function getMetadata(metadataKey: unknown, target: object): unknown;
}

type RouteMetadata = {
  readonly method: string;
  readonly path: string;
  readonly methodName: string | symbol;
};

function Controller(controllerPath: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(REST_CONTROLLER_KEY, { path: controllerPath, target }, target);
  };
}

function Get(routePath: string): MethodDecorator {
  return (target, propertyKey) => {
    const ctor = target.constructor;
    const routes = (Reflect.getMetadata(REST_ROUTES_KEY, ctor) as RouteMetadata[] | undefined) ?? [];

    Reflect.defineMetadata(REST_ROUTES_KEY, [...routes, { method: 'GET', path: routePath, methodName: propertyKey }], ctor);
  };
}

@Controller('/local-imports')
export class LocalImportController {
  @Get('/')
  list() {
    return [new ImportedUserDto()];
  }
}
`;
}

function getProtocolsRestFixtureSource(): string {
  return `const REST_CONTROLLER_KEY = Symbol.for('croco:rest:controller');
const REST_ROUTES_KEY = Symbol.for('croco:rest:routes');

exports.Controller = function Controller(controllerPath = '') {
  return (target) => {
    const path = controllerPath.startsWith('/') ? controllerPath : \`/\${controllerPath}\`;
    Reflect.defineMetadata(REST_CONTROLLER_KEY, { path: path === '/' ? '' : path, target }, target);
  };
};

exports.Get = function Get(routePath = '') {
  return (target, propertyKey, descriptor) => {
    const path = routePath.startsWith('/') ? routePath : \`/\${routePath}\`;
    const ctor = target.constructor;
    const routes = Reflect.getMetadata(REST_ROUTES_KEY, ctor) ?? [];
    Reflect.defineMetadata(REST_ROUTES_KEY, [...routes, { method: 'GET', path: path === '/' ? '' : path, methodName: propertyKey }], ctor);
    return descriptor;
  };
};
`;
}

function getProtocolsRestFixtureTypes(): string {
  return `export declare function Controller(controllerPath?: string): ClassDecorator;
export declare function Get(routePath?: string): MethodDecorator;
`;
}

function getMixedControllerSource(): string {
  return `import 'reflect-metadata';

const REST_CONTROLLER_KEY = Symbol.for('croco:rest:controller');
const REST_ROUTES_KEY = Symbol.for('croco:rest:routes');

declare namespace Reflect {
  function defineMetadata(metadataKey: unknown, metadataValue: unknown, target: object): void;
  function getMetadata(metadataKey: unknown, target: object): unknown;
}

type RouteMetadata = {
  readonly method: string;
  readonly path: string;
  readonly methodName: string | symbol;
};

function Controller(controllerPath: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(REST_CONTROLLER_KEY, { path: controllerPath, target }, target);
  };
}

function Get(routePath: string): MethodDecorator {
  return (target, propertyKey) => {
    const ctor = target.constructor;
    const routes = (Reflect.getMetadata(REST_ROUTES_KEY, ctor) as RouteMetadata[] | undefined) ?? [];

    Reflect.defineMetadata(REST_ROUTES_KEY, [...routes, { method: 'GET', path: routePath, methodName: propertyKey }], ctor);
  };
}

class UserDto {
  readonly id = 'user-1';
}

export class ExportedHelper {
  readonly dto = new UserDto();
}

@Controller('/users')
export class UsersController {
  @Get('/')
  listUsers() {
    return [new UserDto()];
  }
}
`;
}

function getDuplicateControllerSource(controllerPath: string): string {
  return `import 'reflect-metadata';

const REST_CONTROLLER_KEY = Symbol.for('croco:rest:controller');
const REST_ROUTES_KEY = Symbol.for('croco:rest:routes');

declare namespace Reflect {
  function defineMetadata(metadataKey: unknown, metadataValue: unknown, target: object): void;
  function getMetadata(metadataKey: unknown, target: object): unknown;
}

type RouteMetadata = {
  readonly method: string;
  readonly path: string;
  readonly methodName: string | symbol;
};

function Controller(path: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(REST_CONTROLLER_KEY, { path, target }, target);
  };
}

function Get(routePath: string): MethodDecorator {
  return (target, propertyKey) => {
    const ctor = target.constructor;
    const routes = (Reflect.getMetadata(REST_ROUTES_KEY, ctor) as RouteMetadata[] | undefined) ?? [];

    Reflect.defineMetadata(REST_ROUTES_KEY, [...routes, { method: 'GET', path: routePath, methodName: propertyKey }], ctor);
  };
}

@Controller('${controllerPath}')
export class DuplicateController {
  @Get('/')
  find(): void {}
}
`;
}
