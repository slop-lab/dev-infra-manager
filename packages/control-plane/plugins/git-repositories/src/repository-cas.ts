import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { isNativeGitCandidateRef } from "@slop-lab/dim-contracts-git";
import {
  compareAndSwapProtectedRef as compareAndSwapGsProtectedRef,
  recoverProtectedRefChanges,
  type JournalPort,
  type ProtectedRefChange as GsProtectedRefChange,
  type ProtectedRefIntent,
  type ProtectedRefPorts,
} from "@slop-lab/gs-repository";
import {
  assertAuthoritativeNativeRepositoryTargetCurrent,
  resolveAuthoritativeNativeRepositoryTarget,
  type AuthoritativeNativeRepositoryTarget,
} from "./authoritative-native-root-target.js";
import { checkRefUpdatePolicies } from "./ref-update-policies.js";
import {
  assertRepositoryRefTransitions,
  cancelRepositoryRefIntent,
  finalizeRepositoryRef,
  readRepositoryRefTransitions,
  saveRepositoryRefIntent,
  type RepositoryRefTransition,
} from "./repository-ref-state.js";
import type { RepositoryExtensionContext, RepositoryRuntime } from "./plugin-api.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const protectedRefChangeSchema = z.object({
  projectId: identifier,
  repositoryId: identifier,
  protectedRef: z.string().startsWith("refs/heads/").optional(),
  proposalRef: z.string().refine(isNativeGitCandidateRef),
  expectedCommit: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  authorizationId: digest,
  evidenceDigest: digest,
}).strict().readonly();

export type ProtectedRefChange = z.infer<typeof protectedRefChangeSchema>;
type DimFence = {
  readonly importNonce: string;
  readonly generationId: string;
  readonly policyDigest: string;
};
type DimPolicyProof = { readonly refPolicyRevision: string };
type DimIntent = ProtectedRefIntent<DimFence, DimPolicyProof>;
type DimPorts = ProtectedRefPorts<DimFence, DimPolicyProof, AuthoritativeNativeRepositoryTarget>;

export async function compareAndSwapProtectedRef(
  context: RepositoryExtensionContext,
  input: ProtectedRefChange,
): Promise<{ readonly outcome: "promoted" | "already-current"; readonly sequence: number }> {
  const change = protectedRefChangeSchema.parse(input);
  return compareAndSwapGsProtectedRef(livePortsAlreadyExclusive(context), toGsChange(change));
}

export async function recoverRepositoryRefChanges(
  runtime: Pick<RepositoryRuntime, "state" | "gitExecutable" | "gitIdentity">,
  stateDirectory: string,
): Promise<void> {
  await recoverProtectedRefChanges(recoveryPortsAlreadyExclusive(runtime, stateDirectory));
}

export function readProtectedRefTransition(runtime: RepositoryRuntime, authorizationId: string): RepositoryRefTransition | undefined {
  const database = new DatabaseSync(runtime.state.database, { readOnly: true, defensive: true });
  try {
    return readRepositoryRefTransitions(database)
      .find((entry) => entry.finalized && entry.transition.authorizationId === authorizationId)?.transition;
  } finally {
    database.close();
  }
}

function livePortsAlreadyExclusive(context: RepositoryExtensionContext): DimPorts {
  const journal = journalPort(context.runtime.state.database);
  return {
    runtime: { gitExecutable: context.runtime.gitExecutable, storageRoot: context.stateDirectory },
    gitIdentity: context.runtime.gitIdentity,
    serialization: { kind: "already-exclusive" },
    journal,
    targets: {
      async resolve(change) {
        const selector = toDimSelector(change);
        const authority = await resolveAuthoritativeNativeRepositoryTarget(context.runtime, selector);
        return {
          selector: { namespaceId: change.namespaceId, repositoryId: change.repositoryId },
          repositoryPath: authority.repository,
          head: {
            sequence: authority.currentHead.sequence,
            protectedRef: authority.currentHead.protectedRef,
            commit: authority.currentHead.commit,
            tree: authority.currentHead.tree,
          },
          fence: {
            importNonce: authority.imported.importNonce,
            generationId: context.runtime.expectedGenerationId,
            policyDigest: authority.imported.policyDigest,
          },
          authority,
        };
      },
      async assertCurrent(target) {
        await assertAuthoritativeNativeRepositoryTargetCurrent({
          runtime: context.runtime,
          selector: { projectId: target.selector.namespaceId, repositoryId: target.selector.repositoryId, protectedRef: target.head.protectedRef },
          target: target.authority,
        });
      },
      async locateForRecovery(intent) {
        return join(context.stateDirectory, intent.namespaceId, `${intent.repositoryId}.git`);
      },
    },
    policy: {
      async authorize({ change, target }) {
        return { refPolicyRevision: await checkRefUpdatePolicies(context, target.authority, toDimChange(change)) };
      },
    },
  };
}

