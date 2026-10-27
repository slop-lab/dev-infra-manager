import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceService, type WorkspaceRuntime } from "../../../packages/host/core/src/workspace/service.js";
import { parseWorkspaceRecord, WorkspaceStore } from "../../../packages/host/core/src/workspace/store.js";
import type { WorkspaceRecord } from "../../../packages/host/core/src/workspace/models.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dim-workspace-service-")); roots.push(root);
  const calls: string[] = [];
  const runtime: WorkspaceRuntime = {
    async inspect() { return { running: true }; },
    async updateResources() { calls.push("resources"); return { recreated: false }; },
    async create() { calls.push("create"); }, async start() { calls.push("start"); },
    async stop() { calls.push("stop"); }, async seed() { calls.push("seed"); },
    async remove(_record, options) { calls.push(options.keepData ? "remove:keep" : "remove:delete"); },
    async exec(_record, command) { calls.push(`exec:${command.join(" ")}`); return 17; },
    async connect(record, port) { calls.push(`connect:${record.id}:${port}`); return 0; }
  };
  let acquisitions = 0;
  const store = new WorkspaceStore(root);
  const service = new WorkspaceService(store, runtime, async ({ source, destination }) => {
    acquisitions++;
    await mkdir(destination); await writeFile(path.join(destination, "app.txt"), "project");
    return { url: source.url, ref: "refs/heads/main", commit: "a".repeat(40) };
  });
  return { root, store, service, calls, runtime, acquisitions: () => acquisitions };
}
const create = { name: "dev", source: { url: "https://example.com/app.git" } };

