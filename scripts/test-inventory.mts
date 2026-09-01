import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CORE_COVERAGE_PACKAGES } from "./core-coverage-config.mts";

export const TEST_INVENTORY_VERSION = 1 as const;
export const TEST_LANES = ["fast", "integration", "published", "generated-app", "live"] as const;
export const TEST_QUALIFIERS = ["coverage", "release-only"] as const;
export const TEST_PROFILES = ["ordinary", "publish", "scheduled-live"] as const;

export type TestLane = (typeof TEST_LANES)[number];
export type TestQualifier = (typeof TEST_QUALIFIERS)[number];
export type TestProfile = (typeof TEST_PROFILES)[number];
export type TestRequirement = "R" | "O" | "N/A";

export type GeneratedTestMapping = {
  readonly sourcePath: string;
  readonly generatedPath: string;
  readonly commandId: string;
};

export type TestInventoryEntry = {
  readonly path: string;
  readonly lane: TestLane;
  readonly qualifiers: readonly TestQualifier[];
  readonly owner: string;
  readonly generated?: GeneratedTestMapping;
};

export type TestInventoryException = {
  readonly path: string;
  readonly kind: "non-executable-fixture";
  readonly reason: string;
  readonly owner: string;
};

export type TestInventory = {
  readonly version: 1;
  readonly tests: readonly TestInventoryEntry[];
  readonly exceptions: readonly TestInventoryException[];
};

export type TestInventoryDiagnosticCode =
  | "TEST_DISCOVERY_INVALID_PATH"
  | "TEST_DISCOVERY_CASE_COLLISION"
  | "TEST_DISCOVERY_SYMLINK"
  | "TEST_INVENTORY_ORPHAN"
  | "TEST_INVENTORY_MISSING_FILE"
  | "TEST_INVENTORY_DUPLICATE_PATH"
  | "TEST_INVENTORY_INVALID_LANE"
  | "TEST_INVENTORY_INVALID_QUALIFIER"
  | "TEST_INVENTORY_INCOMPATIBLE_QUALIFIERS"
  | "TEST_INVENTORY_INVALID_OWNER"
  | "TEST_INVENTORY_INVALID_EXCEPTION"
  | "TEST_INVENTORY_STALE_EXCEPTION"
  | "TEST_INVENTORY_UNDECLARED_EXECUTION"
  | "TEST_EVIDENCE_MISSING_REQUIRED"
  | "TEST_LIVE_CREDENTIALS_MISSING"
  | "TEST_GENERATED_MAPPING_MISSING"
  | "TEST_GENERATED_MAPPING_MISMATCH"
  | "TEST_GENERATED_EXECUTION_UNDECLARED"
  | "TEST_GENERATED_SOURCE_DIGEST_MISMATCH";

export type TestInventoryDiagnostic = {
  readonly code: TestInventoryDiagnosticCode;
  readonly message: string;
  readonly path?: string;
};

export type TestDiscoveryResult = {
  readonly paths: readonly string[];
  readonly diagnostics: readonly TestInventoryDiagnostic[];
};

export type TestInventoryReport = {
  readonly schemaVersion: "croco.test-inventory-report/v1";
  readonly valid: boolean;
  readonly inventoryVersion: 1;
  readonly inventoryDigest: string;
  readonly discoveredPaths: readonly string[];
  readonly resolvedEntries: readonly TestInventoryEntry[];
  readonly exceptions: readonly TestInventoryException[];
  readonly generatedMappings: readonly GeneratedTestMapping[];
  readonly evidence?: TestInventoryEvidenceReport;
  readonly diagnostics: readonly TestInventoryDiagnostic[];
};

export type TestInventoryEvidenceEntry = Pick<
  TestInventoryEntry,
  "path" | "lane" | "qualifiers" | "owner"
> & {
  readonly requirement: TestRequirement;
  readonly state: "executed" | "not-run";
  readonly reasonCode: ProfileResolution["reasonCode"] | "EXECUTED";
};

export type TestInventoryEvidenceReport = {
  readonly mode: "enforced" | "report-only";
  readonly profile: TestProfile;
  readonly inventoryVersion: 1;
  readonly inventoryDigest: string;
  readonly entries: readonly TestInventoryEvidenceEntry[];
  readonly diagnostics: readonly TestInventoryDiagnostic[];
};

export type MaterializationEvidence = {
  readonly sourcePath: string;
  readonly sourceDigest: string;
  readonly generatedPath: string;
  readonly materializedPath: string;
  readonly generatedDigest: string;
  readonly inventoryDigest: string;
  readonly commandId: string;
};

export type ProfileResolution = {
  readonly requirement: TestRequirement;
  readonly reasonCode:
    | "REQUIRED_AFFECTED"
    | "REQUIRED_COVERAGE"
    | "REQUIRED_PUBLISH"
    | "REQUIRED_SCHEDULED_LIVE"
    | "OPTIONAL_UNAFFECTED"
    | "OPTIONAL_SCHEDULED"
    | "PROFILE_EXCLUDES_LIVE"
    | "PROFILE_EXCLUDES_COVERAGE"
    | "PROFILE_EXCLUDES_FIDELITY_LANE"
    | "RELEASE_ONLY"
    | "UNAFFECTED_PACKAGING_SURFACE";
};

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_PATH = join(ROOT_DIR, "test-inventory.json");
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "lib",
  "out",
  ".turbo",
  ".cache",
  "coverage",
  ".nyc_output",
  "tmp",
  "temp",
  ".tmp",
  ".git",
  ".owx",
  "generated",
  "__generated__",
  "codegen-output",
  "fixture-output",
  "fixtures-output",
  "snapshots-output",
]);
const TEST_FILE_PATTERN = /\.(?:spec|test)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TYPESCRIPT_FAMILY_PATTERN = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION_PATTERN = /\.d\.(?:ts|mts|cts)$/;
const CORE_COVERAGE_OWNERS = new Set(CORE_COVERAGE_PACKAGES);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(
  code: TestInventoryDiagnosticCode,
  message: string,
  path?: string,
): TestInventoryDiagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

