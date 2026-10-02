import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { LifecycleState } from "@slop-lab/dim-core";
import { workspaceServiceSubdomain } from "@slop-lab/dim-contracts-external-url";
import {
  adminAction,
  availablePort,
  closeServer,
  foreign,
  listen,
  proxyRequest,
  serverPort,
  startApprovalHttpPlugin,
  workspace,
  workspaceRecord
} from "./support/approvalHttpHarness.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((operation) => operation())).then(() => {}));

it("keeps the opencode slug stable and workspace scoped", async () => {
  // Given: two workspaces using one approval-required ingress and one bound target.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-stable-workspace-slug-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  const firstWorkspace = { ...workspace, name: "work.foo" };
  const secondWorkspace = { ...foreign, name: "work_foo" };
  const firstSubdomain = workspaceServiceSubdomain(firstWorkspace.name, "opencode");
  const secondSubdomain = workspaceServiceSubdomain(secondWorkspace.name, "opencode");
  const state = new LifecycleState(stateRoot);
  await state.claimWorkspace(workspaceRecord(firstWorkspace));
  await state.claimWorkspace(workspaceRecord(secondWorkspace));
  const upstream = http.createServer((_request, response) => response.end("opencode-target"));
  await listen(upstream);
  cleanup.push(() => closeServer(upstream));
  const ingressPort = await availablePort();
  const started = await startApprovalHttpPlugin({
    stateRoot,
    ingressPort,
    targetPort: serverPort(upstream),
    workspace: firstWorkspace,
    foreignWorkspace: secondWorkspace
  });
  cleanup.push(() => started.close());

  // When: each workspace requests its fixed slug and the first repeats its request.
  const first = await createRoute(started.controllerBase, "workspace-grant", firstSubdomain);
  const second = await createRoute(started.controllerBase, "foreign-grant", secondSubdomain);
  const repeated = await createRoute(started.controllerBase, "workspace-grant", firstSubdomain);

  // Then: repeat setup reuses one pending identity while workspace authorities remain distinct and closed.
  expect(first.responseStatus).toBe(201);
  expect(second.responseStatus).toBe(201);
  expect(repeated.responseStatus).toBe(200);
  expect(repeated.route).toEqual(first.route);
  expect(firstSubdomain).not.toBe(secondSubdomain);
  expect(first.route.url).toBe(`http://${firstSubdomain}.example.test/`);
  expect(second.route.url).toBe(`http://${secondSubdomain}.example.test/`);
  expect(first.route.approval).toBe("pending");
  expect(second.route.approval).toBe("pending");
  expect(await proxyRequest(ingressPort, `${firstSubdomain}.example.test`)).toMatchObject({ status: 404 });
  expect(await proxyRequest(ingressPort, `${secondSubdomain}.example.test`)).toMatchObject({ status: 404 });

  expect((await adminAction(started.adminBase, "url-approve", first.route.id)).status).toBe(200);
  expect(await proxyRequest(ingressPort, `${firstSubdomain}.example.test`)).toEqual({
    status: 200,
    body: "opencode-target"
  });
  expect(await proxyRequest(ingressPort, `${secondSubdomain}.example.test`)).toMatchObject({ status: 404 });
});

async function createRoute(base: string, grant: string, subdomain: string): Promise<{
  readonly responseStatus: number;
  readonly route: { readonly id: string; readonly url: string; readonly permalink: string; readonly approval: string };
}> {
  const response = await fetch(`${base}/api/urls`, {
    method: "POST",
    headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
    body: JSON.stringify({
      ingress: "public",
      subdomain,
      target: { containers: ["agent"], port: 8080, protocol: "http" }
    })
  });
  const value: unknown = await response.json();
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
  return {
    responseStatus: response.status,
    route: { id: route.id, url: route.url, permalink: route.permalink, approval: route.approval }
  };
}
