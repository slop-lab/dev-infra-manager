import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleSecrets } from "./bundleConfigFixture.js";
import { authoritativePolicy } from "./authoritativeNativeCandidateFixture.js";
import {
  createBundleReview,
  nativeBundleReviewFixture,
  reviewProposalRef
} from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  createFinalizeRoot,
  generationId,
  humanReviewerAuthorization,
  rootRepository,
  runGit,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";

const identityAuthorization = `Basic ${Buffer.from(
  `ordinary-identity:${bundleSecrets.nativeIdentity}`
).toString("base64")}`;
const attemptAuthorization = `Basic ${Buffer.from(
  `ordinary-attempts:${bundleSecrets.attemptIssuer}`
).toString("base64")}`;
const requestId = "00000000-0000-4000-8000-000000000031";

afterEach(cleanupFinalizeFixtures);

describe("installed native root CI proof HTTP boundary", () => {
  it("returns the full canonical imported policy and exact current ordinary event without mutation", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("root-ci-proof-success");
    const envelope = await createBundleReview(fixture.service);
    const event = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
    if (event === undefined) throw new TypeError("ordinary event fixture is missing");
    const repository = rootRepository(fixture.root);
    const reviewPath = join(repository, "dim-authoritative-reviews", "proposals", `${envelope.review.reviewId}.json`);
    const before = await proofState(fixture.root, reviewPath);

    // When
    const policyResponse = await proofRequest(fixture.service.origin, "policy", {
      schemaVersion: 1,
      requestId,
      generationId
    });
    const policyProof: unknown = await policyResponse.json();
    if (typeof policyProof !== "object" || policyProof === null || Array.isArray(policyProof)) {
      throw new TypeError("policy proof fixture is invalid");
    }
    const currentRoot = Reflect.get(policyProof, "currentRoot");
    if (typeof currentRoot !== "object" || currentRoot === null || Array.isArray(currentRoot)) {
      throw new TypeError("current root fixture is invalid");
    }
    const eventResponse = await proofRequest(fixture.service.origin, "review-event", {
      schemaVersion: 1,
      requestId,
      generationId,
      importNonce: Reflect.get(currentRoot, "importNonce"),
      policyDigest: Reflect.get(currentRoot, "policyDigest"),
      eventId: event.eventId,
      reviewId: event.reviewId,
      executionKind: event.executionKind,
      jobName: event.jobName
    });

    // Then
    expect(policyResponse.status).toBe(200);
    expect(policyResponse.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(policyResponse.headers.get("cache-control")).toBe("no-store");
    expect(policyProof).toEqual({
      schemaVersion: 1,
      serviceId: "native-main",
      requestId,
      servingGenerationId: generationId,
      projectId: "project-a",
      repositoryId: "root",
      currentRoot: {
        importNonce: expect.stringMatching(/^[0-9a-f-]{36}$/),
        sequence: 0,
        protectedRef: "refs/heads/main",
        commit: envelope.review.expectedProtectedHead,
        tree: expect.stringMatching(/^[0-9a-f]{40}$/),
        policyDigest: envelope.review.policyDigest
      },
      policy: authoritativePolicy()
    });
    expect(eventResponse.status).toBe(200);
    expect(await eventResponse.json()).toEqual({
      schemaVersion: 1,
      serviceId: "native-main",
      requestId,
      servingGenerationId: generationId,
      projectId: "project-a",
      repositoryId: "root",
      currentRoot,
      policy: authoritativePolicy(),
      reviewLiveness: "current",
      event
    });
    expect(await proofState(fixture.root, reviewPath)).toEqual(before);
  });

  it("denies foreign credentials, selectors, kinds, stale refs, and non-exact surfaces without proof", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("root-ci-proof-denials");
    const envelope = await createBundleReview(fixture.service);
    const ordinary = envelope.events.find((event) => event.executionKind === "ordinary-sysbox");
    const qemu = envelope.events.find((event) => event.executionKind === "qemu");
    if (ordinary === undefined || qemu === undefined) throw new TypeError("review event fixtures are missing");
    const policy = await policyProof(fixture.service.origin);
    const selector = {
      schemaVersion: 1,
      requestId,
      generationId,
      importNonce: policy.importNonce,
      policyDigest: policy.policyDigest,
      eventId: ordinary.eventId,
      reviewId: ordinary.reviewId,
      executionKind: ordinary.executionKind,
      jobName: ordinary.jobName
    } as const;

    // When
    const responses = await Promise.all([
      rawRequest({ origin: fixture.service.origin, method: "POST", path: proofPath("policy"), body: selector,
        authorization: attemptAuthorization }),
      rawRequest({ origin: fixture.service.origin, method: "POST", path: proofPath("policy"), body: selector,
        authorization: "Basic dW5rbm93bjp1bmtub3du" }),
      rawRequest({ origin: fixture.service.origin, method: "POST", path: proofPath("policy"), body: selector,
        authorization: humanReviewerAuthorization }),
      proofRequest(fixture.service.origin, "review-event", { ...selector, executionKind: qemu.executionKind,
        eventId: qemu.eventId, jobName: qemu.jobName }),
      proofRequest(fixture.service.origin, "review-event", { ...selector, importNonce: crypto.randomUUID() }),
      proofRequest(fixture.service.origin, "review-event", { ...selector, policyDigest: "f".repeat(64) }),
      proofRequest(fixture.service.origin, "policy", { schemaVersion: 1, requestId, generationId: "f".repeat(64) }),
      rawRequest({ origin: fixture.service.origin, method: "GET", path: proofPath("policy"),
        authorization: identityAuthorization }),
      rawRequest({ origin: fixture.service.origin, method: "POST", path: `${proofPath("policy")}?proof=1`,
        body: selector, authorization: identityAuthorization }),
      rawRequest({ origin: fixture.service.origin, method: "POST",
        path: proofPath("policy").replace("/root/", "/other/"), body: selector,
        authorization: identityAuthorization }),
      rawRequest({ origin: fixture.service.origin, method: "POST", path: proofPath("policy"), body: "{",
        authorization: identityAuthorization }),
      rawRequest({ origin: fixture.service.origin, method: "POST", path: proofPath("policy"), body: selector,
        authorization: identityAuthorization, contentType: "application/json; charset=utf-8" }),
      rawRequest({ origin: fixture.service.origin, method: "POST", path: proofPath("policy"),
        body: { ...selector, padding: "x".repeat(65 * 1024) }, authorization: identityAuthorization })
    ]);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "commit", "--allow-empty", "-m", "stale"]);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    const stale = await proofRequest(fixture.service.origin, "review-event", selector);

    // Then
    expect(responses.map(({ status }) => status)).toEqual([403, 401, 403, 404, 409, 409, 409, 404, 404, 404, 400, 400, 400]);
    expect(stale.status).toBe(409);
    expect((await stale.json())).toEqual({ error: "proof tuple is stale" });
  });

  it("attests identity before activation while proof remains unavailable", async () => {
    // Given
    const root = await createFinalizeRoot("root-ci-proof-inactive");
    const service = await startFinalizeService(root);

    // When
    const identity = await rawRequest({ origin: service.origin, method: "GET",
      path: "/v1/native-root-ci-proof/identity", authorization: identityAuthorization });
    const unavailable = await proofRequest(service.origin, "policy", { schemaVersion: 1, requestId, generationId });

    // Then
    expect(await identity.json()).toEqual({ schemaVersion: 1, serviceId: "native-main",
      role: "native-root-ci-proof-reader", scope: ["imported-policy:read", "ordinary-review-event:read"], generationId });
    expect(unavailable.status).toBe(503);
  });
});

