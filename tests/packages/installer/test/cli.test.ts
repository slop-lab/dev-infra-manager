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
const cliEntry = fileURLToPath(new URL("../../../../core/packages/installer/src/cli.ts", import.meta.url));
const workspaceRoot = join(testDir, "..", "..", "..");

const tsxCandidates = [
  join(workspaceRoot, "node_modules", ".bin", "tsx"),
  fileURLToPath(new URL("../../../../core/packages/cli/node_modules/.bin/tsx", import.meta.url))
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

function runCliInPty(
  args: readonly string[],
  input: string,
  tsxPath: string,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const command = [tsxPath, cliEntry, ...args].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
    const child = spawn("script", ["--quiet", "--return", "--command", command, "/dev/null"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

const tsxPath = await locateTsx();
const sourceRepositoryUrl = "https://github.com/slop-lab/dev-infra-manager";

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
    expect(result.stdout).toContain(sourceRepositoryUrl);
  });

  it("dim --version reports installer-only state when no CLI is configured", async () => {
    const root = await tempDir("dim-cli-version-uninstalled-");
    const { env } = await baseEnv(root);
    const result = await runCli(["--version"], tsxPath!, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DIM installer 0.9.0");
    expect(result.stdout).toContain("DIM CLI: not installed");
  });

  it("dim <anything> fails with exit code 2 when no CLI is installed", async () => {
    const root = await tempDir("dim-cli-no-cli-dispatch-");
    const { env } = await baseEnv(root);
    const result = await runCli(["workspace", "list"], tsxPath!, env, root);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("DIM CLI is not installed");
    expect(result.stderr).toContain("dim installer install core");
  });

  it("dim (no args, non-TTY) prints facade help and fails instead of hanging", async () => {
    const root = await tempDir("dim-cli-no-args-non-tty-");
    const { env } = await baseEnv(root);
    const result = await runCli([], tsxPath!, env, root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("DIM installer/facade");
    expect(result.stderr).toContain("interactive installation requires a TTY");
  });

  it("dim installer <garbage> is rejected as an unknown command", async () => {
    const root = await tempDir("dim-cli-installer-garbage-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "garbage"], tsxPath!, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown installer command: garbage");
  });

  it("accepts repeated installer namespace tokens", async () => {
    const root = await tempDir("dim-cli-installer-repeated-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "installer", "install", "core", "--help"], tsxPath!, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: dim installer install core");
  });

  it("shows the exact control-plane installer usage", async () => {
    // Given
    const root = await tempDir("dim-control-plane-help-");
    const { env } = await baseEnv(root);

    // When
    const result = await runCli(["installer", "install", "control-plane", "--help"], tsxPath!, env, root);

    // Then
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: dim installer install control-plane --config FILE");
  });

  it("shows the exact control-plane recovery usage", async () => {
    // Given
    const root = await tempDir("dim-control-plane-recover-help-");
    const { env } = await baseEnv(root);

    // When
    const result = await runCli(["installer", "recover", "control-plane", "--help"], tsxPath!, env, root);

    // Then
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Usage: dim installer recover control-plane --roll-forward --generation GENERATION"
    );
  });

  it.each([
    ["missing flags", []],
    ["missing generation", ["--roll-forward"]],
    ["missing roll-forward", ["--generation", "a".repeat(64)]],
    ["repeated generation", ["--roll-forward", "--generation", "a".repeat(64), "--generation", "b".repeat(64)]],
    ["malformed generation", ["--roll-forward", "--generation", "not-a-generation"]],
    ["unknown option", ["--roll-forward", "--generation", "a".repeat(64), "--config", "/tmp/install.json"]]
  ])("rejects control-plane recovery with %s before Docker or state mutation", async (_case, commandArgs) => {
    // Given
    const root = await tempDir("dim-control-plane-invalid-recovery-");
    const { env } = await baseEnv(root);
    const bin = join(root, "bin");
    const dockerInvoked = join(root, "docker-invoked");
    const stateHome = join(root, "state-home");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "docker"), `#!/bin/sh\ntouch '${dockerInvoked}'\nexit 99\n`, { mode: 0o755 });

    // When
    const result = await runCli(
      ["installer", "recover", "control-plane", ...commandArgs],
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}`, XDG_STATE_HOME: stateHome },
      root
    );

    // Then
    expect(result.code).toBe(1);
    await expect(access(dockerInvoked)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(stateHome, "dim", "control-plane"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["missing --config", []],
    ["repeated --config", ["--config", "/tmp/one.json", "--config", "/tmp/two.json"]],
    ["unknown option", ["--config", "/tmp/install.json", "--state-root", "/tmp/state"]],
    ["relative --config", ["--config", "install.json"]]
  ])("rejects %s before Docker or state mutation", async (_case, commandArgs) => {
    // Given
    const root = await tempDir("dim-control-plane-invalid-cli-");
    const { env } = await baseEnv(root);
    const bin = join(root, "bin");
    const dockerInvoked = join(root, "docker-invoked");
    const stateHome = join(root, "state-home");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "docker"), `#!/bin/sh\ntouch '${dockerInvoked}'\nexit 99\n`, { mode: 0o755 });

    // When
    const result = await runCli(
      ["installer", "install", "control-plane", ...commandArgs],
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}`, XDG_STATE_HOME: stateHome },
      root
    );

    // Then
    expect(result.code).toBe(1);
    await expect(access(dockerInvoked)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(stateHome, "dim", "control-plane"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("delegates an absolute --config path to the control-plane installer", async () => {
    // Given
    const root = await tempDir("dim-control-plane-delegation-");
    const { env } = await baseEnv(root);
    const configPath = join(root, "missing-install.json");

    // When
    const result = await runCli(
      ["installer", "install", "control-plane", "--config", configPath],
      tsxPath!,
      { ...env, XDG_STATE_HOME: join(root, "state-home") },
      root
    );

    // Then
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("control-plane installer config must be a non-symbolic-link mode-0600 regular file");
  });

  it("rejects an empty obsolete ordinary-pool selector before reading control-plane config", async () => {
    // Given: the obsolete environment key is present but empty and the config path does not exist.
    const root = await tempDir("dim-control-plane-predecessor-selector-");
    const { env } = await baseEnv(root);
    const stateHome = join(root, "state-home");
    if (tsxPath === undefined) throw new TypeError("tsx executable is required for this suite");

    // When: the real facade starts control-plane installation.
    const result = await runCli(
      ["installer", "install", "control-plane", "--config", join(root, "missing.json")],
      tsxPath,
      { ...env, DIM_ORDINARY_CI_POOL_CONNECTION_FILE: "", XDG_STATE_HOME: stateHome },
      root
    );

    // Then: key presence is rejected before config reading or installer-state creation.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DIM_ORDINARY_CI_POOL_CONNECTION_FILE");
    expect(result.stderr).not.toContain("config must be");
    await expect(access(join(stateHome, "dim", "control-plane"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects obsolete install-cp before configured CLI forwarding", async () => {
    // Given
    const root = await tempDir("dim-control-plane-obsolete-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    const echoFile = join(root, "echo.json");
    await writeStubCli(stub, { versionOutput: "5.5.5", echoFile });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      cli: { mode: "proxied", version: "5.5.5", executable: stub }
    }));

    // When
    const result = await runCli(["install-cp"], tsxPath!, env, root);

    // Then
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("dim installer install control-plane --config FILE");
    await expect(access(echoFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects removed top-level installer commands", async () => {
    const root = await tempDir("dim-cli-legacy-install-");
    const { env } = await baseEnv(root);
    for (const command of ["install-cli", "install-plugin"]) {
      const result = await runCli([command], tsxPath!, env, root);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("DIM CLI is not installed");
    }
  });

  it("dim installer install core rejects --no-local-bin combined with --local-bin", async () => {
    const root = await tempDir("dim-cli-conflicting-flags-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "install", "core", "--no-local-bin", "--local-bin"], tsxPath!, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--no-local-bin and --local-bin cannot be used together");
  });

  it("dim installer install core rejects unknown flags", async () => {
    const root = await tempDir("dim-cli-unknown-flag-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "install", "core", "--bogus-flag"], tsxPath!, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("dim:");
  });

  it("non-TTY registry core install fails before npm unless the exact host mirror plugin is selected", async () => {
    // Given
    const root = await tempDir("dim-cli-required-plugin-non-tty-");
    const { env } = await baseEnv(root);
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(bin, { recursive: true });
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.9.0" });

    // When
    const result = await runCli(
      ["installer", "install", "core", "--no-local-bin"],
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@0.9.0'");
    await expect(access(npmArgs)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs and activates the explicitly selected exact-version host mirror plugin before readiness", async () => {
    // Given
    const root = await tempDir("dim-cli-required-plugin-explicit-");
    const { env, dataHome } = await baseEnv(root);
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(bin, { recursive: true });
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.9.0" });

    // When
    const result = await runCli(
      [
        "installer", "install", "core", "--no-local-bin",
        "--host-mirror-plugin", "@slop-lab/dim-plugin-host-mirrors@0.9.0"
      ],
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(npmArgs, "utf8"))).toContain("@slop-lab/dim-plugin-host-mirrors@0.9.0");
    expect(JSON.parse(await readFile(join(dataHome, "runtime", "current", "plugins.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      plugins: ["@slop-lab/dim-plugin-host-mirrors"]
    });
  });

  it("upgrades an enabled host mirror plugin to the installer version without prompting", async () => {
    // Given
    const root = await tempDir("dim-cli-required-plugin-upgrade-");
    const { env, dataHome } = await baseEnv(root);
    const current = join(dataHome, "runtime", "current");
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(current, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(current, "package.json"), JSON.stringify({
      dependencies: { "@slop-lab/dim-plugin-host-mirrors": "0.8.0" }
    }));
    await writeFile(join(current, "plugins.json"), JSON.stringify({
      schemaVersion: 1,
      plugins: ["@slop-lab/dim-plugin-host-mirrors"]
    }));
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.9.0" });

    // When
    const result = await runCli(
      ["installer", "install", "core", "--no-local-bin"],
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code, result.stderr).toBe(0);
    const args = JSON.parse(await readFile(npmArgs, "utf8"));
    expect(args).toContain("@slop-lab/dim-plugin-host-mirrors@0.9.0");
    expect(args).not.toContain("@slop-lab/dim-plugin-host-mirrors@0.8.0");
  });

  it("TTY registry core install offers and accepts the exact-version host mirror plugin", async () => {
    // Given
    const root = await tempDir("dim-cli-required-plugin-tty-accept-");
    const { env, dataHome } = await baseEnv(root);
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: join(root, "npm-args.json"), versionOutput: "0.9.0" });

    // When
    const result = await runCliInPty(
      ["installer", "install", "core", "--no-local-bin"],
      "y\n",
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("@slop-lab/dim-plugin-host-mirrors@0.9.0");
    expect(JSON.parse(await readFile(join(dataHome, "runtime", "current", "plugins.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      plugins: ["@slop-lab/dim-plugin-host-mirrors"]
    });
  });

  it("TTY registry core install leaves the host unchanged when the host mirror plugin is declined", async () => {
    // Given
    const root = await tempDir("dim-cli-required-plugin-tty-decline-");
    const { env, dataHome } = await baseEnv(root);
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(bin, { recursive: true });
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.9.0" });

    // When
    const result = await runCliInPty(
      ["installer", "install", "core", "--no-local-bin"],
      "n\n",
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("@slop-lab/dim-plugin-host-mirrors@0.9.0");
    await expect(access(npmArgs)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(dataHome, "runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("dim installer install plugin requires the shared CLI runtime first", async () => {
    const root = await tempDir("dim-plugin-before-cli-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "install", "plugin", "@example/plugin@1.0.0"], tsxPath!, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CLI must be installed before plugins");
  });

  it("rejects a missing configured CLI before plugin npm mutation", async () => {
    // Given
    const root = await tempDir("dim-plugin-missing-configured-cli-");
    const { env, configPath } = await baseEnv(root);
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      cli: { mode: "proxied", version: "1.0.0", executable: join(root, "missing-dim") }
    }));
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "1.0.0" });

    // When
    const result = await runCli(
      ["installer", "install", "plugin", "@example/plugin@1.0.0"],
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not executable");
    await expect(access(npmArgs)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a configured CLI version mismatch before plugin npm mutation", async () => {
    // Given
    const root = await tempDir("dim-plugin-mismatched-configured-cli-");
    const { env, configPath, dataHome } = await baseEnv(root);
    const pluginHome = join(dataHome, "runtime", "current");
    const executable = join(pluginHome, "node_modules", ".bin", "dim");
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(executable), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeStubCli(executable, { versionOutput: "2.0.0" });
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      cli: { mode: "proxied", version: "1.0.0", executable }
    }));
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "1.0.0" });

    // When
    const result = await runCli(
      ["installer", "install", "plugin", "@example/plugin@1.0.0"],
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("configured version 1.0.0 does not match installed 2.0.0");
    await expect(access(npmArgs)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enables multiple installed plugins in one command", async () => {
    const root = await tempDir("dim-enable-plugins-");
    const { env, configPath, dataHome } = await baseEnv(root);
    const pluginHome = join(dataHome, "runtime", "current");
    const executable = join(pluginHome, "node_modules", ".bin", "dim");
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(pluginHome, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      cli: { mode: "proxied", version: "0.9.0", executable }
    }));
    await writeFile(join(pluginHome, "package.json"), JSON.stringify({
      private: true,
      dependencies: { "plugin-one": "1.0.0", "plugin-two": "2.0.0" }
    }));
    await writeFile(join(pluginHome, "plugins.json"), '{"schemaVersion":1,"plugins":[]}\n');

    const result = await runCli(["installer", "enable-plugin", "plugin-two", "plugin-one"], tsxPath!, env, root);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Enabled plugin-two\nEnabled plugin-one\n");
    expect(JSON.parse(await readFile(join(pluginHome, "plugins.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      plugins: ["plugin-one", "plugin-two"]
    });
  });

  it("dim installer install core help warns about direct mode under mise", async () => {
    const root = await tempDir("dim-cli-mise-help-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "install", "core", "--help"], tsxPath!, { ...env, MISE_SHELL: "bash" }, root);
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
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.9.0" });
    await writeFile(join(bundle, "core.tgz"), "core");
    await writeFile(join(bundle, "cli.tgz"), "cli");
    await writeFile(join(bundle, "installer.tgz"), "installer");
    await writeFile(join(bundle, "packages.json"), JSON.stringify({
      schemaVersion: 1,
      packages: [
        { name: "@slop-lab/dim-core", version: "0.9.0", file: "core.tgz" },
        { name: "@slop-lab/dim-cli", version: "0.9.0", file: "cli.tgz" },
        { name: "@slop-lab/dim-installer", version: "0.9.0", file: "installer.tgz" }
      ]
    }));

    const result = await runCli(
      ["installer", "install", "core", "--local-packages", bundle, "--no-local-bin"],
      tsxPath!,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Installed local DIM CLI 0.9.0");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.cli).toMatchObject({ mode: "proxied", version: "0.9.0" });
    expect(config.cli.executable).toBe(join(dataHome, "runtime", "current", "node_modules", ".bin", "dim"));
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
    expect(echoed.env.DIM_INSTALLER_VERSION).toBe("0.9.0");
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
    expect(result.stdout).toContain("DIM CLI 5.5.5 (via DIM installer 0.9.0)");
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
    expect(result.stdout).toContain("DIM CLI 9.0.0 (via DIM installer 0.9.0)");
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
    expect(result.stderr).toContain("run 'dim installer install core'");
  });
});
