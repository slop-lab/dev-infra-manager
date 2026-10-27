import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeStubCli } from "./support.js";
import {
  baseEnv,
  cleanupCliTempDirs,
  runCli,
  sourceRepositoryUrl,
  tempDir,
  tsxPath
} from "./cliTestSupport.js";

afterEach(cleanupCliTempDirs);

describe("cli.ts dispatch (integration, via tsx subprocess)", () => {
  it("routes the frozen SSH host endpoint without a configured presentation CLI", async () => {
    const root = await tempDir("dim-host-facade-only-");
    const { env, dataHome } = await baseEnv(root);
    const executable = join(dataHome, "runtime/current/node_modules/.bin/dim-host");
    const capture = join(root, "host-request.json");
    await mkdir(dirname(executable), { recursive: true });
    await writeStubCli(executable, { versionOutput: "4.0.0", echoFile: capture });
    const envelope = Buffer.from(JSON.stringify({ protocol: "dim.cli-host", version: 1, operation: "capabilities" })).toString("base64url");
    const result = await runCli(["__host", envelope], tsxPath, env, root);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(capture, "utf8"))).toMatchObject({ argv: ["__host", envelope], env: { DIM_HOST_EXECUTABLE: executable } });
  });

  it("dim --help reports the facade is not backed by an installed CLI", async () => {
    const root = await tempDir("dim-cli-help-uninstalled-");
    const { env } = await baseEnv(root);
    const result = await runCli(["--help"], tsxPath, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DIM installer/facade");
    expect(result.stdout).toContain("DIM CLI is not installed.");
    expect(result.stdout).toContain(sourceRepositoryUrl);
  });

  it("dim --version reports installer-only state when no CLI is configured", async () => {
    const root = await tempDir("dim-cli-version-uninstalled-");
    const { env } = await baseEnv(root);
    const result = await runCli(["--version"], tsxPath, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DIM installer 0.10.0");
    expect(result.stdout).toContain("DIM CLI: not installed");
  });

  it("dim <anything> fails with exit code 2 when no CLI is installed", async () => {
    const root = await tempDir("dim-cli-no-cli-dispatch-");
    const { env } = await baseEnv(root);
    const result = await runCli(["workspace", "list"], tsxPath, env, root);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("DIM CLI is not installed");
    expect(result.stderr).toContain("dim installer install core");
  });

  it("dim (no args, non-TTY) prints facade help and fails instead of hanging", async () => {
    const root = await tempDir("dim-cli-no-args-non-tty-");
    const { env } = await baseEnv(root);
    const result = await runCli([], tsxPath, env, root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("DIM installer/facade");
    expect(result.stderr).toContain("interactive installation requires a TTY");
  });

  it("dim installer <garbage> is rejected as an unknown command", async () => {
    const root = await tempDir("dim-cli-installer-garbage-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "garbage"], tsxPath, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown installer command: garbage");
  });

  it("accepts repeated installer namespace tokens", async () => {
    const root = await tempDir("dim-cli-installer-repeated-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "installer", "install", "core", "--help"], tsxPath, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: dim installer install core");
  });

  it("rejects the obsolete install-cp token before configured CLI proxy dispatch", async () => {
    // Given
    const root = await tempDir("dim-cli-install-cp-configured-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    const echoFile = join(root, "echo.json");
    await writeStubCli(stub, { versionOutput: "5.5.5", echoFile });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, cli: { mode: "proxied", version: "5.5.5", executable: stub } })
    );

    // When
    const result = await runCli(["install-cp"], tsxPath, env, root);

    // Then
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("installer install control-plane --config FILE");
    await expect(access(echoFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects removed top-level installer commands", async () => {
    const root = await tempDir("dim-cli-legacy-install-");
    const { env } = await baseEnv(root);
    for (const command of ["install-cli", "install-plugin"]) {
      const result = await runCli([command], tsxPath, env, root);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("DIM CLI is not installed");
    }
  });

  it("dim installer install core rejects --no-local-bin combined with --local-bin", async () => {
    const root = await tempDir("dim-cli-conflicting-flags-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "install", "core", "--no-local-bin", "--local-bin"], tsxPath, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--no-local-bin and --local-bin cannot be used together");
  });

  it("dim installer install core rejects unknown flags", async () => {
    const root = await tempDir("dim-cli-unknown-flag-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "install", "core", "--bogus-flag"], tsxPath, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("dim:");
  });

  it("dim installer install core help warns about direct mode under mise", async () => {
    const root = await tempDir("dim-cli-mise-help-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "install", "core", "--help"], tsxPath, { ...env, MISE_SHELL: "bash" }, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--local-bin under mise may shadow its dim shim");
    expect(result.stdout).toContain("bypass the installer facade");
  });
});
