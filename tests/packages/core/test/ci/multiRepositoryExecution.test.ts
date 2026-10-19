import { parseAuthoritativeNativeReviewEnvelope } from "../../../../../core/packages/native-git/src/authoritative-native-review-schema.js";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StaleExecutionSourceError } from "../../../../../core/packages/managed/src/ci/source.js";
import { executionCandidateCredential } from "../../../../../core/packages/managed/src/ci/candidateLease.js";
import { createNativeGitExecutionReadAuthority } from "../../../../../core/packages/managed/src/nativeGitCandidateReadAuthority.js";
import { verifyAndMaterializeCandidate } from "../../../../../core/packages/managed/src/ci/candidate.js";
import { createBundleReview, reviewProposalRef, addCandidateCommit } from "../../../native-git/test/nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, createFinalizeRoot, generationId, humanReviewerAuthorization, runGit } from "../../../native-git/test/nativeRootImportFinalizeFixture.js";
import { multiRepositoryExecutionFixture, type MultiRepositoryExecutionFixture } from "./multiRepositoryExecutionFixture.js";

let fixture: MultiRepositoryExecutionFixture;
beforeEach(async () => { fixture = await multiRepositoryExecutionFixture(); }, 30_000);
afterEach(cleanupFinalizeFixtures);

it("materializes exact joint inputs while public-only leases cannot read private Git", async () => {
  const f = fixture;
  const joint = await f.authorize("joint"), publicOnly = await f.authorize("public-check");
  expect(Object.keys(joint.descriptor.inputs)).toEqual(["private", "public"]);
  expect(joint.descriptor.inputs.private).toEqual({ commit: f.privateBundle.commit, tree: f.privateBundle.tree });
  expect(Object.keys(publicOnly.descriptor.inputs)).toEqual(["public"]);
  expect((await f.post(`/v1/projects/project-a/repositories/private/reviews/${f.envelope.review.reviewId}/approvals`,
    humanReviewerAuthorization, { requestId: randomUUID() })).status).toBe(404);
  const jointCredential = executionCandidateCredential(() => f.source.candidate(joint), f.now);
  const signal = new AbortController().signal;
  const publicRead = await f.source.candidate(publicOnly), firstJoint = await jointCredential(signal);
  expect((await fetch(`${f.native.service.origin}/v1/projects/project-a/repositories/private.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from(`${publicRead.username}:${publicRead.password}`).toString("base64")}` }
  })).status).toBe(403);
  const directory = await createFinalizeRoot("joint-materialized");
  const authority = createNativeGitExecutionReadAuthority({ descriptor: joint.descriptor, gitExecutable: "/usr/bin/git",
    serviceEndpoint: f.native.service.origin, temporaryRoot: directory, credential: firstJoint, credentialProvider: jointCredential });
  await verifyAndMaterializeCandidate({ descriptor: joint.descriptor, descriptorDigest: joint.descriptorDigest, authority,
    workspace: join(directory, "workspace"), scriptFile: join(directory, "script"), signal });
  expect((await readdir(join(directory, "workspace"))).sort()).toEqual(["private", "public"]);
  expect(await readFile(join(directory, "workspace/private/README.md"), "utf8")).toBe("private repository bytes\n");
  expect(await readdir(join(directory, "workspace/private"))).toEqual(["README.md"]);
}, 30_000);

it("refreshes stable leases and requires a new review when an independently promoted input changes", async () => {
  const f = fixture, signal = new AbortController().signal;
  const joint = await f.authorize("joint"), publicOnly = await f.authorize("public-check");
  const jointCredential = executionCandidateCredential(() => f.source.candidate(joint), f.now);
  const publicCredential = executionCandidateCredential(() => f.source.candidate(publicOnly), f.now);
  const first = await jointCredential(signal); await publicCredential(signal);
  f.advanceClock(29_500);
  expect((await jointCredential(signal)).username).not.toBe(first.username);
  const publicHead = await f.publicHead();
  const privateReview = await f.promotePrivate();
  expect(await f.publicHead()).toBe(publicHead);
  f.advanceClock(30_000);
  await expect(jointCredential(signal)).rejects.toBeInstanceOf(StaleExecutionSourceError);
  await expect(publicCredential(signal)).rejects.toBeInstanceOf(StaleExecutionSourceError);
  const path = "/v1/projects/project-a/repositories/public/reviews";
  const resolved = await f.post(`${path}/resolve`, humanReviewerAuthorization, { schemaVersion: 1, proposalRef: reviewProposalRef });
  expect(resolved.status).toBe(200);
  const current = parseAuthoritativeNativeReviewEnvelope(await resolved.json());
  expect(current.review.reviewId).not.toBe(f.envelope.review.reviewId);
  const repeated = await f.post(`${path}/resolve`, humanReviewerAuthorization, { schemaVersion: 1, proposalRef: reviewProposalRef });
  expect(repeated.status).toBe(200); expect(await repeated.json()).toEqual(current);
  expect(current.review.inputs.private?.commit).toBe(privateReview.review.candidateCommit);
  expect(joint.descriptor.inputs.private).toEqual({ commit: f.privateBundle.commit, tree: f.privateBundle.tree });
  const stale = await fetch(`${f.native.service.origin}${path}/${f.envelope.review.reviewId}`, {
    headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId }
  });
  expect(stale.status).toBe(200);
  expect(await stale.json()).toMatchObject({ staleReasons: expect.arrayContaining(["repository-inputs-changed"]) });
}, 30_000);

it("rejects candidate workflow changes that request a repository outside imported policy", async () => {
  const f = fixture, clone = await f.privateWriter();
  await addCandidateCommit(clone, ".dim/ci/runner.yml", Buffer.from("jobs:\n  escaped: {script: README.md, repositories: [public]}\n"));
  await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
  const denied = await createBundleReview(f.native.service, "private");
  expect(denied.planning.status).toBe("invalid"); expect(denied.events).toEqual([]);
}, 30_000);
