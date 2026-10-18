import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configuredWorkspaceBackend,
  setConfiguredWorkspaceBackend
} from "../../../../core/packages/managed/src/userConfig.js";

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

    await expect(setConfiguredWorkspaceBackend("sysbox", { DIM_CONFIG_PATH: target })).resolves.toBe(target);
    expect(configuredWorkspaceBackend({ DIM_CONFIG_PATH: target })).toBe("sysbox");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      schemaVersion: 1,
      pluginHome: "/plugins",
      workspaceBackend: "sysbox"
    });
  });
});
