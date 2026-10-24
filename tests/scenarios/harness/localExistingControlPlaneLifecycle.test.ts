import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { removalPaths } from "../../../scripts/local-uninstall/paths.ts";
import { createRemovalPlan, executeRemoval } from "../../../scripts/local-uninstall/plan.ts";
import { existingControlPlaneUnitPath } from "../../../scripts/local-uninstall/existing-control-plane-unit.ts";
import { readExistingControlPlaneSelection } from "../../../scripts/install-local-existing-control-plane.ts";
import { existingSshTransport } from "../../../scripts/local-control-plane/existing-ssh.ts";
import type { ExistingConnections } from "../../../scripts/local-control-plane/existing-connections.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "dim-existing-cp-lifecycle-")); roots.push(home);
  const env = { HOME: home, XDG_RUNTIME_DIR: join(home, "run") }, paths = removalPaths(env);
  const selected = join(paths.configuration, "existing-control-plane"), connections = join(selected, "connections-test");
  await mkdir(connections, { recursive: true, mode: 0o700 });
  const selection = { schemaVersion: 1, connections, ssh: "dim-control" };
  await writeFile(join(selected, "selection.json"), JSON.stringify(selection), { mode: 0o600 });
  await writeFile(join(connections, "host.json"), JSON.stringify({ credential: "private role material" }), { mode: 0o600 });
  await mkdir(dirname(paths.unit), { recursive: true, mode: 0o700 });
  const unit = existingControlPlaneUnitPath(paths);
  const calls: Array<readonly string[]> = [];
  const run: Command = async (file, args) => {
    calls.push([file, ...args]);
    return { status: 0, stdout: file === "mise" ? "[]" : "", stderr: "" };
  };
  // Exercise the actual producer so changes to SSH/systemd format are covered.
  const bundle: ExistingConnections = { files: {}, hostId: "host-one", generationId: "generation-one", identities: [],
    nativeEndpoint: "http://127.0.0.1:43181", executionEndpoint: "http://127.0.0.1:43182" };
  const runtimeDirectory = join(home, "run/dim-existing-control-plane");
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await existingSshTransport(env, run, { runtimeDirectory }).persist("dim-control", bundle);
  const unitText = await readFile(unit, "utf8");
  calls.length = 0;
  return { env, paths, selected, connections, selection, unit, unitText, calls, run };
}

it("stops/removes the owned SSH tunnel while preserving saved remote mode and credentials for reinstall", async () => {
  const f = await fixture();
  await mkdir(join(f.paths.data, "discarded-runtime"), { recursive: true });
  const plan = await createRemovalPlan(f.paths, f.run, f.env);
  expect(plan.existingControlPlaneUnit).toBe(true);
  expect(plan.persistent.files).toContain(f.selected);
  await executeRemoval(plan, f.run);

  expect(f.calls).toContainEqual(["systemctl", "--user", "disable", "--now", "dim-existing-control-plane-tunnel.service"]);
  await expect(stat(f.unit)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(f.paths.data, "discarded-runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readExistingControlPlaneSelection(f.env)).toEqual(f.selection);
  expect(await readFile(join(f.connections, "host.json"), "utf8")).toContain("private role material");
  expect((await stat(join(f.connections, "host.json"))).mode & 0o777).toBe(0o600);
  const second = await createRemovalPlan(f.paths, f.run, f.env);
  expect(second.existingControlPlaneUnit).toBe(false);
  await executeRemoval(second, f.run);
  expect(await readExistingControlPlaneSelection(f.env)).toEqual(f.selection);
});

it("refuses a foreign tunnel unit before stopping or deleting anything", async () => {
  const f = await fixture();
  await writeFile(f.unit, "[Service]\nExecStart=/foreign/service\n", { mode: 0o600 });
  await expect(createRemovalPlan(f.paths, f.run, f.env)).rejects.toThrow("does not belong");
  expect(f.calls).toEqual([]);
  expect(await readFile(f.unit, "utf8")).toContain("/foreign/service");
  expect(await readExistingControlPlaneSelection(f.env)).toEqual(f.selection);
});

it("rejects unsafe unit permissions and a substituted executable despite the ownership header", async () => {
  const f = await fixture();
  await chmod(f.unit, 0o644);
  await expect(createRemovalPlan(f.paths, f.run, f.env)).rejects.toThrow("unsafe DIM existing control-plane SSH unit");
  await chmod(f.unit, 0o600);
  await writeFile(f.unit, f.unitText.replace("ExecStart=/usr/bin/ssh", "ExecStart=/foreign/ssh"));
  await expect(createRemovalPlan(f.paths, f.run, f.env)).rejects.toThrow("does not belong");
  expect(f.calls).toEqual([]);
});
