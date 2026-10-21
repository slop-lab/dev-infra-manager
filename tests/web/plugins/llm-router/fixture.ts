import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "../../../../packages/control-plane/plugins/llm-router/src/server.js";
import { parseConfig, defaultLimits, backendProfile } from "../../../../packages/control-plane/plugins/llm-router/src/config.js";
import { initializeOperationsWeb } from "../../../../packages/web/core/src/initialize.js";
import { createWebServerFromConfigFile } from "../../../../packages/web/core/src/server.js";
import { createServer as portServer } from "node:net";
export async function llmWebFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-web-plugin-"));
  const cleanup: Array<() => Promise<unknown>> = [() => rm(root, { recursive: true, force: true })];
  const privateWrite = async (name: string, value: string) => { const file = join(root, name); await writeFile(file, value, { mode: 0o600 }); return file; };
  try {
    let inferenceRequests = 0;
    const backend = createServer((request, response) => { if (request.url !== "/v1/models") inferenceRequests++; response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => { backend.closeAllConnections(); backend.close(() => resolve()); }));
    const backendAddress = backend.address(); if (!backendAddress || typeof backendAddress === "string") throw new Error("missing backend address");
    const operatorKey = randomBytes(32).toString("base64url"), keyFile = await privateWrite("operator.key", operatorKey);
    const config = parseConfig({ schemaVersion: 3, stateDirectory: join(root, "router-state"), listen: { host: "127.0.0.1", port: 8318 }, backend: backendProfile,
      accounts: [{ id: "account-one", reference: "Dedicated test account", endpoint: `http://127.0.0.1:${backendAddress.port}`, keyFile: await privateWrite("provider.key", randomBytes(32).toString("base64url")) }],
      routes: [{ id: "default", accountId: "account-one", models: [{ id: "model-one", name: "Test model", api: "responses", context: 1000, output: 100 }] }], limits: defaultLimits, hostIssuers: [], operators: [{ id: "web-admin", keyFile, role: "operator" }] });
    const router = await createRouter(config); cleanup.push(() => router.close());
    router.ledger.createProject("example", { allowedRoutes: ["default"], limits: defaultLimits, captureMode: "required", tokenMode: "observe" });
    await new Promise<void>((resolve) => router.server.listen(0, "127.0.0.1", resolve));
    const address = router.server.address(); if (!address || typeof address === "string") throw new Error("missing router address");
    const connectionFile = await privateWrite("operator.json", JSON.stringify({ schemaVersion: 1, endpoint: `http://127.0.0.1:${address.port}`, actorId: "web-admin", keyFile }));
    const server = portServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = server.address(); if (!port || typeof port === "string") throw new Error("missing web port"); await new Promise<void>((resolve) => server.close(() => resolve()));
    const settings = await privateWrite("operations.json", JSON.stringify({ hosts: [] })), configPath = join(root, "web.json");
    const browser = await initializeOperationsWeb({ operations: settings, output: configPath, port: port.port });
    const saved = JSON.parse(await readFile(configPath, "utf8")) as { accounts: Array<{ username: string; roles: string[]; passwordHash: string }> };
    const account = saved.accounts[0]!; saved.accounts.push({ ...account, username: "observer", roles: ["read"] });
    await writeFile(configPath, JSON.stringify({ ...saved, pluginHome: dirname(fileURLToPath(new URL("../../../package.json", import.meta.url))), plugins: [
      { package: "@slop-lab/dim-web-plugin-llm-router", config: { connectionFile } },
      { package: "@slop-lab/dim-web-plugin-native-git" }
    ] }), { mode: 0o600 });
    let web = await createWebServerFromConfigFile(configPath); cleanup.push(() => web.close());
    return { root, configPath, connectionFile, keyFile, operatorKey, origin: await web.listen(), password: browser.password, username: browser.username, router,
      inferenceRequests: () => inferenceRequests,
      async restartWeb() { await web.close(); web = await createWebServerFromConfigFile(configPath); await web.listen(); },
      async login(username = browser.username) {
        const response = await fetch(this.origin + "/v1/session", { method: "POST", headers: { origin: this.origin, "content-type": "application/json" }, body: JSON.stringify({ username, password: browser.password }) });
        const body = await response.json() as { csrfToken: string }; const cookie = response.headers.get("set-cookie")?.split(";")[0];
        if (response.status !== 201 || !cookie) throw new Error("fixture login failed"); return { origin: this.origin, cookie, "x-dim-csrf": body.csrfToken, "content-type": "application/json" };
      },
      async close() { for (const close of cleanup.reverse()) await close(); }
    };
  } catch (error) { for (const close of cleanup.reverse()) await close(); throw error; }
}
