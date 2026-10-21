import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ownedControllerUnit } from "../../../scripts/local-uninstall/controller-unit.ts";
import { planDocker, removeDocker } from "../../../scripts/local-uninstall/docker.ts";
import { removalPaths, validatePaths } from "../../../scripts/local-uninstall/paths.ts";
import { createRemovalPlan, executeRemoval } from "../../../scripts/local-uninstall/plan.ts";
import { planMise, removeMise, installerTool } from "../../../scripts/local-uninstall/mise.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";
import type { DockerClaim, DockerKind } from "../../../scripts/local-uninstall/types.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
function dockerFixture(claims: readonly DockerClaim[]) {
  const resources = new Map(claims.map((claim) => [`${claim.kind}:${claim.name}`, { Name: claim.kind === "container" ? `/${claim.name}` : claim.name, Id: `id-${claim.name}`, Created: "2026-01-01T00:00:00Z", CreatedAt: "2026-01-01T00:00:00Z", Labels: { ...claim.labels }, Config: { Labels: { ...claim.labels } }, Mounts: [] }]));
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const foreign = new Map<string, string[]>(); let failRemoval: string | undefined;
  const run: Command = async (file, args) => {
    calls.push({ file, args });
    if (file === "mise") return ok("[]");
    if (file !== "docker") throw new Error(`unexpected command ${file}`);
    const kind = args[0] as DockerKind;
    if (args[1] === "ls") {
      if (args.includes("--filter")) return ok((foreign.get(args[args.indexOf("--filter") + 1]!) ?? []).join("\n"));
      return ok([...resources.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([key]) => JSON.stringify({ Name: key.slice(kind.length + 1), Names: key.slice(kind.length + 1) })).join("\n"));
    }
    if (args[1] === "inspect") return ok(JSON.stringify([resources.get(`${kind}:${args[2]}`)]));
    if (args[1] === "rm") {
      if (kind === failRemoval) return { status: 1, stdout: "", stderr: "injected removal failure" };
      const id = args.at(-1); for (const [key, resource] of resources) if (key.startsWith(`${kind}:`) && (resource.Id === id || resource.Name === id)) resources.delete(key);
      return ok();
    }
    throw new Error(`unexpected docker arguments ${JSON.stringify(args)}`);
  };
  return { resources, calls, foreign, run, fail(kind?: string) { failRemoval = kind; }, mutations() { return calls.filter(({ args }) => args[1] === "rm"); } };
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "dim-local-uninstall-")); roots.push(home);
  const paths = removalPaths({ HOME: home, XDG_RUNTIME_DIR: join(home, "run") });
  return { home, paths };
}
const labels = { "dim.managed": "true", "dim.workspace-id": "owned" };
const volume: DockerClaim = { kind: "volume", name: "owned-data", labels };
it("refuses foreign labels and shared volumes or networks before Docker mutation", async () => {
  const f = dockerFixture([volume]); f.resources.get("volume:owned-data")!.Labels = { "dim.managed": "false", "dim.workspace-id": "owned" };
  await expect(planDocker(f.run, [volume])).rejects.toThrow("ownership mismatch"); expect(f.mutations()).toEqual([]);
  for (const kind of ["volume", "network"] as const) {
    const claim = { ...volume, kind }, shared = dockerFixture([claim]); shared.foreign.set(`${kind}=owned-data`, ["foreign-container"]);
    await expect(planDocker(shared.run, [claim])).rejects.toThrow("foreign container uses"); expect(shared.mutations()).toEqual([]);
  }
});
it("refuses replaced volume identity both before and immediately preceding deletion", async () => {
  const f = dockerFixture([volume]), plan = await planDocker(f.run, [volume]);
  f.resources.get("volume:owned-data")!.Created = "2026-02-01T00:00:00Z";
  await expect(removeDocker(f.run, plan)).rejects.toThrow("identity changed"); expect(f.mutations()).toEqual([]);
  f.resources.get("volume:owned-data")!.Created = "2026-01-01T00:00:00Z";
  let inspections = 0;
  const racing: Command = async (file, args) => {
    if (file === "docker" && args[1] === "inspect" && ++inspections === 2) f.resources.get("volume:owned-data")!.Created = "2026-03-01T00:00:00Z";
    return f.run(file, args);
  };
  await expect(removeDocker(racing, plan)).rejects.toThrow("identity changed"); expect(f.mutations()).toEqual([]);
});
it("dry planning never writes state and partial Docker failure retains configuration and retry authority", async () => {
  const f = await fixture(), id = "11111111-1111-1111-1111-111111111111";
  await mkdir(join(f.paths.state, "workspaces"), { recursive: true, mode: 0o700 }); await mkdir(join(f.paths.home, ".config/dim"), { recursive: true });
  await writeFile(f.paths.config, JSON.stringify({ retained: true }));
  await writeFile(join(f.paths.configuration, "hosts.json"), JSON.stringify({ current: "remote" }));
  await writeFile(join(f.paths.state, "workspaces/dev.json"), JSON.stringify({ schemaVersion: 10, name: "dev", id, runtime: "container" }));
  const prefix = `dim-workspace-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
  const claims: DockerClaim[] = ["container", "network", "home", "checkout", "docker", "tmp"].map((role) => ({ kind: role === "container" || role === "network" ? role : "volume", name: role === "container" || role === "network" ? prefix : `${prefix}-${role}`, labels: { "dim.managed": "true", "dim.workspace-id": id, "dim.resource": role, "dim.workspace-schema": "10" } }));
  const docker = dockerFixture(claims), plan = await createRemovalPlan(f.paths, docker.run);
  expect(plan.docker).toHaveLength(6); expect(docker.mutations()).toEqual([]);
  await expect(readFile(join(f.paths.data, "local-uninstall.json"))).rejects.toMatchObject({ code: "ENOENT" });
  docker.fail("volume"); await expect(executeRemoval(plan, docker.run)).rejects.toThrow("injected removal failure");
  expect(JSON.parse(await readFile(f.paths.config, "utf8"))).toEqual({ retained: true });
  expect(JSON.parse(await readFile(join(f.paths.data, "local-uninstall.json"), "utf8"))).toMatchObject({ schemaVersion: 1 });
  docker.fail(); const retry = await createRemovalPlan(f.paths, docker.run); await executeRemoval(retry, docker.run);
  expect(docker.resources.size).toBe(0); await expect(readFile(join(f.paths.configuration, "hosts.json"))).rejects.toMatchObject({ code: "ENOENT" }); await expect(readFile(f.paths.config)).rejects.toMatchObject({ code: "ENOENT" });
  const absent = await createRemovalPlan(f.paths, docker.run); expect(absent.docker).toEqual([]); await executeRemoval(absent, docker.run);
});
it("rejects broad and redirected removal roots", async () => {
  const f = await fixture(); await expect(validatePaths({ ...f.paths, data: f.home })).rejects.toThrow("broad removal path");
  await expect(validatePaths({ ...f.paths, data: join(f.paths.repository, ".local") })).rejects.toThrow("broad removal path");
  const elsewhere = join(f.home, "elsewhere"); await mkdir(elsewhere); await mkdir(join(f.home, ".local/share"), { recursive: true }); await symlink(elsewhere, f.paths.data);
  await expect(validatePaths(f.paths)).rejects.toThrow("symlinked removal path");
});
it("removes only explicitly selected DIM installer mise registrations", async () => {
  const f = await fixture(), calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: Command = async (file, args) => { calls.push({ file, args }); return ok(args[0] === "ls" ? JSON.stringify([{ version: "0.10.0", install_path: join(f.home, ".local/share/mise/installs/dim-installer/0.10.0") }]) : ""); };
  const selected = await planMise(run, { HOME: f.home }); expect(selected).toEqual([`${installerTool}@0.10.0`]); await removeMise(run, selected);
  expect(calls).toEqual([{ file: "mise", args: ["ls", "--json", installerTool] }, { file: "mise", args: ["unuse", "--global", "--no-prune", installerTool] }, { file: "mise", args: ["uninstall", `${installerTool}@0.10.0`] }]);
  const foreign: Command = async () => ok(JSON.stringify([{ version: "0.10.0", install_path: "/outside/mise" }]));
  await expect(planMise(foreign, { HOME: f.home })).rejects.toThrow("unexpected mise installer registration");
});

it("recognizes the owned controller entrypoint and rejects a sibling installation prefix", async () => {
  const f = await fixture(); await mkdir(join(f.home, ".config/systemd/user"), { recursive: true });
  const unit = (entrypoint: string) => `[Unit]\nDescription=DIM managed controller\n[Service]\nExecStart="/usr/bin/node" ${JSON.stringify(entrypoint)} "controller" "serve"\n`;
  await writeFile(f.paths.unit, unit(join(f.paths.data, "runtime/current/cli.js")));
  expect(await ownedControllerUnit(f.paths)).toBe(true);
  await writeFile(f.paths.unit, unit(join(`${f.paths.data}-foreign`, "cli.js")));
  await expect(ownedControllerUnit(f.paths)).rejects.toThrow("does not belong to the selected installation");
});
it("rejects a missing or stale reinstall candidate before executing removal", async () => {
  const f = await fixture(), scripts = join(f.home, "scripts"), marker = join(f.home, "removed");
  await mkdir(scripts);
  for (const name of ["reinstall-source-build.bash", "install-source-build.bash", "uninstall-source-build.bash"]) {
    await copyFile(new URL(`../../../scripts/${name}`, import.meta.url), join(scripts, name));
  }
  await writeFile(join(scripts, "uninstall-local.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "removed");\n`);
  const run = promisify(execFile);
  await expect(run("bash", [join(scripts, "reinstall-source-build.bash")])).rejects.toMatchObject({ stderr: expect.stringContaining("not prepared") });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(f.home, ".local/prepared-local.state"), "old-candidate\n");
  await writeFile(join(scripts, "local-package-version.bash"), "printf '0.10.0\\n'\n");
  await writeFile(join(scripts, "local-preparation-state.bash"), "printf 'changed-candidate\\n'\n");
  await expect(run("bash", [join(scripts, "reinstall-source-build.bash"), "--with-managed"])).rejects.toMatchObject({ stderr: expect.stringContaining("stale or mismatched") });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
