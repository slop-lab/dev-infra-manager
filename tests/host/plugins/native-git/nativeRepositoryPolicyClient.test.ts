import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { NativeGitAdmissionHttpRequest, NativeGitAdmissionHttpResponse } from "@slop-lab/dim-contracts-git/http";
import { createNativeRepositoryPolicyClient } from "../../../../packages/host/plugins/native-git/src/nativeRepositoryPolicyClient.js";
import { compileNativeRepositoryBootstrapPolicy } from "../../../../packages/host/plugins/native-git/src/nativeRootBootstrapPolicy.js";
import type { NativeGitRootImporterConnection, NativeControlPlaneConnection } from "@slop-lab/dim-host-plugin-native-git";

const connection: NativeGitRootImporterConnection = { schemaVersion: 1, endpoint: "http://127.0.0.1:19181", serviceId: "native-main",
  role: "operator-root-importer", hostId: "host-a", generationId: "a".repeat(64), credential: { username: "importer", password: Buffer.alloc(32, 9).toString("base64url") } };
const selected: NativeControlPlaneConnection = { schemaVersion: 1, hostId: connection.hostId, nativeGit: { serviceId: "native-main", transport: "loopback-http",
  endpoint: connection.endpoint, generationId: connection.generationId, workspaceWriteIssuer: { username: "unused", password: "unused" }, rootReadIssuer: { username: "unused-reader", password: "unused-reader" } } };
const policy = compileNativeRepositoryBootstrapPolicy({ repositoryId: "main", protectedRef: "refs/heads/development", extensions: {} }).repositoryPolicy;
const next = compileNativeRepositoryBootstrapPolicy({ repositoryId: "main", protectedRef: policy.protectedRef, extensions: { "merge-policy": {} } }).repositoryPolicy;
function snapshot(value = policy) {
  const policyDigest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { schemaVersion: 1 as const, projectId: "dim", repositoryId: "main", protectedRef: value.protectedRef, policy: value, policyDigest,
    currentHead: { projectId: "dim", repositoryId: "main", protectedRef: value.protectedRef, commit: "b".repeat(40), tree: "c".repeat(40), sequence: 2, policyDigest } };
}
const identity = { schemaVersion: 1, serviceId: "native-main", role: "operator-root-importer", hostId: connection.hostId, generationId: connection.generationId };
const signal = () => AbortSignal.timeout(5000);
function response(body: unknown, statusCode = 200): NativeGitAdmissionHttpResponse { return { statusCode, contentType: "application/json", cacheControl: "no-store", body: Buffer.from(JSON.stringify(body)) }; }

it("attests importer identity and binds policy updates to the last observed policy digest and protected commit", async () => {
  const calls: NativeGitAdmissionHttpRequest[] = [];
  const client = createNativeRepositoryPolicyClient(connection, selected, { async request(input) {
    calls.push(input); return response(input.path.endsWith("identity") ? identity : input.method === "GET" ? snapshot() : snapshot(next));
  } });
  const before = await client.read("dim", "main", signal());
  expect(await client.update(before, next, signal())).toEqual(snapshot(next));
  expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "GET /v1/operator-root-importer-identity", "GET /v1/projects/dim/repositories/main/policy",
    "GET /v1/operator-root-importer-identity", "POST /v1/projects/dim/repositories/main/policy"
  ]);
  expect(JSON.parse(calls[3]!.body!)).toEqual({ schemaVersion: 1, expectedPolicyDigest: before.policyDigest, expectedProtectedHead: before.currentHead.commit, policy: next });
  expect(calls[3]!.generationId).toBe(connection.generationId);
});

it("rejects another control plane or stale importer identity before sending policy authority", async () => {
  let calls = 0;
  const http = { async request() { calls++; return response({ ...identity, generationId: "f".repeat(64) }); } };
  expect(() => createNativeRepositoryPolicyClient({ ...connection, endpoint: "http://127.0.0.1:19182" }, selected, http)).toThrow(/conflicts/);
  expect(calls).toBe(0);
  await expect(createNativeRepositoryPolicyClient(connection, selected, http).read("dim", "main", signal())).rejects.toThrow();
  expect(calls).toBe(1);
});

it("rejects mixed head, identity or policy digest evidence and reports CAS rejection", async () => {
  for (const invalid of [{ ...snapshot(), repositoryId: "other" }, { ...snapshot(), policyDigest: "0".repeat(64) },
    { ...snapshot(), currentHead: { ...snapshot().currentHead, policyDigest: "0".repeat(64) } }]) {
    const client = createNativeRepositoryPolicyClient(connection, selected, { async request(input) { return response(input.path.endsWith("identity") ? identity : invalid); } });
    await expect(client.read("dim", "main", signal())).rejects.toThrow(/evidence/);
  }
  const client = createNativeRepositoryPolicyClient(connection, selected, { async request(input) { return input.path.endsWith("identity") ? response(identity) : response({}, 409); } });
  await expect(client.update(snapshot(), next, signal())).rejects.toThrow(/409.*refresh/);
});
