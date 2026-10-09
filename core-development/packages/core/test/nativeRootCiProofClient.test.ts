import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeRootCiProofClient,
  NativeRootCiProofRejectedError,
  NativeRootCiProofUnavailableError,
  type NativeRootCiProofHttpClient
} from "../../../../core/packages/core/src/nativeRootCiProofClient.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import {
  createBundleReview,
  nativeBundleReviewFixture
} from "../../native-git/test/nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  generationId
} from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const credential = { username: "ordinary-identity", password: bundleSecrets.nativeIdentity } as const;

afterEach(cleanupFinalizeFixtures);

describe("native root CI proof client", () => {
  it("reads a real canonical imported policy and only its exact current ordinary stored event", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("root-ci-proof-client");
    const envelope = await createBundleReview(fixture.service);
    const event = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
    if (event === undefined) throw new TypeError("ordinary event fixture is missing");
    const client = createNativeRootCiProofClient({ endpoint: fixture.service.origin,
      serviceId: "native-main", generationId, identity: credential });

    // When
    const policy = await client.readImportedPolicy("project-a", AbortSignal.timeout(5_000));
    const proof = await client.readOrdinaryReviewEvent({ projectId: "project-a",
      importNonce: policy.currentRoot.importNonce, policyDigest: policy.currentRoot.policyDigest,
      eventId: event.eventId, reviewId: event.reviewId, executionKind: "ordinary-sysbox",
      jobName: event.jobName }, AbortSignal.timeout(5_000));

    // Then
    expect(policy.policy.requiredJobs.map(({ kind, name }) => `${kind}:${name}`))
      .toEqual(["qemu:integration", "ordinary-sysbox:source"]);
    expect(policy.policy.requiredReviewerIds).toEqual(["owner"]);
    expect(proof.event).toEqual(event);
    expect(proof.currentRoot).toEqual(policy.currentRoot);
    expect(proof.policy).toEqual(policy.policy);
  });

  it.each([
    ["extra field", (proof: Record<string, unknown>) => ({ ...proof, extra: true })],
    ["wrong service", (proof: Record<string, unknown>) => ({ ...proof, serviceId: "foreign" })],
    ["wrong generation", (proof: Record<string, unknown>) => ({ ...proof, servingGenerationId: "b".repeat(64) })],
    ["replayed nonce", (proof: Record<string, unknown>) => ({ ...proof, requestId: randomUUID() })],
    ["policy digest", (proof: Record<string, unknown>) => ({ ...proof,
      currentRoot: { ...record(proof.currentRoot), policyDigest: "f".repeat(64) } })],
    ["policy revision", (proof: Record<string, unknown>) => ({ ...proof,
      policy: { ...record(proof.policy), policyRevision: "e".repeat(64) } })],
    ["unsorted jobs", unsortedJobsProof],
    ["unsorted reviewers", (proof: Record<string, unknown>) => ({ ...proof,
      policy: { ...record(proof.policy), requiredReviewerIds: ["z-reviewer", "owner"] } })],
    ["root object format", (proof: Record<string, unknown>) => ({ ...proof,
      currentRoot: { ...record(proof.currentRoot), tree: "d".repeat(64) } })]
  ])("rejects an unavailable %s policy proof", async (_label, mutate) => {
    // Given
    const client = createNativeRootCiProofClient(config(), scriptedClient((request) => request.method === "GET"
      ? identity() : mutate(canonicalPolicyProof(String(bodyRecord(request.body).requestId)))));

    // When / Then
    await expect(client.readImportedPolicy("project-a", AbortSignal.timeout(1_000)))
      .rejects.toThrow(NativeRootCiProofUnavailableError);
  });

  it.each([
    ["event selector", (proof: Record<string, unknown>) => ({ ...proof,
      event: { ...record(proof.event), jobName: "foreign" } })],
    ["event digest", (proof: Record<string, unknown>) => ({ ...proof,
      event: { ...record(proof.event), eventId: "f".repeat(64) } })],
    ["candidate object format", (proof: Record<string, unknown>) => ({ ...proof,
      event: { ...record(proof.event), candidateTree: "f".repeat(64) } })],
    ["current root", (proof: Record<string, unknown>) => ({ ...proof,
      currentRoot: { ...record(proof.currentRoot), commit: "f".repeat(40) } })],
    ["review liveness", (proof: Record<string, unknown>) => ({ ...proof, reviewLiveness: "approved" })]
  ])("rejects an unavailable %s event proof", async (_label, mutate) => {
    // Given
    const client = createNativeRootCiProofClient(config(), scriptedClient((request) => {
      if (request.method === "GET") return identity();
      return mutate(canonicalEventProof(bodyRecord(request.body).requestId));
    }));

    // When / Then
    await expect(client.readOrdinaryReviewEvent(eventSelector(), AbortSignal.timeout(1_000)))
      .rejects.toThrow(NativeRootCiProofUnavailableError);
  });

  it("maps only 404 and 409 to rejection while concealing credentials from every other failure", async () => {
    // Given
    const clients = [404, 409, 401, 403, 500].map((statusCode) => createNativeRootCiProofClient(config(), {
      async request(request) {
        if (request.method === "GET") return jsonResponse(identity());
        return { ...jsonResponse({ error: "denied" }), statusCode };
      }
    }));
    const secretClient = createNativeRootCiProofClient(config(), {
      async request() { throw new Error(`transport leaked ${credential.password}`); }
    });

    // When / Then
    await expect(clients[0]?.readImportedPolicy("project-a", AbortSignal.timeout(1_000)))
      .rejects.toThrow(NativeRootCiProofRejectedError);
    await expect(clients[1]?.readImportedPolicy("project-a", AbortSignal.timeout(1_000)))
      .rejects.toThrow(NativeRootCiProofRejectedError);
    for (const client of clients.slice(2)) {
      await expect(client.readImportedPolicy("project-a", AbortSignal.timeout(1_000)))
        .rejects.toThrow(NativeRootCiProofUnavailableError);
    }
    let message = "";
    try { await secretClient.readImportedPolicy("project-a", AbortSignal.timeout(1_000)); }
    catch (error) { message = String(error); }
    expect(message).not.toContain(credential.password);
  });

  it("pins endpoint, credential, exact identity, request shape, and caller cancellation", async () => {
    // Given
    const requests: Parameters<NativeRootCiProofHttpClient["request"]>[0][] = [];
    const mutable = config();
    const client = createNativeRootCiProofClient(mutable, {
      async request(request) {
        requests.push(request);
        return jsonResponse(request.method === "GET" ? identity()
          : canonicalPolicyProof(String(bodyRecord(request.body).requestId)));
      }
    });
    Reflect.set(mutable, "endpoint", "http://attacker.invalid");
    Reflect.set(mutable.identity, "password", "attacker-secret");

    // When
    await client.readImportedPolicy("project-a", AbortSignal.timeout(1_000));

    // Then
    expect(requests).toHaveLength(2);
    const proofRequest = requests.at(1);
    if (proofRequest === undefined) throw new TypeError("proof request is missing");
    expect(requests.every(({ endpoint }) => endpoint === "http://native-git:8080")).toBe(true);
    expect(requests.every(({ authorization }) => authorization.includes(Buffer.from(
      `${credential.username}:${credential.password}`).toString("base64")))).toBe(true);
    expect(bodyRecord(proofRequest.body).generationId).toBe(generationId);
    expect(Object.keys(bodyRecord(proofRequest.body)).sort()).toEqual(["generationId", "requestId", "schemaVersion"]);
  });
});

