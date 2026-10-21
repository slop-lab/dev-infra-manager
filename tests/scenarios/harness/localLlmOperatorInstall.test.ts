import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { llmOperatorArtifacts, restoreLocalLlmOperator } from "../../../scripts/install-local-llm-operator.ts";
import { removalPaths } from "../../../scripts/local-uninstall/paths.ts";
import { llmOperatorUnitPath, ownedLlmOperatorUnit } from "../../../scripts/local-uninstall/llm-operator-unit.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";

const roots: string[] = [];
const version = "0.10.0-local-test";
const manifest = { schemaVersion: 1, packages: [
  { name: "@slop-lab/dim-cli", version, file: "cli.tgz" },
  { name: "@slop-lab/dim-control-plane-plugin-llm-router", version, file: "router.tgz", requires: { "@slop-lab/dim-control-plane-core": version, "@slop-lab/dim-llm-router-client": version } },
  { name: "@slop-lab/dim-control-plane-core", version, file: "cp-core.tgz" },
  { name: "@slop-lab/dim-llm-router-client", version, file: "client.tgz", requires: { "@slop-lab/dim-contracts-operations": version } },
  { name: "@slop-lab/dim-contracts-operations", version, file: "operations.tgz" },
  { name: "@slop-lab/dim-host-core", version, file: "host-core.tgz" }
] };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(withConfig = true) {
  const root = await mkdtemp(join(tmpdir(), "dim-local-operator-install-")); roots.push(root);
  const env = { HOME: root, DIM_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), PATH: "/usr/bin" };
  const paths = removalPaths(env), configuration = join(paths.configuration, "llm/operator-service.json"), bundle = join(root, "bundle");
  await mkdir(join(paths.configuration, "llm/state"), { recursive: true, mode: 0o700 }); await mkdir(bundle);
  if (withConfig) await writeFile(configuration, JSON.stringify({ stateDirectory: join(paths.configuration, "llm/state"), existingConfiguration: true }), { mode: 0o600 });
  const retainedKey = join(paths.configuration, "llm/operator.key"), retainedData = join(paths.configuration, "llm/state/router.sqlite3");
  await writeFile(retainedKey, "retained-operator-key", { mode: 0o600 }); await writeFile(retainedData, "retained-ledger", { mode: 0o600 });
  await writeFile(join(bundle, "packages.json"), JSON.stringify(manifest));
  for (const { file } of manifest.packages) await writeFile(join(bundle, file), file);
  const calls: string[][] = [];
  const run: Command = async (file, args) => { calls.push([file, ...args]); return { status: 0, stdout: "", stderr: "" }; };
  const install = vi.fn((args: readonly string[]) => {
    const stage = args[args.indexOf("--prefix") + 1]!;
    mkdirSync(join(stage, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(stage, "node_modules/.bin/dim-control-plane-llm-router"), "operator");
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { env, paths, configuration, bundle, retainedKey, retainedData, calls, run, install };
}
it("selects the operator's exact dependency closure without the host or presentation runtime", () => {
  expect(llmOperatorArtifacts(manifest).map(({ file }) => file).sort()).toEqual(["router.tgz", "cp-core.tgz", "client.tgz", "operations.tgz"].sort());
  expect(() => llmOperatorArtifacts({ ...manifest, packages: manifest.packages.map((entry) => entry.file === "client.tgz" ? { ...entry, version: "0.9.0" } : entry) })).toThrow(/matching/);
});
it("skips optional operator restoration when no retained service configuration exists", async () => {
  const f = await fixture(false);
  expect(await restoreLocalLlmOperator(f.bundle, f.env, f.run, f.install)).toBeUndefined();
  expect(f.install).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
});
it("restores an isolated owned listener idempotently and preserves retained credentials and ledger", async () => {
  const f = await fixture(), before = await readFile(f.configuration, "utf8");
  const executable = await restoreLocalLlmOperator(f.bundle, f.env, f.run, f.install);
  expect(executable).toBe(join(f.paths.data, "llm-operator/runtime/current/node_modules/.bin/dim-control-plane-llm-router"));
  expect(await ownedLlmOperatorUnit(f.paths)).toBe(true);
  expect(f.calls).toContainEqual(["systemctl", "--user", "restart", "dim-llm-router-operator.service"]);
  expect(f.calls.at(-1)).toEqual(["systemctl", "--user", "is-active", "--quiet", "dim-llm-router-operator.service"]);
  const unit = await readFile(llmOperatorUnitPath(f.paths), "utf8");
  expect(unit).toContain('"operator-serve"'); expect(unit).toContain(f.configuration); expect(unit).not.toContain("retained-operator-key");
  await restoreLocalLlmOperator(f.bundle, f.env, f.run, f.install); expect(f.install).toHaveBeenCalledTimes(1);
  expect(await readFile(f.configuration, "utf8")).toBe(before);
  expect(await readFile(f.retainedKey, "utf8")).toBe("retained-operator-key");
  expect(await readFile(f.retainedData, "utf8")).toBe("retained-ledger");
});
it("refuses foreign units and public retained configuration before installing or restarting", async () => {
  const f = await fixture(); await chmod(f.configuration, 0o644);
  await expect(restoreLocalLlmOperator(f.bundle, f.env, f.run, f.install)).rejects.toThrow("mode-0600");
  await chmod(f.configuration, 0o600); const unit = llmOperatorUnitPath(f.paths); await mkdir(join(f.env.XDG_CONFIG_HOME, "systemd/user"), { recursive: true });
  await writeFile(unit, "[Service]\nExecStart=/foreign/service\n", { mode: 0o600 });
  await expect(restoreLocalLlmOperator(f.bundle, f.env, f.run, f.install)).rejects.toThrow("does not belong");
  expect(f.install).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
});
it("leaves the selected runtime and running unit intact when an updated bundle fails installation", async () => {
  const f = await fixture(); await restoreLocalLlmOperator(f.bundle, f.env, f.run, f.install);
  const current = join(f.paths.data, "llm-operator/runtime/current"), selected = await readlink(current), unit = await readFile(llmOperatorUnitPath(f.paths), "utf8");
  f.calls.length = 0; await writeFile(join(f.bundle, "router.tgz"), "updated-operator");
  await expect(restoreLocalLlmOperator(f.bundle, f.env, f.run, () => { throw new Error("npm failed"); })).rejects.toThrow("npm failed");
  expect(await readlink(current)).toBe(selected); expect(await readFile(llmOperatorUnitPath(f.paths), "utf8")).toBe(unit); expect(f.calls).toEqual([]);
});
it("installs a manual listener without writing a unit when user systemd is unavailable", async () => {
  const f = await fixture();
  const run: Command = async (file, args) => { f.calls.push([file, ...args]); return { status: 1, stdout: "", stderr: "unavailable" }; };
  expect(await restoreLocalLlmOperator(f.bundle, f.env, run, f.install)).toContain("llm-operator/runtime/current");
  expect(f.calls).toEqual([["systemctl", "--user", "show-environment"]]);
  await expect(readFile(llmOperatorUnitPath(f.paths))).rejects.toMatchObject({ code: "ENOENT" });
});

it("restores the full retained inference service so managed accounts reach live requests", async () => {
  const f = await fixture(), router = join(f.paths.configuration, "llm/router.json");
  await writeFile(router, JSON.stringify({ schemaVersion: 3, stateDirectory: join(f.paths.configuration, "llm/state") }), { mode: 0o600 });
  await restoreLocalLlmOperator(f.bundle, f.env, f.run, f.install);
  const unit = await readFile(llmOperatorUnitPath(f.paths), "utf8");
  expect(unit).toContain(`"serve" "${router}"`);
  expect(await ownedLlmOperatorUnit(f.paths)).toBe(true);
  expect(await readFile(f.retainedData, "utf8")).toBe("retained-ledger");
});
