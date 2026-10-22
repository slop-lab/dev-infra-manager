import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MAX_CONFIG_BYTES, accountRolesSchema, loadWebConfig, parseWebConfig, type WebConfig, type AccountRole } from "./config.js";
import { browserAccount } from "./initialize.js";

export class AccountChangeError extends Error {}
export function parseAccountRoles(input: string) {
  const result = accountRolesSchema.safeParse(input.split(",").map((role) => role.trim()));
  if (!result.success) throw new Error("Choose distinct roles from read, operator, reviewer, account-admin");
  return result.data;
}
export function defaultWebAccountConfig(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "dim/web/config.json");
}
export type AccountChange =
  | { readonly operation: "add" | "set-roles"; readonly username: string; readonly roles: readonly AccountRole[] }
  | { readonly operation: "reset-password" | "remove"; readonly username: string };
export async function listWebAccounts(file: string) {
  return publicAccounts(await loadWebConfig(resolve(file)));
}
function publicAccounts(config: WebConfig) {
  return config.accounts.map(({ username, roles }) => ({ username, roles }));
}

/** Trusted local callers, or an authorized HTTP administrator, update the same private state. */
export async function changeWebAccount(file: string, input: AccountChange, options: {
  readonly authorize?: (config: WebConfig) => void;
  readonly committed?: (config: WebConfig) => void;
} = {}) {
  file = resolve(file);
  if (typeof input.username !== "string" || input.username.length < 1 || input.username.length > 256 || /[\x00-\x1f\x7f]/.test(input.username)) throw new AccountChangeError("Account username must contain 1–256 printable characters");
  if ("roles" in input) accountRolesSchema.parse(input.roles);
  // Validate the file before creating a lock beside it. Never initialize or adopt unknown state.
  await loadWebConfig(file);
  const lockPath = `${file}.accounts.lock`;
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (cause) { throw new AccountChangeError("Account settings are busy. Refresh accounts and retry after the other update completes", { cause }); }
  let temporary: string | undefined;
  try {
    const previous = await loadWebConfig(file);
    options.authorize?.(previous);
    const existing = previous.accounts.find(({ username }) => username === input.username);
    if (input.operation === "add" && existing) throw new AccountChangeError("Account already exists; use set-roles or reset-password");
    if (input.operation !== "add" && !existing) throw new AccountChangeError("Account does not exist; use account list to inspect available usernames");
    let password: string | undefined;
    let accounts = [...previous.accounts];
    if (input.operation === "add") {
      const created = browserAccount(input.username, input.roles); password = created.password; accounts.push(created.account);
    } else if (input.operation === "remove") {
      if (accounts.length === 1) throw new AccountChangeError("Cannot remove the last browser account");
      accounts = accounts.filter(({ username }) => username !== input.username);
    } else {
      accounts = accounts.map((account) => {
        if (account.username !== input.username) return account;
        if (input.operation === "set-roles") return { ...account, roles: input.roles };
        const replacement = browserAccount(account.username, account.roles); password = replacement.password;
        return replacement.account;
      });
    }
    if (previous.accounts.some((account) => account.roles.includes("account-admin"))
      && !accounts.some((account) => account.roles.includes("account-admin"))) throw new AccountChangeError("Cannot remove or demote the last account administrator; create another administrator first");
    const updated = parseWebConfig({ ...previous, accounts });
    const serialized = `${JSON.stringify(updated, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) throw new AccountChangeError("Updated account configuration exceeds the 64 KiB limit; no changes saved");
    temporary = join(dirname(file), `.dim-web-accounts-${randomUUID()}.tmp`);
    const stage = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await stage.writeFile(serialized); await stage.sync(); } finally { await stage.close(); }
    if (JSON.stringify(await loadWebConfig(file)) !== JSON.stringify(previous)) throw new AccountChangeError("Configuration changed during account update; retry using the current configuration");
    await rename(temporary, file); temporary = undefined;
    options.committed?.(updated);
    return { configPath: file, username: input.username, accounts: publicAccounts(updated), ...(password === undefined ? {} : { password }), restartRequired: true as const };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await lock.close(); await unlink(lockPath);
  }
}
