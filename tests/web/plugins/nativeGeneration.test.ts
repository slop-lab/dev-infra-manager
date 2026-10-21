import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { webPlugin } from "../../../packages/web/plugins/native-git/src/index.js";
import { installedReviewerFixture } from "./nativeFixture.js";
import { humanReviewer, generationId } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
it("pins the attested service generation for subsequent review reads and approvals after service replacement", async () => {
  const native = await installedReviewerFixture(), root = await mkdtemp(join(tmpdir(), "dim-web-generation-"));
  const reviewerConnection = join(root, "reviewer.json");
  try {
    await writeFile(reviewerConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl: native.baseUrl(), generationId, ...humanReviewer }), { mode: 0o600 });
    const runtime = await webPlugin.create({ reviewerConnection, projects: [{ projectId: "project-a", repositoryIds: ["root"] }] });
    expect(await runtime.invoke("reviews.detail", { controllerId: "direct", projectId: "project-a", repositoryId: "root", reviewId: native.reviewId })).toMatchObject({ reviewId: native.reviewId });
    await native.restart();
    for (const name of ["reviews.detail", "reviews.approve"]) await expect(runtime.invoke(name, { controllerId: "direct", projectId: "project-a", repositoryId: "root", reviewId: native.reviewId })).rejects.toMatchObject({ status: 409 });
  } finally { await native.close(); await rm(root, { recursive: true, force: true }); }
});
