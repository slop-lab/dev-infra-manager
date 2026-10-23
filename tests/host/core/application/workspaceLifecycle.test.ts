import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessRunner } from "@slop-lab/dim-host-core/workspace";
import { composeWorkspaceRuntime, loadHostPlugins } from "../../../../packages/host/core/src/application/host-plugins.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-lifecycle-")); roots.push(root); vi.stubEnv("DIM_PLUGIN_HOME", root);
  const events = path.join(root, "events"), module = path.join(root, "runtime.mjs");
  await writeFile(module, `// @ts-check
import {appendFile} from 'node:fs/promises';
const event=async(value)=>appendFile(${JSON.stringify(events)},value+'\\n');
let running=false;
export const hostPlugin={name:'lifecycle',runtime:{name:'fixture',create:async()=>({
inspect:async()=>({id:'owned',running}),start:async()=>{running=true;await event('start');},
remove:async(record,options)=>event('remove:'+options.keepData),exec:async()=>event('exec'),connect:async()=>event('connect'),
updateResources:async()=>{await event('recreated');return {recreated:true};}})},
workspaceLifecycle:{started:async(record,context)=>event('ready:'+context.extensions.length),
removing:async(record,options)=>event('release:'+options.keepData)}};`);
  await writeFile(path.join(root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [module] }));
  const runner = new ProcessRunner(), runtime = composeWorkspaceRuntime({ stateRoot: root, runner, cleanupRunner: runner }).runtime;
  const record = { ...workspaceRecord(), runtime: "fixture" };
  return { root, runtime, record, events: async () => (await readFile(events, "utf8")).trim().split("\n") };
}

it("reconciles only running workspaces before access and after start or recreation", async () => {
  const f = await fixture();
  await f.runtime.exec(f.record, ["true"]);
  expect(await f.events()).toEqual(["exec"]);
  await f.runtime.start(f.record);
  await f.runtime.exec(f.record, ["true"]);
  await f.runtime.connect(f.record, 3000);
  await f.runtime.updateResources(f.record, f.record.resources);
  expect(await f.events()).toEqual(["exec", "start", "ready:0", "ready:0", "exec", "ready:0", "connect", "recreated", "ready:0"]);
});

it("releases attached resources before both recreation and final removal", async () => {
  const f = await fixture();
  await f.runtime.remove(f.record, { keepData: true });
  await f.runtime.remove(f.record, { keepData: false });
  expect(await f.events()).toEqual(["release:true", "remove:true", "release:false", "remove:false"]);
});

it("rejects invalid lifecycle handlers before starting runtime operations", async () => {
  const f = await fixture(), invalid = path.join(f.root, "invalid.mjs");
  await writeFile(invalid, "// @ts-check\nexport const hostPlugin={name:'invalid',workspaceLifecycle:{started:'invalid'}};");
  await writeFile(path.join(f.root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [invalid] }));
  await expect(loadHostPlugins()).rejects.toThrow(/invalid workspace lifecycle/);
});

it("blocks guest access and resource deletion when lifecycle reconciliation fails", async () => {
  const f = await fixture(), invalid = path.join(f.root, "failure.mjs"), provider = path.join(f.root, "runtime.mjs");
  await writeFile(invalid, "// @ts-check\nexport const hostPlugin={name:'failure',workspaceLifecycle:{started:async()=>{throw Error('not ready');},removing:async()=>{throw Error('not released');}}};");
  await writeFile(path.join(f.root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [provider, invalid] }));
  const runner = new ProcessRunner(), runtime = composeWorkspaceRuntime({ stateRoot: f.root, runner, cleanupRunner: runner }).runtime;
  await expect(runtime.start(f.record)).rejects.toThrow("not ready");
  await expect(runtime.exec(f.record, ["true"])).rejects.toThrow("not ready");
  await expect(runtime.remove(f.record, { keepData: false })).rejects.toThrow("not released");
  expect(await f.events()).toEqual(["start", "ready:0", "ready:0"]);
});
