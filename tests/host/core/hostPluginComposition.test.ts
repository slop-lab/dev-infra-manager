import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessRunner } from "@slop-lab/dim-host-core/workspace";
import { composeWorkspaceRuntime, loadHostPlugins } from "../../../packages/host/core/src/application/host-plugins.js";

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

it.each([["host-mirrors", "mirrors"], ["cache-server", "cache-server"]])("discovers the installed %s package using its host command identity", async (pluginName, commandName) => {
  const root = await fixture();
  await mkdir(path.join(root, "node_modules", "@slop-lab"), { recursive: true });
  await symlink(new URL(`../../../packages/host/plugins/${pluginName.replace(/^host-/, "")}`, import.meta.url).pathname,
    path.join(root, "node_modules", "@slop-lab", `dim-host-plugin-${pluginName.replace(/^host-/, "")}`));
  await writeFile(path.join(root, "plugins.json"), JSON.stringify({
    schemaVersion: 1, plugins: [`@slop-lab/dim-host-plugin-${pluginName.replace(/^host-/, "")}`]
  }));
  const loaded = await loadHostPlugins();
  expect(loaded.map(({ name, commands }) => ({ name, commands: commands?.map(({ name }) => name) }))).toEqual([{
    name: pluginName, commands: [commandName]
  }]);
});

it("loads the actual tools, router and external URL guest descriptors together", async () => {
  const root = await fixture();
  const selections = [
    ["agent-tools", "@slop-lab/dim-host-plugin-agent-tools", "agent-tools"],
    ["host-llm-router", "@slop-lab/dim-host-plugin-llm-router", "host-llm-router"],
    ["external-urls", "@slop-lab/dim-host-plugin-external-urls", "external-urls"]
  ] as const;
  for (const [directory, name] of selections) {
    const installed = path.join(root, "node_modules", name);
    await mkdir(path.dirname(installed), { recursive: true });
    await symlink(new URL(`../../../packages/host/plugins/${directory.replace(/^host-/, "")}`, import.meta.url).pathname, installed);
  }
  await writeFile(path.join(root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: selections.map(([, name]) => name) }));
  const loaded = await loadHostPlugins();
  expect(loaded.map(({ name }) => name)).toEqual(selections.map(([, , name]) => name));
  expect(loaded.every(({ guest }) => guest && guest.commands?.length && guest.description)).toBe(true);
});
