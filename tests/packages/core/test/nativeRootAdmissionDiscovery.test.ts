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
import { openNativeRootAdmissionDatabase } from "../../../../core/packages/core/src/nativeRootAdmissionSchema.js";
import { NativeRootAdmissionStore } from "../../../../core/packages/core/src/nativeRootAdmissionStore.js";
import {
  createNativeRootAdmissionResponse,
  NativeRootAdmissionResponseTooLargeError
} from "../../../../core/packages/core/src/nativeRootAdmissionResponse.js";
import { bundleSecrets, idleOrdinaryConfig } from "../../native-git/test/bundleConfigFixture.js";
import { nativeBundleReviewFixture } from "../../native-git/test/nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const activationToken = Buffer.alloc(32, 42).toString("base64url");
const registrar = auth("ordinary-registrar", bundleSecrets.registrar);
const reader = auth("native-query", bundleSecrets.nativeQuery);
const path = "/v1/projects/project-a/repositories/root/native-root-admission/";
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root admission discovery", () => {
  it("bounds the complete admission envelope before a caller can commit it", () => {
    // Given
    const oversized = oversizedAdmission();

    // When / Then
    expect(() => createNativeRootAdmissionResponse({ serviceId: "ordinary-main", generationId,
      requestId: randomUUID(), admission: oversized })).toThrow(NativeRootAdmissionResponseTooLargeError);
  });

  it("rolls back admission registration when its complete response exceeds the wire bound", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-oversized-discovery-"));
    roots.push(root);
    const file = join(root, "ordinary.sqlite3");
    const database = openNativeRootAdmissionDatabase(file);
    const oversized = oversizedAdmission();
    const store = new NativeRootAdmissionStore(database, { ordinaryServiceId: "ordinary-main",
      controlPlaneGenerationId: generationId, capacityConfigDigest: oversized.capacityConfigDigest,
      leaseMilliseconds: 60_000, now: Date.now });
    const requestId = randomUUID();

    // When / Then
    try {
      expect(() => store.commitRegistration({ proof: { schemaVersion: 1, serviceId: "native-main", requestId,
        servingGenerationId: generationId, projectId: "project-a", repositoryId: "root",
        currentRoot: oversized.importedRoot.currentRoot, policy: oversized.importedRoot.policy },
      request: { requestId, operation: "register", tupleDigest: "a".repeat(64),
        responseBody: (admission) => createNativeRootAdmissionResponse({ serviceId: "ordinary-main",
          generationId, requestId, admission }) } })).toThrow(NativeRootAdmissionResponseTooLargeError);
    } finally { database.close(); }
    expect(count(file, "native_root_admissions")).toBe(0);
    expect(count(file, "native_root_admission_requests")).toBe(0);
  });

  it("returns the exact live Project admission without using the capped replay ledger", async () => {
    // Given
    const native = await nativeBundleReviewFixture("discovery-live");
    const { origin, database } = await startOrdinary(native.service.origin);
    const preactivation = await post(origin, `${path}discover`, reader, request());
    await post(origin, "/v1/activation", `Bearer ${activationToken}`, { schemaVersion: 1, generationId });
    const registration = await post(origin, `${path}register`, registrar, request());
    expect(registration.status).toBe(200);
    const admission = (await registration.json()).admission;
    const before = rows(database);
    const selector = request();

    // When
    const first = await post(origin, `${path}discover`, reader, selector);
    const again = await post(origin, `${path}discover`, reader, selector);

    // Then
    expect(preactivation.status).toBe(503);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect((await first.json()).admission).toEqual(admission);
    expect((await again.json()).admission).toEqual(admission);
    expect(count(database, "native_root_admission_requests")).toBe(1);
    expect(rows(database)).toEqual(before);
  });

  it("conceals foreign roles, wrong generations, and expired admissions without writes", async () => {
    // Given
    const native = await nativeBundleReviewFixture("discovery-denial");
    const { origin, database } = await startOrdinary(native.service.origin);
    await post(origin, "/v1/activation", `Bearer ${activationToken}`, { schemaVersion: 1, generationId });
    const registration = await post(origin, `${path}register`, registrar, request());
    expect(registration.status).toBe(200);
    const admission: unknown = (await registration.json()).admission;
    if (typeof admission !== "object" || admission === null) throw new TypeError("admission is unavailable");
    const admissionGeneration = Reflect.get(admission, "admissionGeneration");

    // When
    const wrongRole = await post(origin, `${path}discover`, registrar, request());
    const unknown = await post(origin, `${path}discover`, "Basic dW5rbm93bjp1bmtub3du", request());
    const wrongGeneration = await post(origin, `${path}discover`, reader,
      { ...request(), generationId: "f".repeat(64) });
    const foreign = await post(origin, path.replace("project-a", "project-b") + "discover", reader, request());
    const invalid = await post(origin, `${path}discover`, reader, { ...request(), admissionGeneration });
    const db = new DatabaseSync(database);
    db.prepare("UPDATE native_root_admissions SET lease_expires_at = 1 WHERE admission_generation = ?")
      .run(admissionGeneration);
    db.close();
    const expired = await post(origin, `${path}discover`, reader, request());

    // Then
    expect([wrongRole.status, unknown.status, wrongGeneration.status, foreign.status, invalid.status, expired.status])
      .toEqual([403, 401, 409, 404, 400, 404]);
    expect(count(database, "native_root_admission_requests")).toBe(1);
    expect(state(database)).toBe("active");
  });

  it("does not discover a revoked admission or revive its historical response", async () => {
    // Given
    const native = await nativeBundleReviewFixture("discovery-revoked");
    const { origin, database } = await startOrdinary(native.service.origin);
    await post(origin, "/v1/activation", `Bearer ${activationToken}`, { schemaVersion: 1, generationId });
    const registration = await post(origin, `${path}register`, registrar, request());
    expect(registration.status).toBe(200);
    const admission: unknown = (await registration.json()).admission;
    if (typeof admission !== "object" || admission === null) throw new TypeError("admission is unavailable");
    const admissionGeneration = Reflect.get(admission, "admissionGeneration");
    const selector = request();
    expect((await post(origin, `${path}discover`, reader, selector)).status).toBe(200);

    // When
    const revoked = await post(origin, `${path}revoke`, registrar, { ...request(), admissionGeneration });
    const discovered = await post(origin, `${path}discover`, reader, selector);

    // Then
    expect(revoked.status).toBe(200);
    expect(discovered.status).toBe(404);
    expect(count(database, "native_root_admission_requests")).toBe(2);
    expect(state(database)).toBe("revoked");
  });
});

