import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageDir = resolve(__dirname, "../..");
const rootDir = resolve(packageDir, "../..");
const spawnTimeoutMs = 180_000;

describe("published RPC codegen CLI", () => {
  it(
    "generates clients for OpenAPI schemas through the published package contract",
    () => {
      const packRoot = mkdtempSync(join(tmpdir(), "croco-rpc-codegen-pack-"));
      const consumerRoot = mkdtempSync(join(tmpdir(), "croco-rpc-codegen-consumer-"));

      try {
        ensureBuilt();
        run(
          "pnpm",
          ["--filter", "@croco/problems-core", "pack", "--pack-destination", packRoot],
          rootDir,
        );
        run(
          "pnpm",
          ["--filter", "@croco/protocol-codegen", "pack", "--pack-destination", packRoot],
          rootDir,
        );
        run(
          "pnpm",
          ["--filter", "@croco/protocols-core", "pack", "--pack-destination", packRoot],
          rootDir,
        );
        run(
          "pnpm",
          ["--filter", "@croco/framework-preset", "pack", "--pack-destination", packRoot],
          rootDir,
        );
        run(
          "pnpm",
          ["--filter", "@croco/presentation-preset", "pack", "--pack-destination", packRoot],
          rootDir,
        );
        run(
          "pnpm",
          ["--filter", "@croco/rpc-codegen", "pack", "--pack-destination", packRoot],
          rootDir,
        );

        const problemsCoreTarball = findTarball(packRoot, "croco-problems-core-");
        const protocolCodegenTarball = findTarball(packRoot, "croco-protocol-codegen-");
        const protocolsCoreTarball = findTarball(packRoot, "croco-protocols-core-");
        const frameworkPresetTarball = findTarball(packRoot, "croco-framework-preset-");
        const presentationPresetTarball = findTarball(packRoot, "croco-presentation-preset-");
        const rpcCodegenTarball = findTarball(packRoot, "croco-rpc-codegen-");
        const packedManifest = JSON.parse(
          run("tar", ["-xOf", rpcCodegenTarball, "package/package.json"], rootDir).stdout,
        ) as {
          bin?: Record<string, string>;
        };
        const packedCli = run(
          "tar",
          ["-xOf", rpcCodegenTarball, "package/dist/cli.js"],
          rootDir,
        ).stdout;

        expect(packedManifest.bin?.["croco-rpc-codegen"]).toBe("./dist/cli.js");
        expect(packedCli.split(/\r?\n/, 1)[0]).toBe("#!/usr/bin/env node");

        writeFileSync(
          join(consumerRoot, "package.json"),
          `${JSON.stringify(
            {
              name: "croco-rpc-codegen-consumer",
              private: true,
              type: "module",
            },
            null,
            2,
          )}\n`,
        );
        writePnpmWorkspaceOverrides(consumerRoot, {
          "@croco/framework-preset": `file:${frameworkPresetTarball}`,
          "@croco/presentation-preset": `file:${presentationPresetTarball}`,
          "@croco/problems-core": `file:${problemsCoreTarball}`,
          "@croco/protocol-codegen": `file:${protocolCodegenTarball}`,
          "@croco/protocols-core": `file:${protocolsCoreTarball}`,
        });

        run("pnpm", ["add", "--prod", rpcCodegenTarball, "--ignore-scripts"], consumerRoot);
        run(
          "node",
          ["--input-type=module", "--eval", "await import('@croco/rpc-codegen');"],
          consumerRoot,
        );
        run("node", ["--eval", "require('@croco/rpc-codegen');"], consumerRoot);
        run(
          "pnpm",
          [
            "add",
            "--prod",
            "zod@3.25.76",
            "@asteasolutions/zod-to-openapi@7.3.4",
            "--ignore-scripts",
          ],
          consumerRoot,
        );

        const help = run("pnpm", ["exec", "croco-rpc-codegen", "--help"], consumerRoot);
        expect(help.stdout).toContain("Usage: croco-rpc-codegen");

        writeFileSync(
          join(consumerRoot, "UsersController.ts"),
          `import { z } from 'zod';
import type {} from '@asteasolutions/zod-to-openapi';

declare namespace Reflect {
  function defineMetadata(key: unknown, value: unknown, target: object, propertyKey?: string): void;
}

const schema = z.object({ id: z.string().openapi({ example: 'user-1' }) }).openapi('User');
export class UsersController {
  listUsers() { return { id: 'user-1' }; }
}
Reflect.defineMetadata(Symbol.for('croco:rest:controller'), { path: '/users', target: UsersController }, UsersController);
Reflect.defineMetadata(Symbol.for('croco:rest:routes'), [{ method: 'GET', path: '/', methodName: 'listUsers' }], UsersController);
Reflect.defineMetadata(Symbol.for('croco:rest:responseSchema'), schema, UsersController, 'listUsers');
`,
        );
        run(
          "pnpm",
          ["exec", "croco-rpc-codegen", "--controllers", "UsersController.ts", "--out", "client"],
          consumerRoot,
        );
        expect(readFileSync(join(consumerRoot, "client", "users.ts"), "utf8")).toContain(
          "listUsers",
        );
      } finally {
        rmSync(packRoot, { force: true, recursive: true });
        rmSync(consumerRoot, { force: true, recursive: true });
      }
    },
    spawnTimeoutMs,
  );
});

