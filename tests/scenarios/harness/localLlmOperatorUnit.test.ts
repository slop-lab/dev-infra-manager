import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ownedLlmOperatorUnit, llmOperatorUnitPath } from "../../../scripts/local-uninstall/llm-operator-unit.ts";
import { removalPaths } from "../../../scripts/local-uninstall/paths.ts";
import { createRemovalPlan, executeRemoval } from "../../../scripts/local-uninstall/plan.ts";
import { showRemovalPlan } from "../../../scripts/local-uninstall/presentation.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "dim operator%unit-")); roots.push(home);
  const env = { HOME: home, XDG_RUNTIME_DIR: join(home, "run") }, paths = removalPaths(env);
  const configuration = join(paths.configuration, "llm/operator-service.json"), key = join(paths.configuration, "llm/operator.key");
  const executable = join(paths.data, "llm-operator/runtime/current/node_modules/.bin/dim-control-plane-llm-router");
  await mkdir(dirname(configuration), { recursive: true, mode: 0o700 });
  await writeFile(configuration, JSON.stringify({ note: "private operator settings", operators: [{ id: "operator", keyFile: key, role: "operator" }] }), { mode: 0o600 });
  await writeFile(key, "private-operator-authentication", { mode: 0o600 });
  await mkdir(dirname(executable), { recursive: true, mode: 0o700 });
  await writeFile(executable, "// owned disposable runtime\n");
  await mkdir(dirname(paths.unit), { recursive: true, mode: 0o700 });
  const args = ["/absolute/node", executable, "operator-serve", configuration];
  const unit = (tokens = args, description = "DIM LLM router operator API") => `[Unit]\nDescription=${description}\n[Service]\nExecStart=:${tokens.map((arg) => JSON.stringify(arg.replaceAll("%", "%%"))).join(" ")}\n[Install]\nWantedBy=default.target\n`;
  const writeUnit = async (text = unit()) => writeFile(llmOperatorUnitPath(paths), text);
  const calls: string[][] = [];
  const run: Command = async (file, argv) => { calls.push([file, ...argv]); return { status: 0, stdout: file === "mise" ? "[]" : "", stderr: "" }; };
  return { paths, env, configuration, key, executable, args, unit, writeUnit, calls, run };
}
it("includes the exact operator unit in dry plans and disables/removes its runtime while retaining authentication", async () => {
  const f = await fixture(); await f.writeUnit();
  expect(await ownedLlmOperatorUnit(f.paths)).toBe(true);
  const plan = await createRemovalPlan(f.paths, f.run, f.env), logs = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(plan.llmOperatorUnit).toBe(true);
  expect(plan.persistent.files).toContain(dirname(f.configuration));
  showRemovalPlan(plan);
  expect(logs.mock.calls.flat().join("\n")).toContain(`LLM router operator unit: ${llmOperatorUnitPath(f.paths)}`);
  expect(f.calls.some((args) => args.includes("disable"))).toBe(false);
  const before = await readFile(f.configuration, "utf8");
  await executeRemoval(plan, f.run);
  expect(f.calls).toContainEqual(["systemctl", "--user", "disable", "--now", "dim-llm-router-operator.service"]);
  expect(f.calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
  await expect(readFile(llmOperatorUnitPath(f.paths))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(f.executable)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.configuration, "utf8")).toBe(before);
  expect(await readFile(f.key, "utf8")).toBe("private-operator-authentication");
});
it("refuses foreign runtime, inference command, configuration and description without touching their unit", async () => {
  const f = await fixture();
  const variants = [f.unit([f.args[0]!, "/foreign/runtime", "operator-serve", f.configuration]), f.unit([f.args[0]!, f.executable, "serve", f.configuration]), f.unit([f.args[0]!, f.executable, "operator-serve", "/foreign/config.json"]), f.unit(f.args, "Another service")];
  for (const unit of variants) {
    await f.writeUnit(unit);
    await expect(createRemovalPlan(f.paths, f.run, f.env)).rejects.toThrow("does not belong");
    expect(await readFile(llmOperatorUnitPath(f.paths), "utf8")).toBe(unit);
  }
  expect(f.calls.some((args) => args.includes("disable"))).toBe(false);
});
it("rejects redirected executables and insecure private configuration", async () => {
  const f = await fixture(); await f.writeUnit();
  await chmod(f.configuration, 0o644);
  await expect(ownedLlmOperatorUnit(f.paths)).rejects.toThrow("unsafe DIM LLM router operator configuration");
  await chmod(f.configuration, 0o600);
  await rm(f.executable); const foreign = join(f.paths.home, "foreign.js"); await writeFile(foreign, "// foreign\n"); await symlink(foreign, f.executable);
  await expect(ownedLlmOperatorUnit(f.paths)).rejects.toThrow("does not belong");
});
it("rechecks unit ownership before executing a prepared removal plan", async () => {
  const f = await fixture(); await f.writeUnit();
  const plan = await createRemovalPlan(f.paths, f.run, f.env);
  await f.writeUnit(f.unit([f.args[0]!, "/foreign/runtime", "operator-serve", f.configuration]));
  await expect(executeRemoval(plan, f.run)).rejects.toThrow("does not belong");
  expect(f.calls.some((args) => args.includes("disable"))).toBe(false);
  expect(await readFile(f.key, "utf8")).toBe("private-operator-authentication");
});
it("recognizes absent units and permits removal of an exact owned unit with missing runtime/config", async () => {
  const f = await fixture(); expect(await ownedLlmOperatorUnit(f.paths)).toBe(false);
  await f.writeUnit(); await rm(f.executable); await rm(f.configuration);
  expect(await ownedLlmOperatorUnit(f.paths)).toBe(true);
});
