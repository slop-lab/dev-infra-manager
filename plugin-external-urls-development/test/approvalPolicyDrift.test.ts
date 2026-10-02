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
  const first = await startApprovalHttpPlugin(stateRoot, ingressPort, serverPort(upstream));
  const pending = routeResponse(await (await requestUrl(first.controllerBase, "workspace-grant")).json());
  expect((await adminAction(first.adminBase, "url-approve", pending.id)).status).toBe(200);
  expect(await proxyRequest(ingressPort)).toEqual({ status: 200, body: "policy-target" });
  await first.close();

  // When: restart changes the same direct listener from loopback to every interface.
  const publicRestart = await startApprovalHttpPlugin(stateRoot, ingressPort, serverPort(upstream), true, "0.0.0.0");
  cleanup.push(() => publicRestart.close());

  // Then: the wider exposure requires a fresh host decision before traffic resumes.
  expect(await storedApproval(stateRoot, workspace.id)).toBe("pending");
  expect(await proxyRequest(ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });
  expect((await adminAction(publicRestart.adminBase, "url-approve", pending.id)).status).toBe(200);
  expect(await proxyRequest(ingressPort)).toEqual({ status: 200, body: "policy-target" });
});
