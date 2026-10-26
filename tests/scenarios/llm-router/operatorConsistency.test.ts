import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { backendProfile, defaultLimits, parseConfig } from "../../../packages/control-plane/plugins/llm-router/src/config.js";
import { createRouterOperatorServer } from "../../../packages/control-plane/plugins/llm-router/src/operator-server.js";
import { createRouter } from "../../../packages/control-plane/plugins/llm-router/src/server.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener address");
  return `http://127.0.0.1:${address.port}`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-router-consistency-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const operatorKey = randomBytes(32).toString("base64url");
  const operatorKeyFile = join(root, "operator.key");
  const providerKeyFile = join(root, "provider.key");
  await writeFile(operatorKeyFile, operatorKey, { mode: 0o600 });
  await writeFile(providerKeyFile, "provider-key", { mode: 0o600 });
  const upstream = createServer((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}'));
  const upstreamEndpoint = await listen(upstream);
  cleanup.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const config = parseConfig({
    schemaVersion: 3,
    stateDirectory: join(root, "state"),
    listen: { host: "127.0.0.1", port: 8318 },
    backend: backendProfile,
    accounts: [{ id: "provider", reference: "Provider", endpoint: upstreamEndpoint, keyFile: providerKeyFile }],
    routes: [{ id: "default", accountId: "provider", models: [{ id: "test-model", name: "Test", api: "responses", context: 1000, output: 100 }] }],
    limits: defaultLimits,
    hostIssuers: [],
    operators: [{ id: "operator", keyFile: operatorKeyFile, role: "operator" }]
  });
  const router = await createRouter(config);
  cleanup.push(() => router.close());
  const routerEndpoint = await listen(router.server);
  const operator = await createRouterOperatorServer(config);
  cleanup.push(() => operator.close());
  const operatorEndpoint = await listen(operator.server);
  const authorization = `Basic ${Buffer.from(`operator:${operatorKey}`).toString("base64")}`;
  const invoke = (endpoint: string, name: string, input: unknown, signal?: AbortSignal) => fetch(`${endpoint}/v1/operator/operations/${name}`, {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  return { root, config, router, routerEndpoint, operatorEndpoint, invoke };
}

it("does not let an authoritative account read claim absence while a disconnected create is still publishing", async () => {
  // Given: account enrollment is held after owner dispatch but before catalog publication.
  const fx = await fixture();
  const held = Promise.withResolvers<void>();
  let release: ServerResponse | undefined;
  const control = createServer((_request, response) => {
    release = response;
    held.resolve();
  });
  const controlEndpoint = await listen(control);
  cleanup.push(async () => {
    control.closeAllConnections();
    await new Promise<void>((resolve) => control.close(() => resolve()));
  });
  const executable = join(fx.root, "held-backend.mjs");
  await writeFile(executable, `#!${process.execPath}\nimport { get } from "node:http";\nget("${controlEndpoint}/hold", (response) => { response.resume(); response.on("end", () => console.log("CLIProxyAPI Version: 8.0.33")); }).on("error", (error) => { throw error; });\n`, { mode: 0o700 });
  fx.config.accountManagement = { backendExecutable: executable };
  const cancellation = new AbortController();
  const creation = fx.invoke(fx.routerEndpoint, "account.create", { accountId: "held-account", provider: "openai", endpoint: "https://api.example.test/v1", apiKey: "private-key" }, cancellation.signal).catch((error: unknown) => error);
  await held.promise;
  cancellation.abort();
  await creation;

  // When: another listener performs the authoritative account metadata read.
  const read = fx.invoke(fx.operatorEndpoint, "accounts", {});
  const observed = await Promise.race([
    read.then(() => "completed" as const),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250))
  ]);
  release?.end();

  // Then: the read waits for the owner operation and observes the published account.
  expect(observed).toBe("blocked");
  const response = await read;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "held-account" })]));
});

it("returns 5xx when post-commit audit fails while preserving the committed project state", async () => {
  // Given: a project exists and only the outer operation audit append will fail.
  const fx = await fixture();
  const created = await fx.invoke(fx.routerEndpoint, "project.create", { projectId: "demo", routeId: "default" });
  expect(created.status).toBe(200);
  const audit = fx.router.ledger.audit.bind(fx.router.ledger);
  vi.spyOn(fx.router.ledger, "audit").mockImplementation((actor, operation, target, detail) => {
    if (operation === "remote.project.state") throw new Error("synthetic post-commit audit failure");
    audit(actor, operation, target, detail);
  });

  // When: the owner commits a pause and then cannot append the operation audit record.
  const response = await fx.invoke(fx.routerEndpoint, "project.state", { projectId: "demo", action: "pause" });

  // Then: HTTP reports uncertainty, while authoritative state retains the committed effect.
  expect(response.status).toBe(503);
  expect(fx.router.ledger.project("demo")).toMatchObject({ paused: true });
});
