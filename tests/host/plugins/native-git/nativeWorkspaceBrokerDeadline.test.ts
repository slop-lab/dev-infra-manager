import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceStore, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import { NativeProjectPendingStore } from "../../../../packages/host/plugins/native-git/src/nativeProjectPendingStore.js";
import { writeNativeWorkspaceAttachment } from "../../../../packages/host/plugins/native-git/src/nativeWorkspaceAttachment.js";
import { attachmentRecord, projectRecord } from "./nativeProjectFixture.js";

const mocks = vi.hoisted(() => ({ readiness: vi.fn(), issueLease: vi.fn() }));
vi.mock("../../../../packages/host/plugins/native-git/src/nativeProjectReadinessClient.js", () => ({
  proveNativeProjectReadiness: mocks.readiness
}));
vi.mock("../../../../packages/host/plugins/native-git/src/nativeGitWorkspaceWriteIssuerClient.js", () => ({
  createNativeGitWorkspaceWriteIssuerClient: () => ({ issueWorkspaceWriteLease: mocks.issueLease })
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("allows readiness and lease proofs beyond the former five-second broker limits", async () => {
  // Given
  const fixture = await brokerFixture();
  mocks.readiness.mockImplementation(async (_connection, _project, _repositoryId, signal: AbortSignal) => {
    await delay(5_100, undefined, { signal });
    return { generationId: "a".repeat(64) };
  });
  mocks.issueLease.mockImplementation(async (_request, signal: AbortSignal) => {
    await delay(5_100, undefined, { signal });
    return { username: "workspace-write-test", password: "secret" };
  });

  // When
  const started = performance.now();
  const response = await fetch(`${fixture.endpoint}${fixture.gitPath}`, { headers: fixture.headers });
  const elapsed = performance.now() - started;

  // Then
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ready");
  expect(elapsed).toBeGreaterThanOrEqual(10_000);
  expect(elapsed).toBeLessThan(15_000);
  expect(mocks.readiness).toHaveBeenCalledTimes(1);
  expect(mocks.issueLease).toHaveBeenCalledTimes(1);
});

it("cancels a pending readiness proof when the workspace request disconnects", async () => {
  // Given
  const fixture = await brokerFixture();
  let entered: (() => void) | undefined;
  const proofEntered = new Promise<void>((resolve) => { entered = resolve; });
  let cancelled: (() => void) | undefined;
  const proofCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
  mocks.readiness.mockImplementation(async (_connection, _project, _repositoryId, signal: AbortSignal) => {
    entered?.();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      cancelled?.();
      resolve();
    }, { once: true }));
    throw signal.reason;
  });
  const controller = new AbortController();
  const request = fetch(`${fixture.endpoint}${fixture.gitPath}`, { headers: fixture.headers, signal: controller.signal });
  await proofEntered;

  // When
  controller.abort();

  // Then
  await expect(request).rejects.toThrow();
  await expect(Promise.race([
    proofCancelled,
    delay(500).then(() => Promise.reject(new Error("readiness proof was not cancelled with its request")))
  ])).resolves.toBeUndefined();
  expect(mocks.issueLease).not.toHaveBeenCalled();
});

it("retains gzip and protocol-v2 metadata while replacing only the scoped upstream credential", async () => {
  const fixture = await brokerFixture();
  mocks.readiness.mockResolvedValue({ generationId: "a".repeat(64) });
  mocks.issueLease.mockResolvedValue({ username: "workspace-write-test", password: "secret" });
  const path = fixture.gitPath.replace("/info/refs?service=git-upload-pack", "/git-upload-pack");
  const response = await fetch(`${fixture.endpoint}${path}`, { method: "POST", headers: {
    ...fixture.headers, "content-type": "application/x-git-upload-pack-request", "git-protocol": "version=2", "content-encoding": "gzip",
  }, body: gzipSync("0014command=ls-refs\n00010000") });
  expect(response.status).toBe(200); await response.body?.cancel();
  expect(fixture.received).toEqual([{ protocol: "version=2", encoding: "gzip" }]);
});

