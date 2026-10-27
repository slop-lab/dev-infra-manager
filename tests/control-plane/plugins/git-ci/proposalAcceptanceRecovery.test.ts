import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { reviewPreparations, reviewChangeMatchers, createAuthoritativeNativeReview, readAuthoritativeNativeReviewEnvelopes } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { proposalAcceptanceState, stageProposalAcceptance } from "../../../../packages/control-plane/plugins/git-review/src/proposal-acceptance.js";
import { readRawProposalJobs } from "../../../../packages/control-plane/plugins/git-review/src/raw-proposal-journal.js";
import { readPendingAuthoritativeNativeDeliveries } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import { addCandidateCommit, nativeBundleReviewFixture, reviewProposalRef } from "./nativeBundleReviewFixture.js";
import { activateFinalizeServiceForGeneration, activationTokenB, cleanupFinalizeFixtures, closeFinalizeService,
  generationB, generationId, hostPromoterAuthorization, humanReviewerAuthorization, rootRepository, runGit, activationToken,
  startFinalizeServiceForGeneration } from "../git-repositories/nativeRootImportFinalizeFixture.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
afterEach(cleanupFinalizeFixtures);

it("returns the Git response after durable raw handoff without awaiting slow review preparation", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("proposal-async-handoff");
  const preparation = reviewPreparations(fixture.service.context.extensions).find(({ name }) => name === "git-ci");
  if (!preparation) throw new Error("fixture CI preparation missing");
  const prepare = preparation.prepare;
  let signalStarted: (() => void) | undefined;
  let releasePreparation: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const release = new Promise<void>((resolve) => { releasePreparation = resolve; });
  await addCandidateCommit(fixture.clone, "slow.txt", Buffer.from("slow downstream preparation\n"));
  const commit = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
  Object.defineProperty(preparation, "prepare", { value: async (input: Parameters<typeof prepare>[0]) => {
    if (input.evidence.candidateCommit === commit) { signalStarted?.(); await release; }
    return prepare(input);
  } });

  try {
    // When
    const before = performance.now();
    const push = runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    const response = await Promise.race([
      push.then(() => "returned" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5_000))
    ]);
    const elapsedMilliseconds = performance.now() - before;

    // Then
    expect(response).toBe("returned");
    expect(elapsedMilliseconds).toBeLessThan(5_000);
    await started;
    const headers = { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId };
    const status = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/review-preparations`, { headers });
    expect(status.status).toBe(200);
    const body: unknown = await status.json();
    if (typeof body !== "object" || body === null || !("jobs" in body) || !Array.isArray(body.jobs)) throw new Error("raw job status missing");
    expect(body.jobs).toContainEqual(expect.objectContaining({ candidateCommit: commit, status: "pending" }));
    expect((await readAuthoritativeNativeReviewEnvelopes(rootRepository(fixture.root)))
      .some(({ review }) => review.candidateCommit === commit)).toBe(false);

    let closed = false;
    const close = closeFinalizeService(fixture.service).then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    releasePreparation?.();
    await close;
    const envelope = (await readAuthoritativeNativeReviewEnvelopes(rootRepository(fixture.root)))
      .find(({ review }) => review.candidateCommit === commit);
    expect(envelope).toBeDefined();
  } finally {
    releasePreparation?.();
    Object.defineProperty(preparation, "prepare", { value: prepare });
  }
}, 30_000);

it.each([false, true])("recovers an interrupted proposal only in its accepted generation (rollover=%s)", async (rollover) => {
  const fixture = await nativeBundleReviewFixture("proposal-intent-interruption");
  const preparation = reviewPreparations(fixture.service.context.extensions).find(({ name }) => name === "git-ci");
  if (!preparation?.accepted) throw new Error("fixture CI preparation missing");
  const accepted = preparation.accepted;
  Object.defineProperty(preparation, "accepted", { value: async () => { throw new Error("injected interruption before intent publication"); } });
  await addCandidateCommit(fixture.clone, "second.txt", Buffer.from("new accepted proposal\n"));
  const commit = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
  try {
    await expect(runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`])).resolves.toBeDefined();
    await expect.poll(async () => {
      const response = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/review-preparations`, {
        headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId }
      });
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null || !("jobs" in value) || !Array.isArray(value.jobs)) return undefined;
      const job = value.jobs.find((candidate) => typeof candidate === "object" && candidate !== null
        && Reflect.get(candidate, "candidateCommit") === commit);
      return job === undefined ? undefined : Reflect.get(job, "status");
    }, { timeout: 10_000 }).toBe("failed");
    const envelope = (await readAuthoritativeNativeReviewEnvelopes(rootRepository(fixture.root)))
      .find(({ review }) => review.candidateCommit === commit);
    if (!envelope) throw new Error("interrupted review was not persisted");
    await expect.poll(() => proposalAcceptanceState(rootRepository(fixture.root), generationId, envelope)).toBe("failed");
    expect((await readPendingAuthoritativeNativeDeliveries(rootRepository(fixture.root), 20, binding, generationId))
      .filter(({ event }) => event.reviewId === envelope.review.reviewId)).toEqual([]);
    await closeFinalizeService(fixture.service);
    const servingGeneration = rollover ? generationB : generationId, token = rollover ? activationTokenB : activationToken;
    const restarted = await startFinalizeServiceForGeneration(fixture.root, servingGeneration, token);
    await activateFinalizeServiceForGeneration(restarted.origin, servingGeneration, token);
    if (!rollover) await expect.poll(async () => (await readRawProposalJobs(rootRepository(fixture.root), generationId))
      .find(({ binding: raw }) => raw.candidateCommit === commit)?.state.status, { timeout: 10_000 }).toBe("ready");
    expect((await readPendingAuthoritativeNativeDeliveries(rootRepository(fixture.root), 20, binding, servingGeneration))
      .filter(({ event }) => event.reviewId === envelope.review.reviewId)).toHaveLength(rollover ? 0 : 2);
  } finally { Object.defineProperty(preparation, "accepted", { value: accepted }); }
}, 30_000);

it("keeps a failed accepted review blocked across generation rollover until explicit current-generation acceptance succeeds", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("proposal-acceptance-rollover-blocker");
  const preparation = reviewPreparations(fixture.service.context.extensions).find(({ name }) => name === "git-ci");
  if (!preparation?.accepted) throw new Error("fixture CI preparation missing");
  const accepted = preparation.accepted;
  Object.defineProperty(preparation, "accepted", { value: async () => { throw new Error("injected accepted hook failure"); } });
  await addCandidateCommit(fixture.clone, "blocked.txt", Buffer.from("blocked accepted proposal\n"));
  const commit = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
  try {
    await expect(runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`])).resolves.toBeDefined();
    await expect.poll(async () => (await readRawProposalJobs(rootRepository(fixture.root), generationId))
      .find(({ binding: raw }) => raw.candidateCommit === commit)?.state.status, { timeout: 10_000 }).toBe("failed");
    const envelope = (await readAuthoritativeNativeReviewEnvelopes(rootRepository(fixture.root)))
      .find(({ review }) => review.candidateCommit === commit);
    if (!envelope) throw new Error("failed accepted review was not persisted");
    await closeFinalizeService(fixture.service);
    Object.defineProperty(preparation, "accepted", { value: accepted });
    const current = await startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB);
    await activateFinalizeServiceForGeneration(current.origin, generationB, activationTokenB);
    const reviewPath = `/v1/projects/project-a/repositories/root/reviews/${envelope.review.reviewId}`;
    const reviewerHeaders = { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationB };
    const currentPreparation = reviewPreparations(current.context.extensions).find(({ name }) => name === "git-ci");
    if (!currentPreparation?.accepted) throw new Error("current fixture CI preparation missing");
    const currentAccepted = currentPreparation.accepted;
    let acceptedStarted: (() => void) | undefined;
    let releaseAccepted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { acceptedStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseAccepted = resolve; });
    Object.defineProperty(currentPreparation, "accepted", { value: async (input: Parameters<typeof currentAccepted>[0]) => {
      acceptedStarted?.();
      await release;
      return currentAccepted(input);
    } });

    // When
    const blockedReview = await fetch(`${current.origin}${reviewPath}`, { headers: reviewerHeaders });
    const blockedApproval = await fetch(`${current.origin}${reviewPath}/approvals`, {
      method: "POST", headers: { ...reviewerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID() })
    });
    const blockedPromotion = await fetch(`${current.origin}${reviewPath}/promotions`, {
      method: "POST", headers: { authorization: hostPromoterAuthorization, "x-dim-generation-id": generationB,
        "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1 })
    });
    const staleResolution = fetch(`${current.origin}/v1/projects/project-a/repositories/root/reviews/resolve`, {
      method: "POST", headers: { ...reviewerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, proposalRef: reviewProposalRef })
    });
    await started;
    await current.context.mutate({ projectId: "project-a", repositoryId: "root" }, async () => {
      await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "update-ref", reviewProposalRef,
        envelope.review.expectedProtectedHead]);
    });
    releaseAccepted?.();
    const staleResolved = await staleResolution;
    expect(staleResolved.status).toBe(409);
    expect(await proposalAcceptanceState(rootRepository(fixture.root), generationB, envelope)).toBe("failed");
    Object.defineProperty(currentPreparation, "accepted", { value: currentAccepted });
    await current.context.mutate({ projectId: "project-a", repositoryId: "root" }, async () => {
      await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "update-ref", reviewProposalRef, commit]);
    });
    const resolved = await fetch(`${current.origin}/v1/projects/project-a/repositories/root/reviews/resolve`, {
      method: "POST", headers: { ...reviewerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, proposalRef: reviewProposalRef })
    });
    const approval = await fetch(`${current.origin}${reviewPath}/approvals`, {
      method: "POST", headers: { ...reviewerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID() })
    });
    const promotion = await fetch(`${current.origin}${reviewPath}/promotions`, {
      method: "POST", headers: { authorization: hostPromoterAuthorization, "x-dim-generation-id": generationB,
        "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1 })
    });

    // Then
    expect(blockedReview.status).toBe(200);
    expect(await blockedReview.json()).toMatchObject({ status: "stale", staleReasons: ["proposal-preparation-failed"] });
    expect(blockedApproval.status).toBe(409);
    expect(blockedPromotion.status).toBe(409);
    expect(await blockedPromotion.text()).toMatch(/human approval evidence is incomplete/);
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    expect(approval.status, await approval.clone().text()).toBe(201);
    expect(promotion.status).toBe(409);
    expect(await promotion.text()).toMatch(/execution evidence is missing/);
    expect(await proposalAcceptanceState(rootRepository(fixture.root), generationB, envelope)).toBe("none");
    await closeFinalizeService(current);
    const restarted = await startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB);
    await activateFinalizeServiceForGeneration(restarted.origin, generationB, activationTokenB);
    expect(await proposalAcceptanceState(rootRepository(fixture.root), generationB, envelope)).toBe("none");
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
  await expect.poll(async () => (await readAuthoritativeNativeReviewEnvelopes(repository))
    .some(({ review }) => review.proposalRef === proposalRef)).toBe(true);
  const envelope = (await readAuthoritativeNativeReviewEnvelopes(repository)).find(({ review }) => review.proposalRef === proposalRef);
  if (!envelope) throw new Error("staged review was not recovered");
  await expect.poll(() => proposalAcceptanceState(repository, generationId, envelope)).toBe("none");
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 20, binding, generationId))
    .filter(({ event }) => event.reviewId === envelope.review.reviewId)).toHaveLength(2);
}, 30_000);
