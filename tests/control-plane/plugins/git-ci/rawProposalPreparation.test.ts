import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { reviewPreparations, readAuthoritativeNativeReviewEnvelopes } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import {
  finalizeRepositoryRef,
  readNativeProjectRootCurrentHeadFromDatabase,
  readNativeProjectRootImportsFromDatabase,
  saveRepositoryRefIntent
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { authoritativePolicy } from "../git-repositories/authoritativeNativeCandidateFixture.js";
import {
  activateFinalizeServiceForGeneration,
  activationToken,
  activationTokenB,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationB,
  generationId,
  humanReviewerAuthorization,
  rootRepository,
  runGit,
  startFinalizeServiceForGeneration
} from "../git-repositories/nativeRootImportFinalizeFixture.js";
import { addCandidateCommit, nativeBundleReviewFixture, refreshBundleReviewWriter, reviewProposalRef } from "./nativeBundleReviewFixture.js";
import { readRawProposalJobs } from "../../../../packages/control-plane/plugins/git-review/src/raw-proposal-journal.js";

afterEach(cleanupFinalizeFixtures);

it("accepts new proposal work in a serving generation newer than the retained import receipt", async () => {
  const fixture = await nativeBundleReviewFixture("raw-new-serving-generation");
  await closeFinalizeService(fixture.service);
  const restarted = await startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB);
  await activateFinalizeServiceForGeneration(restarted.origin, generationB, activationTokenB);
  await refreshBundleReviewWriter({ ...fixture, service: restarted }, generationB);
  await addCandidateCommit(fixture.clone, "new-generation.txt", Buffer.from("new explicitly accepted proposal\n"));
  const commit = await head(fixture.clone);
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
  await expect.poll(async () => (await readRawProposalJobs(rootRepository(fixture.root), generationB))
    .find(({ binding }) => binding.candidateCommit === commit)?.state.status, { timeout: 10_000 }).toBe("ready");
});

