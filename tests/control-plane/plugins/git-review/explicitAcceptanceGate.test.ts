import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { reviewPreparations, readAuthoritativeNativeReviewEnvelopes } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { addCandidateCommit, nativeBundleReviewFixture } from "../git-ci/nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId, humanReviewerAuthorization, rootRepository, runGit } from "../git-repositories/nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

it("blocks approval of a newly resolved ordinary candidate while explicit acceptance is pending", async () => {
  // Given a candidate without an automatic proposal job.
  const fixture = await nativeBundleReviewFixture("explicit-acceptance-gate");
  const proposalRef = "refs/heads/explicit-ordinary";
  await addCandidateCommit(fixture.clone, "explicit.txt", Buffer.from("explicit acceptance\n"));
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${proposalRef}`]);
  const candidateCommit = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
  const preparation = reviewPreparations(fixture.service.context.extensions).find(({ name }) => name === "git-ci");
  if (preparation?.accepted === undefined) throw new Error("fixture acceptance missing");
  const accepted = preparation.accepted;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  Object.defineProperty(preparation, "accepted", { value: async (input: Parameters<typeof accepted>[0]) => {
    if (input.envelope.review.candidateCommit === candidateCommit) { entered.resolve(); await release.promise; }
    return accepted(input);
  } });
  const base = `${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews`;
  const headers = { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId, "content-type": "application/json" };
  const resolving = fetch(`${base}/resolve`, { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, proposalRef }) });
  try {
    await entered.promise;
    const envelope = (await readAuthoritativeNativeReviewEnvelopes(rootRepository(fixture.root)))
      .find(({ review }) => review.candidateCommit === candidateCommit);
    if (envelope === undefined) throw new Error("explicit canonical review missing");
    // When approval races slow acceptance after canonical review publication.
    const approval = await fetch(`${base}/${envelope.review.reviewId}/approvals`, {
      method: "POST", headers, body: JSON.stringify({ requestId: randomUUID() })
    });
    // Then preparation readiness is not inferred from the envelope's existence.
    expect(approval.status).toBe(409);
    release.resolve();
    expect((await resolving).status).toBe(200);
  } finally {
    release.resolve(); await resolving;
    Object.defineProperty(preparation, "accepted", { value: accepted });
  }
}, 30_000);