function toRepositoryPath(rootDir: string, absolutePath: string): string {
  return relative(rootDir, absolutePath).split(sep).join("/").normalize("NFC");
}

function hasCompileContractSegment(path: string): boolean {
  const segments = path.split("/");
  return segments.some(
    (segment, index) =>
      segment === "tests" && ["compile", "contracts"].includes(segments[index + 1] ?? ""),
  );
}

export function isAuthoredTestPath(path: string): boolean {
  return (
    TEST_FILE_PATTERN.test(path) ||
    (hasCompileContractSegment(path) &&
      TYPESCRIPT_FAMILY_PATTERN.test(path) &&
      !DECLARATION_PATTERN.test(path))
  );
}

function discoveryRoots(rootDir: string): readonly string[] {
  const roots: string[] = [];
  const packagesRoot = join(rootDir, "packages");
  if (existsSync(packagesRoot)) {
    for (const name of readdirSync(packagesRoot).sort()) {
      for (const child of ["src", "e2e"]) {
        const candidate = join(packagesRoot, name, child);
        if (existsSync(candidate)) roots.push(candidate);
      }
    }
    const templates = join(packagesRoot, "create-croco-app", "templates");
    if (existsSync(templates)) roots.push(templates);
  }
  for (const parent of ["apps", "examples"]) {
    const parentPath = join(rootDir, parent);
    if (!existsSync(parentPath)) continue;
    for (const name of readdirSync(parentPath).sort()) {
      const candidate = join(parentPath, name, "src");
      if (existsSync(candidate)) roots.push(candidate);
    }
  }
  for (const candidate of [join(rootDir, "scripts", "tests"), join(rootDir, "tests")]) {
    if (existsSync(candidate)) roots.push(candidate);
  }
  return [...new Set(roots.map((path) => resolve(path)))].sort();
}

function isWithinRoot(rootDir: string, target: string): boolean {
  const relation = relative(rootDir, target);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

export function ancestorDirectoriesWithinRoot(
  rootDir: string,
  absolutePath: string,
): readonly string[] | undefined {
  const ancestors: string[] = [];
  let current = dirname(absolutePath);
  while (current !== rootDir) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    ancestors.push(current);
    current = parent;
  }
  return ancestors;
}

export function validateRepositoryPath(path: string): TestInventoryDiagnostic | undefined {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("//") ||
    path !== path.normalize("NFC") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return diagnostic(
      "TEST_DISCOVERY_INVALID_PATH",
      `Invalid repository-relative NFC POSIX path: ${path}`,
      path,
    );
  }
  return undefined;
}

export function findCaseCollisionDiagnostics(
  paths: readonly string[],
): readonly TestInventoryDiagnostic[] {
  const diagnostics: TestInventoryDiagnostic[] = [];
  const caseFolded = new Map<string, string>();
  for (const path of [...paths].sort()) {
    const folded = path.toLowerCase();
    const previous = caseFolded.get(folded);
    if (previous !== undefined && previous !== path) {
      diagnostics.push(
        diagnostic(
          "TEST_DISCOVERY_CASE_COLLISION",
          `Case-folding collision between ${previous} and ${path}`,
          path,
        ),
      );
    } else {
      caseFolded.set(folded, path);
    }
  }
  return diagnostics;
}

export function discoverAuthoredTests(rootDir = ROOT_DIR): TestDiscoveryResult {
  const resolvedRoot = realpathSync(rootDir);
  const paths: string[] = [];
  const diagnostics: TestInventoryDiagnostic[] = [];

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const repositoryPath = toRepositoryPath(rootDir, absolutePath);
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        diagnostics.push(
          diagnostic(
            "TEST_DISCOVERY_SYMLINK",
            `Discovery does not traverse symlinks: ${repositoryPath}`,
            repositoryPath,
          ),
        );
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && isAuthoredTestPath(repositoryPath)) {
        const realPath = realpathSync(absolutePath);
        if (!isWithinRoot(resolvedRoot, realPath)) {
          diagnostics.push(
            diagnostic(
              "TEST_DISCOVERY_INVALID_PATH",
              `Test resolves outside repository: ${repositoryPath}`,
              repositoryPath,
            ),
          );
        } else {
          paths.push(repositoryPath);
        }
      }
    }
  };

  for (const root of discoveryRoots(rootDir)) {
    const stats = lstatSync(root);
    if (stats.isSymbolicLink()) {
      diagnostics.push(
        diagnostic(
          "TEST_DISCOVERY_SYMLINK",
          `Discovery root is a symlink: ${toRepositoryPath(rootDir, root)}`,
        ),
      );
    } else {
      visit(root);
    }
  }

  const sortedPaths = [...new Set(paths)].sort();
  diagnostics.push(...findCaseCollisionDiagnostics(sortedPaths));
  return { paths: sortedPaths, diagnostics };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
    throw new TypeError(`${label} keys must exactly match ${canonical.join(", ")}`);
  }
}

function parseGenerated(
  value: unknown,
  path: string,
  diagnostics: TestInventoryDiagnostic[],
): GeneratedTestMapping | undefined {
  const object = objectValue(value);
  if (!object) {
    diagnostics.push(
      diagnostic(
        "TEST_GENERATED_MAPPING_MISSING",
        `Generated-app entry lacks a generated mapping: ${path}`,
        path,
      ),
    );
    return undefined;
  }
  const sourcePath = object.sourcePath;
  const generatedPath = object.generatedPath;
  const commandId = object.commandId;
  if (
    typeof sourcePath !== "string" ||
    typeof generatedPath !== "string" ||
    typeof commandId !== "string" ||
    commandId.length === 0
  ) {
    diagnostics.push(
      diagnostic(
        "TEST_GENERATED_MAPPING_MISSING",
        `Generated mapping is incomplete: ${path}`,
        path,
      ),
    );
    return undefined;
  }
  if (
    sourcePath !== path ||
    validateRepositoryPath(sourcePath) ||
    validateRepositoryPath(generatedPath)
  ) {
    diagnostics.push(
      diagnostic(
        "TEST_GENERATED_MAPPING_MISMATCH",
        `Generated mapping does not match its canonical source: ${path}`,
        path,
      ),
    );
    return undefined;
  }
  return { sourcePath, generatedPath, commandId };
}

