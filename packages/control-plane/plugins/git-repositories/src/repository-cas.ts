import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { isCandidateRef } from "@slop-lab/gs-repository-contracts";
import {
  compareAndSwapProtectedRef as compareAndSwapGsProtectedRef,
  parseProtectedRefFinalizedQuery,
  recoverProtectedRefChanges,
  type ProtectedRefChange as GsProtectedRefChange,
  type ProtectedRefFinalized,
  type ProtectedRefFinalizedQuery,
  type ProtectedRefPorts,
  type ProtectedRefTarget,
} from "@slop-lab/gs-repository";
import {
  assertAuthoritativeNativeRepositoryTargetCurrent,
  resolveAuthoritativeNativeRepositoryTarget,
  type AuthoritativeNativeRepositoryTarget,
} from "./authoritative-native-root-target.js";
import { checkRefUpdatePolicies, refUpdatePolicies, refUpdatePolicyRevision } from "./ref-update-policies.js";
import { readRepositoryRefTransitions, type RepositoryRefTransition } from "./repository-ref-state.js";
import { createDimJournalPort } from "./repository-cas-journal.js";
import type { RepositoryExtensionContext, RepositoryRuntime } from "./plugin-api.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/); const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const protectedRefChangeSchema = z.object({
  projectId: identifier,
  repositoryId: identifier,
  protectedRef: z.string().startsWith("refs/heads/").optional(),
  proposalRef: z.string().refine(isCandidateRef),
  expectedCommit: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  authorizationId: digest,
  evidenceDigest: digest,
}).strict().readonly();

export type ProtectedRefChange = z.infer<typeof protectedRefChangeSchema>;
type DimPorts = ProtectedRefPorts;

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

export async function findFinalizedProtectedRef(
  runtime: Pick<RepositoryRuntime, "state">,
  query: ProtectedRefFinalizedQuery,
): Promise<ProtectedRefFinalized | undefined> {
  return createDimJournalPort(runtime.state.database).findFinalizedExact(parseProtectedRefFinalizedQuery(query));
}

function livePortsAlreadyExclusive(context: RepositoryExtensionContext): DimPorts {
  const journal = createDimJournalPort(context.runtime.state.database);
  const authorities = new WeakMap<ProtectedRefTarget, AuthoritativeNativeRepositoryTarget>();
  return {
    runtime: { gitExecutable: context.runtime.gitExecutable, storageRoot: context.stateDirectory },
    gitIdentity: context.runtime.gitIdentity,
    serialization: { kind: "already-exclusive" },
    journal,
    targets: {
      async resolve(change) {
        const selector = toDimSelector(change);
        const authority = await resolveAuthoritativeNativeRepositoryTarget(context.runtime, selector);
        const target: ProtectedRefTarget = {
          selector: { namespaceId: change.namespaceId, repositoryId: change.repositoryId },
          repositoryPath: authority.repository,
          head: {
            sequence: authority.currentHead.sequence,
            protectedRef: authority.currentHead.protectedRef,
            commit: authority.currentHead.commit,
            tree: authority.currentHead.tree,
          },
          incarnationId: authority.imported.importNonce,
          authorityEpoch: context.runtime.expectedGenerationId,
          policyDigest: authority.imported.policyDigest,
          ownerPrincipalId: authority.imported.ownerHostId,
          refPolicyRevision: refUpdatePolicyRevision(authority.imported.policy, refUpdatePolicies(context.extensions)),
        };
        authorities.set(target, authority);
        return target;
      },
      async assertCurrent(target) {
        const authority = authorityForTarget(authorities, target);
        await assertAuthoritativeNativeRepositoryTargetCurrent({
          runtime: context.runtime,
          selector: { projectId: target.selector.namespaceId, repositoryId: target.selector.repositoryId, protectedRef: target.head.protectedRef },
          target: authority,
        });
        if (target.refPolicyRevision !== refUpdatePolicyRevision(authority.imported.policy, refUpdatePolicies(context.extensions))) throw new Error("DIM ref update policies changed after target resolution");
      },
      async locateForRecovery(intent) {
        return join(context.stateDirectory, intent.namespaceId, `${intent.repositoryId}.git`);
      },
    },
    policy: {
      async authorize({ change, target }) {
        return { refPolicyRevision: await checkRefUpdatePolicies(context, authorityForTarget(authorities, target), toDimChange(change)) };
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
    journal: createDimJournalPort(runtime.state.database),
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

function authorityForTarget(authorities: WeakMap<ProtectedRefTarget, AuthoritativeNativeRepositoryTarget>, target: ProtectedRefTarget): AuthoritativeNativeRepositoryTarget {
  const authority = authorities.get(target);
  if (authority === undefined) throw new Error("protected ref target was not resolved by this DIM authority adapter");
  return authority;
}