function ensureBuilt(): void {
  const packages = [
    {
      buildArgs: ["--filter", "@croco/problems-core", "build"],
      files: ["index.js", "index.d.ts"],
      root: join(rootDir, "packages", "problems-core"),
    },
    {
      buildArgs: ["--filter", "@croco/protocols-core", "build"],
      files: ["index.js", "index.d.ts"],
      root: join(rootDir, "packages", "protocols-core"),
    },
    {
      buildArgs: ["--filter", "@croco/protocol-codegen", "build"],
      files: ["index.js", "index.d.ts"],
      root: join(rootDir, "packages", "protocol-codegen"),
    },
    {
      buildArgs: ["--filter", "@croco/framework-preset", "build"],
      files: ["index.js", "index.d.ts"],
      root: join(rootDir, "packages", "framework-preset"),
    },
    {
      buildArgs: ["--filter", "@croco/presentation-preset", "build"],
      files: ["index.js", "index.d.ts"],
      root: join(rootDir, "packages", "presentation-preset"),
    },
    {
      buildArgs: ["--filter", "@croco/rpc-codegen", "build"],
      files: ["cli.js", "cli.d.ts", "index.js", "index.d.ts"],
      root: packageDir,
    },
  ];

  for (const packageBuild of packages) {
    if (!hasBuiltFiles(packageBuild.root, packageBuild.files)) {
      run("pnpm", packageBuild.buildArgs, rootDir);
    }
  }
}

function hasBuiltFiles(packageRoot: string, files: readonly string[]): boolean {
  return files.every((file) => existsSync(join(packageRoot, "dist", file)));
}

function findTarball(directory: string, prefix: string): string {
  const filename = readdirSync(directory).find(
    (entry) => entry.startsWith(prefix) && entry.endsWith(".tgz"),
  );

  if (!filename) {
    throw new Error(`Missing packed tarball with prefix ${prefix}`);
  }

  return join(directory, filename);
}

function writePnpmWorkspaceOverrides(
  consumerRoot: string,
  overrides: Record<string, string>,
): void {
  const lines = [
    "packages:",
    "  - .",
    "overrides:",
    ...Object.entries(overrides).map(
      ([packageName, range]) => `  ${JSON.stringify(packageName)}: ${JSON.stringify(range)}`,
    ),
  ];

  writeFileSync(join(consumerRoot, "pnpm-workspace.yaml"), `${lines.join("\n")}\n`);
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
): { stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: spawnTimeoutMs,
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed`,
        result.error ? `${result.error.name}: ${result.error.message}` : undefined,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
