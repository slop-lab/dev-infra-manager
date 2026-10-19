import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { loadPrivateJson, parseReviewerWebConfig, type ReviewerWebConfig } from "./config.js";
import { NativeGitClient } from "./native-client.js";
import { operationsConfigSchema } from "./operations.js";
const connectionSchema = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), baseUrl: z.string().url(),
  generationId: z.string().regex(/^[0-9a-f]{64}$/), reviewerId: z.string(), username: z.string(), password: z.string() }).strict();
const promoterConnectionSchema = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), endpoint: z.string().url(),
  role: z.literal("host-promoter"), hostId: z.string(), generationId: z.string(), credential: z.object({ username: z.string(), password: z.string() }).strict() }).strict();
function browserAccount(username: string, roles: readonly ("read" | "reviewer" | "operator")[]) {
  const password = randomBytes(24).toString("base64url"), salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return { password, account: { username, roles, passwordHash: `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}` } };
}
function listener(port = 9081) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("web port must be between 1 and 65535");
  return { schemaVersion: 1, host: "127.0.0.1", port, publicOrigin: `http://127.0.0.1:${port}`, session: { idleSeconds: 900, absoluteSeconds: 28800 } };
}
async function writeConfig(output: string, config: ReviewerWebConfig) {
  const configPath = resolve(output);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const handle = await open(configPath, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); } finally { await handle.close(); }
  return configPath;
}
/** Credentials stay in private files; only the new browser login is printed. */
export async function initializeReviewerWeb(input: { connection: string; project: string; repositories: readonly string[]; output: string; port?: number; operations?: string; promoter?: string }) {
  const connection = connectionSchema.parse(await loadPrivateJson(resolve(input.connection)));
  const promoter = input.promoter === undefined ? undefined : promoterConnectionSchema.parse(await loadPrivateJson(resolve(input.promoter)));
  if (promoter !== undefined && (promoter.endpoint !== connection.baseUrl || promoter.generationId !== connection.generationId)) throw new Error("promoter endpoint and generation must match the reviewer connection");
  const operations = input.operations === undefined ? undefined : operationsConfigSchema.parse(await loadPrivateJson(resolve(input.operations)));
  const browser = browserAccount("reviewer", ["read", "reviewer", ...(operations !== undefined || promoter !== undefined ? ["operator" as const] : [])]);
  const nativeGit = { baseUrl: connection.baseUrl, username: connection.username, password: connection.password,
    projectId: input.project, repositoryIds: input.repositories, reviewerId: connection.reviewerId, generationId: connection.generationId,
    ...(promoter === undefined ? {} : { promoter: { ...promoter.credential, hostId: promoter.hostId } }) };
  const config = parseReviewerWebConfig({ ...listener(input.port), nativeGit, ...(operations === undefined ? {} : { operations }), accounts: [browser.account] });
  await new NativeGitClient(nativeGit).attest();
  return { configPath: await writeConfig(input.output, config), username: browser.account.username, password: browser.password };
}
/** Ordinary Git hosts need no managed Git or CI package. Existing files are never overwritten. */
export async function initializeOperationsWeb(input: { operations: string; output: string; port?: number }) {
  const operations = operationsConfigSchema.parse(await loadPrivateJson(resolve(input.operations)));
  const browser = browserAccount("operator", ["read", "operator"]);
  const config = parseReviewerWebConfig({ ...listener(input.port), operations, accounts: [browser.account] });
  return { configPath: await writeConfig(input.output, config), username: browser.account.username, password: browser.password };
}
