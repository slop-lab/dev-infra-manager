import { parseAuthoritativeNativeReviewEnvelope } from "../../../../../core/packages/native-git/src/authoritative-native-review-schema.js";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nativeGitExecutionSource, StaleExecutionSourceError } from "../../../../../core/packages/managed/src/ci/source.js";
import { executionCandidateCredential } from "../../../../../core/packages/managed/src/ci/candidateLease.js";
import { createNativeGitExecutionReadAuthority } from "../../../../../core/packages/managed/src/nativeGitCandidateReadAuthority.js";
import { verifyAndMaterializeCandidate } from "../../../../../core/packages/managed/src/ci/candidate.js";
import { authoritativePolicy } from "../../../native-git/test/authoritativeNativeCandidateFixture.js";
import { nativeBundleReviewFixture, createBundleReview, reviewProposalRef, reviewWorkspaceId, addCandidateCommit } from "../../../native-git/test/nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, createRootBundle, createFinalizeRoot, uploadRootBundle, parseImportReceipt,
  finalizeRootImport, importer, projectInput, generationId, humanReviewerAuthorization, hostPromoterAuthorization,
  workspaceWriteIssuerAuthorization, runGit } from "../../../native-git/test/nativeRootImportFinalizeFixture.js";
import { idleNativeConfig } from "../../../native-git/test/bundleConfigFixture.js";
import { assignment } from "./executionFixture.js";

