import type { RepositoryAccess, RepositoryReadService } from "@slop-lab/gs-repository-service";
import type {
  ReviewChangedPath,
} from "@slop-lab/gs-review-contracts";
import type { RepositoryPolicy } from "@slop-lab/gs-repository-contracts";
import type { ReviewChangeMatcher } from "./change-matchers.js";
import { codeReviewPolicy } from "./policy.js";
import { readAuthoritativeCandidateFile, readReviewBlob } from "./review-git.js";

export type ReviewRequirements = {
  readonly reviewerIds: readonly string[];
  readonly evidence: readonly { readonly rule: number; readonly digest: string }[];
};

export async function reviewRequirementsForChanges(input: {
  readonly reader: RepositoryReadService;
  readonly access: RepositoryAccess;
  readonly matchers: readonly ReviewChangeMatcher[];
  readonly policy: RepositoryPolicy;
  readonly changes: readonly ReviewChangedPath[];
  readonly candidateCommit: string;
  readonly baseCommit?: string;
  readonly protectedRef?: string;
}): Promise<ReviewRequirements> {
  const reviewed = codeReviewPolicy(input.policy, input.matchers, input.protectedRef);
  const reviewers = new Set(pathRequiredReviewers(reviewed, input.changes));
  const objectIds = new Set(input.changes
    .flatMap(({ oldObjectId, newObjectId }) => [oldObjectId, newObjectId])
    .filter((objectId) => objectId !== "0"));
  const blobs = new Map<string, Promise<Buffer>>();
  const signal = AbortSignal.timeout(30_000);
  const readBlob = (objectId: string): Promise<Buffer> => {
    if (!objectIds.has(objectId)) throw new ReviewRequirementsError("matcher requested an object outside the change set");
    let pending = blobs.get(objectId);
    if (pending === undefined) {
      pending = readReviewBlob({ reader: input.reader, access: input.access, objectId, signal });
      blobs.set(objectId, pending);
    }
    return pending.then((value) => Buffer.from(value));
  };
  const evidence: { rule: number; digest: string }[] = [];
  for (const [index, rule] of reviewed.changeReviewerRules.entries()) {
    const matcher = input.matchers.find(({ name }) => name === rule.matcher);
    if (matcher === undefined) throw new ReviewRequirementsError(`required matcher '${rule.matcher}' is unavailable`);
    const result = await matcher.matches({
      options: rule.options,
      changes: input.changes,
      readBlob,
      readCandidateFile: (path) => readAuthoritativeCandidateFile({
        reader: input.reader,
        access: input.access,
        candidateCommit: input.candidateCommit,
        path,
        signal,
      }),
      ...(input.baseCommit === undefined ? {} : {
        readBaseFile: (path: string) => readAuthoritativeCandidateFile({
          reader: input.reader,
          access: input.access,
          candidateCommit: input.baseCommit ?? "",
          path,
          signal,
        }),
      }),
    });
    const matches = typeof result === "boolean" ? result : result.matches;
    if (typeof result !== "boolean") {
      if (!/^[0-9a-f]{64}$/.test(result.evidenceDigest)) {
        throw new ReviewRequirementsError("matcher returned an invalid evidence digest");
      }
      evidence.push({ rule: index, digest: result.evidenceDigest });
    }
    if (matches) for (const reviewer of rule.reviewerIds) reviewers.add(reviewer);
  }
  return { reviewerIds: [...reviewers].sort(), evidence };
}

function pathRequiredReviewers(
  reviewed: ReturnType<typeof codeReviewPolicy>,
  changes: readonly ReviewChangedPath[],
): readonly string[] {
  const reviewers = new Set(reviewed.requiredReviewerIds);
  for (const rule of reviewed.pathReviewerRules) {
    const prefix = Buffer.from(rule.pathPrefix, "utf8");
    const matches = changes.some((change) => [change.oldPathBytes, change.newPathBytes]
      .some((encoded) => Buffer.from(encoded, "base64").subarray(0, prefix.length).equals(prefix)));
    if (matches) for (const reviewer of rule.reviewerIds) reviewers.add(reviewer);
  }
  return [...reviewers].sort();
}

export class ReviewRequirementsError extends Error {
  readonly name = "ReviewRequirementsError";
}
