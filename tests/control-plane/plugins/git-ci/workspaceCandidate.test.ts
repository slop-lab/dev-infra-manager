import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { executionGrantSchema } from "@slop-lab/dim-contracts-ci/execution";
import { activateFinalizeServiceForGeneration, activationTokenB, cleanupFinalizeFixtures, closeFinalizeService,
  generationB, generationId, runGit, startFinalizeServiceForGeneration, workspaceWriteIssuerAuthorization } from "../git-repositories/nativeRootImportFinalizeFixture.js";
import { idleNativeConfig } from "../git-repositories/bundleConfigFixture.js";
import { addCandidateCommit, nativeBundleReviewFixture, publishedReviewEnvelopes, publishedReviewNames, reviewWorkspaceId } from "./nativeBundleReviewFixture.js";
import { result, slot } from "../../../contracts/ci/executionFixture.js";
import { authoritativePolicy } from "../git-repositories/authoritativeNativeCandidateFixture.js";
import { gitPolicy } from "../../../support/git-policy.js";

afterEach(cleanupFinalizeFixtures);

it("requests and reports exact ordinary-branch CI idempotently within the workspace repository grant", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("workspace-candidate-ci");
  const candidateRef = "refs/heads/feature-ci";
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${candidateRef}`]);
  const candidateCommit = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD^{commit}"])).stdout.trim();
  const candidateTree = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  const lease = await issueWorkspaceLease(fixture.service.origin, fixture.repositoryId);
  const authorization = `Basic ${Buffer.from(`${lease.username}:${lease.password}`).toString("base64")}`;
  const requestId = randomUUID();
  const body = { schemaVersion: 1, requestId, candidateRef, candidateCommit, candidateTree };
  const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/workspace-ci/requests`;
  const before = await publishedReviewNames(fixture.root);

  // When
  const requested = await fetch(endpoint, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });

  // Then
  expect(requested.status, await requested.clone().text()).toBe(200);
  const receipt: unknown = await requested.json();
  if (!receipt || typeof receipt !== "object" || typeof Reflect.get(receipt, "reviewId") !== "string"
    || !Reflect.get(receipt, "status") || typeof Reflect.get(receipt, "status") !== "object") throw new Error("workspace CI receipt is invalid");
  const reviewId = Reflect.get(receipt, "reviewId");
  const receiptStatus = Reflect.get(receipt, "status");
  if (typeof reviewId !== "string" || !receiptStatus || typeof receiptStatus !== "object") throw new Error("workspace CI receipt is invalid");
  expect(Reflect.get(receiptStatus, "state")).toBe("pending");
  const repeated = await fetch(endpoint, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(repeated.status, await repeated.clone().text()).toBe(200);
  expect(await repeated.json()).toMatchObject({ reviewId, requestId });
  expect((await publishedReviewNames(fixture.root)).length).toBe(before.length + 1);

  const conflict = await fetch(endpoint, { method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ ...body, candidateTree: "0".repeat(candidateTree.length) }) });
  expect(conflict.status).toBe(409);
  const foreign = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/foreign/workspace-ci/requests/${requestId}`, { headers: { authorization } });
  expect(foreign.status).toBe(404);
  const protectedRequest = await fetch(endpoint, { method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ ...body, requestId: randomUUID(), candidateRef: "refs/heads/main" }) });
  expect(protectedRequest.status).toBe(403);

  const envelope = (await publishedReviewEnvelopes(fixture.root)).find((entry) => entry.review.reviewId === reviewId);
  if (!envelope || envelope.events.length === 0) throw new Error("workspace CI review plan is missing");
  const config = idleNativeConfig();
  for (const event of envelope.events) {
    const grantResponse = await post({ origin: fixture.service.origin, path: "/v1/execution-grants", credential: config.ci.grantIssuer, body: {
      executionId: randomUUID(), generationId, event, workerId: "worker-a", slotId: "primary", profile: slot.profile,
    } });
    expect(grantResponse.status, await grantResponse.clone().text()).toBe(201);
    const grant = executionGrantSchema.parse(await grantResponse.json());
    const { logs: _logs, ...evidence } = result(grant);
    const evidenceResponse = await post({ origin: fixture.service.origin,
      path: `/v1/executions/project-a/root/${grant.executionId}/evidence`, credential: config.ci.resultReporter, body: evidence });
    expect(evidenceResponse.status, await evidenceResponse.clone().text()).toBe(201);
  }
  const status = await fetch(`${endpoint}/${requestId}`, { headers: { authorization } });
  expect(status.status, await status.clone().text()).toBe(200);
  expect(await status.json()).toMatchObject({ reviewId,
    status: { state: "succeeded", jobs: envelope.events.map(() => ({ status: "succeeded" })) } });
  await addCandidateCommit(fixture.clone, "later.txt", Buffer.from("later\n"));
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${candidateRef}`]);
  const stale = await fetch(`${endpoint}/${requestId}`, { headers: { authorization } });
  expect(stale.status, await stale.clone().text()).toBe(200);
  expect(await stale.json()).toMatchObject({ status: { state: "stale" } });
}, 30_000);

