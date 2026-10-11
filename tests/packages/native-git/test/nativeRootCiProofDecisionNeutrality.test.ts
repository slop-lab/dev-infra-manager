import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleSecrets } from "./bundleConfigFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId, rootRepository } from "./nativeRootImportFinalizeFixture.js";

const identityAuthorization = `Basic ${Buffer.from(
  `ordinary-identity:${bundleSecrets.nativeIdentity}`
).toString("base64")}`;
const reviewerAuthorization = `Basic ${Buffer.from(
  `human-reviewer-owner:${bundleSecrets.humanReviewer}`
).toString("base64")}`;

afterEach(cleanupFinalizeFixtures);

describe("native root CI review proof decision neutrality", () => {
  it("returns the same current ordinary event while review decisions move through approved and self-revoked", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("root-ci-proof-decisions");
    const envelope = await createBundleReview(fixture.service);
    const event = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
    if (event === undefined) throw new TypeError("ordinary event fixture is missing");
    const policy = await proof(fixture.service.origin, "policy", {
      schemaVersion: 1, requestId: randomUUID(), generationId
    });
    const currentRoot = field(policy, "currentRoot");
    const selector = { schemaVersion: 1, requestId: randomUUID(), generationId,
      importNonce: stringField(currentRoot, "importNonce"), policyDigest: stringField(currentRoot, "policyDigest"),
      eventId: event.eventId, reviewId: event.reviewId, executionKind: event.executionKind, jobName: event.jobName };

    // When
    const pending = await proof(fixture.service.origin, "review-event", selector);
    const approvalResponse = await decision({ origin: fixture.service.origin, reviewId: event.reviewId,
      suffix: "approvals", body: { requestId: randomUUID() } });
    const approval = await approvalResponse.json();
    const approved = await proof(fixture.service.origin, "review-event", { ...selector, requestId: randomUUID() });
    const revocationResponse = await decision({ origin: fixture.service.origin, reviewId: event.reviewId,
      suffix: "revocations", body: { approvalId: stringField(approval, "approvalId") } });
    const decisionFilesBefore = await decisionBytes(fixture.root);
    const revoked = await proof(fixture.service.origin, "review-event", { ...selector, requestId: randomUUID() });

    // Then
    expect(approvalResponse.status).toBe(201);
    expect(revocationResponse.status).toBe(201);
    expect([pending, approved, revoked].map((value) => field(value, "event"))).toEqual([event, event, event]);
    expect([pending, approved, revoked].map((value) => Reflect.get(value, "reviewLiveness")))
      .toEqual(["current", "current", "current"]);
    expect(await decisionBytes(fixture.root)).toEqual(decisionFilesBefore);
  });
});

async function proof(origin: string, suffix: "policy" | "review-event", body: object): Promise<object> {
  const response = await fetch(`${origin}/v1/projects/project-a/repositories/root/native-root-ci-proof/${suffix}`, {
    method: "POST", headers: { authorization: identityAuthorization, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(200);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("proof is invalid");
  return value;
}

function decision(input: { readonly origin: string; readonly reviewId: string;
  readonly suffix: "approvals" | "revocations"; readonly body: object }): Promise<Response> {
  return fetch(`${input.origin}/v1/projects/project-a/repositories/root/reviews/${input.reviewId}/${input.suffix}`, {
    method: "POST", headers: { authorization: reviewerAuthorization, "x-dim-generation-id": generationId,
      "content-type": "application/json" }, body: JSON.stringify(input.body)
  });
}

function field(value: object, key: string): object {
  const selected = Reflect.get(value, key);
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) throw new TypeError("field is invalid");
  return selected;
}

function stringField(value: object, key: string): string {
  const selected = Reflect.get(value, key);
  if (typeof selected !== "string") throw new TypeError("field is invalid");
  return selected;
}

async function decisionBytes(root: string): Promise<readonly Buffer[]> {
  const repository = rootRepository(root);
  const paths = [join(repository, "dim-authoritative-approvals"), join(repository, "dim-authoritative-revocations")];
  const byStore = await Promise.all(paths.map(async (path) => {
    const names = (await readdir(path, { recursive: true })).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map((name) => readFile(join(path, name))));
  }));
  return byStore.flat();
}
