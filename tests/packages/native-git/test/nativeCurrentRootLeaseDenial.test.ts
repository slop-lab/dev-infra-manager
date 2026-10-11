import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFinalizeFixtures,
  generationId,
  rootReadIssuerAuthorization,
  runGit,
  workspaceWriteIssuerAuthorization
} from "./nativeRootImportFinalizeFixture.js";
import { nativeBundleReviewFixture, reviewWorkspaceId } from "./nativeBundleReviewFixture.js";
import { seedRootPromotion } from "./nativeCurrentRootProofFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native current root lease denial", () => {
  it("returns conflict to both read and write issuers for unattested promotion state", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("unattested-root-leases");
    const candidateCommit = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"]))
      .stdout.trim();
    const candidateTree = (await runGit("/usr/bin/git", ["-C", fixture.clone,
      "rev-parse", `${candidateCommit}^{tree}`])).stdout.trim();
    await seedRootPromotion({ root: fixture.root, candidateCommit, candidateTree });
    const origin = `${fixture.service.origin}/v1/projects/project-a`;

    // When
    const read = await fetch(`${origin}/root-read-leases`, {
      method: "POST",
      headers: { authorization: rootReadIssuerAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, generationId })
    });
    const write = await fetch(`${origin}/workspace-write-leases`, {
      method: "POST",
      headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root",
        workspaceId: reviewWorkspaceId })
    });

    // Then
    expect(read.status).toBe(409);
    expect(write.status).toBe(409);
  });
});
