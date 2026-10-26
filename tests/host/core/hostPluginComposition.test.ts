import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessRunner } from "@slop-lab/dim-host-core/workspace";
import { composeWorkspaceRuntime, loadHostPlugins } from "../../../packages/host/core/src/application/host-plugins.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";

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

it("dispatches controller targets only to the selected optional runtime capability", async () => {
  // Given: one optional runtime with target resolution and one without it.
  const root = await fixture();
  const capable = path.join(root, "capable.mjs"), lifecycleOnly = path.join(root, "lifecycle-only.mjs");
  const methods = "inspect:async()=>({running:true}),create:async()=>{},start:async()=>{},stop:async()=>{},remove:async()=>{},updateResources:async()=>({recreated:false}),seed:async()=>{},exec:async()=>0,connect:async()=>0";
  await writeFile(capable, `export const hostPlugin={name:'capable',runtime:{name:'capable-runtime',create:async()=>({${methods},resolveTarget:async(_record,target)=>({protocol:target.protocol,host:'127.0.0.2',port:4321,fingerprint:'selected'})})}};`);
  await writeFile(lifecycleOnly, `export const hostPlugin={name:'lifecycle-only',runtime:{name:'lifecycle-only-runtime',create:async()=>({${methods}})}};`);
  await writeFile(path.join(root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [capable, lifecycleOnly] }));
  const runner = new ProcessRunner();
  const runtime = composeWorkspaceRuntime({ runner, cleanupRunner: runner, stateRoot: root }).runtime;
  if (!runtime.resolveTarget) throw new Error("composed runtime target dispatcher is missing");
  const target = { containers: [], port: 80, protocol: "http" as const };

  // When: target resolution selects each recorded optional runtime.
  const resolved = await runtime.resolveTarget({ ...workspaceRecord(), runtime: "capable-runtime" }, target);

  // Then: only the owning capability resolves, while absence and unknown names fail closed.
  expect(resolved).toEqual({ protocol: "http", host: "127.0.0.2", port: 4321, fingerprint: "selected" });
  await expect(runtime.resolveTarget({ ...workspaceRecord(), runtime: "lifecycle-only-runtime" }, target))
    .rejects.toThrow(/does not support controller targets/);
  await expect(runtime.resolveTarget({ ...workspaceRecord(), runtime: "missing-runtime" }, target))
    .rejects.toThrow(/not installed/);
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
