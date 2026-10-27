import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFakeCliNpm } from "./support.js";
import {
  baseEnv,
  cleanupCliTempDirs,
  npmArguments,
  runCli,
  runCliInPty,
  tempDir,
  tsxPath
} from "./cliTestSupport.js";

afterEach(cleanupCliTempDirs);

describe("cli.ts dispatch (integration, via tsx subprocess)", () => {
  it("installs the base CLI without plugins or a controller on a non-TTY", async () => {
    // Given
    const root = await tempDir("dim-cli-required-plugin-non-tty-");
    const { env, dataHome } = await baseEnv(root);
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(bin, { recursive: true });
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.10.0", controllerArgsFile: join(root, "controller-calls.json") });

    // When
    const result = await runCli(
      ["installer", "install", "core", "--no-local-bin"],
      tsxPath,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(await npmArguments(npmArgs)).not.toContain("@slop-lab/dim-host-plugin-mirrors@0.10.0");
    expect(await npmArguments(npmArgs)).not.toContain("@slop-lab/dim-control-plane-admin@0.10.0");
    expect(JSON.parse(await readFile(join(dataHome, "runtime/current/plugins.json"), "utf8"))).toEqual({ schemaVersion: 1, plugins: [] });
    await expect(access(join(root, "controller-calls.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs the administration profile and enables both selected host plugins at the facade version", async () => {
    const root = await tempDir("dim-cli-managed-component-");
    const { env, dataHome } = await baseEnv(root);
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(bin, { recursive: true });
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.10.0" });
    const result = await runCli(["installer", "install", "core", "--no-local-bin", "--with-managed"],
      tsxPath, { ...env, PATH: `${bin}:${env.PATH}` }, root);
    expect(result.code, result.stderr).toBe(0);
    const args = await npmArguments(npmArgs);
    expect(args).toContain("@slop-lab/dim-host-core@0.10.0");
    expect(args).toContain("@slop-lab/dim-control-plane-admin@0.10.0");
    expect(args).toContain("@slop-lab/dim-host-plugin-native-git@0.10.0");
    expect(args).toContain("@slop-lab/dim-host-plugin-execution-worker@0.10.0");
    expect(JSON.parse(await readFile(join(dataHome, "runtime/current/plugins.json"), "utf8"))).toEqual({ schemaVersion: 1, plugins: ["@slop-lab/dim-host-plugin-execution-worker", "@slop-lab/dim-host-plugin-native-git"] });
  });

  it("retains an already selected managed component at the new matched version", async () => {
    const root = await tempDir("dim-cli-managed-component-update-");
    const { env, dataHome } = await baseEnv(root);
    const current = join(dataHome, "runtime/current");
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(current, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(current, "package.json"), JSON.stringify({ dependencies: { "@slop-lab/dim-control-plane-admin": "0.9.0" } }));
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.10.0" });
    const result = await runCli(["installer", "install", "core", "--no-local-bin"],
      tsxPath, { ...env, PATH: `${bin}:${env.PATH}` }, root);
    expect(result.code, result.stderr).toBe(0);
    const args = await npmArguments(npmArgs);
    expect(args).toContain("@slop-lab/dim-control-plane-admin@0.10.0");
    expect(args).not.toContain("@slop-lab/dim-control-plane-admin@0.9.0");
  });

  it.each(["@slop-lab/dim-host-plugin-mirrors@latest", "@slop-lab/dim-host-plugin-mirrors@0.9.0", "other-plugin@0.10.0"])(
    "rejects an unreviewed explicit host mirror selection %s before installing", async (specifier) => {
      const root = await tempDir("dim-cli-optional-plugin-invalid-");
      const { env } = await baseEnv(root);
      const result = await runCli(["installer", "install", "core", "--no-local-bin", "--host-mirror-plugin", specifier],
        tsxPath, env, root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("must be the reviewed package '@slop-lab/dim-host-plugin-mirrors@0.10.0'");
    });

  it("installs and activates the explicitly selected exact-version host mirror plugin", async () => {
    // Given
    const root = await tempDir("dim-cli-required-plugin-explicit-");
    const { env, dataHome } = await baseEnv(root);
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(bin, { recursive: true });
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.10.0" });

    // When
    const result = await runCli(
      [
        "installer", "install", "core", "--no-local-bin",
        "--host-mirror-plugin", "@slop-lab/dim-host-plugin-mirrors@0.10.0"
      ],
      tsxPath,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(await npmArguments(npmArgs)).toContain("@slop-lab/dim-host-plugin-mirrors@0.10.0");
    expect(JSON.parse(await readFile(join(dataHome, "runtime", "current", "plugins.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      plugins: ["@slop-lab/dim-host-plugin-mirrors"]
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
      dependencies: { "@slop-lab/dim-host-plugin-mirrors": "0.8.0" }
    }));
    await writeFile(join(current, "plugins.json"), JSON.stringify({
      schemaVersion: 1,
      plugins: ["@slop-lab/dim-host-plugin-mirrors"]
    }));
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.10.0" });

    // When
    const result = await runCli(
      ["installer", "install", "core", "--no-local-bin"],
      tsxPath,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code, result.stderr).toBe(0);
    const args = await npmArguments(npmArgs);
    expect(args).toContain("@slop-lab/dim-host-plugin-mirrors@0.10.0");
    expect(args).not.toContain("@slop-lab/dim-host-plugin-mirrors@0.8.0");
  });

  it("TTY registry core installation does not prompt for optional plugins", async () => {
    const root = await tempDir("dim-cli-base-tty-");
    const { env, dataHome } = await baseEnv(root);
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: join(root, "npm-args.json"), versionOutput: "0.10.0" });
    const result = await runCliInPty(["installer", "install", "core", "--no-local-bin"], "", tsxPath,
      { ...env, PATH: `${bin}:${env.PATH}` }, root);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain("Install and enable");
    expect(JSON.parse(await readFile(join(dataHome, "runtime/current/plugins.json"), "utf8"))).toEqual({ schemaVersion: 1, plugins: [] });
  });
});
