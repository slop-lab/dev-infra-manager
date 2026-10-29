import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { RepositoryReadService } from "../../../packages/gs/repository-service/src/index.js";
import { createReviewFeature, type ReviewChangeMatcher, type ReviewPreparation } from "../../../packages/gs/review/src/index.js";
import { openMergePolicyFeature, type MergeQualityGuard } from "../../../packages/gs/merge-policy/src/index.js";
import { codeReviewRefUpdatePolicyExtension } from "../../../packages/control-plane/plugins/git-review/src/ref-update-policy.js";
import { mergeRefUpdatePolicyExtension } from "../../../packages/control-plane/plugins/git-merge-policy/src/ref-update-policy.js";

it("propagates matcher, preparation, and quality revisions into DIM ref-policy proofs", async () => {
  // Given
  let matcherRevision = "1".repeat(64);
  let preparationRevision = "2".repeat(64);
  let qualityRevision = "3".repeat(64);
  const matcher: ReviewChangeMatcher = {
    name: "matcher",
    get revision() { return matcherRevision; },
    validate() {},
    async matches() { return false; },
  };
  const preparation: ReviewPreparation = {
    name: "preparation",
    get revision() { return preparationRevision; },
    async prepare() { return { inputs: {} }; },
  };
  const reader = unusedReader();
  const review = createReviewFeature({
    reader,
    matchers: [matcher],
    preparations: [preparation],
    currentAuthorityEpoch: () => "4".repeat(64),
  });
  const root = await mkdtemp(join(tmpdir(), "gs-revision-fencing-"));
  const quality: MergeQualityGuard = {
    name: "quality",
    get revision() { return qualityRevision; },
    async check() { return []; },
  };
  const merge = openMergePolicyFeature({
    statePath: join(root, "merge.sqlite3"),
    reviewFeature: review,
    reader,
    qualityGuards: [quality],
    selectedRefPolicyNames: ["code-review", "merge-policy"],
    integrationPolicyNames: [],
  });
  const dimReview = codeReviewRefUpdatePolicyExtension(() => { throw new Error("unused"); },
    () => review.refUpdatePolicy.revision);
  const dimMerge = mergeRefUpdatePolicyExtension(() => { throw new Error("unused"); },
    () => merge.refUpdatePolicy.revision);

  try {
    // When / Then
    const initialReview = revision(dimReview.value);
    matcherRevision = "5".repeat(64);
    expect(revision(dimReview.value)).not.toBe(initialReview);
    const matcherChanged = revision(dimReview.value);
    preparationRevision = "6".repeat(64);
    expect(revision(dimReview.value)).not.toBe(matcherChanged);
    const initialMerge = revision(dimMerge.value);
    qualityRevision = "7".repeat(64);
    expect(revision(dimMerge.value)).not.toBe(initialMerge);
  } finally {
    merge.close();
    await rm(root, { recursive: true, force: true });
  }
});

function revision(value: object): string {
  const selected = Reflect.get(value, "revision");
  if (typeof selected !== "string") throw new Error("ref-policy revision missing");
  return selected;
}

function unusedReader(): RepositoryReadService {
  const unused = (): never => { throw new Error("unused repository reader"); };
  return {
    readBytes: async () => unused(),
    assertAdvertisedCommits: async () => unused(),
    readTreeFile: async () => unused(),
    readRef: async () => unused(),
    readCommitTree: async () => unused(),
  };
}