export function parseTestInventory(value: unknown): {
  inventory: TestInventory;
  diagnostics: readonly TestInventoryDiagnostic[];
} {
  const diagnostics: TestInventoryDiagnostic[] = [];
  const object = objectValue(value);
  if (!object || object.version !== TEST_INVENTORY_VERSION || !Array.isArray(object.tests)) {
    throw new TypeError("test-inventory.json must contain version 1 and a tests array");
  }
  const tests: TestInventoryEntry[] = [];
  for (const rawEntry of object.tests) {
    const entry = objectValue(rawEntry);
    if (!entry || typeof entry.path !== "string" || typeof entry.owner !== "string") {
      diagnostics.push(
        diagnostic(
          "TEST_DISCOVERY_INVALID_PATH",
          "Inventory entry must contain string path and owner",
        ),
      );
      continue;
    }
    const path = entry.path;
    const pathDiagnostic = validateRepositoryPath(path);
    if (pathDiagnostic) diagnostics.push(pathDiagnostic);
    if (!TEST_LANES.includes(entry.lane as TestLane)) {
      diagnostics.push(
        diagnostic(
          "TEST_INVENTORY_INVALID_LANE",
          `Unsupported lane ${String(entry.lane)} for ${path}`,
          path,
        ),
      );
      continue;
    }
    const lane = entry.lane as TestLane;
    const rawQualifiers = entry.qualifiers ?? [];
    if (
      !Array.isArray(rawQualifiers) ||
      rawQualifiers.some((qualifier) => !TEST_QUALIFIERS.includes(qualifier as TestQualifier))
    ) {
      diagnostics.push(
        diagnostic("TEST_INVENTORY_INVALID_QUALIFIER", `Unsupported qualifier for ${path}`, path),
      );
      continue;
    }
    const qualifiers = [...new Set(rawQualifiers as TestQualifier[])].sort();
    if (
      (qualifiers.includes("coverage") && !["fast", "integration"].includes(lane)) ||
      (qualifiers.includes("release-only") &&
        !["integration", "published", "generated-app", "live"].includes(lane))
    ) {
      diagnostics.push(
        diagnostic(
          "TEST_INVENTORY_INCOMPATIBLE_QUALIFIERS",
          `Incompatible qualifiers for ${lane} entry ${path}`,
          path,
        ),
      );
    }
    const generated =
      lane === "generated-app" ? parseGenerated(entry.generated, path, diagnostics) : undefined;
    if (lane !== "generated-app" && entry.generated !== undefined) {
      diagnostics.push(
        diagnostic(
          "TEST_GENERATED_MAPPING_MISMATCH",
          `Only generated-app entries may declare generated mappings: ${path}`,
          path,
        ),
      );
    }
    tests.push({ path, lane, qualifiers, owner: entry.owner, ...(generated ? { generated } : {}) });
  }

  const exceptions: TestInventoryException[] = [];
  if (object.exceptions !== undefined && !Array.isArray(object.exceptions)) {
    diagnostics.push(
      diagnostic("TEST_INVENTORY_INVALID_EXCEPTION", "Inventory exceptions must be an array"),
    );
  }
  for (const rawException of Array.isArray(object.exceptions) ? object.exceptions : []) {
    const exception = objectValue(rawException);
    if (
      !exception ||
      typeof exception.path !== "string" ||
      exception.kind !== "non-executable-fixture" ||
      typeof exception.reason !== "string" ||
      exception.reason.trim().length === 0 ||
      typeof exception.owner !== "string"
    ) {
      diagnostics.push(
        diagnostic(
          "TEST_INVENTORY_INVALID_EXCEPTION",
          "Malformed non-executable-fixture exception",
        ),
      );
      continue;
    }
    const pathDiagnostic = validateRepositoryPath(exception.path);
    if (pathDiagnostic || !/(?:^|\/)(?:fixture|fixtures)(?:\/|[-_.])/i.test(exception.path)) {
      diagnostics.push(
        diagnostic(
          "TEST_INVENTORY_INVALID_EXCEPTION",
          `Exception is not an exact non-executable fixture: ${exception.path}`,
          exception.path,
        ),
      );
      continue;
    }
    exceptions.push({
      path: exception.path,
      kind: "non-executable-fixture",
      reason: exception.reason.trim(),
      owner: exception.owner,
    });
  }
  return { inventory: { version: 1, tests, exceptions }, diagnostics };
}

export function parseStrictTestInventory(value: unknown): TestInventory {
  const object = objectValue(value);
  if (!object) throw new TypeError("test inventory must be an object");
  assertExactObjectKeys(object, ["version", "tests", "exceptions"], "test inventory");
  if (object.version !== TEST_INVENTORY_VERSION) {
    throw new TypeError(`test inventory version must be ${TEST_INVENTORY_VERSION}`);
  }
  if (!Array.isArray(object.tests) || !Array.isArray(object.exceptions)) {
    throw new TypeError("test inventory tests and exceptions must be arrays");
  }
  object.tests.forEach((value, index) => {
    const entry = objectValue(value);
    if (!entry) throw new TypeError(`test inventory tests[${index}] must be an object`);
    const generated = entry.lane === "generated-app";
    assertExactObjectKeys(
      entry,
      generated
        ? ["path", "lane", "qualifiers", "owner", "generated"]
        : ["path", "lane", "qualifiers", "owner"],
      `test inventory tests[${index}]`,
    );
    if (typeof entry.owner !== "string" || entry.owner.trim().length === 0) {
      throw new TypeError(`test inventory tests[${index}].owner must be non-empty`);
    }
    if (generated) {
      const mapping = objectValue(entry.generated);
      if (!mapping)
        throw new TypeError(`test inventory tests[${index}].generated must be an object`);
      assertExactObjectKeys(
        mapping,
        ["sourcePath", "generatedPath", "commandId"],
        `test inventory tests[${index}].generated`,
      );
    }
  });
  object.exceptions.forEach((value, index) => {
    const exception = objectValue(value);
    if (!exception) throw new TypeError(`test inventory exceptions[${index}] must be an object`);
    assertExactObjectKeys(
      exception,
      ["path", "kind", "reason", "owner"],
      `test inventory exceptions[${index}]`,
    );
    if (typeof exception.owner !== "string" || exception.owner.trim().length === 0) {
      throw new TypeError(`test inventory exceptions[${index}].owner must be non-empty`);
    }
  });
  const parsed = parseTestInventory(object);
  if (parsed.diagnostics.length > 0) {
    throw new TypeError(
      `test inventory diagnostics are not empty: ${JSON.stringify(parsed.diagnostics)}`,
    );
  }
  return canonicalInventory(parsed.inventory);
}

