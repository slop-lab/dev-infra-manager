import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
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

const readinessToken = Buffer.alloc(32, 41).toString("base64url");
const activationToken = Buffer.alloc(32, 42).toString("base64url");
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installed native root admission service", () => {
  it("durably admits a real imported root, replays before proof, restarts inactive, and revokes", async () => {
    // Given
    const native = await nativeBundleReviewFixture("ordinary-root-admission");
    const envelope = await createBundleReview(native.service);
    const event = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
    if (event === undefined) throw new TypeError("ordinary review event is missing");
    const root = await temporaryRoot();
    const ordinary = await startOrdinary(root, native.service.origin);
    const registrar = authorization("ordinary-registrar", bundleSecrets.registrar);
    const reader = authorization("native-query", bundleSecrets.nativeQuery);
    const registerRequest = requestBody();

    // When
    const identity = await call(ordinary.origin, "GET", "/v1/native-root-admission/identity", reader);
    const preactivation = await call(ordinary.origin, "POST", admissionPath("register"), registrar, registerRequest);
    await activate(ordinary.origin);
    const registered = await call(ordinary.origin, "POST", admissionPath("register"), registrar, registerRequest);
    const admissionGeneration = admissionField(registered, "admissionGeneration");
    const receipt = await call(ordinary.origin, "POST", "/v1/native-root-ci-events",
      authorization("native-events", bundleSecrets.webhook),
      { schemaVersion: 1, generationId, admissionGeneration, event });
    const removedClaims = await call(ordinary.origin, "POST", "/v1/host-claims",
      authorization("host-a", bundleSecrets.host), {});
    const conflictingReplay = await call(ordinary.origin, "POST", admissionPath("current"), reader,
      { ...registerRequest, admissionGeneration });
    const currentRequest = { ...requestBody(), admissionGeneration };
    const current = await call(ordinary.origin, "POST", admissionPath("current"), reader, currentRequest);
    await close(ordinary.server);
    await close(native.service.server);
    const restarted = await startOrdinary(root, "http://127.0.0.1:1");
    const inactive = await call(restarted.origin, "POST", admissionPath("current"), reader, currentRequest);
    await activate(restarted.origin);
    const replayWithoutProof = await call(restarted.origin, "POST", admissionPath("register"), registrar, registerRequest);
    const receiptReplayWithoutProof = await call(restarted.origin, "POST", "/v1/native-root-ci-events",
      authorization("native-events", bundleSecrets.webhook),
      { schemaVersion: 1, generationId, admissionGeneration, event });
    const revokeRequest = { ...requestBody(), admissionGeneration };
    const revoked = await call(restarted.origin, "POST", admissionPath("revoke"), registrar, revokeRequest);
    const historicalCurrent = await call(restarted.origin, "POST", admissionPath("current"), reader, currentRequest);
    const absent = await call(restarted.origin, "POST", admissionPath("current"), reader, { ...requestBody(), admissionGeneration });
    const revokeReplay = await call(restarted.origin, "POST", admissionPath("revoke"), registrar, revokeRequest);

    // Then
    expect(identity).toEqual({ status: 200, body: { schemaVersion: 1, serviceId: "ordinary-main",
      servingGenerationId: generationId, role: "native-root-admission-reader",
      scope: ["imported-root-admission:read"] } });
    expect(preactivation.status).toBe(503);
    expect(registered.status).toBe(200);
    expect(receipt).toEqual({ status: 202, body: { schemaVersion: 1, generationId,
      admissionGeneration, eventId: event.eventId, recorded: true } });
    expect(removedClaims.status).toBe(404);
    expect(conflictingReplay.status).toBe(409);
    expect(current.body).toEqual({ ...bodyRecord(registered.body), requestId: currentRequest.requestId });
    expect(inactive.status).toBe(503);
    expect(replayWithoutProof).toEqual(registered);
    expect(receiptReplayWithoutProof).toEqual(receipt);
    expect(revoked.status).toBe(200);
    expect(historicalCurrent).toEqual(current);
    expect(absent.status).toBe(404);
    expect(revokeReplay).toEqual(revoked);
    expect(admissionRows(root)).toEqual([{ generation: admissionGeneration, state: "revoked" }]);
    expect(requestCount(root)).toBe(3);
    expect(receiptCount(root)).toBe(1);
    expect(demandRows(root)).toEqual([{ demandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      admissionGeneration, eventId: event.eventId,
      reviewId: event.reviewId, state: "superseded" }]);
  });

  it("rejects wrong role, generation, replay tuple, legacy surfaces, and proof outage without mutation", async () => {
    // Given
    const root = await temporaryRoot();
    const ordinary = await startOrdinary(root, "http://127.0.0.1:1");
    await activate(ordinary.origin);
    const registrar = authorization("ordinary-registrar", bundleSecrets.registrar);
    const reader = authorization("native-query", bundleSecrets.nativeQuery);
    const request = requestBody();

    // When
    const results = await Promise.all([
      call(ordinary.origin, "POST", admissionPath("register"), reader, request),
      call(ordinary.origin, "POST", admissionPath("register"), registrar, { ...request, generationId: "f".repeat(64) }),
      call(ordinary.origin, "POST", admissionPath("current"), reader, { ...request, admissionGeneration: randomUUID() }),
      call(ordinary.origin, "POST", admissionPath("register"), registrar, requestBody()),
      call(ordinary.origin, "POST", "/v1/operator-admissions", registrar, request),
      call(ordinary.origin, "POST", "/v1/native-events", registrar, request),
      call(ordinary.origin, "POST", "/v1/admission-verifications", reader, request)
    ]);

    // Then
    expect(results.map(({ status }) => status)).toEqual([404, 409, 404, 503, 404, 404, 404]);
    expect(admissionRows(root)).toEqual([]);
    expect(requestCount(root)).toBe(0);
  });

  it("rejects non-v4 request IDs before fetching proof or changing state", async () => {
    // Given
    const root = await temporaryRoot();
    const ordinary = await startOrdinary(root, "http://127.0.0.1:1");
    await activate(ordinary.origin);
    const registrar = authorization("ordinary-registrar", bundleSecrets.registrar);

    // When
    const result = await call(ordinary.origin, "POST", admissionPath("register"), registrar,
      { ...requestBody(), requestId: "00000000-0000-5000-8000-000000000001" });

    // Then
    expect(result.status).toBe(400);
    expect(admissionRows(root)).toEqual([]);
    expect(requestCount(root)).toBe(0);
  });

  it("orders receipt authentication and activation before strict bounded parsing", async () => {
    // Given
    const root = await temporaryRoot();
    const ordinary = await startOrdinary(root, "http://127.0.0.1:1");
    const endpoint = "/v1/native-root-ci-events";
    const webhook = authorization("native-events", bundleSecrets.webhook);
    const invalid = JSON.stringify({ executable: ["sh"] });

    // When
    const inactive = await rawCall(ordinary.origin, endpoint, webhook, invalid, "application/json");
    await activate(ordinary.origin);
    const unknown = await rawCall(ordinary.origin, endpoint, "Basic unknown", invalid, "application/json");
    const wrongRole = await rawCall(ordinary.origin, endpoint,
      authorization("native-query", bundleSecrets.nativeQuery), invalid, "application/json");
    const wrongType = await rawCall(ordinary.origin, endpoint, webhook, invalid, "text/plain");
    const malformed = await rawCall(ordinary.origin, endpoint, webhook, invalid, "application/json");
    const oversized = await rawCall(ordinary.origin, endpoint, webhook, `"${"x".repeat(65_537)}"`, "application/json");
    const query = await rawCall(ordinary.origin, `${endpoint}?event=1`, webhook, invalid, "application/json");

    // Then
    expect([inactive.status, unknown.status, wrongRole.status, wrongType.status, malformed.status,
      oversized.status, query.status]).toEqual([503, 401, 403, 415, 400, 413, 404]);
    expect(receiptCount(root)).toBe(0);
  });
});

