import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "../../../../packages/host/core/src/workspace/store.js";
import { VmAccessService } from "../../../../packages/host/plugins/vm/src/access.js";
import { IncusMachines } from "../../../../packages/host/plugins/vm/src/incus.js";
import { PersistentVmService } from "../../../../packages/host/plugins/vm/src/store.js";
import { config, FakeIncus, workspace } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(permissions: readonly ("copy" | "discover" | "exec" | "lifecycle" | "status")[]) {
  const root = await mkdtemp(path.join(tmpdir(), "dim-vm-access-")); roots.push(root);
  const store = new WorkspaceStore(root), runner = new FakeIncus();
  const machines = new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {} });
  const records = new PersistentVmService(root, machines, store), access = new VmAccessService(records);
  const current = workspace({ initialized: true, phase: "running" }); await store.write(current);
  const vm = await records.create("desktop", "a".repeat(64), current.resources); await records.start(vm.name);
  const credential = await records.grantAccess(vm.name, current.name, permissions);
  return { store, runner, machines, records, access, current, vm, credential };
}

function request(input: Awaited<ReturnType<typeof fixture>>) {
  return { token: input.credential.token, grantId: input.credential.grantId, generation: input.credential.generation,
    vmId: input.vm.id, vmName: input.vm.name, workspaceId: input.current.id };
}