function config() {
  return { endpoint: "http://native-git:8080", serviceId: "native-main", generationId,
    identity: { ...credential } } as const;
}

function eventSelector() {
  return { projectId: "project-a", importNonce: "00000000-0000-4000-8000-000000000032",
    policyDigest: canonicalPolicyProof().currentRoot.policyDigest, eventId: eventId(), reviewId: "a".repeat(64),
    executionKind: "ordinary-sysbox" as const, jobName: "source" };
}

function identity() {
  return { schemaVersion: 1, serviceId: "native-main", role: "native-root-ci-proof-reader",
    scope: ["imported-policy:read", "ordinary-review-event:read"], generationId };
}

function canonicalPolicyProof(requestId = "00000000-0000-4000-8000-000000000031") {
  const policy = policyFixture();
  const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  return { schemaVersion: 1, serviceId: "native-main", requestId, servingGenerationId: generationId,
    projectId: "project-a", repositoryId: "root", currentRoot: {
      importNonce: "00000000-0000-4000-8000-000000000032", sequence: 0, protectedRef: "refs/heads/main",
      commit: "1".repeat(40), tree: "2".repeat(40), policyDigest }, policy };
}

function canonicalEventProof(requestId: unknown) {
  return { ...canonicalPolicyProof(String(requestId)), reviewLiveness: "current", event: {
    schemaVersion: 2, type: "dim.native.review-job.available", eventId: eventId(), projectId: "project-a",
    repositoryId: "root", protectedRef: "refs/heads/main", reviewId: "a".repeat(64),
    expectedProtectedHead: "1".repeat(40), candidateCommit: "3".repeat(40), candidateTree: "4".repeat(40),
    policyRevision: policyFixture().policyRevision, requiredReviewRevision: policyFixture().requiredReviewRevision,
    requiredJobSetRevision: policyFixture().requiredJobSetRevision, executionKind: "ordinary-sysbox",
    jobName: "source", evidenceClass: "candidate-controlled" } };
}

