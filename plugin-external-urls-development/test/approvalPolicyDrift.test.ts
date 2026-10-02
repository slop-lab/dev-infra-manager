import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { LifecycleState } from "@slop-lab/dim-core";
import { ExternalUrlStore } from "../../plugin-external-urls/src/routeStore.js";
import {
  adminAction,
  availablePort,
  closeServer,
  listen,
  proxyRequest,
  requestUrl,
  routeResponse,
  serverPort,
  startApprovalHttpPlugin,
  storedApproval,
  workspace,
  workspaceRecord
} from "./support/approvalHttpHarness.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((operation) => operation())).then(() => {}));

it("returns an approved route to pending when its direct listener becomes publicly bound", async () => {
  // Given: an approved route whose direct ingress is bound only to loopback.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-http-policy-drift-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  await new LifecycleState(stateRoot).claimWorkspace(workspaceRecord(workspace));
  const upstream = http.createServer((_request, response) => response.end("policy-target"));
  await listen(upstream);
  cleanup.push(() => closeServer(upstream));
  const ingressPort = await availablePort();
  const targetPort = serverPort(upstream);
  const first = await startApprovalHttpPlugin({ stateRoot, ingressPort, targetPort });
  const pending = routeResponse(await (await requestUrl(first.controllerBase, "workspace-grant")).json());
  expect((await adminAction(first.adminBase, "url-approve", pending.id)).status).toBe(200);
  expect(await proxyRequest(ingressPort)).toEqual({ status: 200, body: "policy-target" });
  await first.close();

  // When: restart changes the same direct listener from loopback to every interface.
  const publicRestart = await startApprovalHttpPlugin({
    stateRoot,
    ingressPort,
    targetPort,
    initialize: true,
    listenHost: "0.0.0.0"
  });
  cleanup.push(() => publicRestart.close());

  // Then: the wider exposure requires a fresh host decision before traffic resumes.
  expect(await storedApproval(stateRoot, workspace.id)).toBe("pending");
  expect(await proxyRequest(ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });
  expect((await adminAction(publicRestart.adminBase, "url-approve", pending.id)).status).toBe(200);
  expect(await proxyRequest(ingressPort)).toEqual({ status: 200, body: "policy-target" });
});

it("regenerates a pending HTTP route when its advertised public port changes", async () => {
  // Given: an approved route advertised without an explicit public port.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-http-port-drift-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  await new LifecycleState(stateRoot).claimWorkspace(workspaceRecord(workspace));
  const upstream = http.createServer((_request, response) => response.end("port-target"));
  await listen(upstream);
  cleanup.push(() => closeServer(upstream));
  const ingressPort = await availablePort();
  const targetPort = serverPort(upstream);
  const first = await startApprovalHttpPlugin({ stateRoot, ingressPort, targetPort });
  const approved = routeResponse(await (await requestUrl(first.controllerBase, "workspace-grant")).json());
  expect((await adminAction(first.adminBase, "url-approve", approved.id)).status).toBe(200);
  const before = (await new ExternalUrlStore(stateRoot).list(workspace.id))[0];
  if (before === undefined) throw new Error("missing stored route before drift");
  await first.close();

  // When: the same listener restarts with a new public port but its first target resolution fails.
  const publicPort = 8443;
  const restarted = await startApprovalHttpPlugin({
    stateRoot,
    ingressPort,
    targetPort,
    initialize: true,
    publicPort,
    failInitializationResolution: true
  });
  cleanup.push(() => restarted.close());
  const afterFailure = (await new ExternalUrlStore(stateRoot).list(workspace.id))[0];
  if (afterFailure === undefined) throw new Error("missing stored route after failed reconciliation");

  // Then: denial is durable, but the old revision remains so a later request retries reconciliation.
  expect(afterFailure).toMatchObject({
    approval: "pending",
    policyRevision: before.policyRevision,
    url: before.url,
    route: { authority: before.route.authority, url: before.route.url }
  });

  // When: the next controller request resolves the target successfully.
  const returned = routeResponse(await (await requestUrl(restarted.controllerBase, "workspace-grant")).json());
  const stored = (await new ExternalUrlStore(stateRoot).list(workspace.id))[0];
  const inventory = routeResponse(await (await fetch(`${restarted.adminBase}/url-list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  })).json());

  // Then: returned, durable, and host inventory tuples advance together while approval stays pending.
  expect(returned).toMatchObject({ id: approved.id, approval: "pending", url: `http://work--app.example.test:${publicPort}/` });
  expect(inventory).toMatchObject({ id: approved.id, approval: "pending", url: returned.url });
  expect(stored?.policyRevision).not.toBe(before.policyRevision);
  expect(stored?.url).toBe(returned.url);
  expect(stored?.route.url).toBe(returned.url);
  expect(await proxyRequest(ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });
});

it("regenerates a pending managed-Caddy route from stable public exposure instead of its router port", async () => {
  // Given: an approved route behind a loopback router with a distinct stable HTTPS-style public socket.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-caddy-port-drift-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  await new LifecycleState(stateRoot).claimWorkspace(workspaceRecord(workspace));
  const upstream = http.createServer((_request, response) => response.end("caddy-target"));
  await listen(upstream);
  cleanup.push(() => closeServer(upstream));
  const firstRouterPort = await availablePort();
  const targetPort = serverPort(upstream);
  const first = await startApprovalHttpPlugin({
    stateRoot,
    ingressPort: firstRouterPort,
    targetPort,
    scheme: "https",
    approvalExposure: { listenHost: "0.0.0.0", listenPort: 443 }
  });
  const approved = routeResponse(await (await requestUrl(first.controllerBase, "workspace-grant")).json());
  expect((await adminAction(first.adminBase, "url-approve", approved.id)).status).toBe(200);
  await first.close();

  // When: both the ephemeral router port and stable public port change.
  const secondRouterPort = await availablePort();
  const publicPort = 9443;
  const restarted = await startApprovalHttpPlugin({
    stateRoot,
    ingressPort: secondRouterPort,
    targetPort,
    initialize: true,
    scheme: "https",
    publicPort,
    approvalExposure: { listenHost: "0.0.0.0", listenPort: publicPort }
  });
  cleanup.push(() => restarted.close());
  const returned = routeResponse(await (await requestUrl(restarted.controllerBase, "workspace-grant")).json());

  // Then: the durable public tuple tracks the stable port and remains pending on the new internal router.
  expect(returned).toMatchObject({ id: approved.id, approval: "pending", url: `https://work--app.example.test:${publicPort}/` });
  expect((await new ExternalUrlStore(stateRoot).list(workspace.id))[0]?.url).toBe(returned.url);
  expect(await proxyRequest(secondRouterPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });
});
