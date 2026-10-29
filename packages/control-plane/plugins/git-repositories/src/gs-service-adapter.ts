import type {
  BorrowedRepositoryMutationAccess,
  BorrowedRepositoryMutationAuthority,
  BorrowedRepositoryReadAccess,
  BorrowedRepositoryReadAuthority,
  RepositoryAuthority,
  RepositoryAvailability,
  RepositoryMutationGate,
  RepositoryReadGate,
  RepositoryReadService,
  RepositoryTarget,
  RepositoryTargetSelector,
} from "@slop-lab/gs-repository-service";
import {
  assertAuthoritativeNativeRepositoryTargetCurrent,
  AuthoritativeRepositoryError,
  resolveAuthoritativeNativeRepositoryTarget,
  type AuthoritativeNativeRepositoryTarget,
} from "./authoritative-native-root-target.js";
import type { RepositoryExtensionContext } from "./plugin-api.js";
import { compareAndSwapProtectedRef } from "./repository-cas.js";
import { findFinalizedProtectedRef } from "./repository-cas.js";
import { readNativeProjectRegistrations } from "./native-bundle-state.js";
import { refUpdatePolicies, refUpdatePolicyRevision } from "./ref-update-policies.js";
import { createGsRepositoryReader } from "./gs-service-reader.js";

export type GsRepositoryServiceAdapter = {
  readonly authority: RepositoryAuthority;
  readonly readGate: RepositoryReadGate;
  readonly mutationGate: RepositoryMutationGate;
  readonly reader: RepositoryReadService;
  withBorrowedRead<Result>(
    selector: RepositoryTargetSelector,
    operation: (access: BorrowedRepositoryReadAccess) => Promise<Result>,
  ): Promise<Result>;
  withBorrowedMutation<Result>(
    selector: RepositoryTargetSelector,
    operation: (access: BorrowedRepositoryMutationAccess) => Promise<Result>,
  ): Promise<Result>;
};

export function createGsRepositoryServiceAdapter(context: RepositoryExtensionContext): GsRepositoryServiceAdapter {
  const targetProofs = new WeakMap<RepositoryTarget, AuthoritativeNativeRepositoryTarget>();
  const authority = createAuthority(context, targetProofs);
  const withBorrowedMutation = <Result>(
    selector: RepositoryTargetSelector,
    operation: (access: BorrowedRepositoryMutationAccess) => Promise<Result>,
  ): Promise<Result> => withBorrowed(authority, createBorrowedMutationAuthority, async (borrowed) => operation({
    authority: borrowed,
    target: await borrowed.resolve(selector),
  }));
  const withBorrowedRead = <Result>(
    selector: RepositoryTargetSelector,
    operation: (access: BorrowedRepositoryReadAccess) => Promise<Result>,
  ): Promise<Result> => withBorrowed(authority, createBorrowedReadAuthority, async (borrowed) => operation({
    authority: borrowed,
    target: await borrowed.resolve(selector),
  }));
  return {
    authority,
    readGate: {
      read: (selector, operation) => context.read(() => withBorrowedRead(selector, operation)),
    },
    mutationGate: {
      mutate: (selector, operation) => context.mutate(toDimSelector(selector), () => withBorrowedMutation(selector, operation)),
    },
    reader: createGsRepositoryReader(context, targetProofs),
    withBorrowedRead,
    withBorrowedMutation,
  };
}

function createAuthority(
  context: RepositoryExtensionContext,
  targetProofs: WeakMap<RepositoryTarget, AuthoritativeNativeRepositoryTarget>,
): RepositoryAuthority & { promote(change: Parameters<BorrowedRepositoryMutationAuthority["promote"]>[0]): ReturnType<BorrowedRepositoryMutationAuthority["promote"]> } {
  const authority = {
    get authorityEpoch() { return context.runtime.expectedGenerationId; },
    async resolve(selector: RepositoryTargetSelector): Promise<RepositoryTarget> {
      assertAvailable(context);
      const proof = await resolveAuthoritativeNativeRepositoryTarget(
        { ...context.runtime, authoritativeTargetProofs: new Map() },
        toDimSelector(selector),
      );
      const target = toGsTarget(context, proof);
      targetProofs.set(target, proof);
      return target;
    },
    async assertCurrent(target: RepositoryTarget): Promise<void> {
      assertAvailable(context);
      const proof = targetProofs.get(target);
      if (proof === undefined) throw new GsRepositoryAdapterError("repository target was not issued by this DIM adapter");
      await assertAuthoritativeNativeRepositoryTargetCurrent({
        runtime: { ...context.runtime, authoritativeTargetProofs: new Map() },
        selector: toDimSelector({ ...target.selector, protectedRef: target.head.protectedRef }),
        target: proof,
      });
      if (target.authorityEpoch !== context.runtime.expectedGenerationId
        || target.refPolicyRevision !== refUpdatePolicyRevision(proof.imported.policy, refUpdatePolicies(context.extensions))) {
        throw new GsRepositoryAdapterError("repository authority or selected policy changed");
      }
    },
    async list(namespace: { readonly namespaceId: string }): Promise<readonly RepositoryTarget[]> {
      const targets: RepositoryTarget[] = [];
      for (const selector of await authority.listSelectors(namespace)) targets.push(await authority.resolve(selector));
      return targets;
    },
    async listSelectors(namespace?: { readonly namespaceId: string }) {
      assertAvailable(context);
      return readNativeProjectRegistrations(context.runtime.state)
        .filter((entry) => namespace === undefined || entry.projectId === namespace.namespaceId)
        .map((entry) => ({ namespaceId: entry.projectId, repositoryId: entry.repositoryId }))
        .sort((left, right) => left.namespaceId.localeCompare(right.namespaceId)
          || left.repositoryId.localeCompare(right.repositoryId));
    },
    async availability(selector: RepositoryTargetSelector): Promise<RepositoryAvailability> {
      const exists = (await authority.listSelectors({ namespaceId: selector.namespaceId }))
        .some((entry) => entry.repositoryId === selector.repositoryId);
      if (!exists) return { kind: "not-found" };
      try {
        return { kind: "available", target: await authority.resolve(selector) };
      } catch (error) {
        if (error instanceof AuthoritativeRepositoryError && /recovery/i.test(error.message)) {
          return { kind: "recovery-required" };
        }
        throw error;
      }
    },
    findFinalized: (query: Parameters<RepositoryAuthority["findFinalized"]>[0]) => findFinalizedProtectedRef(context.runtime, query),
    promote: (change: Parameters<BorrowedRepositoryMutationAuthority["promote"]>[0]) => compareAndSwapProtectedRef(context, {
      projectId: change.namespaceId,
      repositoryId: change.repositoryId,
      ...(change.protectedRef === undefined ? {} : { protectedRef: change.protectedRef }),
      proposalRef: change.proposalRef,
      expectedCommit: change.expectedCommit,
      candidateCommit: change.candidateCommit,
      candidateTree: change.candidateTree,
      authorizationId: change.authorizationId,
      evidenceDigest: change.evidenceDigest,
    }),
  };
  return authority;
}

