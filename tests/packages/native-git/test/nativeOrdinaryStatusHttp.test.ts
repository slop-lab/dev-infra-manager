import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { createNodeAdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import {
  ordinaryStatusFixture,
  post,
  queryAuthorization,
  readStatusRecord,
  resultReporterAuthorization,
  statusRecordPath,
  statusReviewPath
} from "./nativeOrdinaryStatusFixture.js";
import {
  cleanupFinalizeFixtures,
  activateFinalizeService,
  closeFinalizeService,
  humanReviewerAuthorization,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("installed native ordinary terminal status HTTP boundary", () => {
  it("returns typed current terminal evidence only after ordinary delivery proof", async () => {
    // Given
    const fixture = await ordinaryStatusFixture("ordinary-terminal-evidence");
    const reviewId = fixture.review.reviewId;
    if (typeof reviewId !== "string") throw new TypeError("review ID is missing");
    const selector = { projectId: "project-a", reviewId, jobName: "source" };
    await expect(fixture.service.currentOrdinaryTerminalEvidence(selector)).rejects.toThrow();
    expect((await post(fixture.service.origin, statusReviewPath(fixture.review.reviewId),
      fixture.event, resultReporterAuthorization)).status).toBe(201);

    // When
    const evidence = await fixture.service.currentOrdinaryTerminalEvidence(selector);

    // Then
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      executionKind: "ordinary-sysbox",
      evidenceClass: "candidate-controlled",
      projectId: "project-a",
      repositoryId: "root",
      reviewId: fixture.review.reviewId,
      jobName: "source",
      result: "success",
      provenance: {
        ordinaryServiceId: "ordinary-main",
        servingGenerationId: "a".repeat(64),
        cleanupComplete: true
      }
    });
  }, 30_000);

  it("publishes one immutable schema-3 status and exactly replays it after restart", async () => {
    // Given
    const fixture = await ordinaryStatusFixture("ordinary-status-happy");
    const path = statusReviewPath(fixture.review.reviewId);

    // When
    const created = await post(fixture.service.origin, path, fixture.event, resultReporterAuthorization);
    const createdText = await created.text();
    expect(created.status).toBe(201);
    const storedPath = statusRecordPath(fixture.root, fixture.review.reviewId);
    const metadata = await lstat(storedPath);
    const storedBytes = await readFile(storedPath, "utf8");
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, rejectingProofClient());
    await activateFinalizeService(restarted.origin);
    const beforeReplay = await lstat(storedPath);
    const replay = await post(restarted.origin, path, fixture.event, resultReporterAuthorization);

    // Then
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(created.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(metadata.uid).toBe(process.getuid?.());
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
    expect(JSON.parse(createdText)).toEqual(JSON.parse(storedBytes));
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(createdText);
    expect(await readFile(storedPath, "utf8")).toBe(storedBytes);
    expect((await lstat(storedPath)).mtimeMs).toBe(beforeReplay.mtimeMs);
    expect(fixture.proof.requestIds).toHaveLength(1);
    expect(fixture.proof.requestIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    const conflicting = await post(restarted.origin, path,
      { ...fixture.event, eventId: crypto.randomUUID() }, resultReporterAuthorization);
    expect(conflicting.status).toBe(409);
    expect(await readFile(storedPath, "utf8")).toBe(storedBytes);
  }, 30_000);

  it("requires the exact generation header and activation for status creation and replay", async () => {
    // Given
    const fixture = await ordinaryStatusFixture("ordinary-status-activation-fence");
    const path = statusReviewPath(fixture.review.reviewId);
    expect((await post(fixture.service.origin, path, fixture.event, resultReporterAuthorization)).status).toBe(201);
    const storedPath = statusRecordPath(fixture.root, fixture.review.reviewId);
    const storedBytes = await readFile(storedPath, "utf8");
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, rejectingProofClient());
    const database = new DatabaseSync(`${fixture.root}/native-idle.sqlite3`);
    const activation = database.prepare("SELECT activation_token_sha256 FROM bundle_activation").get();
    if (typeof activation?.activation_token_sha256 !== "string") throw new TypeError("activation binding is unavailable");
    database.prepare("UPDATE bundle_activation SET activation_token_sha256 = ?").run("9".repeat(64));
    database.close();

    // When
    const missing = await statusPost(restarted.origin, path, fixture.event);
    const wrong = await statusPost(restarted.origin, path, fixture.event, "b".repeat(64));
    const inactiveReplay = await statusPost(restarted.origin, path, fixture.event, "a".repeat(64));
    const restored = new DatabaseSync(`${fixture.root}/native-idle.sqlite3`);
    restored.prepare("UPDATE bundle_activation SET activation_token_sha256 = ?")
      .run(activation.activation_token_sha256);
    restored.close();
    await activateFinalizeService(restarted.origin);
    const replay = await statusPost(restarted.origin, path, fixture.event, "a".repeat(64));

    // Then
    expect([missing.status, wrong.status, inactiveReplay.status, replay.status]).toEqual([409, 409, 503, 201]);
    expect(await readFile(storedPath, "utf8")).toBe(storedBytes);
  }, 30_000);

  it("accepts a terminal status only after a live ordinary current-result HTTP proof", async () => {
    // Given
    let rootCommit = "";
    let rootTree = "";
    let proofRequests = 0;
    const ordinary = createServer(async (request, response) => {
      if (request.method !== "POST"
        || request.url !== "/v1/projects/project-a/repositories/root/native-root-ci-result-proof/current-result"
        || request.headers.authorization !== queryAuthorization) {
        response.writeHead(403).end();
        return;
      }
      const body = await readRequestBody(request);
      const proofRequest = record(JSON.parse(body));
      const event = record(proofRequest.terminalEvent);
      const payload = record(event.payload);
      const descriptor = record(payload.descriptor);
      proofRequests += 1;
      response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 1, serviceId: "ordinary-main", requestId: proofRequest.requestId,
        servingGenerationId: "a".repeat(64), projectId: "project-a", repositoryId: "root",
        claimId: "00000000-0000-4000-8000-000000000071",
        serviceEpochId: "00000000-0000-4000-8000-000000000072",
        admissionGeneration: descriptor.admissionGeneration, rootSequence: 0, rootCommit, rootTree,
        cleanupComplete: true, terminalEvent: event,
        terminalEventDigest: eventDigest(event) }));
    });
    ordinary.listen(0, "127.0.0.1");
    await once(ordinary, "listening");
    const address = ordinary.address();
    if (address === null || typeof address === "string") throw new TypeError("ordinary listener is unavailable");
    try {
      const fixture = await ordinaryStatusFixture("ordinary-status-live-http",
        createNodeAdmissionVerifierHttpClient(`http://127.0.0.1:${address.port}`));
      rootCommit = String(fixture.review.expectedProtectedHead);
      rootTree = fixture.rootTree;

      // When
      const response = await post(fixture.service.origin, statusReviewPath(fixture.review.reviewId),
        fixture.event, resultReporterAuthorization);

      // Then
      expect(response.status).toBe(201);
      expect(proofRequests).toBe(1);
      expect(await readStatusRecord(fixture.root, fixture.review.reviewId)).toMatchObject({
        schemaVersion: 3,
        eventId: fixture.event.eventId,
        reviewId: fixture.review.reviewId,
        reporterUsername: "ordinary-results"
      });
    } finally {
      const closed = once(ordinary, "close");
      ordinary.close();
      await closed;
    }
  }, 30_000);

  it("rejects wrong-role, foreign, malformed, and mismatched-proof reports without status evidence", async () => {
    // Given
    const fixture = await ordinaryStatusFixture("ordinary-status-denials");
    const path = statusReviewPath(fixture.review.reviewId);

    // When
    const wrongRole = await post(fixture.service.origin, path, fixture.event, humanReviewerAuthorization);
    const foreign = await post(fixture.service.origin, path.replace("project-a", "project-b"),
      fixture.event, resultReporterAuthorization);
    const malformed = await post(fixture.service.origin, path,
      { ...fixture.event, schemaVersion: 2 }, resultReporterAuthorization);
    fixture.proof.mismatch = true;
    const mismatchedProof = await post(fixture.service.origin, path, fixture.event, resultReporterAuthorization);

    // Then
    expect([wrongRole.status, foreign.status, malformed.status, mismatchedProof.status]).toEqual([403, 404, 400, 409]);
    await expect(readStatusRecord(fixture.root, fixture.review.reviewId)).rejects.toThrow();
  }, 30_000);
});

