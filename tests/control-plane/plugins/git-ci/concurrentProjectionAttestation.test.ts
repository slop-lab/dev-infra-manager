import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAuthoritativeNativeReviewEnvelope,
  readVerifiedCiReviewSources,
  saveAuthoritativeNativeReviewEnvelope,
  type VerifiedCiReviewSource
} from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import * as planFiles from "../../../../packages/gs/ci/src/plan-file-version.js";
import {
  readVerifiedGitCiDeliveryProjection,
  saveGitCiPlan,
  type GitCiPlan
} from "../../../../packages/gs/ci/src/plan-store.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("rejects a known plan path replacement through repository path aliases", async () => {
  // Given
  const fixture = await projectionFixture();
  const firstSource = await reviewSource(fixture, 0);
  const secondSource = await reviewSource(fixture, 1);
  await readVerifiedGitCiDeliveryProjection(relative(process.cwd(), fixture.repository), firstSource);
  await replacePlan(fixture);

  // When / Then
  await expect(readVerifiedGitCiDeliveryProjection(fixture.repository, secondSource))
    .rejects.toThrow(/plan|version|changed/i);
});

it("coalesces concurrent cold reads of the same plan", async () => {
  // Given
  const fixture = await projectionFixture();
  const source = await reviewSource(fixture, 0);
  const originalRead = planFiles.readGitCiPlanFile;
  const originalDirectoryCheck = planFiles.assertPrivateGitCiPlanDirectory;
  const readStarted = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const secondCallerJoined = Promise.withResolvers<void>();
  let reads = 0;
  let directoryChecks = 0;
  vi.spyOn(planFiles, "assertPrivateGitCiPlanDirectory").mockImplementation(async (path) => {
    await originalDirectoryCheck(path);
    directoryChecks += 1;
    if (directoryChecks === 2) setImmediate(() => secondCallerJoined.resolve());
  });
  vi.spyOn(planFiles, "readGitCiPlanFile").mockImplementation(async (input) => {
    if (input.readBody) {
      reads += 1;
      readStarted.resolve();
      await releaseRead.promise;
    }
    return originalRead(input);
  });

  // When
  const first = readVerifiedGitCiDeliveryProjection(fixture.repository, source);
  await readStarted.promise;
  const second = readVerifiedGitCiDeliveryProjection(fixture.repository, source);
  await secondCallerJoined.promise;

  // Then
  expect(reads).toBe(1);
  releaseRead.resolve();
  const [firstProjection, secondProjection] = await Promise.all([first, second]);
  expect(secondProjection).toBe(firstProjection);
  expect(reads).toBe(1);
});

it("rejects a plan replacement while cold readers share an earlier file snapshot", async () => {
  const fixture = await projectionFixture();
  const firstSource = await reviewSource(fixture, 0), secondSource = await reviewSource(fixture, 1);
  const originalRead = planFiles.readGitCiPlanFile;
  const originalDirectoryCheck = planFiles.assertPrivateGitCiPlanDirectory;
  const snapshotRead = Promise.withResolvers<void>(), releaseRead = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<void>();
  let directoryChecks = 0;
  vi.spyOn(planFiles, "assertPrivateGitCiPlanDirectory").mockImplementation(async (path) => {
    await originalDirectoryCheck(path);
    directoryChecks += 1;
    if (directoryChecks === 2) setImmediate(() => joined.resolve());
  });
  vi.spyOn(planFiles, "readGitCiPlanFile").mockImplementation(async (input) => {
    const record = await originalRead(input);
    if (input.readBody) { snapshotRead.resolve(); await releaseRead.promise; }
    return record;
  });
  const first = readVerifiedGitCiDeliveryProjection(fixture.repository, firstSource);
  const firstOutcome = first.then(() => "accepted", () => "rejected");
  await snapshotRead.promise;
  await replacePlan(fixture);
  const second = readVerifiedGitCiDeliveryProjection(fixture.repository, secondSource);
  const secondOutcome = second.then(() => "accepted", () => "rejected");
  await joined.promise;
  releaseRead.resolve();
  expect(await Promise.all([firstOutcome, secondOutcome])).toEqual(["rejected", "rejected"]);
});

