import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deterministicProvider, fixtureModel } from "./provider.ts";

const setup = process.argv[2], data = process.env.DIM_DATA_HOME;
if (!setup?.startsWith("/") || !data) throw new Error("separate CP fixture requires its prepared private installation");
const resolver = createRequire(join(data, "control-plane/runtime/current/package.json"));
const llm: typeof import("../../../../packages/control-plane/plugins/llm-router/src/index.js") = await import(pathToFileURL(resolver.resolve("@slop-lab/dim-control-plane-plugin-llm-router")).href);
const urls: typeof import("../../../../packages/control-plane/plugins/external-urls/src/index.js") = await import(pathToFileURL(resolver.resolve("@slop-lab/dim-control-plane-plugin-external-urls")).href);
const directory = join(setup, "practical"), state = join(data, "practical-ci-services"); await mkdir(state, { mode: 0o700 });
const key = randomBytes(32).toString("base64url"), backendKey = join(state, "backend.key");
await writeFile(backendKey, key, { mode: 0o600, flag: "wx" });
const provider = deterministicProvider(key); provider.listen(0, "127.0.0.1"); await once(provider, "listening");
const address = provider.address(); if (!address || typeof address === "string") throw new Error("test-only provider has no listener");
const limits = { concurrent: 4, requestsPerUtcDay: 20, requestBytes: 2 * 1024 * 1024, responseBytes: 2 * 1024 * 1024, captureBytesPerProject: 20 * 1024 * 1024, deadlineMilliseconds: 120_000 };
const router = await llm.createRouter(llm.parseConfig({ schemaVersion: 3, stateDirectory: join(state, "llm"), listen: { host: "127.0.0.1", port: 18318 },
  backend: { name: "CLIProxyAPI", version: "8.0.33", accountSelection: "exclusive-worker", attemptVisibility: "request-only", cancellation: "best-effort" },
  accounts: [{ id: "deterministic-fixture", reference: "test-only-not-provider-qualification", endpoint: `http://127.0.0.1:${address.port}`, keyFile: backendKey }],
  routes: [{ id: "ci", accountId: "deterministic-fixture", models: [{ id: fixtureModel, name: "TEST ONLY deterministic file tool protocol", api: "chat", context: 32768, output: 4096 }] }], limits,
  hostIssuers: [{ id: "practical-host", keyFile: join(directory, "issuer.key"), projects: [{ id: "practical-ci", routeIds: ["ci"] }] }],
  operators: [{ id: "practical-reader", keyFile: join(directory, "reader.key"), role: "read" }] }));
router.ledger.createProject("practical-ci", { allowedRoutes: ["ci"], limits, captureMode: "metadata", tokenMode: "observe" });
router.server.listen(18318, "127.0.0.1"); await once(router.server, "listening");
const abort = new AbortController();
const ingress = await urls.startExternalUrlIngress({ schemaVersion: 1, domain: "ci.localhost", publicListen: { host: "127.0.0.1", port: 18443 }, managementListen: { host: "127.0.0.1", port: 18444 },
  hosts: [{ id: "practical-host", token: (await readFile(join(directory, "ingress.key"), "utf8")).trim(), relayOrigin: "http://127.0.0.1:18445" }] }, abort.signal);
const native = spawn(process.execPath, [resolve(import.meta.dirname, "../../../../scripts/examples/serve-control-plane.ts"), setup], { stdio: "inherit" });
try {
  console.log("practical-ci-control-plane-ready: installed router/ingress, deterministic TEST-ONLY provider, bounded 20-request project");
  await new Promise<void>((done, reject) => { process.once("SIGTERM", done); process.once("SIGINT", done); native.once("error", reject); native.once("exit", (code) => reject(new Error(`separate native CP exited ${code}`))); });
} finally {
  abort.abort(); native.kill("SIGTERM");
  await ingress.close(); await router.close(); provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done()));
}
