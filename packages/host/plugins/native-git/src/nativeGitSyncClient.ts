import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createNodeNativeGitAdmissionHttpClient, type NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { UserError } from "@slop-lab/dim-host-core";
import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { hasDuplicateJsonKeys } from "./nativeControlPlaneJson.js";

export type GitSyncConnection = {
  readonly schemaVersion: 1;
  readonly serviceId: "native-main";
  readonly role: "git-sync-operator";
  readonly hostId: string;
  readonly generationId: string;
  readonly endpoint: string;
  readonly credential: { readonly username: string; readonly password: string };
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("invalid Git sync response or configuration");
  return value as Record<string, unknown>;
}
const identifier = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export async function loadGitSyncConnection(file: string): Promise<GitSyncConnection> {
  if (!isAbsolute(file)) throw new UserError("Git sync connection path must be absolute on the selected host");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      throw new UserError("Git sync connection is missing. Enable gitSync in the managed control-plane setup, deploy it, then run 'dim control-plane connect SETUP' to generate git-sync.json; use --connection for an explicit file", { cause });
    }
    throw cause;
  });
  try {
    const before = await handle.stat({ bigint: true }), uid = process.geteuid?.();
    if (uid === undefined || !before.isFile() || before.uid !== BigInt(uid) || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n || before.size < 1n || before.size > 16n * 1024n) throw new UserError("Git sync connection must be a private operator-owned regular file");
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    if (bytes.length !== Number(before.size) || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new UserError("Git sync connection changed during read");
    const text = bytes.toString("utf8");
    if (hasDuplicateJsonKeys(text)) throw new UserError("duplicate Git sync connection fields");
    const row = object(JSON.parse(text)), credential = object(row.credential);
    if (Object.keys(row).sort().join() !== "credential,endpoint,generationId,hostId,role,schemaVersion,serviceId" || row.schemaVersion !== 1 || row.serviceId !== "native-main" || row.role !== "git-sync-operator"
      || typeof row.hostId !== "string" || !identifier.test(row.hostId) || typeof row.generationId !== "string" || !/^[0-9a-f]{64}$/.test(row.generationId)
      || typeof row.endpoint !== "string" || Object.keys(credential).sort().join() !== "password,username" || typeof credential.username !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(credential.username)
      || typeof credential.password !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(credential.password)) throw new UserError("invalid Git sync operator configuration");
    const endpoint = new URL(row.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/"
      || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname)) || endpoint.origin !== row.endpoint) throw new UserError("Git sync endpoint must be an HTTPS or loopback HTTP origin");
    return { schemaVersion: 1, serviceId: "native-main", role: "git-sync-operator", hostId: row.hostId, generationId: row.generationId,
      endpoint: row.endpoint, credential: { username: credential.username, password: credential.password } };
  } finally { await handle.close(); }
}
export async function requestGitSync(input: {
  readonly connection: GitSyncConnection;
  readonly selected: NativeControlPlaneConnection;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly operation: "fetch" | "merge" | "publish";
  readonly protectedRef?: string;
  readonly signal: AbortSignal;
}, http: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()): Promise<Record<string, unknown>> {
  const { connection, selected } = input;
  if (connection.endpoint !== selected.nativeGit.endpoint || connection.generationId !== selected.nativeGit.generationId || connection.hostId !== selected.hostId
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.projectId) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.repositoryId)) throw new UserError("Git sync operator does not match the selected control plane, generation or repository");
  const authorization = `Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}`;
  async function request(method: "GET" | "POST", path: string): Promise<Record<string, unknown>> {
    const result = await http.request({ endpoint: connection.endpoint, method, path, authorization, generationId: connection.generationId,
      ...(method === "POST" ? { body: JSON.stringify({ schemaVersion: 1, ...(input.protectedRef === undefined ? {} : { protectedRef: input.protectedRef }) }) } : {}), signal: input.signal });
    if (result.contentType !== "application/json" || result.cacheControl !== "no-store" || result.body.length > 64 * 1024) throw new UserError("invalid Git sync HTTP response");
    const value = object(JSON.parse(result.body.toString("utf8")));
    if (![200, 201].includes(result.statusCode)) throw new UserError(`Git sync ${method === "GET" ? "identity check" : input.operation} rejected (HTTP ${result.statusCode})${typeof value.error === "string" ? `: ${value.error.slice(0, 1024)}` : ""}`);
    if (value.schemaVersion !== 1) throw new UserError("unsupported Git sync response");
    return value;
  }
  const identity = await request("GET", "/v1/git-sync-operator-identity");
  if (identity.serviceId !== "native-main" || identity.role !== "git-sync-operator" || identity.hostId !== connection.hostId || identity.generationId !== connection.generationId) throw new UserError("Git sync serving identity conflicts with selected operator");
  return request("POST", `/v1/projects/${input.projectId}/repositories/${input.repositoryId}/sync/${input.operation}`);
}
