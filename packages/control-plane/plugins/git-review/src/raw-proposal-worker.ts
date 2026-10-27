import { join } from "node:path";
import {
  readNativeProjectRegistrations,
  resolveAuthoritativeNativeRepositoryTarget,
  type RepositoryExtensionContext
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { createAuthoritativeNativeReview, type AuthoritativeNativeReviewHooks } from "./authoritative-native-review.js";
import { readAuthoritativeNativeReviewRefs } from "./authoritative-native-review-git.js";
import { acceptReviewPreparations, type CodeReviewRuntime } from "./plugin-api.js";
import { completeProposalAcceptance, failProposalAcceptance, stageProposalAcceptance } from "./proposal-acceptance.js";
import {
  readRawProposalJobs,
  replaceRawProposalJob,
  type RawProposalBinding,
  type RawProposalJob,
  type RawProposalState
} from "./raw-proposal-journal.js";
export { captureRawProposalJobs } from "./raw-proposal-capture.js";

const retryDelaysMilliseconds = [0, 100, 500, 1_000, 5_000] as const;

type RawProposalRecoveryInput = {
  readonly context: RepositoryExtensionContext;
  readonly runtime: CodeReviewRuntime;
  readonly hooks?: AuthoritativeNativeReviewHooks;
  readonly retryFailed?: boolean;
  readonly publish: <Result>(scope: { readonly projectId: string; readonly repositoryId: string }, operation: () => Promise<Result>) => Promise<Result>;
};

export function createRawProposalWorker(input: RawProposalRecoveryInput & {
  readonly unavailable: (error: unknown) => void;
}): { readonly wake: (retryFailed?: boolean) => void; readonly drain: () => Promise<void> } {
  type Registration = ReturnType<typeof readNativeProjectRegistrations>[number];
  const pending = new Map<string, { readonly registration: Registration; readonly retryFailed: boolean }>();
  const active = new Map<string, Promise<void>>();
  let draining = false;
  const schedule = (): void => {
    while (active.size < 4) {
      const entry = [...pending.entries()].find(([key]) => !active.has(key));
      if (entry === undefined) return;
      const [key, queued] = entry;
      pending.delete(key);
      const running = processRepository({ ...input, retryFailed: queued.retryFailed }, queued.registration)
        .catch(input.unavailable)
        .finally(() => { active.delete(key); schedule(); });
      active.set(key, running);
    }
  };
  const wake = (retryFailed = false): void => {
    if (draining) return;
    for (const registration of readNativeProjectRegistrations(input.runtime.state)) {
      if (registration.phase !== "repository-prepared") continue;
      const key = `${registration.projectId}/${registration.repositoryId}`;
      const queued = pending.get(key);
      pending.set(key, { registration, retryFailed: retryFailed || queued?.retryFailed === true });
    }
    schedule();
  };
  return {
    wake,
    async drain() {
      draining = true;
      schedule();
      while (active.size > 0 || pending.size > 0) {
        schedule();
        await Promise.allSettled([...active.values()]);
      }
    }
  };
}

async function processRepository(
  input: RawProposalRecoveryInput,
  registration: ReturnType<typeof readNativeProjectRegistrations>[number]
): Promise<void> {
    const repository = join(input.context.stateDirectory, registration.projectId, `${registration.repositoryId}.git`);
    for (const job of await readRawProposalJobs(repository)) {
      if (job.state.status !== "pending" && job.state.status !== "failed") continue;
      if (job.state.status === "failed" && input.retryFailed !== true) continue;
      if (job.binding.generationId !== input.runtime.expectedGenerationId) {
        await replaceRawProposalJob(repository, job, { status: "stale", staleReason: "generation-changed" });
        continue;
      }
       for (let attempt = 0; attempt < 6; attempt++) {
         if (attempt > 0 && await rawJobCompleted(repository, job)) break;
         if (await prepareRawProposalJob(input, repository, job) === "complete") break;
         const milliseconds = retryDelaysMilliseconds[attempt];
         if (milliseconds !== undefined) await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
       }
    }
}

async function prepareRawProposalJob(
  input: RawProposalRecoveryInput,
  repository: string,
  job: RawProposalJob
): Promise<"failed" | "complete"> {
  const initial = await staleState(input.runtime, job.binding);
  if (initial !== undefined) {
    await replaceRawProposalJob(repository, job, initial);
    return initial.status === "failed" ? "failed" : "complete";
  }
  let published: Awaited<ReturnType<typeof createAuthoritativeNativeReview>> | undefined;
  try {
    const envelope = await createAuthoritativeNativeReview({ ...input.runtime, authoritativeTargetProofs: new Map() }, {
      projectId: job.binding.projectId, repositoryId: job.binding.repositoryId,
      proposalRef: job.binding.proposalRef, protectedRef: job.binding.protectedRef
    }, {
      ...input.hooks,
      async publish(publication, publish) {
        return input.publish({ projectId: job.binding.projectId, repositoryId: job.binding.repositoryId }, async () => {
          if (await rawJobCompleted(repository, job)) throw new RawProposalCompletedError();
          const stale = await staleState(input.runtime, job.binding);
          if (stale !== undefined) throw new RawProposalBlockedError(stale);
          assertEnvelopeBinding(job.binding, publication.envelope);
          await stageProposalAcceptance(publication.repository, input.runtime.expectedGenerationId, publication.envelope);
          published = input.hooks?.publish === undefined
            ? await publish()
            : await input.hooks.publish(publication, publish);
          return published;
        });
      }
    });
    await acceptReviewPreparations(input.runtime, envelope, `proposal:${envelope.review.reviewId}`);
    await input.publish({ projectId: job.binding.projectId, repositoryId: job.binding.repositoryId }, async () => {
      if (await rawJobCompleted(repository, job)) return;
      const stale = await staleState(input.runtime, job.binding);
      if (stale !== undefined) throw new RawProposalBlockedError(stale);
      assertEnvelopeBinding(job.binding, envelope);
      await completeProposalAcceptance(repository, input.runtime.expectedGenerationId, envelope);
      await replaceRawProposalJob(repository, job, { status: "ready", reviewId: envelope.review.reviewId, envelopeId: envelope.envelopeId });
    });
    return "complete";
  } catch (error) {
    if (error instanceof RawProposalCompletedError || await rawJobCompleted(repository, job)) return "complete";
    if (error instanceof RawProposalBlockedError) {
      if (published !== undefined) await failProposalAcceptance(repository, input.runtime.expectedGenerationId, published);
      await replaceRawProposalJob(repository, job, error.state);
      return error.state.status === "failed" ? "failed" : "complete";
    }
    const stale = await staleState(input.runtime, job.binding);
    if (stale !== undefined) {
      if (published !== undefined) await failProposalAcceptance(repository, input.runtime.expectedGenerationId, published);
      await replaceRawProposalJob(repository, job, stale);
      return stale.status === "failed" ? "failed" : "complete";
    }
    if (published !== undefined) await failProposalAcceptance(repository, input.runtime.expectedGenerationId, published);
    await replaceRawProposalJob(repository, job, { status: "failed", failure: "review-preparation-failed" });
    return "failed";
  }
}

async function rawJobCompleted(repository: string, job: RawProposalJob): Promise<boolean> {
  const current = (await readRawProposalJobs(repository, job.binding.generationId))
    .find((candidate) => candidate.jobId === job.jobId);
  if (current === undefined) throw new RawProposalWorkerError("raw proposal job disappeared during processing");
  return current.state.status === "ready" || current.state.status === "stale";
}

async function staleState(runtime: CodeReviewRuntime, expected: RawProposalBinding): Promise<Extract<RawProposalState, { readonly status: "stale" | "failed" }> | undefined> {
  if (runtime.expectedGenerationId !== expected.generationId) return { status: "stale", staleReason: "generation-changed" };
  const currentRuntime = { ...runtime, authoritativeTargetProofs: new Map() };
  let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
  try {
    target = await resolveAuthoritativeNativeRepositoryTarget(currentRuntime, {
      projectId: expected.projectId, repositoryId: expected.repositoryId, protectedRef: expected.protectedRef
    });
  } catch {
    return { status: "failed", failure: "review-preparation-failed" };
  }
  if (target.imported.policyDigest !== expected.policyDigest) return { status: "stale", staleReason: "policy-changed" };
  if (target.currentHead.commit !== expected.expectedProtectedHead || target.currentHead.sequence !== expected.authority.headSequence
    || target.currentHead.tree !== expected.authority.headTree) return { status: "stale", staleReason: "protected-head-changed" };
  if (target.imported.ownerHostId !== expected.authority.ownerHostId || target.imported.generationId !== expected.authority.importGenerationId
    || target.imported.importNonce !== expected.authority.importNonce || target.imported.bundleDigest !== expected.authority.bundleDigest
    || target.imported.resolvedTree !== expected.authority.resolvedTree) return { status: "stale", staleReason: "authority-changed" };
  try {
    const refs = await readAuthoritativeNativeReviewRefs({ gitExecutable: runtime.gitExecutable, gitIdentity: runtime.gitIdentity,
      repository: target.repository, signal: AbortSignal.timeout(30_000), protectedRef: expected.protectedRef, proposalRef: expected.proposalRef });
    if (refs.protectedHead !== expected.expectedProtectedHead) return { status: "stale", staleReason: "protected-head-changed" };
    if (refs.candidateCommit !== expected.candidateCommit || refs.candidateTree !== expected.candidateTree) {
      return { status: "stale", staleReason: "candidate-ref-changed" };
    }
  } catch {
    return { status: "failed", failure: "review-preparation-failed" };
  }
  return undefined;
}

function assertEnvelopeBinding(binding_: RawProposalBinding, envelope: Awaited<ReturnType<typeof createAuthoritativeNativeReview>>): void {
  const review = envelope.review;
  if (review.projectId !== binding_.projectId || review.repositoryId !== binding_.repositoryId
    || review.proposalRef !== binding_.proposalRef || review.protectedRef !== binding_.protectedRef
    || review.expectedProtectedHead !== binding_.expectedProtectedHead || review.candidateCommit !== binding_.candidateCommit
    || review.candidateTree !== binding_.candidateTree || envelope.policyDigest !== binding_.policyDigest) {
    throw new RawProposalBlockedError({ status: "stale", staleReason: "authority-changed" });
  }
}

class RawProposalBlockedError extends Error {
  readonly name = "RawProposalBlockedError";
  constructor(readonly state: Extract<RawProposalState, { readonly status: "stale" | "failed" }>) {
    super(state.status === "stale" ? state.staleReason : state.failure);
  }
}
class RawProposalCompletedError extends Error { readonly name = "RawProposalCompletedError"; }
class RawProposalWorkerError extends Error { readonly name = "RawProposalWorkerError"; }