function recoveryPortsAlreadyExclusive(
  runtime: Pick<RepositoryRuntime, "state" | "gitExecutable" | "gitIdentity">,
  stateDirectory: string,
): DimPorts {
  return {
    runtime: { gitExecutable: runtime.gitExecutable, storageRoot: stateDirectory },
    gitIdentity: runtime.gitIdentity,
    serialization: { kind: "already-exclusive" },
    journal: journalPort(runtime.state.database),
    targets: {
      async resolve() { throw new Error("protected ref recovery cannot resolve a live target"); },
      async assertCurrent() { throw new Error("protected ref recovery cannot authorize a live target"); },
      async locateForRecovery(intent) { return join(stateDirectory, intent.namespaceId, `${intent.repositoryId}.git`); },
    },
    policy: {
      async authorize() { throw new Error("protected ref recovery cannot authorize a new transition"); },
    },
  };
}

function journalPort(databasePath: string): JournalPort<DimFence, DimPolicyProof> {
  return {
    findFinalized(change, protectedRef) {
      const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
      try {
        const entry = readRepositoryRefTransitions(database).find(({ transition, finalized }) => finalized
          && transition.projectId === change.namespaceId
          && transition.repositoryId === change.repositoryId
          && transition.authorizationId === change.authorizationId
          && transition.protectedRef === protectedRef);
        return entry === undefined ? undefined : fromDimIntent(entry.transition);
      } finally {
        database.close();
      }
    },
    appendIntent(intent) { saveRepositoryRefIntent(databasePath, toDimIntent(intent)); },
    finalize(intent) { finalizeRepositoryRef(databasePath, toDimIntent(intent)); },
    cancel(intent) { cancelRepositoryRefIntent(databasePath, toDimIntent(intent)); },
    pending() {
      const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
      try {
        assertRepositoryRefTransitions(database);
        return readRepositoryRefTransitions(database)
          .filter((entry) => !entry.finalized)
          .map((entry) => fromDimIntent(entry.transition));
      } finally {
        database.close();
      }
    },
  };
}

function toGsChange(input: ProtectedRefChange): GsProtectedRefChange {
  return {
    namespaceId: input.projectId,
    repositoryId: input.repositoryId,
    ...(input.protectedRef === undefined ? {} : { protectedRef: input.protectedRef }),
    proposalRef: input.proposalRef,
    expectedCommit: input.expectedCommit,
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    authorizationId: input.authorizationId,
    evidenceDigest: input.evidenceDigest,
  };
}

function toDimChange(input: GsProtectedRefChange): ProtectedRefChange {
  return {
    projectId: input.namespaceId,
    repositoryId: input.repositoryId,
    ...(input.protectedRef === undefined ? {} : { protectedRef: input.protectedRef }),
    proposalRef: input.proposalRef,
    expectedCommit: input.expectedCommit,
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    authorizationId: input.authorizationId,
    evidenceDigest: input.evidenceDigest,
  };
}

function toDimSelector(input: GsProtectedRefChange): { readonly projectId: string; readonly repositoryId: string; readonly protectedRef?: string } {
  return {
    projectId: input.namespaceId,
    repositoryId: input.repositoryId,
    ...(input.protectedRef === undefined ? {} : { protectedRef: input.protectedRef }),
  };
}

function toDimIntent(intent: DimIntent): RepositoryRefTransition {
  return {
    projectId: intent.namespaceId,
    repositoryId: intent.repositoryId,
    sequence: intent.sequence,
    importNonce: intent.fence.importNonce,
    protectedRef: intent.protectedRef,
    proposalRef: intent.proposalRef,
    expectedCommit: intent.expectedCommit,
    expectedTree: intent.expectedTree,
    candidateCommit: intent.candidateCommit,
    candidateTree: intent.candidateTree,
    generationId: intent.fence.generationId,
    policyDigest: intent.fence.policyDigest,
    refPolicyRevision: intent.proof.refPolicyRevision,
    authorizationId: intent.authorizationId,
    evidenceDigest: intent.evidenceDigest,
  };
}

function fromDimIntent(transition: RepositoryRefTransition): DimIntent {
  return {
    namespaceId: transition.projectId,
    repositoryId: transition.repositoryId,
    sequence: transition.sequence,
    protectedRef: transition.protectedRef,
    proposalRef: transition.proposalRef,
    expectedCommit: transition.expectedCommit,
    expectedTree: transition.expectedTree,
    candidateCommit: transition.candidateCommit,
    candidateTree: transition.candidateTree,
    authorizationId: transition.authorizationId,
    evidenceDigest: transition.evidenceDigest,
    fence: {
      importNonce: transition.importNonce,
      generationId: transition.generationId,
      policyDigest: transition.policyDigest,
    },
    proof: { refPolicyRevision: transition.refPolicyRevision },
  };
}
