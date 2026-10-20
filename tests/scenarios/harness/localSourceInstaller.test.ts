import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const fixtureRoots: string[] = [];

type PackageEntry = {
  readonly name: string;
  readonly version: string;
  readonly file: string;
};

type PackageManifest = {
  readonly schemaVersion: 1;
  readonly packages: readonly PackageEntry[];
};

function run(command: string, arguments_: readonly string[], environment: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(command, arguments_, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 10 * 1024 * 1024
  });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local source installation", () => {
  it("reinstalls a matched built CLI through a real existing facade", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-local-source-installer-"));
    fixtureRoots.push(root);
    const bundle = resolve(root, "bundle");
    const home = resolve(root, "home");
    const configHome = resolve(root, "config");
    const dataHome = resolve(root, "data", "dim");
    const installPrefix = resolve(root, "installer");
    await Promise.all([bundle, home, configHome, dataHome, installPrefix].map((directory) =>
      mkdir(directory, { recursive: true })
    ));

    const environment = {
      ...process.env,
      MISE_SKIP_RESHIM: "1",
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: resolve(root, "data"),
      DIM_CONFIG_PATH: resolve(configHome, "dim", "config.json"),
      DIM_DATA_HOME: dataHome,
      DIM_PLUGIN_HOME: resolve(dataHome, "runtime", "current"),
      DIM_INSTALL_PREFIX: installPrefix,
      DIM_STATE_ROOT: resolve(root, "state")
    };
    await mkdir(resolve(environment.DIM_CONFIG_PATH, ".."), { recursive: true });
    const packed = run(process.execPath, [
      resolve(workspaceRoot, "scripts/pack-local-packages.ts"), workspaceRoot, bundle
    ], environment);
    expect(packed.status, packed.stderr).toBe(0);

    const manifest = JSON.parse(await readFile(resolve(bundle, "packages.json"), "utf8")) as PackageManifest;
    const installer = manifest.packages.find((entry) => entry.name === "@slop-lab/dim-installer");
    expect(installer).toBeDefined();
    const aggregateVersion = installer?.version ?? "";
    const builtInstaller = JSON.parse(await readFile(resolve(workspaceRoot, "packages/installer/dist/package.json"), "utf8")) as { version: string };
    expect(aggregateVersion).toBe(builtInstaller.version);
    expect(new Set(manifest.packages.map((entry) => entry.version))).toEqual(new Set([aggregateVersion]));

    const installedFacade = run("npm", [
      "install", "--global", "--prefix", installPrefix, resolve(bundle, installer?.file ?? ""),
      "--no-fund", "--no-audit"
    ], environment);
    expect(installedFacade.status, installedFacade.stderr).toBe(0);
    const facade = resolve(installPrefix, "bin", "dim");

    // When
    const installArguments = [
      "installer", "install", "core", "--local-packages", bundle, "--no-local-bin", "--defer-controller-restart"
    ];
    const firstInstall = run(facade, installArguments, environment);
    const replacementInstall = run(facade, installArguments, environment);
    const version = run(facade, ["--version"], environment);

    // Then
    expect(firstInstall.status, firstInstall.stderr).toBe(0);
    expect(replacementInstall.status, replacementInstall.stderr).toBe(0);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(`DIM CLI ${aggregateVersion} (via DIM installer ${aggregateVersion})`);
    await expect(access(resolve(home, ".local", "bin", "dim"), constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });

    const runtimeManifest = JSON.parse(
      await readFile(resolve(dataHome, "runtime", "current", "package.json"), "utf8")
    ) as { readonly dependencies: Readonly<Record<string, string>> };
    expect(runtimeManifest.dependencies["@slop-lab/dim-installer"]).toBeUndefined();
    expect(Object.keys(runtimeManifest.dependencies).sort()).toEqual(["@slop-lab/dim-cli", "@slop-lab/dim-host-core"]);
    for (const entry of manifest.packages.filter(({ name }) => ["@slop-lab/dim-cli", "@slop-lab/dim-host-core"].includes(name))) {
      expect(runtimeManifest.dependencies[entry.name]).toContain(entry.file);
    }
    const pluginNames = ["cache-server", "host-mirrors", "host-llm-router", "vm", "workspace-check", "agent-tools", "tunnels"]
      .map((name) => `@slop-lab/dim-host-plugin-${name.replace(/^host-/, "")}`);
    const pluginArtifacts = pluginNames.map((name) => {
      const entry = manifest.packages.find((entry) => entry.name === name);
      if (!entry) throw new Error(`matched plugin bundle is missing ${name}`);
      return resolve(bundle, entry.file);
    });
    const installedPlugins = run(facade, ["installer", "install", "plugin", ...pluginArtifacts], environment);
    expect(installedPlugins.status, installedPlugins.stderr).toBe(0);
    const discovered = run(facade, ["plugins"], environment);
    expect(discovered.status, discovered.stderr).toBe(0);
    const metadata = JSON.parse(discovered.stdout) as Array<{ name: string; commands: Array<{ name: string }>; runtime?: string }>;
    expect(metadata.map(({ name }) => name).sort()).toEqual(["cache-server", "host-mirrors", "host-llm-router", "vm", "workspace-check", "agent-tools", "tunnels"].sort());
    expect(metadata.flatMap(({ commands }) => commands.map(({ name }) => name))).toEqual(expect.arrayContaining(["cache-server", "mirrors", "tools", "llm", "vm", "workspace-check", "tunnel"]));
    expect(metadata.find(({ name }) => name === "vm")?.runtime).toBe("vm");
    const expanded = JSON.parse(await readFile(resolve(dataHome, "runtime/current/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(expanded.dependencies).sort()).toEqual(["@slop-lab/dim-cli", "@slop-lab/dim-host-core", ...pluginNames].sort());
    for (const optional of ["@slop-lab/dim-control-plane-admin", "@slop-lab/dim-control-plane-plugin-native-git"]) {
      await expect(access(resolve(dataHome, "runtime/current/node_modules", optional))).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 120_000);

  it("refuses unsupported state through the exact packed target without changing installed data", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-local-source-preflight-"));
    fixtureRoots.push(root);
    const bundle = resolve(root, "bundle");
    const home = resolve(root, "home");
    const configPath = resolve(root, "config", "dim", "config.json");
    const dataHome = resolve(root, "data", "dim");
    const installPrefix = resolve(root, "installer");
    const stateRoot = resolve(root, "state");
    await Promise.all([bundle, home, resolve(configPath, ".."), installPrefix, resolve(stateRoot, "workspaces")]
      .map((directory) => mkdir(directory, { recursive: true })));
    const environment = {
      ...process.env,
      MISE_SKIP_RESHIM: "1",
      HOME: home,
      DIM_CONFIG_PATH: configPath,
      DIM_DATA_HOME: dataHome,
      DIM_PLUGIN_HOME: resolve(dataHome, "runtime", "current"),
      DIM_INSTALL_PREFIX: installPrefix,
      DIM_STATE_ROOT: stateRoot
    };
    const packed = run(process.execPath, [
      resolve(workspaceRoot, "scripts/pack-local-packages.ts"), workspaceRoot, bundle
    ], environment);
    expect(packed.status, packed.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(resolve(bundle, "packages.json"), "utf8")) as PackageManifest;
    const installer = manifest.packages.find((entry) => entry.name === "@slop-lab/dim-installer");
    const installedFacade = run("npm", [
      "install", "--global", "--prefix", installPrefix, resolve(bundle, installer?.file ?? ""),
      "--no-fund", "--no-audit"
    ], environment);
    expect(installedFacade.status, installedFacade.stderr).toBe(0);
    const facade = resolve(installPrefix, "bin", "dim");
    const current = resolve(dataHome, "runtime", "current");
    await mkdir(current, { recursive: true });
    await writeFile(resolve(current, "runtime-marker"), "old runtime\n");
    await writeFile(resolve(current, "plugins.json"), '{"schemaVersion":1,"plugins":[]}\n');
    await writeFile(resolve(current, "package.json"), '{"dependencies":{}}\n');
    await writeFile(configPath, '{"schemaVersion":1,"preserved":"user config"}\n');
    const statePath = resolve(stateRoot, "workspaces", "work-1.json");
    await writeFile(statePath, '{"schemaVersion":5,"name":"work-1","secret":"do-not-print"}\n');
    const imageMarker = resolve(stateRoot, "image-marker");
    await writeFile(imageMarker, "existing image identity\n");
    const before = await Promise.all([
      readFile(facade),
      readFile(resolve(current, "runtime-marker")),
      readFile(resolve(current, "plugins.json")),
      readFile(resolve(current, "package.json")),
      readFile(configPath),
      readFile(statePath),
      readFile(imageMarker)
    ]);

    // When
    const installation = run(facade, ["installer", "install", "core", "--local-packages", bundle, "--no-local-bin"], environment);

    // Then
    expect(installation.status).toBe(1);
    expect(installation.stderr).toMatch(
      /workspace state.*work-1\.json.*unsupported workspace state.*export.*recreat.*no state was changed/is
    );
    expect(installation.stderr).not.toContain("do-not-print");
    expect(await Promise.all([
      readFile(facade),
      readFile(resolve(current, "runtime-marker")),
      readFile(resolve(current, "plugins.json")),
      readFile(resolve(current, "package.json")),
      readFile(configPath),
      readFile(statePath),
      readFile(imageMarker)
    ])).toEqual(before);
    expect(await readdir(resolve(dataHome, "runtime"))).toEqual(["current"]);
  }, 120_000);
});
