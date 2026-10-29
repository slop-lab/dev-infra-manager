import { chmod, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAuthoritativeNativeReviewEnvelope,
  readVerifiedCiReviewSources,
  saveAuthoritativeNativeReviewEnvelope
} from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import {
  gitCiEnvelope,
  readVerifiedGitCiDeliveryProjection,
  saveGitCiPlan,
  type GitCiPlan
} from "../../../../packages/gs/ci/src/plan-store.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  rootRepository,
  startFinalizeService
} from "../git-repositories/nativeRootImportFinalizeFixture.js";
import { nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verified Git CI delivery projection", () => {
  it("matches the legacy full constructor without retaining historical patch bodies", async () => {
    // Given
    const fixture = await projectionFixture();
    const source = (await readVerifiedCiReviewSources(fixture.repository, fixture.review.review.reviewId))[0];
    if (source === undefined) throw new ProjectionFixtureError("verified review source is missing");
    const legacy = await gitCiEnvelope(fixture.repository, fixture.review);
    if (legacy === undefined) throw new ProjectionFixtureError("legacy CI envelope is missing");

    // When
    const projection = await readVerifiedGitCiDeliveryProjection(fixture.repository, source);

    // Then
    expect(projection).toEqual({
      reviewId: legacy.review.reviewId,
      envelopeId: legacy.envelopeId,
      createdAt: legacy.review.createdAt,
      policyDigest: legacy.policyDigest,
      events: legacy.events
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection?.events)).toBe(true);
    expect(JSON.stringify(projection)).not.toContain("large historical patch");
  });

  it("reuses only a current exact plan version without rereading its body", async () => {
    // Given
    const fixture = await projectionFixture();
    const source = (await readVerifiedCiReviewSources(fixture.repository, fixture.review.review.reviewId))[0];
    if (source === undefined) throw new ProjectionFixtureError("verified review source is missing");
    const handle = await open(fixture.planPath, "r");
    const readFile = vi.spyOn(Object.getPrototypeOf(handle), "readFile");
    await handle.close();

    // When
    const cold = await readVerifiedGitCiDeliveryProjection(fixture.repository, source);
    const readsAfterCold = readFile.mock.calls.length;
    const selectedAgain = (await readVerifiedCiReviewSources(
      fixture.repository,
      fixture.review.review.reviewId
    ))[0];
    if (selectedAgain === undefined) throw new ProjectionFixtureError("reselected review source is missing");
    const warm = await readVerifiedGitCiDeliveryProjection(fixture.repository, selectedAgain);

    // Then
    expect(selectedAgain).toBe(source);
    expect(warm).toBe(cold);
    expect(readsAfterCold).toBe(1);
    expect(readFile).toHaveBeenCalledTimes(readsAfterCold);
  });

  it.each(["tampered", "replaced"] as const)("rejects a %s live plan version", async (effect) => {
    // Given
    const fixture = await projectionFixture();
    const source = (await readVerifiedCiReviewSources(fixture.repository, fixture.review.review.reviewId))[0];
    if (source === undefined) throw new ProjectionFixtureError("verified review source is missing");
    await readVerifiedGitCiDeliveryProjection(fixture.repository, source);
    if (effect === "tampered") {
      await writeFile(fixture.planPath, `${JSON.stringify({ ...fixture.plan, qualityRevision: "f".repeat(64) })}\n`, { mode: 0o600 });
    } else {
      const replacement = `${fixture.planPath}.replacement`;
      await writeFile(replacement, `${JSON.stringify(fixture.plan)}\n`, { mode: 0o600 });
      await rename(replacement, fixture.planPath);
    }

    // When / Then
    await expect(readVerifiedGitCiDeliveryProjection(fixture.repository, source)).rejects.toThrow(/plan|version|changed/i);
  });

  it("retains plan replacement rejection after the compact projection is evicted", async () => {
    // Given
    const fixture = await projectionFixture();
    const source = (await readVerifiedCiReviewSources(fixture.repository, fixture.review.review.reviewId))[0];
    if (source === undefined) throw new ProjectionFixtureError("verified review source is missing");
    await readVerifiedGitCiDeliveryProjection(fixture.repository, source);
    const { reviewId: _reviewId, createdAt: _createdAt, workspaceId: _workspaceId,
      proposalRef: _proposalRef, ...baseIdentity } = fixture.review.review;
    for (let index = 1; index <= 1_024; index += 1) {
      const workspaceId = Buffer.alloc(32);
      workspaceId.writeUInt32BE(index, 28);
      const encodedWorkspaceId = workspaceId.toString("base64url");
      const review = createAuthoritativeNativeReviewEnvelope({
        identity: { ...baseIdentity, workspaceId: encodedWorkspaceId,
          proposalRef: `refs/heads/proposals/${encodedWorkspaceId}/eviction-${index}` },
        policyDigest: fixture.review.policyDigest,
        attachments: fixture.review.attachments,
        createdAt: new Date(index).toISOString()
      });
      const reviewPath = join(fixture.repository, "dim-authoritative-reviews", "proposals",
        `${review.review.reviewId}.${review.envelopeId}.json`);
      await writeFile(reviewPath, `${JSON.stringify(review)}\n`, { mode: 0o600 });
      const evictionSource = (await readVerifiedCiReviewSources(fixture.repository, review.review.reviewId))[0];
      if (evictionSource === undefined) throw new ProjectionFixtureError("eviction review source is missing");
      await readVerifiedGitCiDeliveryProjection(fixture.repository, evictionSource);
    }
    const replacement = `${fixture.planPath}.replacement`;
    await writeFile(replacement, `${JSON.stringify(fixture.plan)}\n`, { mode: 0o600 });
    await rename(replacement, fixture.planPath);

    // When / Then
    await expect(readVerifiedGitCiDeliveryProjection(fixture.repository, source)).rejects.toThrow(/plan|version|changed/i);
  }, 60_000);

  it("rejects a non-private Git CI plan directory", async () => {
    // Given
    const fixture = await projectionFixture();
    const source = (await readVerifiedCiReviewSources(fixture.repository, fixture.review.review.reviewId))[0];
    if (source === undefined) throw new ProjectionFixtureError("verified review source is missing");
    await chmod(join(fixture.repository, "dim-git-ci-plans"), 0o750);

    // When / Then
    await expect(readVerifiedGitCiDeliveryProjection(fixture.repository, source)).rejects.toThrow(/directory|0700|private/i);
  });

  it("audits every attached plan before constructing the startup dispatcher", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("ci-plan-startup-audit");
    await closeFinalizeService(fixture.service);
    const repository = rootRepository(fixture.root);
    const planName = (await readdir(join(repository, "dim-git-ci-plans"))).sort()[0];
    if (planName === undefined) throw new ProjectionFixtureError("Git CI plan is missing");
    await writeFile(join(repository, "dim-git-ci-plans", planName), "{}\n", { mode: 0o600 });

    // When / Then
    await expect(startFinalizeService(fixture.root)).rejects.toThrow(/plan|schema|invalid/i);
  }, 30_000);
});

