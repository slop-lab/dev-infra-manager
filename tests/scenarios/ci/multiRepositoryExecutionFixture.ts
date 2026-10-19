import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { nativeGitExecutionSource } from "../../../packages/control-plane/plugins/ci/src/source.js";
import { nativeBundleReviewFixture, createBundleReview, reviewProposalRef, reviewWorkspaceId, addCandidateCommit } from "../../control-plane/plugins/native-git/nativeBundleReviewFixture.js";
import { authoritativePolicy } from "../../control-plane/plugins/native-git/authoritativeNativeCandidateFixture.js";
import { createRootBundle, createFinalizeRoot, uploadRootBundle, parseImportReceipt, finalizeRootImport,
  importer, projectInput, generationId, humanReviewerAuthorization, hostPromoterAuthorization,
  workspaceWriteIssuerAuthorization, runGit } from "../../control-plane/plugins/native-git/nativeRootImportFinalizeFixture.js";
import { idleNativeConfig } from "../../control-plane/plugins/native-git/bundleConfigFixture.js";
import { assignment } from "../../contracts/ci/executionFixture.js";

/** Fresh actual Git repositories and authority per scenario, without test-order state. */
export async function multiRepositoryExecutionFixture() {
  let now = Date.now();
  const native = await nativeBundleReviewFixture("joint-inputs", undefined,
    authoritativePolicy(["owner"], [], [], ["private", "public"]), undefined, undefined, undefined,
    undefined, {}, undefined, `jobs:
  public-check:
    script: .dim/ci/jobs/source.bash
    repositories: [public]
  joint:
    script: .dim/ci/jobs/integration.bash
    repositories: [public, private]
`, () => now, "public");
  const privateBundle = await createRootBundle({ "README.md": "private repository bytes\n" });
  await native.service.prepareProject(generationId, importer.hostId, projectInput("project-a", "private"));
  const imported = await uploadRootBundle(native.service.origin, privateBundle,
    authoritativePolicy(["owner"], [], [], ["private"]), "private");
  const receipt = parseImportReceipt(await imported.json());
  const finalized = await finalizeRootImport(native.service.origin, { schemaVersion: 1, generationId,
    importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest }, undefined, "private");
  if (finalized.status !== 200) throw new Error("private fixture repository import failed");
  const envelope = await createBundleReview(native.service, "public");
  const source = nativeGitExecutionSource({ ...idleNativeConfig().ci, endpoint: native.service.origin }, generationId);
  const post = (path: string, authorization: string, body: unknown) => fetch(`${native.service.origin}${path}`, {
    method: "POST", headers: { authorization, "content-type": "application/json", "x-dim-generation-id": generationId },
    body: JSON.stringify(body)
  });
  async function privateWriter() {
    const response = await post("/v1/projects/project-a/repositories/private/workspace-write-leases", workspaceWriteIssuerAuthorization,
      { schemaVersion: 1, generationId, repositoryId: "private", workspaceId: reviewWorkspaceId });
    if (response.status !== 201) throw new Error("private fixture writer lease failed");
    const lease: unknown = await response.json();
    if (typeof lease !== "object" || lease === null || typeof Reflect.get(lease, "username") !== "string"
      || typeof Reflect.get(lease, "password") !== "string") throw new Error("invalid private fixture writer lease");
    const remote = new URL("/v1/projects/project-a/repositories/private.git", native.service.origin);
    remote.username = Reflect.get(lease, "username"); remote.password = Reflect.get(lease, "password");
    const clone = await createFinalizeRoot("private-writer");
    await runGit("/usr/bin/git", ["clone", remote.href, clone]);
    await runGit("/usr/bin/git", ["-C", clone, "config", "user.name", "DIM test"]);
    await runGit("/usr/bin/git", ["-C", clone, "config", "user.email", "test@example.invalid"]);
    return clone;
  }
  return {
    native, privateBundle, envelope, source, post, privateWriter,
    now: () => now,
    advanceClock(milliseconds: number) { now += milliseconds; },
    async authorize(jobName: string) {
      const event = envelope.events.find((event) => event.jobName === jobName);
      if (!event) throw new Error(`missing fixture job '${jobName}'`);
      return source.authorize({ ...assignment(), event, generationId });
    },
    async publicHead() {
      return (await runGit("/usr/bin/git", ["--git-dir", join(native.root, "project-a/public.git"), "rev-parse", "refs/heads/main"])).stdout.trim();
    },
    async promotePrivate() {
      const clone = await privateWriter();
      await addCandidateCommit(clone, "README.md", Buffer.from("new private repository head\n"));
      await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
      const review = await createBundleReview(native.service, "private");
      const path = `/v1/projects/project-a/repositories/private/reviews/${review.review.reviewId}`;
      const approval = await post(`${path}/approvals`, humanReviewerAuthorization, { requestId: randomUUID() });
      if (approval.status !== 201) throw new Error("private fixture approval failed");
      const promotion = await post(`${path}/promotions`, hostPromoterAuthorization, { schemaVersion: 1 });
      if (promotion.status !== 201) throw new Error("private fixture promotion failed");
      return review;
    }
  };
}
export type MultiRepositoryExecutionFixture = Awaited<ReturnType<typeof multiRepositoryExecutionFixture>>;