function policyFixture() {
  const requiredJobs = [
    { name: "integration", kind: "qemu", evidenceClass: "candidate-controlled" },
    { name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }
  ] as const;
  const reviewers = { requiredReviewerIds: ["owner"], pathReviewerRules: [] } as const;
  const revision = (domain: string, version: number, value: unknown) => createHash("sha256")
    .update(`dim-native-${domain}-v${version}\0`).update(JSON.stringify(value)).digest("hex");
  return { schemaVersion: 1, protectedRef: "refs/heads/main",
    policyRevision: revision("policy", 2, { protectedRef: "refs/heads/main", ...reviewers, requiredJobs }),
    requiredReviewRevision: revision("reviewers", 1, reviewers),
    requiredJobSetRevision: revision("jobs", 2, requiredJobs), requiredJobs, ...reviewers };
}

function unsortedJobsProof(proof: Record<string, unknown>): Record<string, unknown> {
  const original = record(proof.policy);
  const requiredJobs = [...array(original.requiredJobs)].reverse();
  const reviewers = { requiredReviewerIds: original.requiredReviewerIds, pathReviewerRules: original.pathReviewerRules };
  const revision = (domain: string, version: number, value: unknown) => createHash("sha256")
    .update(`dim-native-${domain}-v${version}\0`).update(JSON.stringify(value)).digest("hex");
  const policy = { ...original, policyRevision: revision("policy", 2,
    { protectedRef: original.protectedRef, ...reviewers, requiredJobs }),
    requiredJobSetRevision: revision("jobs", 2, requiredJobs), requiredJobs };
  return { ...proof, policy, currentRoot: { ...record(proof.currentRoot),
    policyDigest: createHash("sha256").update(JSON.stringify(policy)).digest("hex") } };
}

function eventId(): string {
  return createHash("sha256").update("dim-native-authoritative-review-event-v1\0")
    .update(JSON.stringify({ executionKind: "ordinary-sysbox", jobName: "source", reviewId: "a".repeat(64) }))
    .digest("hex");
}

function scriptedClient(body: (request: Parameters<NativeRootCiProofHttpClient["request"]>[0]) => unknown) {
  return { async request(request: Parameters<NativeRootCiProofHttpClient["request"]>[0]) {
    return jsonResponse(body(request));
  } };
}

function jsonResponse(body: unknown) {
  return { statusCode: 200, contentType: "application/json; charset=utf-8", cacheControl: "no-store",
    body: Buffer.from(JSON.stringify(body)) };
}

function bodyRecord(body: string | undefined): Readonly<Record<string, unknown>> {
  return record(JSON.parse(body ?? "null"));
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected record");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("expected array");
  return value;
}
