import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessRunner, WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import { createWorkspaceOnHost, ensureWorkspaceIntegration, resolveWorkspaceMetadata } from "../../../../packages/host/core/src/application/workspace-composition.js";
import { composeWorkspaceRuntime, hostPluginExtensions, loadHostPlugins, resolveHostExecutionRouting } from "../../../../packages/host/core/src/application/host-plugins.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-source-provider-")); roots.push(root);
  vi.stubEnv("DIM_PLUGIN_HOME", root);
  const provider = path.join(root, "node_modules", "company-source"); await mkdir(provider, { recursive: true });
  await writeFile(path.join(provider, "package.json"), JSON.stringify({ name: "company-source", type: "module", exports: "./index.js" }));
  const manifest = (plugins: string[]) => writeFile(path.join(root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins }));
  const store = new WorkspaceStore(path.join(root, "state")), runner = new ProcessRunner();
  const context = { store, runner, cleanupRunner: runner, signal: new AbortController().signal };
  return { root, provider, manifest, context };
}

it("uses only enabled source and metadata providers, including after disabling a previously loaded package", async () => {
  const f = await fixture(), record = { ...workspaceRecord(), source: { ...workspaceRecord().source, url: "company://project" } };
  const observed = path.join(f.root, "ensured.json");
  await writeFile(path.join(f.provider, "index.js"), `import {writeFile} from 'node:fs/promises';
export const hostPlugin={name:'company-source',source:{schemes:['company'],
async create(input,context){return {...${JSON.stringify(record)},name:input.name};},
async ensure(record,context){await writeFile(${JSON.stringify(observed)},JSON.stringify({id:record.id,stateRoot:context.stateRoot}));}},
async workspaceMetadata(){return {projectId:'project-id',projectName:'company-project'};}};`);
  const baseCreate = vi.fn(async () => record);
  const service = { create: baseCreate };
  // The installed dependency alone must not authorize its module or source scheme.
  await f.manifest([]);
  await expect(createWorkspaceOnHost({ name: "chosen", source: { url: "company://project" } }, service, f.context)).rejects.toThrow(/no enabled host provider/);
  await expect(ensureWorkspaceIntegration(record, f.context)).rejects.toThrow(/no enabled host provider/);
  expect(await resolveWorkspaceMetadata(record, { ...f.context, stateRoot: f.context.store.root })).toBeUndefined();
  await f.manifest(["company-source"]);
  expect(await createWorkspaceOnHost({ name: "chosen", source: { url: "company://project" } }, service, f.context)).toMatchObject({ id: record.id, name: "chosen" });
  await ensureWorkspaceIntegration(record, f.context);
  expect(JSON.parse(await readFile(observed, "utf8"))).toEqual({ id: record.id, stateRoot: f.context.store.root });
  expect(await resolveWorkspaceMetadata(record, { ...f.context, stateRoot: f.context.store.root })).toEqual({ projectId: "project-id", projectName: "company-project" });
  expect(baseCreate).not.toHaveBeenCalled();
  await f.manifest([]);
  await expect(createWorkspaceOnHost({ name: "chosen", source: { url: "company://project" } }, service, f.context)).rejects.toThrow(/no enabled host provider/);
  expect(await resolveWorkspaceMetadata(record, { ...f.context, stateRoot: f.context.store.root })).toBeUndefined();
});

it("keeps ordinary Git acquisition independent of broken optional modules and rejects unsupported selection options", async () => {
  const f = await fixture();
  await writeFile(path.join(f.provider, "index.js"), "throw new Error('must not import optional source code for ordinary Git');");
  await f.manifest(["company-source"]);
  const record = workspaceRecord(), create = vi.fn(async () => record);
  const service = { create };
  for (const url of ["https://git.example/repo.git", "git@example:repo.git", "devbox:repo.git", "git+ssh://devbox/repo.git", "ssh+git://devbox/repo.git", "/tmp/local.git"]) {
    expect(await createWorkspaceOnHost({ name: "ordinary", source: { url } }, service, f.context)).toBe(record);
  }
  await expect(createWorkspaceOnHost({ name: "ordinary", source: { url: "https://git.example/repo.git" }, repositories: ["private"] }, service, f.context)).rejects.toThrow(/source provider/);
  expect(create).toHaveBeenCalledTimes(6);
});

