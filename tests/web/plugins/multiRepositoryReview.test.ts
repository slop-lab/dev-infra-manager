import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nativeBundleReviewFixture, createBundleReview } from "../../control-plane/plugins/git-ci/nativeBundleReviewFixture.js";
import { authoritativePolicy } from "../../control-plane/plugins/git-repositories/authoritativeNativeCandidateFixture.js";
import { cleanupFinalizeFixtures, createRootBundle, uploadRootBundle, parseImportReceipt, finalizeRootImport,
  generationId, importer, projectInput } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
import { webPlugin } from "../../../packages/web/plugins/native-git/src/index.js";
import { humanReviewer } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);
it("selects independent repositories in one web Project and fences review IDs by repository", async () => {
  const native = await nativeBundleReviewFixture("web-multi", undefined, authoritativePolicy(["owner"], [], [], ["public"]),
    undefined, undefined, undefined, undefined, {}, undefined, "jobs: {}\n", undefined, "public");
  await native.service.prepareProject(generationId, importer.hostId, projectInput("project-a", "private"));
  const bundle = await createRootBundle({ "README.md": "private bytes\n" });
  const receipt = parseImportReceipt(await (await uploadRootBundle(native.service.origin, bundle,
    authoritativePolicy(["owner"], [], [], ["private"]), "private")).json());
  expect((await finalizeRootImport(native.service.origin, { schemaVersion: 1, generationId,
    importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest }, undefined, "private")).status).toBe(200);
  const envelope = await createBundleReview(native.service, "public");
  const root = await mkdtemp(join(tmpdir(), "dim-web-multi-"));
  const file = join(root, "reviewer.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl: native.service.origin, generationId, ...humanReviewer }), { mode: 0o600 });
  const runtime = await webPlugin.create({ reviewerConnection: file, projectId: "project-a", repositoryIds: ["public", "private"] });
  try {
    expect(await runtime.invoke("repositories.list", {})).toMatchObject({ projectId: "project-a", repositoryIds: ["public", "private"] });
    expect(Array.isArray(await runtime.invoke("reviews.list", { repositoryId: "public" }))).toBe(true);
    expect(await runtime.invoke("reviews.list", { repositoryId: "private" })).toEqual([]);
    expect(await runtime.invoke("reviews.detail", { repositoryId: "public", reviewId: envelope.review.reviewId }))
      .toMatchObject({ repositoryId: "public", inputs: envelope.review.inputs });
    await expect(runtime.invoke("reviews.detail", { repositoryId: "private", reviewId: envelope.review.reviewId })).rejects.toMatchObject({ status: 404 });
    await expect(runtime.invoke("reviews.list", { repositoryId: "unconfigured" })).rejects.toThrow("configured scope");
  } finally { await rm(root, { recursive: true, force: true }); }
});