it.each([false, true])("recovers failed raw preparation only in its accepted generation (rollover=%s)", async (rollover) => {
  // Given
  const fixture = await nativeBundleReviewFixture(`raw-prepare-failure-${String(rollover)}`);
  const preparation = gitCiPreparation(fixture);
  const prepare = preparation.prepare;
  await addCandidateCommit(fixture.clone, "failed-prepare.txt", Buffer.from("fail before review publication\n"));
  const commit = await head(fixture.clone);
  Object.defineProperty(preparation, "prepare", { value: async (input: Parameters<typeof prepare>[0]) => {
    if (input.evidence.candidateCommit === commit) throw new Error("injected preparation failure");
    return prepare(input);
  } });

  try {
    // When
    await expect(runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`])).resolves.toBeDefined();
    await expect.poll(() => rawJob(fixture.service.origin, commit), { timeout: 10_000 }).toMatchObject({ status: "failed" });

    // Then
    expect((await readAuthoritativeNativeReviewEnvelopes(rootRepository(fixture.root)))
      .some(({ review }) => review.candidateCommit === commit)).toBe(false);
    await expect(runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", "HEAD:refs/heads/main"])).rejects.toThrow();
    await closeFinalizeService(fixture.service);
    const servingGeneration = rollover ? generationB : generationId;
    const restarted = await startFinalizeServiceForGeneration(fixture.root, servingGeneration,
      rollover ? activationTokenB : activationToken);
    await activateFinalizeServiceForGeneration(restarted.origin, servingGeneration,
      rollover ? activationTokenB : activationToken);
    if (rollover) {
      await expect.poll(async () => (await readRawProposalJobs(rootRepository(fixture.root)))
        .find(({ binding }) => binding.candidateCommit === commit)?.state, { timeout: 10_000 }).toMatchObject({
          status: "stale", staleReason: "generation-changed"
        });
      const status = await fetch(`${restarted.origin}/v1/projects/project-a/repositories/root/review-preparations`, {
        headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": servingGeneration }
      });
      expect(status.status).toBe(200);
      const historical: unknown = await status.json();
      expect(historical).toMatchObject({ jobs: expect.arrayContaining([
        expect.objectContaining({ candidateCommit: commit, generationId, status: "stale", staleReason: "generation-changed" })
      ]) });
      expect((await readAuthoritativeNativeReviewEnvelopes(rootRepository(fixture.root)))
        .some(({ review }) => review.candidateCommit === commit)).toBe(false);
    } else {
      await expect.poll(() => rawJob(restarted.origin, commit), { timeout: 10_000 }).toMatchObject({ status: "ready" });
      expect((await readAuthoritativeNativeReviewEnvelopes(rootRepository(fixture.root)))
        .some(({ review }) => review.candidateCommit === commit)).toBe(true);
    }
  } finally {
    Object.defineProperty(preparation, "prepare", { value: prepare });
  }
}, 30_000);

it("marks the exact accepted job stale when its candidate ref moves during preparation", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("raw-candidate-stale");
  const preparation = gitCiPreparation(fixture);
  const prepare = preparation.prepare;
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await addCandidateCommit(fixture.clone, "candidate-a.txt", Buffer.from("candidate A\n"));
  const candidateA = await head(fixture.clone);
  Object.defineProperty(preparation, "prepare", { value: async (input: Parameters<typeof prepare>[0]) => {
    if (input.evidence.candidateCommit === candidateA) { entered?.(); await gate; }
    return prepare(input);
  } });

  try {
    // When
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    await blocked;
    await addCandidateCommit(fixture.clone, "candidate-b.txt", Buffer.from("candidate B\n"));
    const candidateB = await head(fixture.clone);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    release?.();

    // Then
    await expect.poll(() => rawJob(fixture.service.origin, candidateA), { timeout: 10_000 }).toMatchObject({
      status: "stale", staleReason: "candidate-ref-changed"
    });
    await expect.poll(() => rawJob(fixture.service.origin, candidateB), { timeout: 10_000 }).toMatchObject({ status: "ready" });
    const reviews = await readAuthoritativeNativeReviewEnvelopes(rootRepository(fixture.root));
    expect(reviews.some(({ review }) => review.candidateCommit === candidateA)).toBe(false);
    expect(reviews.some(({ review }) => review.candidateCommit === candidateB)).toBe(true);
  } finally {
    release?.();
    Object.defineProperty(preparation, "prepare", { value: prepare });
  }
}, 30_000);

it("marks pending raw preparation stale when trusted policy changes", async () => {
  const fixture = await blockedPreparationFixture("raw-policy-stale", "policy.txt");
  try {
    const policy = authoritativePolicy(["owner"], [], [
      { name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }
    ]);
    replaceImportedPolicy(fixture.root, policy);
    fixture.release();
    await expect.poll(() => rawJob(fixture.origin, fixture.commit), { timeout: 10_000 }).toMatchObject({
      status: "stale", staleReason: "policy-changed"
    });
  } finally { fixture.restore(); }
}, 30_000);

it("marks pending raw preparation stale when the protected head advances", async () => {
  const fixture = await blockedPreparationFixture("raw-head-stale", "head.txt");
  try {
    await addCandidateCommit(fixture.clone, "advanced-main.txt", Buffer.from("advanced protected head\n"));
    const candidateCommit = await head(fixture.clone);
    const candidateTree = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD^{tree}"])).stdout.trim();
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", "HEAD:refs/heads/head-advance-source"]);
    await advanceProtectedHead(fixture.root, candidateCommit, candidateTree);
    fixture.release();
    await expect.poll(() => rawJob(fixture.origin, fixture.commit), { timeout: 10_000 }).toMatchObject({
      status: "stale", staleReason: "protected-head-changed"
    });
  } finally { fixture.restore(); }
}, 30_000);

async function blockedPreparationFixture(label: string, path: string): Promise<{
  readonly root: string; readonly clone: string; readonly origin: string; readonly commit: string;
  readonly release: () => void; readonly restore: () => void;
}> {
  const fixture = await nativeBundleReviewFixture(label);
  const preparation = gitCiPreparation(fixture);
  const prepare = preparation.prepare;
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await addCandidateCommit(fixture.clone, path, Buffer.from(`${label}\n`));
  const commit = await head(fixture.clone);
  Object.defineProperty(preparation, "prepare", { value: async (input: Parameters<typeof prepare>[0]) => {
    if (input.evidence.candidateCommit === commit) { entered?.(); await gate; }
    return prepare(input);
  } });
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
  await blocked;
  return { root: fixture.root, clone: fixture.clone, origin: fixture.service.origin, commit,
    release: () => release?.(), restore: () => { release?.(); Object.defineProperty(preparation, "prepare", { value: prepare }); } };
}

function gitCiPreparation(fixture: Awaited<ReturnType<typeof nativeBundleReviewFixture>>) {
  const preparation = reviewPreparations(fixture.service.context.extensions).find(({ name }) => name === "git-ci");
  if (preparation === undefined) throw new Error("fixture CI preparation missing");
  return preparation;
}

async function rawJob(origin: string, candidateCommit: string): Promise<unknown> {
  const response = await fetch(`${origin}/v1/projects/project-a/repositories/root/review-preparations`, {
    headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId }
  });
  if (response.status !== 200) return { statusCode: response.status };
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || !("jobs" in value) || !Array.isArray(value.jobs)) return undefined;
  return value.jobs.find((candidate) => typeof candidate === "object" && candidate !== null
    && Reflect.get(candidate, "candidateCommit") === candidateCommit);
}

async function head(clone: string): Promise<string> {
  return (await runGit("/usr/bin/git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
}

function replaceImportedPolicy(root: string, policy: object): void {
  const policyJson = JSON.stringify(policy);
  const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
  database.prepare("UPDATE native_project_root_import SET policy_json = ?, policy_sha256 = ?")
    .run(policyJson, createHash("sha256").update(policyJson).digest("hex"));
  database.close();
}

async function advanceProtectedHead(root: string, candidateCommit: string, candidateTree: string): Promise<void> {
  const database = join(root, "native-idle.sqlite3");
  const imported = readNativeProjectRootImportsFromDatabase(database).find(({ projectId, repositoryId }) =>
    projectId === "project-a" && repositoryId === "root");
  if (imported?.phase !== "repository-imported") throw new Error("fixture import missing");
  const current = readNativeProjectRootCurrentHeadFromDatabase(database, "project-a", "root", "refs/heads/main");
  const transition = { projectId: "project-a", repositoryId: "root", sequence: current.sequence + 1,
    importNonce: imported.importNonce, protectedRef: "refs/heads/main", proposalRef: reviewProposalRef,
    expectedCommit: current.commit, expectedTree: current.tree, candidateCommit, candidateTree, generationId,
    policyDigest: current.policyDigest, refPolicyRevision: "1".repeat(64), authorizationId: "2".repeat(64), evidenceDigest: "3".repeat(64) };
  saveRepositoryRefIntent(database, transition);
  const repository = rootRepository(root);
  await runGit("/usr/bin/git", ["--git-dir", repository, "update-ref", "refs/heads/main", candidateCommit, current.commit]);
  finalizeRepositoryRef(database, transition);
}
