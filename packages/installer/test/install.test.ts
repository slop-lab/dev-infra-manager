import { chmod, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredCli,
  configuredPluginHome,
  defaultBinDirectory,
  defaultDataHome,
  defaultInstallPrefix,
  defaultPluginHome,
  defaultUserConfigPath,
  installDimCli,
  installManagedSymlink,
  installPlugins,
  packageNameFromSpecifier,
  queryCliVersion,
  readUserConfig,
  validateConfiguredCli
} from "../src/install.js";
import { makeTempDir, writeFailingStub, writeFakeCliNpm, writeFakePluginNpm, writeStubCli } from "./support.js";

describe("@slop-lab/dim-installer", () => {
  const temporaryDirectories: string[] = [];

  async function tempDir(prefix: string): Promise<string> {
    const dir = await makeTempDir(prefix);
    temporaryDirectories.push(dir);
    return dir;
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(temporaryDirectories.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  });

  describe("packageNameFromSpecifier", () => {
    it("extracts registry package names without guessing path specs", () => {
      expect(packageNameFromSpecifier("@dev-infra-manager/plugin-github")).toBe("@dev-infra-manager/plugin-github");
      expect(packageNameFromSpecifier("@company/internal-git@1.2.3")).toBe("@company/internal-git");
      expect(packageNameFromSpecifier("dim-plugin-example@2")).toBe("dim-plugin-example");
      expect(packageNameFromSpecifier("./plugin.tgz")).toBeUndefined();
    });
  });

  describe("default path helpers", () => {
    it("derive from XDG/HOME environment variables", () => {
      const env = { HOME: "/home/example" };
      expect(defaultInstallPrefix(env)).toBe("/home/example/.local");
      expect(defaultBinDirectory(env)).toBe("/home/example/.local/bin");
      expect(defaultDataHome(env)).toBe("/home/example/.local/share/dim");
      expect(defaultPluginHome(env)).toBe("/home/example/.local/share/dim/plugins");
      expect(defaultUserConfigPath(env)).toBe("/home/example/.config/dim/config.json");
    });

    it("honor explicit overrides over HOME-derived defaults", () => {
      const env = {
        HOME: "/home/example",
        XDG_DATA_HOME: "/custom/data",
        XDG_CONFIG_HOME: "/custom/config",
        DIM_DATA_HOME: "/explicit/data-home",
        DIM_PLUGIN_HOME: "/explicit/plugins",
        DIM_INSTALL_PREFIX: "/explicit/prefix",
        DIM_CONFIG_PATH: "/explicit/config.json"
      };
      expect(defaultDataHome(env)).toBe("/explicit/data-home");
      expect(defaultPluginHome(env)).toBe("/explicit/plugins");
      expect(defaultInstallPrefix(env)).toBe("/explicit/prefix");
      expect(defaultUserConfigPath(env)).toBe("/explicit/config.json");
    });

  });

  describe("readUserConfig", () => {
    it("returns a bare schema-1 config when the file does not exist", async () => {
      const dir = await tempDir("dim-config-enoent-");
      expect(await readUserConfig(join(dir, "missing.json"))).toEqual({ schemaVersion: 1 });
    });

    it("rejects a config file with the wrong schema version", async () => {
      const dir = await tempDir("dim-config-bad-schema-");
      const target = join(dir, "dim.json");
      await writeFile(target, JSON.stringify({ schemaVersion: 2 }));
      await expect(readUserConfig(target)).rejects.toThrow(/invalid DIM user config/);
    });

    it("rejects a malformed cli block", async () => {
      const dir = await tempDir("dim-config-bad-cli-");
      const target = join(dir, "dim.json");
      await writeFile(target, JSON.stringify({ schemaVersion: 1, cli: { mode: "direct" } }));
      await expect(readUserConfig(target)).rejects.toThrow(/invalid cli configuration/);
    });
  });

  describe("installDimCli", () => {
    it("installs the pinned CLI version, verifies it is executable, and writes proxied config", async () => {
      const root = await tempDir("dim-install-cli-");
      const npm = join(root, "npm.mjs");
      const argumentsFile = join(root, "arguments.json");
      await writeFakeCliNpm(npm, { argsFile: argumentsFile, versionOutput: "9.9.9" });

      const dataHome = join(root, "data-home");
      const configPath = join(root, "config", "dim", "config.json");
      const pluginHome = join(root, "plugin-home");
      vi.stubEnv("DIM_PLUGIN_HOME", pluginHome);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ schemaVersion: 1, workspaceBackend: "gvisor" }));

      const installed = await installDimCli({
        version: "9.9.9",
        exposeOnPath: false,
        npmCommand: npm,
        dataHome,
        configPath
      });

      const versionDirectory = join(dataHome, "cli", "9.9.9");
      expect(JSON.parse(await readFile(argumentsFile, "utf8"))).toEqual([
        "install",
        "--prefix",
        versionDirectory,
        "--save-exact",
        "--no-fund",
        "--no-audit",
        "@slop-lab/dim-cli@9.9.9"
      ]);

      const executable = join(versionDirectory, "node_modules", ".bin", "dim");
      expect(installed).toEqual({ executable, mode: "proxied", version: "9.9.9" });
      expect("symlink" in installed).toBe(false);

      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        schemaVersion: 1,
        workspaceBackend: "gvisor",
        cli: { mode: "proxied", version: "9.9.9", executable },
        pluginHome
      });
      expect(await configuredCli({ DIM_CONFIG_PATH: configPath })).toEqual({
        mode: "proxied",
        version: "9.9.9",
        executable
      });
    });

    it("creates a managed ~/.local/bin symlink in direct mode", async () => {
      const root = await tempDir("dim-install-direct-");
      const npm = join(root, "npm.mjs");
      const argumentsFile = join(root, "arguments.json");
      await writeFakeCliNpm(npm, { argsFile: argumentsFile, versionOutput: "1.0.0" });

      const dataHome = join(root, "data-home");
      const binDirectory = join(root, "bin");
      const configPath = join(root, "config", "dim.json");

      const installed = await installDimCli({
        version: "1.0.0",
        exposeOnPath: true,
        npmCommand: npm,
        dataHome,
        binDirectory,
        configPath
      });

      const executable = join(dataHome, "cli", "1.0.0", "node_modules", ".bin", "dim");
      const linkPath = join(binDirectory, "dim");
      expect(installed).toEqual({ executable, mode: "direct", version: "1.0.0", symlink: linkPath });
      expect(await readlink(linkPath)).toBe(executable);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        cli: { mode: "direct", version: "1.0.0", executable }
      });
    });

    it("preserves unknown fields already present in the user config", async () => {
      const root = await tempDir("dim-install-preserve-");
      const npm = join(root, "npm.mjs");
      await writeFakeCliNpm(npm, { argsFile: join(root, "arguments.json"), versionOutput: "2.0.0" });

      const configPath = join(root, "dim.json");
      await mkdir(root, { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ schemaVersion: 1, futureFeature: { enabled: true }, pluginHome: "/kept/plugin/home" })
      );

      await installDimCli({
        version: "2.0.0",
        exposeOnPath: false,
        npmCommand: npm,
        dataHome: join(root, "data-home"),
        configPath
      });

      const written = JSON.parse(await readFile(configPath, "utf8"));
      expect(written.futureFeature).toEqual({ enabled: true });
      expect(written.pluginHome).toBe("/kept/plugin/home");
      expect(written.cli).toEqual({
        mode: "proxied",
        version: "2.0.0",
        executable: join(root, "data-home", "cli", "2.0.0", "node_modules", ".bin", "dim")
      });
    });
  });

  describe("installManagedSymlink", () => {
    async function setup(prefix: string) {
      const root = await tempDir(prefix);
      const managedRoot = join(root, "cli");
      const versionADir = join(managedRoot, "1.0.0", "node_modules", ".bin");
      const versionBDir = join(managedRoot, "2.0.0", "node_modules", ".bin");
      await mkdir(versionADir, { recursive: true });
      await mkdir(versionBDir, { recursive: true });
      const targetA = join(versionADir, "dim");
      const targetB = join(versionBDir, "dim");
      await writeFile(targetA, "#!/bin/sh\nexit 0\n");
      await writeFile(targetB, "#!/bin/sh\nexit 0\n");
      await chmod(targetA, 0o755);
      await chmod(targetB, 0o755);
      const linkPath = join(root, "bin", "dim");
      return { root, managedRoot, targetA, targetB, linkPath };
    }

    it("creates a new symlink pointing at the managed target", async () => {
      const { managedRoot, targetA, linkPath } = await setup("dim-symlink-create-");
      await installManagedSymlink(linkPath, targetA, managedRoot);
      expect(await readlink(linkPath)).toBe(targetA);
    });

    it("replaces an existing managed symlink when re-run with a new version", async () => {
      const { managedRoot, targetA, targetB, linkPath } = await setup("dim-symlink-replace-");
      await installManagedSymlink(linkPath, targetA, managedRoot);
      await installManagedSymlink(linkPath, targetB, managedRoot);
      expect(await readlink(linkPath)).toBe(targetB);
    });

    it("refuses to overwrite a pre-existing regular file", async () => {
      const { managedRoot, targetA, linkPath } = await setup("dim-symlink-regular-file-");
      await mkdir(join(linkPath, ".."), { recursive: true });
      await writeFile(linkPath, "not managed by dim");
      await expect(installManagedSymlink(linkPath, targetA, managedRoot)).rejects.toThrow(/not managed by DIM installer/);
      expect(await readFile(linkPath, "utf8")).toBe("not managed by dim");
    });

    it("refuses to overwrite a symlink pointing outside the managed root", async () => {
      const { root, managedRoot, targetA, linkPath } = await setup("dim-symlink-external-");
      const externalTarget = join(root, "unrelated-app");
      await writeFile(externalTarget, "#!/bin/sh\nexit 0\n");
      await chmod(externalTarget, 0o755);
      await mkdir(join(linkPath, ".."), { recursive: true });
      await symlink(externalTarget, linkPath);

      await expect(installManagedSymlink(linkPath, targetA, managedRoot)).rejects.toThrow(/not managed by DIM installer/);
      expect(await readlink(linkPath)).toBe(externalTarget);
    });
  });

  describe("validateConfiguredCli", () => {
    it("throws a helpful error when the executable is missing", async () => {
      const root = await tempDir("dim-validate-missing-");
      const cli = { mode: "proxied" as const, version: "1.0.0", executable: join(root, "does-not-exist") };
      await expect(validateConfiguredCli(cli, undefined)).rejects.toThrow(/run 'dim install-cli'/);
    });

    it("throws when the executable exists but is not executable", async () => {
      const root = await tempDir("dim-validate-not-exec-");
      const executable = join(root, "dim");
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o600);
      const cli = { mode: "proxied" as const, version: "1.0.0", executable };
      await expect(validateConfiguredCli(cli, undefined)).rejects.toThrow(/not executable/);
    });

    it("throws when the configured executable resolves back to the facade itself", async () => {
      const root = await tempDir("dim-validate-self-ref-");
      const executable = join(root, "dim");
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
      const cli = { mode: "proxied" as const, version: "1.0.0", executable };
      await expect(validateConfiguredCli(cli, executable)).rejects.toThrow(/points back to the installer facade/);
    });

    it("skips the self-reference check when facadePath is undefined", async () => {
      const root = await tempDir("dim-validate-undefined-facade-");
      const executable = join(root, "dim");
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
      const cli = { mode: "proxied" as const, version: "1.0.0", executable };
      await expect(validateConfiguredCli(cli, undefined)).resolves.toBe(executable);
    });

    it("does not throw when facadePath does not exist", async () => {
      const root = await tempDir("dim-validate-missing-facade-");
      const executable = join(root, "dim");
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
      const cli = { mode: "proxied" as const, version: "1.0.0", executable };
      await expect(validateConfiguredCli(cli, join(root, "no-such-facade"))).resolves.toBe(executable);
    });
  });

  describe("queryCliVersion", () => {
    it("resolves the trimmed stdout of `<executable> --version`", async () => {
      const root = await tempDir("dim-query-version-");
      const stub = join(root, "dim");
      await writeStubCli(stub, { versionOutput: "3.4.5" });
      await expect(queryCliVersion(stub)).resolves.toBe("3.4.5");
    });

    it("rejects when the executable exits with a non-zero status", async () => {
      const root = await tempDir("dim-query-version-fail-");
      const stub = join(root, "dim");
      await writeFailingStub(stub, 7);
      await expect(queryCliVersion(stub)).rejects.toThrow(/exited with 7/);
    });
  });

  describe("installPlugins", () => {
    it("creates the plugin home package.json, installs packages, and writes plugins.json", async () => {
      const root = await tempDir("dim-install-plugins-");
      const npm = join(root, "npm.mjs");
      const argumentsFile = join(root, "arguments.json");
      await writeFakePluginNpm(npm, { argsFile: argumentsFile });

      const pluginHome = join(root, "plugins");
      const configPath = join(root, "dim.json");

      const installed = await installPlugins(
        ["@dev-infra-manager/plugin-github@1.0.0", "dim-plugin-example@2.0.0"],
        { pluginHome, npmCommand: npm, configPath }
      );

      expect(new Set(installed)).toEqual(new Set(["@dev-infra-manager/plugin-github", "dim-plugin-example"]));
      expect(JSON.parse(await readFile(argumentsFile, "utf8"))).toEqual([
        "install",
        "--save-exact",
        "--no-fund",
        "--no-audit",
        "@dev-infra-manager/plugin-github@1.0.0",
        "dim-plugin-example@2.0.0"
      ]);

      const manifest = JSON.parse(await readFile(join(pluginHome, "plugins.json"), "utf8"));
      expect(manifest).toEqual({
        schemaVersion: 1,
        plugins: ["@dev-infra-manager/plugin-github", "dim-plugin-example"]
      });

      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        schemaVersion: 1,
        pluginHome
      });
    });

    it("dedupes and sorts plugins.json across repeated installs, and merges with an existing manifest", async () => {
      const root = await tempDir("dim-install-plugins-merge-");
      const pluginHome = join(root, "plugins");
      await mkdir(pluginHome, { recursive: true });
      await writeFile(
        join(pluginHome, "plugins.json"),
        JSON.stringify({ schemaVersion: 1, plugins: ["zzz-existing-plugin"] })
      );

      const npm = join(root, "npm.mjs");
      await writeFakePluginNpm(npm, { argsFile: join(root, "arguments.json") });

      await installPlugins(["aaa-new-plugin@1.0.0"], { pluginHome, npmCommand: npm, configPath: join(root, "dim.json") });

      const manifest = JSON.parse(await readFile(join(pluginHome, "plugins.json"), "utf8"));
      expect(manifest.plugins).toEqual(["aaa-new-plugin", "zzz-existing-plugin"]);
    });

    it("preserves unknown fields in the user config when updating pluginHome", async () => {
      const root = await tempDir("dim-install-plugins-preserve-");
      const pluginHome = join(root, "plugins");
      const configPath = join(root, "dim.json");
      await writeFile(configPath, JSON.stringify({ schemaVersion: 1, futureField: 42 }));

      const npm = join(root, "npm.mjs");
      await writeFakePluginNpm(npm, { argsFile: join(root, "arguments.json") });

      await installPlugins(["dim-plugin-example@1.0.0"], { pluginHome, npmCommand: npm, configPath });

      const written = JSON.parse(await readFile(configPath, "utf8"));
      expect(written.futureField).toBe(42);
      expect(written.pluginHome).toBe(pluginHome);
    });

    it("throws when npm does not add a requested package as a direct dependency", async () => {
      const root = await tempDir("dim-install-plugins-missing-");
      const pluginHome = join(root, "plugins");
      const npm = join(root, "npm.mjs");
      await writeFakePluginNpm(npm, {
        argsFile: join(root, "arguments.json"),
        skipNames: ["dim-plugin-example"]
      });

      await expect(
        installPlugins(["dim-plugin-example@1.0.0"], { pluginHome, npmCommand: npm, configPath: join(root, "dim.json") })
      ).rejects.toThrow(/did not install 'dim-plugin-example' as a direct plugin dependency/);
    });

    it("requires at least one plugin specifier", async () => {
      await expect(installPlugins([], { pluginHome: "/irrelevant" })).rejects.toThrow(/at least one plugin package/);
    });
  });

  describe("configuredPluginHome / configuredCli", () => {
    it("fall back to defaults when no config file exists", async () => {
      const dir = await tempDir("dim-configured-defaults-");
      const configPath = join(dir, "dim.json");
      expect(await configuredPluginHome({ DIM_CONFIG_PATH: configPath, HOME: dir })).toBe(
        defaultPluginHome({ HOME: dir })
      );
      expect(await configuredCli({ DIM_CONFIG_PATH: configPath, HOME: dir })).toBeUndefined();
    });
  });
});
