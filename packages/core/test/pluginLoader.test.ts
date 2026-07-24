import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dimUserConfigPath,
  loadInstalledPlugins,
  pluginHome,
  readPluginManifest,
  resolvePluginHome
} from "../src/pluginLoader.js";

describe("plugin loader configuration", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-plugin-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses an explicit plugin home and treats a missing manifest as empty", async () => {
    expect(pluginHome({ DIM_PLUGIN_HOME: root })).toBe(root);
    expect(await readPluginManifest(root)).toEqual({ schemaVersion: 1, plugins: [] });
  });

  it("loads the plugin home recorded by the installer unless the environment overrides it", async () => {
    const configHome = join(root, "config");
    const configuredHome = join(root, "configured-plugins");
    await mkdir(join(configHome, "slop-lab"), { recursive: true });
    await writeFile(
      join(configHome, "slop-lab", "dim.json"),
      JSON.stringify({ schemaVersion: 1, installPrefix: join(root, "prefix"), pluginHome: configuredHome })
    );
    expect(dimUserConfigPath({ XDG_CONFIG_HOME: configHome })).toBe(join(configHome, "slop-lab", "dim.json"));
    expect(await resolvePluginHome({ XDG_CONFIG_HOME: configHome })).toBe(configuredHome);
    expect(await resolvePluginHome({ XDG_CONFIG_HOME: configHome, DIM_PLUGIN_HOME: root })).toBe(root);
  });

  it("deduplicates configured plugin packages", async () => {
    await writeFile(
      join(root, "plugins.json"),
      JSON.stringify({ schemaVersion: 1, plugins: ["@example/github", "@example/github"] })
    );
    expect(await readPluginManifest(root)).toEqual({
      schemaVersion: 1,
      plugins: ["@example/github"]
    });
  });

  it("loads only packages named by the explicit manifest", async () => {
    const packageRoot = join(root, "node_modules", "@example", "github");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@example/github",
      type: "module",
      exports: "./index.js"
    }));
    await writeFile(join(packageRoot, "index.js"), `
      export default {
        name: "@example/github",
        apiVersion: 1,
        register(host) {
          host.registerRepositoryProvider({ kind: "github-mirror", async register() {} });
        }
      };
    `);
    await writeFile(
      join(root, "plugins.json"),
      JSON.stringify({ schemaVersion: 1, plugins: ["@example/github"] })
    );

    const loaded = await loadInstalledPlugins(root);
    expect(loaded.registry.repositoryProviderKinds()).toEqual(["github-mirror"]);
  });
});
