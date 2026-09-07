import fs from "node:fs";
import path from "node:path";

export const ENTRYPOINT_EXEMPTIONS = new Map();

export const FILES_EXEMPTIONS = new Map();

export const EXPORT_CONDITION_ORDER = ["types", "import", "require"];

export const EXPECTED_PACKAGE_LICENSE = "Apache-2.0";

const CI_SCRIPT_COMMANDS = new Map([
  [
    "docs:api:model",
    "node --experimental-strip-types ../docs/scripts/generate-package-api-model.mts",
  ],
  [
    "test:evidence",
    "pnpm run test --maxWorkers=1 --reporter=json --outputFile=.turbo/croco-test-evidence.json",
  ],
]);

export const BUNDLED_RUNTIME_DEPENDENCY_EXEMPTIONS = new Map([
  [
    "create-croco-app",
    new Map([
      [
        "@croco/framework-context",
        "The published generator bundles framework intent and runtime capability helpers through tsup.noExternal.",
      ],
      [
        "@croco/tenant-core",
        "The published generator bundles tenant model helpers through tsup.noExternal.",
      ],
    ]),
  ],
]);

export function bundledRuntimeDependencyNamesFor(packageName) {
  return new Set(BUNDLED_RUNTIME_DEPENDENCY_EXEMPTIONS.get(packageName)?.keys() ?? []);
}

export const DIRECT_DIST_ENTRYPOINT_EXCEPTIONS = new Map([
  [
    "@croco/problems-core",
    "Problem contracts are imported by ESM runtime policy checks while the package keeps CommonJS publish semantics.",
  ],
  ["@croco/rpc-codegen", "Codegen exposes a built CLI and dual ESM/CJS library surface from dist."],
  [
    "@croco/storage-cloudinary",
    "Storage adapters keep root entrypoints aligned with packed dist artifacts for provider smoke checks.",
  ],
  [
    "@croco/storage-core",
    "Storage packages use direct dist roots so adapter consumers resolve the same files locally and from npm.",
  ],
  [
    "@croco/storage-r2",
    "Storage adapters keep root entrypoints aligned with packed dist artifacts for provider smoke checks.",
  ],
  [
    "@croco/telemetry-api",
    "Telemetry decorators and helpers are consumed as built runtime artifacts across Node and browser smokes.",
  ],
]);

export const DIRECT_DIST_ENTRYPOINT_PACKAGES = new Set(DIRECT_DIST_ENTRYPOINT_EXCEPTIONS.keys());

export const EXPECTED_FILES_BY_PACKAGE = new Map([
  ["create-croco-app", ["dist", "templates"]],
  ["@croco/utils-next-font-pretendard", ["dist", "PretendardVariable.woff2"]],
]);

export function expectedFilesFor(packageName) {
  return EXPECTED_FILES_BY_PACKAGE.get(packageName) ?? ["dist"];
}

export function fieldMatchesPath(source, rootFieldName, publishFieldPath) {
  const rootValue = source[rootFieldName];
  const publishValue = publishFieldPath.split(".").reduce((value, propertyName) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    return value[propertyName];
  }, source);

  return valuesMatch(rootValue, publishValue);
}

export function canonicalExportConditionNames(exportValue) {
  if (!exportValue || typeof exportValue !== "object" || Array.isArray(exportValue)) {
    return [];
  }

  const conditionNames = Object.keys(exportValue);
  const standardConditions = EXPORT_CONDITION_ORDER.filter((conditionName) =>
    Object.hasOwn(exportValue, conditionName),
  );
  const additionalConditions = conditionNames.filter(
    (conditionName) => !EXPORT_CONDITION_ORDER.includes(conditionName),
  );

  return [...standardConditions, ...additionalConditions];
}

export function exportConditionOrderDiagnostics(exportsValue, fieldName) {
  if (!exportsValue || typeof exportsValue !== "object" || Array.isArray(exportsValue)) {
    return [];
  }

  const diagnostics = [];
  for (const [exportPath, exportValue] of Object.entries(exportsValue)) {
    collectExportConditionOrderDiagnostics(
      exportValue,
      `${fieldName}[${JSON.stringify(exportPath)}]`,
      diagnostics,
    );
  }

  return diagnostics;
}

