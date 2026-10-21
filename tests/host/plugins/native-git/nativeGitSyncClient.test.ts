import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { NativeGitAdmissionHttpRequest, NativeGitAdmissionHttpResponse } from "@slop-lab/dim-contracts-git/http";
import type { NativeControlPlaneConnection } from "@slop-lab/dim-host-plugin-native-git";
import { loadGitSyncConnection, requestGitSync, type GitSyncConnection } from "../../../../packages/host/plugins/native-git/src/nativeGitSyncClient.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const connection: GitSyncConnection = { schemaVersion: 1, serviceId: "native-main", role: "git-sync-operator", hostId: "host-a", generationId: "a".repeat(64), endpoint: "http://127.0.0.1:19418", credential: { username: "sync-operator", password: Buffer.alloc(32, 5).toString("base64url") } };
const selected: NativeControlPlaneConnection = { schemaVersion: 1, hostId: connection.hostId, nativeGit: { serviceId: "native-main", generationId: connection.generationId, endpoint: connection.endpoint, transport: "loopback-http", workspaceWriteIssuer: { username: "unused-write", password: "unused" }, rootReadIssuer: { username: "unused-read", password: "unused-read" } } };
const input = { connection, selected, projectId: "project-a", repositoryId: "root", operation: "merge" as const, signal: AbortSignal.timeout(5000) };
const identity = { schemaVersion: 1, serviceId: "native-main", role: "git-sync-operator", hostId: connection.hostId, generationId: connection.generationId };
function response(body: unknown, statusCode = 200): NativeGitAdmissionHttpResponse { return { statusCode, contentType: "application/json", cacheControl: "no-store", body: Buffer.from(JSON.stringify(body)) }; }

it("loads only a private role-bound operator connection and rejects aliases or malformed destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-sync-client-")); roots.push(root);
  const file = join(root, "git-sync.json"); await writeFile(file, JSON.stringify(connection), { mode: 0o600 });
  expect(await loadGitSyncConnection(file)).toEqual(connection);
  await chmod(file, 0o644); await expect(loadGitSyncConnection(file)).rejects.toThrow(/private/); await chmod(file, 0o600);
  await symlink(file, `${file}-link`); await expect(loadGitSyncConnection(`${file}-link`)).rejects.toThrow();
  for (const endpoint of ["http://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test?credential=x"]) {
    await writeFile(file, JSON.stringify({ ...connection, endpoint })); await expect(loadGitSyncConnection(file)).rejects.toThrow(/endpoint/);
  }
  await writeFile(file, JSON.stringify(connection).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')); await expect(loadGitSyncConnection(file)).rejects.toThrow(/duplicate/);
});

it("attests the operator generation before sending a URL-free bounded sync command", async () => {
  const calls: NativeGitAdmissionHttpRequest[] = [];
  const result = await requestGitSync(input, { async request(request) { calls.push(request); return response(request.method === "GET" ? identity : { schemaVersion: 1, outcome: "proposed", proposalRef: "proposal" }); } });
  expect(result.outcome).toBe("proposed");
  expect(calls.map(({ path }) => path)).toEqual(["/v1/git-sync-operator-identity", "/v1/projects/project-a/repositories/root/sync/merge"]);
  expect(calls[1]?.body).toBe('{"schemaVersion":1}'); expect(calls[1]?.generationId).toBe(connection.generationId);
  expect(calls[1]?.authorization).toBe(`Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}`);
});

it("refuses a cross-control-plane selection before network access and stale identity before mutation", async () => {
  let calls = 0;
  const http = { async request() { calls++; return response({ ...identity, generationId: "b".repeat(64) }); } };
  await expect(requestGitSync({ ...input, connection: { ...connection, hostId: "other" } }, http)).rejects.toThrow(/selected/); expect(calls).toBe(0);
  await expect(requestGitSync(input, http)).rejects.toThrow(/identity/); expect(calls).toBe(1);
});

it("preserves structured conflicts and reports rejected publication without credential disclosure", async () => {
  const conflict = { schemaVersion: 1, outcome: "conflict", expectedProtectedHead: "a".repeat(40) };
  expect(await requestGitSync(input, { async request(request) { return response(request.method === "GET" ? identity : conflict); } })).toEqual(conflict);
  await expect(requestGitSync({ ...input, operation: "publish" }, { async request(request) { return request.method === "GET" ? response(identity) : response({ error: "remote diverged" }, 409); } })).rejects.toThrow(/remote diverged/);
});
