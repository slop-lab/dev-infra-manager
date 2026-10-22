import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { changeWebAccount, listWebAccounts, parseAccountRoles } from "../../packages/web/core/src/accounts.js";
import { loadWebConfig, MAX_CONFIG_BYTES } from "../../packages/web/core/src/config.js";
import { AccountAuthenticator } from "../../packages/web/core/src/session.js";
import { webConfig, WEB_PASSWORD, WEB_USERNAME } from "./webHarness.js";
import { runAccountCli } from "../../packages/web/core/src/account-cli.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-accounts-")); roots.push(root);
  const file = join(root, "config.json");
  await writeFile(file, JSON.stringify(webConfig({ publicOrigin: "http://127.0.0.1:9081", port: 9081 })), { mode: 0o600 });
  return { root, file };
}
async function authenticate(file: string, username: string, password: string) {
  return new AccountAuthenticator((await loadWebConfig(file)).accounts, 2, Date.now).authenticate(username, password);
}
it("changes roles without changing password, services or other accounts; resets and removes separately", async () => {
  const { file } = await fixture(), before = await loadWebConfig(file);
  const created = await changeWebAccount(file, { operation: "add", username: "reviewer", roles: ["read", "reviewer"] });
  expect(created.password).toBeTruthy();
  expect(await authenticate(file, "reviewer", created.password!)).toEqual({ kind: "accepted", accountId: "reviewer" });
  const result = await changeWebAccount(file, { operation: "set-roles", username: WEB_USERNAME, roles: ["read", "operator", "reviewer"] });
  expect(result).not.toHaveProperty("password");
  expect((await loadWebConfig(file)).accounts[0]?.passwordHash).toBe(before.accounts[0]?.passwordHash);
  expect((await loadWebConfig(file)).operations).toEqual(before.operations);
  expect(await authenticate(file, WEB_USERNAME, WEB_PASSWORD)).toEqual({ kind: "accepted", accountId: WEB_USERNAME });
  expect(JSON.stringify(await listWebAccounts(file))).not.toContain("scrypt");
  const reset = await changeWebAccount(file, { operation: "reset-password", username: "reviewer" });
  expect((await authenticate(file, "reviewer", created.password!)).kind).not.toBe("accepted");
  expect((await authenticate(file, "reviewer", reset.password!)).kind).toBe("accepted");
  expect((await listWebAccounts(file))[1]?.roles).toEqual(["read", "reviewer"]);
  await changeWebAccount(file, { operation: "remove", username: "reviewer" });
  expect(await listWebAccounts(file)).toEqual([{ username: WEB_USERNAME, roles: ["read", "operator", "reviewer"] }]);
});
it("rejects invalid mutations and a competing lock without changing the private configuration", async () => {
  const { file } = await fixture(), original = await readFile(file, "utf8");
  for (const change of [
    { operation: "remove", username: WEB_USERNAME },
    { operation: "remove", username: "absent" },
    { operation: "add", username: WEB_USERNAME, roles: ["read"] },
  ] as const) await expect(changeWebAccount(file, change)).rejects.toThrow();
  expect(() => parseAccountRoles("read,read")).toThrow();
  expect(() => parseAccountRoles("admin")).toThrow();
  await writeFile(`${file}.accounts.lock`, "other writer", { mode: 0o600 });
  await expect(changeWebAccount(file, { operation: "reset-password", username: WEB_USERNAME })).rejects.toThrow("Cannot lock");
  expect(await readFile(`${file}.accounts.lock`, "utf8")).toBe("other writer");
  expect(await readFile(file, "utf8")).toBe(original);
});
it("refuses unsafe files and never replaces symlinks or hard-linked configuration", async () => {
  const { root, file } = await fixture();
  await chmod(file, 0o644);
  await expect(listWebAccounts(file)).rejects.toThrow();
  await chmod(file, 0o600);
  const alias = join(root, "alias"); await symlink(file, alias);
  await expect(changeWebAccount(alias, { operation: "remove", username: WEB_USERNAME })).rejects.toThrow();
  await link(file, join(root, "hardlink"));
  await expect(listWebAccounts(file)).rejects.toThrow();
});
it("rejects an oversized update before replacing an otherwise loadable configuration", async () => {
  const { file } = await fixture();
  const config = { ...await loadWebConfig(file), plugins: [{ package: "example", config: { padding: "" } }] };
  config.plugins[0]!.config.padding = "x".repeat(MAX_CONFIG_BYTES - Buffer.byteLength(JSON.stringify(config)) - 20);
  const original = JSON.stringify(config); await writeFile(file, original);
  await loadWebConfig(file);
  await expect(changeWebAccount(file, { operation: "add", username: "reviewer", roles: ["read", "reviewer"] })).rejects.toThrow("64 KiB");
  expect(await readFile(file, "utf8")).toBe(original);
  expect(await listWebAccounts(file)).toHaveLength(1);
});

it("treats a username after the option delimiter literally even when it is --help", async () => {
  const { file } = await fixture();
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runAccountCli(["add", "--config", file, "--roles", "read", "--", "--help"]);
    expect((await listWebAccounts(file))[1]?.username).toBe("--help");
    await runAccountCli(["set-roles", "--config", file, "--roles", "read,reviewer", "--", "--help"]);
    expect((await listWebAccounts(file))[1]?.roles).toEqual(["read", "reviewer"]);
  } finally { output.mockRestore(); }
});