export function parseMaterializationEvidence(
  value: unknown,
  expectedInventoryDigest?: string,
): readonly MaterializationEvidence[] {
  const repositoryPath = (value: unknown, index: number, field: string): string => {
    if (typeof value !== "string" || validateRepositoryPath(value)) {
      throw new TypeError(`materialization evidence[${index}].${field} must be a repository path`);
    }
    return value;
  };
  const sha256Digest = (value: unknown, index: number, field: string): string => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw new TypeError(`materialization evidence[${index}].${field} must be a SHA-256 digest`);
    }
    return value;
  };
  const commandIdentifier = (value: unknown, index: number): string => {
    if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
      throw new TypeError(`materialization evidence[${index}].commandId must be non-empty`);
    }
    return value;
  };
  if (!Array.isArray(value)) throw new TypeError("materialization evidence must be an array");
  const parsed = value.map((value, index): MaterializationEvidence => {
    const entry = objectValue(value);
    if (!entry) throw new TypeError(`materialization evidence[${index}] must be an object`);
    assertExactObjectKeys(
      entry,
      [
        "sourcePath",
        "sourceDigest",
        "generatedPath",
        "materializedPath",
        "generatedDigest",
        "inventoryDigest",
        "commandId",
      ],
      `materialization evidence[${index}]`,
    );
    const sourcePath = repositoryPath(entry.sourcePath, index, "sourcePath");
    const generatedPath = repositoryPath(entry.generatedPath, index, "generatedPath");
    const materializedPath = repositoryPath(entry.materializedPath, index, "materializedPath");
    const sourceDigest = sha256Digest(entry.sourceDigest, index, "sourceDigest");
    const generatedDigest = sha256Digest(entry.generatedDigest, index, "generatedDigest");
    const materializationInventoryDigest = sha256Digest(
      entry.inventoryDigest,
      index,
      "inventoryDigest",
    );
    const commandId = commandIdentifier(entry.commandId, index);
    if (
      expectedInventoryDigest !== undefined &&
      materializationInventoryDigest !== expectedInventoryDigest
    ) {
      throw new TypeError(
        `materialization evidence[${index}].inventoryDigest does not match the inventory`,
      );
    }
    return {
      sourcePath,
      sourceDigest,
      generatedPath,
      materializedPath,
      generatedDigest,
      inventoryDigest: materializationInventoryDigest,
      commandId,
    };
  });
  const sourcePaths = parsed.map(({ sourcePath }) => sourcePath);
  const materializedPaths = parsed.map(({ materializedPath }) => materializedPath);
  if (
    new Set(sourcePaths).size !== sourcePaths.length ||
    new Set(materializedPaths).size !== materializedPaths.length
  ) {
    throw new TypeError("materialization evidence source and artifact paths must be unique");
  }
  return [...parsed].sort((left, right) => compareText(left.sourcePath, right.sourcePath));
}

export function readTestInventory(path = INVENTORY_PATH): {
  inventory: TestInventory;
  diagnostics: readonly TestInventoryDiagnostic[];
} {
  return parseTestInventory(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function canonicalInventory(inventory: TestInventory): TestInventory {
  return {
    version: 1,
    tests: [...inventory.tests]
      .map((entry) => ({ ...entry, qualifiers: [...entry.qualifiers].sort() }))
      .sort((left, right) => compareText(left.path, right.path)),
    exceptions: [...inventory.exceptions].sort((left, right) => compareText(left.path, right.path)),
  };
}

export function inventoryDigest(inventory: TestInventory): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalInventory(inventory)))
    .digest("hex");
}

export function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function expectedOwnerForPath(rootDir: string, path: string): string | undefined {
  if (path.startsWith("packages/create-croco-app/templates/")) return "create-croco-app";
  if (path.startsWith("scripts/tests/")) return "repo:ci";
  if (path.startsWith("examples/")) return "repo:examples";
  if (path.startsWith("tests/")) return "repo:tests";
  const match = /^(?:packages|apps)\/([^/]+)\//.exec(path);
  if (!match?.[1]) return undefined;
  const manifestPath = join(
    rootDir,
    path.startsWith("packages/") ? "packages" : "apps",
    match[1],
    "package.json",
  );
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
  return typeof manifest.name === "string" ? manifest.name : undefined;
}

function validateDeclaredFile(
  rootDir: string,
  path: string,
  code: TestInventoryDiagnosticCode,
): TestInventoryDiagnostic | undefined {
  const repositoryRoot = resolve(rootDir);
  const absolutePath = resolve(repositoryRoot, path);
  if (!isWithinRoot(repositoryRoot, absolutePath) || !existsSync(absolutePath)) {
    return diagnostic(code, `Declared path does not exist: ${path}`, path);
  }
  const stats = lstatSync(absolutePath);
  if (stats.isSymbolicLink())
    return diagnostic("TEST_DISCOVERY_SYMLINK", `Declared path is a symlink: ${path}`, path);
  const ancestors = ancestorDirectoriesWithinRoot(repositoryRoot, absolutePath);
  if (!ancestors) {
    return diagnostic(code, `Declared path escapes repository root: ${path}`, path);
  }
  for (const ancestor of ancestors) {
    if (lstatSync(ancestor).isSymbolicLink())
      return diagnostic(
        "TEST_DISCOVERY_SYMLINK",
        `Declared path contains a symlink: ${path}`,
        path,
      );
  }
  return undefined;
}

