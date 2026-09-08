import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const scriptPath = resolve(__dirname, "../package-docs-check.mts");
const scriptTestTimeout = 30_000;
const tempRoots: string[] = [];

vi.setConfig({ testTimeout: scriptTestTimeout });

type ScriptResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
};

describe("package-docs-check.mts", () => {
  afterAll(() => {
    vi.resetConfig();
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["README.md", ["   ```bash", "   pnpm nonexistent-readme", "   ```"]],
    ["CONTRIBUTING.md", ["> ```bash", "> pnpm run nonexistent-contributing", "> ```"]],
    ["AGENTS.md", ["Run `pnpm nonexistent-agents` before pushing."]],
    [
      "RELEASING.md",
      ["- ```bash", "  pnpm docs:catalog:check && pnpm nonexistent-releasing", "  ```"],
    ],
  ])("rejects nonexistent pnpm scripts in %s Markdown containers", (docsPath, lines) => {
    const root = createCommandValidationRoot();
    const existingContent =
      docsPath === "README.md"
        ? readFileSync(join(root, docsPath), "utf-8")
        : "# Command fixture\n";
    writeFileSync(join(root, docsPath), [existingContent.trimEnd(), "", ...lines, ""].join("\n"));

    const result = runScript(root, "--check");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${docsPath}: documented command \`pnpm nonexistent-`);
  });

  it("allows pnpm builtins and package-local scripts outside the repository root", () => {
    const root = createCommandValidationRoot();
    writeFileSync(
      join(root, "CONTRIBUTING.md"),
      [
        "# Command fixture",
        "",
        "```bash",
        "pnpm add example",
        "pnpm audit",
        "pnpm dlx example",
        "pnpm update",
        "pnpm --dir packages/alpha package-only",
        "pnpm --filter @croco/alpha package-only",
        "cd packages/alpha",
        "pnpm package-only",
        "cd ../..",
        "pnpm docs:catalog:check",
        "```",
        "",
      ].join("\n"),
    );

    const writeResult = runScript(root, "--write");
    expect(writeResult.status, writeResult.stdout).toBe(0);
  });

  it("requires explicit pnpm run commands even when the script name is a pnpm builtin", () => {
    const root = createCommandValidationRoot();
    writeFileSync(
      join(root, "CONTRIBUTING.md"),
      ["# Command fixture", "", "```bash", "pnpm run deploy", "```", ""].join("\n"),
    );

    const result = runScript(root, "--check");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "CONTRIBUTING.md: documented command `pnpm deploy` is not defined in package.json#scripts",
    );
  });

  it("rejects a public package without canonical role metadata", () => {
    const root = createCommandValidationRoot();
    const path = join(root, "docs/package-catalog.json");
    const catalog = JSON.parse(readFileSync(path, "utf-8"));
    delete catalog.packageRoles;
    writeJson(path, catalog);
    const result = runScript(root, "--write");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("packageRoles");
  });

  it("rejects drift in the canonical role map shipped with generated applications", () => {
    const root = createCommandValidationRoot();
    const written = runScript(root, "--write");
    expect(written.status, written.stdout).toBe(0);
    const path = join(root, "packages/create-croco-app/src/data/package-roles.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "@croco/alpha": "contracts" });
    writeJson(path, { "@croco/alpha": "plugins" });
    const checked = runScript(root, "--check");
    expect(checked.status).toBe(1);
    expect(checked.stdout).toContain("canonical role drift detected");
  });

  it("writes the README package catalog and documentation report from package manifests", () => {
    const root = createTempRoot();
    writePackage(root, "alpha", { name: "@croco/alpha" });
    writePackage(root, "beta", { name: "@croco/beta" });
    writeCatalogMetadata(root, ["alpha", "beta"]);
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["alpha", "beta"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");
    const readme = readFileSync(join(root, "README.md"), "utf-8");
    const report = readFileSync(join(root, "docs", "package-docs-report.md"), "utf-8");
    const matrix = readFileSync(
      join(
        root,
        "packages",
        "docs",
        "src",
        "content",
        "docs",
        "en",
        "reference",
        "extension-matrix.md",
      ),
      "utf-8",
    );

    expect(result.status).toBe(0);
    expect(readme).toContain("<!-- CROCO:PACKAGE-CATALOG:START -->");
    expect(readme).toContain("현재 카탈로그는 **2개 public package**");
    expect(readme).toContain("Croco 1.0 Spine");
    expect(readme).toContain("Canonical Package Roles");
    expect(readme).toContain("Contracts");
    expect(readme).toContain("release-critical compatibility scope");
    expect(readme).toContain(
      "Current 1.0 spine status: 2 spine packages; 0 production-ready, 2 beta, 0 alpha/WIP, 0 deprecated; 2 beta promotion records.",
    );
    expect(readme).toContain("| Beta promotion records          |     2 |");
    expect(readme).toContain("Extension & Adapter Matrix");
    expect(readme).toContain("Adapter Ecosystem");
    expect(readme).toContain("compatibility certification checklist");
    expect(readme).toContain("certified compatibility");
    expect(readme).toContain("Certification policy:");
    expect(readme).toContain("not-applicable");
    expect(readme).toContain("`@croco/alpha`");
    expect(report).toContain("## Croco 1.0 Spine");
    expect(report).toContain("## Certification Policy");
    expect(report).toContain("`certified-required`");
    expect(report).toContain("`not-applicable`");
    expect(report).toContain("## Certification Records");
    expect(report).toContain("Croco 1.0 spine packages");
    expect(report).toContain(
      "Current 1.0 spine status: 2 spine packages; 0 production-ready, 2 beta, 0 alpha/WIP, 0 deprecated; 2 beta promotion records.",
    );
    expect(report).toContain("| Beta promotion records          |     2 |");
    expect(report).toContain("| `@croco/beta`");
    expect(report).toContain("Missing generated API docs");
    expect(report).toContain("Generated API Docs Backlog By Maturity");
    expect(report).toContain("| beta             |                2 |");
    expect(report).toContain("Extension Matrix");
    expect(matrix).toContain("title: Extension Matrix");
    expect(matrix).toContain("Adapter Ecosystem");
    expect(matrix).toContain("certification checklist");
    expect(matrix).toContain("compatibility certification claim");
    expect(matrix).toContain("Certification policy:");
    expect(matrix).toContain("not-applicable<br>not required until production-ready");
    expect(matrix).toContain("`@croco/alpha`");
  });

  it("renders missing production certification records as certified-required", () => {
    const root = createTempRoot();
    writePackage(root, "provider", { name: "@croco/provider" });
    writeGeneratedApiDocs(root, "provider");
    writeCatalogMetadata(root, ["provider"], {
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
      productionPackages: ["provider"],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");
    const matrix = readFileSync(
      join(
        root,
        "packages",
        "docs",
        "src",
        "content",
        "docs",
        "en",
        "reference",
        "extension-matrix.md",
      ),
      "utf-8",
    );

    expect(result.status).toBe(0);
    expect(matrix).toContain("certified-required<br>missing certification record");
  });

  it("renders public compatibility claims without records as certified-required", () => {
    const root = createTempRoot();
    writePackage(root, "provider", { name: "@croco/provider" });
    writeFileSync(
      join(root, "packages", "provider", "README.md"),
      "# @croco/provider\n\nCroco compatible: @croco/provider provider contract\n",
    );
    writeCatalogMetadata(root, ["provider"], {
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
      productionPackages: [],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");
    const matrix = readFileSync(
      join(
        root,
        "packages",
        "docs",
        "src",
        "content",
        "docs",
        "en",
        "reference",
        "extension-matrix.md",
      ),
      "utf-8",
    );

    expect(result.status).toBe(0);
    expect(matrix).toContain("certified-required<br>missing certification record");
  });

  it("renders prose certification claims without records as certified-required", () => {
    const root = createTempRoot();
    writePackage(root, "provider", { name: "@croco/provider" });
    writeFileSync(
      join(root, "packages", "provider", "README.md"),
      "# @croco/provider\n\nThis package is certified for the Croco provider contract.\n",
    );
    writeCatalogMetadata(root, ["provider"], {
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
      productionPackages: [],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");
    const matrix = readFileSync(
      join(
        root,
        "packages",
        "docs",
        "src",
        "content",
        "docs",
        "en",
        "reference",
        "extension-matrix.md",
      ),
      "utf-8",
    );

    expect(result.status).toBe(0);
    expect(matrix).toContain("certified-required<br>missing certification record");
  });

  it("fails when the certification policy references a malformed scope group", () => {
    const root = createTempRoot();
    writePackage(root, "provider", { name: "@croco/provider" });
    writeGeneratedApiDocs(root, "provider");
    writeCatalogMetadata(root, ["provider"], {
      certificationPolicy: {
        scope: createCertificationPolicyScope(["Integration"]),
      },
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
      productionPackages: [],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: [],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "certification.policy.scope.extensionGroups references non-extension group Integration",
    );
    expect(result.stdout).toContain(
      "certification.policy.scope.extensionGroups must include extensionMatrix group Provider",
    );
  });

  it("fails when certification policy state descriptions are blank", () => {
    const root = createTempRoot();
    const policyScope = createCertificationPolicyScope(["Provider"]);
    writePackage(root, "provider", { name: "@croco/provider" });
    writeGeneratedApiDocs(root, "provider");
    writeCatalogMetadata(root, ["provider"], {
      certificationPolicy: {
        scope: {
          ...policyScope,
          states: {
            ...(policyScope.states as Record<string, unknown>),
            "candidate-optional": "  ",
          },
        },
      },
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
      productionPackages: [],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: [],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "certification.policy.scope.states.candidate-optional must be a non-empty string",
    );
  });

  it("fails when extension matrix packages are outside extension groups", () => {
    const root = createTempRoot();
    writePackage(root, "provider", { name: "@croco/provider" });
    writeGeneratedApiDocs(root, "provider");
    writeCatalogMetadata(root, ["provider"], {
      additionalGroups: { Provider: [] },
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Core",
      productionPackages: ["provider"],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: [],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "extensionMatrix.packages.provider is not in an extension group",
    );
  });

  it("fails check mode when the README catalog was not regenerated", () => {
    const root = createTempRoot();
    writePackage(root, "alpha", { name: "@croco/alpha" });
    writeCatalogMetadata(root, ["alpha"]);
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["alpha"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--check");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("README.md package catalog drift detected");
    expect(result.stdout).toContain("reference/extension-matrix.md drift detected");
    expect(result.stdout).toContain("docs/package-docs-report.md drift detected");
  });

  it("fails when metadata references a package that no longer exists", () => {
    const root = createTempRoot();
    writePackage(root, "alpha", { name: "@croco/alpha" });
    writeCatalogMetadata(root, ["alpha", "removed"]);
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["alpha"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("packageRoles.removed refers to a package that is not public");
  });

  it("fails when spine metadata references a package that no longer exists", () => {
    const root = createTempRoot();
    writePackage(root, "alpha", { name: "@croco/alpha" });
    writeCatalogMetadata(root, ["alpha"], {
      spinePackages: ["alpha", "removed"],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["alpha"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("spine.packages references missing package removed");
  });

  it("fails for a new public package without README or API docs outside the legacy baseline", () => {
    const root = createTempRoot();
    writePackage(root, "alpha", { name: "@croco/alpha" }, { readme: false });
    writeCatalogMetadata(root, ["alpha"]);
    writeDocsBaseline(root, {
      allowedMissingApiDocs: [],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("new public packages missing README");
    expect(result.stdout).toContain("new public packages missing API docs");
  });

  it("fails when a production package missing API docs remains in the legacy baseline", () => {
    const root = createTempRoot();
    writePackage(root, "stable", { name: "@croco/stable" });
    writeCatalogMetadata(root, ["stable"], {
      productionPackages: ["stable"],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["stable"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "production-ready packages cannot remain in allowedMissingApiDocs: stable",
    );
    expect(result.stdout).toContain("production-ready packages missing API docs");
  });

  it("allows a justified temporary production API docs exception", () => {
    const root = createTempRoot();
    writePackage(root, "stable", { name: "@croco/stable" });
    writeCatalogMetadata(root, ["stable"], {
      productionPackages: ["stable"],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: [],
      allowedMissingReadme: [],
      allowedMissingTests: [],
      temporaryProductionApiDocExceptions: {
        stable: "TypeDoc generation is blocked by an upstream parser issue.",
      },
    });

    const result = runScript(root, "--write");
    const report = readFileSync(join(root, "docs", "package-docs-report.md"), "utf-8");

    expect(result.status).toBe(0);
    expect(report).toContain(
      "`@croco/stable` (`packages/stable`) — temporary production exception: TypeDoc generation is blocked by an upstream parser issue.",
    );
  });

  it("fails when a temporary production API docs exception is stale", () => {
    const root = createTempRoot();
    writePackage(root, "stable", { name: "@croco/stable" });
    writeGeneratedApiDocs(root, "stable");
    writeCatalogMetadata(root, ["stable"], {
      productionPackages: ["stable"],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: [],
      allowedMissingReadme: [],
      allowedMissingTests: [],
      temporaryProductionApiDocExceptions: {
        stable: "TypeDoc generation is blocked by an upstream parser issue.",
      },
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "temporaryProductionApiDocExceptions entries must match production-ready packages currently missing API docs: stable",
    );
  });

  it("fails when an extension group package is missing matrix metadata", () => {
    const root = createTempRoot();
    writePackage(root, "provider", { name: "@croco/provider" });
    writeCatalogMetadata(root, ["provider"], {
      extensionGroups: ["Provider"],
      extensionPackages: [],
      groupName: "Provider",
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "extensionMatrix is missing metadata for Provider package provider",
    );
  });

  it("renders certification records from catalog metadata", () => {
    const root = createTempRoot();
    writePackage(root, "provider", {
      name: "@croco/provider",
      version: "1.2.3",
    });
    writeCatalogMetadata(root, ["provider"], {
      certificationRecords: [
        createCertificationRecord("@croco/provider", {
          contract: "@croco/core/Provider",
          packageVersion: "1.2.3",
        }),
      ],
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");
    const report = readFileSync(join(root, "docs", "package-docs-report.md"), "utf-8");
    const matrix = readFileSync(
      join(
        root,
        "packages",
        "docs",
        "src",
        "content",
        "docs",
        "en",
        "reference",
        "extension-matrix.md",
      ),
      "utf-8",
    );

    expect(result.status).toBe(0);
    expect(report).toMatch(/\| Certification records\s+\|\s+1 \|/);
    expect(report).toContain("`@croco/core/Provider`");
    expect(report).toContain("liveSmoke: missing");
    expect(report).toContain("liveSmoke evidence has not been recorded.");
    expect(matrix).toContain("uncertified (1.2.3)");
    expect(matrix).toContain("missing: liveSmoke");
  });

  it("fails when candidate certification records are missing live smoke evidence", () => {
    const root = createTempRoot();
    writePackage(root, "provider", {
      name: "@croco/provider",
      version: "1.2.3",
    });
    writeCatalogMetadata(root, ["provider"], {
      certificationRecords: [
        createCertificationRecord("@croco/provider", {
          contract: "@croco/core/Provider",
          packageVersion: "1.2.3",
          state: "candidate",
        }),
      ],
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "certification.records[0].state candidate requires present liveSmoke evidence",
    );
  });

  it("fails when certification records do not link to extension matrix entries", () => {
    const root = createTempRoot();
    writePackage(root, "provider", {
      name: "@croco/provider",
      version: "1.2.3",
    });
    writeCatalogMetadata(root, ["provider"], {
      certificationRecords: [
        createCertificationRecord("@croco/provider", {
          contract: "@croco/core/Provider",
          packageVersion: "1.2.3",
        }),
      ],
      extensionGroups: [],
      extensionPackages: [],
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "certification.records[0].package @croco/provider must also be listed in extensionMatrix.packages",
    );
  });

  it("fails when missing certification evidence lacks an explicit reason", () => {
    const root = createTempRoot();
    writePackage(root, "provider", {
      name: "@croco/provider",
      version: "1.2.3",
    });
    writeCatalogMetadata(root, ["provider"], {
      certificationRecords: [
        createCertificationRecord("@croco/provider", {
          evidence: {
            liveSmoke: {
              status: "missing",
            },
          },
          contract: "@croco/core/Provider",
          packageVersion: "1.2.3",
        }),
      ],
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "certification.records[0].evidence.liveSmoke missing evidence must include reason",
    );
  });

  it("fails when known certification gaps do not name missing evidence keys", () => {
    const root = createTempRoot();
    writePackage(root, "provider", {
      name: "@croco/provider",
      version: "1.2.3",
    });
    writeCatalogMetadata(root, ["provider"], {
      certificationRecords: [
        createCertificationRecord("@croco/provider", {
          contract: "@croco/core/Provider",
          knownGaps: ["Real credential smoke has not been recorded."],
          packageVersion: "1.2.3",
        }),
      ],
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "certification.records[0].knownGaps must name the missing certification gaps: liveSmoke",
    );
  });

  it("fails when present certification evidence only has prose", () => {
    const root = createTempRoot();
    writePackage(root, "provider", {
      name: "@croco/provider",
      version: "1.2.3",
    });
    writeCatalogMetadata(root, ["provider"], {
      certificationRecords: [
        createCertificationRecord("@croco/provider", {
          evidence: {
            diagnostics: {
              status: "present",
              description: "Diagnostics coverage exists in package tests.",
            },
          },
          contract: "@croco/core/Provider",
          packageVersion: "1.2.3",
        }),
      ],
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "certification.records[0].evidence.diagnostics present evidence must include command or artifact",
    );
  });

  it("escapes pipe characters in rendered certification table cells", () => {
    const root = createTempRoot();
    writePackage(root, "provider", {
      name: "@croco/provider",
      version: "1.2.3",
    });
    writeCatalogMetadata(root, ["provider"], {
      certificationRecords: [
        createCertificationRecord("@croco/provider", {
          contract: "@croco/core/Provider|v1",
          evidence: {
            diagnostics: {
              status: "present",
              command: "pnpm test -- --case diagnostics|provider",
            },
          },
          knownGaps: ["liveSmoke | real credential smoke has not been recorded."],
          packageVersion: "1.2.3",
        }),
      ],
      extensionGroups: ["Provider"],
      extensionPackages: ["provider"],
      groupName: "Provider",
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["provider"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");
    const report = readFileSync(join(root, "docs", "package-docs-report.md"), "utf-8");
    const matrix = readFileSync(
      join(
        root,
        "packages",
        "docs",
        "src",
        "content",
        "docs",
        "en",
        "reference",
        "extension-matrix.md",
      ),
      "utf-8",
    );

    expect(result.status).toBe(0);
    expect(report).toContain("`@croco/core/Provider\\|v1`");
    expect(report).toContain("diagnostics\\|provider");
    expect(report).toContain("liveSmoke \\| real credential smoke has not been recorded.");
    expect(matrix).toContain("@croco/core/Provider\\|v1");
  });

  it("fails when presentation-preset claims a runtime without generated profile evidence", () => {
    const root = createTempRoot();
    writePackage(root, "presentation-preset", { name: "@croco/presentation-preset" });
    writePresentationRuntimeProfileCatalog(root, ["node"]);
    writeCatalogMetadata(root, ["presentation-preset"], {
      extensionRuntimesByPackage: {
        "presentation-preset": ["node", "browser"],
      },
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["presentation-preset"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "packages/presentation-preset/runtime-profiles.json: Catalog runtime claim 'browser' has no generated runtime profile evidence",
    );
  });

  it("accepts presentation-preset runtime claims with generated profile evidence", () => {
    const root = createTempRoot();
    writePackage(root, "presentation-preset", { name: "@croco/presentation-preset" });
    writePresentationRuntimeProfileCatalog(root, ["node", "browser"]);
    writeCatalogMetadata(root, ["presentation-preset"], {
      extensionRuntimesByPackage: {
        "presentation-preset": ["node", "browser"],
      },
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["presentation-preset"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "package-docs-check: package catalog and documentation report are in sync.",
    );
  });

  it("fails when presentation-preset runtime metadata is defined as a non-object value", () => {
    const root = createTempRoot();
    writePackage(root, "presentation-preset", { name: "@croco/presentation-preset" });
    writePresentationRuntimeProfileCatalog(root, ["node"], {
      runtimeMetadata: "node20",
    });
    writeCatalogMetadata(root, ["presentation-preset"], {
      extensionRuntimesByPackage: {
        "presentation-preset": ["node"],
      },
    });
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["presentation-preset"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "packages/presentation-preset/runtime-profiles.json: Generated runtime profile 'node-fixture' runtime must be an object when provided",
    );
  });

  it("fails when public architecture docs use stale layer text or missing package names", () => {
    const root = createTempRoot();
    writePackage(root, "alpha", { name: "@croco/alpha" });
    writeCatalogMetadata(root, ["alpha"]);
    writeDocsBaseline(root, {
      allowedMissingApiDocs: ["alpha"],
      allowedMissingReadme: [],
      allowedMissingTests: [],
    });
    writeFileSync(
      join(root, "packages", "docs", "src", "content", "docs", "en", "guides", "architecture.mdx"),
      [
        "---",
        "title: Architecture",
        "---",
        "",
        "Croco separates concerns into four clear layers.",
        "",
        "- `removed-package` is no longer present.",
        "",
      ].join("\n"),
    );

    const result = runScript(root, "--write");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("must not describe the current architecture as four layers");
    expect(result.stdout).toContain(
      "references package removed-package that is not in docs/package-catalog.json",
    );
  });
});

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "croco-package-docs-"));
  tempRoots.push(root);
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(
    join(root, "README.md"),
    [
      "# Fixture",
      "",
      "## 📦 패키지 카탈로그",
      "",
      "manual catalog",
      "",
      "---",
      "",
      "## 🛠 개발 환경",
      "",
      "dev section",
      "",
    ].join("\n"),
  );
  writeJson(join(root, "package.json"), {
    scripts: {
      "docs:catalog:check": "fixture",
      "docs:catalog:write": "fixture",
      test: "fixture",
    },
  });
  writeDefaultPublicDocs(root);

  return root;
}

function createCommandValidationRoot(): string {
  const root = createTempRoot();
  writePackage(root, "alpha", {
    name: "@croco/alpha",
    scripts: { "package-only": "fixture" },
  });
  writeCatalogMetadata(root, ["alpha"]);
  writeDocsBaseline(root, {
    allowedMissingApiDocs: ["alpha"],
    allowedMissingReadme: [],
    allowedMissingTests: [],
  });
  return root;
}

function writeDefaultPublicDocs(root: string): void {
  const docsRoot = join(root, "packages", "docs", "src", "content", "docs", "en");
  mkdirSync(join(docsRoot, "guides"), { recursive: true });
  writeFileSync(
    join(docsRoot, "index.mdx"),
    ["---", "title: Fixture", "---", "", "Understand the current layered structure.", ""].join(
      "\n",
    ),
  );
  writeFileSync(
    join(docsRoot, "guides", "getting-started.mdx"),
    [
      "---",
      "title: Getting Started",
      "---",
      "",
      "Explore the current architecture guide.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(docsRoot, "guides", "architecture.mdx"),
    [
      "---",
      "title: Architecture",
      "---",
      "",
      "Croco uses Kernel, Contracts, Plugins, Application, Profiles, and Tooling roles.",
      "",
      "- `alpha` is a fixture package.",
      "",
    ].join("\n"),
  );
}

function writePackage(
  root: string,
  packageDirName: string,
  pkg: Record<string, unknown>,
  options: { readonly readme?: boolean; readonly tests?: boolean } = {},
): void {
  const packageDir = join(root, "packages", packageDirName);
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(join(packageDir, "src"), { recursive: true });
  writeFileSync(join(packageDir, "src", "index.ts"), "export const value = 1;\n");

  if (options.tests !== false) {
    mkdirSync(join(packageDir, "src", "tests"), { recursive: true });
  }

  if (options.readme !== false) {
    writeFileSync(join(packageDir, "README.md"), `# ${pkg.name}\n\nFixture package.\n`);
  }

  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ version: "0.0.0", ...pkg }, null, 2)}\n`,
  );
}

function writeGeneratedApiDocs(root: string, packageDirName: string): void {
  mkdirSync(join(root, "packages", "docs", "src", "content", "docs", "api", packageDirName), {
    recursive: true,
  });
}

function writeCatalogMetadata(
  root: string,
  packageNames: readonly string[],
  options: {
    readonly additionalGroups?: Record<string, readonly string[]>;
    readonly certificationPolicy?: Record<string, unknown> | null;
    readonly extensionGroups?: readonly string[];
    readonly extensionPackages?: readonly string[];
    readonly extensionRuntimesByPackage?: Record<string, readonly string[]>;
    readonly certificationRecords?: readonly Record<string, unknown>[];
    readonly groupName?: string;
    readonly productionPackages?: readonly string[];
    readonly spinePromotionPackages?: readonly string[];
    readonly spinePackages?: readonly string[];
  } = {},
): void {
  const groupName = options.groupName ?? "Core";
  const extensionPackages = options.extensionPackages ?? packageNames;
  const productionPackages = options.productionPackages ?? [];
  const productionPackageNames = new Set(productionPackages);
  const betaPackages = packageNames.filter(
    (packageName) => !productionPackageNames.has(packageName),
  );
  const spinePackageNames = options.spinePackages ?? packageNames;
  const spinePackageNameSet = new Set(spinePackageNames);
  const spinePromotionPackages =
    options.spinePromotionPackages ??
    betaPackages.filter((packageName) => spinePackageNameSet.has(packageName));
  writeJson(join(root, "docs", "package-catalog.json"), {
    schemaVersion: 1,
    packageRoles: Object.fromEntries(
      packageNames.map((name) => [
        name,
        {
          role: "Contracts",
          subtype: "domain",
          domain: "Fixture",
          runtimes: extensionPackages.includes(name)
            ? (options.extensionRuntimesByPackage?.[name] ?? ["node"])
            : [],
        },
      ]),
    ),
    spine: {
      label: "Croco 1.0 spine",
      description: "Fixture release-critical package set.",
      packages: spinePackageNames,
      promotion: {
        packages: Object.fromEntries(
          spinePromotionPackages.map((packageName) => [
            packageName,
            {
              owner: "fixture-owner",
              recoveryAction: "Complete fixture release evidence.",
              targetEvidence: ["fixture release evidence"],
            },
          ]),
        ),
      },
    },
    groups: {
      [groupName]: {
        description: "Fixture core packages",
        packages: packageNames,
      },
      ...Object.fromEntries(
        Object.entries(options.additionalGroups ?? {}).map(([name, packages]) => [
          name,
          {
            description: "Fixture extension package set",
            packages,
          },
        ]),
      ),
    },
    maturity: {
      production: {
        label: "production-ready",
        packages: productionPackages,
      },
      beta: {
        label: "beta",
        packages: betaPackages,
      },
      alpha: {
        label: "alpha",
        packages: [],
      },
      deprecated: {
        label: "deprecated",
        packages: [],
      },
    },
    extensionMatrix: {
      groups: options.extensionGroups ?? [groupName],
      packages: Object.fromEntries(
        extensionPackages.map((packageName) => [
          packageName,
          {
            adapter: "Fixture adapter",
            domain: "Fixture",
            features: ["Fixture feature"],
            requiredEnv: ["none"],
            runtimes: options.extensionRuntimesByPackage?.[packageName] ?? ["node"],
          },
        ]),
      ),
    },
    certification: {
      schemaVersion: 1,
      ...(options.certificationPolicy === null
        ? {}
        : {
            policy: {
              scope: createCertificationPolicyScope(options.extensionGroups ?? [groupName]),
              ...options.certificationPolicy,
            },
          }),
      records: options.certificationRecords ?? [],
    },
  });
}

function createCertificationPolicyScope(
  extensionGroups: readonly string[],
): Record<string, unknown> {
  return {
    extensionGroups,
    requiredMaturity: "production",
    claimRequiresCertified: true,
    states: {
      "certified-required":
        "A certified record is required for production-ready extension packages or public compatibility claims.",
      "candidate-optional":
        "A pre-production record may track evidence before the extension package is production-ready; candidate state requires liveSmoke evidence.",
      "not-applicable":
        "No certification record is required until production-ready maturity or a public compatibility claim.",
    },
  };
}

function createCertificationRecord(
  packageName: string,
  overrides: {
    readonly adapterCategory?: string;
    readonly contract?: string;
    readonly evidence?: Record<string, Record<string, unknown>>;
    readonly knownGaps?: readonly string[];
    readonly package?: string;
    readonly packageVersion?: string;
    readonly runtimes?: readonly string[];
    readonly state?: string;
  } = {},
): Record<string, unknown> {
  const evidence = {
    conformance: {
      status: "present",
      command: `pnpm --filter ${packageName} test`,
    },
    noCredentialSmoke: {
      status: "present",
      command: `pnpm --filter ${packageName} test`,
    },
    liveSmoke: {
      status: "missing",
      reason: "Live smoke has not been recorded.",
    },
    diagnostics: {
      status: "present",
      command: `pnpm --filter ${packageName} test`,
      description: "Diagnostics coverage exists in package tests.",
    },
    redactionTests: {
      status: "present",
      command: `pnpm --filter ${packageName} test`,
      description: "Redaction coverage exists in package tests.",
    },
    ...overrides.evidence,
  };

  return {
    package: overrides.package ?? packageName,
    contract: overrides.contract ?? "@croco/core/Provider",
    adapterCategory: overrides.adapterCategory ?? "provider",
    runtimes: overrides.runtimes ?? ["node"],
    packageVersion: overrides.packageVersion ?? "0.0.0",
    state: overrides.state ?? "uncertified",
    evidence,
    knownGaps: overrides.knownGaps ?? ["liveSmoke evidence has not been recorded."],
  };
}

function writePresentationRuntimeProfileCatalog(
  root: string,
  runtimes: readonly string[],
  options: { readonly runtimeMetadata?: unknown } = {},
): void {
  writeJson(join(root, "packages", "presentation-preset", "runtime-profiles.json"), {
    schemaVersion: 1,
    validationCommand: "pnpm --filter @croco/presentation-preset test",
    profiles: runtimes.map((runtime) => ({
      name: `${runtime}-fixture`,
      runtime,
      packageTestName: `validates ${runtime}`,
      generatedAppSmokeCase: `${runtime}-smoke`,
      generatedAppSmokeCommand: `CROCO_GENERATED_SMOKE_CASES=${runtime}-smoke pnpm create-croco-app:smoke`,
      target: {
        target: runtime,
        requiredEnvVars: [],
        ...(options.runtimeMetadata !== undefined ? { runtime: options.runtimeMetadata } : {}),
        output: {
          presetName: `presentation-preset/${runtime}-fixture`,
          buildTime: "2026-01-01T00:00:00.000Z",
          format: "esm",
          artifacts: [
            { path: `${runtime}/index.js`, format: "esm", type: "code" },
            { path: `${runtime}/index.d.ts`, format: "neutral", type: "types" },
          ],
          entries: [
            {
              exportName: ".",
              main: `${runtime}/index.js`,
              types: `${runtime}/index.d.ts`,
            },
          ],
        },
      },
    })),
  });
}

function writeDocsBaseline(
  root: string,
  baseline: {
    readonly allowedMissingApiDocs: readonly string[];
    readonly allowedMissingReadme: readonly string[];
    readonly allowedMissingTests: readonly string[];
    readonly temporaryProductionApiDocExceptions?: Record<string, string>;
  },
): void {
  writeJson(join(root, "docs", "package-docs-baseline.json"), {
    schemaVersion: 1,
    ...baseline,
  });
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runScript(root: string, mode: "--check" | "--write"): ScriptResult {
  const result = spawnSync(
    "node",
    ["--experimental-strip-types", scriptPath, mode, "--root", root],
    {
      encoding: "utf-8",
    },
  );

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}
