import { z } from "zod";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { loadPrivateJson } from "./private-file.js";

const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const upstream = { upstreamRef: z.string().startsWith("refs/remotes/upstream/").max(1024), upstreamCommit: objectId, expectedProtectedHead: objectId };
export const syncResultSchema = z.discriminatedUnion("outcome", [
  z.object({ schemaVersion: z.literal(1), outcome: z.literal("published"), sourceCommit: objectId, targetRef: z.string().startsWith("refs/heads/").max(1024) }).strict(),
  ...["fetched", "unchanged", "conflict"].map((outcome) => z.object({ schemaVersion: z.literal(1), outcome: z.literal(outcome), ...upstream }).strict()),
  z.object({ schemaVersion: z.literal(1), outcome: z.literal("proposed"), ...upstream, proposalRef: z.string().startsWith("refs/").max(1024), candidateCommit: objectId }).strict()
]);
export async function createSyncClient(file: string, expected: { baseUrl: string; generationId: string; hostId?: string }) {
  const connection = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), role: z.literal("git-sync-operator"),
    endpoint: z.string(), generationId: z.string().regex(/^[a-f0-9]{64}$/), hostId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    credential: z.object({ username: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), password: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict() }).strict().parse(await loadPrivateJson(file));
  if (connection.endpoint !== expected.baseUrl || connection.generationId !== expected.generationId || expected.hostId && connection.hostId !== expected.hostId) throw new Error("Git sync connection conflicts with selected Native Git service");
  const http = createNodeNativeGitAdmissionHttpClient();
  async function request(path: string, mutation = false, protectedRef?: string) {
    const result = await http.request({ endpoint: connection.endpoint, path, method: mutation ? "POST" : "GET", generationId: connection.generationId,
      authorization: `Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}`,
      signal: AbortSignal.timeout(30_000), ...(mutation ? { body: JSON.stringify({ schemaVersion: 1, ...(protectedRef === undefined ? {} : { protectedRef }) }) } : {}) });
    if (![200, 201].includes(result.statusCode) || result.contentType !== "application/json" || result.cacheControl !== "no-store" || result.body.length > 64 * 1024) throw new Error("Git sync operation failed; check service state and connection");
    return JSON.parse(result.body.toString("utf8")) as unknown;
  }
  const identity = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), role: z.literal("git-sync-operator"), hostId: z.string(), generationId: z.string() }).strict().parse(await request("/v1/git-sync-operator-identity"));
  if (identity.hostId !== connection.hostId || identity.generationId !== connection.generationId) throw new Error("Git sync identity conflicts with selected operator");
  return {
    async invoke(projectId: string, repositoryId: string, operation: "fetch" | "merge" | "publish", protectedRef?: string) {
      return syncResultSchema.parse(await request(`/v1/projects/${projectId}/repositories/${repositoryId}/sync/${operation}`, true, protectedRef));
    }
  };
}
