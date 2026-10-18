import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessRunner } from "@slop-lab/dim-core/workspace";
import { composeWorkspaceRuntime, loadHostPlugins } from "../../../../core/packages/cli/src/host-plugins.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dim-host-plugin-")); roots.push(root);
  vi.stubEnv("DIM_PLUGIN_HOME", root);
  return root;
}

it("keeps ordinary container composition independent of optional plugin configuration", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "plugins.json"), "broken optional configuration");
  const runner = new ProcessRunner();
  const composition = composeWorkspaceRuntime({ runner, cleanupRunner: runner, stateRoot: root });
  expect(await composition.defaultImage("container")).toBeUndefined();
  await expect(composition.defaultImage("vm")).rejects.toThrow();
});

it("discovers explicit host commands without a managed controller and rejects competing command owners", async () => {
  const root = await fixture();
  const first = path.join(root, "first.mjs"), second = path.join(root, "second.mjs");
  await writeFile(first, 'export const hostPlugin={name:"first",commands:[{name:"tools",description:"Tool setup"}],async run(){}};');
  await writeFile(second, 'export const hostPlugin={name:"second",commands:[{name:"tools",description:"Conflicting command"}],async run(){}};');
  await writeFile(path.join(root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [first] }));
  const loaded = await loadHostPlugins();
  expect(loaded.map((plugin) => [plugin.name, plugin.commands?.[0]?.name])).toEqual([["first", "tools"]]);
  await writeFile(path.join(root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [first, second] }));
  await expect(loadHostPlugins()).rejects.toThrow("duplicate host plugin command");
});
