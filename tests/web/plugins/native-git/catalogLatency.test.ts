import { scryptSync } from "node:crypto";
import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createWebServerFromConfigFile } from "../../../../packages/web/core/src/server.js";
import { operations, webPlugin } from "../../../../packages/web/plugins/native-git/src/index.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("keeps two healthy controllers available across repeated and concurrent refreshes", async () => {
  let releaseSlow = () => {};
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let releaseSlowRefresh = () => {};
  const slowRefreshGate = new Promise<void>((resolve) => { releaseSlowRefresh = resolve; });
  let releaseFastRefresh = () => {};
  const fastRefreshGate = new Promise<void>((resolve) => { releaseFastRefresh = resolve; });
  let markSlowStarted = () => {};
  const slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve; });
  let markSlowCompleted = () => {};
  const slowCompleted = new Promise<void>((resolve) => { markSlowCompleted = resolve; });
  let slowCalls = 0, fastCalls = 0;
  const descriptors = operations.filter(({ name }) => name === "projects.list" || name === "reviews.list").map(({ name, description, access }) => ({ name, description, access }));
  const connecting = webPlugin.autoConnect!({ controllers: [
    { id: "slow", async run() { slowCalls++; if (slowCalls === 1) { markSlowStarted(); await slowGate; markSlowCompleted(); } else await slowRefreshGate;
      return { schemaVersion: 1, generationId: "a".repeat(64), reviewerId: "owner", projects: [], operations: descriptors }; } },
    { id: "fast", async run() { fastCalls++; if (fastCalls > 1) await fastRefreshGate;
      return { schemaVersion: 1, generationId: "b".repeat(64), reviewerId: "owner", projects: [{ projectId: "project-a", name: "Project A", repositoryIds: ["public"] }], operations: descriptors }; } }
  ] });
  await slowStarted;
  const connectedBeforeSlowController = await Promise.race([connecting.then(() => true), new Promise<false>((resolve) => setImmediate(() => resolve(false)))]);
  expect(connectedBeforeSlowController).toBe(true);
  const runtime = await connecting;
  expect(await runtime.invoke("projects.list", {})).toMatchObject({ controllers: [
    { id: "slow", status: "unavailable", projects: [] },
    { id: "fast", status: "ready", projects: [{ projectId: "project-a", repositoryIds: ["public"] }] }
  ] });
  releaseSlow();
  await slowCompleted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect(runtime.invoke("projects.list", {})).resolves.toMatchObject({ controllers: [{ id: "slow", status: "ready" }, { id: "fast", status: "ready" }] });
  const third = runtime.invoke("projects.list", {}), fourth = runtime.invoke("projects.list", {});
  releaseSlowRefresh();
  await expect(Promise.all([third, fourth])).resolves.toEqual([
    expect.objectContaining({ controllers: [expect.objectContaining({ id: "slow", status: "ready" }), expect.objectContaining({ id: "fast", status: "ready" })] }),
    expect.objectContaining({ controllers: [expect.objectContaining({ id: "slow", status: "ready" }), expect.objectContaining({ id: "fast", status: "ready" })] })
  ]);
  releaseFastRefresh();
});

it("coalesces concurrent automatic catalog reads into one controller discovery cycle", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const descriptors = operations.filter(({ name }) => name === "projects.list").map(({ name, description, access }) => ({ name, description, access }));
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "devbox", async run() {
    calls++;
    await gate;
    return { schemaVersion: 1, generationId: "a".repeat(64), reviewerId: "owner", projects: [], operations: descriptors };
  } }] });
  const first = runtime.invoke("projects.list", {}), second = runtime.invoke("projects.list", {});
  expect(calls).toBe(1);
  release();
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  expect(calls).toBe(1);
});

it("keeps concurrent catalog readers on one generation until their shared refresh completes", async () => {
  let describeCalls = 0, releaseRefresh = () => {}, markRefreshStarted = () => {};
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
  const writes: string[][] = [];
  const descriptors = operations.filter(({ name }) => name === "projects.list" || name === "reviews.list").map(({ name, description, access }) => ({ name, description, access }));
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "devbox", async run(args) {
    if (args[2] === "describe") {
      describeCalls++;
      if (describeCalls === 1) throw new Error("initially unavailable");
      if (describeCalls === 2) { markRefreshStarted(); await refreshGate; return { schemaVersion: 1, generationId: "a".repeat(64), reviewerId: "owner", projects: [{ projectId: "project-a", name: "Project A", repositoryIds: ["public"] }], operations: descriptors }; }
      return { schemaVersion: 1, generationId: "a".repeat(64), reviewerId: "owner", projects: [{ projectId: "project-a", name: "Project A", repositoryIds: ["public"] }], operations: descriptors };
    }
    writes.push([...args]); return [];
  } }] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const first = runtime.invoke("projects.list", {}); await refreshStarted;
  const second = runtime.invoke("projects.list", {});
  expect(describeCalls).toBe(2);
  releaseRefresh();
  await expect(Promise.all([first, second])).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ controllers: [expect.objectContaining({ status: "ready", projects: [expect.objectContaining({ projectId: "project-a" })] })] })
  ]));
  expect(await runtime.invoke("reviews.list", { controllerId: "devbox", projectId: "project-a", repositoryId: "public" })).toEqual([]);
  expect(describeCalls).toBe(3);
  expect(writes[0]).toContain("a".repeat(64));
});

