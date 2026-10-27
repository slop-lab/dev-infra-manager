import { afterEach, expect, it } from "vitest";
import { readPendingAuthoritativeNativeDeliveries } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import { nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId, hostPromoterAuthorization, rootRepository, runGit } from "../git-repositories/nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);
it("records current CI intent when an operator explicitly prepares an ordinary branch merge", async () => {
  const fixture = await nativeBundleReviewFixture("merge-ci-intent"), sourceRef = "refs/heads/ordinary-merge";
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${sourceRef}`]);
  const response = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/merges`, {
    method: "POST", headers: { authorization: hostPromoterAuthorization, "x-dim-generation-id": generationId, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, sourceRef, targetRef: "refs/heads/main" }),
  });
  expect(response.status).toBe(200);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("reviewId" in value) || typeof value.reviewId !== "string") throw new Error("merge fixture review missing");
  const reviewId = value.reviewId;
  const jobs = (await readPendingAuthoritativeNativeDeliveries(rootRepository(fixture.root), 10,
    authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs"), generationId)).filter(({ event }) => event.reviewId === reviewId);
  expect(jobs).toHaveLength(2); expect(jobs.every(({ intent }) => intent?.generationId === generationId)).toBe(true);
}, 30_000);
