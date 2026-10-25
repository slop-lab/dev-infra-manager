import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { nativeRepositoryPolicyRevision, parseAuthoritativeImportedRootPolicy } from "@slop-lab/dim-contracts-git";
import { afterEach, expect, it } from "vitest";
import { createNativeGitProjectAttachmentClient } from "../../../../packages/service-clients/native-git/src/project-attachment.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("allows an attachment HTTP response beyond the former ten-second client limit", async () => {
  // Given
  const generationId = "a".repeat(64);
  const policyInput = { protectedRef: "refs/heads/main", extensions: {} } as const;
  const policy = parseAuthoritativeImportedRootPolicy({
    schemaVersion: 1,
    ...policyInput,
    policyRevision: nativeRepositoryPolicyRevision(policyInput)
  });
  const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const commit = "b".repeat(40), tree = "c".repeat(40);
  const server = createServer(async (_request, response) => {
    await delay(10_200);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({
      schemaVersion: 1,
      serviceId: "native-main",
      generationId,
      ownerHostId: "host-a",
      projectId: "project-a",
      repositories: [{
        repositoryId: "root",
        importReceipt: {
          schemaVersion: 1,
          serviceId: "native-main",
          projectId: "project-a",
          repositoryId: "root",
          generationId,
          importNonce: randomUUID(),
          protectedRef: "refs/heads/main",
          expectedCommit: commit,
          policyDigest,
          bundleDigest: "d".repeat(64),
          bundleSize: 1,
          resolvedTree: tree,
          phase: "repository-imported"
        },
        importedPolicy: policy,
        effectivePolicy: policy,
        currentHead: {
          projectId: "project-a",
          repositoryId: "root",
          sequence: 0,
          protectedRef: "refs/heads/main",
          commit,
          tree,
          policyDigest
        }
      }]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("attachment client test server has no listener");
  const client = createNativeGitProjectAttachmentClient({
    endpoint: `http://127.0.0.1:${String(address.port)}`,
    generationId,
    ownerHostId: "host-a",
    credential: { username: "reader", password: "secret" }
  });

  // When
  const started = performance.now();
  const attachment = await client.inspect("project-a", AbortSignal.timeout(90_000));
  const elapsed = performance.now() - started;

  // Then
  expect(attachment.repositories.map(({ repositoryId }) => repositoryId)).toEqual(["root"]);
  expect(elapsed).toBeGreaterThanOrEqual(10_000);
  expect(elapsed).toBeLessThan(15_000);
}, 20_000);
