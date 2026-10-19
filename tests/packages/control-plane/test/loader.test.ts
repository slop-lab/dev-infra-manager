import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { startControlPlaneFile } from "../../../../packages/control-plane/core/src/cli.js";

it("loads only enabled modules from the independent CP tree and rejects disabled selections before importing any module", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-cp-enabled-"));
  const pluginHome = join(root, "cp"), packageRoot = join(pluginHome, "node_modules/@fixture/service");
  const marker = join(root, "events"), configuration = join(root, "services.json");
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    await writeFile(join(packageRoot, "index.js"), `
import { appendFileSync } from 'node:fs';
const record = value => appendFileSync(${JSON.stringify(marker)}, value + '\\n');
record('import');
export const controlPlanePlugin = {
  apiVersion: 1, name: 'fixture',
  configure() {
    return { async start() {
      record('start');
      return { async close() { record('close'); } };
    } };
  }
};
`);
    await writeFile(configuration, JSON.stringify({ schemaVersion: 1, plugins: [{ package: "@fixture/service", config: {} }] }), { mode: 0o600 });
    const manifest = join(pluginHome, "plugins.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, plugins: [] }), { mode: 0o600 });
    const environment = { DIM_CONTROL_PLANE_PLUGIN_HOME: pluginHome, DIM_PLUGIN_HOME: "/unrelated-host-plugins" };
    await expect(startControlPlaneFile(configuration, new AbortController().signal, environment)).rejects.toThrow(/not enabled/);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // Node normally searches parent node_modules too; an enabled name is not
    // permission to load a package outside this CP installation.
    const ambient = join(root, "node_modules/@fixture/ambient");
    await mkdir(ambient, { recursive: true });
    await writeFile(join(ambient, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    await writeFile(join(ambient, "index.js"), "throw new Error('ambient package must never import');");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, plugins: ["@fixture/ambient"] }));
    await writeFile(configuration, JSON.stringify({ schemaVersion: 1, plugins: [{ package: "@fixture/ambient", config: {} }] }));
    await expect(startControlPlaneFile(configuration, new AbortController().signal, environment)).rejects.toThrow(/not installed/);
    await writeFile(configuration, JSON.stringify({ schemaVersion: 1, plugins: [{ package: "@fixture/service", config: {} }] }));
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, plugins: ["@fixture/service"] }));
    const service = await startControlPlaneFile(configuration, new AbortController().signal, environment);
    await service.close();
    expect(await readFile(marker, "utf8")).toBe("import\nstart\nclose\n");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, plugins: [] }));
    await expect(startControlPlaneFile(configuration, new AbortController().signal, environment)).rejects.toThrow(/not enabled/);
    expect(await readFile(marker, "utf8")).toBe("import\nstart\nclose\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
