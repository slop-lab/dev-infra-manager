import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { loadPrivateJson, parseReviewerWebConfig } from "./config.js";
import { NativeGitClient } from "./native-client.js";

const connectionSchema = z.object({
  schemaVersion: z.literal(1), serviceId: z.literal("native-main"), baseUrl: z.string().url(),
  generationId: z.string().regex(/^[0-9a-f]{64}$/), reviewerId: z.string(), username: z.string(), password: z.string()
}).strict();

/** Credentials stay in private files; only the new browser login is printed. */
export async function initializeReviewerWeb(input: {
  connection: string; project: string; output: string; port?: number;
}): Promise<{ configPath: string; username: string; password: string }> {
  const connection = connectionSchema.parse(await loadPrivateJson(resolve(input.connection)));
  const password = randomBytes(24).toString("base64url");
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const port = input.port ?? 9081;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("reviewer web port must be between 1 and 65535");
  const config = parseReviewerWebConfig({
    schemaVersion: 1, host: "127.0.0.1", port, publicOrigin: `http://127.0.0.1:${port}`,
    reviewerAccountId: "reviewer",
    nativeGit: { baseUrl: connection.baseUrl, username: connection.username, password: connection.password,
      projectId: input.project, reviewerId: connection.reviewerId, generationId: connection.generationId },
    accounts: [{ username: "reviewer", passwordHash: `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}` }],
    session: { idleSeconds: 900, absoluteSeconds: 28800 }
  });
  await new NativeGitClient(config.nativeGit).attest();
  const configPath = resolve(input.output);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const handle = await open(configPath, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); }
  finally { await handle.close(); }
  return { configPath, username: "reviewer", password };
}
