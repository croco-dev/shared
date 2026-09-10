import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export async function extendApplicationZodRuntimes(
  sourcePaths: readonly string[],
  extender: (namespace: unknown) => void,
): Promise<void> {
  const extendedPackages = new Set<string>();

  for (const sourcePath of sourcePaths) {
    const applicationRequire = createRequire(sourcePath);
    let packageJsonPath: string;

    try {
      packageJsonPath = applicationRequire.resolve("zod/package.json");
    } catch {
      continue;
    }

    if (extendedPackages.has(packageJsonPath)) continue;
    extendedPackages.add(packageJsonPath);

    extendZodModule(applicationRequire("zod") as unknown, extender);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      readonly exports?: {
        readonly "."?: { readonly import?: unknown };
      };
    };
    const importPath = packageJson.exports?.["."]?.import;
    if (typeof importPath !== "string") continue;
    const esmModule = (await import(
      pathToFileURL(path.resolve(path.dirname(packageJsonPath), importPath)).href
    )) as unknown;
    extendZodModule(esmModule, extender);
  }
}

function extendZodModule(moduleExports: unknown, extender: (namespace: unknown) => void): void {
  if (!moduleExports || typeof moduleExports !== "object") return;
  const candidate = moduleExports as { readonly z?: unknown };
  const zodNamespace = candidate.z;
  if (!zodNamespace || typeof zodNamespace !== "object") return;
  const zodConstructors = zodNamespace as {
    readonly ZodObject?: unknown;
    readonly ZodType?: unknown;
  };
  if (
    typeof zodConstructors.ZodObject !== "function" ||
    typeof zodConstructors.ZodType !== "function"
  ) {
    return;
  }
  extender(zodNamespace);
}