export function isSelectedByVitestScript(testScript: string, testPath: string): boolean {
  const stripQuotes = (value: string): string => value.replace(/^(?:"([^"]*)"|'([^']*)')$/, "$1$2");
  const vitestRunIndex = testScript.search(/(?:^|\s)vitest run(?:\s|$)/);
  if (vitestRunIndex < 0) return false;
  const vitestCommand = testScript.slice(vitestRunIndex).trimStart();
  const excludedPaths = [...vitestCommand.matchAll(/--exclude\s+([^\s]+)/g)].map((match) =>
    stripQuotes(match[1] ?? ""),
  );
  if (
    excludedPaths.some((excluded) => {
      const prefix = excluded.replace(/\*\*.*$/, "").replace(/\*.*$/, "");
      return prefix.length > 0 && testPath.startsWith(prefix);
    })
  ) {
    return false;
  }
  const tokens = vitestCommand
    .replace(/^vitest run(?:\s|$)/, "")
    .split(/\s+/)
    .map(stripQuotes);
  const selectors = tokens.filter((token, index) => {
    if (!token || token.startsWith("-")) return false;
    const previous = tokens[index - 1];
    if (previous === "--exclude" || previous === "--config" || previous === "--reporter") {
      return false;
    }
    return token.includes("/") || token.includes(".spec.") || token.includes(".test.");
  });
  if (selectors.length === 0) return true;
  return selectors.some((selector) => {
    const wildcardIndex = selector.search(/[?*[\]{}]/);
    if (wildcardIndex >= 0) return testPath.startsWith(selector.slice(0, wildcardIndex));
    return selector.includes(".spec.") || selector.includes(".test.")
      ? testPath === selector
      : testPath.startsWith(`${selector}/`);
  });
}

function isDeclaredExecutableTest(rootDir: string, path: string): boolean {
  if (path.startsWith("packages/create-croco-app/templates/")) return false;
  if (path.startsWith("scripts/tests/") || path.startsWith("tests/")) return true;
  const workspace = /^(packages|apps|examples)\/([^/]+)\/(.+)$/.exec(path);
  if (!workspace?.[1] || !workspace[2] || !workspace[3]) return false;
  const manifestPath = join(rootDir, workspace[1], workspace[2], "package.json");
  if (!existsSync(manifestPath)) return false;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly scripts?: Readonly<Record<string, unknown>>;
  };
  return Object.entries(manifest.scripts ?? {}).some(
    ([name, command]) =>
      /^test(?::|$)/.test(name) &&
      typeof command === "string" &&
      isSelectedByVitestScript(command, workspace[3]),
  );
}

export function validateTestInventory(
  rootDir: string,
  inventory: TestInventory,
  parseDiagnostics: readonly TestInventoryDiagnostic[] = [],
): TestInventoryReport {
  const discovery = discoverAuthoredTests(rootDir);
  const diagnostics = [...parseDiagnostics, ...discovery.diagnostics];
  const pathCounts = new Map<string, number>();
  for (const entry of inventory.tests)
    pathCounts.set(entry.path, (pathCounts.get(entry.path) ?? 0) + 1);
  for (const exception of inventory.exceptions)
    pathCounts.set(exception.path, (pathCounts.get(exception.path) ?? 0) + 1);
  for (const [path, count] of pathCounts) {
    if (count > 1)
      diagnostics.push(
        diagnostic(
          "TEST_INVENTORY_DUPLICATE_PATH",
          `Path is declared ${count} times: ${path}`,
          path,
        ),
      );
  }

  const discovered = new Set(discovery.paths);
  const declared = new Set(inventory.tests.map(({ path }) => path));
  const excepted = new Set(inventory.exceptions.map(({ path }) => path));
  for (const path of discovery.paths) {
    if (!declared.has(path) && !excepted.has(path))
      diagnostics.push(
        diagnostic("TEST_INVENTORY_ORPHAN", `Discovered test lacks a declaration: ${path}`, path),
      );
  }
  for (const entry of inventory.tests) {
    const missing = validateDeclaredFile(rootDir, entry.path, "TEST_INVENTORY_MISSING_FILE");
    if (missing) diagnostics.push(missing);
    else if (!discovered.has(entry.path))
      diagnostics.push(
        diagnostic(
          "TEST_INVENTORY_MISSING_FILE",
          `Declared path is outside authored-test discovery: ${entry.path}`,
          entry.path,
        ),
      );
    const expectedOwner = expectedOwnerForPath(rootDir, entry.path);
    if (expectedOwner === undefined || entry.owner !== expectedOwner) {
      diagnostics.push(
        diagnostic(
          "TEST_INVENTORY_INVALID_OWNER",
          `Expected owner ${expectedOwner ?? "<none>"}, received ${entry.owner}`,
          entry.path,
        ),
      );
    }
  }
  for (const exception of inventory.exceptions) {
    const missing = validateDeclaredFile(rootDir, exception.path, "TEST_INVENTORY_STALE_EXCEPTION");
    const absolutePath = resolve(rootDir, exception.path);
    if (!missing && lstatSync(absolutePath).isDirectory()) {
      diagnostics.push(
        diagnostic(
          "TEST_INVENTORY_INVALID_EXCEPTION",
          `Directories cannot be inventory exceptions: ${exception.path}`,
          exception.path,
        ),
      );
    } else if (missing || !discovered.has(exception.path)) {
      diagnostics.push(
        missing ??
          diagnostic(
            "TEST_INVENTORY_STALE_EXCEPTION",
            `Exception no longer identifies a discovered test: ${exception.path}`,
            exception.path,
          ),
      );
    }
    if (!missing && isDeclaredExecutableTest(rootDir, exception.path)) {
      diagnostics.push(
        diagnostic(
          "TEST_INVENTORY_INVALID_EXCEPTION",
          `Executable tests cannot be inventory exceptions: ${exception.path}`,
          exception.path,
        ),
      );
    }
    const expectedOwner = expectedOwnerForPath(rootDir, exception.path);
    if (expectedOwner === undefined || exception.owner !== expectedOwner) {
      diagnostics.push(
        diagnostic(
          "TEST_INVENTORY_INVALID_OWNER",
          `Expected owner ${expectedOwner ?? "<none>"}, received ${exception.owner}`,
          exception.path,
        ),
      );
    }
  }

  const digest = inventoryDigest(inventory);
  return {
    schemaVersion: "croco.test-inventory-report/v1",
    valid: diagnostics.length === 0,
    inventoryVersion: 1,
    inventoryDigest: digest,
    discoveredPaths: discovery.paths,
    resolvedEntries: canonicalInventory(inventory).tests,
    exceptions: canonicalInventory(inventory).exceptions,
    generatedMappings: canonicalInventory(inventory).tests.flatMap(({ generated }) =>
      generated ? [generated] : [],
    ),
    diagnostics: diagnostics.sort((left, right) =>
      compareText(`${left.path ?? ""}:${left.code}`, `${right.path ?? ""}:${right.code}`),
    ),
  };
}

