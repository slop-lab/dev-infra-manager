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

const readinessToken = Buffer.alloc(32, 61).toString("base64url");
const activationToken = Buffer.alloc(32, 62).toString("base64url");
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root CI event receipt proof races", () => {
  it("conflicts when admission is revoked after the real proof returns", async () => {
    // Given
    const fixture = await raceFixture("receipt-revoke-race");

    // When
    const pending = fixture.sendReceipt();
    await fixture.proofReturned.promise;
    const revoked = await call(fixture.origin, admissionPath("revoke"), registrarAuthorization(), {
      schemaVersion: 1, requestId: randomUUID(), generationId, admissionGeneration: fixture.admissionGeneration
    });
    fixture.releaseProof.resolve();
    const raced = await pending;
    const inactivePreflight = await fixture.sendReceipt();

    // Then
    expect([revoked.status, raced.status, inactivePreflight.status]).toEqual([200, 409, 404]);
    expect(receiptCount(fixture.root)).toBe(0);
  });

  it("conflicts when admission expires after the real proof returns", async () => {
    // Given
    const fixture = await raceFixture("receipt-expiry-race");

    // When
    const pending = fixture.sendReceipt();
    await fixture.proofReturned.promise;
    fixture.clock.value = fixture.expiresAt;
    fixture.releaseProof.resolve();
    const raced = await pending;
    const inactivePreflight = await fixture.sendReceipt();

    // Then
    expect([raced.status, inactivePreflight.status]).toEqual([409, 404]);
    expect(receiptCount(fixture.root)).toBe(0);
  });

  it("conflicts when durable activation changes after the real proof returns", async () => {
    // Given
    const fixture = await raceFixture("receipt-activation-race");

    // When
    const pending = fixture.sendReceipt();
    await fixture.proofReturned.promise;
    replaceActivationDigest(fixture.root);
    fixture.releaseProof.resolve();
    const raced = await pending;

    // Then
    expect(raced.status).toBe(409);
    expect(receiptCount(fixture.root)).toBe(0);
  });
});

async function raceFixture(label: string) {
  const native = await nativeBundleReviewFixture(label);
  const envelope = await createBundleReview(native.service);
  const event = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
  if (event === undefined) throw new TypeError("ordinary review event is missing");
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-receipt-race-"));
  roots.push(root);
  const proofReturned = deferred();
  const releaseProof = deferred();
  const nodeClient = createNodeNativeGitAdmissionHttpClient();
  const clock = { value: 1_000 };
  const server = await configuredNativeRootAdmissionServer({
    config: parseNativeOrdinaryBundleConfig(idleOrdinaryConfig()), stateDirectory: join(root, "ordinary"),
    readinessToken, activationToken, expectedGenerationId: generationId, now: () => clock.value,
    proofHttpClient: { request: async (input) => {
      const response = await nodeClient.request({ ...input, endpoint: native.service.origin });
      if (input.path.endsWith("/review-event")) {
        proofReturned.resolve();
        await releaseProof.promise;
      }
      return response;
    } }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("ordinary listener is unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  await call(origin, "/v1/activation", `Bearer ${activationToken}`, { schemaVersion: 1, generationId });
  const registered = await call(origin, admissionPath("register"), registrarAuthorization(), {
    schemaVersion: 1, requestId: randomUUID(), generationId
  });
  const admission = admissionRecord(registered.body);
  const admissionGeneration = stringField(admission, "admissionGeneration");
  const expiresAt = numberField(admission, "expiresAt");
  const body = { schemaVersion: 1, generationId, admissionGeneration, event };
  return { root, origin, clock, expiresAt, admissionGeneration, proofReturned, releaseProof,
    sendReceipt: () => call(origin, "/v1/native-root-ci-events", webhookAuthorization(), body) };
}

function admissionPath(operation: "register" | "revoke"): string {
  return `/v1/projects/project-a/repositories/root/native-root-admission/${operation}`;
}
function registrarAuthorization(): string { return authorization("ordinary-registrar", bundleSecrets.registrar); }
function webhookAuthorization(): string { return authorization("native-events", bundleSecrets.webhook); }
function authorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
async function call(origin: string, path: string, authorizationHeader: string, body: object): Promise<HttpResult> {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: {
    authorization: authorizationHeader, "content-type": "application/json"
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
function admissionRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("response is invalid");
  const admission = Reflect.get(value, "admission");
  if (typeof admission !== "object" || admission === null || Array.isArray(admission)) {
    throw new TypeError("admission is invalid");
  }
  return Object.fromEntries(Object.keys(admission).map((key) => [key, Reflect.get(admission, key)]));
}
function stringField(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new TypeError("admission string field is invalid");
  return value;
}
function numberField(record: Readonly<Record<string, unknown>>, field: string): number {
  const value = record[field];
  if (typeof value !== "number") throw new TypeError("admission number field is invalid");
  return value;
}
function replaceActivationDigest(root: string): void {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"));
  database.prepare("UPDATE bundle_activation SET activation_token_sha256 = ?").run("f".repeat(64));
  database.close();
}
function receiptCount(root: string): number {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"), { readOnly: true });
  const row = database.prepare("SELECT COUNT(*) AS count FROM native_root_ci_event_receipts").get();
  database.close();
  return Number(row?.count);
}
function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  const resolve = resolvePromise;
  if (resolve === undefined) throw new TypeError("deferred resolver is unavailable");
  return { promise, resolve };
}
async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void };
type HttpResult = { readonly status: number; readonly body: unknown };
