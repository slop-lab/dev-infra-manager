import { request as httpRequest, createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { backendProfile, defaultLimits, parseConfig } from "../../../packages/control-plane/plugins/llm-router/src/config.js";
import { RouterLedger } from "../../../packages/control-plane/plugins/llm-router/src/ledger.js";
import { RouterOperationRejectedError } from "../../../packages/control-plane/plugins/llm-router/src/operation-errors.js";
import { createRouter } from "../../../packages/control-plane/plugins/llm-router/src/server.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener address");
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(test: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-router-cancel-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const providerKeyFile = join(root, "provider.key");
  await writeFile(providerKeyFile, "provider-key", { mode: 0o600 });
  let pending: ServerResponse | undefined;
  const upstream = createServer((_request, response) => {
    pending = response;
  });
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
    hostIssuers: []
  });
  const router = await createRouter(config);
  cleanup.push(() => router.close());
  const origin = await listen(router.server);
  const workspace = workspaceRecord();
  router.ledger.createProject(workspace.id, { allowedRoutes: ["default"], limits: defaultLimits, captureMode: "required", tokenMode: "observe" });
  const token = router.ledger.issue(workspace, "default", workspace.id);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return { router, origin, headers, token, pending: () => pending };
}

function reserve(ledger: RouterLedger, token: string): string {
  const grant = ledger.authenticate(token);
  if (grant === undefined) throw new Error("fixture principal was not authenticated");
  return ledger.reserve(grant, "test-model", "policy", 2, defaultLimits, { accountId: "provider" }).id;
}

it("rejects a settled ledger cancellation without auditing or persisting intent", async () => {
  // Given: a request has already settled.
  const fx = await fixture();
  const requestId = reserve(fx.router.ledger, fx.token);
  fx.router.ledger.finish(requestId, { outcome: "completed", captureComplete: false });

  // When: cancellation is requested after settlement.
  const error = expect(() => fx.router.ledger.cancel(requestId));

  // Then: the known rejection has no cancellation side effect or audit claim.
  error.toThrow(RouterOperationRejectedError);
  expect(fx.router.ledger.request(requestId)).toMatchObject({ cancel_requested: 0, outcome: "completed" });
  expect(fx.router.ledger.database.prepare("SELECT COUNT(*) AS count FROM audit WHERE operation='request.cancel'").get()?.count).toBe(0);
});

it("persists one idempotent cancellation intent for unresolved occupied work", async () => {
  // Given: dispatched work was recovered with an unknown upstream outcome.
  const fx = await fixture();
  const requestId = reserve(fx.router.ledger, fx.token);
  fx.router.ledger.dispatch(requestId);
  fx.router.ledger.recoverInterrupted();

  // When: the same cancellation intent is requested twice.
  fx.router.ledger.cancel(requestId);
  fx.router.ledger.cancel(requestId);

  // Then: the intent remains durable and only the newly persisted transition is audited.
  expect(fx.router.ledger.request(requestId)).toMatchObject({ cancel_requested: 1, outcome: "uncertain", occupied: 1 });
  expect(fx.router.ledger.database.prepare("SELECT COUNT(*) AS count FROM audit WHERE operation='request.cancel'").get()?.count).toBe(1);
});

it("returns HTTP 409 when completion wins the cancellation race", async () => {
  // Given: inference is running and a cancellation request has sent headers but not its body terminator.
  const fx = await fixture();
  const inference = fetch(`${fx.origin}/v1/responses`, {
    method: "POST",
    headers: fx.headers,
    body: JSON.stringify({ model: "test-model", input: [] })
  });
  await waitFor(() => fx.pending() !== undefined);
  const active = fx.router.ledger.database.prepare("SELECT id FROM requests WHERE outcome='running'").get();
  if (typeof active?.id !== "string") throw new Error("missing active request");
  const cancellation = new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const request = httpRequest(`${fx.origin}/v1/requests/${active.id}/cancel`, { method: "POST", headers: fx.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.flushHeaders();
    fx.pending()?.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "completed", model: "test-model", output: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    void inference.then((response) => response.arrayBuffer()).then(() => request.end(), reject);
  });

  // When: completion commits before the cancellation handler attempts its ledger update.
  const response = await cancellation;

  // Then: HTTP reports a known conflict and no false intent is persisted.
  expect(response.status).toBe(409);
  expect(JSON.parse(response.body)).toMatchObject({ error: { category: "operation_failed" } });
  expect(fx.router.ledger.request(active.id)).toMatchObject({ outcome: "completed", cancel_requested: 0 });
});

it("accepts HTTP cancellation for unresolved occupied work only after persisting intent", async () => {
  // Given: a workspace-owned request has unresolved occupied upstream work.
  const fx = await fixture();
  const requestId = reserve(fx.router.ledger, fx.token);
  fx.router.ledger.dispatch(requestId);
  fx.router.ledger.recoverInterrupted();

  // When: the workspace principal requests cancellation through the real HTTP endpoint.
  const response = await fetch(`${fx.origin}/v1/requests/${requestId}/cancel`, { method: "POST", headers: fx.headers });

  // Then: the positive receipt corresponds to the durable intent without claiming termination.
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ requestId, cancellationRequested: true, upstreamTerminationConfirmed: false });
  expect(fx.router.ledger.request(requestId)).toMatchObject({ cancel_requested: 1, occupied: 1 });
});