export function validateExecutedPaths(
  inventory: TestInventory,
  executedPaths: readonly string[],
): readonly TestInventoryDiagnostic[] {
  const declared = new Set(inventory.tests.map(({ path }) => path));
  return [...new Set(executedPaths)]
    .sort()
    .flatMap((path) =>
      declared.has(path)
        ? []
        : [
            diagnostic(
              "TEST_INVENTORY_UNDECLARED_EXECUTION",
              `Executed test is not declared: ${path}`,
              path,
            ),
          ],
    );
}

export function resolveTestProfile(
  entry: Pick<TestInventoryEntry, "lane" | "qualifiers">,
  profile: TestProfile,
  options: { readonly affected?: boolean; readonly packagingSurfaceAffected?: boolean } = {},
): ProfileResolution {
  if (entry.lane === "live") {
    return profile === "scheduled-live"
      ? { requirement: "R", reasonCode: "REQUIRED_SCHEDULED_LIVE" }
      : { requirement: "N/A", reasonCode: "PROFILE_EXCLUDES_LIVE" };
  }
  if (entry.qualifiers.includes("release-only")) {
    return profile === "publish"
      ? { requirement: "R", reasonCode: "REQUIRED_PUBLISH" }
      : { requirement: "N/A", reasonCode: "RELEASE_ONLY" };
  }
  if (entry.qualifiers.includes("coverage")) {
    if (profile === "scheduled-live") {
      return { requirement: "N/A", reasonCode: "PROFILE_EXCLUDES_COVERAGE" };
    }
    if (profile === "publish") return { requirement: "R", reasonCode: "REQUIRED_PUBLISH" };
    return options.affected
      ? { requirement: "R", reasonCode: "REQUIRED_COVERAGE" }
      : { requirement: "O", reasonCode: "OPTIONAL_UNAFFECTED" };
  }
  if (profile === "publish") return { requirement: "R", reasonCode: "REQUIRED_PUBLISH" };
  if (profile === "scheduled-live") {
    return ["fast", "integration"].includes(entry.lane)
      ? { requirement: "O", reasonCode: "OPTIONAL_SCHEDULED" }
      : { requirement: "N/A", reasonCode: "PROFILE_EXCLUDES_FIDELITY_LANE" };
  }
  if (entry.lane === "published") {
    return options.packagingSurfaceAffected
      ? { requirement: "R", reasonCode: "REQUIRED_AFFECTED" }
      : { requirement: "N/A", reasonCode: "UNAFFECTED_PACKAGING_SURFACE" };
  }
  if (entry.lane === "generated-app") {
    return options.affected
      ? { requirement: "R", reasonCode: "REQUIRED_AFFECTED" }
      : { requirement: "N/A", reasonCode: "UNAFFECTED_PACKAGING_SURFACE" };
  }
  return options.affected
    ? { requirement: "R", reasonCode: "REQUIRED_AFFECTED" }
    : { requirement: "O", reasonCode: "OPTIONAL_UNAFFECTED" };
}

export function createTestInventoryEvidenceReport(
  inventory: TestInventory,
  profile: TestProfile,
  options: {
    readonly affectedOwners?: readonly string[];
    readonly packagingSurfaceOwners?: readonly string[];
    readonly requiredGeneratedPaths?: readonly string[];
    readonly executedPaths?: readonly string[];
    readonly enforce?: boolean;
    readonly liveCredentialsAvailable?: boolean;
  } = {},
): TestInventoryEvidenceReport {
  const executedPaths = [...new Set(options.executedPaths ?? [])].sort();
  const executed = new Set(executedPaths);
  const affectedOwners = new Set(options.affectedOwners ?? []);
  const packagingSurfaceOwners = new Set(options.packagingSurfaceOwners ?? []);
  const requiredGeneratedPaths = options.requiredGeneratedPaths
    ? new Set(options.requiredGeneratedPaths)
    : undefined;
  const diagnostics = [...validateExecutedPaths(inventory, executedPaths)];
  const entries = canonicalInventory(inventory).tests.map((entry): TestInventoryEvidenceEntry => {
    const resolution =
      entry.lane === "generated-app" && requiredGeneratedPaths
        ? requiredGeneratedPaths.has(entry.path)
          ? { requirement: "R" as const, reasonCode: "REQUIRED_AFFECTED" as const }
          : {
              requirement: "N/A" as const,
              reasonCode: "UNAFFECTED_PACKAGING_SURFACE" as const,
            }
        : resolveTestProfile(entry, profile, {
            affected: affectedOwners.has(entry.owner),
            packagingSurfaceAffected: packagingSurfaceOwners.has(entry.owner),
          });
    if (executed.has(entry.path)) {
      return {
        ...entry,
        requirement: resolution.requirement,
        state: "executed",
        reasonCode: "EXECUTED",
      };
    }
    if (options.enforce && resolution.requirement === "R") {
      diagnostics.push(
        diagnostic(
          entry.lane === "live" && options.liveCredentialsAvailable === false
            ? "TEST_LIVE_CREDENTIALS_MISSING"
            : "TEST_EVIDENCE_MISSING_REQUIRED",
          entry.lane === "live" && options.liveCredentialsAvailable === false
            ? `Required live credentials or resources are unavailable: ${entry.path}`
            : `Required test execution evidence is missing: ${entry.path}`,
          entry.path,
        ),
      );
    }
    return {
      ...entry,
      requirement: resolution.requirement,
      state: "not-run",
      reasonCode: resolution.reasonCode,
    };
  });
  return {
    mode: options.enforce ? "enforced" : "report-only",
    profile,
    inventoryVersion: 1,
    inventoryDigest: inventoryDigest(inventory),
    entries,
    diagnostics: diagnostics.sort((left, right) =>
      compareText(`${left.path ?? ""}:${left.code}`, `${right.path ?? ""}:${right.code}`),
    ),
  };
}