describe("workspace-scoped auxiliary VM access", () => {
  it("discovers only exact grants for the current workspace", async () => {
    const f = await fixture(["discover", "status"]);
    expect(await f.access.discover(f.current)).toEqual([{ vmId: f.vm.id, vmName: "desktop", running: true,
      permissions: ["discover", "status"] }]);
    await f.store.write(workspace({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", initialized: true, phase: "running" }));
    expect(await f.access.discover(await f.store.read("dev"))).toEqual([]);
  });

  it("returns status and streams exec only with exact permission and identities", async () => {
    const f = await fixture(["discover", "status", "exec"]), identity = request(f);
    expect(await f.access.status(identity)).toMatchObject({ vmId: f.vm.id, vmName: "desktop", running: true });
    await expect(f.access.exec({ ...identity, command: ["printf", "%s", "literal;$(no-shell)"] })).resolves.toBe(0);
    expect(f.runner.calls.at(-1)).toEqual(expect.arrayContaining(["exec", expect.any(String), "--", "runuser", "--user", "dim",
      "--preserve-environment", "--", "printf", "%s", "literal;$(no-shell)"]));
    await expect(f.access.exec({ ...identity, grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", command: ["true"] })).rejects.toThrow(/denied/);
  });

  it("keeps lifecycle separate from ordinary guest access", async () => {
    const without = await fixture(["discover", "status", "exec"]);
    await expect(without.access.lifecycle({ ...request(without), operation: "stop" })).rejects.toThrow(/denied/);
    const allowed = await fixture(["discover", "status", "lifecycle"]);
    await allowed.access.lifecycle({ ...request(allowed), operation: "stop" });
    expect((await allowed.machines.inspect(allowed.vm))?.running).toBe(false);
    await allowed.access.lifecycle({ ...request(allowed), operation: "start" });
    expect((await allowed.machines.inspect(allowed.vm))?.running).toBe(true);
  });

  it("keeps start pending until Docker is ready before checking guest directories", async () => {
    const f = await fixture(["discover", "status", "exec", "lifecycle"]), identity = request(f);
    await f.access.lifecycle({ ...identity, operation: "stop" });
    const order: string[] = [];
    let releaseDocker!: () => void, enteredDocker!: () => void;
    const dockerReady = new Promise<void>((resolve) => { releaseDocker = resolve; });
    const dockerEntered = new Promise<void>((resolve) => { enteredDocker = resolve; });
    const run = f.runner.run.bind(f.runner);
    vi.spyOn(f.runner, "run").mockImplementation(async (command, args, options) => {
      if (args.includes("exec")) {
        if (args.includes("docker")) { order.push("docker"); enteredDocker(); await dockerReady; }
        else if (args.at(-1) === "true") order.push("agent");
        else if (args.includes("runuser")) order.push("directories");
      }
      return run(command, args, options);
    });
    let returned = false;
    const starting = f.access.lifecycle({ ...identity, operation: "start" }).then(() => { returned = true; });
    expect(await Promise.race([dockerEntered.then(() => true), starting.then(() => false)])).toBe(true);
    expect(returned).toBe(false); expect(order).not.toContain("directories");
    expect(order).toEqual(["agent", "docker"]);
    releaseDocker(); await starting;
    expect(returned).toBe(true); expect(order).toEqual(["agent", "docker", "directories"]);
  });

  it("rolls back a new start when Docker fails and preserves an already-running VM", async () => {
    for (const alreadyRunning of [false, true]) {
      const f = await fixture(["discover", "status", "lifecycle"]), identity = request(f);
      if (!alreadyRunning) await f.access.lifecycle({ ...identity, operation: "stop" });
      const run = f.runner.run.bind(f.runner), directories = vi.fn();
      vi.spyOn(f.runner, "run").mockImplementation(async (command, args, options) => {
        if (args.includes("exec") && args.includes("docker")) throw new Error("guest Docker unavailable");
        if (args.includes("exec") && args.includes("runuser")) directories();
        return run(command, args, options);
      });
      await expect(f.access.lifecycle({ ...identity, operation: "start" })).rejects.toThrow("guest Docker unavailable");
      expect(directories).not.toHaveBeenCalled();
      expect((await f.machines.inspect(f.vm))?.running).toBe(alreadyRunning);
    }
  });

  it("stops a newly started auxiliary VM when readiness fails", async () => {
    const f = await fixture(["discover", "status", "lifecycle"]), identity = request(f);
    await f.access.lifecycle({ ...identity, operation: "stop" });
    const run = f.runner.run.bind(f.runner);
    vi.spyOn(f.runner, "run").mockImplementation(async (command, args, options) => {
      if (args.includes("exec") && args.at(-1) === "true") throw new Error("guest agent unavailable");
      return run(command, args, options);
    });
    await expect(f.access.lifecycle({ ...identity, operation: "start" })).rejects.toThrow("guest agent unavailable");
    expect((await f.machines.inspect(f.vm))?.running).toBe(false);
  });

  it("preserves an already-running auxiliary VM when readiness fails", async () => {
    const f = await fixture(["discover", "status", "lifecycle"]), identity = request(f);
    const run = f.runner.run.bind(f.runner);
    vi.spyOn(f.runner, "run").mockImplementation(async (command, args, options) => {
      if (args.includes("exec") && args.at(-1) === "true") throw new Error("guest image not ready");
      return run(command, args, options);
    });
    await expect(f.access.lifecycle({ ...identity, operation: "start" })).rejects.toThrow("guest image not ready");
    expect((await f.machines.inspect(f.vm))?.running).toBe(true);
  });

  it("reports readiness and rollback failures when a newly started VM cannot be force-stopped", async () => {
    const f = await fixture(["discover", "status", "lifecycle"]), identity = request(f);
    await f.access.lifecycle({ ...identity, operation: "stop" });
    const run = f.runner.run.bind(f.runner);
    vi.spyOn(f.runner, "run").mockImplementation(async (command, args, options) => {
      if (args.includes("exec") && args.at(-1) === "true") throw new Error("guest agent unavailable");
      return run(command, args, options);
    });
    vi.spyOn(f.machines, "abortStart").mockRejectedValue(new Error("force stop failed"));
    await expect(f.access.lifecycle({ ...identity, operation: "start" }))
      .rejects.toThrow("VM startup failed and stopping the started VM could not be confirmed");
  });

  it("serializes lifecycle authorization with grant revocation", async () => {
    const f = await fixture(["discover", "status", "lifecycle"]), identity = request(f);
    const originalAuthorize = f.records.authorizeAccess.bind(f.records), originalStop = f.machines.stop.bind(f.machines);
    let authorizeReady: (() => void) | undefined, continueAuthorize: (() => void) | undefined, revoked = false;
    const authorized = new Promise<void>((resolve) => { authorizeReady = resolve; });
    const proceed = new Promise<void>((resolve) => { continueAuthorize = resolve; });
    vi.spyOn(f.records, "authorizeAccess").mockImplementation(async (...args) => {
      const result = await originalAuthorize(...args); authorizeReady?.(); await proceed; return result;
    });
    vi.spyOn(f.machines, "stop").mockImplementation(async (record) => {
      expect(revoked).toBe(false); await originalStop(record);
    });
    const lifecycle = f.access.lifecycle({ ...identity, operation: "stop" });
    await authorized;
    const revocation = f.records.revoke(f.vm.name, f.current.id).then(() => { revoked = true; });
    continueAuthorize?.();
    await lifecycle; await revocation;
    expect(revoked).toBe(true);
  });

  it("routes copy through the bounded DIMCP1 guest helper below the VM home", async () => {
    const f = await fixture(["discover", "status", "copy"]), identity = request(f);
    await expect(f.access.copy({ ...identity, direction: "push", path: "artifacts/result.bin", recursive: false,
      overwrite: true })).resolves.toBe(0);
    expect(f.runner.calls.at(-1)).toEqual(expect.arrayContaining(["exec", expect.any(String), "--", "runuser", "--user", "dim",
      "--preserve-environment", "--", "node", "--input-type=commonjs", "-e", expect.stringContaining("DIMCP1"),
      "receive", "/home/dim/artifacts/result.bin", "0", "1", "dim-workspace-copy", "helper", expect.any(String), "/home/dim"]));
    await expect(f.access.copy({ ...identity, path: "../escape", direction: "pull", recursive: false,
      overwrite: false })).rejects.toThrow(/path/);
  });

  it("rejects access immediately after revoke, workspace stop or target replacement", async () => {
    const f = await fixture(["discover", "status", "exec"]), identity = request(f);
    await f.records.revoke(f.vm.name, f.current.id);
    await expect(f.access.status(identity)).rejects.toThrow(/denied/);
    const rotated = await fixture(["discover", "status", "exec"]), rotatedIdentity = request(rotated);
    await rotated.store.write({ ...rotated.current, phase: "stopped" });
    await expect(rotated.access.status(rotatedIdentity)).rejects.toThrow(/denied/);
    await rotated.store.write({ ...rotated.current, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", phase: "running" });
    await expect(rotated.access.status(rotatedIdentity)).rejects.toThrow(/denied/);
  });
});