describe("workspace application lifecycle", () => {
  it("persists an explicitly selected runtime without importing its implementation or changing lifecycle semantics", async () => {
    const f = await fixture();
    const record = await f.service.create({ ...create, runtime: "vm", image: "a".repeat(64) });
    expect(record.runtime).toBe("vm");
    expect(parseWorkspaceRecord(record)).toEqual(record);
    await f.service.restart(record.name, record.id);
    expect(f.calls).toEqual(["create", "start", "seed", "stop", "start"]);
    await expect(f.service.create({ ...create, name: "bad", runtime: "../host" })).rejects.toThrow("invalid workspace runtime");
    expect(f.acquisitions()).toBe(1);
  });
  it("inspects an empty host without configuring a runtime or control plane", async () => {
    const f = await fixture();
    expect(await f.service.list()).toEqual([]); expect(f.calls).toEqual([]); expect(f.acquisitions()).toBe(0);
  });

  it("preserves identity and user data across stop/start/recreation without reseeding", async () => {
    const f = await fixture();
    const initial = await f.service.create(create);
    expect(initial.initialized).toBe(true); expect(initial.phase).toBe("running");
    await f.service.stop("dev"); await f.service.start("dev");
    const recreated = await f.service.recreate("dev");
    expect(recreated.id).toBe(initial.id);
    expect(f.acquisitions()).toBe(1);
    expect(f.calls).toEqual(["create", "start", "seed", "stop", "start", "remove:keep", "create", "start"]);
    expect(await f.service.exec("dev", ["false"])).toBe(17);
    await f.service.discard("dev");
    expect(f.calls.at(-1)).toBe("remove:delete"); expect(await f.service.list()).toEqual([]);
  });

  it("leaves failed initialization discoverable and cannot pretend an empty workspace is ready", async () => {
    const f = await fixture();
    f.runtime.seed = async () => { throw new Error("copy failed"); };
    await expect(f.service.create(create)).rejects.toThrow("workspace create 'dev': at seed checkout: copy failed");
    const failed = await f.service.show("dev");
    expect(failed.initialized).toBe(false); expect(failed.phase).toBe("error");
    await expect(f.service.start("dev")).rejects.toThrow("initialization did not complete");
    expect(f.calls.filter((c) => c === "start")).toHaveLength(1);
    expect((await f.service.show("dev")).error).toBe("at seed checkout: copy failed");
    await f.service.discard("dev"); expect(await f.service.list()).toEqual([]);
  });

  it("retains state after cleanup failure so discard can be retried", async () => {
    const f = await fixture(); await f.service.create(create);
    const remove = f.runtime.remove;
    f.runtime.remove = async () => { throw new Error("runtime unavailable"); };
    await expect(f.service.discard("dev")).rejects.toThrow("runtime unavailable");
    expect((await f.service.show("dev")).phase).toBe("error");
    f.runtime.remove = remove;
    await f.service.discard("dev"); expect(await f.service.list()).toEqual([]);
  });

  it("rejects destructive duplicate creation and stopped execution", async () => {
    const f = await fixture(); await f.service.create(create);
    await expect(f.service.create(create)).rejects.toThrow("already exists"); expect(f.acquisitions()).toBe(1);
    await f.service.stop("dev");
    await expect(f.service.exec("dev", ["echo", "hello"])).rejects.toThrow("run dim start dev");
    expect(f.calls.some((call) => call.startsWith("exec:"))).toBe(false);
  });

  it("rejects resource input without changing healthy runtime state", async () => {
    const f = await fixture(); await f.service.create(create);
    await expect(f.service.resources("dev", { cpuCount: "-1" })).rejects.toThrow("invalid workspace resources");
    expect((await f.service.show("dev")).phase).toBe("running");
    expect(f.calls).not.toContain("resources");
    const updated = await f.service.resources("dev", { cpuCount: "unlimited" });
    expect(updated.workspace.resources.cpuCount).toBe("unlimited");
    expect(updated.recreated).toBe(false);
  });

  it("reports actual stopped or missing runtimes without rewriting lifecycle state", async () => {
    const f = await fixture(); await f.service.create(create);
    f.runtime.inspect = async () => ({ running: false });
    expect((await f.service.show("dev")).runtimeStatus).toBe("stopped");
    f.runtime.inspect = async () => undefined;
    expect((await f.service.list())[0]?.runtimeStatus).toBe("missing");
    f.runtime.inspect = async () => { throw new Error("Docker offline"); };
    expect((await f.service.show("dev")).runtimeError).toBe("Docker offline");
    expect((await f.store.read("dev")).phase).toBe("running");
  });

  it("pins forwarded connections to the selected identity and rejects invalid ports before runtime access", async () => {
    const f = await fixture();
    const original = await f.service.create(create);
    await f.service.connect("dev", 3000, { workspaceId: original.id });
    expect(f.calls.at(-1)).toBe(`connect:${original.id}:3000`);
    for (const port of [0, -1, 65536, 1.5, NaN]) await expect(f.service.connect("dev", port)).rejects.toThrow("port must be");
    await f.service.discard("dev");
    const replacement = await f.service.create(create);
    await expect(f.service.connect("dev", 3000, { workspaceId: original.id })).rejects.toThrow("was replaced");
    expect(f.calls.filter((call) => call.startsWith("connect:"))).toEqual([`connect:${original.id}:3000`]);
    expect((await f.store.read("dev")).phase).toBe("running");
    await f.service.connect("dev", 3000, { workspaceId: replacement.id });
    await f.service.stop("dev");
    await expect(f.service.connect("dev", 3000)).rejects.toThrow("run dim start dev");
  });

  it("pins copy streams to workspace identity while holding the lifecycle lock", async () => {
    const f = await fixture();
    const original = await f.service.create(create);
    let releaseCopy: (() => void) | undefined;
    f.runtime.copy = async (_record, operation) => {
      f.calls.push(`copy:${operation.command.join(" ")}`);
      await new Promise<void>((resolve) => { releaseCopy = resolve; });
      return 0;
    };
    const copying = f.service.copy("dev", ["copy-helper"], { workspaceId: original.id, token: randomUUID(), path: "target" });
    while (releaseCopy === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    const recreating = f.service.recreate("dev", original.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.calls).not.toContain("remove:keep");
    releaseCopy();
    await expect(copying).resolves.toBe(0);
    await recreating;
    expect(f.calls).toContain("copy:copy-helper");
    await f.service.discard("dev");
    const replacement = await f.service.create(create);
    await expect(f.service.copy("dev", ["copy-helper"], { workspaceId: original.id, token: randomUUID(), path: "target" })).rejects.toThrow("identity changed");
    expect(replacement.id).not.toBe(original.id);
  });

  it("validates complete persisted records rather than asserting partial data", async () => {
    const f = await fixture(); const record = await f.service.create(create);
    for (const mutation of [
      { ...record, name: "../host" }, { ...record, resources: { cpuCount: "2" } },
      { ...record, source: { ...record.source, commit: "bad" } },
      { ...record, initialized: "yes" }, { ...record, unknown: true }
    ]) expect(() => parseWorkspaceRecord(mutation)).toThrow();
    const invalid = { ...record, phase: "missing" } as unknown as WorkspaceRecord;
    await expect(f.store.write(invalid)).rejects.toThrow();
    expect((await f.service.show("dev")).phase).toBe("running");
  });
});


it("persists independent checkout identities and rejects ambiguous or escaping layouts", async () => {
  const f = await fixture();
  const base = await f.service.create(create);
  const publicSource = { url: "dim://app/public", ref: "refs/heads/main", commit: "b".repeat(40) };
  const privateSource = { url: "dim://app/private", ref: "refs/heads/main", commit: "c".repeat(64) };
  const source = { ...privateSource, checkouts: [{ directory: "public", source: publicSource }], workingDirectory: "public" };
  const record = { ...base, source };
  await f.store.write(record);
  expect((await f.store.read("dev")).source).toEqual(source);
  for (const checkouts of [
    [{ directory: "../private", source: publicSource }],
    [{ directory: "public", source: publicSource }, { directory: "public", source: privateSource }],
    [{ directory: "public/nested", source: publicSource }], []
  ]) expect(() => parseWorkspaceRecord({ ...record, source: { ...source, checkouts } })).toThrow();
  expect(() => parseWorkspaceRecord({ ...record, source: { ...source, workingDirectory: "private" } })).toThrow();
  expect(() => parseWorkspaceRecord({ ...record, source: { ...source, checkouts: [{ directory: "public", source: { ...publicSource, commit: "invalid" } }] } })).toThrow();
});
import { randomUUID } from "node:crypto";
