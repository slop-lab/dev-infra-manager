import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import { createNativeWorkspaceBroker } from "../../../../packages/host/plugins/native-git/src/nativeWorkspaceBroker.js";
import { attachmentRecord, repositoryBinding, repositoryRecord } from "./nativeProjectFixture.js";
import { nativeWorkspaceBrokerHealth } from "../../../../packages/host/plugins/native-git/src/nativeWorkspaceAttachment.js";
import type { NativeWorkspaceAttachment } from "../../../../packages/host/plugins/native-git/src/nativeWorkspaceAttachment.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dim-native-broker-scope-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new WorkspaceStore(root);
  const now = new Date().toISOString();
  const workspace: WorkspaceRecord = { schemaVersion: 10, id: randomUUID(), name: "development", source: {
    url: "dim://example", ref: "refs/heads/main", commit: "a".repeat(40) }, runtime: "container", image: "unused:test",
    resources: { cpuCount: "1", memory: "1g", pidsLimit: "256" }, git: { name: "Test", email: "test@example.invalid" },
    initialized: true, phase: "running", createdAt: now, updatedAt: now };
  await store.write(workspace);
  const attachment: NativeWorkspaceAttachment = { ...attachmentRecord(root, workspace.id, workspace.name), projectName: "example", projectId: "example" };
  const server = createNativeWorkspaceBroker(attachment);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("broker test has no listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Basic ${Buffer.from(`dim:${attachment.repositories.public!.grant}`).toString("base64")}` };
  return { store, workspace, endpoint, headers, attachment };
}
const gitPath = "/v1/projects/example/repositories/public.git/info/refs?service=git-upload-pack";

describe("native workspace broker authority", () => {
  it("requires its own scoped credential and exposes only the selected Project Git protocol", async () => {
    const { endpoint, headers } = await fixture();
    const unauthorized = await fetch(`${endpoint}/health`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Basic");
    expect((await fetch(`${endpoint}/health`, { headers: { authorization: "Basic invalid" } })).status).toBe(401);
    expect((await fetch(`${endpoint}/health`, { headers })).status).toBe(200);
    for (const request of ["/api/host-inputs/secret", "/v1/call/workspace.discard", "/health?extra=true",
      "/v1/projects/foreign/repositories/public.git/info/refs?service=git-upload-pack",
      `${gitPath}&service=git-receive-pack`]) {
      expect((await fetch(`${endpoint}${request}`, { headers })).status).toBe(404);
    }
    expect((await fetch(`${endpoint}/v1/projects/example/repositories/public.git/git-receive-pack`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}"
    })).status).toBe(404);
  });

  it("uses current core initialization, phase and immutable identity to revoke stale grants", async () => {
    const { store, workspace, endpoint, headers } = await fixture();
    for (const changes of [
      { initialized: false, phase: "creating" as const }, { phase: "stopped" as const }, { phase: "error" as const }
    ]) {
      await store.write({ ...workspace, ...changes });
      expect((await fetch(`${endpoint}${gitPath}`, { headers })).status).toBe(409);
    }
    await store.write({ ...workspace, phase: "discarding" });
    expect((await fetch(`${endpoint}/health`, { headers })).status).toBe(410);
    await store.remove(workspace.name);
    expect((await fetch(`${endpoint}/health`, { headers })).status).toBe(410);
    await store.write({ ...workspace, id: randomUUID() });
    expect((await fetch(`${endpoint}/health`, { headers })).status).toBe(410);
    expect((await fetch(`${endpoint}${gitPath}`, { headers })).status).toBe(410);
  });
});

it("fences each selected repository credential independently and never routes an unselected repository", async () => {
  const { attachment, store, workspace } = await fixture();
  attachment.repositories.private = { ...repositoryBinding(repositoryRecord("private")), nativeWorkspaceId: randomBytes(32).toString("base64url"), grant: randomBytes(32).toString("base64url") };
  const server = createNativeWorkspaceBroker(attachment);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing broker address");
  const headers = { authorization: `Basic ${Buffer.from(`dim:${attachment.repositories.public!.grant}`).toString("base64")}` };
  expect((await fetch(`http://127.0.0.1:${address.port}/v1/projects/example/repositories/private.git/info/refs?service=git-upload-pack`, { headers })).status).toBe(401);
  expect((await fetch(`http://127.0.0.1:${address.port}/v1/projects/example/repositories/unselected.git/info/refs?service=git-upload-pack`, { headers })).status).toBe(404);
  await store.write({ ...workspace, id: randomUUID() });
  expect((await fetch(`http://127.0.0.1:${address.port}/health`, { headers })).status).toBe(410);
});

it("keeps broker identity across policy refresh while fencing changes to grants and snapshots", async () => {
  const { endpoint, headers, attachment } = await fixture();
  const refreshed = { ...attachment, repositories: { ...attachment.repositories,
    public: { ...attachment.repositories.public!, policyRevision: "f".repeat(64) } } };
  expect(await (await fetch(`${endpoint}/health`, { headers })).text()).toBe(nativeWorkspaceBrokerHealth(refreshed));
  for (const changed of [{ grant: randomBytes(32).toString("base64url") }, { commit: "f".repeat(40) }]) {
    const changedScope = { ...refreshed, repositories: { ...refreshed.repositories,
      public: { ...refreshed.repositories.public!, ...changed } } };
    expect(nativeWorkspaceBrokerHealth(changedScope)).not.toBe(nativeWorkspaceBrokerHealth(refreshed));
  }
});
