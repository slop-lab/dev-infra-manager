import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { prepareLocalNpmGraph, removeLocalNpmOverrides } from "../../packages/installer/src/localNpmGraph.js";

const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-local-npm-")); roots.push(root);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(404, { "content-type": "application/json" }); response.end('{"error":"not in local closure"}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test registry");
  const env = { ...process.env, npm_config_registry: `http://127.0.0.1:${address.port}`,
    npm_config_userconfig: "/dev/null", npm_config_ignore_scripts: "true", npm_config_fetch_retries: "0",
    npm_config_update_notifier: "false" };
  const run = async (directory: string, args: string[]) => exec("npm", args, { cwd: directory,
    env: { ...env, npm_config_cache: join(directory, "npm-cache") }, timeout: 15_000, maxBuffer: 1024 * 1024 });
  const pack = async (name: string, version: string, dependencies: Record<string, string> = {}) => {
    const directory = join(root, `${name.replaceAll("/", "-")}-${version}`); await mkdir(directory);
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, dependencies }));
    await writeFile(join(directory, "index.js"), '// @ts-check\nmodule.exports = "local-only";\n');
    const packed: unknown = JSON.parse((await run(directory, ["pack", "--json", "--ignore-scripts", "--pack-destination", root])).stdout);
    const entry: unknown = Array.isArray(packed) ? packed[0] : undefined;
    if (!entry || typeof entry !== "object" || !("filename" in entry) || typeof entry.filename !== "string") throw new Error("missing packed fixture");
    return join(root, entry.filename);
  };
  return { root, requests, run, pack, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
const library = "@slop-lab/gs-local-npm-fixture", plugin = "@slop-lab/dim-local-npm-fixture";
const install = ["install", "--save-exact", "--no-audit", "--no-fund"];
it("prevents actual npm metadata lookups for unpublished transitive local packages", async () => {
  const f = await fixture();
  try {
    const version = "0.10.0-local-only", lib = await f.pack(library, version), app = await f.pack(plugin, version, { [library]: version });
    const bare = join(f.root, "bare"); await mkdir(bare); await writeFile(join(bare, "package.json"), '{"private":true}');
    await f.run(bare, [...install, lib, app]);
    expect(f.requests).toContain("/@slop-lab%2fgs-local-npm-fixture"); // The old install succeeds but still waits on the registry.
    f.requests.length = 0;
    const fixed = join(f.root, "fixed"); await mkdir(fixed);
    await prepareLocalNpmGraph(fixed, [library, plugin], [lib, app]);
    await f.run(fixed, [...install, lib, app]);
    expect(f.requests).toEqual([]);
    expect(JSON.parse(await readFile(join(fixed, "node_modules", library, "package.json"), "utf8")).version).toBe(version);
    expect(JSON.parse(await readFile(join(fixed, "package.json"), "utf8")).overrides[library]).toBe(`$${library}`);
  } finally { await f.close(); }
});
it("keeps local upgrades and plugin removal independent of registry metadata", async () => {
  const f = await fixture();
  try {
    const runtime = join(f.root, "runtime"); await mkdir(runtime);
    for (const version of ["0.10.0-local-first", "0.10.0-local-second"]) {
      const lib = await f.pack(library, version), app = await f.pack(plugin, version, { [library]: version });
      await prepareLocalNpmGraph(runtime, [library, plugin], [lib, app]);
      await f.run(runtime, [...install, lib, app]);
      expect(JSON.parse(await readFile(join(runtime, "node_modules", library, "package.json"), "utf8")).version).toBe(version);
    }
    await f.run(runtime, ["uninstall", "--no-audit", "--no-fund", plugin]);
    await removeLocalNpmOverrides(runtime, [plugin]);
    await f.run(runtime, install);
    const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
    expect(manifest.dependencies[plugin]).toBeUndefined(); expect(manifest.overrides[plugin]).toBeUndefined();
    expect(manifest.overrides[library]).toBe(`$${library}`); expect(f.requests).toEqual([]);
  } finally { await f.close(); }
});
it("rejects partial local mappings before changing a runtime manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-local-npm-shape-")); roots.push(root);
  const original = '{"private":true,"description":"retained"}'; await writeFile(join(root, "package.json"), original);
  await expect(prepareLocalNpmGraph(root, [library], ["/a.tgz", "/b.tgz"])).rejects.toThrow("complete artifact closure");
  await expect(prepareLocalNpmGraph(root, [library, library], ["/a.tgz", "/b.tgz"])).rejects.toThrow("complete artifact closure");
  await expect(prepareLocalNpmGraph(root, [library, plugin], ["/a.tgz", "example@1.0.0"])).rejects.toThrow("complete artifact closure");
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(original);
});
