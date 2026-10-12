import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFinalizeService,
  cleanupFinalizeFixtures,
  foreignHumanReviewer,
  generationId,
  humanReviewerAuthorization,
  rootRepository,
  runGit,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";
import { authoritativePolicy } from "./authoritativeNativeCandidateFixture.js";
import { bundleSecrets } from "./bundleConfigFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("installed native human approval", () => {
  it("binds a required human approval to the exact current review without moving the protected ref", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-approval");
    const { review } = await createBundleReview(fixture.service);
    const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}`;
    const headers = { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId };
    const reviewPath = join(rootRepository(fixture.root), "dim-authoritative-reviews", "proposals", `${review.reviewId}.json`);
    const reviewBefore = await readFile(reviewPath);
    const protectedBefore = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root),
      "rev-parse", "refs/heads/main"])).stdout.trim();

    // When
    const approval = await fetch(`${endpoint}/approvals`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID() })
    });

    // Then
    expect(approval.status).toBe(201);
    const approvalBody: unknown = await approval.json();
    expect(approvalBody).toMatchObject({ reviewId: review.reviewId, reviewerId: "owner" });
    const inspected = await fetch(endpoint, { headers });
    expect(inspected.status).toBe(200);
    expect((await inspected.json()).status).toBe("approved");
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root),
      "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(protectedBefore);
    expect(await readFile(reviewPath)).toEqual(reviewBefore);
    const approvalPath = join(rootRepository(fixture.root), "dim-authoritative-approvals", "records",
      `${stringField(approvalBody, "approvalId")}.json`);
    expect((await stat(approvalPath)).mode & 0o777).toBe(0o600);
  });

  it("converges exact replay across restart and rejects a conflicting active request", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-approval-replay");
    const { review } = await createBundleReview(fixture.service);
    const path = `/v1/projects/project-a/repositories/root/reviews/${review.reviewId}/approvals`;
    const headers = { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId,
      "content-type": "application/json" };
    const requestId = randomUUID();
    const first = await fetch(`${fixture.service.origin}${path}`, {
      method: "POST", headers, body: JSON.stringify({ requestId })
    });
    const firstBytes = await first.text();
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root);

    // When
    const replay = await fetch(`${restarted.origin}${path}`, {
      method: "POST", headers, body: JSON.stringify({ requestId })
    });
    const conflict = await fetch(`${restarted.origin}${path}`, {
      method: "POST", headers, body: JSON.stringify({ requestId: randomUUID() })
    });

    // Then
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBytes);
    expect(conflict.status).toBe(409);
    expect(await readdir(join(rootRepository(fixture.root), "dim-authoritative-approvals", "records")))
      .toHaveLength(1);
  });

  it("requires every path-added reviewer before reporting approved", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-approval-path", undefined,
      authoritativePolicy(["owner"], [{ pathPrefix: "candidate.bin", reviewerIds: ["foreign"] }]));
    const { review } = await createBundleReview(fixture.service);
    const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}`;
    const headers = { "x-dim-generation-id": generationId, "content-type": "application/json" };

    // When
    await fetch(`${endpoint}/approvals`, { method: "POST", headers: {
      ...headers, authorization: humanReviewerAuthorization
    }, body: JSON.stringify({ requestId: randomUUID() }) });
    const pending = await fetch(endpoint, { headers: { ...headers, authorization: humanReviewerAuthorization } });
    const foreignAuthorization = `Basic ${Buffer.from(
      `${foreignHumanReviewer.username}:${foreignHumanReviewer.password}`
    ).toString("base64")}`;
    await fetch(`${endpoint}/approvals`, { method: "POST", headers: {
      ...headers, authorization: foreignAuthorization
    }, body: JSON.stringify({ requestId: randomUUID() }) });
    const approved = await fetch(endpoint, { headers: { ...headers, authorization: foreignAuthorization } });

    // Then
    expect((await pending.json()).status).toBe("pending");
    expect((await approved.json()).status).toBe("approved");
  });

  it("preserves security approval across a quality-only revision while rejecting stale CI evidence", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-approval-quality-revision");
    const envelope = await createBundleReview(fixture.service);
    const event = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
    if (event === undefined) throw new ApprovalFixtureError();
    const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${envelope.review.reviewId}`;
    const reviewerHeaders = { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId };
    expect((await fetch(`${endpoint}/approvals`, { method: "POST",
      headers: { ...reviewerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID() }) })).status).toBe(201);
    await closeFinalizeService(fixture.service);
    const ordinaryOnly = authoritativePolicy(["owner"], [], [
      { name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }
    ]);
    replaceImportedPolicy(fixture.root, ordinaryOnly);
    const restarted = await startFinalizeService(fixture.root);
    const identityAuthorization = `Basic ${Buffer.from(
      `ordinary-identity:${bundleSecrets.nativeIdentity}`
    ).toString("base64")}`;
    const proofHeaders = { authorization: identityAuthorization, "content-type": "application/json" };
    const proofRequest = { schemaVersion: 1, requestId: randomUUID(), generationId };
    const policyProof = await fetch(`${restarted.origin}/v1/projects/project-a/repositories/root/native-root-ci-proof/policy`, {
      method: "POST", headers: proofHeaders, body: JSON.stringify(proofRequest)
    });
    const currentRoot = recordField(await policyProof.json(), "currentRoot");

    // When
    const status = await fetch(endpoint.replace(fixture.service.origin, restarted.origin), { headers: reviewerHeaders });
    const staleEvidence = await fetch(
      `${restarted.origin}/v1/projects/project-a/repositories/root/native-root-ci-proof/review-event`, {
        method: "POST", headers: proofHeaders, body: JSON.stringify({ ...proofRequest,
          importNonce: stringField(currentRoot, "importNonce"), policyDigest: stringField(currentRoot, "policyDigest"),
          eventId: event.eventId, reviewId: event.reviewId,
          executionKind: event.executionKind, jobName: event.jobName })
      }
    );

    // Then
    expect(status.status).toBe(200);
    expect((await status.json()).status).toBe("approved");
    expect(staleEvidence.status).toBe(409);
  });
});

function replaceImportedPolicy(root: string, policy: object): void {
  const policyJson = JSON.stringify(policy);
  const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
  database.prepare("UPDATE native_project_root_import SET policy_json = ?, policy_sha256 = ?")
    .run(policyJson, createHash("sha256").update(policyJson).digest("hex"));
  database.close();
}

function recordField(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApprovalFixtureError();
  const selected = Reflect.get(value, field);
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) throw new ApprovalFixtureError();
  return selected;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApprovalFixtureError();
  const selected = Reflect.get(value, field);
  if (typeof selected !== "string") throw new ApprovalFixtureError();
  return selected;
}

class ApprovalFixtureError extends Error {
  readonly name = "ApprovalFixtureError";
}
