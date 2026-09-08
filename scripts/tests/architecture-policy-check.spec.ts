import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const scriptPath = resolve(__dirname, "../architecture-policy-check.mts");
const scriptTestTimeout = 30_000;
const tempRoots: string[] = [];

vi.setConfig({ testTimeout: scriptTestTimeout });

type ScriptResult = {
  readonly output: string;
  readonly status: number | null;
};

type ArchitecturePackageGroup = {
  readonly packages?: readonly string[];
  readonly paths?: readonly string[];
};

describe("architecture-policy-check.mts", () => {
  afterAll(() => vi.resetConfig());
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it("passes when canonical package roles match policy groups", () => {
    const root = createTempRoot();
    writePackage(root, "alpha");
    writePackage(root, "provider");
    writePackageCatalog(root, { Contracts: ["alpha"], Plugins: ["provider"] });
    writeArchitectureManifest(root, {
      contracts: { packages: ["@croco/alpha"] },
      plugins: { packages: ["@croco/provider"] },
    });
    expect(runScript(root).status).toBe(0);
  });

  it.each([
    [{}, "no group"],
    [{ plugins: { packages: ["@croco/alpha"] } }, "plugins"],
    [
      { contracts: { packages: ["@croco/alpha"] }, kernel: { packages: ["@croco/alpha"] } },
      "contracts, kernel",
    ],
  ])("rejects missing, mismatched, or overlapping canonical classification", (groups, actual) => {
    const root = createTempRoot();
    writePackage(root, "alpha");
    writePackageCatalog(root, { Contracts: ["alpha"] });
    writeArchitectureManifest(root, groups);
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      `canonical role Contracts but croco.arch.json assigns ${actual}`,
    );
    expect(result.output).toContain("Assign @croco/alpha to exactly packageGroups.contracts");
  });

  it("rejects missing canonical role metadata", () => {
    const root = createTempRoot();
    writePackage(root, "alpha");
    writePackageCatalog(root, {});
    writeArchitectureManifest(root, { contracts: { packages: ["@croco/alpha"] } });
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("packageRoles.alpha is required");
  });

  it("fails with recovery when the role catalog is missing", () => {
    const root = createTempRoot();
    writePackage(root, "alpha");
    writeArchitectureManifest(root, {});
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Restore docs/package-catalog.json");
  });

  it("uses custom package roots", () => {
    const root = createTempRoot();
    writePackage(root, "alpha", "libs");
    writePackageCatalog(root, { Contracts: ["alpha"] });
    writeArchitectureManifest(root, { contracts: { packages: ["@croco/alpha"] } }, ["libs"]);
    expect(runScript(root).status).toBe(0);
  });

  it.each(["Kernel", "Contracts"])("rejects %s source imports into concrete Plugins", (role) => {
    const root = createTempRoot();
    writePackage(root, "alpha");
    writePackage(root, "provider");
    writePackageCatalog(root, { [role]: ["alpha"], Plugins: ["provider"] });
    writeArchitectureManifest(root, {
      [role.toLowerCase()]: { packages: ["@croco/alpha"] },
      plugins: { packages: ["@croco/provider"] },
    });
    mkdirSync(join(root, "packages/alpha/src"), { recursive: true });
    writeFileSync(join(root, "packages/alpha/src/index.ts"), 'import "@croco/provider";\n');
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("architecture-policy/forbidden-import");
    expect(result.output).toContain("Move concrete implementation imports into Plugins");
  });
});

function runScript(root: string): ScriptResult {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      scriptPath,
      "--manifest",
      join(root, "croco.arch.json"),
      "--root",
      root,
    ],
    {
      encoding: "utf-8",
    },
  );

  return {
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  };
}

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "croco-architecture-policy-check-"));
  tempRoots.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "packages"), { recursive: true });
  return root;
}

function writePackage(root: string, shortName: string, packageRoot = "packages"): void {
  const packageDir = join(root, packageRoot, shortName);
  mkdirSync(packageDir, { recursive: true });
  writeJson(join(packageDir, "package.json"), {
    name: `@croco/${shortName}`,
    version: "0.0.0",
    type: "module",
  });
}

function writePackageCatalog(
  root: string,
  groups: Readonly<Record<string, readonly string[]>>,
): void {
  writeJson(join(root, "docs", "package-catalog.json"), {
    packageRoles: Object.fromEntries(
      Object.entries(groups).flatMap(([role, packages]) =>
        packages.map((name) => [
          name,
          {
            role,
            subtype: role === "Plugins" ? "provider" : role === "Kernel" ? "runtime" : "domain",
            runtimes: [],
            domain: "test",
          },
        ]),
      ),
    ),
  });
}

function writeArchitectureManifest(
  root: string,
  packageGroups: Readonly<Record<string, ArchitecturePackageGroup>>,
  packageRoots: readonly string[] = ["packages"],
): void {
  writeJson(join(root, "croco.arch.json"), {
    schemaVersion: "croco.architecture-policy/v1",
    packageRoots,
    include: packageRoots.map((packageRoot) => `${packageRoot}/*/src/**/*.ts`),
    ignore: [],
    packageGroups,
    rules: {
      forbiddenImports: [
        {
          id: "canonical-plugin-boundary",
          from: { groups: ["kernel", "contracts"] },
          to: { groups: ["plugins"] },
          recovery: "Move concrete implementation imports into Plugins.",
        },
      ],
    },
  });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
