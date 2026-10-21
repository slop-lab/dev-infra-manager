import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { nativeBundleReviewFixture, createBundleReview, reviewProposalRef } from "../../control-plane/plugins/git-ci/nativeBundleReviewFixture.js";
import { humanReviewer, foreignHumanReviewer, generationId, generationB, activationTokenB, startFinalizeServiceForGeneration, activateFinalizeServiceForGeneration, runGit } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
export async function installedReviewerFixture() {
  const fixture = await nativeBundleReviewFixture("web");
  const envelope = await createBundleReview(fixture.service);
  let service = fixture.service;
  return {
    ...fixture, get service() { return service; }, reviewId: envelope.review.reviewId, proposalRef: reviewProposalRef,
    baseUrl: () => fixture.service.origin,
    git: (directory: string, args: string[]) => runGit("/usr/bin/git", ["-C", directory, ...args]),
    request: (username: string, method: string, path: string, body?: object) => {
      const credential = username === "docs-reviewer-user" ? foreignHumanReviewer : humanReviewer;
      return fetch(fixture.service.origin + path, { method, headers: {
        authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
        "Content-Type": "application/json", "X-Dim-Generation-Id": generationId
      }, ...(body === undefined ? {} : { body: JSON.stringify(path.endsWith("/approvals") ? { requestId: randomUUID() } : body) }) });
    },
    async restart() {
      const origin = fixture.service.origin;
      await service.close();
      service = await startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB);
      await activateFinalizeServiceForGeneration(service.origin, generationB, activationTokenB);
      await new Promise<void>((resolve) => service.server.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        service.server.once("error", reject);
        service.server.listen(Number(new URL(origin).port), "127.0.0.1", () => { service.server.off("error", reject); resolve(); });
      });
    },
    async close() { await service.close(); await Promise.all([fixture.root, fixture.clone].map((root) => rm(root, { recursive:true, force:true }))); }
  };
}
export type ReviewFixture = Awaited<ReturnType<typeof installedReviewerFixture>>;