async function startOrdinary(nativeOrigin: string): Promise<{ readonly origin: string; readonly database: string }> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-admission-discovery-"));
  roots.push(root);
  const client = createNodeNativeGitAdmissionHttpClient();
  const server = await configuredNativeRootAdmissionServer({
    config: parseNativeOrdinaryBundleConfig(idleOrdinaryConfig()),
    stateDirectory: join(root, "ordinary"),
    readinessToken: Buffer.alloc(32, 41).toString("base64url"), activationToken,
    expectedGenerationId: generationId,
    proofHttpClient: { request: (input) => client.request({ ...input, endpoint: nativeOrigin }) }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("ordinary listener is unavailable");
  return { origin: `http://127.0.0.1:${address.port}`, database: join(root, "ordinary", "ordinary-ci.sqlite3") };
}

function post(origin: string, endpoint: string, authorization: string, body: object): Promise<Response> {
  return fetch(`${origin}${endpoint}`, { method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body) });
}

function request(): { readonly schemaVersion: 1; readonly requestId: string; readonly generationId: string } {
  return { schemaVersion: 1, requestId: randomUUID(), generationId };
}

function auth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function count(file: string, table: string): number {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count); }
  finally { database.close(); }
}

function state(file: string): string {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return String(database.prepare("SELECT state FROM native_root_admissions").get()?.state); }
  finally { database.close(); }
}

function rows(file: string): readonly unknown[] {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return database.prepare("SELECT * FROM native_root_admissions").all(); }
  finally { database.close(); }
}

function oversizedAdmission() {
  return { schemaVersion: 1, admissionGeneration: randomUUID(), capacityConfigDigest: "a".repeat(64),
    expiresAt: Date.now() + 1000, importedRoot: { serviceId: "native-main", servingGenerationId: generationId,
      projectId: "project-a", repositoryId: "root", currentRoot: {
        importNonce: randomUUID(), sequence: 0, protectedRef: "refs/heads/main",
        commit: "a".repeat(40), tree: "b".repeat(40), policyDigest: "c".repeat(64)
      }, policy: { schemaVersion: 1, protectedRef: "refs/heads/main", policyRevision: "d".repeat(64),
        requiredReviewRevision: "e".repeat(64), requiredJobSetRevision: "f".repeat(64),
        requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }],
        requiredReviewerIds: ["owner"], pathReviewerRules: [{ pathPrefix: "x".repeat(65_000), reviewerIds: ["owner"] }]
      } }
  } as const;
}
