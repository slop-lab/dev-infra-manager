import { afterEach, describe, expect, it } from "vitest";
import { authoritativePolicy, proofBytes } from "./authoritativeNativeCandidateFixture.js";
import {
  activateFinalizeService,
  authorization,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootRepository,
  runGit,
  startFinalizeService,
  uploadRootBundle
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native imported root proof with proposals", () => {
  it("keeps the protected-root proof live after a workspace proposal is created", async () => {
    // Given
    const root = await createFinalizeRoot("proposal-proof");
    const bundle = await createRootBundle();
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle,
      authoritativePolicy())).json());
    expect((await finalizeRootImport(service.origin, { schemaVersion: 1, generationId,
      importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest })).status).toBe(200);
    const before = await proofBytes(root);
    const workspaceId = "A".repeat(43);
    const candidate = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root),
      "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
      "commit-tree", bundle.tree, "-p", bundle.commit, "-m", "candidate"])).stdout.trim();
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(root), "update-ref",
      `refs/heads/proposals/${workspaceId}/change`, candidate]);

    // When
    const proof = await fetch(`${service.origin}/v1/projects/project-a/root-import/proof`, {
      headers: { authorization }
    });

    // Then
    expect(proof.status).toBe(200);
    expect(await proofBytes(root)).toEqual(before);
    await closeFinalizeService(service);
    const restarted = await startFinalizeService(root);
    await activateFinalizeService(restarted.origin);
    const afterRestart = await fetch(`${restarted.origin}/v1/projects/project-a/root-import/proof`, {
      headers: { authorization }
    });
    expect(afterRestart.status).toBe(200);
  });
});
