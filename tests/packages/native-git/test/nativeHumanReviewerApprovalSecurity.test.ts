import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { idleNativeConfig } from "./bundleConfigFixture.js";
import {
  addCandidateCommit,
  createBundleReview,
  nativeBundleReviewFixture,
  reviewProposalRef
} from "./nativeBundleReviewFixture.js";
import {
  authorization,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  foreignHumanReviewer,
  generationId,
  humanReviewerAuthorization,
  rootRepository,
  runGit,
  startFinalizeService,
  workspaceWriteIssuerAuthorization
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("installed native human approval security", () => {
  it("denies non-review roles, unrequired reviewers, and non-exact requests without evidence", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-approval-denials");
    const { review } = await createBundleReview(fixture.service);
    const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}/approvals`;
    const ordinaryQuery = idleNativeConfig().ordinaryCi.query;
    const foreignAuthorization = basic(foreignHumanReviewer.username, foreignHumanReviewer.password);
    const request = { method: "POST", headers: { "x-dim-generation-id": generationId,
      "content-type": "application/json" }, body: JSON.stringify({ requestId: randomUUID() }) } as const;

    // When
    const responses = await Promise.all([
      fetch(endpoint, request),
      fetch(endpoint, { ...request, headers: { ...request.headers, authorization } }),
      fetch(endpoint, { ...request, headers: { ...request.headers, authorization: workspaceWriteIssuerAuthorization } }),
      fetch(endpoint, { ...request, headers: { ...request.headers,
        authorization: basic(ordinaryQuery.username, ordinaryQuery.password) } }),
      fetch(endpoint, { ...request, headers: { ...request.headers, authorization: foreignAuthorization } }),
      fetch(`${endpoint}?approve=true`, { ...request, headers: {
        ...request.headers, authorization: humanReviewerAuthorization
      } }),
      fetch(endpoint, { headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId } }),
      fetch(endpoint, { method: "POST", headers: { authorization: humanReviewerAuthorization,
        "x-dim-generation-id": generationId, "content-type": "application/json" }, body: "{}" })
    ]);

    // Then
    expect(responses.map(({ status }) => status)).toEqual([401, 403, 403, 403, 403, 404, 404, 400]);
    await expect(readdir(join(rootRepository(fixture.root), "dim-authoritative-approvals")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses candidate and protected-ref drift without publishing approval evidence", async () => {
    // Given
    const candidateFixture = await nativeBundleReviewFixture("human-approval-candidate-drift");
    const candidateReview = await createBundleReview(candidateFixture.service);
    await addCandidateCommit(candidateFixture.clone, "later.txt", Buffer.from("later\n"));
    await runGit("/usr/bin/git", ["-C", candidateFixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    const protectedFixture = await nativeBundleReviewFixture("human-approval-protected-drift");
    const protectedReview = await createBundleReview(protectedFixture.service);
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(protectedFixture.root), "update-ref",
      "refs/heads/main", protectedReview.review.candidateCommit, protectedReview.review.expectedProtectedHead]);

    // When
    const candidateResponse = await approve(candidateFixture.service.origin, candidateReview.review.reviewId);
    const protectedResponse = await approve(protectedFixture.service.origin, protectedReview.review.reviewId);

    // Then
    expect(candidateResponse.status).toBe(409);
    expect([409, 503]).toContain(protectedResponse.status);
    for (const fixture of [candidateFixture, protectedFixture]) {
      await expect(readdir(join(rootRepository(fixture.root), "dim-authoritative-approvals")))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("publishes only stale old-tuple evidence when the proposal moves after final proof", async () => {
    // Given
    const entered = deferredSignal();
    const publication = deferredSignal();
    const fixture = await nativeBundleReviewFixture("human-approval-race", undefined, undefined, {
      async beforeApprovalPublication() {
        entered.resolve();
        await publication.promise;
      }
    });
    const { review } = await createBundleReview(fixture.service);

    // When
    const approving = approve(fixture.service.origin, review.reviewId);
    await entered.promise;
    await addCandidateCommit(fixture.clone, "raced.txt", Buffer.from("raced\n"));
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    publication.resolve();
    const approval = await approving;
    const inspected = await fetch(
      `${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}`,
      { headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId } }
    );

    // Then
    expect(approval.status).toBe(201);
    expect(await approval.json()).toMatchObject({ status: "stale",
      staleReasons: expect.arrayContaining(["candidate-commit-changed", "candidate-tree-changed"]) });
    expect(await inspected.json()).toMatchObject({
      status: "stale",
      staleReasons: expect.arrayContaining(["candidate-commit-changed", "candidate-tree-changed"])
    });
  });

  it("rejects tampered immutable approval bytes at startup without rewriting them", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-approval-tamper");
    const { review } = await createBundleReview(fixture.service);
    const response = await approve(fixture.service.origin, review.reviewId);
    const body: unknown = await response.json();
    const approvalId = stringField(body, "approvalId");
    const path = join(rootRepository(fixture.root), "dim-authoritative-approvals", "records", `${approvalId}.json`);
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.approvedAt = "2026-01-01T00:00:00.000Z";
    await writeFile(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    const tampered = await readFile(path);
    await closeFinalizeService(fixture.service);

    // When / Then
    await expect(startFinalizeService(fixture.root)).rejects.toThrow(/approval digest is invalid/);
    expect(await readFile(path)).toEqual(tampered);
  });
});

function approve(origin: string, reviewId: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/repositories/root/reviews/${reviewId}/approvals`, {
    method: "POST",
    headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId,
      "content-type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID() })
  });
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
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

function deferredSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return {
    promise,
    resolve() {
      if (release === undefined) throw new ApprovalFixtureError();
      release();
    }
  };
}
