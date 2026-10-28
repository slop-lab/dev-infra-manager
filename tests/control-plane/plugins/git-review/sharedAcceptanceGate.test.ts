import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  codeReviewService, createAuthoritativeNativeReview, readAuthoritativeNativeReviewEnvelopes,
  reviewChangeMatchers, reviewPreparationExtension, reviewPreparations,
  type ReviewPreparation
} from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { proposalAcceptanceState, stageProposalAcceptance } from "../../../../packages/control-plane/plugins/git-review/src/proposal-acceptance.js";
import { basic, fixture, generationId, git, reviewer } from "../git-repositories/optionalFeaturesFixture.js";

const selector = { projectId: "project", repositoryId: "main", proposalRef: "refs/heads/shared-review" };
async function candidate(preparation: ReviewPreparation) {
  const f = await fixture(true, [reviewPreparationExtension(preparation)]);
  try {
    await writeFile(join(f.source, "README.md"), "shared review candidate\n");
    await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${selector.proposalRef}`]);
    return { ...f, repository: join(f.root, "state/project/main.git") };
  } catch (error) { await f.service.close(); await rm(f.root, { recursive: true, force: true }); throw error; }
}
function approve(f: Awaited<ReturnType<typeof candidate>>, reviewId: string) {
  return fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/${reviewId}/approvals`, {
    method: "POST", headers: { authorization: basic(reviewer), "x-dim-generation-id": generationId, "content-type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID() })
  });
}

it("completes the matching raw publication acceptance when the shared review service accepts its canonical envelope", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await candidate({ name: "shared-acceptance", async prepare() { return { inputs: {} }; },
    async accepted() { entered.resolve(); await release.promise; } });
  let creating: ReturnType<ReturnType<typeof codeReviewService>["create"]> | undefined;
  try {
    const runtime = { ...f.service.context.runtime, authoritativeTargetProofs: new Map(),
      reviewPreparations: reviewPreparations(f.extensions), reviewChangeMatchers: reviewChangeMatchers(f.extensions) };
    // A raw worker published this exact canonical envelope and has not completed acceptance.
    const published = await createAuthoritativeNativeReview(runtime, selector);
    await stageProposalAcceptance(f.repository, generationId, published);
    expect((await approve(f, published.review.reviewId)).status).toBe(409);
    creating = codeReviewService(f.extensions).create(f.service.context, selector);
    await entered.promise;
    expect(await proposalAcceptanceState(f.repository, generationId, published)).toBe("pending");
    release.resolve();
    const accepted = await creating;
    expect(accepted.envelopeId).toBe(published.envelopeId);
    expect(await proposalAcceptanceState(f.repository, generationId, accepted)).toBe("none");
    const approval = await approve(f, accepted.review.reviewId);
    expect(approval.status, await approval.clone().text()).toBe(201);
  } finally { release.resolve(); await creating?.catch(() => undefined); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});

it.each([false, true])("keeps a shared review unapprovable when downstream acceptance fails (reused=%s)", async (reused) => {
  const f = await candidate({ name: "shared-acceptance", async prepare() { return { inputs: {} }; },
    async accepted() { throw new Error("injected downstream acceptance failure"); } });
  try {
    if (reused) {
      const runtime = { ...f.service.context.runtime, authoritativeTargetProofs: new Map(),
        reviewPreparations: reviewPreparations(f.extensions), reviewChangeMatchers: reviewChangeMatchers(f.extensions) };
      const canonical = await createAuthoritativeNativeReview(runtime, selector);
      expect(await proposalAcceptanceState(f.repository, generationId, canonical)).toBe("none");
    }
    await expect(codeReviewService(f.extensions).create(f.service.context, selector)).rejects.toThrow("injected downstream acceptance failure");
    const envelope = (await readAuthoritativeNativeReviewEnvelopes(f.repository))[0];
    if (envelope === undefined) throw new Error("canonical review missing");
    expect(await proposalAcceptanceState(f.repository, generationId, envelope)).toBe("failed");
    const approval = await approve(f, envelope.review.reviewId);
    expect(approval.status, await approval.clone().text()).toBe(409);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
