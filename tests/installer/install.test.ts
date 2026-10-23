import { access, chmod, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredCli,
  defaultBinDirectory,
  defaultDataHome,
  defaultInstallPrefix,
  defaultPluginHome,
  defaultUserConfigPath,
  installDimCli,
  installHostRuntime,
  hostExecutable,
  cliExecutable,
  installManagedSymlink,
  installPlugins,
  packageNameFromSpecifier,
  queryCliVersion,
  readHostPackageBundle,
  readCliPackageBundle,
  readHostPluginPackageBundle,
  readUserConfig,
  validateConfiguredCli
} from "../../packages/installer/src/install.js";
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
      expect(packageNameFromSpecifier("plugin.tgz")).toBeUndefined();
    });
  });

  describe("default path helpers", () => {
    it("derive from XDG/HOME environment variables", () => {
      const env = { HOME: "/home/example" };
      expect(defaultInstallPrefix(env)).toBe("/home/example/.local");
      expect(defaultBinDirectory(env)).toBe("/home/example/.local/bin");
      expect(defaultDataHome(env)).toBe("/home/example/.local/share/dim");
      expect(defaultPluginHome(env)).toBe("/home/example/.local/share/dim/runtime/current");
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

  describe("independent host and CLI installation", () => {
    async function setup(version = "2.0.0", extra: Partial<Parameters<typeof writeFakeCliNpm>[1]> = {}) {
      const root = await tempDir("dim-independent-runtime-");
      const npm = join(root, "npm.mjs");
      const argsFile = join(root, "npm-args.json");
      const dataHome = join(root, "data");
      const configPath = join(root, "config.json");
      await writeFakeCliNpm(npm, { argsFile, versionOutput: version, ...extra });
      return { root, npm, argsFile, dataHome, configPath, version };
    }

    it("installs presentation separately and preserves unrelated configuration without starting a controller", async () => {
      const fixture = await setup();
      const calls = join(fixture.root, "controller.json");
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: fixture.version, controllerArgsFile: calls });
      await writeFile(fixture.configPath, JSON.stringify({ schemaVersion: 1, futureFeature: { enabled: true } }));
      const installed = await installDimCli({ ...fixture, exposeOnPath: false, npmCommand: fixture.npm });
      expect(installed).toEqual({ executable: cliExecutable(fixture.dataHome), mode: "proxied", version: fixture.version });
      const args = JSON.parse(await readFile(fixture.argsFile, "utf8")) as string[];
      expect(args.at(-1)).toBe("@slop-lab/dim-cli@2.0.0");
      expect(args[args.indexOf("--prefix") + 1]).toContain("/cli/runtime/.staging-");
      expect(await readUserConfig(fixture.configPath)).toMatchObject({ futureFeature: { enabled: true }, cli: installed });
      await expect(access(calls)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(fixture.dataHome, "runtime"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("updates host and plugins while retaining a different compatible CLI release and durable data", async () => {
      const fixture = await setup();
      const cli = await installDimCli({ ...fixture, exposeOnPath: false, npmCommand: fixture.npm, packageSpecifiers: ["@slop-lab/dim-cli@2.0.0"] });
      const cliBefore = await readFile(cli.executable);
      const durable = join(fixture.dataHome, "workspaces");
      await mkdir(durable, { recursive: true }); await writeFile(join(durable, "checkout"), "keep");
      const calls = join(fixture.root, "controller.json");
      const manifest = join(fixture.root, "manifest.json");
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: "3.0.0", controllerArgsFile: calls, controllerManifestFile: manifest });
      const host = await installHostRuntime({ ...fixture, version: "3.0.0", npmCommand: fixture.npm, restartController: true, plugins: [{ name: "@slop-lab/dim-host-plugin-mirrors", specifier: "@slop-lab/dim-host-plugin-mirrors@3.0.0" }] });
      expect(host).toEqual({ executable: hostExecutable(fixture.dataHome), version: "3.0.0" });
      expect(await readFile(cli.executable)).toEqual(cliBefore);
      expect((await readUserConfig(fixture.configPath)).cli).toEqual({ mode: cli.mode, executable: cli.executable, version: cli.version });
      expect((await readUserConfig(fixture.configPath)).host).toEqual(host);
      expect(JSON.parse(await readFile(manifest, "utf8"))).toEqual({ schemaVersion: 1, plugins: ["@slop-lab/dim-host-plugin-mirrors"] });
      expect(JSON.parse(await readFile(calls, "utf8"))).toEqual([["controller", "restart"]]);
      expect(await readFile(join(durable, "checkout"), "utf8")).toBe("keep");
      const args = JSON.parse(await readFile(fixture.argsFile, "utf8")) as string[];
      expect(args).toContain("@slop-lab/dim-host-core@3.0.0"); expect(args.some(value => value.startsWith("@slop-lab/dim-cli@"))).toBe(false);
    });

    it("upgrades retained official host plugins to the host release while keeping the CLI release", async () => {
      const fixture = await setup();
      const cli = await installDimCli({ ...fixture, exposeOnPath: false, npmCommand: fixture.npm });
      await installHostRuntime({ ...fixture, npmCommand: fixture.npm, plugins: [{
        name: "@slop-lab/dim-host-plugin-cache-server", specifier: "@slop-lab/dim-host-plugin-cache-server@2.0.0"
      }, { name: "@example/custom", specifier: "@example/custom@1.2.3" }] });
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: "3.0.0" });
      await installHostRuntime({ ...fixture, version: "3.0.0", npmCommand: fixture.npm });
      const args = JSON.parse(await readFile(fixture.argsFile, "utf8")) as string[];
      expect(args).toContain("@slop-lab/dim-host-plugin-cache-server@3.0.0");
      expect(args).not.toContain("@slop-lab/dim-host-plugin-cache-server@2.0.0");
      expect(args).toContain("@example/custom@1.2.3");
      expect(await queryCliVersion(cli.executable)).toBe("2.0.0");
      expect((await readUserConfig(fixture.configPath)).cli?.version).toBe("2.0.0");
    });

    it("updates only CLI while preserving the host runtime, plugin state and configured host release", async () => {
      const fixture = await setup();
      const host = await installHostRuntime({ ...fixture, npmCommand: fixture.npm });
      const marker = join(fixture.dataHome, "runtime", "current", "sentinel"); await writeFile(marker, "host stays");
      const manifestBefore = await readFile(join(fixture.dataHome, "runtime", "current", "plugins.json"));
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: "8.0.0" });
      await installDimCli({ ...fixture, version: "8.0.0", exposeOnPath: false, npmCommand: fixture.npm });
      expect(await readFile(marker, "utf8")).toBe("host stays");
      expect(await readFile(join(fixture.dataHome, "runtime", "current", "plugins.json"))).toEqual(manifestBefore);
      expect((await readUserConfig(fixture.configPath)).host).toEqual(host);
    });

    it("rejects incompatible host updates before promotion and keeps the retained CLI", async () => {
      const fixture = await setup();
      const cli = await installDimCli({ ...fixture, exposeOnPath: false, npmCommand: fixture.npm });
      await installHostRuntime({ ...fixture, npmCommand: fixture.npm });
      const before = await readFile(fixture.configPath);
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: "3.0.0", protocolVersions: [2] });
      await expect(installHostRuntime({ ...fixture, version: "3.0.0", npmCommand: fixture.npm })).rejects.toThrow(/protocol/);
      expect(await queryCliVersion(hostExecutable(fixture.dataHome))).toBe("2.0.0");
      expect(await queryCliVersion(cli.executable)).toBe("2.0.0");
      expect(await readFile(fixture.configPath)).toEqual(before);
    });

    it("rejects incompatible CLI updates before promotion without changing host or configuration", async () => {
      const fixture = await setup();
      await installHostRuntime({ ...fixture, npmCommand: fixture.npm });
      const previous = await installDimCli({ ...fixture, exposeOnPath: false, npmCommand: fixture.npm });
      const before = await readFile(fixture.configPath);
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: "3.0.0", protocolVersions: [2] });
      await expect(installDimCli({ ...fixture, version: "3.0.0", exposeOnPath: false, npmCommand: fixture.npm })).rejects.toThrow(/protocol/);
      expect(await queryCliVersion(previous.executable)).toBe("2.0.0");
      expect(await queryCliVersion(hostExecutable(fixture.dataHome))).toBe("2.0.0");
      expect(await readFile(fixture.configPath)).toEqual(before);
    });

    it("rejects a wrong staged version without pruning the previous CLI", async () => {
      const fixture = await setup();
      const previous = await installDimCli({ ...fixture, exposeOnPath: false, npmCommand: fixture.npm });
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: "wrong-version" });
      await expect(installDimCli({ ...fixture, exposeOnPath: false, npmCommand: fixture.npm })).rejects.toThrow(/reports wrong-version/);
      expect(await queryCliVersion(previous.executable)).toBe("2.0.0");
    });

    it("exposes a managed CLI launcher that supplies the owned host endpoint", async () => {
      const fixture = await setup();
      const binDirectory = join(fixture.root, "bin");
      const cli = await installDimCli({ ...fixture, exposeOnPath: true, binDirectory, npmCommand: fixture.npm });
      expect(await readlink(join(binDirectory, "dim"))).toBe(cli.executable);
      const capture = join(fixture.root, "captured.json");
      await writeStubCli(join(fixture.dataHome, "cli", "runtime", "current", "node_modules", ".bin", "dim"), { versionOutput: "2.0.0", echoFile: capture });
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)(join(binDirectory, "dim"), ["workspace", "ls"]);
      expect(JSON.parse(await readFile(capture, "utf8"))).toMatchObject({ argv: ["workspace", "ls"], env: { DIM_HOST_EXECUTABLE: hostExecutable(fixture.dataHome) } });
    });

    it("moves the exact former installer symlink into the separate CLI prefix", async () => {
      const fixture = await setup(); const binDirectory = join(fixture.root, "bin");
      const old = join(fixture.dataHome, "runtime/current/node_modules/.bin/dim");
      await mkdir(dirname(old), { recursive: true }); await writeStubCli(old, { versionOutput: "1.0.0" });
      await mkdir(binDirectory); await symlink(old, join(binDirectory, "dim"));
      const cli = await installDimCli({ ...fixture, exposeOnPath: true, binDirectory, npmCommand: fixture.npm });
      expect(await readlink(join(binDirectory, "dim"))).toBe(cli.executable);
      expect(await queryCliVersion(old)).toBe("1.0.0");
    });

    it("restores the previous CLI and managed symlink when configuration fails after promotion", async () => {
      const fixture = await setup(); const binDirectory = join(fixture.root, "bin");
      const previous = await installDimCli({ ...fixture, exposeOnPath: true, binDirectory, npmCommand: fixture.npm });
      const priorTarget = await readlink(join(binDirectory, "dim"));
      await writeFile(fixture.configPath, "not json");
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: "3.0.0" });
      await expect(installDimCli({ ...fixture, version: "3.0.0", exposeOnPath: true, binDirectory, npmCommand: fixture.npm })).rejects.toThrow();
      expect(await queryCliVersion(previous.executable)).toBe("2.0.0");
      expect(await readlink(join(binDirectory, "dim"))).toBe(priorTarget);
    });

    it("preserves foreign bin files and removes a failed clean CLI candidate", async () => {
      const fixture = await setup(); const binDirectory = join(fixture.root, "bin");
      await mkdir(binDirectory); await writeFile(join(binDirectory, "dim"), "user owned");
      await expect(installDimCli({ ...fixture, exposeOnPath: true, binDirectory, npmCommand: fixture.npm })).rejects.toThrow(/not managed by DIM installer/);
      expect(await readFile(join(binDirectory, "dim"), "utf8")).toBe("user owned");
      await expect(access(cliExecutable(fixture.dataHome))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("runs the staged host preflight before changing installed state", async () => {
      const fixture = await setup();
      await installHostRuntime({ ...fixture, npmCommand: fixture.npm });
      const before = await readFile(fixture.configPath);
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: "3.0.0", preflightSource: 'export async function preflightStateCompatibility() { throw new Error("target core rejected workspace state"); }' });
      await expect(installHostRuntime({ ...fixture, version: "3.0.0", npmCommand: fixture.npm })).rejects.toThrow(/target core rejected workspace state/);
      expect(await queryCliVersion(hostExecutable(fixture.dataHome))).toBe("2.0.0");
      expect(await readFile(fixture.configPath)).toEqual(before);
      expect(await readdir(join(fixture.dataHome, "runtime"))).toEqual(["current"]);
    });

    it("restores and restarts the previous host when candidate readiness fails", async () => {
      const fixture = await setup();
      const oldCalls = join(fixture.root, "old-calls.json");
      await installHostRuntime({ ...fixture, npmCommand: fixture.npm });
      await writeStubCli(hostExecutable(fixture.dataHome), { versionOutput: "2.0.0", echoFile: oldCalls });
      const calls = join(fixture.root, "calls.json");
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: "3.0.0", controllerArgsFile: calls, controllerExitCode: 9 });
      await expect(installHostRuntime({ ...fixture, version: "3.0.0", restartController: true, npmCommand: fixture.npm })).rejects.toThrow(/controller restart/);
      expect(await queryCliVersion(hostExecutable(fixture.dataHome))).toBe("2.0.0");
      expect(JSON.parse(await readFile(calls, "utf8"))).toEqual([["controller", "restart"]]);
      expect(JSON.parse(await readFile(oldCalls, "utf8"))).toMatchObject({ argv: ["controller", "restart"] });
    });

    it("stops a ready clean host candidate before rollback when final configuration fails", async () => {
      const fixture = await setup(); const calls = join(fixture.root, "calls.json"); const running = join(fixture.root, "running");
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: fixture.version, controllerArgsFile: calls, controllerRunningFile: running, controllerCorruptConfigFile: fixture.configPath });
      await expect(installHostRuntime({ ...fixture, restartController: true, npmCommand: fixture.npm })).rejects.toThrow();
      expect(JSON.parse(await readFile(calls, "utf8"))).toEqual([["controller", "restart"], ["controller", "stop"]]);
      await expect(access(running)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(hostExecutable(fixture.dataHome))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("preserves a running candidate and previous host backup if stopping it fails", async () => {
      const fixture = await setup(); await installHostRuntime({ ...fixture, npmCommand: fixture.npm });
      const oldMarker = join(fixture.dataHome, "runtime", "current", "sentinel"); await writeFile(oldMarker, "previous");
      const calls = join(fixture.root, "calls.json"); const running = join(fixture.root, "running");
      await writeFakeCliNpm(fixture.npm, { argsFile: fixture.argsFile, versionOutput: "3.0.0", controllerArgsFile: calls, controllerRunningFile: running, controllerStopExitCode: 9, controllerCorruptConfigFile: fixture.configPath });
      await expect(installHostRuntime({ ...fixture, version: "3.0.0", restartController: true, npmCommand: fixture.npm })).rejects.toThrow();
      expect(await queryCliVersion(hostExecutable(fixture.dataHome))).toBe("3.0.0"); await access(running);
      const backup = (await readdir(join(fixture.dataHome, "runtime"))).find(name => name.startsWith(".previous-"));
      expect(backup).toBeDefined(); expect(await readFile(join(fixture.dataHome, "runtime", backup!, "sentinel"), "utf8")).toBe("previous");
    });

    it("restarts the restored host after cancellation during candidate readiness", async () => {
      const fixture = await setup(); await installHostRuntime({ ...fixture, npmCommand: fixture.npm });
      const calls = join(fixture.root, "old-calls.json"); await writeStubCli(hostExecutable(fixture.dataHome), { versionOutput: fixture.version, echoFile: calls });
      const abort = new AbortController();
      await expect(installHostRuntime({ ...fixture, npmCommand: fixture.npm, restartController: true, operation: { signal: abort.signal, activity() {}, reportProgress(stage) { if (stage === "controller readiness") abort.abort(new Error("cancelled")); } } })).rejects.toThrow();
      expect(JSON.parse(await readFile(calls, "utf8"))).toMatchObject({ argv: ["controller", "restart"] });
    });
  });

  describe("readHostPackageBundle", () => {
    async function bundleFixture() {
      const root = await tempDir("dim-local-bundle-");
      const version = "0.10.0-local-test";
      const entries = [
        { name: "@slop-lab/dim-host-core", file: "core.tgz", version, requires: {} },
        { name: "@slop-lab/dim-cli", file: "cli.tgz", version, requires: {} },
        { name: "@slop-lab/dim-contracts-external-url", file: "contract.tgz", version, requires: {} },
        { name: "@slop-lab/dim-control-plane-plugin-git-repositories", file: "native-git.tgz", version, requires: { "@slop-lab/dim-contracts-external-url": version } },
        { name: "@slop-lab/dim-control-plane-admin", file: "managed.tgz", version, requires: { "@slop-lab/dim-host-core": version, "@slop-lab/dim-control-plane-plugin-git-repositories": version } },
        { name: "@slop-lab/dim-host-plugin-mirrors", file: "mirrors.tgz", version, requires: { "@slop-lab/dim-host-core": version } },
        { name: "@slop-lab/dim-installer", file: "installer.tgz", version, requires: {} }
      ];
      await Promise.all(entries.map(({ file }) => writeFile(join(root, file), "fixture archive")));
      const publish = async (packages = entries) => writeFile(join(root, "packages.json"), JSON.stringify({ schemaVersion: 1, packages }));
      await publish();
      return { root, entries, publish };
    }

    it("selects only host artifacts and independently selects presentation artifacts", async () => {
      const { root } = await bundleFixture();
      expect(await readHostPackageBundle(root)).toEqual({
        version: "0.10.0-local-test",
        packageSpecifiers: [join(root, "core.tgz")],
        packageNames: ["@slop-lab/dim-host-core"]
      });
      expect((await readCliPackageBundle(root)).packageNames).toEqual(["@slop-lab/dim-cli"]);
    });

    it("includes the complete managed dependency closure without unrelated plugins or installer", async () => {
      const { root } = await bundleFixture();
      const selected = await readHostPackageBundle(root, ["@slop-lab/dim-control-plane-admin"]);
      expect(selected.packageNames).toEqual([
        "@slop-lab/dim-host-core", "@slop-lab/dim-contracts-external-url",
        "@slop-lab/dim-control-plane-plugin-git-repositories", "@slop-lab/dim-control-plane-admin"
      ]);
      expect(selected.packageSpecifiers).not.toContain(join(root, "mirrors.tgz"));
      expect(selected.packageSpecifiers).not.toContain(join(root, "installer.tgz"));
    });

    it("installs a base workspace plugin without optional managed components", async () => {
      const { root } = await bundleFixture();
      expect((await readHostPackageBundle(root, ["@slop-lab/dim-host-plugin-mirrors"])).packageNames).toEqual([
        "@slop-lab/dim-host-core", "@slop-lab/dim-host-plugin-mirrors"
      ]);
    });

    it("selects exact host plugins from a bundle and rejects a different requested version", async () => {
      const { root } = await bundleFixture();
      expect((await readHostPluginPackageBundle(root, ["@slop-lab/dim-host-plugin-mirrors@0.10.0-local-test"])).packageNames).toEqual([
        "@slop-lab/dim-host-core", "@slop-lab/dim-host-plugin-mirrors"
      ]);
      await expect(readHostPluginPackageBundle(root, ["@slop-lab/dim-host-plugin-mirrors@0.9.0"])).rejects.toThrow(/does not match selected plugin/);
      await expect(readHostPluginPackageBundle(root, ["@slop-lab/dim-host-plugin-mirrors@latest"])).rejects.toThrow(/exact PACKAGE@VERSION/);
    });

    it("rejects selected missing or version-mismatched dependencies instead of falling back to a registry", async () => {
      const { root, entries, publish } = await bundleFixture();
      await publish(entries.filter(({ name }) => name !== "@slop-lab/dim-control-plane-plugin-git-repositories"));
      await expect(readHostPackageBundle(root, ["@slop-lab/dim-control-plane-admin"])).rejects.toThrow(/requires missing bundle package/);
      await expect(readHostPackageBundle(root)).resolves.toMatchObject({ packageNames: ["@slop-lab/dim-host-core"] });
      await publish(entries.map((entry) => entry.name === "@slop-lab/dim-control-plane-plugin-git-repositories" ? { ...entry, version: "0.9.0" } : entry));
      await expect(readHostPackageBundle(root, ["@slop-lab/dim-control-plane-admin"])).rejects.toThrow(/requires .*but the bundle contains/);
      await expect(readHostPackageBundle(root, ["missing-plugin"])).rejects.toThrow(/does not contain required package 'missing-plugin'/);
    });

    it("rejects bundles without host core or with unsafe filenames", async () => {
      const root = await tempDir("dim-invalid-local-bundle-");
      await writeFile(join(root, "packages.json"), JSON.stringify({ schemaVersion: 1, packages: [] }));
      await expect(readHostPackageBundle(root)).rejects.toThrow(/does not contain/);
      await writeFile(join(root, "packages.json"), JSON.stringify({ schemaVersion: 1, packages: [
        { name: "@slop-lab/dim-cli", version: "0.9.0", file: "../cli.tgz", requires: {} }
      ] }));
      await expect(readHostPackageBundle(root)).rejects.toThrow(/invalid local package filename/);
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
      await expect(validateConfiguredCli(cli, undefined)).rejects.toThrow(/run 'dim installer install cli'/);
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
      await mkdir(join(pluginHome, "node_modules", ".bin"), { recursive: true });
      await writeStubCli(join(pluginHome, "node_modules", ".bin", "dim-host"), { versionOutput: "1.0.0" });
      const installed = await installPlugins(
        ["@dev-infra-manager/plugin-github@1.0.0", "dim-plugin-example@2.0.0"],
        { pluginHome, npmCommand: npm }
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
    });

    it("dedupes and sorts plugins.json across repeated installs, and merges with an existing manifest", async () => {
      const root = await tempDir("dim-install-plugins-merge-");
      const pluginHome = join(root, "plugins");
      await mkdir(pluginHome, { recursive: true });
      await writeFile(
        join(pluginHome, "plugins.json"),
        JSON.stringify({ schemaVersion: 1, plugins: ["zzz-existing-plugin"] })
      );
      await mkdir(join(pluginHome, "node_modules", ".bin"), { recursive: true });
      await writeStubCli(join(pluginHome, "node_modules", ".bin", "dim-host"), { versionOutput: "1.0.0" });

      const npm = join(root, "npm.mjs");
      await writeFakePluginNpm(npm, { argsFile: join(root, "arguments.json") });

      await installPlugins(["aaa-new-plugin@1.0.0"], { pluginHome, npmCommand: npm });

      const manifest = JSON.parse(await readFile(join(pluginHome, "plugins.json"), "utf8"));
      expect(manifest.plugins).toEqual(["aaa-new-plugin", "zzz-existing-plugin"]);
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
        installPlugins(["dim-plugin-example@1.0.0"], { pluginHome, npmCommand: npm })
      ).rejects.toThrow(/did not install 'dim-plugin-example' as a direct plugin dependency/);
    });

    it("keeps the prior plugin runtime when npm mutates staging and then fails", async () => {
      const root = await tempDir("dim-install-plugins-rollback-");
      const pluginHome = join(root, "runtime", "current");
      await mkdir(pluginHome, { recursive: true });
      await writeFile(join(pluginHome, "package.json"), JSON.stringify({
        private: true,
        dependencies: { "existing-plugin": "1.0.0" }
      }));
      await writeFile(join(pluginHome, "plugins.json"), JSON.stringify({
        schemaVersion: 1,
        plugins: ["existing-plugin"]
      }));
      const npm = join(root, "npm.mjs");
      await writeFakePluginNpm(npm, { argsFile: join(root, "arguments.json"), exitCode: 8 });

      await expect(installPlugins(["new-plugin@2.0.0"], { pluginHome, npmCommand: npm })).rejects.toThrow(/exited with 8/);

      expect(JSON.parse(await readFile(join(pluginHome, "package.json"), "utf8"))).toEqual({
        private: true,
        dependencies: { "existing-plugin": "1.0.0" }
      });
      expect(JSON.parse(await readFile(join(pluginHome, "plugins.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        plugins: ["existing-plugin"]
      });
    });

    it("restores and restarts the prior plugin runtime when controller readiness fails", async () => {
      // Given
      const root = await tempDir("dim-install-plugin-controller-rollback-");
      const pluginHome = join(root, "runtime", "current");
      const executable = join(pluginHome, "node_modules", ".bin", "dim-host");
      const controllerCalls = join(root, "controller-calls.json");
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(join(pluginHome, "package.json"), JSON.stringify({
        private: true,
        dependencies: { "existing-plugin": "1.0.0" }
      }));
      await writeFile(join(pluginHome, "plugins.json"), JSON.stringify({
        schemaVersion: 1,
        plugins: ["existing-plugin"]
      }));
      await writeFile(executable, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const dependencies = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")).dependencies ?? {};
const calls = existsSync(${JSON.stringify(controllerCalls)}) ? JSON.parse(readFileSync(${JSON.stringify(controllerCalls)}, "utf8")) : [];
calls.push(Object.keys(dependencies).sort());
writeFileSync(${JSON.stringify(controllerCalls)}, JSON.stringify(calls));
process.exit("new-plugin" in dependencies ? 9 : 0);
`);
      await chmod(executable, 0o755);
      const npm = join(root, "npm.mjs");
      await writeFakePluginNpm(npm, { argsFile: join(root, "arguments.json") });

      // When
      const installation = installPlugins(["new-plugin@2.0.0"], { pluginHome, npmCommand: npm, restartController: true });

      // Then
      await expect(installation).rejects.toThrow(/controller restart/);
      expect(JSON.parse(await readFile(join(pluginHome, "package.json"), "utf8"))).toEqual({
        private: true,
        dependencies: { "existing-plugin": "1.0.0" }
      });
      expect(JSON.parse(await readFile(join(pluginHome, "plugins.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        plugins: ["existing-plugin"]
      });
      expect(JSON.parse(await readFile(controllerCalls, "utf8"))).toEqual([
        ["existing-plugin", "new-plugin"],
        ["existing-plugin"]
      ]);
    });

    it("requires at least one plugin specifier", async () => {
      await expect(installPlugins([], { pluginHome: "/irrelevant" })).rejects.toThrow(/at least one plugin package/);
    });

    it("rejects mutable registry plugin specifiers", async () => {
      for (const specifier of ["example", "example@latest", "example@^1.2.3", "@scope/example@1.x"]) {
        await expect(installPlugins([specifier], { pluginHome: "/irrelevant" })).rejects.toThrow(/exact version/);
      }
    });
  });

  describe("configuredCli", () => {
    it("falls back when no config file exists", async () => {
      const dir = await tempDir("dim-configured-defaults-");
      const configPath = join(dir, "dim.json");
      expect(await configuredCli({ DIM_CONFIG_PATH: configPath, HOME: dir })).toBeUndefined();
    });
  });
});
