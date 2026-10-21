import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { loadPrivateJson, parseWebConfig, type WebConfig } from "./config.js";
import { operationsConfigSchema } from "./operations.js";
function browserAccount(username: string, roles: readonly ("read" | "reviewer" | "operator")[]) {
  const password = randomBytes(24).toString("base64url"), salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return { password, account: { username, roles, passwordHash: `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}` } };
}
function listener(port = 9081) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("web port must be between 1 and 65535");
  return { schemaVersion: 1, host: "127.0.0.1", port, publicOrigin: `http://127.0.0.1:${port}`, session: { idleSeconds: 900, absoluteSeconds: 28800 } };
}
async function writeConfig(output: string, config: WebConfig) {
  const configPath = resolve(output);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const handle = await open(configPath, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); } finally { await handle.close(); }
  return configPath;
}
/** Feature selection is trusted server input; browser roles are always explicit. */
export async function initializeFeaturesWeb(input: { specification: string; roles: readonly string[]; output: string; port?: number }) {
  const specification = z.object({
    pluginHome: z.string().refine(isAbsolute).optional(),
    plugins: z.array(z.object({ package: z.string().min(1).max(214), config: z.unknown().optional() }).strict()).min(1).max(64),
    operations: operationsConfigSchema.optional()
  }).strict().parse(await loadPrivateJson(resolve(input.specification)));
  const roles = z.array(z.enum(["read", "operator", "reviewer"])).min(1).max(3)
    .refine((value) => new Set(value).size === value.length).parse(input.roles);
  const browser = browserAccount("operator", roles);
  const config = parseWebConfig({ ...listener(input.port), ...specification, accounts: [browser.account] });
  // Resolve and attest every configured feature before writing credentials or binding.
  const { loadWebPlugins } = await import("./plugins.js");
  const plugins = await loadWebPlugins(config.plugins, config.pluginHome);
  if (plugins.some((plugin) => plugin.status === "unavailable")) throw new Error("A configured Web feature could not attest its connection; check the private specification before retrying");
  return { configPath: await writeConfig(input.output, config), username: browser.account.username, password: browser.password };
}
/** Ordinary Git hosts need no managed Git or CI package. Existing files are never overwritten. */
export async function initializeOperationsWeb(input: { operations: string; output: string; port?: number }) {
  const operations = operationsConfigSchema.parse(await loadPrivateJson(resolve(input.operations)));
  const browser = browserAccount("operator", ["read", "operator"]);
  const config = parseWebConfig({ ...listener(input.port), operations, accounts: [browser.account] });
  return { configPath: await writeConfig(input.output, config), username: browser.account.username, password: browser.password };
}