async function projectionFixture(): Promise<{
  readonly repository: string;
  readonly plan: GitCiPlan;
  readonly planPath: string;
  readonly review: ReturnType<typeof createAuthoritativeNativeReviewEnvelope>;
}> {
  const repository = await mkdtemp(join(tmpdir(), "dim-ci-projection-"));
  roots.push(repository);
  const snapshot = { commit: "2".repeat(40), tree: "3".repeat(40) };
  const requiredJob = { executionKind: "ordinary-sysbox" as const, jobName: "source",
    evidenceClass: "candidate-controlled" as const };
  const requiredJobs = [requiredJob];
  const plan: GitCiPlan = {
    schemaVersion: 1,
    projectId: "project-a",
    repositoryId: "private",
    expectedProtectedHead: "1".repeat(40),
    candidateCommit: snapshot.commit,
    candidateTree: snapshot.tree,
    policyDigest: "5".repeat(64),
    qualityRevision: "9".repeat(64),
    requiredJobs,
    planning: { status: "valid", configBlob: null, jobs: [{ ...requiredJob,
      script: { path: ".dim/ci/jobs/source.bash", objectId: "7".repeat(40), sha256: `sha256:${"8".repeat(64)}` },
      argv: ["/bin/bash", ".dim/ci/jobs/source.bash"], inputs: { private: snapshot } }] }
  };
  const attachment = await saveGitCiPlan(repository, plan);
  const workspaceId = Buffer.alloc(32, 1).toString("base64url");
  const review = createAuthoritativeNativeReviewEnvelope({
    identity: { schemaVersion: 2, serviceId: "native-main", projectId: plan.projectId,
      repositoryId: plan.repositoryId, inputs: { private: snapshot }, protectedRef: "refs/heads/main",
      proposalRef: `refs/heads/proposals/${workspaceId}/change`, expectedProtectedHead: plan.expectedProtectedHead,
      candidateCommit: plan.candidateCommit, candidateTree: plan.candidateTree, policyRevision: "4".repeat(64),
      requiredReviewRevision: "4".repeat(64), workspaceId, requiredReviewerIds: [], changes: [],
      patch: "large historical patch", patchBytes: Buffer.from("large historical patch").toString("base64") },
    policyDigest: plan.policyDigest,
    attachments: [attachment],
    createdAt: "2026-10-28T00:00:00.000Z"
  });
  await saveAuthoritativeNativeReviewEnvelope(repository, review);
  return { repository, plan, planPath: join(repository, "dim-git-ci-plans", `${attachment.id}.json`), review };
}

class ProjectionFixtureError extends Error {
  readonly name = "ProjectionFixtureError";
}
