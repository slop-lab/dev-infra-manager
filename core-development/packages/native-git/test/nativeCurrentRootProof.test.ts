import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { readNativeProjectRootImportsFromDatabase } from "../../../../core/packages/native-git/src/native-project-root-import-transitions.js";
import {
  activationTokenB,
  authorization,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationB,
  generationId,
  importer,
  rootRepository,
  runGit,
  startFinalizeServiceForGeneration
} from "./nativeRootImportFinalizeFixture.js";
import { nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import { detachedCommit, seedRootPromotion } from "./nativeCurrentRootProofFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native Project current root proof", () => {
  it("rejects a finalized row without immutable review, approval, or job evidence", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("current-proof-unattested");
    const candidate = await proposalIdentity(fixture.clone);
    await seedRootPromotion({ root: fixture.root, ...candidate });

    // When
    const response = await rootProof(fixture.service.origin);

    // Then
    expect(response.status).toBe(409);
  });

  it("preserves original import provenance while denying an unattested finalized descendant", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("current-proof-sequence-one");
    const current = await proposalIdentity(fixture.clone);
    const initial = await protectedIdentity(fixture.root);
    await seedRootPromotion({ root: fixture.root, ...current });

    // When
    const response = await rootProof(fixture.service.origin);

    // Then
    expect(response.status).toBe(409);
    const imported = readNativeProjectRootImportsFromDatabase(join(fixture.root, "native-idle.sqlite3"))
      .find((entry) => entry.projectId === "project-a");
    expect(imported?.expectedCommit).toBe(initial.commit);
    expect(imported?.resolvedTree).toBe(initial.tree);
  });

  it("rejects an unattested finalized head during serving-generation rollover", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("current-proof-rollover");
    const current = await proposalIdentity(fixture.clone);
    await seedRootPromotion({ root: fixture.root, ...current });
    await closeFinalizeService(fixture.service);
    // When / Then
    await expect(startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB))
      .rejects.toThrow(/evidence is not yet verified/);
    const imported = readNativeProjectRootImportsFromDatabase(join(fixture.root, "native-idle.sqlite3"))
      .find((entry) => entry.projectId === "project-a");
    expect(imported?.generationId).toBe(generationId);
    expect(imported?.expectedCommit).not.toBe(current.candidateCommit);
  });

  it.each(["wrong recorded tree", "non-descendant", "unresolved intent"] as const)(
    "denies a %s without adopting the protected ref",
    async (scenario) => {
      // Given
      const fixture = await nativeBundleReviewFixture(`current-proof-${scenario.replaceAll(" ", "-")}`);
      const candidate = await proposalIdentity(fixture.clone);
      if (scenario === "wrong recorded tree") {
        const initial = await protectedIdentity(fixture.root);
        await seedRootPromotion({ root: fixture.root, ...candidate, recordedCandidateTree: initial.tree });
      } else if (scenario === "non-descendant") {
        const commit = await detachedCommit(fixture.root, candidate.candidateTree);
        await seedRootPromotion({ root: fixture.root, candidateCommit: commit,
          candidateTree: candidate.candidateTree });
      } else {
        await seedRootPromotion({ root: fixture.root, ...candidate, phase: "intent" });
      }

      // When
      const response = await rootProof(fixture.service.origin);

      // Then
      expect(response.status).toBe(409);
    }
  );

  it("denies unrecorded protected-ref drift", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("current-proof-drift");
    const candidate = await proposalIdentity(fixture.clone);
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "update-ref",
      "refs/heads/main", candidate.candidateCommit]);

    // When
    const response = await rootProof(fixture.service.origin);

    // Then
    expect(response.status).toBe(409);
  });
});

async function proposalIdentity(clone: string): Promise<{
  readonly candidateCommit: string;
  readonly candidateTree: string;
}> {
  const candidateCommit = (await runGit("/usr/bin/git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
  const candidateTree = (await runGit("/usr/bin/git", ["-C", clone, "rev-parse",
    `${candidateCommit}^{tree}`])).stdout.trim();
  return { candidateCommit, candidateTree };
}

async function protectedIdentity(root: string): Promise<{ readonly commit: string; readonly tree: string }> {
  const commit = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root),
    "rev-parse", "refs/heads/main"])).stdout.trim();
  const tree = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root),
    "rev-parse", `${commit}^{tree}`])).stdout.trim();
  return { commit, tree };
}

function rootProof(origin: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/root-import/proof`, { headers: { authorization } });
}
