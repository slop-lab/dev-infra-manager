import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { requestReviewApi } from "./review-client.js";

const connectionSchema = z.object({
  schemaVersion: z.literal(1),
  role: z.enum(["human-reviewer", "host-promoter"]),
  serviceId: z.literal("native-main"),
  endpoint: z.string().url(),
  generationId: z.string().regex(/^[0-9a-f]{64}$/),
  username: z.string().min(1),
  password: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict().readonly();

type Connection = z.infer<typeof connectionSchema>;

export async function runNativeGitOperatorReview(arguments_: readonly string[]): Promise<boolean> {
  const operation = arguments_[0];
  const connectionPath = arguments_[1];
  const projectId = arguments_[2];
  const repositoryId = arguments_[3];
  if (repositoryId === undefined || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(repositoryId)) return false;
  if (operation === undefined || connectionPath === undefined || projectId === undefined) return false;
  const connection = await loadConnection(connectionPath);
  const expectedRole = operation === "promote" ? "host-promoter" : "human-reviewer";
  if (connection.role !== expectedRole) throw new NativeGitOperatorReviewError(`operation requires ${expectedRole} connection`);
  await attest(connection);
  const prefix = `/v1/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}/reviews`;
  let request: Parameters<typeof requestReviewApi>[0];
  if (operation === "resolve" && arguments_.length === 5) {
    request = { baseUrl: connection.endpoint, method: "POST", path: `${prefix}/resolve`,
      credentials: connection, generationId: connection.generationId,
      body: { schemaVersion: 1, proposalRef: arguments_[4] } };
  } else if (operation === "inspect" && arguments_.length === 5) {
    request = { baseUrl: connection.endpoint, method: "GET", path: `${prefix}/${arguments_[4]}`,
      credentials: connection, generationId: connection.generationId };
  } else if (operation === "approve" && arguments_.length === 5) {
    request = { baseUrl: connection.endpoint, method: "POST", path: `${prefix}/${arguments_[4]}/approvals`,
      credentials: connection, generationId: connection.generationId, body: { requestId: randomUUID() } };
  } else if (operation === "revoke" && arguments_.length === 6) {
    request = { baseUrl: connection.endpoint, method: "POST", path: `${prefix}/${arguments_[4]}/revocations`,
      credentials: connection, generationId: connection.generationId, body: { approvalId: arguments_[5] } };
  } else if (operation === "promote" && arguments_.length === 5) {
    request = { baseUrl: connection.endpoint, method: "POST", path: `${prefix}/${arguments_[4]}/promotions`,
      credentials: connection, generationId: connection.generationId, body: { schemaVersion: 1 } };
  } else return false;
  process.stdout.write(await requestReviewApi(request));
  return true;
}

async function attest(connection: Connection): Promise<void> {
  const path = connection.role === "human-reviewer" ? "/v1/human-reviewer-identity" : "/v1/host-promoter-identity";
  const value: unknown = JSON.parse(await requestReviewApi({ baseUrl: connection.endpoint, method: "GET", path,
    credentials: connection }));
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Reflect.get(value, "schemaVersion") !== 1 || Reflect.get(value, "serviceId") !== connection.serviceId
    || Reflect.get(value, "role") !== connection.role || Reflect.get(value, "generationId") !== connection.generationId) {
    throw new NativeGitOperatorReviewError("native Git operator identity attestation failed");
  }
}

async function loadConnection(path: string): Promise<Connection> {
  if (!isAbsolute(path)) throw new NativeGitOperatorReviewError("operator connection path must be absolute");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const uid = process.geteuid?.();
    if (uid === undefined || !metadata.isFile() || metadata.uid !== uid || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600 || metadata.size < 1 || metadata.size > 64 * 1024) {
      throw new NativeGitOperatorReviewError("operator connection must be a caller-owned mode-0600 regular file");
    }
    const result = connectionSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
    if (!result.success || new URL(result.data.endpoint).origin !== result.data.endpoint) {
      throw new NativeGitOperatorReviewError("operator connection is invalid");
    }
    return result.data;
  } finally { await handle.close(); }
}

export class NativeGitOperatorReviewError extends Error {
  readonly name = "NativeGitOperatorReviewError";
}
