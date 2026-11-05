import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceService, WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { hostPlugin } from "../../../../packages/host/plugins/vm/src/index.js";
import { IncusMachines } from "../../../../packages/host/plugins/vm/src/incus.js";
import { PersistentVmService } from "../../../../packages/host/plugins/vm/src/store.js";
import { config, FakeIncus, workspace } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("deploys ordinary agent VM access and discovers only operator-granted targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-vm-workspace-integration-")); roots.push(root);
  const home = path.join(root, "home"); await mkdir(home, { mode: 0o700 });
  const store = new WorkspaceStore(path.join(root, "state")), current = workspace({ initialized: true, phase: "running" }); await store.write(current);
  const runner = new FakeIncus(), machines = new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {} });
  const records = new PersistentVmService(store.root, machines, store);
  const vm = await records.create("desktop", "a".repeat(64), current.resources); await records.start(vm.name);
  const service = new WorkspaceService(store, { async inspect() { return { running: true }; }, async create() {}, async start() {}, async stop() {},
    async remove() {}, async updateResources() { return { recreated: false }; }, async seed() {}, async exec() { return 0; }, async connect() { return 0; } },
  async () => { throw new Error("source acquisition is unavailable"); });
  vi.spyOn(service, "exec").mockImplementation(async (name, args, options) => {
    expect(name).toBe(current.name); expect(options?.workspaceId).toBe(current.id);
    const chunks: Buffer[] = []; if (options?.stdin) for await (const chunk of options.stdin) chunks.push(Buffer.from(chunk));
    return new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, args.slice(1), { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.resume(); child.stderr.resume(); child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); child.stdin.end(Buffer.concat(chunks));
    });
  });
  const configDirectory = path.join(store.root, "plugins/vm"); await mkdir(configDirectory, { recursive: true });
  await writeFile(path.join(configDirectory, "config.json"), JSON.stringify({ ...config, budgetHelper: "/usr/local/bin/dim-vm-budget" }), { mode: 0o600 });
  const abort = new AbortController();
  const context: WorkspaceHostPluginContext = { runner, cleanupRunner: runner, store, service, stateRoot: store.root, signal: abort.signal };

  await hostPlugin.workspaceReady?.(current, context);
  expect((await stat(path.join(home, ".local/bin/dim-vm"))).mode & 0o777).toBe(0o700);
  expect((await stat(path.join(home, ".local/share/dim-vm/copy.cjs"))).mode & 0o777).toBe(0o700);
  expect(await hostPlugin.workspaceCapabilities?.(current, context)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "auxiliary-vm-access", state: "blocked", reason: expect.objectContaining({ code: "vm-grant-required" }) })
  ]));

  await hostPlugin.run?.(["vm", "grant", vm.name, current.name, "--lifecycle"], context);
  const credential = JSON.parse(await readFile(path.join(home, ".config/dim/vms/desktop.json"), "utf8"));
  expect(credential).toMatchObject({ schemaVersion: 2, vmId: vm.id, vmName: vm.name, workspaceId: current.id,
    endpoint: "http://127.0.0.1:19420/services/vm", permissions: ["console", "copy", "discover", "exec", "lifecycle", "status"] });
  expect(await hostPlugin.workspaceCapabilities?.(current, context)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "auxiliary-vm-access", state: "available", access: { kind: "guest-operation", operation: "list" } })
  ]));
  const list = hostPlugin.guest?.operations?.find(({ name }) => name === "list");
  if (!list) throw new Error("VM guest list operation missing");
  expect(await list.handle({}, current, context)).toEqual([{ vmId: vm.id, vmName: vm.name, running: true,
    permissions: ["console", "copy", "discover", "exec", "lifecycle", "status"] }]);
  expect(hostPlugin.workspaceServices?.names).toContain("vm");
  expect(await hostPlugin.workspaceServices?.resolve("vm", current, context)).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
  abort.abort();
});
