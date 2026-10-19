import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../../../../packages/host/core/src/workspace/store.js";
import { IncusMachines } from "../../../../packages/host/plugins/vm/src/incus.js";
import { PersistentVmService } from "../../../../packages/host/plugins/vm/src/store.js";
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
  it("keeps a persistent auxiliary disk until explicit discard", async () => {
    const { service, runner } = await fixture();
    await service.start("desktop"); await service.stop("desktop");
    expect(runner.exists).toBe(true);
    expect((await service.read("desktop")).initialized).toBe(true);
    await service.discard("desktop");
    expect(runner.exists).toBe(false);
    await expect(service.read("desktop")).rejects.toThrow("does not exist");
  });
});
