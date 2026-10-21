import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { restoreLocalSharedIngress, sharedIngressArtifacts } from "../../../scripts/install-local-shared-ingress.ts";
import { removalPaths } from "../../../scripts/local-uninstall/paths.ts";
import { ownedSharedIngressUnit, sharedIngressUnitPath } from "../../../scripts/local-uninstall/shared-ingress-unit.ts";
import { createRemovalPlan, executeRemoval } from "../../../scripts/local-uninstall/plan.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";
const roots: string[] = [];
const version = "0.10.0-test", cp = "@slop-lab/dim-control-plane-plugin-external-urls", host = "@slop-lab/dim-host-plugin-external-urls";
const manifest = { schemaVersion: 1, packages: [
  { name: "@slop-lab/dim-cli", version, file: "cli.tgz" },
  { name: cp, version, file: "ingress.tgz", requires: { "@slop-lab/dim-control-plane-core": version } },
  { name: "@slop-lab/dim-control-plane-core", version, file: "cp.tgz" },
  { name: host, version, file: "host.tgz" }
] };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-shared-ingress-")); roots.push(root);
  const env = { HOME: root, XDG_RUNTIME_DIR: join(root, "run") }, paths = removalPaths(env), configuration = join(paths.configuration, "shared-ingress/services.json"), bundle = join(root, "bundle");
  await mkdir(join(paths.configuration, "shared-ingress"), { recursive: true, mode: 0o700 }); await mkdir(bundle);
  await writeFile(configuration, JSON.stringify({ schemaVersion: 1, plugins: [{ package: cp, config: { domain: "example.test" } }] }), { mode: 0o600 });
  await writeFile(join(paths.configuration, "external-urls.json"), JSON.stringify({ schemaVersion: 1, ingresses: {} }), { mode: 0o600 });
  await writeFile(join(bundle, "packages.json"), JSON.stringify(manifest));
  for (const { file } of manifest.packages) await writeFile(join(bundle, file), file);
  const calls: string[][] = [], run: Command = async (file, args) => { calls.push([file, ...args]); return { status: 0, stdout: file === "mise" ? "[]" : "", stderr: "" }; };
  const install = vi.fn((args: readonly string[]) => { const stage = args[args.indexOf("--prefix") + 1]!; mkdirSync(join(stage, "node_modules/.bin"), { recursive: true }); writeFileSync(join(stage, "node_modules/.bin/dim-control-plane"), "ingress"); });
  const hostInstall = vi.fn(async () => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  return { root, env, paths, configuration, bundle, calls, run, install, hostInstall };
}
it("selects only the shared control-plane runtime dependency closure", () => {
  expect(sharedIngressArtifacts(manifest).map(({ file }) => file).sort()).toEqual(["cp.tgz", "ingress.tgz"]);
});
it("restores reviewed shared ingress and host plugin idempotently without changing private configuration", async () => {
  const f = await fixture(), before = await readFile(f.configuration);
  await restoreLocalSharedIngress(f.bundle, f.env, f.run, f.install, f.hostInstall);
  expect(await ownedSharedIngressUnit(f.paths)).toBe(true);
  expect(f.calls).toContainEqual(["systemctl", "--user", "restart", "dim-shared-ingress.service"]);
  expect(f.hostInstall).toHaveBeenCalledWith(expect.objectContaining({ home: f.paths.hostPlugins, version, files: [join(f.bundle, "host.tgz")] }));
  await restoreLocalSharedIngress(f.bundle, f.env, f.run, f.install, f.hostInstall);
  expect(f.install).toHaveBeenCalledTimes(1); expect(await readFile(f.configuration)).toEqual(before);
});
it("refuses foreign service units and public credentials before installing", async () => {
  const f = await fixture(); await chmod(f.configuration, 0o644);
  await expect(restoreLocalSharedIngress(f.bundle, f.env, f.run, f.install, f.hostInstall)).rejects.toThrow("mode-0600");
  await chmod(f.configuration, 0o600); const unit = sharedIngressUnitPath(f.paths);
  await mkdir(join(f.root, ".config/systemd/user"), { recursive: true }); await writeFile(unit, "[Service]\nExecStart=/foreign/service\n");
  await expect(restoreLocalSharedIngress(f.bundle, f.env, f.run, f.install, f.hostInstall)).rejects.toThrow("does not belong");
  expect(f.install).not.toHaveBeenCalled();
});
it("retains ingress credentials, host selection and TLS state with cache retention disabled while replacing runtime", async () => {
  const f = await fixture(), tls = join(f.paths.state, "shared-ingress/data");
  await mkdir(tls, { recursive: true, mode: 0o700 }); await writeFile(join(tls, "certificate.key"), "private TLS key", { mode: 0o600 });
  await restoreLocalSharedIngress(f.bundle, f.env, f.run, f.install, f.hostInstall);
  const plan = await createRemovalPlan(f.paths, f.run, f.env, { keepCacheData: false });
  expect(plan.sharedIngressUnit).toBe(true); expect(plan.persistent.files).toContain(join(f.paths.configuration, "shared-ingress"));
  await executeRemoval(plan, f.run);
  expect(await readFile(join(tls, "certificate.key"), "utf8")).toBe("private TLS key");
  expect(await readFile(f.configuration, "utf8")).toContain("example.test");
  expect(await readFile(join(f.paths.configuration, "external-urls.json"), "utf8")).toContain("ingresses");
  await expect(stat(join(f.paths.data, "shared-ingress/runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.calls).toContainEqual(["systemctl", "--user", "disable", "--now", "dim-shared-ingress.service"]);
  await restoreLocalSharedIngress(f.bundle, f.env, f.run, f.install, f.hostInstall);
  expect(await ownedSharedIngressUnit(f.paths)).toBe(true);
});
it("retains only the selected edge TLS volumes and restores its original deployment after runtime replacement", async () => {
  const f = await fixture(), directory = join(f.paths.state, "plugins/external-urls/caddy/https-ts");
  const other = join(f.paths.state, "plugins/external-urls/caddy/other");
  for (const [path, name] of [[directory, "https-ts"], [other, "other"]]) {
    await mkdir(path!, { recursive: true, mode: 0o700 });
    await writeFile(join(path!, "compose.yml"), `services:\n  caddy:\n    container_name: dim-caddy-${name}\nvolumes:\n  caddy-data:\n  caddy-config:\n`, { mode: 0o600 });
  }
  await writeFile(join(directory, "Caddyfile"), "reviewed TLS edge with private DNS credential", { mode: 0o600 });
  await writeFile(join(f.paths.configuration, "shared-ingress/edge.json"), JSON.stringify({ schemaVersion: 1, ingressName: "https-ts" }), { mode: 0o600 });
  const { collectHostClaims } = await import("../../../scripts/local-uninstall/host-resources.ts");
  const { retainedPersistentData } = await import("../../../scripts/local-uninstall/persistent-data.ts");
  const claims = await collectHostClaims(f.paths);
  const persistent = await retainedPersistentData(f.paths, [], claims.map((claim) => ({ claim, id: claim.name, created: "now" })));
  expect([...persistent.volumes].sort()).toEqual(["https-ts_caddy-config", "https-ts_caddy-data"]);
  expect(persistent.files).toContain(directory); expect(persistent.files).not.toContain(other);
  await restoreLocalSharedIngress(f.bundle, f.env, f.run, f.install, f.hostInstall);
  expect(f.calls).toContainEqual(["docker", "compose", "--project-directory", directory, "--project-name", "https-ts", "--file", join(directory, "compose.yml"), "up", "-d"]);
  expect(await readFile(join(directory, "Caddyfile"), "utf8")).toBe("reviewed TLS edge with private DNS credential");
});
