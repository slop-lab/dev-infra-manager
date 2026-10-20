import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
const { ensureWorkspaceRelay }: typeof import("../../../../packages/host/plugins/mirrors/src/attachment.js") =
  await import(new URL("../../../../packages/host/plugins/mirrors/dist/attachment.js", import.meta.url).href);

it("runs the compiled relay with npm alone, updates targets in place and reconciles selected protocols", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-relay-lifecycle-")), relayRoot = join(root, "relay");
  const store = new WorkspaceStore(join(root, "workspaces")), workspace = workspaceRecord(); await store.write(workspace);
  const upstream = createServer((request, response) => response.end(request.url));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("upstream missing");
  const origin = `http://127.0.0.1:${address.port}`, scope = { workspaceStateRoot: store.root, workspaceName: workspace.name,
    workspaceId: workspace.id, listen: "127.0.0.1" };
  const signal = AbortSignal.timeout(12_000);
  try {
    const first = await ensureWorkspaceRelay(relayRoot, { ...scope, endpoints: { npm: `${origin}/first/` } }, signal);
    expect(Object.keys(first.ports)).toEqual(["npm"]);
    const npm = `http://127.0.0.1:${first.ports.npm}`;
    expect(await (await fetch(`${npm}/package`)).text()).toBe("/first/package");
    expect(await ensureWorkspaceRelay(relayRoot, { ...scope, endpoints: { npm: `${origin}/first/` } }, signal)).toEqual(first);
    const updated = await ensureWorkspaceRelay(relayRoot, { ...scope, endpoints: { npm: `${origin}/second/` } }, signal);
    expect(updated).toEqual(first);
    expect(await (await fetch(`${npm}/package`)).text()).toBe("/second/package");
    const expanded = await ensureWorkspaceRelay(relayRoot, { ...scope, endpoints: { npm: `${origin}/second/`, apt: `${origin}/` } }, signal);
    expect(Object.keys(expanded.ports).sort()).toEqual(["apt", "npm"]);
    expect(await (await fetch(`http://127.0.0.1:${expanded.ports.npm}/package`)).text()).toBe("/second/package");
    const selected = await ensureWorkspaceRelay(relayRoot, { ...scope, endpoints: { npm: `${origin}/second/` } }, signal);
    expect(Object.keys(selected.ports)).toEqual(["npm"]);
    expect(await (await fetch(`http://127.0.0.1:${selected.ports.npm}/package`)).text()).toBe("/second/package");
  } finally {
    // Read the owned private token and close only this test's detached relay.
    try {
      const ready: unknown = JSON.parse(await readFile(join(relayRoot, "ready.json"), "utf8"));
      const config: unknown = JSON.parse(await readFile(join(relayRoot, "relay.json"), "utf8"));
      if (!ready || typeof ready !== "object" || !("controlPort" in ready) || typeof ready.controlPort !== "number"
        || !config || typeof config !== "object" || !("controlToken" in config) || typeof config.controlToken !== "string") throw new Error("owned relay state invalid");
      await fetch(`http://127.0.0.1:${ready.controlPort}/__dim/close`, { method: "POST", headers: { authorization: `Bearer ${config.controlToken}` }, signal: AbortSignal.timeout(1000) });
    } finally {
      await store.remove(workspace.name);
      upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
});
