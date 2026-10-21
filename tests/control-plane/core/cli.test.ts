import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the built control-plane CLI through its installed bin symlink and stops its real plugin listener on SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-cp-cli-symlink-"));
  const pluginHome = join(root, "runtime");
  const bin = join(pluginHome, "node_modules/.bin/dim-control-plane");
  const packageName = "@slop-lab/dim-control-plane-plugin-external-urls";
  const pluginPath = join(pluginHome, "node_modules", packageName);
  const configuration = join(root, "ingress.json");
  const managementPort = await availablePort();
  const token = "fixture-host-credential-".padEnd(48, "a");
  await mkdir(dirname(bin), { recursive: true }); await mkdir(dirname(pluginPath), { recursive: true });
  await symlink(fileURLToPath(new URL("../../../packages/control-plane/core/dist/cli.js", import.meta.url)), bin);
  await symlink(fileURLToPath(new URL("../../../packages/control-plane/plugins/external-urls", import.meta.url)), pluginPath);
  await writeFile(join(pluginHome, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(join(pluginHome, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [packageName] }));
  await writeFile(configuration, JSON.stringify({ schemaVersion: 1, plugins: [{ package: packageName, config: {
    schemaVersion: 1, domain: "dev.example.test", publicListen: { host: "127.0.0.1", port: 0 },
    managementListen: { host: "127.0.0.1", port: managementPort },
    hosts: [{ id: "fixture", token, relayOrigin: "http://127.0.0.1:1" }]
  } }] }), { mode: 0o600 });
  const child = spawn(process.execPath, [bin, "run", configuration], {
    env: { ...process.env, DIM_CONTROL_PLANE_PLUGIN_HOME: pluginHome }, stdio: ["ignore", "pipe", "pipe"]
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => { if (diagnostic.length < 8192) diagnostic += chunk.toString("utf8"); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const endpoint = `http://127.0.0.1:${managementPort}/v1/identity`;
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`control-plane CLI exited before its listener started: ${diagnostic}`);
      try {
        const response = await fetch(endpoint, { headers: { "x-dim-host-id": "fixture", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
        if (response.status !== 200) return undefined;
        return response.json();
      } catch { return undefined; }
    }, { timeout: 5000, interval: 50 }).toEqual({ schemaVersion: 1, hostId: "fixture", domain: "dev.example.test" });
    expect(child.kill("SIGTERM")).toBe(true);
    await expect.poll(() => child.exitCode, { timeout: 3000, interval: 20 }).toBe(0);
    expect(await exited).toEqual({ code: 0, signal: null });
    await expect(fetch(endpoint, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    expect(diagnostic).toBe("");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});

async function availablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("fixture port unavailable");
  return address.port;
}
