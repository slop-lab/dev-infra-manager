import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeStubCli } from "./support.js";
import { baseEnv, cleanupCliTempDirs, runCli, tempDir, tsxPath } from "./cliTestSupport.js";

afterEach(cleanupCliTempDirs);

describe("cli.ts dispatch (integration, via tsx subprocess)", () => {
  it("shows the exact control-plane installer usage", async () => {
    // Given
    const root = await tempDir("dim-control-plane-help-");
    const { env } = await baseEnv(root);

    // When
    const result = await runCli(["installer", "install", "control-plane", "--help"], tsxPath, env, root);

    // Then
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: dim installer install control-plane --config FILE");
  });

  it("shows the exact control-plane recovery usage", async () => {
    // Given
    const root = await tempDir("dim-control-plane-recover-help-");
    const { env } = await baseEnv(root);

    // When
    const result = await runCli(["installer", "recover", "control-plane", "--help"], tsxPath, env, root);

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
      tsxPath,
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
      tsxPath,
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
      tsxPath,
      { ...env, XDG_STATE_HOME: join(root, "state-home") },
      root
    );

    // Then
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("control-plane installer config must be a non-symbolic-link mode-0600 regular file");
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

    const result = await runCli(["--version"], tsxPath, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DIM CLI 5.5.5 (via DIM installer 0.10.0)");
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

    const result = await runCli(["--version"], tsxPath, env, root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DIM CLI 9.0.0 (via DIM installer 0.10.0)");
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

    const result = await runCli(["workspace", "list"], tsxPath, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("run 'dim installer install cli'");
  });
});