it("waits for selected-controller reattestation and rejects scope revoked during refresh", async () => {
  let describeCalls = 0, operationCalls = 0, releaseRefresh = () => {}, markRefreshStarted = () => {};
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
  const descriptors = operations.filter(({ name }) => name === "projects.list" || name === "reviews.list").map(({ name, description, access }) => ({ name, description, access }));
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "devbox", async run(args) {
    if (args[2] === "describe") {
      describeCalls++;
      if (describeCalls > 1) { markRefreshStarted(); await refreshGate; }
      return { schemaVersion: 1, generationId: "a".repeat(64), reviewerId: "owner", projects: describeCalls === 1 ? [{ projectId: "project-a", name: "Project A", repositoryIds: ["public"] }] : [], operations: descriptors };
    }
    operationCalls++;
    return [];
  } }] });
  await expect(runtime.invoke("projects.list", {})).resolves.toMatchObject({ controllers: [{ status: "ready" }] });
  const refreshingCatalog = runtime.invoke("projects.list", {});
  await refreshStarted;
  const operation = runtime.invoke("reviews.list", { controllerId: "devbox", projectId: "project-a", repositoryId: "public" })
    .then(() => ({ kind: "resolved" as const }), (error: unknown) => ({ kind: "rejected" as const, error }));
  await expect(Promise.race([operation, new Promise<{ readonly kind: "pending" }>((resolve) => setImmediate(() => resolve({ kind: "pending" })))]))
    .resolves.toEqual({ kind: "pending" });
  releaseRefresh();
  await expect(refreshingCatalog).resolves.toMatchObject({ controllers: [{ status: "ready", projects: [] }] });
  const outcome = await operation;
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind === "rejected") expect(outcome.error).toEqual(expect.objectContaining({ message: expect.stringContaining("scope") }));
  expect(operationCalls).toBe(0);
});

it("serves a fresh fast-controller catalog over authenticated HTTP while another controller is still discovering", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-web-native-catalog-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const gate = join(root, "slow-gate"), calls = join(root, "calls.log"), executable = join(root, "dim"), config = join(root, "web.json");
  await writeFile(gate, "blocked");
  await writeFile(executable, `#!${process.execPath}\n// @ts-check\nimport {access,appendFile} from 'node:fs/promises';const args=process.argv.slice(2),selector=args[args.indexOf('--host')+1];await appendFile(${JSON.stringify(calls)},selector+' started\\n');if(selector==='slow'){while(true){try{await access(${JSON.stringify(gate)});await new Promise(resolve=>setTimeout(resolve,10));}catch{break;}}}await appendFile(${JSON.stringify(calls)},selector+' completed\\n');console.log(JSON.stringify({schemaVersion:1,generationId:(selector==='slow'?'a':'b').repeat(64),reviewerId:'owner',projects:selector==='fast'?[{projectId:'project-a',name:'Project A',repositoryIds:['public']}]:[],operations:[{name:'projects.list',description:'Discover controllers, projects and repositories',access:'read'}]}));`, { mode: 0o700 });
  const password = "browser-password", salt = Buffer.alloc(16, 9), hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  await writeFile(config, JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1:9081",
    operations: { hosts: [{ id: "slow", selector: "slow", executable }, { id: "fast", selector: "fast", executable }], consoles: [] },
    pluginHome: fileURLToPath(new URL("../../../", import.meta.url)), plugins: [{ package: "@slop-lab/dim-web-plugin-native-git" }],
    accounts: [{ username: "reader", passwordHash: `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`, roles: ["read"] }],
    session: { idleSeconds: 900, absoluteSeconds: 3600 } }), { mode: 0o600 });
  const web = await createWebServerFromConfigFile(config); cleanup.push(() => web.close());
  await expect(access(gate)).resolves.toBeUndefined();
  const base = await web.listen(), origin = "http://127.0.0.1:9081";
  const login = await fetch(base + "/v1/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "reader", password }) });
  const session = await login.json() as { csrfToken: string };
  const headers = { origin, "content-type": "application/json", cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "", "x-dim-csrf": session.csrfToken };
  const catalog = await fetch(base + "/v1/extensions/native-git/operations/projects.list", { method: "POST", headers, body: "{}" });
  expect(catalog.status).toBe(200);
  await expect(catalog.json()).resolves.toMatchObject({ controllers: [
    { id: "slow", status: "unavailable", projects: [] },
    { id: "fast", status: "ready", projects: [{ projectId: "project-a", repositoryIds: ["public"] }] }
  ] });
  expect((await readFile(calls, "utf8")).match(/fast started/g)).toHaveLength(1);
  await expect(access(gate)).resolves.toBeUndefined();
  await unlink(gate);
});