it("allows the upstream proof and Git backend to run beyond the former thirty-second proxy limit", async () => {
  // Given
  const fixture = await brokerFixture(30_200);
  mocks.readiness.mockResolvedValue({ generationId: "a".repeat(64) });
  mocks.issueLease.mockResolvedValue({ username: "workspace-write-test", password: "secret" });

  // When
  const started = performance.now();
  const response = await fetch(`${fixture.endpoint}${fixture.gitPath}`, { headers: fixture.headers });
  const elapsed = performance.now() - started;

  // Then
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ready");
  expect(elapsed).toBeGreaterThanOrEqual(30_000);
  expect(elapsed).toBeLessThan(35_000);
}, 40_000);

async function brokerFixture(upstreamDelayMilliseconds = 0): Promise<{
  readonly endpoint: string;
  readonly gitPath: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly received: { readonly protocol: string | undefined; readonly encoding: string | undefined }[];
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dim-native-broker-deadline-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const received: { protocol: string | undefined; encoding: string | undefined }[] = [];
  const upstream = createServer(async (_request, response) => {
    received.push({ protocol: typeof _request.headers["git-protocol"] === "string" ? _request.headers["git-protocol"] : undefined,
      encoding: typeof _request.headers["content-encoding"] === "string" ? _request.headers["content-encoding"] : undefined });
    await delay(upstreamDelayMilliseconds);
    response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" }).end("ready");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
  const upstreamAddress = upstream.address();
  if (upstreamAddress === null || typeof upstreamAddress === "string") throw new Error("upstream test server has no listener");
  const now = new Date().toISOString();
  const workspace: WorkspaceRecord = {
    schemaVersion: 10,
    id: randomUUID(),
    name: "development",
    source: { url: "dim://project-a", ref: "refs/heads/main", commit: "a".repeat(40) },
    runtime: "container",
    image: "unused:test",
    resources: { cpuCount: "1", memory: "1g", pidsLimit: "256" },
    git: { name: "Test", email: "test@example.invalid" },
    initialized: true,
    phase: "running",
    createdAt: now,
    updatedAt: now
  };
  await new WorkspaceStore(root).write(workspace);
  const project = projectRecord(["public"]);
  if (project.phase !== "ready") throw new Error("broker test Project is not ready");
  await new NativeProjectPendingStore(root).attach(project);
  const attachment = attachmentRecord(root, workspace.id);
  const connection = {
    schemaVersion: 1,
    hostId: "host-a",
    nativeGit: {
      transport: "loopback-http",
      endpoint: `http://127.0.0.1:${String(upstreamAddress.port)}`,
      serviceId: "native-main",
      generationId: "a".repeat(64),
      workspaceWriteIssuer: { username: "writer", password: randomBytes(32).toString("base64url") },
      rootReadIssuer: { username: "reader", password: randomBytes(32).toString("base64url") }
    }
  };
  await writeFile(attachment.connectionFile, `${JSON.stringify(connection)}\n`, { mode: 0o600 });
  await chmod(attachment.connectionFile, 0o600);
  await writeNativeWorkspaceAttachment(attachment);
  const { createNativeWorkspaceBroker } = await import("../../../../packages/host/plugins/native-git/src/nativeWorkspaceBroker.js");
  const broker = createNativeWorkspaceBroker(attachment);
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { broker.close(() => resolve()); broker.closeAllConnections(); }));
  const brokerAddress = broker.address();
  if (brokerAddress === null || typeof brokerAddress === "string") throw new Error("broker test server has no listener");
  return {
    endpoint: `http://127.0.0.1:${String(brokerAddress.port)}`,
    gitPath: "/v1/projects/project-a/repositories/public.git/info/refs?service=git-upload-pack",
    headers: { authorization: `Basic ${Buffer.from(`dim:${attachment.repositories.public?.grant ?? ""}`).toString("base64")}` }, received
  };
}
