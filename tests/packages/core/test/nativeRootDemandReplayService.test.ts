import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionHttpClient.js";
import { parseNativeOrdinaryBundleConfig } from "../../../../core/packages/core/src/nativeOrdinaryBundleConfig.js";
import { configuredNativeRootAdmissionServer } from "../../../../core/packages/core/src/nativeRootAdmissionService.js";
import { bundleSecrets, idleOrdinaryConfig } from "../../native-git/test/bundleConfigFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "../../native-git/test/nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const readinessToken = Buffer.alloc(32, 51).toString("base64url");
const activationToken = Buffer.alloc(32, 52).toString("base64url");
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installed native root demand replay", () => {
  it("converges a lost receipt acknowledgement after restart without requeueing demand", async () => {
    // Given
    const native = await nativeBundleReviewFixture("ordinary-root-demand-replay");
    const envelope = await createBundleReview(native.service);
    const event = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
    if (event === undefined) throw new TypeError("ordinary review event is missing");
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-demand-replay-"));
    roots.push(root);
    const ordinary = await startOrdinary(root, native.service.origin);
    await post(ordinary.origin, "/v1/activation", `Bearer ${activationToken}`, { schemaVersion: 1, generationId });
    const registered = await post(ordinary.origin,
      "/v1/projects/project-a/repositories/root/native-root-admission/register",
      authorization("ordinary-registrar", bundleSecrets.registrar),
      { schemaVersion: 1, requestId: randomUUID(), generationId });
    const admissionGeneration = admissionField(registered.body);
    const receipt = { schemaVersion: 1, generationId, admissionGeneration, event };

    // When
    await sendWithoutReadingAcknowledgement(ordinary.origin, "/v1/native-root-ci-events",
      authorization("native-events", bundleSecrets.webhook), receipt);
    await close(ordinary.server);
    await close(native.service.server);
    const restarted = await startOrdinary(root, "http://127.0.0.1:1");
    await post(restarted.origin, "/v1/activation", `Bearer ${activationToken}`, { schemaVersion: 1, generationId });
    const replay = await post(restarted.origin, "/v1/native-root-ci-events",
      authorization("native-events", bundleSecrets.webhook), receipt);

    // Then
    expect(replay.status).toBe(202);
    expect(rows(root, "native_root_ci_event_receipts")).toBe(1);
    expect(demands(root)).toEqual([{ demandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      admissionGeneration, eventId: event.eventId,
      reviewId: event.reviewId, state: "queued" }]);
  });
});

async function startOrdinary(root: string, nativeOrigin: string): Promise<Service> {
  const nodeClient = createNodeNativeGitAdmissionHttpClient();
  const server = await configuredNativeRootAdmissionServer({
    config: parseNativeOrdinaryBundleConfig(idleOrdinaryConfig()), stateDirectory: join(root, "ordinary"),
    readinessToken, activationToken, expectedGenerationId: generationId,
    proofHttpClient: { request: (input) => nodeClient.request({ ...input, endpoint: nativeOrigin }) }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("ordinary listener is unavailable");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function post(origin: string, path: string, authorization: string, body: object): Promise<HttpResult> {
  const response = await fetch(`${origin}${path}`, { method: "POST",
    headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function sendWithoutReadingAcknowledgement(origin: string, path: string,
  authorization: string, body: object): Promise<void> {
  const payload = JSON.stringify(body);
  await new Promise<void>((resolve, reject) => {
    const outgoing = request(`${origin}${path}`, { method: "POST", headers: { authorization,
      "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (incoming) => {
      incoming.destroy();
      resolve();
    });
    outgoing.once("error", reject);
    outgoing.end(payload);
  });
}
function authorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
function admissionField(body: unknown): string {
  const admission = typeof body === "object" && body !== null ? Reflect.get(body, "admission") : undefined;
  const value = typeof admission === "object" && admission !== null
    ? Reflect.get(admission, "admissionGeneration") : undefined;
  if (typeof value !== "string") throw new TypeError("admission generation is unavailable");
  return value;
}
function rows(root: string, table: "native_root_ci_event_receipts"): number {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"), { readOnly: true });
  const count = Number(database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get()?.value);
  database.close();
  return count;
}
function demands(root: string): readonly Readonly<Record<string, string>>[] {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"), { readOnly: true });
  const values = database.prepare(`SELECT demand_id, admission_generation, event_id, review_id, state
    FROM native_root_ci_demands ORDER BY created_at, demand_id`).all().map((row) => ({
      demandId: String(row.demand_id), admissionGeneration: String(row.admission_generation), eventId: String(row.event_id),
      reviewId: String(row.review_id), state: String(row.state)
    }));
  database.close();
  return values;
}
async function close(server: Server): Promise<void> {
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

type Service = { readonly server: Server; readonly origin: string };
type HttpResult = { readonly status: number; readonly body: unknown };
