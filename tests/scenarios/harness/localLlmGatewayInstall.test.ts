import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { restoreLocalLlmGateway } from "../../../scripts/install-local-llm-gateway.ts";
import { removalPaths } from "../../../scripts/local-uninstall/paths.ts";
import { llmGatewayUnitPath, ownedLlmGatewayUnit } from "../../../scripts/local-uninstall/llm-gateway-unit.ts";
import { createRemovalPlan, executeRemoval } from "../../../scripts/local-uninstall/plan.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-local-llm-gateway-")); roots.push(root);
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "run") }, paths = removalPaths(env);
  const directory = join(paths.configuration, "llm-host"), configuration = join(directory, "gateway.json"), bundle = join(root, "bundle");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(bundle);
  await writeFile(configuration, JSON.stringify({ schemaVersion: 1, stateDirectory: join(directory, "state"), workspaceStateRoot: paths.managed, connection: { issuerKeyFile: join(directory, "issuer.key") } }), { mode: 0o600 });
  await writeFile(join(directory, "issuer.key"), "retained-private-issuer", { mode: 0o600 });
  const version = "0.10.0", name = "@slop-lab/dim-host-plugin-llm-router";
  await writeFile(join(bundle, "packages.json"), JSON.stringify({ schemaVersion: 1, packages: [{ name: "@slop-lab/dim-cli", version, file: "cli.tgz" }, { name, version, file: "gateway.tgz" }] }));
  const calls: string[][] = [], installations: unknown[] = [];
  const run: Command = async (file, args) => { calls.push([file, ...args]); return { status: 0, stdout: file === "mise" ? "[]" : "", stderr: "" }; };
  const install = async (input: unknown) => { installations.push(input); };
  return { env, paths, configuration, bundle, calls, run, install, installations };
}
it("restores the optional gateway plugin and owned service, then removes only runtime while retaining credentials", async () => {
  const f = await fixture();
  await restoreLocalLlmGateway(f.bundle, f.env, f.run, f.install);
  expect(f.installations).toEqual([{ home: f.paths.hostPlugins, version: "0.10.0", files: [join(f.bundle, "gateway.tgz")] }]);
  expect(await ownedLlmGatewayUnit(f.paths)).toBe(true);
  expect(await readFile(llmGatewayUnitPath(f.paths), "utf8")).toContain('"--host" "local" "llm" "serve"');
  const plan = await createRemovalPlan(f.paths, f.run, f.env); expect(plan.llmGatewayUnit).toBe(true);
  await executeRemoval(plan, f.run);
  expect(f.calls).toContainEqual(["systemctl", "--user", "disable", "--now", "dim-llm-router-gateway.service"]);
  await expect(readFile(llmGatewayUnitPath(f.paths))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.paths.configuration, "llm-host/issuer.key"), "utf8")).toBe("retained-private-issuer");
});
it("rejects public configuration and foreign units before package installation", async () => {
  const f = await fixture(); await chmod(f.configuration, 0o644);
  await expect(restoreLocalLlmGateway(f.bundle, f.env, f.run, f.install)).rejects.toThrow("mode-0600");
  await chmod(f.configuration, 0o600); await mkdir(join(f.env.XDG_CONFIG_HOME, "systemd/user"), { recursive: true });
  await writeFile(llmGatewayUnitPath(f.paths), "[Service]\nExecStart=/foreign/service\n");
  await expect(restoreLocalLlmGateway(f.bundle, f.env, f.run, f.install)).rejects.toThrow("does not belong");
  expect(f.installations).toEqual([]); expect(f.calls).toEqual([]);
});