afterEach(cleanupFinalizeFixtures);
it("binds joint CI to exact repository snapshots, denies private reads to public-only jobs, and fences stale dependency refresh", async () => {
  let now = Date.now();
  const policy = authoritativePolicy(["owner"], [], [], ["private", "public"]);
  const fixture = await nativeBundleReviewFixture("joint-inputs", undefined, policy, undefined, undefined, undefined,
    undefined, {}, undefined, `jobs:
  public-check:
    script: .dim/ci/jobs/source.bash
    repositories: [public]
  joint:
    script: .dim/ci/jobs/integration.bash
    repositories: [public, private]
`, () => now, "public");
  const privateBundle = await createRootBundle({ "README.md": "private repository bytes\n" });
  await fixture.service.prepareProject(generationId, importer.hostId, projectInput("project-a", "private"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(fixture.service.origin, privateBundle,
    authoritativePolicy(["owner"], [], [], ["private"]), "private")).json());
  expect((await finalizeRootImport(fixture.service.origin, { schemaVersion: 1, generationId,
    importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest }, undefined, "private")).status).toBe(200);
  const envelope = await createBundleReview(fixture.service, "public");
  expect(envelope.review.repositoryId).toBe("public");
  const jointEvent = envelope.events.find((event) => event.jobName === "joint")!;
  const publicEvent = envelope.events.find((event) => event.jobName === "public-check")!;
  expect(Object.keys(jointEvent.inputs)).toEqual(["private", "public"]);
  expect(jointEvent.inputs.private).toEqual({ commit: privateBundle.commit, tree: privateBundle.tree });
  expect(Object.keys(publicEvent.inputs)).toEqual(["public"]);
  expect((await post(`/v1/projects/project-a/repositories/private/reviews/${envelope.review.reviewId}/approvals`,
    humanReviewerAuthorization, { requestId: randomUUID() })).status).toBe(404);
  const source = nativeGitExecutionSource({ ...idleNativeConfig().ci, endpoint: fixture.service.origin }, generationId);
  const joint = await source.authorize({ ...assignment(), event: jointEvent, generationId });
  const publicOnly = await source.authorize({ ...assignment(), event: publicEvent, generationId });
  const jointCredential = executionCandidateCredential(() => source.candidate(joint), () => now);
  const publicCredential = executionCandidateCredential(() => source.candidate(publicOnly), () => now);
  const signal = new AbortController().signal;
  const publicRead = await publicCredential(signal), firstJoint = await jointCredential(signal);
  expect((await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/private.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from(`${publicRead.username}:${publicRead.password}`).toString("base64")}` }
  })).status).toBe(403);
  const directory = await createFinalizeRoot("joint-materialized");
  const authority = createNativeGitExecutionReadAuthority({ descriptor: joint.descriptor, gitExecutable: "/usr/bin/git",
    serviceEndpoint: fixture.service.origin, temporaryRoot: directory, credential: firstJoint, credentialProvider: jointCredential });
  await verifyAndMaterializeCandidate({ descriptor: joint.descriptor, descriptorDigest: joint.descriptorDigest, authority,
    workspace: join(directory, "workspace"), scriptFile: join(directory, "script"), signal });
  expect((await readdir(join(directory, "workspace"))).sort()).toEqual(["private", "public"]);
  expect(await readFile(join(directory, "workspace/private/README.md"), "utf8")).toBe("private repository bytes\n");
  expect(await readdir(join(directory, "workspace/private"))).toEqual(["README.md"]);
  now += 29_500;
  expect((await jointCredential(signal)).username).not.toBe(firstJoint.username);
  // Promote only the private repository through its own review and protected-ref CAS.
  const leaseResponse = await post("/v1/projects/project-a/repositories/private/workspace-write-leases", workspaceWriteIssuerAuthorization,
    { schemaVersion: 1, generationId, repositoryId: "private", workspaceId: reviewWorkspaceId });
  expect(leaseResponse.status).toBe(201);
  const lease: unknown = await leaseResponse.json();
  if (lease === null || typeof lease !== "object" || typeof Reflect.get(lease, "username") !== "string" || typeof Reflect.get(lease, "password") !== "string") throw new Error("invalid fixture lease");
  const remote = new URL("/v1/projects/project-a/repositories/private.git", fixture.service.origin);
  remote.username = String(Reflect.get(lease, "username")); remote.password = String(Reflect.get(lease, "password"));
  const clone = await createFinalizeRoot("private-writer");
  await runGit("/usr/bin/git", ["clone", remote.href, clone]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.name", "DIM test"]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.email", "test@example.invalid"]);
  await addCandidateCommit(clone, "README.md", Buffer.from("new private repository head\n"));
  await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
  const privateReview = await createBundleReview(fixture.service, "private");
  const reviewPath = `/v1/projects/project-a/repositories/private/reviews/${privateReview.review.reviewId}`;
  expect((await post(`${reviewPath}/approvals`, humanReviewerAuthorization, { requestId: randomUUID() })).status).toBe(201);
  expect((await post(`${reviewPath}/promotions`, hostPromoterAuthorization, { schemaVersion: 1 })).status).toBe(201);
  now += 30_000;
  await expect(jointCredential(signal)).rejects.toBeInstanceOf(StaleExecutionSourceError);
  await expect(publicCredential(signal)).rejects.toBeInstanceOf(StaleExecutionSourceError);
  const resolved = await post("/v1/projects/project-a/repositories/public/reviews/resolve", humanReviewerAuthorization,
    { schemaVersion: 1, proposalRef: reviewProposalRef });
  expect(resolved.status).toBe(200);
  const refreshedReview = parseAuthoritativeNativeReviewEnvelope(await resolved.json());
  expect(refreshedReview.review.reviewId).not.toBe(envelope.review.reviewId);
  const repeated = await post("/v1/projects/project-a/repositories/public/reviews/resolve", humanReviewerAuthorization,
    { schemaVersion: 1, proposalRef: reviewProposalRef });
  expect(repeated.status).toBe(200); expect(await repeated.json()).toEqual(refreshedReview);
  expect(refreshedReview.review.inputs.private?.commit).toBe(privateReview.review.candidateCommit);
  expect(joint.descriptor.inputs.private).toEqual({ commit: privateBundle.commit, tree: privateBundle.tree });
  const staleResponse = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/public/reviews/${envelope.review.reviewId}`, {
    headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId }
  });
  expect(staleResponse.status).toBe(200);
  expect(await staleResponse.json()).toMatchObject({ staleReasons: expect.arrayContaining(["repository-inputs-changed"]) });
  await addCandidateCommit(clone, ".dim/ci/runner.yml", Buffer.from("jobs:\n  escaped: {script: README.md, repositories: [public]}\n"));
  await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
  const denied = await createBundleReview(fixture.service, "private");
  expect(denied.planning.status).toBe("invalid"); expect(denied.events).toEqual([]);
  async function post(path: string, authorization: string, body: unknown) {
    return fetch(`${fixture.service.origin}${path}`, { method: "POST", headers: { authorization,
      "content-type": "application/json", "x-dim-generation-id": generationId }, body: JSON.stringify(body) });
  }
// This scenario imports, materializes and promotes independent repositories on shared CI CPUs.
// Production request and lease deadlines stay independently bounded.
}, 60_000);
