import { z } from "zod";
import {
  resolveAuthoritativeNativeRootTarget,
  type AuthoritativeNativeCandidateRuntime
} from "./authoritative-native-root-target.js";
import {
  assertAuthoritativeNativeReviewRefs,
  inspectAuthoritativeNativeReviewGit
} from "./authoritative-native-review-git.js";
import {
  createAuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeChangedPath,
  type AuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewIdentity
} from "./authoritative-native-review-schema.js";
import { saveAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { NativeImportedRootPolicy } from "./native-imported-root-policy.js";
import { CandidateExecutionError } from "./candidate-execution-schema.js";

const workspaceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((value) =>
  Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value);
const proposalName = z.string().min(1).max(1024).refine((value) => !value.startsWith(".")
  && !value.includes("/.") && !value.includes("..") && !value.includes("//") && !value.endsWith("/")
  && !value.endsWith(".") && !value.endsWith(".lock") && /^[A-Za-z0-9._/-]+$/.test(value));
const selectorSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  repositoryId: z.literal("root"),
  proposalRef: z.string()
}).strict().readonly().transform((selector, context) => {
  const match = /^refs\/heads\/proposals\/([^/]+)\/(.+)$/.exec(selector.proposalRef);
  const workspace = workspaceId.safeParse(match?.[1]);
  const proposal = proposalName.safeParse(match?.[2]);
  if (!workspace.success || !proposal.success) {
    context.addIssue({ code: "custom", message: "proposal namespace is invalid" });
    return z.NEVER;
  }
  return { ...selector, workspaceId: workspace.data };
});

export type AuthoritativeNativeReviewHooks = {
  readonly beforeFinalVerification?: () => void | Promise<void>;
};

export async function createAuthoritativeNativeReview(
  runtime: AuthoritativeNativeCandidateRuntime,
  input: unknown,
  hooks: AuthoritativeNativeReviewHooks = {}
): Promise<AuthoritativeNativeReviewEnvelope> {
  try {
    const selector = selectorSchema.safeParse(input);
    if (!selector.success) {
      throw new AuthoritativeNativeReviewError("authoritative native review selector is invalid", {
        cause: selector.error
      });
    }
    const target = await resolveAuthoritativeNativeRootTarget(runtime, { projectId: selector.data.projectId });
    const signal = AbortSignal.timeout(30_000);
    const evidence = await inspectAuthoritativeNativeReviewGit({
      gitExecutable: runtime.gitExecutable,
      gitIdentity: runtime.gitIdentity,
      repository: target.repository,
      signal,
      protectedRef: target.currentHead.protectedRef,
      expectedProtectedHead: target.currentHead.commit,
      proposalRef: selector.data.proposalRef
    });
    const policy = target.imported.policy;
    const requiredJobs = policy.requiredJobs.map(({ name, kind, evidenceClass }) => ({
      executionKind: kind,
      jobName: name,
      evidenceClass
    })).sort((left, right) => left.executionKind.localeCompare(right.executionKind)
      || left.jobName.localeCompare(right.jobName));
    const identity: AuthoritativeNativeReviewIdentity = {
      schemaVersion: 1,
      serviceId: "native-main",
      projectId: selector.data.projectId,
      repositoryId: selector.data.repositoryId,
      protectedRef: policy.protectedRef,
      proposalRef: selector.data.proposalRef,
      ...evidence,
      policyRevision: policy.policyRevision,
      requiredReviewRevision: policy.requiredReviewRevision,
      requiredJobSetRevision: policy.requiredJobSetRevision,
      policyDigest: target.imported.policyDigest,
      workspaceId: selector.data.workspaceId,
      requiredJobs,
      requiredReviewerIds: requiredReviewers(policy, evidence.changes)
    };
    const envelope = createAuthoritativeNativeReviewEnvelope(identity, new Date().toISOString());
    await hooks.beforeFinalVerification?.();
    const current = await resolveAuthoritativeNativeRootTarget(runtime, { projectId: selector.data.projectId });
    if (current.repository !== target.repository
      || JSON.stringify(current.imported) !== JSON.stringify(target.imported)
      || JSON.stringify(current.currentHead) !== JSON.stringify(target.currentHead)) {
      throw new AuthoritativeNativeReviewError("authoritative imported root changed during review creation");
    }
    await assertAuthoritativeNativeReviewRefs({
      gitExecutable: runtime.gitExecutable,
      gitIdentity: runtime.gitIdentity,
      repository: target.repository,
      signal,
      protectedRef: identity.protectedRef,
      proposalRef: identity.proposalRef,
      expectedProtectedHead: identity.expectedProtectedHead,
      candidateCommit: identity.candidateCommit,
      candidateTree: identity.candidateTree
    });
    return saveAuthoritativeNativeReviewEnvelope(target.repository, envelope);
  } catch (error) {
    if (error instanceof AuthoritativeNativeReviewError) throw error;
    if (error instanceof CandidateExecutionError) {
      throw new AuthoritativeNativeReviewError(error.message, { cause: error });
    }
    if (error instanceof Error && /changed during review creation/.test(error.message)) {
      throw new AuthoritativeNativeReviewError("authoritative native refs changed during review creation", { cause: error });
    }
    throw new AuthoritativeNativeReviewError("authoritative native review could not be created", { cause: error });
  }
}

function requiredReviewers(
  policy: NativeImportedRootPolicy,
  changes: readonly AuthoritativeNativeChangedPath[]
): readonly string[] {
  const reviewers = new Set(policy.requiredReviewerIds);
  for (const rule of policy.pathReviewerRules) {
    const prefix = Buffer.from(rule.pathPrefix, "utf8");
    const matches = changes.some((change) => [change.oldPathBytes, change.newPathBytes]
      .some((encoded) => Buffer.from(encoded, "base64").subarray(0, prefix.length).equals(prefix)));
    if (matches) for (const reviewer of rule.reviewerIds) reviewers.add(reviewer);
  }
  return [...reviewers].sort();
}

export class AuthoritativeNativeReviewError extends Error {
  readonly name = "AuthoritativeNativeReviewError";
}
