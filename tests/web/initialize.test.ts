import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("initializes an ordinary host operations account through the public CLI without a native Git connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-web-operations-init-"));
  try {
    const settings = join(root, "operations.json"), output = join(root, "web.json");
    await writeFile(settings, JSON.stringify({ hosts: [{ id: "devbox", selector: "saved-host", executable: "/trusted/dim" }] }), { mode: 0o600 });
    const cli = fileURLToPath(new URL("../../packages/web/core/src/cli.ts", import.meta.url));
    const args = ["--import", "tsx", cli, "init-operations", settings, "--output", output];
    const { stdout } = await promisify(execFile)(process.execPath, args);
    const password = /Browser password: (\S+)/.exec(stdout)?.[1]; expect(password).toBeTruthy();
    const bytes = await readFile(output, "utf8"); expect(bytes).not.toContain(password!);
    const config: unknown = JSON.parse(bytes);
    expect(config).toMatchObject({ accounts: [{ username: "operator", roles: ["read", "operator", "account-admin"] }], operations: { hosts: [{ id: "devbox" }] } });
    expect(config).not.toHaveProperty("nativeGit"); expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(promisify(execFile)(process.execPath, args)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("initializes feature-only accounts with explicit roles, validates configured plugins, and never overwrites credentials", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { initializeFeaturesWeb } = await import("../../packages/web/core/src/initialize.js");
  const root = await mkdtemp(join(tmpdir(), "dim-web-features-init-"));
  try {
    const plugin = join(root, "node_modules/fixture-feature"); await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "fixture-feature", type: "module", main: "index.js" }));
    await writeFile(join(plugin, "index.js"), `export const webPlugin={id:'fixture',title:'Fixture',description:'Test feature',operations:[],assets:{'panel.js':new URL('./panel.js',import.meta.url)},browserEntry:'panel.js',async create(config){if(config.reject)throw new Error('connection attestation failed');return {invoke:async()=>({})};}};`);
    const specification = join(root, "features.json"), output = join(root, "web.json");
    await writeFile(specification, JSON.stringify({ pluginHome: root, plugins: [{ package: "fixture-feature" }] }), { mode: 0o600 });
    const initialized = await initializeFeaturesWeb({ specification, roles: ["read", "reviewer"], output });
    const bytes = await readFile(output, "utf8");
    expect(bytes).not.toContain(initialized.password);
    expect(JSON.parse(bytes)).toMatchObject({ plugins: [{ package: "fixture-feature" }], accounts: [{ username: "operator", roles: ["read", "reviewer"] }] });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(initializeFeaturesWeb({ specification, roles: ["operator"], output })).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe(bytes);
    for (const roles of [[], ["administrator"], ["read", "read"]]) {
      await expect(initializeFeaturesWeb({ specification, roles, output: join(root, "invalid.json") })).rejects.toThrow();
    }
    await writeFile(specification, JSON.stringify({ pluginHome: root, plugins: [{ package: "fixture-feature", config: { reject: true } }] }));
    const rejected = join(root, "rejected.json");
    await expect(initializeFeaturesWeb({ specification, roles: ["read"], output: rejected })).rejects.toThrow("attest");
    await expect(stat(rejected)).rejects.toThrow();
    await chmod(specification, 0o644);
    await expect(initializeFeaturesWeb({ specification, roles: ["read"], output: rejected })).rejects.toThrow("caller-owned mode-0600");
  } finally { await rm(root, { recursive: true, force: true }); }
});
