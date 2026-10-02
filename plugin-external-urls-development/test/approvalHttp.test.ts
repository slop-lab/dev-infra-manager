import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { LifecycleState } from "@slop-lab/dim-core";
import {
  adminAction,
  availablePort,
  closeServer,
  foreign,
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

it("keeps an approval-required HTTP route pending until host approval and preserves exact approval across restart", async () => {
  // Given: a current workspace, an approval-required ingress, and a real HTTP target.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-http-approval-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  await new LifecycleState(stateRoot).claimWorkspace(workspaceRecord(workspace));
  const upstream = http.createServer((_request, response) => response.end("approved-target"));
  await listen(upstream);
  cleanup.push(() => closeServer(upstream));
  const ingressPort = await availablePort();
  const targetPort = serverPort(upstream);
  const first = await startApprovalHttpPlugin(stateRoot, ingressPort, targetPort);
  cleanup.push(() => first.close());

  // When: the workspace requests the route but neither it nor a foreign workspace has host authority.
  const created = await requestUrl(first.controllerBase, "workspace-grant");
  const pending = routeResponse(await created.json());
  const workspaceApproval = await fetch(`${first.controllerBase}/api/urls/${pending.id}/approve`, {
    method: "POST",
    headers: { authorization: "Bearer workspace-grant" }
  });
  const foreignRevoke = await fetch(`${first.controllerBase}/api/urls/${pending.id}`, {
    method: "DELETE",
    headers: { authorization: "Bearer foreign-grant" }
  });

  // Then: creation succeeds with redacted pending state and public traffic remains denied.
  expect(created.status).toBe(201);
  expect(pending).toMatchObject({ approval: "pending", url: "http://work--app.example.test/" });
  expect(pending.internalFields).toEqual([]);
  expect(workspaceApproval.status).toBe(404);
  expect(foreignRevoke.status).toBe(404);
  expect(await proxyRequest(ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });

  await first.close();
  const pendingRestart = await startApprovalHttpPlugin(stateRoot, ingressPort, targetPort, true);
  cleanup.push(() => pendingRestart.close());
  expect(await proxyRequest(ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });

  // When: the host administrator approves the exact pending ID after restart.
  const approved = await adminAction(pendingRestart.adminBase, "url-approve", pending.id);

  // Then: only that target becomes reachable and approval is durable.
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect(routeResponse(await approved.json()).approval).toBe("approved");
  expect(await proxyRequest(ingressPort)).toEqual({ status: 200, body: "approved-target" });
  expect(await storedApproval(stateRoot, workspace.id)).toBe("approved");

  await pendingRestart.close();
  const restarted = await startApprovalHttpPlugin(stateRoot, ingressPort, targetPort, true);
  cleanup.push(() => restarted.close());

  // Then: restart restores approval only for the same workspace instance and exact route tuple.
  expect(await proxyRequest(ingressPort)).toEqual({ status: 200, body: "approved-target" });

  // When: the host administrator revokes the route.
  const revoked = await adminAction(restarted.adminBase, "url-revoke", pending.id);

  // Then: revocation is visible, terminal for that ID, and immediately denies traffic.
  expect(revoked.status).toBe(200);
  expect(routeResponse(await revoked.json()).approval).toBe("revoked");
  expect(await proxyRequest(ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });
  expect((await adminAction(restarted.adminBase, "url-approve", pending.id)).status).toBe(400);

  const replacement = await requestUrl(restarted.controllerBase, "workspace-grant");
  const replacementRoute = routeResponse(await replacement.json());
  expect(replacement.status).toBe(201);
  expect(replacementRoute.id).not.toBe(pending.id);
  expect(replacementRoute.approval).toBe("pending");

  expect((await adminAction(restarted.adminBase, "url-approve", replacementRoute.id)).status).toBe(200);
  expect(await proxyRequest(ingressPort)).toEqual({ status: 200, body: "approved-target" });
  const deleted = await fetch(`${restarted.controllerBase}/api/urls/${replacementRoute.id}`, {
    method: "DELETE",
    headers: { authorization: "Bearer workspace-grant" }
  });
  expect(deleted.status).toBe(204);
  expect(await proxyRequest(ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });

  const successor = routeResponse(await (await requestUrl(restarted.controllerBase, "workspace-grant")).json());

  await new LifecycleState(stateRoot).writeWorkspace(workspaceRecord({ ...workspace, id: foreign.id }));
  expect((await adminAction(restarted.adminBase, "url-approve", successor.id)).status).toBe(400);
});