function rejectingProofClient(): AdmissionVerifierHttpClient {
  return {
    async request() {
      throw new Error("historical replay must not request live ordinary proof");
    }
  };
}

function statusPost(origin: string, path: string, body: object, generationId?: string): Promise<Response> {
  return fetch(`${origin}${path}`, { method: "POST", headers: {
    authorization: resultReporterAuthorization,
    "content-type": "application/json",
    ...(generationId === undefined ? {} : { "x-dim-generation-id": generationId })
  }, body: JSON.stringify(body) });
}

function proofClient(fixture: Awaited<ReturnType<typeof ordinaryStatusFixture>>): AdmissionVerifierHttpClient {
  return {
    async request(input) {
      if (!input.path.endsWith("/native-root-ci-result-proof/current-result") || input.body === undefined) {
        throw new TypeError(`unexpected ordinary request: ${input.path}`);
      }
      const request: unknown = JSON.parse(input.body);
      if (typeof request !== "object" || request === null || Array.isArray(request)) throw new TypeError("invalid proof request");
      const event = Reflect.get(request, "terminalEvent");
      const requestId = Reflect.get(request, "requestId");
      if (typeof requestId !== "string") throw new TypeError("invalid proof request ID");
      fixture.proof.requestIds.push(requestId);
      const payload = Reflect.get(event, "payload");
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new TypeError("invalid event payload");
      const descriptor = Reflect.get(payload, "descriptor");
      if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
        throw new TypeError("invalid event descriptor");
      }
      return { statusCode: 200, contentType: "application/json", cacheControl: "no-store", body: Buffer.from(JSON.stringify({
        schemaVersion: 1, serviceId: "ordinary-main", requestId,
        servingGenerationId: "a".repeat(64), projectId: "project-a", repositoryId: "root",
        claimId: "00000000-0000-4000-8000-000000000061",
        serviceEpochId: "00000000-0000-4000-8000-000000000062",
        admissionGeneration: Reflect.get(descriptor, "admissionGeneration"),
        rootSequence: 0, rootCommit: fixture.review.expectedProtectedHead,
        rootTree: fixture.rootTree,
        cleanupComplete: true, terminalEvent: event,
        terminalEventDigest: eventDigest(event)
      })) };
    }
  };
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected record");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function eventDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex")}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(Reflect.get(value, key))]));
}
