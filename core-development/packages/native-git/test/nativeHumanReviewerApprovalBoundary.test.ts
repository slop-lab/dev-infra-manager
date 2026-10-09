import { randomUUID } from "node:crypto";
import { link, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundleReview, nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import { authoritativePolicy } from "./authoritativeNativeCandidateFixture.js";
import { createAuthoritativeNativeReviewEnvelope } from "../../../../core/packages/native-git/src/authoritative-native-review-schema.js";
import { cleanupFinalizeFixtures, closeFinalizeService, createFinalizeRoot, generationId,
  humanReviewerAuthorization, rootRepository, startFinalizeService } from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native human approval boundaries", () => {
  it("conceals non-exact GET routes before reviewer authentication", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("approval-get-routing");
    const { review } = await createBundleReview(fixture.service);
    const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}`;

    // When
    const responses = await Promise.all([
      fetch(`${endpoint}/approvals`),
      fetch(`${endpoint}?extra=1`),
      fetch(`${fixture.service.origin}/not-a-review`)
    ]);

    // Then
    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
  });

  it("rejects a hard-linked approval at startup without adopting it", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("approval-hardlink");
    const { review } = await createBundleReview(fixture.service);
    const response = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}/approvals`, {
      method: "POST",
      headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId,
        "content-type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID() })
    });
    expect(response.status).toBe(201);
    await closeFinalizeService(fixture.service);
    const records = join(rootRepository(fixture.root), "dim-authoritative-approvals", "records");
    const names = await readdir(records);
    const name = names[0];
    if (name === undefined) throw new Error("approval fixture has no record");
    const aliasRoot = await createFinalizeRoot("approval-hardlink-alias");
    await link(join(records, name), join(aliasRoot, "approval-alias.json"));

    // When / Then
    await expect(startFinalizeService(fixture.root)).rejects.toThrow(/single.link|link count/i);
    expect(await readdir(records)).toEqual(names);
  });

  it("does not approve a rehashed review omitting a path-required human reviewer", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("approval-path-binding", undefined,
      authoritativePolicy(["owner"], [{ pathPrefix: "candidate.bin", reviewerIds: ["foreign"] }]));
    const original = await createBundleReview(fixture.service);
    const { reviewId: _reviewId, createdAt, ...identity } = original.review;
    const altered = createAuthoritativeNativeReviewEnvelope({ ...identity,
      requiredReviewerIds: ["owner"] }, createdAt);
    await writeFile(join(rootRepository(fixture.root), "dim-authoritative-reviews", "proposals",
      `${altered.review.reviewId}.json`), `${JSON.stringify(altered)}\n`, { mode: 0o600 });

    // When
    const response = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${altered.review.reviewId}/approvals`, {
      method: "POST",
      headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId,
        "content-type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID() })
    });

    // Then
    expect(response.status).toBe(409);
    await expect(readdir(join(rootRepository(fixture.root), "dim-authoritative-approvals")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
