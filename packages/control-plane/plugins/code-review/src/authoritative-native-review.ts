import { defaultReviewChangeMatchers } from "./change-matchers.js";
import { codeReviewPolicy } from "./policy.js";
import type { CodeReviewRuntime, ReviewAttachment } from "./extensions.js";
import { assertReviewInputsCurrent } from "./review-inputs.js";
import { z } from "zod";
import {
  resolveAuthoritativeNativeRepositoryTarget,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/extensions";
import {
  assertAuthoritativeNativeReviewRefs,
  readAuthoritativeNativeCandidateFile,
  readAuthoritativeNativeReviewBlob,
  inspectAuthoritativeNativeReviewGit
} from "./authoritative-native-review-git.js";
import {
  createAuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeChangedPath,
  type AuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewIdentity
} from "./authoritative-native-review-schema.js";
import { saveAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { NativeImportedRootPolicy } from "@slop-lab/dim-control-plane-plugin-git-repositories/extensions";
import { repositorySnapshotsSchema as executionInputsSchema } from "@slop-lab/dim-contracts-git";

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
  runtime: CodeReviewRuntime,
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
    const requirements = await reviewRequirementsForChanges(runtime, policy, evidence.changes, target.repository, evidence.candidateCommit, evidence.expectedProtectedHead);
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
      requiredReviewRevision: codeReviewPolicy(policy, runtime.reviewChangeMatchers).requiredReviewRevision,
      workspaceId: selector.data.workspaceId,
      requiredReviewerIds: requirements.reviewerIds,
      ...(requirements.evidence.length === 0 ? {} : { changeRuleEvidence: requirements.evidence })
    };
    const attachments: ReviewAttachment[] = [];
    for (const preparation of runtime.reviewPreparations ?? []) {
      const prepared = await preparation.prepare({ runtime, selector: selector.data, target, evidence, identity });
      const combined = { ...identity.inputs };
      for (const [id, snapshot] of Object.entries(prepared.inputs)) {
        const previous = combined[id];
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(snapshot)) throw new Error("review preparations returned conflicting repository snapshots");
        combined[id] = snapshot;
      }
      identity = { ...identity, inputs: executionInputsSchema.parse(Object.fromEntries(Object.entries(combined).sort(([left], [right]) => left.localeCompare(right)))) };
      if (prepared.attachment !== undefined) attachments.push(prepared.attachment);
    }
    const envelope = createAuthoritativeNativeReviewEnvelope({ identity,
      policyDigest: target.imported.policyDigest, attachments, createdAt: new Date().toISOString() });
    await hooks.beforeFinalVerification?.();
    const current = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: selector.data.projectId, repositoryId: selector.data.repositoryId });
    if (current.repository !== target.repository
      || JSON.stringify(current.imported) !== JSON.stringify(target.imported)
      || JSON.stringify(current.currentHead) !== JSON.stringify(target.currentHead)) {
      throw new AuthoritativeNativeReviewError("authoritative imported repository changed during review creation");
    }
    const currentRequirements = await reviewRequirementsForChanges(runtime, current.imported.policy, evidence.changes, target.repository, evidence.candidateCommit, evidence.expectedProtectedHead);
    if (codeReviewPolicy(current.imported.policy, runtime.reviewChangeMatchers).requiredReviewRevision !== identity.requiredReviewRevision
      || JSON.stringify(currentRequirements.reviewerIds) !== JSON.stringify(identity.requiredReviewerIds)
      || JSON.stringify(currentRequirements.evidence) !== JSON.stringify(identity.changeRuleEvidence ?? [])) {
      throw new AuthoritativeNativeReviewError("required review matcher changed during review creation");
    }
    await assertReviewInputsCurrent(runtime, identity);
    for (const preparation of runtime.reviewPreparations ?? []) {
      const attachment = attachments.find((entry) => entry.kind === preparation.name);
      await preparation.assertCurrent?.({ runtime, review: identity, ...(attachment === undefined ? {} : { attachment }) });
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
    if (error instanceof Error && /changed during review creation/.test(error.message)) {
      throw new AuthoritativeNativeReviewError("authoritative native refs changed during review creation", { cause: error });
    }
    throw new AuthoritativeNativeReviewError("authoritative native review could not be created", { cause: error });
  }
}

function pathRequiredReviewers(
  reviewed: ReturnType<typeof codeReviewPolicy>,
  changes: readonly AuthoritativeNativeChangedPath[]
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

export async function reviewRequirementsForChanges(
  runtime: CodeReviewRuntime, policy: NativeImportedRootPolicy, changes: readonly AuthoritativeNativeChangedPath[],
  repository: string, candidateCommit: string, baseCommit?: string
): Promise<{ readonly reviewerIds: readonly string[]; readonly evidence: readonly { readonly rule: number; readonly digest: string }[] }> {
  const reviewed = codeReviewPolicy(policy, runtime.reviewChangeMatchers);
  const reviewers = new Set(pathRequiredReviewers(reviewed, changes));
  const objectIds = new Set(changes.flatMap(({ oldObjectId, newObjectId }) => [oldObjectId, newObjectId]).filter((id) => id !== "0"));
  const blobs = new Map<string, Promise<Buffer>>();
  const git = { gitExecutable: runtime.gitExecutable, gitIdentity: runtime.gitIdentity, repository, signal: AbortSignal.timeout(30_000) };
  const readBlob = (objectId: string): Promise<Buffer> => {
    if (!objectIds.has(objectId)) throw new Error("review matcher requested an object outside the authoritative change set");
    let pending = blobs.get(objectId);
    if (pending === undefined) { pending = readAuthoritativeNativeReviewBlob(git, objectId); blobs.set(objectId, pending); }
    return pending.then((value) => Buffer.from(value));
  };
  const evidence: { rule: number; digest: string }[] = [];
  for (const [index, rule] of reviewed.changeReviewerRules.entries()) {
    const matcher = (runtime.reviewChangeMatchers ?? defaultReviewChangeMatchers()).find(({ name }) => name === rule.matcher);
    if (matcher === undefined) throw new Error(`required review change matcher '${rule.matcher}' is unavailable`);
    const result = await matcher.matches({ options: rule.options, changes, readBlob,
      readCandidateFile: (path) => readAuthoritativeNativeCandidateFile({ ...git, candidateCommit }, path),
      ...(baseCommit === undefined ? {} : { readBaseFile: (path: string) => readAuthoritativeNativeCandidateFile({ ...git, candidateCommit: baseCommit }, path) }) });
    const matches = typeof result === "boolean" ? result : result.matches;
    if (typeof result !== "boolean") {
      if (!/^[0-9a-f]{64}$/.test(result.evidenceDigest)) throw new Error("review change matcher returned invalid evidence digest");
      evidence.push({ rule: index, digest: result.evidenceDigest });
    }
    if (typeof matches !== "boolean") throw new Error(`review change matcher '${matcher.name}' returned a non-boolean result`);
    if (matches) for (const reviewer of rule.reviewerIds) reviewers.add(reviewer);
  }
  return { reviewerIds: [...reviewers].sort(), evidence };
}

export class AuthoritativeNativeReviewError extends Error {
  readonly name = "AuthoritativeNativeReviewError";
}
