import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ciQueryConnectionSchema, type CiQueryConnection } from "@slop-lab/dim-contracts-ci/connections";
import { createHash } from "node:crypto";
import { executionArtifactManifestSchema, executionArtifactIdSchema, executionArtifactLimits } from "@slop-lab/dim-contracts-execution";
import { executionSummarySchema, executionDetailSchema } from "@slop-lab/dim-contracts-ci/query";

export async function createCiQueryClient(file: string) {
  if (!isAbsolute(file)) throw new Error("CI query connection path must be absolute");
  let connection: CiQueryConnection;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600
        || stat.nlink !== 1 || stat.size > 16 * 1024) throw new Error("connection must be private");
      connection = ciQueryConnectionSchema.parse(JSON.parse(await handle.readFile("utf8")));
    } finally { await handle.close(); }
  } catch (error) { throw new Error(`cannot load private CI query connection '${file}'`, { cause: error }); }
  return createExecutionQueryClient(connection);
}
/** Private callers supply a validated connection; credentials never appear in returned data. */
export function createExecutionQueryClient(raw: CiQueryConnection) {
  return executionQueryTransport(ciQueryConnectionSchema.parse(raw));
}
/** Trusted server configuration may address a private service DNS origin over HTTP.
 * Never use this constructor for operator connection files or candidate input. */
export function createExecutionServiceQueryClient(raw: CiQueryConnection) {
  const connection = ciQueryConnectionSchema.extend({ endpoint: z.string().refine(value => {
    try { const url = new URL(value); return url.origin === value && ["http:", "https:"].includes(url.protocol)
      && !url.username && !url.password; } catch { return false; }
  }) }).parse(raw);
  return executionQueryTransport(connection);
}
function executionQueryTransport(connection: CiQueryConnection) {
  async function request(target: string, binary = false): Promise<unknown> {
    const abort = AbortSignal.timeout(30_000);
    const response = await fetch(connection.endpoint + target, { redirect: "error", signal: abort,
      headers: { "X-Dim-Generation-Id": connection.generationId, authorization: `Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}` } });
    if (response.status === 409) throw new Error("CI connection generation is stale");
    if (response.status === 404) throw new Error("CI execution or artifact is unavailable");
    if (response.status === 401) throw new Error("CI query credential was rejected");
    if (response.status !== 200 || response.headers.get("cache-control") !== "no-store"
      || response.headers.get("content-type") !== (binary ? "application/octet-stream" : "application/json")) throw new Error("CI query is unavailable");
    const maximum = binary ? executionArtifactLimits.fileBytes : 16 * 1024 * 1024;
    const reader = response.body?.getReader(); if (!reader) throw new Error("CI returned an empty response");
    const chunks: Buffer[] = []; let size = 0;
    try { for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) throw new Error("CI response exceeds its bound"); chunks.push(Buffer.from(value)); } }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks); return binary ? bytes : JSON.parse(bytes.toString("utf8"));
  }
  const id = (value: string) => z.string().uuid().parse(value);
  async function artifacts(executionId: string) { return executionArtifactManifestSchema.parse(await request(`/v1/jobs/${id(executionId)}/artifacts`)); }
  return {
    async jobs() { return z.array(executionSummarySchema).max(100).parse(await request("/v1/jobs")); },
    async detail(executionId: string) { return executionDetailSchema.parse(await request(`/v1/jobs/${id(executionId)}`)); },
    async byEvent(eventId: string) {
      z.string().regex(/^[0-9a-f]{64}$/).parse(eventId);
      return z.object({jobs:z.array(executionDetailSchema).max(32)}).strict().parse(await request(`/v1/jobs/by-event/${encodeURIComponent(eventId)}`));
    },
    artifacts,
    async artifact(executionId: string, artifactId: string): Promise<Buffer> {
      executionArtifactIdSchema.parse(artifactId);
      const manifest = await artifacts(executionId), metadata = manifest.artifacts.find(item => item.id === artifactId);
      if (!metadata) throw new Error("CI artifact is unavailable");
      const bytes = await request(`/v1/jobs/${id(executionId)}/artifacts/${artifactId}`, true) as Buffer;
      if (bytes.length !== metadata.bytes || "sha256:" + createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new Error("CI artifact integrity failure");
      return bytes;
    }
  };
}