it("rejects missing CI policy without publishing a new candidate request or review", async () => {
  const configured = authoritativePolicy(), policy = gitPolicy({ "code-review": configured.extensions["code-review"], "merge-policy": configured.extensions["merge-policy"] });
  const fixture = await nativeBundleReviewFixture("workspace-ci-policy", undefined, policy), lease = await issueWorkspaceLease(fixture.service.origin, fixture.repositoryId);
  const candidateRef = "refs/heads/ordinary"; await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${candidateRef}`]);
  const before = await publishedReviewNames(fixture.root);
  const response = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/workspace-ci/requests`, { method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${lease.username}:${lease.password}`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), candidateRef,
      candidateCommit: (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim(),
      candidateTree: (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD^{tree}"])).stdout.trim() }),
  });
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: expect.stringContaining("no configured Git CI policy") });
  expect(await publishedReviewNames(fixture.root)).toEqual(before);
}, 30_000);

it("requires a new current-generation request ID while reusing the immutable review identity", async () => {
  const fixture = await nativeBundleReviewFixture("workspace-ci-generation"), candidateRef = "refs/heads/generation-candidate";
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${candidateRef}`]);
  const input = { schemaVersion: 1, requestId: randomUUID(), candidateRef,
    candidateCommit: (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim(),
    candidateTree: (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD^{tree}"])).stdout.trim() };
  const leaseA = await issueWorkspaceLease(fixture.service.origin, fixture.repositoryId);
  const authorizationA = `Basic ${Buffer.from(`${leaseA.username}:${leaseA.password}`).toString("base64")}`;
  const path = "/v1/projects/project-a/repositories/root/workspace-ci/requests";
  const first = await fetch(fixture.service.origin + path, { method: "POST", headers: { authorization: authorizationA, "content-type": "application/json" }, body: JSON.stringify(input) });
  expect(first.status).toBe(200);
  const firstReceipt: unknown = await first.json();
  const firstReviewId = firstReceipt && typeof firstReceipt === "object" ? Reflect.get(firstReceipt, "reviewId") : undefined;
  if (typeof firstReviewId !== "string") throw new Error("first review ID is missing");
  await closeFinalizeService(fixture.service);
  const servingB = await startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB);
  await activateFinalizeServiceForGeneration(servingB.origin, generationB, activationTokenB);
  const leaseB = await issueWorkspaceLease(servingB.origin, fixture.repositoryId, reviewWorkspaceId, generationB);
  const authorizationB = `Basic ${Buffer.from(`${leaseB.username}:${leaseB.password}`).toString("base64")}`;
  const oldStatus = await fetch(`${servingB.origin}${path}/${input.requestId}`, { headers: { authorization: authorizationB } });
  expect(oldStatus.status).toBe(200);
  expect(await oldStatus.json()).toMatchObject({ generationId, currentGenerationId: generationB, status: { state: "stale", reason: "request-generation-stale" } });

  const oldId = await fetch(servingB.origin + path, { method: "POST", headers: { authorization: authorizationB, "content-type": "application/json" }, body: JSON.stringify(input) });
  expect(oldId.status).toBe(409);
  const currentInput = { ...input, requestId: randomUUID() };
  const current = await fetch(servingB.origin + path, { method: "POST", headers: { authorization: authorizationB, "content-type": "application/json" },
    body: JSON.stringify(currentInput) });
  expect(current.status, await current.clone().text()).toBe(200);
  expect(await current.json()).toMatchObject({ reviewId: firstReviewId, status: { state: "pending" } });
  const sameIdCase = await fetch(servingB.origin + path, { method: "POST", headers: { authorization: authorizationB, "content-type": "application/json" }, body: JSON.stringify({ ...currentInput, requestId: currentInput.requestId.toUpperCase() }) });
  expect(sameIdCase.status).toBe(200); expect(await sameIdCase.json()).toMatchObject({ requestId: currentInput.requestId, reviewId: firstReviewId });
  const equivalent = await fetch(servingB.origin + path, { method: "POST", headers: { authorization: authorizationB, "content-type": "application/json" },
    body: JSON.stringify({ ...currentInput, requestId: randomUUID() }) });
  expect(equivalent.status, await equivalent.clone().text()).toBe(200);
  expect(await equivalent.json()).toMatchObject({ reviewId: firstReviewId, status: { state: "pending" } });
}, 30_000);

it("reports non-required planned jobs and denies foreign workspace ownership and every protected candidate ref", async () => {
  const fixture = await nativeBundleReviewFixture("workspace-ci-scope", undefined, authoritativePolicy(["owner"], [], []));
  const lease = await issueWorkspaceLease(fixture.service.origin, fixture.repositoryId), other = await issueWorkspaceLease(fixture.service.origin, fixture.repositoryId, Buffer.alloc(32, 17).toString("base64url"));
  const authorization = `Basic ${Buffer.from(`${lease.username}:${lease.password}`).toString("base64")}`, foreign = `Basic ${Buffer.from(`${other.username}:${other.password}`).toString("base64")}`;
  const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/workspace-ci/requests`, candidateRef = "refs/heads/ordinary";
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${candidateRef}`]);
  const body = { schemaVersion: 1, requestId: randomUUID(), candidateRef,
    candidateCommit: (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim(),
    candidateTree: (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD^{tree}"])).stdout.trim() };
  const requested = await fetch(endpoint, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(requested.status).toBe(200); expect(await requested.json()).toMatchObject({ status: { state: "pending", jobs: expect.arrayContaining([{ name: "source", kind: "ordinary-sysbox", status: "pending" }]), review: { state: "not-required", requiredJobs: [] } } });
  expect((await fetch(`${endpoint}/${body.requestId}`, { headers: { authorization: foreign } })).status).toBe(404);
  expect((await fetch(endpoint, { method: "POST", headers: { authorization: foreign, "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(409);
  for (const protectedRef of ["refs/heads/main", "refs/heads/development"]) {
    const denied = await fetch(endpoint, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ ...body, requestId: randomUUID(), candidateRef: protectedRef }) });
    expect(denied.status).toBe(403);
  }
}, 30_000);

async function issueWorkspaceLease(origin: string, repositoryId: string, workspaceId = reviewWorkspaceId,
  servingGeneration = generationId): Promise<{ readonly username: string; readonly password: string }> {
  const response = await fetch(`${origin}/v1/projects/project-a/repositories/${repositoryId}/workspace-write-leases`, {
    method: "POST", headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId: servingGeneration, repositoryId, workspaceId }),
  });
  if (response.status !== 201) throw new Error("workspace lease was not issued");
  const value: unknown = await response.json();
  const username = value && typeof value === "object" ? Reflect.get(value, "username") : undefined;
  const password = value && typeof value === "object" ? Reflect.get(value, "password") : undefined;
  if (typeof username !== "string" || typeof password !== "string") throw new Error("workspace lease is invalid");
  return { username, password };
}

function post(input: { readonly origin: string; readonly path: string; readonly credential: { readonly username: string; readonly password: string }; readonly body: unknown }): Promise<Response> {
  const { origin, path, credential, body } = input;
  return fetch(origin + path, { method: "POST", headers: {
    authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
    "x-dim-generation-id": generationId, "content-type": "application/json",
  }, body: JSON.stringify(body) });
}
