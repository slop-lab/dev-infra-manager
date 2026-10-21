import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { backendProfile, defaultLimits, type RouterConfig } from "../../../packages/control-plane/plugins/llm-router/src/config.js";
import { accountLoginStatus, closeManagedBackends, configureManagedAccountModels, createManagedAccount, ensureManagedBackend, startAccountLogin } from "../../../packages/control-plane/plugins/llm-router/src/managed-backend.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-managed-accounts-")); cleanup.push(() => rm(root, { force: true, recursive: true }));
  const source = await readFile(fileURLToPath(new URL("./managedBackendFixture.ts", import.meta.url)), "utf8");
  const binary = join(root, "backend.ts"); await writeFile(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const stateDirectory = join(root, "state"); await mkdir(stateDirectory, { mode: 0o700 });
  const config: RouterConfig = { schemaVersion: 3, stateDirectory, listen: { host: "127.0.0.1", port: 8318 }, backend: backendProfile, accounts: [], routes: [], limits: defaultLimits, hostIssuers: [], accountManagement: { backendExecutable: binary } };
  cleanup.push(() => closeManagedBackends(config)); return { config, root, binary };
}
it("runs isolated account workers with dedicated credentials and cleans up their listeners", async () => {
  const { config } = await fixture();
  const one = await createManagedAccount(config, { accountId: "one", reference: "One", provider: "openai", endpoint: "https://api.example/v1", apiKey: "private-api-key" });
  config.accounts.push(one);
  const two = await createManagedAccount(config, { accountId: "two", reference: "Two", provider: "codex" }); config.accounts.push(two);
  expect(one.endpoint).not.toBe(two.endpoint); expect(one.keyFile).not.toBe(two.keyFile);
  await Promise.all([ensureManagedBackend(config, one), ensureManagedBackend(config, one), ensureManagedBackend(config, two)]);
  const oneKey = (await readFile(one.keyFile, "utf8")).trim(), twoKey = (await readFile(two.keyFile, "utf8")).trim();
  expect((await fetch(one.endpoint + "/v1/models", { headers: { authorization: `Bearer ${twoKey}` } })).status).toBe(401);
  expect((await fetch(two.endpoint + "/v1/models", { headers: { authorization: `Bearer ${oneKey}` } })).status).toBe(401);
  await configureManagedAccountModels(config, one, [{ id: "example-model", name: "Example", api: "chat", context: 1000, output: 100 }]);
  const yaml = JSON.parse(await readFile(join(config.stateDirectory, "managed-accounts/one/config.yaml"), "utf8"));
  expect(yaml["api-keys"]["openai-compatibility"][0].models).toEqual([{ name: "example-model", alias: "example-model" }]);
  expect(yaml.routing.retry["request-retry"]).toBe(0);
  expect((await stat(one.keyFile)).mode & 0o777).toBe(0o600);
  await closeManagedBackends(config);
  await expect(fetch(one.endpoint + "/v1/models")).rejects.toThrow();
});
it("publishes only a device challenge, persists session state and keeps Codex credentials private", async () => {
  const { config } = await fixture();
  const account = await createManagedAccount(config, { accountId: "codex-one", reference: "Codex one", provider: "codex" });
  const login = await startAccountLogin(config, account);
  expect(login).toMatchObject({ accountId: account.id, status: "pending", userCode: "ABCD-12345", verificationUrl: "https://auth.openai.com/codex/device" });
  await expect.poll(async () => (await accountLoginStatus(config, account, login.sessionId)).status).toBe("connected");
  expect(JSON.stringify(await accountLoginStatus(config, account, login.sessionId))).not.toContain("fixture-private-refresh");
  await expect(startAccountLogin(config, account)).rejects.toThrow("already connected");
  await expect(accountLoginStatus(config, account, "../../config")).rejects.toThrow("invalid account login session");
  await expect(createManagedAccount(config, { accountId: account.id, reference: "Duplicate", provider: "codex" })).rejects.toThrow();
});
it("rejects unpinned or writable executables before creating an account", async () => {
  const { config, root, binary } = await fixture();
  for (const endpoint of ["file:///private", "http://169.254.169.254", "https://user:secret@example.com/v1", "https://example.com/v1?api_key=secret"]) await expect(createManagedAccount(config, { accountId: "invalid-endpoint", reference: "Invalid", provider: "openai", endpoint, apiKey: "private" })).rejects.toThrow("API endpoint");
  await expect(stat(join(root, "state/managed-accounts/invalid-endpoint"))).rejects.toThrow();
  await chmod(binary, 0o722);
  await expect(createManagedAccount(config, { accountId: "unsafe", reference: "Unsafe", provider: "codex" })).rejects.toThrow("unsafe managed");
  await chmod(binary, 0o700);
  await writeFile(binary, `#!${process.execPath}\nconsole.log('CLIProxyAPI Version: 9.0.0, Commit: fixture');\n`, { mode: 0o700 });
  await expect(createManagedAccount(config, { accountId: "unpinned", reference: "Unpinned", provider: "codex" })).rejects.toThrow("8.0.33");
  await expect(stat(join(root, "state/managed-accounts/unpinned"))).rejects.toThrow();
});
