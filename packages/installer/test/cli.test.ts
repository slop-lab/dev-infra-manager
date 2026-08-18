import { spawn } from "node:child_process";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir, writeFakeCliNpm, writeStubCli } from "./support.js";

/**
 * cli.ts runs `dispatch()` at module top level via top-level await, so it
 * cannot be unit-tested by importing it directly (importing it would run the
 * real dispatcher against argv/env of the vitest worker process itself).
 * Instead we spawn it as a real subprocess through `tsx`, matching how the
 * published `dim` bin actually executes ("#!/usr/bin/env node" + a compiled
 * cli.js in production; tsx gives us the same ESM/TS module here without a
 * build step). `tsx` is not a devDependency of this package, but it is
 * already a devDependency of the sibling @slop-lab/dim-cli package in this
 * workspace, so pnpm's single workspace install always provides it - no new
 * tooling is added just for this.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(testDir, "..", "src", "cli.ts");
const workspaceRoot = join(testDir, "..", "..", "..");

const tsxCandidates = [
  join(workspaceRoot, "node_modules", ".bin", "tsx"),
  join(workspaceRoot, "packages", "cli", "node_modules", ".bin", "tsx")
];

async function locateTsx(): Promise<string | undefined> {
  for (const candidate of tsxCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[], tsxPath: string, env: NodeJS.ProcessEnv, cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxPath, [cliEntry, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end();
  });
}

const tsxPath = await locateTsx();

describe.skipIf(!tsxPath)("cli.ts dispatch (integration, via tsx subprocess)", () => {
  const temporaryDirectories: string[] = [];

  async function tempDir(prefix: string): Promise<string> {
    const dir = await makeTempDir(prefix);
    temporaryDirectories.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  });

  async function baseEnv(root: string): Promise<{ env: NodeJS.ProcessEnv; configPath: string; dataHome: string }> {
    const home = join(root, "home");
    const configPath = join(root, "config", "dim.json");
    const dataHome = join(root, "data-home");
    await mkdir(home, { recursive: true });
    return {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        DIM_CONFIG_PATH: configPath,
        DIM_DATA_HOME: dataHome
      },
      configPath,
      dataHome
    };
  }

  it("dim --help reports the facade is not backed by an installed CLI", async () => {
    const root = await tempDir("dim-cli-help-uninstalled-");
    const { env } = await baseEnv(root);
    const result = await runCli(["--help"], tsxPath!, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DIM installer/facade");
    expect(result.stdout).toContain("DIM CLI is not installed.");
  });

  it("dim --version reports installer-only state when no CLI is configured", async () => {
    const root = await tempDir("dim-cli-version-uninstalled-");
    const { env } = await baseEnv(root);
    const result = await runCli(["--version"], tsxPath!, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DIM installer 0.7.0");
    expect(result.stdout).toContain("DIM CLI: not installed");
  });

  it("dim <anything> fails with exit code 2 when no CLI is installed", async () => {
    const root = await tempDir("dim-cli-no-cli-dispatch-");
    const { env } = await baseEnv(root);
    const result = await runCli(["workspace", "list"], tsxPath!, env, root);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("DIM CLI is not installed");
    expect(result.stderr).toContain("dim install-cli");
  });

  it("dim (no args, non-TTY) prints facade help and fails instead of hanging", async () => {
    const root = await tempDir("dim-cli-no-args-non-tty-");
    const { env } = await baseEnv(root);
    const result = await runCli([], tsxPath!, env, root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("DIM installer/facade");
    expect(result.stderr).toContain("interactive installation requires a TTY");
  });

  it("dim installer <garbage> is rejected as an unknown argument", async () => {
    const root = await tempDir("dim-cli-installer-garbage-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "garbage"], tsxPath!, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown installer argument: garbage");
  });

  it("dim install-cli rejects --no-local-bin combined with --local-bin", async () => {
    const root = await tempDir("dim-cli-conflicting-flags-");
    const { env } = await baseEnv(root);
    const result = await runCli(["install-cli", "--no-local-bin", "--local-bin"], tsxPath!, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--no-local-bin and --local-bin cannot be used together");
  });

  it("dim install-cli rejects unknown flags", async () => {
    const root = await tempDir("dim-cli-unknown-flag-");
    const { env } = await baseEnv(root);
    const result = await runCli(["install-cli", "--bogus-flag"], tsxPath!, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("dim:");
  });

  it("dim install-cli help warns about direct mode under mise", async () => {
    const root = await tempDir("dim-cli-mise-help-");
    const { env } = await baseEnv(root);
    const result = await runCli(["install-cli", "--help"], tsxPath!, { ...env, MISE_SHELL: "bash" }, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--local-bin under mise may shadow its dim shim");
    expect(result.stdout).toContain("bypass the installer facade");
  });

  it("installs a local package bundle behind the facade without creating a PATH symlink", async () => {
    const root = await tempDir("dim-cli-local-bundle-");
    const { env, configPath, dataHome } = await baseEnv(root);
    const bin = join(root, "bin");
    const bundle = join(root, "bundle");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(bin, { recursive: true });
    await mkdir(bundle, { recursive: true });
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.7.0" });
    await writeFile(join(bundle, "core.tgz"), "core");
    await writeFile(join(bundle, "cli.tgz"), "cli");
    await writeFile(join(bundle, "installer.tgz"), "installer");
    await writeFile(join(bundle, "packages.json"), JSON.stringify({
      schemaVersion: 1,
      packages: [
        { name: "@slop-lab/dim-core", version: "0.7.0", file: "core.tgz" },
        { name: "@slop-lab/dim-cli", version: "0.7.0", file: "cli.tgz" },
        { name: "@slop-lab/dim-installer", version: "0.7.0", file: "installer.tgz" }
      ]
    }));

    const result = await runCli(
      ["install-cli", "--local-packages", bundle, "--no-local-bin"],
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Installed local DIM CLI 0.7.0");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.cli).toMatchObject({ mode: "proxied", version: "0.7.0" });
    expect(config.cli.executable).toMatch(new RegExp(`^${dataHome}/cli/local-[0-9a-f]{16}/`));
    expect(JSON.parse(await readFile(npmArgs, "utf8"))).toEqual(expect.arrayContaining([
      join(bundle, "core.tgz"),
      join(bundle, "cli.tgz")
    ]));
    expect(JSON.parse(await readFile(npmArgs, "utf8"))).not.toContain(join(bundle, "installer.tgz"));
  });

  it("proxies unrecognized args, cwd, and facade env vars through to the configured CLI", async () => {
    const root = await tempDir("dim-cli-proxy-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    const echoFile = join(root, "echo.json");
    await writeStubCli(stub, { versionOutput: "5.5.5", echoFile });

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, cli: { mode: "proxied", version: "5.5.5", executable: stub } })
    );

    const cwd = await tempDir("dim-cli-proxy-cwd-");
    const result = await runCli(["some", "random", "args", "--", "extra"], tsxPath!, env, cwd);
    expect(result.code).toBe(0);

    const echoed = JSON.parse(await readFile(echoFile, "utf8"));
    expect(echoed.argv).toEqual(["some", "random", "args", "--", "extra"]);
    expect(echoed.cwd).toBe(await realpath(cwd));
    expect(echoed.env.DIM_INVOKED_VIA_INSTALLER).toBe("1");
    expect(echoed.env.DIM_INSTALLER_VERSION).toBe("0.7.0");
  });

  it("forwards --help to the configured CLI instead of intercepting it", async () => {
    const root = await tempDir("dim-cli-proxy-help-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    const echoFile = join(root, "echo.json");
    await writeStubCli(stub, { versionOutput: "5.5.5", echoFile });

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, cli: { mode: "proxied", version: "5.5.5", executable: stub } })
    );

    const result = await runCli(["--help"], tsxPath!, env, root);
    expect(result.code).toBe(0);
    const echoed = JSON.parse(await readFile(echoFile, "utf8"));
    expect(echoed.argv).toEqual(["--help"]);
  });

  it("bare dim proxies to the configured CLI instead of opening the interactive installer", async () => {
    const root = await tempDir("dim-cli-proxy-bare-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    const echoFile = join(root, "echo.json");
    await writeStubCli(stub, { versionOutput: "5.5.5", echoFile });

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, cli: { mode: "proxied", version: "5.5.5", executable: stub } })
    );

    const result = await runCli([], tsxPath!, env, root);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("interactive installation requires a TTY");
    const echoed = JSON.parse(await readFile(echoFile, "utf8"));
    expect(echoed.argv).toEqual([]);
  });

  it("dim --version reports both installer and CLI versions when configured and matching", async () => {
    const root = await tempDir("dim-cli-version-configured-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    await writeStubCli(stub, { versionOutput: "5.5.5" });

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, cli: { mode: "proxied", version: "5.5.5", executable: stub } })
    );

    const result = await runCli(["--version"], tsxPath!, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DIM CLI 5.5.5 (via DIM installer 0.7.0)");
    expect(result.stderr).not.toContain("configured version");
  });

  it("dim --version warns on a configured/installed version mismatch", async () => {
    const root = await tempDir("dim-cli-version-mismatch-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    await writeStubCli(stub, { versionOutput: "9.0.0" });

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, cli: { mode: "proxied", version: "1.0.0", executable: stub } })
    );

    const result = await runCli(["--version"], tsxPath!, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DIM CLI 9.0.0 (via DIM installer 0.7.0)");
    expect(result.stderr).toContain("configured version 1.0.0 does not match installed 9.0.0");
  });

  it("surfaces a clear error for a stale config pointing at a missing executable", async () => {
    const root = await tempDir("dim-cli-stale-config-");
    const { env, configPath } = await baseEnv(root);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        cli: { mode: "proxied", version: "1.0.0", executable: join(root, "no-such-dim") }
      })
    );

    const result = await runCli(["workspace", "list"], tsxPath!, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("run 'dim install-cli'");
  });
});
