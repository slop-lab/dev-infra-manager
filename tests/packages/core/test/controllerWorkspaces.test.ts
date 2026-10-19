import type { CommandResult } from "@slop-lab/dim-core";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessRunner, WorkspaceStore, workspaceRuntimeResources, type StreamingCommandRunner, type WorkspaceRecord } from "@slop-lab/dim-core/workspace";
import { ControllerWorkspaces } from "../../../../core/packages/managed/src/controllerWorkspace.js";
import { WorkspaceGrantStore } from "../../../../core/packages/managed/src/workspaceGrantStore.js";
import { writeNativeWorkspaceAttachment } from "../../../../core/packages/managed/src/nativeWorkspaceAttachment.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-controller-core-")); roots.push(root);
  const core = join(root, "core"), managed = join(root, "managed"), record = workspaceRecord();
  const store = new WorkspaceStore(core); await store.write(record);
  const runner = new RouteRunner(record);
  return { root, core, managed, record, store, runner, controller: new ControllerWorkspaces({ stateRoot: managed }, runner, core) };
}

describe("optional plugin controller core workspace adapter", () => {
  it("binds grants to UUID, rejects replacement and discard, and does not invent a Project", async () => {
    const f = await fixture();
    const token = await f.controller.ensureGrant(f.record.name);
    const selected = { id: f.record.id, name: f.record.name };
    expect(await f.controller.authenticate(token)).toEqual(selected);
    expect(await f.controller.list()).toEqual([selected]);
    expect(await f.controller.authenticate(`${token}x`)).toBeUndefined();
    await f.store.write({ ...f.record, id: randomUUID() });
    expect(await f.controller.authenticate(token)).toBeUndefined();
    await expect(f.controller.run(selected, async () => "must not run")).rejects.toThrow(/identity/);
    expect(await f.controller.ensureGrant(f.record.name)).not.toBe(token);
    await f.store.write(f.record);
    await new WorkspaceGrantStore(f.managed).remove(f.record);
    expect(await f.controller.authenticate(token)).toBeUndefined();
    const recreated = await f.controller.ensureGrant(f.record.name);
    await f.store.remove(f.record.name);
    expect(await f.controller.authenticate(recreated)).toBeUndefined();
  });

  it("reads Project metadata only from a matching native attachment", async () => {
    const f = await fixture();
    const attachment = { schemaVersion: 1 as const, workspaceId: f.record.id, workspaceName: f.record.name,
      nativeWorkspaceId: Buffer.alloc(32, 1).toString("base64url"), projectName: "project", projectId: "project-id",
      protectedRef: "refs/heads/main", commit: "a".repeat(40), tree: "b".repeat(40), policyRevision: "c".repeat(64),
      requiredReviewRevision: "d".repeat(64), requiredJobSetRevision: "e".repeat(64), connectionFile: join(f.root, "connection.json"),
      workspaceStateRoot: f.core, managedStateRoot: f.managed, gateway: "172.18.0.1", port: 1234,
      grant: Buffer.alloc(32, 2).toString("base64url") };
    await writeNativeWorkspaceAttachment(attachment);
    expect(await f.controller.list()).toEqual([{ id: f.record.id, name: f.record.name, projectName: "project", projectId: "project-id" }]);
    await writeNativeWorkspaceAttachment({ ...attachment, workspaceName: "other" });
    await expect(f.controller.list()).rejects.toThrow(/conflicts/);
  });

  it.each([false, true])("routes only through the owned agent IP with nested target=%s", async (nested) => {
    const f = await fixture();
    const resolved = await f.controller.resolveTarget(f.record, { containers: nested ? ["app"] : [], port: 3000, protocol: "http" });
    expect(resolved).toMatchObject({ host: "172.18.0.2", port: 23456, protocol: "http" });
    expect(f.runner.relay).toMatchObject({ listenHost: "172.18.0.2", host: nested ? "172.19.0.2" : "127.0.0.1", port: 3000 });
    expect(f.runner.calls.filter((call) => call[1] === "exec").every((call) => call[4] === "owned-container-id")).toBe(true);
    expect(resolved.fingerprint).toBe(nested ? "owned-container-id/nested-container-id" : "owned-container-id");
  });

  it("starts and reuses the in-workspace byte relay without dropping a half-close response", async () => {
    const f = await fixture();
    const target = createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = []; socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => socket.end(Buffer.concat(chunks)));
    });
    target.listen(0, "127.0.0.1"); await once(target, "listening");
    const address = target.address(); if (!address || typeof address === "string") throw new Error("missing listener");
    const processes = new ProcessRunner();
    const pids = new Set<number>(), keys = new Set<string>();
    const runner = new class extends RouteRunner {
      override async run(command: string, args: string[]): Promise<CommandResult> {
        const result = await super.run(command, args);
        const node = args.indexOf("node");
        if (node < 0) return result;
        keys.add(String(this.relay?.key));
        const actual = await processes.run(process.execPath, args.slice(node + 1));
        if (actual.exitCode === 0) pids.add(Number(JSON.parse(actual.stdout).pid));
        return actual;
      }
    }(f.record, "127.0.0.1");
    const controller = new ControllerWorkspaces({ stateRoot: f.managed }, runner, f.core);
    try {
      const requested = { containers: [], port: address.port, protocol: "tcp" as const };
      const first = await controller.resolveTarget(f.record, requested);
      expect(await controller.resolveTarget(f.record, requested)).toEqual(first);
      const socket = createConnection({ host: first.host, port: first.port, allowHalfOpen: true });
      const chunks: Buffer[] = []; socket.on("data", (chunk) => chunks.push(chunk));
      const done = once(socket, "end");
      const input = Buffer.alloc(256 * 1024 + 1); for (let index = 0; index < input.length; index++) input[index] = index % 256;
      socket.end(input); await done; socket.destroy();
      expect(Buffer.concat(chunks)).toEqual(input); expect(pids.size).toBe(1);
    } finally {
      for (const pid of pids) process.kill(pid, "SIGTERM");
      await Promise.all([...keys].flatMap((key) => ["json", "log"].map((extension) => rm(`/tmp/dim-controller-routes/${key}.${extension}`, { force: true }))));
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("rejects a UUID replaced while its runtime target was being resolved", async () => {
    const f = await fixture();
    const runner = new class extends RouteRunner {
      override async run(command: string, args: string[]): Promise<CommandResult> {
        const result = await super.run(command, args);
        if (args.includes("node")) await f.store.write({ ...f.record, id: randomUUID() });
        return result;
      }
    }(f.record);
    const controller = new ControllerWorkspaces({ stateRoot: f.managed }, runner, f.core);
    await expect(controller.resolveTarget(f.record, { containers: [], port: 80, protocol: "http" }))
      .rejects.toThrow(/identity/);
  });

  it("rejects foreign runtime ownership, nested depth two and stale identities before relay execution", async () => {
    const f = await fixture();
    await expect(f.controller.resolveTarget(f.record, { containers: ["one", "two"], port: 80, protocol: "http" }))
      .rejects.toThrow(/zero or one/);
    expect(f.runner.calls).toEqual([]);
    f.runner.foreign = true;
    await expect(f.controller.resolveTarget(f.record, { containers: [], port: 80, protocol: "http" }))
      .rejects.toThrow(/ownership/);
    expect(f.runner.relay).toBeUndefined();
    await f.store.write({ ...f.record, id: randomUUID() });
    await expect(f.controller.resolveTarget(f.record, { containers: [], port: 80, protocol: "http" }))
      .rejects.toThrow(/identity/);
  });
});

class RouteRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  foreign = false;
  relay: Record<string, unknown> | undefined;
  constructor(private readonly record: WorkspaceRecord, private readonly agentIp = "172.18.0.2") {}
  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    let value: unknown;
    if (args[0] === "container") {
      const r = workspaceRuntimeResources(this.record);
      value = { Id: "owned-container-id", Config: { Image: this.record.image, Labels: {
        "dim.managed": "true", "dim.workspace-id": this.foreign ? randomUUID() : this.record.id,
        "dim.resource": "container", "dim.workspace-schema": "10"
      } }, HostConfig: { Runtime: "sysbox-runc", Privileged: false, OomScoreAdj: 500, NetworkMode: r.network }, State: { Running: true },
      Mounts: [["home", "/home/dim"], ["checkout", "/workspace"], ["docker", "/var/lib/docker"], ["tmp", "/mnt/dim-tmp"]].map(([role, destination]) => ({
        Type: "volume", RW: true, Destination: destination, Name: r[role as "home" | "checkout" | "docker" | "tmp"]
      })), NetworkSettings: { Networks: { [r.network]: { IPAddress: this.agentIp } } } };
    } else if (args.includes("docker")) {
      value = { Id: "nested-container-id", State: { Running: true }, NetworkSettings: { Networks: { bridge: { IPAddress: "172.19.0.2" } } } };
    } else {
      this.relay = JSON.parse(Buffer.from(args.at(-1)!, "base64url").toString()) as Record<string, unknown>;
      value = { port: 23456 };
    }
    return { command, args, exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
  }
  async runStreaming(): Promise<number> { throw new Error("route resolution must not execute host streams"); }
}
