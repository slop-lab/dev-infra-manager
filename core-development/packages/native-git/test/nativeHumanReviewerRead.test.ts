import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNativeGitBundleConfig } from "../../../../core/packages/native-git/src/bundle-config.js";
import { configuredNativeGitBundleServer } from "../../../../core/packages/native-git/src/native-bundle-server.js";
import { bundleSecrets, idleNativeConfig } from "./bundleConfigFixture.js";
import { authoritativePolicy } from "./authoritativeNativeCandidateFixture.js";
import {
  addCandidateCommit,
  createBundleReview,
  nativeBundleReviewFixture,
  reviewProposalRef
} from "./nativeBundleReviewFixture.js";
import {
  activateFinalizeService,
  activationToken,
  activationTokenB,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  foreignHumanReviewer,
  generationId,
  generationB,
  humanReviewer,
  humanReviewerAuthorization,
  importer,
  createFinalizeRoot,
  createRootBundle,
  projectInput,
  rootRepository,
  runGit,
  startFinalizeService,
  startFinalizeServiceForGeneration,
  uploadRootBundle,
  workspaceWriteIssuerAuthorization
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("installed imported-root human reviewer", () => {
  it("accepts only strict schema-7 globally distinct canonical reviewer credentials", () => {
    // Given
    const valid = { ...idleNativeConfig(), humanReviewers: [humanReviewer] };

    // When / Then
    expect(parseNativeGitBundleConfig(valid).humanReviewers).toEqual([humanReviewer]);
    expect(() => parseNativeGitBundleConfig({ ...valid, schemaVersion: 6 })).toThrow();
    expect(() => parseNativeGitBundleConfig({
      ...valid,
      humanReviewers: [{ ...humanReviewer, password: "not-a-canonical-token" }]
    })).toThrow();
    expect(() => parseNativeGitBundleConfig({
      ...valid,
      humanReviewers: [humanReviewer, { ...foreignHumanReviewer, reviewerId: humanReviewer.reviewerId }]
    })).toThrow(/distinct/);
    expect(() => parseNativeGitBundleConfig({
      ...valid,
      humanReviewers: [{ ...humanReviewer, password: valid.ordinaryCi.query.password }]
    })).toThrow(/distinct/);
  });

  it("rejects an imported policy reviewer without configured human credentials before state mutation", async () => {
    // Given
    const root = await createFinalizeRoot("human-reviewer-import-validation");
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    const bundle = await createRootBundle();
    const before = await readFile(join(root, "native-idle.sqlite3"));

    // When
    const response = await uploadRootBundle(service.origin, bundle, authoritativePolicy(["missing-reviewer"]));

    // Then
    expect(response.status).toBe(400);
    expect(await readFile(join(root, "native-idle.sqlite3"))).toEqual(before);
  });

  it("rejects a persisted imported policy whose reviewer credential is absent at startup", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-reviewer-startup-validation");
    await closeFinalizeService(fixture.service);
    const database = join(fixture.root, "native-idle.sqlite3");
    const before = await readFile(database);
    const config = parseNativeGitBundleConfig({
      ...idleNativeConfig(),
      humanReviewers: [foreignHumanReviewer]
    });

    // When
    const startup = configuredNativeGitBundleServer({
      config,
      stateDirectory: fixture.root,
      readinessToken: Buffer.alloc(32, 41).toString("base64url"),
      activationToken,
      expectedGenerationId: generationId
    });

    // Then
    await expect(startup).rejects.toThrow(/unavailable human reviewer/);
    expect(await readFile(database)).toEqual(before);
    expect(before.includes(Buffer.from(bundleSecrets.foreignHumanReviewer))).toBe(false);
  });

  it("serves only the required reviewer the exact immutable review and preserves stale inspection across restart", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-reviewer-read");
    const created = await createBundleReview(fixture.service);
    const path = `/v1/projects/project-a/repositories/root/reviews/${created.review.reviewId}`;
    const headers = { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId };

    // When
    const identity = await fetch(`${fixture.service.origin}/v1/human-reviewer-identity`, {
      headers: { authorization: humanReviewerAuthorization }
    });
    const current = await fetch(`${fixture.service.origin}${path}`, { headers });
    await addCandidateCommit(fixture.clone, "review-drift.txt", Buffer.from("drift\n"));
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root);
    await activateFinalizeService(restarted.origin);
    const stale = await fetch(`${restarted.origin}${path}`, { headers });

    // Then
    expect(identity.status).toBe(200);
    expect(await identity.json()).toEqual({
      schemaVersion: 1,
      serviceId: "native-main",
      role: "human-reviewer",
      reviewerId: "owner",
      generationId
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      schemaVersion: 1,
      status: "pending",
      staleReasons: [],
      review: { reviewId: created.review.reviewId, requiredReviewerIds: ["owner"] },
      events: created.events
    });
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({
      status: "stale",
      staleReasons: expect.arrayContaining(["candidate-commit-changed", "candidate-tree-changed"]),
      review: created.review,
      events: created.events
    });
  });

  it("fails closed for unauthenticated, wrong-role, foreign, unrequired, malformed, generation, and inactive requests", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-reviewer-denials");
    const created = await createBundleReview(fixture.service);
    const path = `/v1/projects/project-a/repositories/root/reviews/${created.review.reviewId}`;
    const auth = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const reviewerHeaders = { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId };

    // When
    const responses = await Promise.all([
      fetch(`${fixture.service.origin}${path}`),
      fetch(`${fixture.service.origin}${path}`, { headers: {
        authorization: workspaceWriteIssuerAuthorization, "x-dim-generation-id": generationId
      } }),
      fetch(`${fixture.service.origin}${path}`, { headers: {
        authorization: auth(foreignHumanReviewer.username, foreignHumanReviewer.password),
        "x-dim-generation-id": generationId
      } }),
      fetch(`${fixture.service.origin}${path.replace("project-a", "project-b")}`, { headers: reviewerHeaders }),
      fetch(`${fixture.service.origin}${path}/approvals`, { headers: reviewerHeaders }),
      fetch(`${fixture.service.origin}${path}?list=true`, { headers: reviewerHeaders }),
      fetch(`${fixture.service.origin}${path}`, { headers: {
        authorization: humanReviewerAuthorization, "x-dim-generation-id": "b".repeat(64)
      } })
    ]);
    await closeFinalizeService(fixture.service);
    const inactive = await startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB);
    const unavailable = await fetch(`${inactive.origin}${path}`, { headers: {
      authorization: humanReviewerAuthorization, "x-dim-generation-id": generationB
    } });

    // Then
    expect(responses.map((response) => response.status)).toEqual([401, 403, 403, 404, 404, 404, 409]);
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await currentStoredEnvelope(fixture.root, created.review.reviewId)))
      .not.toContain(humanReviewer.password);
  });
});

async function currentStoredEnvelope(root: string, reviewId: string): Promise<unknown> {
  return JSON.parse(await readFile(join(
    rootRepository(root), "dim-authoritative-reviews", "proposals", `${reviewId}.json`
  ), "utf8"));
}
