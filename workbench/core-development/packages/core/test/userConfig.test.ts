import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configuredCiRunnerDefaults,
  configuredWorkspaceBackend,
  setConfiguredCiRunnerDefaults,
  setConfiguredWorkspaceBackend
} from "../../../../core/packages/core/src/userConfig.js";

describe("DIM user config", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("atomically records a backend while preserving other settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-user-config-"));
    roots.push(root);
    const target = path.join(root, "config.json");
    await writeFile(target, JSON.stringify({
      schemaVersion: 1,
      pluginHome: "/plugins"
    }));

    await expect(setConfiguredWorkspaceBackend("runc", { DIM_CONFIG_PATH: target })).resolves.toBe(target);
    expect(configuredWorkspaceBackend({ DIM_CONFIG_PATH: target })).toBe("runc");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      schemaVersion: 1,
      pluginHome: "/plugins",
      workspaceBackend: "runc"
    });
  });

  it("records and resets inherited CI runner resource defaults", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-user-config-"));
    roots.push(root);
    const target = path.join(root, "config.json");
    const env = { DIM_CONFIG_PATH: target };

    await setConfiguredCiRunnerDefaults({ cpus: "6", memory: "12GiB", pidsLimit: "4096" }, env);
    expect(configuredCiRunnerDefaults(env)).toEqual({ cpus: "6", memory: "12GiB", pidsLimit: "4096" });

    await setConfiguredCiRunnerDefaults(undefined, env);
    expect(configuredCiRunnerDefaults(env)).toBeUndefined();
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ schemaVersion: 1 });
  });
});
