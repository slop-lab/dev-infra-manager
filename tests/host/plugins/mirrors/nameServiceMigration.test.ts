import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkspaceStore, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
const { attachWorkspaceMirrors }: typeof import("../../../../packages/host/plugins/mirrors/src/attachment.js") =
  await import(new URL("../../../../packages/host/plugins/mirrors/dist/attachment.js", import.meta.url).href);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-name-service-migration-"));
  const store = new WorkspaceStore(join(root, "workspaces")), workspace = workspaceRecord();
  await store.write(workspace);
  const upstream = createServer((_request, response) => { response.end("cache bytes"); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("upstream unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const reconciled: { workspace: WorkspaceRecord; registrations: readonly { name: string; upstream: string }[] }[] = [];
  const context: WorkspaceHostPluginContext = {
    store, runner: { run: async () => { throw new Error("unused"); }, runStreaming: async () => 0 },
    cleanupRunner: { run: async () => { throw new Error("unused"); } }, stateRoot: root, signal: AbortSignal.timeout(15_000),
    hostGateway: async () => "127.0.0.1",
    service: { exec: async () => 0 } as unknown as WorkspaceHostPluginContext["service"],
    nameService: { reconcile: async (ws, registrations) => { reconciled.push({ workspace: ws, registrations }); return { resolver: "127.0.0.1" }; } }
  };
  return {
    workspace, context, origin, reconciled,
    async close() { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }); },
    async closeRelay() {
      const relayRoot = join(root, "plugins/host-mirrors/workspaces", workspace.id);
      try {
        const ready: unknown = JSON.parse(await readFile(join(relayRoot, "ready.json"), "utf8"));
        const config: unknown = JSON.parse(await readFile(join(relayRoot, "relay.json"), "utf8"));
        if (!ready || typeof ready !== "object" || !("controlPort" in ready) || typeof ready.controlPort !== "number"
          || !config || typeof config !== "object" || !("controlToken" in config) || typeof config.controlToken !== "string") return;
        await fetch(`http://127.0.0.1:${ready.controlPort}/__dim/close`, { method: "POST", headers: { authorization: `Bearer ${config.controlToken}` }, signal: AbortSignal.timeout(1_000) });
      } catch { /* nothing to close */ }
    }
  };
}

it("registers only the migrated npm name (not pypi), pointed at the relay's own gateway-port endpoint", async () => {
  const f = await fixture();
  try {
    await attachWorkspaceMirrors(f.workspace, f.context, { endpoints: { npm: `${f.origin}/`, pypi: `${f.origin}/root/pypi/+simple/` } });
    expect(f.reconciled).toHaveLength(1);
    const registrations = f.reconciled[0]!.registrations;
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.name).toBe("npm.cache.dim.internal");
    expect(registrations[0]?.upstream).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(registrations[0]?.upstream).not.toBe(f.origin + "/");
  } finally { await f.closeRelay(); await f.close(); }
});

it("deregisters (reconciles an empty set) once npm is no longer configured", async () => {
  const f = await fixture();
  try {
    await attachWorkspaceMirrors(f.workspace, f.context, { endpoints: { npm: `${f.origin}/`, pypi: `${f.origin}/root/pypi/+simple/` } });
    await attachWorkspaceMirrors(f.workspace, f.context, { endpoints: { pypi: `${f.origin}/root/pypi/+simple/` } });
    expect(f.reconciled).toHaveLength(2);
    expect(f.reconciled[1]?.registrations).toEqual([]);
  } finally { await f.closeRelay(); await f.close(); }
});

it("refuses to attach without a workspace name service, exactly like it refuses without a private gateway", async () => {
  const f = await fixture();
  try {
    const { nameService: _omitted, ...rest } = f.context;
    await expect(attachWorkspaceMirrors(f.workspace, rest, { endpoints: { npm: `${f.origin}/` } })).rejects.toThrow(/name service/);
  } finally { await f.close(); }
});
