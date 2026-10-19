import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { NativeProjectPendingStore } from "../../../../core/packages/managed/src/nativeProjectPendingStore.js";
import { NativeProjectDraftStore } from "../../../../core/packages/managed/src/nativeProjectDraftStore.js";
import type { NativeGitRootImporterClient } from "../../../../core/packages/managed/src/nativeGitRootImporterClient.js";
import type { NativeControlPlaneConnection } from "../../../../core/packages/managed/src/nativeControlPlaneConnection.js";
import { repositoryRecord } from "./nativeProjectFixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-project-catalog-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  let wrongRepository = false;
  const generationId = "a".repeat(64);
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
    if (request.headers.authorization !== `Basic ${Buffer.from("issuer:private-issuer-credential").toString("base64")}`) { response.writeHead(401).end(); return; }
    if (request.url === "/v1/operator-workspace-write-issuer-identity") {
      response.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main", role: "operator-workspace-write-issuer", hostId: "host-a", generationId })); return;
    }
    const match = /^\/v1\/projects\/project-a\/repositories\/([a-z-]+)\/workspace-readiness$/.exec(request.url ?? "");
    if (!match) { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid fixture body");
    response.end(JSON.stringify({ ...body, schemaVersion: 1, serviceId: "native-main", ownerHostId: "host-a", projectId: "project-a",
      repositoryId: wrongRepository ? "foreign" : match[1], generationId }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture listener");
  const connection: NativeControlPlaneConnection = { schemaVersion: 1, hostId: "host-a", nativeGit: { serviceId: "native-main", generationId,
    transport: "loopback-http", endpoint: `http://127.0.0.1:${address.port}`,
    workspaceWriteIssuer: { username: "issuer", password: "private-issuer-credential" }, rootReadIssuer: { username: "reader", password: "private-reader-credential" } } };
  const store = new NativeProjectPendingStore(root);
  return { root, store, requests, connection, wrongRepository: () => { wrongRepository = true; } };
}
async function imported(root: string, repositoryId: string): Promise<NativeGitRootImporterClient> {
  const repository = repositoryRecord(repositoryId), bytes = Buffer.from(`bundle:${repositoryId}`), bundlePath = path.join(root, `${repositoryId}.bundle`);
  await writeFile(bundlePath, bytes, { mode: 0o600 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const receipt = { ...repository.importReceipt, bundleDigest: digest, bundleSize: bytes.length };
  const drafts = new NativeProjectDraftStore(root);
  await drafts.claim({ name: "acme", projectId: "project-a", repositoryId, ownerHostId: "host-a", generationId: "a".repeat(64),
    protectedRef: repository.protectedRef, expectedCommit: repository.commit, expectedTree: repository.tree, reviewPolicy: repository.reviewPolicy, bundlePath });
  await drafts.markRepositoryImported("acme", repositoryId, receipt);
  return { hostId: "host-a", generationId: "a".repeat(64), async attest() {}, async importRepository() { throw new Error("admission must not re-import"); },
    async proveRepository(projectId, selected) {
      if (projectId !== "project-a" || selected !== repositoryId) throw new Error("proof requested for wrong scope");
      return { schemaVersion: 3, servingGenerationId: "a".repeat(64), ownerHostId: "host-a", importReceipt: receipt,
        currentHead: { projectId, repositoryId, sequence: 0, protectedRef: repository.protectedRef, commit: repository.commit, tree: repository.tree, policyDigest: receipt.policyDigest } };
    } };
}
const signal = () => AbortSignal.timeout(10_000);
it("creates one private Project identity and admits independent repositories before configuring distinct defaults", async () => {
  const { root, store, connection, requests } = await fixture();
  expect((await store.create({ name: "acme", projectId: "project-a", ownerHostId: "host-a" })).phase).toBe("configuring");
  const publicImporter = await imported(root, "public"), privateImporter = await imported(root, "private");
  await store.admitRepository("acme", "public", publicImporter, connection, signal());
  const first = await readFile(path.join(root, "projects/acme.json"));
  await store.admitRepository("acme", "public", publicImporter, connection, signal());
  expect(await readFile(path.join(root, "projects/acme.json"))).toEqual(first);
  await store.admitRepository("acme", "private", privateImporter, connection, signal());
  const ready = await store.configure("acme", { configurationRepositoryId: "private", defaultWorkingRepositoryId: "public" }, connection, signal());
  expect(Object.keys(ready.repositories)).toEqual(["public", "private"]);
  expect(ready).toMatchObject({ phase: "ready", configurationRepositoryId: "private", defaultWorkingRepositoryId: "public" });
  expect(await new NativeProjectPendingStore(root).read("acme", "host-a")).toEqual(ready);
  expect(requests).toContain("POST /v1/projects/project-a/repositories/public/workspace-readiness");
  expect(requests).toContain("POST /v1/projects/project-a/repositories/private/workspace-readiness");
});
it("keeps other repository state intact when a new admission fails readiness", async () => {
  const { root, store, connection, wrongRepository } = await fixture();
  await store.create({ name: "acme", projectId: "project-a", ownerHostId: "host-a" });
  await store.admitRepository("acme", "public", await imported(root, "public"), connection, signal());
  const before = await readFile(path.join(root, "projects/acme.json"));
  const client = await imported(root, "private"); wrongRepository();
  await expect(store.admitRepository("acme", "private", client, connection, signal())).rejects.toThrow();
  expect(await readFile(path.join(root, "projects/acme.json"))).toEqual(before);
});
it("serializes concurrent imports without losing either repository", async () => {
  const { root, store, connection } = await fixture();
  await store.create({ name: "acme", projectId: "project-a", ownerHostId: "host-a" });
  const publicImporter = await imported(root, "public"), privateImporter = await imported(root, "private");
  await Promise.all([store.admitRepository("acme", "public", publicImporter, connection, signal()), store.admitRepository("acme", "private", privateImporter, connection, signal())]);
  expect(Object.keys((await store.read("acme", "host-a"))?.repositories ?? {}).sort()).toEqual(["private", "public"]);
});
it("refuses identity collisions, foreign hosts and unsafe canonical state without rewriting it", async () => {
  const { root, store } = await fixture();
  await store.create({ name: "acme", projectId: "project-a", ownerHostId: "host-a" });
  await expect(store.create({ name: "other", projectId: "project-a", ownerHostId: "host-a" })).rejects.toThrow(/already belongs/);
  await expect(store.create({ name: "acme", projectId: "another", ownerHostId: "host-a" })).rejects.toThrow(/changes its identity/);
  await expect(store.read("acme", "foreign")).rejects.toThrow(/selected host/);
  const file = path.join(root, "projects/acme.json"), before = await readFile(file);
  await chmod(file, 0o644);
  await expect(store.read("acme", "host-a")).rejects.toThrow();
  await chmod(file, 0o600); await link(file, path.join(root, "copy"));
  await expect(store.read("acme", "host-a")).rejects.toThrow();
  expect(await readFile(file)).toEqual(before);
});
