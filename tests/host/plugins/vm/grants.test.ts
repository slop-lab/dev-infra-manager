import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../../../../packages/host/core/src/workspace/store.js";
import { IncusMachines } from "../../../../packages/host/plugins/vm/src/incus.js";
import { parsePersistentVm, PersistentVmService } from "../../../../packages/host/plugins/vm/src/store.js";
import { config, FakeIncus, workspace } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-vm-grants-")); roots.push(root);
  const store = new WorkspaceStore(root);
  const runner = new FakeIncus();
  const machines = new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {} });
  const service = new PersistentVmService(root, machines, store);
  await store.write(workspace({ initialized: true, phase: "running" }));
  const record = await service.create("desktop", "a".repeat(64), workspace().resources);
  return { root, store, runner, machines, service, record };
}
describe("persistent VM scoped access", () => {
  it("persists a separate machine record with private hashed workspace grants", async () => {
    const { root, service, record } = await fixture();
    const token = await service.grant("desktop", "dev");
    const file = path.join(root, "plugins/vm/instances/desktop.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toContain(token);
    expect((await service.authorize("desktop", token))?.id).toBe(record.id);
    expect(await service.authorize("desktop", "wrong")).toBeUndefined();
  });
  it("issues an identity-pinned permission grant without persisting its token", async () => {
    const { root, service, record } = await fixture();
    const credential = await service.grantAccess("desktop", "dev", ["discover", "status", "exec", "copy"]);
    expect(credential).toMatchObject({ vmId: record.id, vmName: record.name, workspaceId: workspace().id,
      permissions: ["copy", "discover", "exec", "status"], generation: 1 });
    expect(credential.grantId).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await readFile(path.join(root, "plugins/vm/instances/desktop.json"), "utf8");
    expect(stored).not.toContain(credential.token);
    expect(JSON.parse(stored).grants[0]).toMatchObject({ grantId: credential.grantId, generation: 1,
      permissions: ["copy", "discover", "exec", "status"] });
  });
  it("authorizes only the exact workspace, VM identity and requested permission", async () => {
    const { service, record } = await fixture();
    const credential = await service.grantAccess("desktop", "dev", ["discover", "exec"]);
    const access = await service.authorizeAccess("desktop", credential.token, { permission: "exec",
      vmId: record.id, workspaceId: workspace().id });
    expect(access).toMatchObject({ vm: { id: record.id }, workspace: { id: workspace().id },
      grant: { grantId: credential.grantId, permissions: ["discover", "exec"] } });
    await expect(service.authorizeAccess("desktop", credential.token, { permission: "lifecycle",
      vmId: record.id, workspaceId: workspace().id })).resolves.toBeUndefined();
    await expect(service.authorizeAccess("desktop", credential.token, { permission: "exec",
      vmId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId: workspace().id })).resolves.toBeUndefined();
    await expect(service.authorizeAccess("desktop", credential.token, { permission: "exec",
      vmId: record.id, workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).resolves.toBeUndefined();
    await expect(service.authorizeAccess("desktop", credential.token, { permission: "exec", vmId: record.id,
      workspaceId: workspace().id, grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: credential.generation })).resolves.toBeUndefined();
    await expect(service.authorizeAccess("desktop", credential.token, { permission: "exec", vmId: record.id,
      workspaceId: workspace().id, grantId: credential.grantId, generation: credential.generation + 1 })).resolves.toBeUndefined();
  });
  it("reads legacy console-only grants without widening their authority", () => {
    const parsed = parsePersistentVm({ schemaVersion: 1, id: "12345678-1234-4234-8234-123456789abc",
      name: "desktop", image: "a".repeat(64), resources: workspace().resources, initialized: true,
      createdAt: "2026-10-18T00:00:00Z", grants: [{ workspaceId: workspace().id,
        workspaceName: "dev", digest: "f".repeat(64) }] });
    expect(parsed.grants[0]).toMatchObject({ permissions: ["console"], generation: 1 });
  });
  it("revokes immediately on workspace stop/discard and rejects name reuse", async () => {
    const { service, store } = await fixture();
    const token = await service.grant("desktop", "dev");
    await store.write(workspace({ initialized: true, phase: "stopped" }));
    expect(await service.authorize("desktop", token)).toBeUndefined();
    await store.remove("dev");
    expect(await service.authorize("desktop", token)).toBeUndefined();
    await store.write(workspace({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", initialized: true, phase: "running" }));
    expect(await service.authorize("desktop", token)).toBeUndefined();
  });
  it("rotates only the selected workspace grant and preserves the VM on revoke", async () => {
    const { service, runner } = await fixture();
    const old = await service.grant("desktop", "dev"), next = await service.grant("desktop", "dev");
    expect(await service.authorize("desktop", old)).toBeUndefined();
    expect(await service.authorize("desktop", next)).toBeDefined();
    await service.revoke("desktop", workspace().id);
    expect(await service.authorize("desktop", next)).toBeUndefined();
    expect(runner.exists).toBe(true);
  });
  it("does not let a stale delivery failure revoke a newer grant", async () => {
    const { service } = await fixture();
    const stale = await service.grantAccess("desktop", "dev", ["discover", "status"]);
    const current = await service.grantAccess("desktop", "dev", ["discover", "status"]);
    await service.revokeGrant("desktop", { workspaceId: stale.workspaceId, grantId: stale.grantId, generation: stale.generation });
    expect(await service.authorizeAccess("desktop", current.token, { permission: "status", vmId: current.vmId,
      workspaceId: current.workspaceId, grantId: current.grantId, generation: current.generation })).toBeDefined();
  });
  it("keeps a persistent auxiliary disk until explicit discard", async () => {
    const { service, runner } = await fixture();
    await service.start("desktop"); await service.stop("desktop");
    expect(runner.exists).toBe(true);
    expect((await service.read("desktop")).initialized).toBe(true);
    await service.discard("desktop");
    expect(runner.exists).toBe(false);
    await expect(service.read("desktop")).rejects.toThrow("does not exist");
  });
  it("rejects stale auxiliary VM identity before destructive smoke cleanup", async () => {
    const { service, runner, record } = await fixture();
    await expect(service.discard(record.name, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).rejects.toThrow("identity changed");
    expect(runner.exists).toBe(true);
    await service.discard(record.name, record.id);
    expect(runner.exists).toBe(false);
  });
});