it("does not let a paused warm hit resurrect an evicted projection", async () => {
  // Given
  const fixture = await projectionFixture();
  const source = await reviewSource(fixture, 0);
  await readVerifiedGitCiDeliveryProjection(fixture.repository, source);
  const originalRead = planFiles.readGitCiPlanFile;
  const warmPaused = Promise.withResolvers<void>();
  const releaseWarm = Promise.withResolvers<void>();
  let targetWarmPaused = false;
  let bodyReads = 0;
  vi.spyOn(planFiles, "readGitCiPlanFile").mockImplementation(async (input) => {
    const record = await originalRead(input);
    if (input.readBody) bodyReads += 1;
    if (input.path === fixture.planPath && !input.readBody && !targetWarmPaused) {
      targetWarmPaused = true;
      warmPaused.resolve();
      await releaseWarm.promise;
    }
    return record;
  });
  const warm = readVerifiedGitCiDeliveryProjection(fixture.repository, source);
  await warmPaused.promise;
  for (let index = 1; index <= 1_024; index += 1) {
    await readVerifiedGitCiDeliveryProjection(fixture.repository, await reviewSource(fixture, index));
  }
  const readsBeforeRetry = bodyReads;

  // When
  releaseWarm.resolve();
  await warm;
  await readVerifiedGitCiDeliveryProjection(fixture.repository, source);

  // Then
  expect(bodyReads).toBe(readsBeforeRetry + 1);
}, 60_000);

type ProjectionFixture = {
  readonly repository: string;
  readonly plan: GitCiPlan;
  readonly planPath: string;
  readonly attachment: Awaited<ReturnType<typeof saveGitCiPlan>>;
};

async function projectionFixture(): Promise<ProjectionFixture> {
  const repository = await mkdtemp(join(tmpdir(), "dim-ci-projection-race-"));
  roots.push(repository);
  const snapshot = { commit: "2".repeat(40), tree: "3".repeat(40) };
  const plan: GitCiPlan = {
    schemaVersion: 1,
    projectId: "project-a",
    repositoryId: "root",
    expectedProtectedHead: "1".repeat(40),
    candidateCommit: snapshot.commit,
    candidateTree: snapshot.tree,
    policyDigest: "6".repeat(64),
    qualityRevision: "7".repeat(64),
    requiredJobs: [],
    planning: { status: "valid", configBlob: null, jobs: [] }
  };
  const attachment = await saveGitCiPlan(repository, plan);
  return {
    repository,
    plan,
    attachment,
    planPath: join(repository, "dim-git-ci-plans", `${attachment.id}.json`)
  };
}

async function reviewSource(fixture: ProjectionFixture, index: number): Promise<VerifiedCiReviewSource> {
  const workspaceId = Buffer.alloc(32);
  workspaceId.writeUInt32BE(index, 28);
  const encodedWorkspaceId = workspaceId.toString("base64url");
  const envelope = createAuthoritativeNativeReviewEnvelope({
    identity: {
      schemaVersion: 2,
      serviceId: "native-main",
      projectId: fixture.plan.projectId,
      repositoryId: fixture.plan.repositoryId,
      inputs: { root: { commit: fixture.plan.candidateCommit, tree: fixture.plan.candidateTree } },
      protectedRef: "refs/heads/main",
      proposalRef: `refs/heads/proposals/${encodedWorkspaceId}/race-${index}`,
      expectedProtectedHead: fixture.plan.expectedProtectedHead,
      candidateCommit: fixture.plan.candidateCommit,
      candidateTree: fixture.plan.candidateTree,
      policyRevision: "4".repeat(64),
      requiredReviewRevision: "5".repeat(64),
      workspaceId: encodedWorkspaceId,
      requiredReviewerIds: ["owner"],
      changes: [],
      patch: "",
      patchBytes: ""
    },
    policyDigest: fixture.plan.policyDigest,
    attachments: [fixture.attachment],
    createdAt: new Date(index).toISOString()
  });
  await saveAuthoritativeNativeReviewEnvelope(fixture.repository, envelope);
  const source = (await readVerifiedCiReviewSources(fixture.repository, envelope.review.reviewId))[0];
  if (source === undefined) throw new ProjectionFixtureError("fixture verified source missing");
  return source;
}

async function replacePlan(fixture: ProjectionFixture): Promise<void> {
  const replacement = `${fixture.planPath}.replacement`;
  await writeFile(replacement, await readFile(fixture.planPath), { mode: 0o600 });
  await rename(replacement, fixture.planPath);
}

class ProjectionFixtureError extends Error {
  readonly name = "ProjectionFixtureError";
}
