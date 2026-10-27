import { afterEach, expect, it } from "vitest";
import { reviewPreparations, reviewChangeMatchers, createAuthoritativeNativeReview, readAuthoritativeNativeReviewEnvelopes } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { stageProposalAcceptance } from "../../../../packages/control-plane/plugins/git-review/src/proposal-acceptance.js";
import { readPendingAuthoritativeNativeDeliveries } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import { addCandidateCommit, nativeBundleReviewFixture, publishedReviewEnvelopes, reviewProposalRef } from "./nativeBundleReviewFixture.js";
import { activateFinalizeServiceForGeneration, activationTokenB, cleanupFinalizeFixtures, closeFinalizeService,
  generationB, generationId, rootRepository, runGit, activationToken, startFinalizeServiceForGeneration } from "../git-repositories/nativeRootImportFinalizeFixture.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
afterEach(cleanupFinalizeFixtures);

it.each([false, true])("recovers an interrupted proposal only in its accepted generation (rollover=%s)", async (rollover) => {
  const fixture = await nativeBundleReviewFixture("proposal-intent-interruption");
  const preparation = reviewPreparations(fixture.service.context.extensions).find(({ name }) => name === "git-ci");
  if (!preparation?.accepted) throw new Error("fixture CI preparation missing");
  const accepted = preparation.accepted;
  Object.defineProperty(preparation, "accepted", { value: async () => { throw new Error("injected interruption before intent publication"); } });
  await addCandidateCommit(fixture.clone, "second.txt", Buffer.from("new accepted proposal\n"));
  const commit = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
  try {
    await expect(runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`])).rejects.toThrow();
    const envelope = (await publishedReviewEnvelopes(fixture.root)).find(({ review }) => review.candidateCommit === commit);
    if (!envelope) throw new Error("interrupted review was not persisted");
    expect((await readPendingAuthoritativeNativeDeliveries(rootRepository(fixture.root), 20, binding, generationId))
      .filter(({ event }) => event.reviewId === envelope.review.reviewId)).toEqual([]);
    await closeFinalizeService(fixture.service);
    const servingGeneration = rollover ? generationB : generationId, token = rollover ? activationTokenB : activationToken;
    const restarted = await startFinalizeServiceForGeneration(fixture.root, servingGeneration, token);
    await activateFinalizeServiceForGeneration(restarted.origin, servingGeneration, token);
    expect((await readPendingAuthoritativeNativeDeliveries(rootRepository(fixture.root), 20, binding, servingGeneration))
      .filter(({ event }) => event.reviewId === envelope.review.reviewId)).toHaveLength(rollover ? 0 : 2);
  } finally { Object.defineProperty(preparation, "accepted", { value: accepted }); }
}, 30_000);

it("recovers a staged current-generation action whose canonical review was not yet published", async () => {
  const fixture = await nativeBundleReviewFixture("proposal-before-publication"), repository = rootRepository(fixture.root);
  const proposalRef = "refs/heads/before-publication";
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${proposalRef}`]);
  await fixture.service.context.serialize(async () => {
    const runtime = { ...fixture.service.context.runtime, authoritativeTargetProofs: new Map(),
      reviewPreparations: reviewPreparations(fixture.service.context.extensions), reviewChangeMatchers: reviewChangeMatchers(fixture.service.context.extensions) };
    await expect(createAuthoritativeNativeReview(runtime, { projectId: "project-a", repositoryId: "root", proposalRef }, {
      async beforePublication({ repository: target, envelope }) {
        await stageProposalAcceptance(target, generationId, envelope);
        throw new Error("injected interruption before canonical review publication");
      }
    })).rejects.toThrow();
  });
  await closeFinalizeService(fixture.service);
  expect((await readAuthoritativeNativeReviewEnvelopes(repository)).some(({ review }) => review.proposalRef === proposalRef)).toBe(false);
  const restarted = await startFinalizeServiceForGeneration(fixture.root, generationId, activationToken);
  await activateFinalizeServiceForGeneration(restarted.origin, generationId, activationToken);
  const envelope = (await readAuthoritativeNativeReviewEnvelopes(repository)).find(({ review }) => review.proposalRef === proposalRef);
  if (!envelope) throw new Error("staged review was not recovered");
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 20, binding, generationId))
    .filter(({ event }) => event.reviewId === envelope.review.reviewId)).toHaveLength(2);
}, 30_000);