export function validateGeneratedMaterialization(
  rootDir: string,
  inventory: TestInventory,
  generatedRoot: string,
  evidence: readonly MaterializationEvidence[],
  requiredSourcePaths: ReadonlySet<string> = new Set(
    inventory.tests.filter(({ lane }) => lane === "generated-app").map(({ path }) => path),
  ),
): readonly TestInventoryDiagnostic[] {
  const digest = inventoryDigest(inventory);
  const entries = new Map(
    inventory.tests
      .filter(({ lane }) => lane === "generated-app")
      .map((entry) => [entry.path, entry]),
  );
  const diagnostics: TestInventoryDiagnostic[] = [];
  const evidenced = new Set<string>();
  for (const item of evidence) {
    const entry = entries.get(item.sourcePath);
    if (!entry) {
      diagnostics.push(
        diagnostic(
          "TEST_GENERATED_EXECUTION_UNDECLARED",
          `Generated execution has no canonical inventory entry: ${item.sourcePath}`,
          item.sourcePath,
        ),
      );
      continue;
    }
    evidenced.add(item.sourcePath);
    if (!entry.generated) {
      diagnostics.push(
        diagnostic(
          "TEST_GENERATED_MAPPING_MISSING",
          `Generated mapping is missing: ${item.sourcePath}`,
          item.sourcePath,
        ),
      );
      continue;
    }
    const sourcePath = join(rootDir, item.sourcePath);
    if (!existsSync(sourcePath) || item.sourceDigest !== fileDigest(sourcePath)) {
      diagnostics.push(
        diagnostic(
          "TEST_GENERATED_SOURCE_DIGEST_MISMATCH",
          `Source is missing or its digest is stale: ${item.sourcePath}`,
          item.sourcePath,
        ),
      );
    }
    if (
      item.generatedPath !== entry.generated.generatedPath ||
      item.commandId !== entry.generated.commandId ||
      item.inventoryDigest !== digest
    ) {
      diagnostics.push(
        diagnostic(
          "TEST_GENERATED_MAPPING_MISMATCH",
          `Materialization provenance does not match inventory: ${item.sourcePath}`,
          item.sourcePath,
        ),
      );
    }
    const materializedPath = resolve(generatedRoot, item.materializedPath);
    if (
      !isWithinRoot(resolve(generatedRoot), materializedPath) ||
      !existsSync(materializedPath) ||
      item.generatedDigest !== fileDigest(materializedPath)
    ) {
      diagnostics.push(
        diagnostic(
          "TEST_GENERATED_MAPPING_MISMATCH",
          `Materialized destination is missing or has a stale digest: ${item.materializedPath}`,
          item.sourcePath,
        ),
      );
    }
  }
  for (const entry of entries.values()) {
    if (requiredSourcePaths.has(entry.path) && !evidenced.has(entry.path)) {
      diagnostics.push(
        diagnostic(
          "TEST_GENERATED_MAPPING_MISSING",
          `Generated-app entry lacks materialization evidence: ${entry.path}`,
          entry.path,
        ),
      );
    }
  }
  return diagnostics;
}

function generatedPathForTemplate(path: string): string {
  const prefix = "packages/create-croco-app/templates/";
  const remainder = path.slice(prefix.length);
  return remainder.slice(remainder.indexOf("/") + 1);
}

export function classifyDiscoveredTest(rootDir: string, path: string): TestInventoryEntry {
  const lower = path.toLowerCase();
  let lane: TestLane = "fast";
  if (path.startsWith("scripts/tests/")) lane = "fast";
  else if (path.startsWith("packages/create-croco-app/templates/")) lane = "generated-app";
  else if (
    /(?:^|[/._-])(?:live|provider-certification|provider-e2e)(?:[/._-]|$)/.test(lower) ||
    /(?:\.postgres\.spec|redismetering\.integration|timescalemetricsstore\.integration|migrationstatuspostgres|testing-resources\/.*\/realresources|livesmoke)/.test(
      lower,
    )
  )
    lane = "live";
  else if (/(?:published|packed-consumer|package-entrypoint|publish-contract)/.test(lower))
    lane = "published";
  else if (/(?:^|[/._-])(?:integration|e2e|journeys?)(?:[/._-]|$)/.test(lower))
    lane = "integration";
  const owner = expectedOwnerForPath(rootDir, path);
  if (!owner) throw new Error(`Cannot resolve owner for ${path}`);
  const qualifiers: TestQualifier[] =
    CORE_COVERAGE_OWNERS.has(owner) &&
    ["fast", "integration"].includes(lane) &&
    !(owner === "@croco/cli" && lane === "integration")
      ? ["coverage"]
      : [];
  return {
    path,
    lane,
    qualifiers,
    owner,
    ...(lane === "generated-app"
      ? {
          generated: {
            sourcePath: path,
            generatedPath: generatedPathForTemplate(path),
            commandId: "create-croco-app",
          },
        }
      : {}),
  };
}

export function createInventoryFromDiscovery(rootDir = ROOT_DIR): TestInventory {
  const discovery = discoverAuthoredTests(rootDir);
  if (discovery.diagnostics.length > 0) throw new Error(JSON.stringify(discovery.diagnostics));
  return canonicalInventory({
    version: 1,
    tests: discovery.paths.map((path) => classifyDiscoveredTest(rootDir, path)),
    exceptions: [],
  });
}

