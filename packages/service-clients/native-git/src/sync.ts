import { createGitServiceClient, syncResultSchema, type BoundedJsonTransport } from "@slop-lab/gs-client";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { z } from "zod";
import { loadPrivateJson } from "./private-file.js";

export { syncResultSchema } from "@slop-lab/gs-client";

export async function createSyncClient(file: string, expected: { readonly baseUrl: string; readonly generationId: string; readonly hostId?: string }) {
  const connection = z.object({
    schemaVersion: z.literal(1),
    serviceId: z.literal("native-main"),
    role: z.literal("git-sync-operator"),
    endpoint: z.string(),
    generationId: z.string().regex(/^[a-f0-9]{64}$/),
    hostId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    credential: z.object({ username: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), password: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  }).strict().parse(await loadPrivateJson(file));
  if (connection.endpoint !== expected.baseUrl || connection.generationId !== expected.generationId
    || expected.hostId !== undefined && connection.hostId !== expected.hostId) {
    throw new NativeGitSyncError("Git sync connection conflicts with selected Native Git service");
  }
  const http = createNodeNativeGitAdmissionHttpClient();
  const request = async (path: string, body?: string, responseLimitBytes = 64 * 1024): Promise<unknown> => {
    const result = await http.request({
      endpoint: connection.endpoint,
      path,
      method: body === undefined ? "GET" : "POST",
      generationId: connection.generationId,
      authorization: `Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}`,
      signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { body }),
    });
    if (![200, 201].includes(result.statusCode) || result.contentType !== "application/json" || result.cacheControl !== "no-store"
      || result.body.length > Math.min(responseLimitBytes, 64 * 1024)) {
      throw new NativeGitSyncError("Git sync operation failed; check service state and connection");
    }
    const parsed: unknown = JSON.parse(result.body.toString("utf8"));
    return parsed;
  };
  const identity = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), role: z.literal("git-sync-operator"), hostId: z.string(), generationId: z.string() }).strict()
    .parse(await request("/v1/git-sync-operator-identity"));
  if (identity.hostId !== connection.hostId || identity.generationId !== connection.generationId) {
    throw new NativeGitSyncError("Git sync identity conflicts with selected operator");
  }
  const transport: BoundedJsonTransport = {
    async request(input) {
      if (input.kind !== "sync") throw new NativeGitSyncError("Git sync transport received an unsupported request");
      const projectId = encodeURIComponent(input.selector.namespaceId);
      const repositoryId = encodeURIComponent(input.selector.repositoryId);
      const body = JSON.stringify({ schemaVersion: 1, ...(input.input.protectedRef === undefined ? {} : { protectedRef: input.input.protectedRef }) });
      return request(`/v1/projects/${projectId}/repositories/${repositoryId}/sync/${input.input.action}`, body, input.responseLimitBytes);
    },
  };
  const client = createGitServiceClient({ transport, capabilities: ["git-sync"] });
  return {
    async invoke(projectId: string, repositoryId: string, action: "fetch" | "merge" | "publish", protectedRef?: string) {
      return client.sync({ namespaceId: projectId, repositoryId, action, ...(protectedRef === undefined ? {} : { protectedRef }) });
    },
  };
}

class NativeGitSyncError extends Error {
  readonly name = "NativeGitSyncError";
}
