import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { NativeControlPlaneConnection } from "../../../../packages/host/plugins/native-git/src/nativeControlPlaneConnection.js";
import { proveNativeProjectReadiness } from "../../../../packages/host/plugins/native-git/src/nativeProjectReadinessClient.js";
import { projectRecord, repositoryRecord } from "./nativeProjectFixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(change: Readonly<Record<string, unknown>> = {}) {
  const repository = repositoryRecord("public"), calls: string[] = [];
  const proof = { schemaVersion: 1, serviceId: "native-main", ownerHostId: "host-a",
    projectId: "project-a", repositoryId: "public", generationId: "a".repeat(64),
    protectedRef: repository.protectedRef, commit: repository.commit, tree: repository.tree,
    policyRevision: repository.repositoryPolicy.policyRevision };
  const server = createServer(async (request, response) => {
    calls.push(`${request.method} ${request.url}`);
    request.resume();
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.method !== "POST" || request.url !== "/v1/projects/project-a/repositories/public/workspace-readiness"
      || request.headers.authorization !== `Basic ${Buffer.from("issuer:private-fixture-credential").toString("base64")}`) {
      response.writeHead(404).end("{}"); return;
    }
    response.end(JSON.stringify({ ...proof, ...change }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture listener");
  const connection: NativeControlPlaneConnection = { schemaVersion: 1, hostId: "host-a", nativeGit: {
    serviceId: "native-main", generationId: proof.generationId, transport: "loopback-http",
    endpoint: `http://127.0.0.1:${address.port}`,
    workspaceWriteIssuer: { username: "issuer", password: "private-fixture-credential" },
    rootReadIssuer: { username: "reader", password: "private-reader-credential" }
  } };
  return { calls, connection, proof };
}

it("attests live readiness in one authenticated round trip without a separate identity request", async () => {
  // Given
  const selected = await fixture();
  // When
  const proof = await proveNativeProjectReadiness(selected.connection, projectRecord(), "public", AbortSignal.timeout(5_000));
  // Then
  expect(proof).toEqual(selected.proof);
  expect(selected.calls).toEqual(["POST /v1/projects/project-a/repositories/public/workspace-readiness"]);
});

it.each([
  { ownerHostId: "foreign" }, { serviceId: "other" }, { generationId: "b".repeat(64) },
  { projectId: "other" }, { repositoryId: "private" }, { protectedRef: "refs/heads/other" },
  { commit: "b".repeat(40) }, { tree: "c".repeat(40) }, { policyRevision: "d".repeat(64) },
  { extra: true }
])("rejects mismatched live readiness without falling back to identity or cached authority: %j", async (change) => {
  // Given
  const selected = await fixture(change);
  // When / Then
  await expect(proveNativeProjectReadiness(selected.connection, projectRecord(), "public", AbortSignal.timeout(5_000)))
    .rejects.toThrow("readiness proof is invalid");
  expect(selected.calls).toEqual(["POST /v1/projects/project-a/repositories/public/workspace-readiness"]);
});