function renderInventory(inventory: TestInventory): string {
  return `${JSON.stringify(canonicalInventory(inventory), null, 2)}\n`;
}

function parseArguments(args: readonly string[]): {
  check: boolean;
  write: boolean;
  json: boolean;
  enforceEvidence: boolean;
  liveCredentialsAvailable: boolean;
  affectedOwners: readonly string[];
  packagingSurfaceOwners: readonly string[];
  profile?: TestProfile;
  executedPathsFile?: string;
  materializationFile?: string;
  generatedRoot?: string;
  output?: string;
} {
  let check = false;
  let write = false;
  let json = false;
  let enforceEvidence = false;
  let liveCredentialsAvailable = false;
  const affectedOwners: string[] = [];
  const packagingSurfaceOwners: string[] = [];
  let profile: TestProfile | undefined;
  let executedPathsFile: string | undefined;
  let materializationFile: string | undefined;
  let generatedRoot: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") check = true;
    else if (argument === "--write") write = true;
    else if (argument === "--json") json = true;
    else if (argument === "--enforce-evidence") enforceEvidence = true;
    else if (argument === "--live-credentials-available") liveCredentialsAvailable = true;
    else if (argument === "--profile") {
      const value = args[index + 1];
      if (!value || !TEST_PROFILES.includes(value as TestProfile)) {
        throw new Error(`--profile requires one of: ${TEST_PROFILES.join(", ")}`);
      }
      profile = value as TestProfile;
      index += 1;
    } else if (argument === "--executed-paths") {
      executedPathsFile = args[index + 1];
      if (!executedPathsFile) throw new Error("--executed-paths requires a JSON file");
      index += 1;
    } else if (argument === "--affected-owner") {
      const owner = args[index + 1];
      if (!owner) throw new Error("--affected-owner requires an owner");
      affectedOwners.push(owner);
      index += 1;
    } else if (argument === "--packaging-surface-owner") {
      const owner = args[index + 1];
      if (!owner) throw new Error("--packaging-surface-owner requires an owner");
      packagingSurfaceOwners.push(owner);
      index += 1;
    } else if (argument === "--materialization-evidence") {
      materializationFile = args[index + 1];
      if (!materializationFile) throw new Error("--materialization-evidence requires a JSON file");
      index += 1;
    } else if (argument === "--generated-root") {
      generatedRoot = args[index + 1];
      if (!generatedRoot) throw new Error("--generated-root requires a path");
      index += 1;
    } else if (argument === "--output") {
      output = args[index + 1];
      if (!output) throw new Error("--output requires a path");
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (check && write) throw new Error("--check and --write are mutually exclusive");
  if (enforceEvidence && !profile) throw new Error("--enforce-evidence requires --profile");
  if ((materializationFile === undefined) !== (generatedRoot === undefined)) {
    throw new Error("--materialization-evidence and --generated-root must be used together");
  }
  return {
    check: check || !write,
    write,
    json,
    enforceEvidence,
    liveCredentialsAvailable,
    affectedOwners,
    packagingSurfaceOwners,
    ...(profile ? { profile } : {}),
    ...(executedPathsFile ? { executedPathsFile } : {}),
    ...(materializationFile ? { materializationFile } : {}),
    ...(generatedRoot ? { generatedRoot } : {}),
    ...(output ? { output } : {}),
  };
}

export function runTestInventoryCli(args: readonly string[], rootDir = ROOT_DIR): number {
  const options = parseArguments(args);
  const inventoryPath = join(rootDir, "test-inventory.json");
  if (options.write) {
    const inventory = createInventoryFromDiscovery(rootDir);
    writeFileSync(inventoryPath, renderInventory(inventory));
  }
  const { inventory, diagnostics } = readTestInventory(inventoryPath);
  const structuralReport = validateTestInventory(rootDir, inventory, diagnostics);
  const executedPaths = options.executedPathsFile
    ? (JSON.parse(readFileSync(resolve(rootDir, options.executedPathsFile), "utf8")) as unknown)
    : [];
  if (!Array.isArray(executedPaths) || executedPaths.some((path) => typeof path !== "string")) {
    throw new Error("--executed-paths must contain a JSON string array");
  }
  const evidence = options.profile
    ? createTestInventoryEvidenceReport(inventory, options.profile, {
        affectedOwners: options.affectedOwners,
        packagingSurfaceOwners: options.packagingSurfaceOwners,
        executedPaths: executedPaths as string[],
        enforce: options.enforceEvidence,
        liveCredentialsAvailable: options.liveCredentialsAvailable,
      })
    : undefined;
  const materializationDiagnostics = options.materializationFile
    ? validateGeneratedMaterialization(
        rootDir,
        inventory,
        resolve(rootDir, options.generatedRoot ?? ""),
        JSON.parse(
          readFileSync(resolve(rootDir, options.materializationFile), "utf8"),
        ) as MaterializationEvidence[],
      )
    : [];
  const combinedDiagnostics = [
    ...structuralReport.diagnostics,
    ...(evidence?.diagnostics ?? []),
    ...materializationDiagnostics,
  ].sort((left, right) =>
    compareText(`${left.path ?? ""}:${left.code}`, `${right.path ?? ""}:${right.code}`),
  );
  const report: TestInventoryReport = {
    ...structuralReport,
    valid: combinedDiagnostics.length === 0,
    ...(evidence ? { evidence } : {}),
    diagnostics: combinedDiagnostics,
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputPath = resolve(rootDir, options.output);
    if (!isWithinRoot(resolve(rootDir), outputPath))
      throw new Error("--output must remain inside the repository");
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, rendered);
  }
  if (options.json) process.stdout.write(rendered);
  else if (!report.valid)
    for (const item of report.diagnostics) process.stderr.write(`${item.code}: ${item.message}\n`);
  else
    process.stdout.write(
      `test inventory valid (${report.resolvedEntries.length} tests, ${report.inventoryDigest})\n`,
    );
  return report.valid ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url))
  process.exitCode = runTestInventoryCli(process.argv.slice(2));
