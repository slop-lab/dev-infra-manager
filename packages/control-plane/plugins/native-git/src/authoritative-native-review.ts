import { captureExecutionInputs, assertExecutionInputsCurrent } from "./execution-inputs.js";
import { z } from "zod";
import {
  resolveAuthoritativeNativeRepositoryTarget,
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
import { CandidateExecutionError, executionInputsSchema } from "@slop-lab/dim-contracts-ci/descriptor";
import { loadAuthoritativeNativeCandidateJobInputs } from "./authoritative-native-candidate-job-inputs.js";
import type { AuthoritativeNativePlanning } from "./authoritative-native-review-schema.js";

const workspaceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((value) =>
  Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value);
const proposalName = z.string().min(1).max(1024).refine((value) => !value.startsWith(".")
  && !value.includes("/.") && !value.includes("..") && !value.includes("//") && !value.endsWith("/")
  && !value.endsWith(".") && !value.endsWith(".lock") && /^[A-Za-z0-9._/-]+$/.test(value));
const selectorSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
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
    const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: selector.data.projectId, repositoryId: selector.data.repositoryId });
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
    let identity: AuthoritativeNativeReviewIdentity = {
      schemaVersion: 2,
      serviceId: "native-main",
      projectId: selector.data.projectId,
      repositoryId: selector.data.repositoryId,
      inputs: { [selector.data.repositoryId]: { commit: evidence.candidateCommit, tree: evidence.candidateTree } },
      protectedRef: policy.protectedRef,
      proposalRef: selector.data.proposalRef,
      ...evidence,
      policyRevision: policy.policyRevision,
      requiredReviewRevision: policy.requiredReviewRevision,
      workspaceId: selector.data.workspaceId,
      requiredReviewerIds: requiredReviewers(policy, evidence.changes)
    };
    let planning: AuthoritativeNativePlanning;
    try {
      const inputs = await loadAuthoritativeNativeCandidateJobInputs(runtime, {
        projectId: selector.data.projectId, repositoryId: selector.data.repositoryId,
        candidateCommit: evidence.candidateCommit,
        candidateTree: evidence.candidateTree
      });
      planning = { status: "valid", configBlob: inputs.configBlob,
        jobs: await Promise.all(inputs.plan.map(async (job) => ({ executionKind: job.kind, jobName: job.name,
          evidenceClass: "candidate-controlled" as const, script: job.script, argv: job.argv,
          inputs: await captureExecutionInputs(runtime, { projectId: selector.data.projectId,
            repositoryId: selector.data.repositoryId, candidateCommit: evidence.candidateCommit,
            candidateTree: evidence.candidateTree, repositories: job.repositories }) }))) };
    } catch (error) {
      if (!(error instanceof CandidateExecutionError)) throw error;
      planning = { status: "invalid", reason: "invalid-candidate-job-plan" };
    }
    if (planning.status === "valid") {
      const combined = Object.assign({}, identity.inputs, ...planning.jobs.map((job) => job.inputs));
      identity = { ...identity, inputs: executionInputsSchema.parse(Object.fromEntries(Object.entries(combined).sort(([left], [right]) => left.localeCompare(right)))) };
    }
    const envelope = createAuthoritativeNativeReviewEnvelope({ identity,
      qualityRevision: policy.requiredJobSetRevision, policyDigest: target.imported.policyDigest,
      requiredJobs, planning, createdAt: new Date().toISOString() });
    await hooks.beforeFinalVerification?.();
    const current = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: selector.data.projectId, repositoryId: selector.data.repositoryId });
    if (current.repository !== target.repository
      || JSON.stringify(current.imported) !== JSON.stringify(target.imported)
      || JSON.stringify(current.currentHead) !== JSON.stringify(target.currentHead)) {
      throw new AuthoritativeNativeReviewError("authoritative imported repository changed during review creation");
    }
    if (planning.status === "valid") for (const job of planning.jobs) {
      await assertExecutionInputsCurrent(runtime, { projectId: identity.projectId, repositoryId: identity.repositoryId,
        candidateCommit: identity.candidateCommit, candidateTree: identity.candidateTree, inputs: job.inputs });
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

export function requiredReviewers(
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
