import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadInstalledPlugins,
  pluginHome,
  readPluginManifest,
  resolvePluginHome
} from "../../../../core/packages/core/src/pluginLoader.js";
import { configuredWorkspaceBackend, dimUserConfigPath } from "../../../../core/packages/core/src/userConfig.js";

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

  it("uses the unified runtime by default and permits an explicit test override", async () => {
    expect(await resolvePluginHome({ HOME: root })).toBe(join(root, ".local", "share", "dim", "runtime", "current"));
    expect(await resolvePluginHome({ HOME: root, DIM_DATA_HOME: join(root, "data") })).toBe(
      join(root, "data", "runtime", "current")
    );
    expect(await resolvePluginHome({ HOME: root, DIM_PLUGIN_HOME: root })).toBe(root);
  });

  it("reads the installed workspace backend from the shared user config", async () => {
    const configPath = join(root, "dim.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, workspaceBackend: "gvisor" }));
    expect(configuredWorkspaceBackend({ DIM_CONFIG_PATH: configPath })).toBe("gvisor");
    expect(configuredWorkspaceBackend({ DIM_CONFIG_PATH: join(root, "missing.json") })).toBeUndefined();
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, workspaceBackend: "unknown" }));
    expect(() => configuredWorkspaceBackend({ DIM_CONFIG_PATH: configPath })).toThrow(/invalid workspaceBackend/);
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
        apiVersion: 4,
        register() {}
      };
    `);
    await writeFile(
      join(root, "plugins.json"),
      JSON.stringify({ schemaVersion: 1, plugins: ["@example/github"] })
    );

    const loaded = await loadInstalledPlugins(root);
    expect(loaded.manifest.plugins).toEqual(["@example/github"]);
    expect(loaded.registered.plugins).toEqual(["builtin.host-inputs", "@example/github"]);
    expect(loaded.registered.hostInputProviders.has("builtin.git-author")).toBe(true);
    await loaded.registered.dispose();
  });
});