async function policyProof(origin: string): Promise<{ readonly importNonce: string; readonly policyDigest: string }> {
  const response = await proofRequest(origin, "policy", { schemaVersion: 1, requestId, generationId });
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) throw new TypeError("policy response is invalid");
  const root = Reflect.get(body, "currentRoot");
  if (typeof root !== "object" || root === null) throw new TypeError("root response is invalid");
  const importNonce = Reflect.get(root, "importNonce");
  const policyDigest = Reflect.get(root, "policyDigest");
  if (typeof importNonce !== "string" || typeof policyDigest !== "string") throw new TypeError("proof fields are invalid");
  return { importNonce, policyDigest };
}

function proofRequest(origin: string, suffix: "policy" | "review-event", body: object): Promise<Response> {
  return rawRequest({ origin, method: "POST", path: proofPath(suffix), body, authorization: identityAuthorization });
}

function proofPath(suffix: "policy" | "review-event"): string {
  return `/v1/projects/project-a/repositories/root/native-root-ci-proof/${suffix}`;
}

function rawRequest(input: { readonly origin: string; readonly method: string; readonly path: string;
  readonly body?: object | string; readonly authorization: string; readonly contentType?: string }): Promise<Response> {
  return fetch(`${input.origin}${input.path}`, { method: input.method, headers: { authorization: input.authorization,
    ...(input.body === undefined ? {} : { "content-type": input.contentType ?? "application/json" }) },
  ...(input.body === undefined ? {} : { body: typeof input.body === "string" ? input.body : JSON.stringify(input.body) }) });
}

async function proofState(root: string, reviewPath: string): Promise<readonly unknown[]> {
  const repository = rootRepository(root);
  return Promise.all([readFile(join(root, "native-idle.sqlite3")),
    readFile(join(repository, "refs", "heads", "main")), readFile(reviewPath),
    optionalEntries(join(repository, "dim-authoritative-approvals")),
    optionalEntries(join(repository, "dim-authoritative-revocations"))]);
}

function optionalEntries(path: string): Promise<readonly string[]> {
  return readdir(path).catch((error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
    ? [] : Promise.reject(error));
}
