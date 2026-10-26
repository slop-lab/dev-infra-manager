import { scryptSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWebServerFromConfigFile } from "../../packages/web/core/src/server.js";
import { configuredWebOperations, workspaceCreateSchema, type WebOperations } from "../../packages/web/core/src/operations.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const uuid = randomUUID();
export async function operationsFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-web-ops-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const salt = Buffer.alloc(16, 7), hash = scryptSync("browser-password", salt, 32, { N: 16384, r: 8, p: 1 });
  const passwordHash = `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
  const calls: unknown[] = [];
  const operations: WebOperations = { hosts: async () => [{ id: "devbox" }],
    workspaces: async () => [{ id: uuid, name: "development", phase: "running", runtimeStatus: "running", runtime: "container", resources: { cpuCount: "1", memory: "2g", pidsLimit: "512" } }],
    workspaceCreate: async (host, input) => { calls.push({ create: host, ...input }); },
    workspaceAction: async (host, input) => { calls.push({ host, ...input }); },

  };
  const file = join(root, "web.json"), origin = "http://127.0.0.1:9081";
  await writeFile(file, JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port: 0, publicOrigin: origin,
    accounts: [ { username: "reader", passwordHash, roles: ["read"] }, { username: "operator", passwordHash, roles: ["read", "operator"] } ],
    session: { idleSeconds: 900, absoluteSeconds: 3600 }, operations: { hosts: [{ id: "devbox", selector: "host-only", executable: "/trusted/dim" }] } }), { mode: 0o600 });
  const web = await createWebServerFromConfigFile(file, { operations }); cleanups.push(() => web.close());
  const base = await web.listen();
  async function login(username: string) {
    const response = await fetch(base + "/v1/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username, password: "browser-password" }) });
    expect(response.status).toBe(201);
    const body = await response.json() as { csrfToken: string };
    return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, "x-dim-csrf": body.csrfToken, origin, "content-type": "application/json" };
  }
  return { root, base, origin, login, calls };
}
it("supports ordinary Git host operations without loading a control plane and enforces role, origin, CSRF and UUID fences", async () => {
  const f = await operationsFixture(), reader = await f.login("reader"), operator = await f.login("operator");
  const path = "/v1/operations/hosts/devbox/workspaces";
  expect((await fetch(f.base + path)).status).toBe(401);
  expect((await fetch(f.base + path, { headers: reader })).status).toBe(200);
  const body = JSON.stringify({ name: "development", expectedId: uuid, action: "restart" });
  expect((await fetch(f.base + path, { method: "POST", headers: reader, body })).status).toBe(403);
  expect((await fetch(f.base + path, { method: "POST", headers: { ...operator, origin: "https://attacker.invalid" }, body })).status).toBe(403);
  expect((await fetch(f.base + path, { method: "POST", headers: { ...operator, "x-dim-csrf": "wrong" }, body })).status).toBe(403);
  expect((await fetch(f.base + path, { method: "POST", headers: operator, body: JSON.stringify({ name: "development", action: "restart" }) })).status).toBe(400);
  expect(f.calls).toEqual([]);
  expect((await fetch(f.base + path, { method: "POST", headers: operator, body })).status).toBe(200);
  expect(f.calls).toEqual([{ host: "devbox", name: "development", expectedId: uuid, action: "restart" }]);
  const status = await fetch(f.base + "/v1/operations/status", { headers: reader });
  expect(await status.json()).toMatchObject({ hosts: [{ id: "devbox" }], consoles: [] });
  expect((await fetch(f.base + "/v1/projects/project-a/repositories/root/reviews/" + "a".repeat(64), { headers: reader })).status).toBe(404);
});
it("accepts host-supported Git clone addresses and rejects inline credentials or unsupported transports", () => {
  for (const source of ["git@github.com:team/project.git", "git.example.test:team/project.git", "ssh://git@example.test/team/project.git", "https://example.test/project.git", "dim://my-project"]) {
    expect(workspaceCreateSchema.parse({ name: "source-check", source }).source).toBe(source);
  }
  for (const source of ["https://user:token@example.test/project.git", "https://token@example.test/project.git", "ssh://git:token@example.test/project.git", "https://example.test/project.git?token=secret", "git://example.test/project.git"]) {
    expect(() => workspaceCreateSchema.parse({ name: "source-check", source })).toThrow();
  }
});
it("creates Git workspaces only with operator, origin and CSRF authority and rejects executable or option inputs", async () => {
  const f = await operationsFixture(), reader = await f.login("reader"), operator = await f.login("operator");
  const path = f.base + "/v1/operations/hosts/devbox/workspaces/create";
  const input = { name: "new-dev", source: "ssh://git@example.test/project.git", runtime: "vm", image: "a".repeat(64),
    resources: { cpuCount: "1.5", memory: "unlimited", pidsLimit: "2048" } };
  const body = JSON.stringify(input);
  expect((await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(401);
  expect((await fetch(path, { method: "POST", headers: reader, body })).status).toBe(403);
  expect((await fetch(path, { method: "POST", headers: { ...operator, "x-dim-csrf": "wrong" }, body })).status).toBe(403);
  expect((await fetch(path, { method: "POST", headers: { ...operator, origin: "https://attacker.invalid" }, body })).status).toBe(403);
  for (const invalid of [{ ...input, source: "ext::sh -c command" }, { ...input, source: "file:///host/private" },
    { ...input, image: "--privileged" }, { ...input, name: "--help" }, { ...input, executable: "/bin/sh" },
    { ...input, resources: { cpuCount: "0" } }, { ...input, runtime: "../../host" }]) {
    expect((await fetch(path, { method: "POST", headers: operator, body: JSON.stringify(invalid) })).status).toBe(400);
  }
  expect(f.calls).toEqual([]);
  expect((await fetch(path, { method: "POST", headers: operator, body })).status).toBe(200);
  expect(f.calls).toEqual([{ create: "devbox", ...input }]);
});
it("executes only configured public DIM host ports, projects safe summaries and passes expected identity as separate argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-web-cli-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const argv = join(root, "argv.json"), executable = join(root, "dim");
  const workspace = { id: uuid, name: "development", runtime: "container", runtimeStatus: "running", phase: "running", resources: { cpuCount: "1", memory: "2g", pidsLimit: "512" }, source: { url: "PRIVATE-HOST-REPO" } };
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(argv)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify(process.argv.includes('ls') ? [${JSON.stringify(workspace)}] : {}));\n`, { mode: 0o700 });
  const operations = configuredWebOperations({ hosts: [{ id: "devbox", selector: "ssh-development", executable }], consoles: [] });
  expect(await operations.workspaces("devbox")).toEqual([{ ...workspace, source: undefined }]);
  expect(await readFile(argv, "utf8")).toBe(JSON.stringify(["--host", "ssh-development", "ls", "--json"]));
  await operations.workspaceAction("devbox", { name: "development", expectedId: uuid, action: "restart" });
  expect(JSON.parse(await readFile(argv, "utf8"))).toEqual(["--host", "ssh-development", "restart", "development", "--expect-id", uuid, "--json"]);
  await operations.workspaceAction("devbox", { name: "development", expectedId: uuid, action: "discard" });
  expect(JSON.parse(await readFile(argv, "utf8"))).toEqual(["--host", "ssh-development", "discard", "development", "--expect-id", uuid, "--yes", "--json"]);
  await operations.workspaceCreate("devbox", workspaceCreateSchema.parse({ name: "new-dev", source: "https://example.test/repo;literal.git", ref: "main",
    runtime: "container", image: "registry.example.test/team/dev@sha256:" + "a".repeat(64), resources: { cpuCount: "unlimited", memory: "4g", pidsLimit: "512" } }));
  expect(JSON.parse(await readFile(argv, "utf8"))).toEqual(["--host", "ssh-development", "create", "https://example.test/repo;literal.git", "new-dev", "--runtime", "container", "--ref", "main",
    "--image", "registry.example.test/team/dev@sha256:" + "a".repeat(64), "--cpus", "unlimited", "--memory", "4g", "--pids", "512", "--json"]);
  await operations.workspaceCreate("devbox", workspaceCreateSchema.parse({ name: "joint", source: "dim://app",
    repositories: ["public", "private"], workingDirectory: "public" }));
  expect(JSON.parse(await readFile(argv, "utf8"))).toEqual(["--host", "ssh-development", "create", "dim://app", "joint", "--runtime", "container",
    "--repository", "public", "--repository", "private", "--workdir", "public", "--json"]);
  expect(() => workspaceCreateSchema.parse({ name: "bad", source: "https://example.test/repo.git", repositories: ["private"] })).toThrow();
  await expect(operations.workspaceCreate("attacker-host", { name: "new-dev", source: "https://example.test/repo.git", runtime: "container" })).rejects.toThrow("host not found");
  await expect(operations.workspaces("attacker-host")).rejects.toThrow("host not found");
});
it("returns fixed actionable host failure categories without raw stderr, credentials or host paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-web-safe-failure-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "dim"), diagnostic = join(root, "diagnostic");
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs'; console.error(fs.readFileSync(${JSON.stringify(diagnostic)},'utf8'));process.exit(2);\n`, { mode: 0o700 });
  const operations = configuredWebOperations({ hosts: [{ id: "devbox", selector: "host-only", executable }], consoles: [] });
  for (const [message, code, guidance] of [
    ["workspace 'new-dev' already exists", "workspace_exists", "choose another name"],
    ["Docker run failed: pull access denied for private/image", "image_unavailable", "build or pull"],
    ["Cannot connect to the Docker daemon", "runtime_unavailable", "dim doctor"],
    ["project 'my-project' not found", "project_unavailable", "ordinary Git"],
    ["fatal: couldn't find remote ref missing", "ref_unavailable", "Git ref empty"],
    ["fatal: Authentication failed", "repository_unavailable", "host Git credentials"],
    ["Unexpected diagnostic", "host_operation_failed", "dim doctor"]
  ]) {
    await writeFile(diagnostic, `${message}\nhttps://user:PRIVATE_SECRET@example.test/repo /private/host/path\n`);
    const failure = await operations.workspaceCreate("devbox", workspaceCreateSchema.parse({ name: "new-dev", source: "https://example.test/repo.git" })).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code, publicMessage: expect.stringContaining(guidance!) });
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_SECRET|\/private\/host\/path|user:/);
  }
  const unavailable = configuredWebOperations({ hosts: [{ id: "missing", selector: "host-only", executable: join(root, "missing") }], consoles: [] });
  await expect(unavailable.workspaces("missing")).rejects.toMatchObject({ code: "host_unavailable", status: 503 });
});
it("projects failed workspace setup state into a safe recovery category", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-web-safe-state-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "dim"), row = { id: uuid, name: "incomplete", runtime: "container", runtimeStatus: "missing", phase: "error", initialized: false,
    resources: { cpuCount: "1", memory: "2g", pidsLimit: "512" }, error: "pull access denied PRIVATE_SECRET /private/path", source: { url: "PRIVATE_REPO" } };
  await writeFile(executable, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify([row]))});\n`, { mode: 0o700 });
  const operations = configuredWebOperations({ hosts: [{ id: "devbox", selector: "host-only", executable }], consoles: [] });
  const rows = await operations.workspaces("devbox");
  expect(rows).toEqual([{ id: uuid, name: "incomplete", runtime: "container", runtimeStatus: "missing", phase: "error", initialized: false,
    resources: row.resources, failureCode: "image_unavailable" }]);
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_SECRET|\/private\/path|PRIVATE_REPO/);
});
