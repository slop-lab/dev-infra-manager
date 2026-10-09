import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
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
  generationId,
  foreignHumanReviewer,
  humanReviewerAuthorization,
  rootRepository,
  runGit,
  startFinalizeService,
  workspaceWriteIssuerAuthorization
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("installed native human approval self-revocation", () => {
  it("revokes one immutable approval, safely reapproves, and ignores a delayed old revocation across restart", async () => {
    const fixture = await nativeBundleReviewFixture("human-revocation-lifecycle");
    const { review } = await createBundleReview(fixture.service);
    const endpoint = reviewEndpoint(fixture.service.origin, review.reviewId);
    const protectedBefore = await protectedHead(fixture.root);
    const reviewPath = join(rootRepository(fixture.root), "dim-authoritative-reviews", "proposals",
      `${review.reviewId}.json`);
    const reviewBefore = await readFile(reviewPath);
    const approvalA = await approve(endpoint, randomUUID());
    expect(approvalA.response.status).toBe(201);
    expect(approvalA.body.status).toBe("approved");

    const revokedA = await revoke(endpoint, approvalA.body.approvalId);
    expect(revokedA.status).toBe(201);
    expect(await status(endpoint)).toMatchObject({ status: "revoked", staleReasons: [] });
    const replayA = await approve(endpoint, approvalA.body.requestId);
    expect(replayA.response.status).toBe(200);
    expect(replayA.body).toMatchObject({ approvalId: approvalA.body.approvalId, status: "revoked" });

    const approvalB = await approve(endpoint, randomUUID());
    expect(approvalB.response.status).toBe(201);
    expect(approvalB.body).toMatchObject({ status: "approved" });
    expect(approvalB.body.approvalId).not.toBe(approvalA.body.approvalId);
    expect((await revoke(endpoint, approvalA.body.approvalId)).status).toBe(200);
    expect(await status(endpoint)).toMatchObject({ status: "approved", staleReasons: [] });

    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root);
    const restartedEndpoint = reviewEndpoint(restarted.origin, review.reviewId);
    expect(await status(restartedEndpoint)).toMatchObject({
      status: "approved",
      approvals: expect.arrayContaining([
        expect.objectContaining({ approvalId: approvalA.body.approvalId }),
        expect.objectContaining({ approvalId: approvalB.body.approvalId })
      ]),
      revocations: [expect.objectContaining({ approvalId: approvalA.body.approvalId, reviewerId: "owner" })]
    });
    expect((await revoke(restartedEndpoint, approvalA.body.approvalId)).status).toBe(200);
    expect(await protectedHead(fixture.root)).toBe(protectedBefore);
    expect(await readFile(reviewPath)).toEqual(reviewBefore);
    const records = join(rootRepository(fixture.root), "dim-authoritative-revocations", "records");
    expect(await readdir(records)).toHaveLength(1);
    expect((await stat(join(records, `${stringField(await revokedA.json(), "revocationId")}.json`))).mode & 0o777)
      .toBe(0o600);
  });

  it("allows the owner to revoke a stale historical approval but denies other authorities and non-exact requests", async () => {
    const fixture = await nativeBundleReviewFixture("human-revocation-auth");
    const { review } = await createBundleReview(fixture.service);
    const endpoint = reviewEndpoint(fixture.service.origin, review.reviewId);
    const approval = await approve(endpoint, randomUUID());
    await addCandidateCommit(fixture.clone, "later.txt", Buffer.from("later\n"));
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    const request = { method: "POST", headers: jsonHeaders(humanReviewerAuthorization),
      body: JSON.stringify({ approvalId: approval.body.approvalId }) } as const;
    const ordinaryQuery = idleNativeConfig().ordinaryCi.query;

    const denied = await Promise.all([
      fetch(`${endpoint}/revocations`, { ...request, headers: jsonHeaders(authorization) }),
      fetch(`${endpoint}/revocations`, { ...request, headers: jsonHeaders(workspaceWriteIssuerAuthorization) }),
      fetch(`${endpoint}/revocations`, { ...request, headers: jsonHeaders(basic(
        ordinaryQuery.username, ordinaryQuery.password
      )) }),
      fetch(`${endpoint}/revocations`, { ...request, headers: jsonHeaders(basic(
        foreignHumanReviewer.username, foreignHumanReviewer.password
      )) }),
      fetch(`${endpoint}/revocations?all=true`, request),
      fetch(`${endpoint.replace("/project-a/", "/project-b/")}/revocations`, request),
      fetch(`${endpoint}/revocations`, { ...request, headers: {
        ...request.headers, "x-dim-generation-id": "b".repeat(64)
      } })
    ]);
    expect(denied.map(({ status: responseStatus }) => responseStatus))
      .toEqual([403, 403, 403, 403, 404, 404, 409]);
    expect(await readdir(join(rootRepository(fixture.root), "dim-authoritative-approvals", "records")))
      .toHaveLength(1);
    await expect(readdir(join(rootRepository(fixture.root), "dim-authoritative-revocations")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const revoked = await revoke(endpoint, approval.body.approvalId);
    expect(revoked.status).toBe(201);
    expect(await revoked.json()).toMatchObject({
      approvalId: approval.body.approvalId,
      reviewerId: "owner",
      status: "stale",
      staleReasons: expect.arrayContaining(["candidate-commit-changed", "candidate-tree-changed"])
    });
    expect(await status(endpoint)).toMatchObject({ status: "stale" });
  });

  it("rejects tampered immutable revocation bytes at startup without rewriting them", async () => {
    const fixture = await nativeBundleReviewFixture("human-revocation-tamper");
    const { review } = await createBundleReview(fixture.service);
    const endpoint = reviewEndpoint(fixture.service.origin, review.reviewId);
    const approval = await approve(endpoint, randomUUID());
    const revocation = await revoke(endpoint, approval.body.approvalId);
    const revocationBody: unknown = await revocation.json();
    const path = join(rootRepository(fixture.root), "dim-authoritative-revocations", "records",
      `${stringField(revocationBody, "revocationId")}.json`);
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.revokedAt = "2026-01-01T00:00:00.000Z";
    await writeFile(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    const tampered = await readFile(path);
    await closeFinalizeService(fixture.service);

    await expect(startFinalizeService(fixture.root)).rejects.toThrow(/revocation digest is invalid/);
    expect(await readFile(path)).toEqual(tampered);
  });
});

type ApprovalResponse = { readonly approvalId: string; readonly requestId: string; readonly status: string };

async function approve(endpoint: string, requestId: string): Promise<{
  readonly response: Response; readonly body: ApprovalResponse;
}> {
  const response = await fetch(`${endpoint}/approvals`, { method: "POST",
    headers: jsonHeaders(humanReviewerAuthorization), body: JSON.stringify({ requestId }) });
  return { response, body: approvalResponse(await response.json()) };
}

function revoke(endpoint: string, approvalId: string): Promise<Response> {
  return fetch(`${endpoint}/revocations`, { method: "POST", headers: jsonHeaders(humanReviewerAuthorization),
    body: JSON.stringify({ approvalId }) });
}

async function status(endpoint: string): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, { headers: {
    authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId
  } });
  expect(response.status).toBe(200);
  return objectValue(await response.json());
}

function jsonHeaders(authorizationHeader: string): Record<string, string> {
  return { authorization: authorizationHeader, "x-dim-generation-id": generationId,
    "content-type": "application/json" };
}

function reviewEndpoint(origin: string, reviewId: string): string {
  return `${origin}/v1/projects/project-a/repositories/root/reviews/${reviewId}`;
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function approvalResponse(value: unknown): ApprovalResponse {
  return {
    approvalId: stringField(value, "approvalId"),
    requestId: stringField(value, "requestId"),
    status: stringField(value, "status")
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RevocationFixtureError();
  return Object.fromEntries(Object.entries(value));
}

async function protectedHead(root: string): Promise<string> {
  return (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root), "rev-parse", "refs/heads/main"]))
    .stdout.trim();
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RevocationFixtureError();
  const selected = Reflect.get(value, field);
  if (typeof selected !== "string") throw new RevocationFixtureError();
  return selected;
}

class RevocationFixtureError extends Error {
  readonly name = "RevocationFixtureError";
}
