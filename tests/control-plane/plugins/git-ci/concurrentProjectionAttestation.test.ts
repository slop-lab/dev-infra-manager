import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAuthoritativeNativeReviewEnvelope, readVerifiedCiReviewSources,
  saveAuthoritativeNativeReviewEnvelope } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import * as planFiles from "../../../../packages/control-plane/plugins/git-ci/src/plan-file-version.js";
import { readVerifiedGitCiDeliveryProjection, saveGitCiPlan } from "../../../../packages/control-plane/plugins/git-ci/src/plan-store.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("does not overwrite a newer plan attestation when an earlier cold read finishes later", async () => {
  // Given two cold readers separated by a byte-identical file replacement.
  const repository = await mkdtemp(join(tmpdir(), "dim-ci-cold-attestation-")); roots.push(repository);
  const primary = { commit: "2".repeat(40), tree: "3".repeat(40) };
  const policyDigest = "6".repeat(64);
  const attachment = await saveGitCiPlan(repository, { schemaVersion: 1, projectId: "project-a", repositoryId: "root",
    expectedProtectedHead: "1".repeat(40), candidateCommit: primary.commit, candidateTree: primary.tree,
    policyDigest, qualityRevision: "7".repeat(64), requiredJobs: [],
    planning: { status: "valid", configBlob: null, jobs: [] } });
  const envelope = createAuthoritativeNativeReviewEnvelope({ identity: {
    schemaVersion: 2, serviceId: "native-main", projectId: "project-a", repositoryId: "root", inputs: { root: primary },
    protectedRef: "refs/heads/main", proposalRef: "refs/heads/cold-race", expectedProtectedHead: "1".repeat(40),
    candidateCommit: primary.commit, candidateTree: primary.tree, policyRevision: "4".repeat(64),
    requiredReviewRevision: "5".repeat(64), requiredReviewerIds: ["owner"], changes: [], patch: "", patchBytes: ""
  }, policyDigest, attachments: [attachment], createdAt: "2026-01-01T00:00:00.000Z" });
  await saveAuthoritativeNativeReviewEnvelope(repository, envelope);
  const source = (await readVerifiedCiReviewSources(repository, envelope.review.reviewId))[0];
  if (source === undefined) throw new Error("fixture verified source missing");
  const originalRead = planFiles.readGitCiPlanFile;
  const firstRead = Promise.withResolvers<void>(), releaseFirst = Promise.withResolvers<void>();
  let reads = 0;
  vi.spyOn(planFiles, "readGitCiPlanFile").mockImplementation(async (input) => {
    const record = await originalRead(input);
    reads += 1;
    if (reads === 1) { firstRead.resolve(); await releaseFirst.promise; }
    return record;
  });
  const earlier = readVerifiedGitCiDeliveryProjection(repository, source);
  const earlierOutcome = earlier.then((value) => ({ ok: true, value } as const), (error: unknown) => ({ ok: false, error } as const));
  try {
    await firstRead.promise;
    const path = join(repository, "dim-git-ci-plans", `${attachment.id}.json`), replacement = `${path}.replacement`;
    await writeFile(replacement, await readFile(path), { mode: 0o600 }); await rename(replacement, path);
    // When the newer reader publishes its attestation before the older read resumes.
    const newer = await readVerifiedGitCiDeliveryProjection(repository, source);
    releaseFirst.resolve();
    const outcome = await earlierOutcome;
    // Then the obsolete snapshot is rejected and cannot poison the current cache.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("obsolete plan snapshot was accepted");
    expect(outcome.error).toBeInstanceOf(planFiles.GitCiPlanFileVersionError);
    expect(await readVerifiedGitCiDeliveryProjection(repository, source)).toBe(newer);
  } finally { releaseFirst.resolve(); await earlierOutcome; }
});
