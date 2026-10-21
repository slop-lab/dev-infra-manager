import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { operationsConfigSchema } from "./operations.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const exactOrigin = z.string().url().superRefine((input, context) => {
  const url = new URL(input);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.origin !== input || url.username !== "" || url.password !== "") {
    context.addIssue({ code: "custom", message: "must be an exact origin" });
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    context.addIssue({ code: "custom", message: "must use HTTPS or loopback HTTP" });
  }
});
const passwordHash = z.string()
  .regex(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/)
  .superRefine((input, context) => {
    const parts = input.split("$");
    const salt = parts[4];
    const hash = parts[5];
    if (salt === undefined || hash === undefined || Buffer.from(salt, "base64").length < 16 || Buffer.from(hash, "base64").length !== 32) {
      context.addIssue({ code: "custom", message: "must contain a 16-byte salt and 32-byte hash" });
    }
  });
const configSchema = z.object({
  schemaVersion: z.literal(1),
  host: z.enum(["127.0.0.1", "::1"]),
  port: z.number().int().min(0).max(65_535),
  publicOrigin: exactOrigin,
  operations: operationsConfigSchema.optional(),
  pluginHome: z.string().refine(isAbsolute).optional(),
  plugins: z.array(z.object({ package: z.string().min(1).max(214), config: z.unknown().optional() }).strict()).max(64).default([]),
  accounts: z.array(z.object({
    username: z.string().min(1).max(256),
    passwordHash,
    roles: z.array(z.enum(["read", "operator", "reviewer"])).min(1).max(3).refine((roles) => new Set(roles).size === roles.length).readonly()
  }).strict().readonly()).min(1).max(256).readonly(),
  session: z.object({
    idleSeconds: z.number().int().positive().max(86_400),
    absoluteSeconds: z.number().int().positive().max(604_800)
  }).strict().readonly()
}).strict().superRefine((config, context) => {
  if (config.session.absoluteSeconds < config.session.idleSeconds) {
    context.addIssue({ code: "custom", path: ["session", "absoluteSeconds"], message: "must cover idle expiry" });
  }
  if (new Set(config.accounts.map(({ username }) => username)).size !== config.accounts.length) {
    context.addIssue({ code: "custom", path: ["accounts"], message: "contains duplicate usernames" });
  }
  if (config.operations === undefined && config.plugins.length === 0) {
    context.addIssue({ code: "custom", message: "configure at least one service" });
  }

}).readonly();

export type WebConfig = z.infer<typeof configSchema>;

export function parseWebConfig(input: unknown): WebConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new WebConfigError("web configuration is invalid");
  return parsed.data;
}

export async function loadWebConfig(path: string): Promise<WebConfig> {
  return parseWebConfig(await loadPrivateJson(path));
}

export async function loadPrivateJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new WebConfigError("web configuration path must be absolute");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new WebConfigError("web configuration must be a caller-owned mode-0600 regular file", { cause: error });
  }
  try {
    const stat = await handle.stat();
    const uid = process.getuid?.();
    if (uid === undefined || !stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_CONFIG_BYTES) {
      throw new WebConfigError("web configuration must be a caller-owned mode-0600 regular file");
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } catch (error) {
    if (error instanceof WebConfigError) throw error;
    throw new WebConfigError("web configuration is invalid", { cause: error });
  } finally {
    await handle.close();
  }
}

export class WebConfigError extends Error {
  readonly name = "WebConfigError";
}