async function startOrdinary(root: string, nativeOrigin: string): Promise<Service> {
  const nodeClient = createNodeNativeGitAdmissionHttpClient();
  const server = await configuredNativeRootAdmissionServer({
    config: parseNativeOrdinaryBundleConfig(idleOrdinaryConfig()),
    stateDirectory: join(root, "ordinary"), readinessToken, activationToken, expectedGenerationId: generationId,
    proofHttpClient: { request: (input) => nodeClient.request({ ...input, endpoint: nativeOrigin }) }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("ordinary listener is unavailable");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-admission-"));
  roots.push(root);
  return root;
}

function admissionPath(operation: "register" | "current" | "revoke"): string {
  return `/v1/projects/project-a/repositories/root/native-root-admission/${operation}`;
}
function requestBody() { return { schemaVersion: 1, requestId: randomUUID(), generationId } as const; }
function authorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
function activate(origin: string): Promise<HttpResult> {
  return call(origin, "POST", "/v1/activation", `Bearer ${activationToken}`,
    { schemaVersion: 1, generationId });
}
async function call(origin: string, method: "GET" | "POST", path: string,
  authorizationHeader: string, body?: object): Promise<HttpResult> {
  const response = await fetch(`${origin}${path}`, { method, headers: { authorization: authorizationHeader,
    ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function rawCall(origin: string, path: string, authorizationHeader: string,
  body: string, contentType: string): Promise<HttpResult> {
  const response = await fetch(`${origin}${path}`, { method: "POST",
    headers: { authorization: authorizationHeader, "content-type": contentType }, body });
  return { status: response.status, body: await response.json() };
}
function admissionField(result: HttpResult, field: string): string {
  if (typeof result.body !== "object" || result.body === null) throw new TypeError("response is invalid");
  const admission = Reflect.get(result.body, "admission");
  if (typeof admission !== "object" || admission === null) throw new TypeError("admission is invalid");
  const value = Reflect.get(admission, field);
  if (typeof value !== "string") throw new TypeError("admission field is invalid");
  return value;
}
function bodyRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("response is invalid");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
function admissionRows(root: string): readonly { readonly generation: string; readonly state: string }[] {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"), { readOnly: true });
  const rows = database.prepare("SELECT admission_generation, state FROM native_root_admissions ORDER BY created_at").all()
    .map((row) => ({ generation: String(row.admission_generation), state: String(row.state) }));
  database.close();
  return rows;
}
function requestCount(root: string): number {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"), { readOnly: true });
  const row = database.prepare("SELECT COUNT(*) AS count FROM native_root_admission_requests").get();
  database.close();
  return Number(row?.count);
}
function receiptCount(root: string): number {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"), { readOnly: true });
  const row = database.prepare("SELECT COUNT(*) AS count FROM native_root_ci_event_receipts").get();
  database.close();
  return Number(row?.count);
}
function demandRows(root: string): readonly Readonly<Record<string, string>>[] {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"), { readOnly: true });
  const rows = database.prepare(`SELECT demand_id, admission_generation, event_id, review_id, state
    FROM native_root_ci_demands ORDER BY created_at, demand_id`).all().map((row) => ({
      demandId: String(row.demand_id), admissionGeneration: String(row.admission_generation), eventId: String(row.event_id),
      reviewId: String(row.review_id), state: String(row.state)
    }));
  database.close();
  return rows;
}
type Service = { readonly server: Server; readonly origin: string };
type HttpResult = { readonly status: number; readonly body: unknown };
