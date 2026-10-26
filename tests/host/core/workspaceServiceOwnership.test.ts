import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadHostPlugins } from "../../../packages/host/core/src/application/host-plugins.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function plugins(sources: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "dim-service-owners-")); roots.push(root); vi.stubEnv("DIM_PLUGIN_HOME", root);
  const files = sources.map((_source, index) => join(root, `${index}.mjs`));
  await Promise.all(sources.map((source, index) => writeFile(files[index] ?? "", source)));
  await writeFile(join(root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: files }));
  return loadHostPlugins();
}
it("reserves core service IDs and rejects competing plugin owners", async () => {
  await expect(plugins(["export const hostPlugin={name:'foreign',workspaceServices:{names:['workspace'],resolve:async()=>undefined}};"]))
    .rejects.toThrow("duplicate workspace service");
  await expect(plugins([
    "export const hostPlugin={name:'first',workspaceServices:{names:['git'],resolve:async()=>undefined}};",
    "export const hostPlugin={name:'second',workspaceServices:{names:['git'],resolve:async()=>undefined}};",
  ])).rejects.toThrow("duplicate workspace service");
});
it.each(["{names:['git'],resolve:42}", "{names:['../host'],resolve:async()=>undefined}", "{names:['git','git'],resolve:async()=>undefined}"])("rejects invalid static service ownership %s", async (declaration) => {
  await expect(plugins([`export const hostPlugin={name:'invalid',workspaceServices:${declaration}};`])).rejects.toThrow("invalid workspace services");
});
