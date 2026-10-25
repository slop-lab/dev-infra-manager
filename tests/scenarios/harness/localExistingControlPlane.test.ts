import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { installLocalExistingControlPlane, readExistingControlPlaneSelection } from "../../../scripts/install-local-existing-control-plane.ts";
import { readExistingConnections } from "../../../scripts/local-control-plane/existing-connections.ts";
import { existingSshArguments, existingSshTransport } from "../../../scripts/local-control-plane/existing-ssh.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : done()); })));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const generation = "a".repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-existing-control-plane-")); roots.push(root);
  const directory = join(root, "exported"); await mkdir(directory, { mode: 0o700 });
  const calls: string[] = [], roles = new Map<string, { username: string; password: string; role?: string; reviewerId?: string; hostId?: string }>();
  let liveGeneration = generation;
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    const role = roles.get(request.url!);
    if (!role || request.method !== "GET" || request.headers.authorization !== `Basic ${Buffer.from(`${role.username}:${role.password}`).toString("base64")}`) { response.writeHead(401).end(); return; }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(role.role ? { schemaVersion: 1, serviceId: "native-main",
      ...(role.role === "operator-project-registrar" ? {} : { generationId: liveGeneration }),
      role: role.role, ...(role.reviewerId ? { reviewerId: role.reviewerId } : { hostId: role.hostId }) } : []));
  }); servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  let next = 0;
  const credential = (role: string, path = `/v1/${role}-identity`) => {
    const value = { username: `role-${++next}`, password: Buffer.alloc(32, next).toString("base64url") };
    roles.set(path, { ...value, ...(role === "query" || role === "operator" ? {} : { role, ...(role === "human-reviewer" ? { reviewerId: "owner" } : { hostId: "remote-host" }) }) });
    return value;
  };
  const base = { schemaVersion: 1, endpoint, serviceId: "native-main", hostId: "remote-host", generationId: generation };
  const reviewer = credential("human-reviewer");
  const files: Record<string, unknown> = {
    "host.json": { schemaVersion: 1, hostId: "remote-host", nativeGit: { transport: "loopback-http", endpoint, serviceId: "native-main", generationId: generation,
      workspaceWriteIssuer: credential("operator-workspace-write-issuer"), rootReadIssuer: { username: "reader", password: Buffer.alloc(32, 99).toString("base64url") } } },
    "importer.json": { ...base, role: "operator-root-importer", credential: credential("operator-root-importer") },
    "registrar.json": { ...base, credential: credential("operator-project-registrar") },
    "reviewer.json": { schemaVersion: 1, serviceId: "native-main", baseUrl: endpoint, generationId: generation, reviewerId: "owner", ...reviewer },
    "promoter.json": { ...base, role: "host-promoter", credential: credential("host-promoter") },
    "ci-query.json": { schemaVersion: 1, role: "query", endpoint, generationId: generation, credential: credential("query", "/v1/jobs") },
    "execution-operator.json": { schemaVersion: 1, role: "operator", endpoint, generationId: generation, credential: credential("operator", "/v1/operator/workers") }
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") };
  return { root, directory, endpoint, env, calls, files, stale: () => { liveGeneration = "b".repeat(64); } };
}
it("attests a generated role bundle without writing, deploying a control plane or selecting it", async () => {
  const f = await fixture(); let selected = false;
  await installLocalExistingControlPlane({ connections: f.directory, check: true }, f.env, { select: async () => { selected = true; } });
  expect(selected).toBe(false);
  expect(f.calls).toHaveLength(7);
  expect(f.calls.every((call) => call.startsWith("GET "))).toBe(true);
  expect(await readdir(f.root)).toEqual(["exported"]);
});
it("copies only scoped client roles, selects after live verification, and saves the existing-connection choice", async () => {
  const f = await fixture(); let selected: string | undefined;
  const result = await installLocalExistingControlPlane({ connections: f.directory }, f.env, { select: async (directory) => {
    expect(f.calls).toHaveLength(14); selected = directory;
    expect(await readFile(join(directory, "host.json"), "utf8")).toContain("remote-host");
  } });
  expect(result.connections).toBe(selected);
  expect(result.connections).not.toBe(f.directory);
  expect(await readExistingControlPlaneSelection(f.env)).toEqual(result);
  expect((await stat(result.connections)).mode & 0o777).toBe(0o700);
  expect((await stat(join(result.connections, "reviewer.json"))).mode & 0o777).toBe(0o600);
  expect((await readdir(result.connections)).sort()).toEqual(Object.keys(f.files).sort());
});
it("rejects stale serving generation before writes and preserves any saved selection", async () => {
  const f = await fixture();
  const saved = await installLocalExistingControlPlane({ connections: f.directory }, f.env, { select: async () => {} });
  const priorFiles = await readdir(join(f.env.XDG_CONFIG_HOME, "dim/existing-control-plane"));
  f.stale(); let selected = false;
  await expect(installLocalExistingControlPlane({ connections: f.directory }, f.env, { select: async () => { selected = true; } })).rejects.toThrow("generation changed");
  expect(selected).toBe(false);
  expect(await readExistingControlPlaneSelection(f.env)).toEqual(saved);
  expect(await readdir(join(f.env.XDG_CONFIG_HOME, "dim/existing-control-plane"))).toEqual(priorFiles);
});
it("rejects a directory containing server secrets or mismatching host credentials without contacting the service", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "native-git.json"), "{}", { mode: 0o600 });
  await expect(readExistingConnections(f.directory)).rejects.toThrow("role connections only");
  await rm(join(f.directory, "native-git.json"));
  const importer = f.files["importer.json"] as Record<string, unknown>;
  await writeFile(join(f.directory, "importer.json"), JSON.stringify({ ...importer, hostId: "other" }), { mode: 0o600 });
  await expect(readExistingConnections(f.directory)).rejects.toThrow("one host");
  expect(f.calls).toEqual([]);
});
it("uses a read-only temporary SSH check and persists the tunnel before final selection", async () => {
  const f = await fixture(), order: string[] = [];
  await installLocalExistingControlPlane({ connections: f.directory, ssh: "my-control-plane" }, f.env, {
    temporary: async (_alias, _bundle, action) => { order.push("temporary"); return action(); },
    persist: async () => { order.push("persist"); }, select: async () => { order.push("select"); }
  });
  expect(order).toEqual(["temporary", "persist", "select"]);
  expect((await readExistingControlPlaneSelection(f.env))?.ssh).toBe("my-control-plane");
});
it("creates only a strict pinned loopback SSH user service, using the operator's SSH configuration", async () => {
  const f = await fixture(), bundle = await readExistingConnections(f.directory), calls: string[][] = [];
  const socketDirectory = join(f.root, "ssh-runtime");
  const run: Command = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "systemctl" && args.includes("restart")) await mkdir(socketDirectory, { mode: 0o700 });
    return { status: 0, stdout: "", stderr: "" };
  };
  await existingSshTransport(f.env, run, { runtimeDirectory: socketDirectory }).persist("my-control-plane", bundle);
  const text = await readFile(join(f.env.XDG_CONFIG_HOME, "systemd/user/dim-existing-control-plane-tunnel.service"), "utf8");
  expect(text).toContain('"StrictHostKeyChecking=yes"');
  expect(text).toContain('"BatchMode=yes"');
  expect(text).toContain("RuntimeDirectory=dim-existing-control-plane\nRuntimeDirectoryMode=0700\nRuntimeDirectoryPreserve=no");
  expect(text).toContain(`"127.0.0.1:${new URL(f.endpoint).port}:127.0.0.1:${new URL(f.endpoint).port}"`);
  expect(calls.slice(0, 4).every(([command]) => command === "systemctl")).toBe(true);
  expect(calls).toContainEqual(["systemctl", "--user", "restart", "dim-existing-control-plane-tunnel.service"]);
  expect(calls.at(-1)?.slice(-3)).toEqual(["-O", "check", "my-control-plane"]);
  await rm(socketDirectory, { recursive: true, force: true });
  expect(() => existingSshArguments("-oProxyCommand=evil", bundle)).toThrow("SSH host alias");
  expect(() => existingSshArguments("good", { ...bundle, nativeEndpoint: "http://remote.example:8787" })).toThrow("127.0.0.1");
});
it("fails before writing an SSH unit when user systemd is unavailable", async () => {
  const f = await fixture(), bundle = await readExistingConnections(f.directory);
  const run: Command = async () => ({ status: 1, stdout: "", stderr: "no user bus" });
  await expect(existingSshTransport(f.env, run).persist("my-control-plane", bundle)).rejects.toThrow("no user bus");
  expect(await readdir(f.root)).toEqual(["exported"]);
});
it.skipIf(!process.env.DIM_TEST_INSTALLED_HOST_PLUGINS)("selects through the real installed Native Git SDK using only disposable host state", async () => {
  const f = await fixture(), managed = join(f.root, "managed");
  const env = { ...f.env, DIM_PLUGIN_HOME: process.env.DIM_TEST_INSTALLED_HOST_PLUGINS!, DIM_MANAGED_STATE_ROOT: managed };
  const result = await installLocalExistingControlPlane({ connections: f.directory }, env);
  const active = JSON.parse(await readFile(join(managed, "active-control-plane.json"), "utf8"));
  expect(active).toEqual({ schemaVersion: 1, hostConnectionFile: join(result.connections, "host.json"), importerConnectionFile: join(result.connections, "importer.json") });
  expect(await readExistingControlPlaneSelection(env)).toEqual(result);
  expect(f.calls).toHaveLength(14);
});