it("rejects competing source owners before source execution", async () => {
  const f = await fixture();
  const files = [path.join(f.root, "first.mjs"), path.join(f.root, "second.mjs")];
  for (const [index, file] of files.entries()) await writeFile(file, `export const hostPlugin={name:'source-${index}',source:{schemes:['company'],create(){throw Error('must not execute');}}};`);
  await f.manifest(files);
  await expect(loadHostPlugins()).rejects.toThrow(/duplicate workspace source scheme/);
});


it("delivers enabled adapter-only contributions unchanged to host capabilities", async () => {
  const f = await fixture();
  const adapter = path.join(f.root, "adapter.mjs"), consumer = path.join(f.root, "consumer.mjs");
  const contribution = { kind: "dim.mirror-adapter", name: "future", value: { moduleUrl: "file:///operator/future-adapter.ts" } };
  const runtimeSeen = path.join(f.root, "runtime.json"), routingSeen = path.join(f.root, "routing.json");
  const sourceSeen = path.join(f.root, "source.json"), ensureSeen = path.join(f.root, "ensure.json"), metadataSeen = path.join(f.root, "metadata.json");
  const customRecord = { ...workspaceRecord(), source: { ...workspaceRecord().source, url: "custom://project" } };
  await writeFile(adapter, `export const hostPlugin={name:'future-adapter',extensions:[${JSON.stringify(contribution)}]};`);
  await writeFile(consumer, `import {writeFile} from 'node:fs/promises';
export const hostPlugin={name:'consumer',runtime:{name:'fixture',async create(context){
await writeFile(${JSON.stringify(runtimeSeen)},JSON.stringify(context.extensions));return {inspect:async()=>({running:true})};}},
async executionRouting(context){await writeFile(${JSON.stringify(routingSeen)},JSON.stringify(context.extensions));},
source:{schemes:['custom'],async create(input,context){await writeFile(${JSON.stringify(sourceSeen)},JSON.stringify(context.extensions));return ${JSON.stringify(customRecord)};},
async ensure(record,context){await writeFile(${JSON.stringify(ensureSeen)},JSON.stringify(context.extensions));}},
async workspaceMetadata(record,context){await writeFile(${JSON.stringify(metadataSeen)},JSON.stringify(context.extensions));}};`);
  const context = { ...f.context, stateRoot: f.context.store.root };
  for (const enabled of [[adapter, consumer], [consumer]]) {
    await f.manifest(enabled);
    const plugins = await loadHostPlugins(), expected = enabled.includes(adapter) ? [contribution] : [];
    expect(hostPluginExtensions(plugins)).toEqual(expected);
    expect(await composeWorkspaceRuntime(context).runtime.inspect({ ...workspaceRecord(), runtime: "fixture" })).toEqual({ running: true });
    expect(await resolveHostExecutionRouting(plugins, context)).toBeUndefined();
    expect(JSON.parse(await readFile(runtimeSeen, "utf8"))).toEqual(expected);
    expect(JSON.parse(await readFile(routingSeen, "utf8"))).toEqual(expected);
    await createWorkspaceOnHost({ name: "custom", source: { url: "custom://project" } }, { create: async () => { throw new Error("must use source provider"); } }, f.context);
    await ensureWorkspaceIntegration(customRecord, f.context);
    expect(await resolveWorkspaceMetadata(customRecord, context)).toBeUndefined();
    for (const file of [sourceSeen, ensureSeen, metadataSeen]) expect(JSON.parse(await readFile(file, "utf8"))).toEqual(expected);
  }
});

it("rejects duplicate generic kind/name contributions before invoking runtime or routing hooks", async () => {
  const f = await fixture();
  const files = [path.join(f.root, "one.mjs"), path.join(f.root, "two.mjs")];
  for (const [index, file] of files.entries()) await writeFile(file, `export const hostPlugin={name:'provider-${index}',
extensions:[{kind:'dim.mirror-adapter',name:'future',value:{moduleUrl:'file:///adapter-${index}.ts'}}],
runtime:{name:'runtime-${index}',create(){throw Error('runtime hook must not execute');}},
executionRouting(){throw Error('routing hook must not execute');}};`);
  await f.manifest(files);
  await expect(loadHostPlugins()).rejects.toThrow(/duplicate host plugin extension 'dim.mirror-adapter\/future'/);
  const context = { ...f.context, stateRoot: f.context.store.root };
  await expect(composeWorkspaceRuntime(context).runtime.inspect({ ...workspaceRecord(), runtime: "runtime-0" })).rejects.toThrow(/duplicate host plugin extension/);
});
