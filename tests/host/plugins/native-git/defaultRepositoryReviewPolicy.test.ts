import { expect, it } from "vitest";
import { defaultRepositoryReviewExtensions } from "../../../../packages/host/plugins/native-git/src/defaultRepositoryReviewPolicy.js";
import { previewNativeRepositoryManifest } from "../../../../packages/host/plugins/native-git/src/repositoryManifestImport.js";

it("defaults review declarations using the importing controller identity without replacing explicit rules or CI", () => {
  const ci = { ciRepositoryIds: ["main"], requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }] };
  const explicit = { requiredReviewerIds: ["security"], pathReviewerRules: [] };
  expect(defaultRepositoryReviewExtensions({ "code-review": explicit, "git-ci": ci }, "operator")).toEqual({ "code-review": explicit, "git-ci": ci });
  expect(defaultRepositoryReviewExtensions({ "code-review": null }, "operator")).toMatchObject({ "code-review": null });
  expect(() => defaultRepositoryReviewExtensions(undefined, "")).toThrow(/reviewer identity/);
});

it("previews the exact reviewer-aware defaults that manifest import persists, including repository-specific sync policy", () => {
  const manifest = `schemaVersion: 1
repositories:
  main:
    ref: main
    upstream: {url: https://example.com/source.git, branch: development}
`;
  const plan = previewNativeRepositoryManifest("project", manifest, "operator");
  expect(plan.repositories[0]!.policy).toEqual({ "code-review": { requiredReviewerIds: [], pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: ["operator"] }] },
    "merge-policy": {}, "git-sync": { upstream: { url: "https://example.com/source.git", branch: "development" } } });
});

it("does not require a reviewer connection or add plugins for explicitly review-disabled or fully declared policies", () => {
  expect(defaultRepositoryReviewExtensions({}, undefined, { "refs/heads/main": { review: false } })).toEqual({});
  const explicit = { "code-review": { requiredReviewerIds: ["security"], pathReviewerRules: [] } };
  expect(defaultRepositoryReviewExtensions(explicit)).toBe(explicit);
});
