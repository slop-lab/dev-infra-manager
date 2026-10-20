import { nativeRepositoryPolicyRevision, parseAuthoritativeImportedRootPolicy } from "../../packages/contracts/git/src/index.js";

/** Test authors select feature declarations explicitly; production owners validate each namespace. */
export function gitPolicy(extensions: Readonly<Record<string, unknown>> = {}, protectedRef = "refs/heads/main") {
  return parseAuthoritativeImportedRootPolicy({ schemaVersion: 1, protectedRef, extensions,
    policyRevision: nativeRepositoryPolicyRevision({ protectedRef, extensions }) });
}
export function managedPolicyExtensions(input: {
  readonly reviewers?: readonly string[];
  readonly paths?: readonly { readonly pathPrefix: string; readonly reviewerIds: readonly string[] }[];
  readonly jobs?: readonly { readonly name: string; readonly kind: "ordinary-sysbox" | "qemu" }[];
  readonly repositories?: readonly string[];
} = {}) {
  return {
    "code-review": { requiredReviewerIds: input.reviewers ?? ["owner"], pathReviewerRules: input.paths ?? [] },
    "git-ci": { ciRepositoryIds: input.repositories ?? ["root"], requiredJobs: (input.jobs ?? []).map((job) => ({ ...job, evidenceClass: "candidate-controlled" as const })) },
    "merge-policy": {}
  };
}