function collectExportConditionOrderDiagnostics(exportValue, fieldName, diagnostics) {
  if (!exportValue || typeof exportValue !== "object" || Array.isArray(exportValue)) {
    return;
  }

  const actual = Object.keys(exportValue);
  const expected = canonicalExportConditionNames(exportValue);
  if (!sameSequence(actual, expected)) {
    diagnostics.push(`${fieldName} conditions must be ordered ${expected.join(", ")}`);
  }

  for (const [conditionName, nestedValue] of Object.entries(exportValue)) {
    collectExportConditionOrderDiagnostics(
      nestedValue,
      `${fieldName}.${conditionName}`,
      diagnostics,
    );
  }
}

export function exportConditionSequenceParityDiagnostics(
  workspaceExports,
  publishedExports,
  workspaceFieldName = "exports",
  publishedFieldName = "publishConfig.exports",
) {
  if (
    !workspaceExports ||
    typeof workspaceExports !== "object" ||
    Array.isArray(workspaceExports) ||
    !publishedExports ||
    typeof publishedExports !== "object" ||
    Array.isArray(publishedExports)
  ) {
    return [];
  }

  const diagnostics = [];
  for (const exportPath of Object.keys(workspaceExports)) {
    const workspaceExport = workspaceExports[exportPath];
    const publishedExport = publishedExports[exportPath];
    if (
      !workspaceExport ||
      typeof workspaceExport !== "object" ||
      Array.isArray(workspaceExport) ||
      !publishedExport ||
      typeof publishedExport !== "object" ||
      Array.isArray(publishedExport)
    ) {
      continue;
    }

    const sharedConditions = new Set(
      Object.keys(workspaceExport).filter((conditionName) =>
        Object.hasOwn(publishedExport, conditionName),
      ),
    );
    const workspaceSequence = Object.keys(workspaceExport).filter((conditionName) =>
      sharedConditions.has(conditionName),
    );
    const publishedSequence = Object.keys(publishedExport).filter((conditionName) =>
      sharedConditions.has(conditionName),
    );
    if (!sameSequence(workspaceSequence, publishedSequence)) {
      diagnostics.push(
        `${workspaceFieldName}[${JSON.stringify(exportPath)}] and ${publishedFieldName}[${JSON.stringify(exportPath)}] must preserve the same shared condition order`,
      );
    }
  }

  return diagnostics;
}

export function packageLicenseDiagnostics(pkg) {
  if (pkg.private === true) {
    return [];
  }

  if (pkg.license !== EXPECTED_PACKAGE_LICENSE) {
    return [`license must be ${JSON.stringify(EXPECTED_PACKAGE_LICENSE)}`];
  }

  return [];
}

export function effectivePublishManifest(sourceManifest) {
  const publishManifest = {
    ...sourceManifest,
    ...sourceManifest.publishConfig,
  };
  delete publishManifest.publishConfig;
  return publishManifest;
}

/**
 * @param {unknown} baseManifest
 * @param {unknown} headManifest
 */
export function isCiScriptOnlyManifestChange(baseManifest, headManifest) {
  if (!isRecord(baseManifest) || !isRecord(headManifest)) {
    return false;
  }

  for (const key of new Set([...Object.keys(baseManifest), ...Object.keys(headManifest)])) {
    if (key !== "scripts" && !valuesMatch(baseManifest[key], headManifest[key])) {
      return false;
    }
  }

  const baseScripts = baseManifest.scripts;
  const headScripts = headManifest.scripts;
  if ((baseScripts !== undefined && !isRecord(baseScripts)) || !isRecord(headScripts)) {
    return false;
  }

  const originalScripts = baseScripts ?? {};

  let addedCiScript = false;
  for (const scriptName of new Set([
    ...Object.keys(originalScripts),
    ...Object.keys(headScripts),
  ])) {
    if (valuesMatch(originalScripts[scriptName], headScripts[scriptName])) {
      continue;
    }
    if (
      originalScripts[scriptName] !== undefined ||
      !CI_SCRIPT_COMMANDS.has(scriptName) ||
      headScripts[scriptName] !== CI_SCRIPT_COMMANDS.get(scriptName)
    ) {
      return false;
    }
    addedCiScript = true;
  }

  return addedCiScript;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuesMatch(left, right) {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesMatch(value, right[index]))
    );
  }

  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && valuesMatch(left[key], right[key]))
  );
}

function sameSequence(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function findPackageJsonFiles(dir, results = []) {
  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      findPackageJsonFiles(fullPath, results);
    } else if (entry.isFile() && entry.name === "package.json") {
      results.push(fullPath);
    }
  }

  return results.sort();
}

export function packageHasSourceEntrypoint(pkgPath) {
  return fs.existsSync(path.join(path.dirname(pkgPath), "src", "index.ts"));
}
