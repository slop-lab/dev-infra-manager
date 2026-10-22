import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseAuthoritativeImportedRootPolicy, type NativeImportedRootPolicy } from "@slop-lab/dim-contracts-git";
import { createNodeNativeGitAdmissionHttpClient, type NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { UserError } from "@slop-lab/dim-host-core";
import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { createNativeGitRootImporterClient } from "./nativeGitRootImporterClient.js";
import type { NativeGitRootImporterConnection } from "./nativeGitRootImporterConnection.js";
import type { NativeGitCurrentRootHead } from "./nativeGitRootImportProof.js";

export interface NativeRepositoryPolicySnapshot {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly protectedRef: string;
  readonly currentHead: NativeGitCurrentRootHead;
  readonly policy: NativeImportedRootPolicy;
  readonly policyDigest: string;
}

/** Existing import authority can explicitly revise policy; workspace credentials cannot. */
export function createNativeRepositoryPolicyClient(connection: NativeGitRootImporterConnection, selected: NativeControlPlaneConnection,
  http: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()) {
  if (connection.endpoint !== selected.nativeGit.endpoint || connection.generationId !== selected.nativeGit.generationId
    || connection.hostId !== selected.hostId) throw new UserError("Repository policy connection conflicts with the selected control plane");
  const importer = createNativeGitRootImporterClient(connection, http);
  async function request(projectId: string, repositoryId: string, signal: AbortSignal, body?: unknown): Promise<NativeRepositoryPolicySnapshot> {
    for (const id of [projectId, repositoryId]) if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) throw new UserError("Invalid policy repository identity");
    await importer.attest(signal);
    const response = await http.request({ endpoint: connection.endpoint, path: `/v1/projects/${projectId}/repositories/${repositoryId}/policy`,
      method: body === undefined ? "GET" : "POST", generationId: connection.generationId,
      authorization: `Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}`,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    if (response.contentType !== "application/json" || response.cacheControl !== "no-store" || response.body.length > 128 * 1024) throw new UserError("Invalid repository policy response");
    if (response.statusCode !== 200) throw new UserError(`Repository policy ${body === undefined ? "read" : "update"} rejected (HTTP ${response.statusCode}); refresh the policy and protected head before retrying`);
    return parsePolicySnapshot(JSON.parse(response.body.toString("utf8")), projectId, repositoryId);
  }
  return {
    read: (projectId: string, repositoryId: string, signal: AbortSignal) => request(projectId, repositoryId, signal),
    async update(previous: NativeRepositoryPolicySnapshot, policy: NativeImportedRootPolicy, signal: AbortSignal) {
      const next = await request(previous.projectId, previous.repositoryId, signal, { schemaVersion: 1,
        expectedPolicyDigest: previous.policyDigest, expectedProtectedHead: previous.currentHead.commit, policy });
      if (!isDeepStrictEqual(next.policy, policy) || next.currentHead.commit !== previous.currentHead.commit) throw new UserError("Repository policy update returned conflicting evidence");
      return next;
    }
  };
}

function parsePolicySnapshot(value: unknown, projectId: string, repositoryId: string): NativeRepositoryPolicySnapshot {
  if (!value || typeof value !== "object") throw new UserError("Invalid repository policy evidence");
  const row = value as Record<string, unknown>, head = row.currentHead as Record<string, unknown> | undefined;
  const policy = parseAuthoritativeImportedRootPolicy(row.policy);
  const digest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  if (row.schemaVersion !== 1 || row.projectId !== projectId || row.repositoryId !== repositoryId
    || row.protectedRef !== policy.protectedRef || row.policyDigest !== digest || !head
    || head.projectId !== projectId || head.repositoryId !== repositoryId || head.protectedRef !== policy.protectedRef
    || head.policyDigest !== digest || typeof head.sequence !== "number" || !Number.isSafeInteger(head.sequence) || head.sequence < 0
    || typeof head.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head.commit)
    || typeof head.tree !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head.tree) || head.tree.length !== head.commit.length) {
    throw new UserError("Repository policy evidence conflicts with its identity or digest");
  }
  return { schemaVersion: 1, projectId, repositoryId, protectedRef: policy.protectedRef, policy, policyDigest: digest,
    currentHead: { projectId, repositoryId, protectedRef: policy.protectedRef, sequence: head.sequence, commit: head.commit, tree: head.tree, policyDigest: digest } };
}
