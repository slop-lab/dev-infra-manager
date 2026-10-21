import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWebServerFromConfigFile } from "../../packages/web/core/src/index.js";
import { webConfig } from "./webHarness.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function file(config: unknown, mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), "dim-web-config-")); roots.push(root);
  const path = join(root, "config.json"); await writeFile(path, JSON.stringify(config), { mode }); return path;
}
const config = () => webConfig({ publicOrigin: "http://127.0.0.1:9081", port: 0 });
it("rejects a public or symbolic-link configuration before starting any service", async () => {
  const path = await file(config(), 0o644), linked = `${path}.link`;
  await symlink(path, linked);
  await expect(createWebServerFromConfigFile(path)).rejects.toThrow("caller-owned mode-0600 regular file");
  await chmod(path, 0o600);
  await expect(createWebServerFromConfigFile(linked)).rejects.toThrow("caller-owned mode-0600 regular file");
});
it("rejects missing/unknown authority, remote cleartext origins, and obsolete feature configuration", async () => {
  const base = config(), account = Array.isArray(base.accounts) ? base.accounts[0] : undefined;
  for (const candidate of [
    { ...base, accounts: [{ ...account, roles: [] }] }, { ...base, accounts: [{ ...account, roles: ["administrator"] }] },
    { ...base, publicOrigin: "http://remote.example:9081" }, { ...base, nativeGit: {} },
    { ...base, operations: { hosts: [], ci: { queryConnection: "/private.json" } } },
    { ...base, operations: { hosts: [], execution: { operatorConnection: "/private.json" } } }
  ]) await expect(createWebServerFromConfigFile(await file(candidate))).rejects.toThrow("configuration is invalid");
});
