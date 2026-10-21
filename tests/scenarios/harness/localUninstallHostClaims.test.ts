import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectHostClaims, collectVmClaims } from "../../../scripts/local-uninstall/host-resources.ts";
import type { RemovalPaths } from "../../../scripts/local-uninstall/types.ts";
const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-uninstall-claims-")); cleanup.push(root);
  const paths: RemovalPaths = { home: root, repository: root, data: root, config: root, configuration: root, state: join(root, "state"), managed: join(root, "managed"), controlPlane: root, hostPlugins: root, controlPlanePlugins: root, runtime: root, bin: root, unit: root };
  async function json(file: string, value: unknown) { await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, JSON.stringify(value), { mode: 0o600 }); }
  return { root, paths, json };
}
const id = "11111111-1111-1111-1111-111111111111";
it("claims only recorded workspace identities and rejects unsupported runtimes", async () => {
  const f = await fixture(), file = join(f.paths.state, "workspaces/dev.json");
  await f.json(file, { schemaVersion: 10, id, name: "dev", runtime: "container" });
  const claims = await collectHostClaims(f.paths);
  expect(claims).toHaveLength(6);
  expect(claims[0]).toMatchObject({ name: `dim-workspace-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`, labels: { "dim.workspace-id": id, "dim.workspace-schema": "10" } });
  await f.json(file, { schemaVersion: 10, id, name: "dev", runtime: "foreign" });
  await expect(collectHostClaims(f.paths)).rejects.toThrow("cannot safely remove workspace runtime");
});
it("requires per-resource cache identities and rejects unknown ledger namespaces", async () => {
  const f = await fixture(), file = join(f.paths.state, "plugins/cache-server/services/cache-dim-cache.json");
  await f.json(file, { schemaVersion: 2, serviceId: "s".repeat(43), resourceIds: { network: "n".repeat(43), "cache:npm": "c".repeat(43), "data:npm": "d".repeat(43) } });
  const claims = await collectHostClaims(f.paths);
  expect(claims.map(({ name }) => name)).toEqual(["dim-cache-network", "dim-cache-npm", "dim-cache-npm-data"]);
  expect(claims[1]?.labels).toMatchObject({ "dim.service-id": "s".repeat(43), "dim.resource-id": "c".repeat(43) });
  await f.json(file, { schemaVersion: 2, serviceId: "s".repeat(43), resourceIds: { network: "n".repeat(43), foreign: "x".repeat(43) } });
  await expect(collectHostClaims(f.paths)).rejects.toThrow("unknown cache resource");
});
it("anchors Caddy volumes to its exact recorded Compose directory and refuses linked state", async () => {
  const f = await fixture(), directory = join(f.paths.state, "plugins/external-urls/caddy/public");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "compose.yml"), "services:\n  caddy:\n    container_name: dim-caddy-public\nvolumes:\n  caddy-data:\n  caddy-config:\n");
  const claims = await collectHostClaims(f.paths);
  expect(claims[0]?.labels).toMatchObject({ "com.docker.compose.project.working_dir": directory });
  expect(claims.slice(1).map(({ requiresContainer }) => requiresContainer)).toEqual(["dim-caddy-public", "dim-caddy-public"]);
  await mkdir(f.paths.managed); await symlink(f.paths.state, join(f.paths.managed, "workspaces"));
  await expect(collectHostClaims(f.paths)).rejects.toThrow("unsafe DIM state directory");
});
it("scopes VM removal to the configured project and recorded fingerprint", async () => {
  const f = await fixture();
  await f.json(join(f.paths.state, "workspaces/vm.json"), { schemaVersion: 10, id, name: "vm", runtime: "vm", image: "a".repeat(64) });
  await f.json(join(f.paths.state, "plugins/vm/config.json"), { schemaVersion: 1, project: "development" });
  expect(await collectVmClaims(f.paths)).toEqual([{ project: "development", name: `dim-${id}`, id, image: "a".repeat(64) }]);
  expect(await collectHostClaims(f.paths)).toEqual([]);
});