async function withBorrowed<Result, Authority extends BorrowedRepositoryReadAuthority>(
  authority: ReturnType<typeof createAuthority>,
  create: (
    authority: ReturnType<typeof createAuthority>,
    run: <Value>(request: () => Promise<Value>) => Promise<Value>,
  ) => Authority,
  operation: (borrowed: Authority) => Promise<Result>,
): Promise<Result> {
  let active = true;
  const pending = new Set<Promise<unknown>>();
  const run = <Value>(request: () => Promise<Value>): Promise<Value> => {
    if (!active) return Promise.reject(new GsRepositoryAdapterError("borrowed repository authority expired"));
    const result = request();
    pending.add(result);
    void result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
  };
  const borrowed = create(authority, run);
  try {
    return await operation(borrowed);
  } finally {
    active = false;
    await Promise.allSettled([...pending]);
  }
}

function createBorrowedReadAuthority(
  authority: ReturnType<typeof createAuthority>,
  run: <Value>(request: () => Promise<Value>) => Promise<Value>,
): BorrowedRepositoryReadAuthority {
  return {
    get authorityEpoch() { return authority.authorityEpoch; },
    resolve: (selector) => run(() => authority.resolve(selector)),
    assertCurrent: (target) => run(() => authority.assertCurrent(target)),
    list: (namespace) => run(() => authority.list(namespace)),
    listSelectors: (namespace) => run(() => authority.listSelectors(namespace)),
    availability: (selector) => run(() => authority.availability(selector)),
    findFinalized: (query) => run(() => authority.findFinalized(query)),
  };
}

function createBorrowedMutationAuthority(
  authority: ReturnType<typeof createAuthority>,
  run: <Value>(request: () => Promise<Value>) => Promise<Value>,
): BorrowedRepositoryMutationAuthority {
  return {
    ...createBorrowedReadAuthority(authority, run),
    promote: (change) => run(() => authority.promote(change)),
  };
}

function toGsTarget(context: RepositoryExtensionContext, proof: AuthoritativeNativeRepositoryTarget): RepositoryTarget {
  const policy = structuredClone(proof.imported.policy);
  freezeValue(policy);
  return {
    selector: { namespaceId: proof.imported.projectId, repositoryId: proof.imported.repositoryId },
    repositoryPath: proof.repository,
    head: {
      sequence: proof.currentHead.sequence,
      protectedRef: proof.currentHead.protectedRef,
      commit: proof.currentHead.commit,
      tree: proof.currentHead.tree,
    },
    incarnationId: proof.imported.importNonce,
    authorityEpoch: context.runtime.expectedGenerationId,
    policyDigest: proof.imported.policyDigest,
    ownerPrincipalId: proof.imported.ownerHostId,
    refPolicyRevision: refUpdatePolicyRevision(proof.imported.policy, refUpdatePolicies(context.extensions)),
    policy,
  };
}

function toDimSelector(selector: RepositoryTargetSelector): {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly protectedRef?: string;
} {
  return {
    projectId: selector.namespaceId,
    repositoryId: selector.repositoryId,
    ...(selector.protectedRef === undefined ? {} : { protectedRef: selector.protectedRef }),
  };
}

function assertAvailable(context: RepositoryExtensionContext): void {
  if (!context.available() || !context.runtime.activated()) {
    throw new GsRepositoryAdapterError("repository authority is unavailable");
  }
}

function freezeValue(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) freezeValue(nested);
  Object.freeze(value);
}

export class GsRepositoryAdapterError extends Error {
  readonly name = "GsRepositoryAdapterError";
}
