import { scryptSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWebServerFromConfigFile } from "../../packages/web/core/src/server.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

type FeatureCatalogEntry = {
  readonly generation: number;
  readonly id: string;
  readonly status: string;
};

async function waitForFile(path: string): Promise<void> {
  await expect.poll(async () => readFile(path, "utf8").catch(() => ""), { timeout: 2_000 }).toBe("started");
}

it("fences every tab from a superseded plugin runtime generation", async () => {
  // Given: two tabs share a session and tab A holds a mutation on authority A.
  const root = await mkdtemp(join(tmpdir(), "dim-web-plugin-generation-")); roots.push(root);
  const authorityPath = join(root, "authority.txt"), startedPath = join(root, "started.txt"), releasePath = join(root, "release.txt"), reconnectStartedPath = join(root, "reconnect-started.txt"), reconnectReleasePath = join(root, "reconnect-release.txt"), callsPath = join(root, "calls.json");
  await writeFile(authorityPath, "A"); await writeFile(callsPath, "[]");
  const directory = join(root, "node_modules/race-feature"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "race-feature", type: "module", main: "index.js" }));
  await writeFile(join(directory, "panel.js"), "export function mount() {}\n");
  await writeFile(join(directory, "index.js"), `import fs from 'node:fs/promises';
const operation={name:'change',description:'Generation race fixture',access:'operator',parseInput(value){return value;},parseOutput(value){return value;}};
const waitForRelease=async(path)=>{while(true){try{await fs.access(path);return;}catch{await new Promise(resolve=>setTimeout(resolve,5));}}};
export const webPlugin={id:'race',title:'Race',description:'Generation race fixture',operations:[operation],assets:{'panel.js':new URL('./panel.js',import.meta.url)},browserEntry:'panel.js',async create(config){const authority=(await fs.readFile(config.authorityPath,'utf8')).trim();if(authority!=='A'){await fs.writeFile(config.reconnectStartedPath,'started');await waitForRelease(config.reconnectReleasePath);}return {async invoke(_name,input){const calls=JSON.parse(await fs.readFile(config.callsPath,'utf8'));calls.push({authority,input});await fs.writeFile(config.callsPath,JSON.stringify(calls));if(input.hold){await fs.writeFile(config.startedPath,'started');await waitForRelease(config.releasePath);}return {receipt:authority};}};}};
`);
  const origin = "http://127.0.0.1:9081", salt = Buffer.alloc(16, 9), hash = scryptSync("browser-password", salt, 32, { N: 16384, r: 8, p: 1 });
  const config = join(root, "web.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port: 0, publicOrigin: origin,
    accounts: [
      { username: "operator", passwordHash: `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`, roles: ["read", "operator"] },
      { username: "reader", passwordHash: `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`, roles: ["read"] }
    ],
    pluginHome: root, plugins: [{ package: "race-feature", config: { authorityPath, startedPath, releasePath, reconnectStartedPath, reconnectReleasePath, callsPath } }], session: { idleSeconds: 900, absoluteSeconds: 3600 } }), { mode: 0o600 });
  const web = await createWebServerFromConfigFile(config);
  try {
    const base = await web.listen();
    const operatorLogin = await fetch(base + "/v1/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "operator", password: "browser-password" }) });
    const operatorSession = await operatorLogin.json() as { csrfToken: string };
    const operatorHeaders = { origin, "content-type": "application/json", cookie: operatorLogin.headers.get("set-cookie")?.split(";")[0] ?? "", "x-dim-csrf": operatorSession.csrfToken };
    const readerLogin = await fetch(base + "/v1/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "reader", password: "browser-password" }) });
    const readerSession = await readerLogin.json() as { csrfToken: string };
    const readerHeaders = { origin, "content-type": "application/json", cookie: readerLogin.headers.get("set-cookie")?.split(";")[0] ?? "", "x-dim-csrf": readerSession.csrfToken };
    const catalogResponse = await fetch(base + "/v1/extensions", { headers: { cookie: operatorHeaders.cookie } });
    const [tabACatalog] = await catalogResponse.json() as FeatureCatalogEntry[];
    expect(tabACatalog).toMatchObject({ id: "race", status: "ready", generation: expect.any(Number) });
    const tabAMutation = fetch(base + "/v1/extensions/race/operations/change", { method: "POST", headers: { ...operatorHeaders, "x-dim-plugin-generation": String(tabACatalog?.generation) }, body: JSON.stringify({ hold: true }) });
    await waitForFile(startedPath);

    // When: tab B changes the private selection to B and reconnects the shared server runtime.
    await writeFile(authorityPath, "B");
    const reconnectPending = fetch(base + "/v1/extensions/race/reconnect", { method: "POST", headers: readerHeaders, body: "{}" });
    await waitForFile(reconnectStartedPath);
    const reconnectingResponse = await fetch(base + "/v1/extensions/race/operations/change", { method: "POST", headers: { ...operatorHeaders, "x-dim-plugin-generation": String(tabACatalog?.generation) }, body: JSON.stringify({ hold: false }) });
    expect(reconnectingResponse.status).toBe(409);
    await writeFile(reconnectReleasePath, "release");
    const reconnect = await reconnectPending;
    expect(reconnect.status).toBe(200);
    const tabBCatalog = await reconnect.json() as FeatureCatalogEntry;
    expect(tabBCatalog.generation).toBeGreaterThan(tabACatalog?.generation ?? Number.MAX_SAFE_INTEGER);
    await writeFile(releasePath, "release");

    // Then: A's late receipt is unknown, and A's stale catalog cannot dispatch against B.
    const lateResponse = await tabAMutation;
    expect(lateResponse.status).toBeGreaterThanOrEqual(500);
    expect(await lateResponse.json()).toEqual({ error: "The feature connection changed while this operation was pending. Its outcome is unknown; refresh current state before retrying." });
    const staleResponse = await fetch(base + "/v1/extensions/race/operations/change", { method: "POST", headers: { ...operatorHeaders, "x-dim-plugin-generation": String(tabACatalog?.generation) }, body: JSON.stringify({ hold: false }) });
    expect(staleResponse.status).toBe(409);
    expect(JSON.parse(await readFile(callsPath, "utf8"))).toEqual([{ authority: "A", input: { hold: true } }]);

    const tabAReconnect = await fetch(base + "/v1/extensions/race/reconnect", { method: "POST", headers: operatorHeaders, body: "{}" });
    const tabAFreshCatalog = await tabAReconnect.json() as FeatureCatalogEntry;
    const freshResponse = await fetch(base + "/v1/extensions/race/operations/change", { method: "POST", headers: { ...operatorHeaders, "x-dim-plugin-generation": String(tabAFreshCatalog.generation) }, body: JSON.stringify({ hold: false }) });
    expect(await freshResponse.json()).toEqual({ receipt: "B" });
    expect(JSON.parse(await readFile(callsPath, "utf8"))).toEqual([{ authority: "A", input: { hold: true } }, { authority: "B", input: { hold: false } }]);

    await writeFile(authorityPath, "C"); await rm(reconnectStartedPath, { force: true }); await rm(reconnectReleasePath, { force: true });
    const revokedReconnect = fetch(base + "/v1/extensions/race/reconnect", { method: "POST", headers: readerHeaders, body: "{}" });
    await waitForFile(reconnectStartedPath);
    const logout = await fetch(base + "/v1/session", { method: "DELETE", headers: readerHeaders });
    expect(logout.status).toBe(204);
    await writeFile(reconnectReleasePath, "release");
    expect((await revokedReconnect).status).toBe(401);
  } finally { await writeFile(releasePath, "release"); await web.close(); }
});
