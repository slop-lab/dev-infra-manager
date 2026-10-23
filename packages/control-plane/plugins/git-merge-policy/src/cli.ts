#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const generation = z.string().regex(/^[0-9a-f]{64}$/);
const connectionSchema = z.object({ schemaVersion: z.literal(1), role: z.literal("host-promoter"),
  serviceId: z.literal("native-main"), hostId: identifier, generationId: generation,
  endpoint: z.string().url().refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  }), credential: z.object({ username: z.string().min(1), password: z.string().min(32) }).strict()
}).strict();

export async function runMergePolicyCli(arguments_: readonly string[]): Promise<string> {
  const [, connectionPath, projectId, repositoryId, reviewId] = z.tuple([
    z.literal("promote"), z.string().refine(isAbsolute), identifier, identifier, generation
  ]).parse(arguments_);
  const handle = await open(connectionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const connection = await (async () => {
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || metadata.nlink !== 1
        || (metadata.mode & 0o777) !== 0o600 || metadata.size < 1 || metadata.size > 64 * 1024) {
        throw new Error("promoter connection must be a caller-owned mode-0600 regular file");
      }
      const contents = Buffer.alloc(64 * 1024 + 1);
      const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
      if (bytesRead > 64 * 1024) throw new Error("promoter connection exceeds limit");
      return connectionSchema.parse(JSON.parse(contents.toString("utf8", 0, bytesRead)));
    } finally { await handle.close(); }
  })();
  const client = createNodeNativeGitAdmissionHttpClient();
  const authorization = `Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}`;
  const request = async (method: "GET" | "POST", path: string, body?: object) => {
    const response = await client.request({ method, path, endpoint: connection.endpoint, authorization,
      generationId: connection.generationId, signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.statusCode < 200 || response.statusCode >= 300 || response.contentType !== "application/json") {
      throw new Error(`merge policy request failed (${response.statusCode})`);
    }
    return response.body.toString("utf8");
  };
  const identity = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"),
    role: z.literal("host-promoter"), hostId: identifier, generationId: generation }).strict()
    .parse(JSON.parse(await request("GET", "/v1/host-promoter-identity")));
  if (identity.hostId !== connection.hostId || identity.generationId !== connection.generationId) throw new Error("promoter identity or generation conflicts with connection");
  return request("POST", `/v1/projects/${projectId}/repositories/${repositoryId}/reviews/${reviewId}/promotions`, { schemaVersion: 1 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMergePolicyCli(process.argv.slice(2)).then((result) => process.stdout.write(`${result}\n`)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
  });
}
