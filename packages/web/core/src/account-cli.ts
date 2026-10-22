import { parseArgs } from "node:util";
import { changeWebAccount, defaultWebAccountConfig, listWebAccounts, parseAccountRoles } from "./accounts.js";

export const accountUsage = `dim-web account list [--config FILE] [--json]
dim-web account add USER --roles read,reviewer [--config FILE] [--json]
dim-web account set-roles USER --roles read,operator,reviewer,account-admin [--config FILE] [--json]
dim-web account reset-password USER [--config FILE] [--json]
dim-web account remove USER [--config FILE] [--json]

Run on the console server as the owner of its private configuration.
--config defaults to $XDG_CONFIG_HOME/dim/web/config.json (or ~/.config/dim/web/config.json).
Account updates preserve other settings. Restart the console and sign in again to apply them.
With install-local: systemctl --user restart dim-web.service
New passwords are generated and shown once; reset-password replaces the existing password.
`;

export async function runAccountCli(args: readonly string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help") { process.stdout.write(accountUsage); return; }
  const [operation, ...rest] = args;
  if (!["list", "add", "set-roles", "reset-password", "remove"].includes(operation!)) throw new Error("Unknown account command; run dim-web account --help");
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    config: { type: "string" }, roles: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" }
  } });
  if (values.help) { process.stdout.write(accountUsage); return; }
  const file = values.config ?? defaultWebAccountConfig();
  if (operation === "list") {
    if (positionals.length || values.roles !== undefined) throw new Error("account list accepts only --config and --json");
    const accounts = await listWebAccounts(file);
    process.stdout.write(values.json ? `${JSON.stringify({ configPath: file, accounts })}\n` : `${accounts.map((account) => `${account.username}: ${account.roles.join(", ")}`).join("\n")}\n`);
    return;
  }
  if (positionals.length !== 1) throw new Error("Choose one account username; run dim-web account --help");
  const username = positionals[0]!;
  const result = operation === "add" || operation === "set-roles"
    ? await changeWebAccount(file, { operation, username, roles: parseAccountRoles(values.roles ?? "") })
    : values.roles !== undefined ? (() => { throw new Error("--roles is only valid for add or set-roles"); })()
      : await changeWebAccount(file, { operation: operation as "reset-password" | "remove", username });
  if (values.json) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  process.stdout.write(`Account ${username}: ${operation} saved.\n`);
  if (result.password !== undefined) process.stdout.write(`Browser username: ${username}\nBrowser password: ${result.password}\n`);
  process.stdout.write("Restart the console and sign in again to apply this change.\nWith install-local: systemctl --user restart dim-web.service\n");
}
