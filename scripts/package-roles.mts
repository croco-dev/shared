import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_ROLE_SUBTYPES = {
  Kernel: ["runtime"],
  Contracts: ["domain", "protocol", "observability"],
  Plugins: ["provider", "transport", "host", "integration", "presentation", "protocol"],
  Profiles: ["composition"],
  Tooling: ["build-target", "codegen", "testing", "cli", "policy", "migration"],
  Application: ["composition"],
} as const;

export type PackageRole = keyof typeof PACKAGE_ROLE_SUBTYPES;
export type PackageRoleMetadata = {
  [Role in PackageRole]: {
    readonly role: Role;
    readonly subtype: (typeof PACKAGE_ROLE_SUBTYPES)[Role][number];
    /** An explicit empty list means runtime compatibility is not claimed. */
    readonly runtimes: readonly string[];
    readonly domain: string;
  };
}[PackageRole];

export type PackageRolesValidation = {
  readonly roles: Readonly<Record<string, PackageRoleMetadata>>;
  readonly errors: readonly string[];
};

const runtimeNames = new Set(["node", "lambda", "cloudflare-workers", "browser"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validatePackageRoles(
  catalog: unknown,
  publicPackageNames: readonly string[],
): PackageRolesValidation {
  const errors: string[] = [];
  const roles: Record<string, PackageRoleMetadata> = {};
  const metadata = isRecord(catalog) ? catalog.packageRoles : undefined;
  if (!isRecord(metadata)) {
    return {
      roles,
      errors: [
        "docs/package-catalog.json packageRoles must be an object containing every public package.",
      ],
    };
  }
  const publicNames = new Set(publicPackageNames);
  const extensions =
    isRecord(catalog) &&
    isRecord(catalog.extensionMatrix) &&
    isRecord(catalog.extensionMatrix.packages)
      ? catalog.extensionMatrix.packages
      : {};
  for (const name of [...new Set([...publicNames, ...Object.keys(metadata)])].sort()) {
    const location = `packageRoles.${name}`;
    if (!publicNames.has(name)) {
      errors.push(
        `${location} refers to a package that is not public; remove the stale role entry.`,
      );
      continue;
    }
    const entry = metadata[name];
    if (!isRecord(entry)) {
      errors.push(`${location} is required; add role, subtype, runtimes, and domain metadata.`);
      continue;
    }
    const before = errors.length;
    if (typeof entry.role !== "string" || !Object.hasOwn(PACKAGE_ROLE_SUBTYPES, entry.role)) {
      errors.push(
        `${location}.role must be one of ${Object.keys(PACKAGE_ROLE_SUBTYPES).join(", ")}.`,
      );
    } else {
      const subtypes: readonly string[] = PACKAGE_ROLE_SUBTYPES[entry.role as PackageRole];
      if (typeof entry.subtype !== "string" || !subtypes.includes(entry.subtype)) {
        errors.push(
          `${location}.subtype must be one of ${subtypes.join(", ")} for role ${entry.role}.`,
        );
      }
    }
    if (
      !isStringArray(entry.runtimes) ||
      entry.runtimes.some((runtime) => !runtimeNames.has(runtime)) ||
      new Set(entry.runtimes).size !== entry.runtimes.length
    ) {
      errors.push(
        `${location}.runtimes must explicitly list unique supported runtime identifiers (${[...runtimeNames].join(", ")}); [] means unclaimed.`,
      );
    }
    if (typeof entry.domain !== "string" || entry.domain.trim().length === 0) {
      errors.push(`${location}.domain must be a nonempty string.`);
    }
    const extension = extensions[name];
    if (isRecord(extension)) {
      if (entry.domain !== extension.domain) {
        errors.push(
          `${location}.domain contradicts extensionMatrix.packages.${name}.domain; synchronize the domain metadata.`,
        );
      }
      if (
        isStringArray(entry.runtimes) &&
        isStringArray(extension.runtimes) &&
        JSON.stringify([...entry.runtimes].sort()) !==
          JSON.stringify([...extension.runtimes].sort())
      ) {
        errors.push(
          `${location}.runtimes contradicts extensionMatrix.packages.${name}.runtimes; synchronize the compatibility metadata.`,
        );
      }
    }
    if (before === errors.length) {
      roles[name] = entry as PackageRoleMetadata;
    }
  }
  return { roles, errors };
}

export function loadPackageRoles(
  rootDir: string,
  publicPackageNames: readonly string[],
): PackageRolesValidation {
  const catalog: unknown = JSON.parse(
    readFileSync(join(rootDir, "docs/package-catalog.json"), "utf8"),
  );
  return validatePackageRoles(catalog, publicPackageNames);
}
