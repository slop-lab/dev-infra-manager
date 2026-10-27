import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProcessRunner, WorkspaceService, WorkspaceStore, type WorkspaceRuntime } from "@slop-lab/dim-host-core/workspace";
import { hostPlugin } from "../../../../packages/host/plugins/kvm/src/index.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(runtimeName = "container", reply = { state: "available", apiVersion: 12 }) {
  const root = await mkdtemp(join(tmpdir(), "dim-kvm-guest-")); roots.push(root);
  const record = workspaceRecord("verification", { runtime: runtimeName });
  const calls: { readonly id: string; readonly command: readonly string[] }[] = [];
  const runtime: WorkspaceRuntime = {
    async inspect() { return { running: true }; }, async create() {}, async start() {}, async stop() {}, async remove() {}, async seed() {},
    async updateResources() { return { recreated: false }; }, async connect() { return 0; },
    async exec(current, command, options) {
      calls.push({ id: current.id, command });
      options?.stdout?.write(JSON.stringify(command.includes("verify") ? { ...reply, effect: "vm-fd-created-and-closed" } : reply));
      return 0;
    }
  };
  const store = new WorkspaceStore(root); await store.write(record);
  const service = new WorkspaceService(store, runtime, async () => { throw new Error("source acquisition is not allowed in discovery"); });
  const runner = new ProcessRunner();
  return { record, store, calls, context: { stateRoot: root, store, service, runner, cleanupRunner: runner, signal: AbortSignal.timeout(10_000) } };
}

it("reports an ordinary workspace as unconfigured without inventing a host delegation or probing the host", async () => {
  const f = await fixture();
  expect(hostPlugin.runtime?.isolation).toBe("container");
  expect(hostPlugin.workspaceCapabilities).toBeTypeOf("function");
  const facts = await hostPlugin.workspaceCapabilities?.(f.record, f.context);
  expect(facts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "vm-fd-verification", state: "blocked",
    access: { kind: "none" }, reason: expect.objectContaining({ code: "runtime-grant-required" }) })]));
  expect(f.calls).toEqual([]);
  const operation = hostPlugin.guest?.operations?.find(({ name }) => name === "verify");
  if (!operation) throw new Error("KVM verification operation missing");
  await expect(operation.handle({}, f.record, f.context)).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

it("discovers real guest access separately from the operator runtime grant", async () => {
  const f = await fixture("container-kvm", { state: "permission-denied", apiVersion: 0 });
  const facts = await hostPlugin.workspaceCapabilities?.(f.record, f.context);
  expect(facts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "vm-fd-verification", state: "unavailable",
    reason: expect.objectContaining({ code: "permission-denied" }) })]));
  expect(f.calls).toHaveLength(1); expect(f.calls[0]?.id).toBe(f.record.id);
});

it("routes only the fixed VM-fd probe inside the exact explicitly KVM-enabled workspace", async () => {
  const f = await fixture("container-kvm"), operation = hostPlugin.guest?.operations?.find(({ name }) => name === "verify");
  if (!operation) throw new Error("KVM verification operation missing");
  const result: unknown = await operation.handle({}, f.record, f.context);
  expect(result).toMatchObject({ schemaVersion: 1, workspaceId: f.record.id, scope: "workspace-kvm", outcome: "verified",
    effect: "vm-fd-created-and-closed", kvmApiVersion: 12 });
  expect(f.calls).toHaveLength(1); expect(f.calls[0]?.command).toEqual(["python3", "-c", expect.any(String), "verify"]);
  await expect(operation.handle({ command: "arbitrary-host-command" }, f.record, f.context)).rejects.toThrow();
  await f.store.write({ ...f.record, id: "00000000-0000-4000-8000-000000000000" });
  await expect(operation.handle({}, f.record, f.context)).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});
