import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleState } from "@slop-lab/dim-core";
import { WorkspaceRouteRegistry } from "../../plugin-external-urls/src/httpRouteRegistry.js";
import {
  adminAction,
  availablePort,
  closeServer,
  foreign,
  listen,
  proxyRequest,
  requestUrl,
  serverPort,
  startApprovalHttpPlugin,
  workspace,
  workspaceRecord
} from "./support/approvalHttpHarness.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((operation) => operation())).then(() => {}));

describe.each([
  { scheme: "http" as const, label: "direct HTTP" },
  { scheme: "https" as const, label: "managed Caddy router" }
])("hostname permalinks through $label", ({ scheme }) => {
  it("gates slug and permalink together through approval and revocation", async () => {
    // Given: an approval-required hostname ingress and a real HTTP target.
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-permalink-approval-"));
    cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
    await new LifecycleState(stateRoot).claimWorkspace(workspaceRecord(workspace));
    const upstream = http.createServer((_request, response) => response.end("same-approved-target"));
    await listen(upstream);
    cleanup.push(() => closeServer(upstream));
    const ingressPort = await availablePort();
    const started = await startApprovalHttpPlugin({
      stateRoot,
      ingressPort,
      targetPort: serverPort(upstream),
      scheme,
      ...(scheme === "https" ? { approvalExposure: { listenHost: "0.0.0.0", listenPort: 443 } } : {})
    });
    cleanup.push(() => started.close());

    // When: the workspace reserves one logical route.
    const created = await requestUrl(started.controllerBase, "workspace-grant");
    const pending = externalRoute(await created.json());
    const slugHost = new URL(pending.url).hostname;
    const permalinkHost = new URL(pending.permalink).hostname;

    // Then: both returned authorities are denied while the shared route is pending.
    expect(created.status).toBe(201);
    expect(pending.approval).toBe("pending");
    expect(permalinkHost).toBe(`work-permalink-${pending.id}.example.test`);
    expect(await proxyRequest(ingressPort, slugHost)).toMatchObject({ status: 404 });
    expect(await proxyRequest(ingressPort, permalinkHost)).toMatchObject({ status: 404 });

    // When: host administration approves the route ID.
    expect((await adminAction(started.adminBase, "url-approve", pending.id)).status).toBe(200);

    // Then: both authorities reach the identical target, while foreign workspace authority cannot revoke it.
    expect(await proxyRequest(ingressPort, slugHost)).toEqual({ status: 200, body: "same-approved-target" });
    expect(await proxyRequest(ingressPort, permalinkHost)).toEqual({ status: 200, body: "same-approved-target" });
    const foreignDelete = await fetch(`${started.controllerBase}/api/urls/${pending.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer foreign-grant" }
    });
    expect(foreignDelete.status).toBe(404);

    // When: host administration revokes the same route ID.
    expect((await adminAction(started.adminBase, "url-revoke", pending.id)).status).toBe(200);

    // Then: both authorities are denied together.
    expect(await proxyRequest(ingressPort, slugHost)).toMatchObject({ status: 404 });
    expect(await proxyRequest(ingressPort, permalinkHost)).toMatchObject({ status: 404 });
  });
});

it("keeps dual authorities exclusive when another workspace resolves to the same target", async () => {
  // Given: one pending route and a policy that selects the same slug for every workspace.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-permalink-exclusive-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  const state = new LifecycleState(stateRoot);
  await state.claimWorkspace(workspaceRecord(workspace));
  await state.claimWorkspace(workspaceRecord(foreign));
  const upstream = http.createServer((_request, response) => response.end("exclusive-target"));
  await listen(upstream);
  cleanup.push(() => closeServer(upstream));
  const ingressPort = await availablePort();
  const sharedPolicy = await policyServer("shared-slug");
  const started = await startApprovalHttpPlugin({
    stateRoot,
    ingressPort,
    targetPort: serverPort(upstream),
    routePolicy: { driver: "webhook", argument: JSON.stringify({ url: sharedPolicy }) }
  });
  cleanup.push(() => started.close());
  const first = externalRoute(await (await requestUrl(started.controllerBase, "workspace-grant")).json());
  const slug = new URL(first.url).hostname;
  const permalink = new URL(first.permalink).hostname;
  expect(await proxyRequest(ingressPort, slug)).toMatchObject({ status: 404 });
  expect(await proxyRequest(ingressPort, permalink)).toMatchObject({ status: 404 });
  expect((await adminAction(started.adminBase, "url-approve", first.id)).status).toBe(200);

  // When: a foreign pending route requests that same slug and exact upstream.
  const collision = await requestUrl(started.controllerBase, "foreign-grant");

  // Then: the request is rejected atomically and the first route alone remains reachable until revocation.
  expect(collision.status).toBe(400);
  expect(await proxyRequest(ingressPort, slug)).toEqual({ status: 200, body: "exclusive-target" });
  expect(await proxyRequest(ingressPort, permalink)).toEqual({ status: 200, body: "exclusive-target" });
  expect((await adminAction(started.adminBase, "url-revoke", first.id)).status).toBe(200);
  expect(await proxyRequest(ingressPort, slug)).toMatchObject({ status: 404 });
  expect(await proxyRequest(ingressPort, permalink)).toMatchObject({ status: 404 });
});

it("keeps the permalink stable across same-instance slug policy changes and denies it after recreation", async () => {
  // Given: an approved route whose policy rewrites its requested slug.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-permalink-lifecycle-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  const state = new LifecycleState(stateRoot);
  await state.claimWorkspace(workspaceRecord(workspace));
  const upstream = http.createServer((_request, response) => response.end("instance-target"));
  await listen(upstream);
  cleanup.push(() => closeServer(upstream));
  const ingressPort = await availablePort();
  const firstPolicy = await policyServer("first-slug");
  const first = await startApprovalHttpPlugin({
    stateRoot,
    ingressPort,
    targetPort: serverPort(upstream),
    routePolicy: { driver: "webhook", argument: JSON.stringify({ url: firstPolicy }) }
  });
  const created = externalRoute(await (await requestUrl(first.controllerBase, "workspace-grant")).json());
  expect((await adminAction(first.adminBase, "url-approve", created.id)).status).toBe(200);
  await first.close();

  // When: the same workspace instance restarts under a reviewed policy that changes only the slug.
  const secondPolicy = await policyServer("second-slug");
  const restarted = await startApprovalHttpPlugin({
    stateRoot,
    ingressPort,
    targetPort: serverPort(upstream),
    initialize: true,
    routePolicy: { driver: "webhook", argument: JSON.stringify({ url: secondPolicy }) }
  });
  const changed = externalRoute(await (await requestUrl(restarted.controllerBase, "workspace-grant")).json());
  const oldSlug = new URL(created.url).hostname;
  const newSlug = new URL(changed.url).hostname;
  const permalink = new URL(changed.permalink).hostname;

  // Then: route identity and permalink remain stable, while the changed slug requires fresh approval.
  expect(changed).toMatchObject({ id: created.id, permalink: created.permalink, approval: "pending" });
  expect(newSlug).not.toBe(oldSlug);
  expect(await proxyRequest(ingressPort, oldSlug)).toMatchObject({ status: 404 });
  expect(await proxyRequest(ingressPort, newSlug)).toMatchObject({ status: 404 });
  expect(await proxyRequest(ingressPort, permalink)).toMatchObject({ status: 404 });
  expect((await adminAction(restarted.adminBase, "url-approve", changed.id)).status).toBe(200);
  expect(await proxyRequest(ingressPort, oldSlug)).toMatchObject({ status: 404 });
  expect(await proxyRequest(ingressPort, newSlug)).toMatchObject({ status: 200 });
  expect(await proxyRequest(ingressPort, permalink)).toMatchObject({ status: 200 });
  await restarted.close();

  // When: that workspace is discarded and recreated under the same name with a fresh instance ID.
  await state.removeWorkspace(workspace.name);
  await state.claimWorkspace(workspaceRecord({ ...workspace, id: foreign.id }));
  const recreated = await startApprovalHttpPlugin({
    stateRoot,
    ingressPort,
    targetPort: serverPort(upstream),
    workspace: { ...workspace, id: foreign.id },
    routePolicy: { driver: "webhook", argument: JSON.stringify({ url: secondPolicy }) }
  });
  cleanup.push(() => recreated.close());
  const replacement = externalRoute(await (await requestUrl(recreated.controllerBase, "workspace-grant")).json());

  // Then: the old permalink stays denied and the new route has a new pending ID and permalink.
  expect(replacement.id).not.toBe(created.id);
  expect(replacement.permalink).not.toBe(created.permalink);
  expect(replacement.approval).toBe("pending");
  expect(await proxyRequest(ingressPort, permalink)).toMatchObject({ status: 404 });
  expect(await proxyRequest(ingressPort, new URL(replacement.permalink).hostname)).toMatchObject({ status: 404 });
});

it("rejects a dual-authority collision without leaving a partial claim", () => {
  // Given: one route already owns the second authority for a different target.
  const registry = new WorkspaceRouteRegistry();
  const firstTarget = { protocol: "http" as const, host: "127.0.0.1", port: 3000, fingerprint: "first" };
  const secondTarget = { protocol: "http" as const, host: "127.0.0.1", port: 4000, fingerprint: "second" };
  registry.provision({
    authorities: ["occupied.example.test"],
    claim: "first-claim",
    upstream: firstTarget,
    enabled: true,
    beforeRebind: () => {}
  });

  // When: another workspace attempts to acquire a free slug plus the occupied permalink.
  expect(() => registry.provision({
    authorities: ["free.example.test", "occupied.example.test"],
    claim: "foreign-claim",
    upstream: secondTarget,
    enabled: true,
    beforeRebind: () => {}
  })).toThrow("already belongs to another route");

  // Then: the free slug was not partially claimed.
  expect(registry.target("free.example.test")).toBeUndefined();
  expect(registry.target("occupied.example.test")?.claim).toBe("first-claim");
});

it("rejects a distinct claim for an authority with the same upstream", () => {
  // Given: an approved claim exclusively owns one authority and upstream.
  const registry = new WorkspaceRouteRegistry();
  const target = { protocol: "http" as const, host: "127.0.0.1", port: 3000, fingerprint: "shared" };
  registry.provision({
    authorities: ["shared.example.test"],
    claim: "approved-claim",
    upstream: target,
    enabled: true,
    beforeRebind: () => {}
  });

  // When: a pending route with a distinct claim requests the same authority and upstream.
  expect(() => registry.provision({
    authorities: ["shared.example.test"],
    claim: "pending-claim",
    upstream: target,
    enabled: false,
    beforeRebind: () => {}
  })).toThrow("already belongs to another route");

  // Then: only the original approved claim can resolve the authority.
  expect(registry.target("shared.example.test")?.claim).toBe("approved-claim");
});

it("rejects a same-upstream collision before acquiring any authority", () => {
  // Given: one claim owns the second authority for a shared upstream.
  const registry = new WorkspaceRouteRegistry();
  const target = { protocol: "http" as const, host: "127.0.0.1", port: 3000, fingerprint: "shared" };
  registry.provision({
    authorities: ["occupied.example.test"],
    claim: "approved-claim",
    upstream: target,
    enabled: true,
    beforeRebind: () => {}
  });

  // When: a distinct pending claim requests a free slug and that occupied authority atomically.
  expect(() => registry.provision({
    authorities: ["free.example.test", "occupied.example.test"],
    claim: "pending-claim",
    upstream: target,
    enabled: false,
    beforeRebind: () => {}
  })).toThrow("already belongs to another route");

  // Then: no partial slug claim exists and the original owner is unchanged.
  expect(registry.target("free.example.test")).toBeUndefined();
  expect(registry.target("occupied.example.test")?.claim).toBe("approved-claim");
});

function externalRoute(value: unknown): {
  readonly id: string;
  readonly url: string;
  readonly permalink: string;
  readonly approval: string;
} {
  if (!value || typeof value !== "object" || !("urls" in value) || !Array.isArray(value.urls)) {
    throw new Error("expected external URL response");
  }
  const route = value.urls[0];
  if (!route || typeof route !== "object"
    || !("id" in route) || typeof route.id !== "string"
    || !("url" in route) || typeof route.url !== "string"
    || !("permalink" in route) || typeof route.permalink !== "string"
    || !("approval" in route) || typeof route.approval !== "string") {
    throw new Error("expected hostname route with permalink");
  }
  return { id: route.id, url: route.url, permalink: route.permalink, approval: route.approval };
}

async function policyServer(subdomain: string): Promise<string> {
  const server = http.createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ allow: true, subdomain }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => closeServer(server));
  return `http://127.0.0.1:${serverPort(server)}/`;
}
