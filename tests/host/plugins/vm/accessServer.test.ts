import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../../../../packages/host/core/src/workspace/store.js";
import { VmAccessService } from "../../../../packages/host/plugins/vm/src/access.js";
import { serveVmAccess } from "../../../../packages/host/plugins/vm/src/accessServer.js";
import { IncusMachines } from "../../../../packages/host/plugins/vm/src/incus.js";
import { PersistentVmService } from "../../../../packages/host/plugins/vm/src/store.js";
import { config, FakeIncus, workspace } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class StreamingIncus extends FakeIncus {
  input = "";
  aborted = false;
  private startedResolve: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });
  async runStreaming(command: string, args: string[], options?: import("../../../../packages/host/core/src/types.js").RunOptions): Promise<number> {
    if (args.includes("exec") && options?.stdin) for await (const chunk of options.stdin) this.input += Buffer.from(chunk).toString("utf8");
    if (args.includes("exec") && args.includes("printf")) {
      options?.stdout?.write(`out:${this.input}`); options?.stderr?.write("err"); return 7;
    }
    if (args.includes("exec") && args.includes("block")) {
      this.startedResolve?.();
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => { this.aborted = true; resolve(); }, { once: true }));
      return 143;
    }
    if (args.includes("send")) options?.stdout?.write(Buffer.from("DIMCP1\0archive", "utf8"));
    return super.runStreaming(command, args, options);
  }
}

async function fixture(permissions = ["copy", "discover", "exec", "lifecycle", "status"] as const) {
  const root = await mkdtemp(path.join(tmpdir(), "dim-vm-access-server-")); roots.push(root);
  const store = new WorkspaceStore(root), runner = new StreamingIncus();
  const machines = new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {} });
  const records = new PersistentVmService(root, machines, store), access = new VmAccessService(records);
  const current = workspace({ initialized: true, phase: "running" }); await store.write(current);
  const vm = await records.create("desktop", "a".repeat(64), current.resources); await records.start(vm.name);
  const credential = await records.grantAccess(vm.name, current.name, permissions);
  const server = await serveVmAccess(access, { host: "127.0.0.1", port: 0, recheckMilliseconds: 20 });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing VM access listener");
  return { runner, records, access, current, vm, credential, server, endpoint: `http://127.0.0.1:${address.port}` };
}

function headers(input: Awaited<ReturnType<typeof fixture>>) {
  return { authorization: `Bearer ${input.credential.token}`, "x-dim-vm-id": input.vm.id,
    "x-dim-vm-name": input.vm.name, "x-dim-workspace-id": input.current.id,
    "x-dim-grant-id": input.credential.grantId, "x-dim-grant-generation": String(input.credential.generation) };
}

function frames(buffer: Buffer): Array<{ channel: number; body: Buffer }> {
  const result = []; let offset = 0;
  while (offset < buffer.length) {
    const channel = buffer.readUInt8(offset), length = buffer.readUInt32BE(offset + 1); offset += 5;
    result.push({ channel, body: buffer.subarray(offset, offset + length) }); offset += length;
  }
  return result;
}

describe("workspace VM access service", () => {
  it("authenticates exact identity and streams stdin, stdout, stderr and exit", async () => {
    const f = await fixture();
    try {
      const response = await fetch(`${f.endpoint}/v1/vms/${f.vm.id}/exec`, { method: "POST", headers: {
        ...headers(f), "x-dim-command": Buffer.from(JSON.stringify(["printf", "%s", "literal"])).toString("base64url") }, body: "input" });
      expect(response.status).toBe(200);
      const output = frames(Buffer.from(await response.arrayBuffer()));
      expect(output.map(({ channel, body }) => [channel, body.toString("utf8")])).toEqual([[1, "out:input"], [2, "err"], [3, "7"]]);
      expect(f.runner.input).toBe("input");
      expect((await fetch(`${f.endpoint}/v1/vms/${f.vm.id}/status`, { headers: headers(f) })).status).toBe(200);
      expect((await fetch(`${f.endpoint}/v1/vms/${f.vm.id}/status`, { headers: { ...headers(f), authorization: "Bearer wrong" } })).status).toBe(403);
    } finally { f.server.close(); await once(f.server, "close"); }
  });

  it("streams bounded copy payloads and routes lifecycle only through its permission", async () => {
    const f = await fixture();
    try {
      const pushed = await fetch(`${f.endpoint}/v1/vms/${f.vm.id}/copy?direction=push&path=artifacts%2Fresult.bin&recursive=0&overwrite=1`, {
        method: "POST", headers: headers(f), body: "archive" });
      expect(pushed.status).toBe(204); expect(f.runner.input).toContain("archive");
      const pulled = await fetch(`${f.endpoint}/v1/vms/${f.vm.id}/copy?direction=pull&path=artifacts%2Fresult.bin&recursive=0&overwrite=0`, {
        method: "POST", headers: headers(f) });
      expect(Buffer.from(await pulled.arrayBuffer()).toString("utf8")).toContain("DIMCP1");
      expect((await fetch(`${f.endpoint}/v1/vms/${f.vm.id}/lifecycle/stop`, { method: "POST", headers: headers(f) })).status).toBe(204);
      expect((await f.records.machines.inspect(f.vm))?.running).toBe(false);
    } finally { f.server.close(); await once(f.server, "close"); }
  });

  it("denies requests after revoke", async () => {
    const f = await fixture();
    try {
      await f.records.revoke(f.vm.name, f.current.id);
      expect((await fetch(`${f.endpoint}/v1/vms/${f.vm.id}/status`, { headers: headers(f) })).status).toBe(403);
    } finally { f.server.close(); await once(f.server, "close"); }
  });

  it("aborts an active exec stream after revoke", async () => {
    const f = await fixture();
    try {
      const pending = fetch(`${f.endpoint}/v1/vms/${f.vm.id}/exec`, { method: "POST", headers: { ...headers(f),
        "x-dim-command": Buffer.from(JSON.stringify(["block"])).toString("base64url") }, body: "" });
      await f.runner.started; await f.records.revoke(f.vm.name, f.current.id);
      const response = await pending; const output = frames(Buffer.from(await response.arrayBuffer()));
      expect(output.at(-1)?.body.toString("utf8")).toBe("143"); expect(f.runner.aborted).toBe(true);
    } finally { f.server.close(); await once(f.server, "close"); }
  });
});
