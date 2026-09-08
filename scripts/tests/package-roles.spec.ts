import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPackageRoles, validatePackageRoles } from "../package-roles.mts";

const plugin = { role: "Plugins", subtype: "provider", runtimes: ["node"], domain: "Transactions" };

function validate(entry: unknown) {
  return validatePackageRoles({ packageRoles: { example: entry } }, ["example"]);
}

describe("canonical package roles", () => {
  it("requires explicit metadata for every public package", () => {
    expect(validatePackageRoles({}, ["example"]).errors).toEqual([
      "docs/package-catalog.json packageRoles must be an object containing every public package.",
    ]);
    expect(validatePackageRoles({ packageRoles: {} }, ["example"]).errors).toEqual([
      "packageRoles.example is required; add role, subtype, runtimes, and domain metadata.",
    ]);
  });

  it("rejects an incompatible role and subtype without exposing invalid roles", () => {
    const result = validate({ ...plugin, role: "Kernel" });
    expect(result.roles).toEqual({});
    expect(result.errors).toEqual([
      "packageRoles.example.subtype must be one of runtime for role Kernel.",
    ]);
  });

  it("rejects missing subtype, runtime and domain metadata", () => {
    expect(validate({ role: "Plugins" }).errors).toHaveLength(3);
  });

  it("requires explicit runtime claims while permitting an explicitly unclaimed package", () => {
    expect(validate({ ...plugin, runtimes: undefined }).errors[0]).toContain(
      ".runtimes must explicitly list",
    );
    expect(validate({ ...plugin, runtimes: [] }).errors).toEqual([]);
    expect(validate({ ...plugin, runtimes: ["unknown"] }).errors).toHaveLength(1);
    expect(validate({ ...plugin, runtimes: ["node", "node"] }).errors).toHaveLength(1);
  });

  it("rejects unknown roles and stale packages in deterministic package order", () => {
    const result = validatePackageRoles(
      { packageRoles: { stale: plugin, example: { ...plugin, role: "Core" } } },
      ["example"],
    );
    expect(result.errors[0]).toContain("packageRoles.example.role");
    expect(result.errors[1]).toContain("packageRoles.stale refers to a package that is not public");
  });

  it("rejects contradictory extension runtime and domain metadata", () => {
    const result = validatePackageRoles(
      {
        packageRoles: { example: plugin },
        extensionMatrix: { packages: { example: { domain: "Events", runtimes: ["lambda"] } } },
      },
      ["example"],
    );
    expect(result.errors).toEqual([
      "packageRoles.example.domain contradicts extensionMatrix.packages.example.domain; synchronize the domain metadata.",
      "packageRoles.example.runtimes contradicts extensionMatrix.packages.example.runtimes; synchronize the compatibility metadata.",
    ]);
  });

  it("compares runtime claims as sets and keeps historical inventory independent", () => {
    const result = validatePackageRoles(
      {
        packageRoles: { example: { ...plugin, runtimes: ["node", "lambda"] } },
        groups: { Core: { packages: ["example"] } },
        extensionMatrix: {
          packages: { example: { domain: "Transactions", runtimes: ["lambda", "node"] } },
        },
      },
      ["example"],
    );
    expect(result.errors).toEqual([]);
    expect(result.roles.example?.role).toBe("Plugins");
  });

  it("covers every actual public package and explains formerly contradictory classifications", () => {
    const root = resolve(__dirname, "../..");
    const packages = readdirSync(resolve(root, "packages")).filter((name) => {
      const manifest = JSON.parse(
        readFileSync(resolve(root, "packages", name, "package.json"), "utf8"),
      );
      return manifest.private !== true;
    });
    const result = loadPackageRoles(root, packages);
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.roles)).toHaveLength(packages.length);
    expect(result.roles["tx-drizzle"]).toMatchObject({ role: "Plugins", subtype: "provider" });
    expect(result.roles["telemetry-api"]).toMatchObject({
      role: "Contracts",
      subtype: "observability",
    });
    expect(result.roles["framework-preset"]).toMatchObject({
      role: "Tooling",
      subtype: "build-target",
    });
    expect(result.roles["presentation-preset"]).toMatchObject({
      role: "Profiles",
      subtype: "composition",
    });
  });
});
