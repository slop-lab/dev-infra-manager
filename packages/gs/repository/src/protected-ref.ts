import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertGitExecutableIdentity,
  GitRepositoryError,
  type GitExecutableIdentity,
  type GitRepositoryRuntime,
  type RepositorySelector,
} from "./repository.js";
import { atomicPromote, candidateDescendsFrom } from "./promotion-git.js";
import {
  assertProtectedRefIntent,
  assertRecoveryPath,
  assertTargetBinding,
  parseProtectedRefChange,
  parseProtectedRefFinalizedQuery,
  type ProtectedRefChange,
} from "./protected-ref-validation.js";
import {
  createProtectedRefFinalizedQuery,
  type ProtectedRefFinalized,
  type ProtectedRefFinalizedQuery,
} from "./protected-ref-finalized.js";

const execute = promisify(execFile);
export type { ProtectedRefChange } from "./protected-ref-validation.js";
export { parseProtectedRefFinalizedQuery };
export type { ProtectedRefFinalized, ProtectedRefFinalizedQuery } from "./protected-ref-finalized.js";
export { createProtectedRefFinalizedQuery };
export { finalizedProtectedRef, protectedRefIntentMatchesQuery } from "./protected-ref-finalized.js";

export type ProtectedRefHead = {
  readonly sequence: number;
  readonly protectedRef: string;
  readonly commit: string;
  readonly tree: string;
};

export type ProtectedRefTarget = {
  readonly selector: RepositorySelector;
  readonly repositoryPath: string;
  readonly head: ProtectedRefHead;
  readonly incarnationId: string;
  readonly authorityEpoch: string;
  readonly policyDigest: string;
  readonly ownerPrincipalId: string;
  readonly refPolicyRevision: string;
};

export type ProtectedRefIntent = RepositorySelector & {
  readonly sequence: number;
  readonly protectedRef: string;
  readonly proposalRef: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly authorizationId: string;
  readonly evidenceDigest: string;
  readonly incarnationId: string;
  readonly authorityEpoch: string;
  readonly policyDigest: string;
  readonly ownerPrincipalId: string;
  readonly refPolicyRevision: string;
};

export type ProtectedRefReceipt = {
  readonly outcome: "promoted" | "already-current";
  readonly sequence: number;
};

type Awaitable<Value> = Value | Promise<Value>;

export interface TargetPort {
  resolve(change: ProtectedRefChange): Promise<ProtectedRefTarget>;
  assertCurrent(target: ProtectedRefTarget): Promise<void>;
  locateForRecovery(intent: ProtectedRefIntent): Promise<string>;
}

export interface JournalPort {
  findFinalized(change: ProtectedRefChange, protectedRef: string): Awaitable<ProtectedRefFinalized | undefined>;
  findFinalizedExact(query: ProtectedRefFinalizedQuery): Awaitable<ProtectedRefFinalized | undefined>;
  appendIntent(intent: ProtectedRefIntent): Awaitable<void>;
  finalize(intent: ProtectedRefIntent): Awaitable<void>;
  cancel(intent: ProtectedRefIntent): Awaitable<void>;
  pending(): Awaitable<readonly ProtectedRefIntent[]>;
}

export interface PolicyPort {
  authorize(input: {
    readonly change: ProtectedRefChange;
    readonly target: ProtectedRefTarget;
  }): Promise<{ readonly refPolicyRevision: string }>;
}

export type SerializationPort = {
  readonly kind: "exclusive";
  runExclusive<Result>(operation: () => Promise<Result>): Promise<Result>;
} | {
  readonly kind: "already-exclusive";
};

export type ProtectedRefPorts = {
  readonly runtime: Pick<GitRepositoryRuntime, "gitExecutable" | "storageRoot">;
  readonly gitIdentity: GitExecutableIdentity;
  readonly targets: TargetPort;
  readonly journal: JournalPort;
  readonly policy: PolicyPort;
  readonly serialization: SerializationPort;
};

export async function compareAndSwapProtectedRef(
  ports: ProtectedRefPorts,
  input: ProtectedRefChange,
): Promise<ProtectedRefReceipt> {
  const change = parseProtectedRefChange(input);
  return runExclusive(ports.serialization, () => compareAndSwapInTransaction(ports, change));
}

export async function recoverProtectedRefChanges(ports: ProtectedRefPorts): Promise<void> {
  await runExclusive(ports.serialization, async () => {
    for (const intent of await ports.journal.pending()) {
      assertProtectedRefIntent(intent);
      await assertGitExecutableIdentity(ports.runtime.gitExecutable, ports.gitIdentity);
      const repositoryPath = await ports.targets.locateForRecovery(intent);
      assertRecoveryPath(ports.runtime, intent, repositoryPath);
      const tree = await readCommitTree(ports.runtime.gitExecutable, repositoryPath, intent.candidateCommit);
      const descends = await candidateDescendsFrom(ports.runtime, intent, intent.expectedCommit, intent.candidateCommit);
      if (tree !== intent.candidateTree || !descends) throw new GitRepositoryError("pending repository ref candidate is invalid");
      const current = await readProtectedRef(ports.runtime.gitExecutable, repositoryPath, intent.protectedRef);
      if (current === intent.expectedCommit) await ports.journal.cancel(intent);
      else if (current === intent.candidateCommit) await ports.journal.finalize(intent);
      else throw new GitRepositoryError("pending repository ref change conflicts with Git state");
    }
  });
}

async function compareAndSwapInTransaction(
  ports: ProtectedRefPorts,
  change: ProtectedRefChange,
): Promise<ProtectedRefReceipt> {
  const target = await ports.targets.resolve(change);
  assertTargetBinding(ports.runtime, change, target);
  if (change.proposalRef === target.head.protectedRef) throw new GitRepositoryError("protected ref source and target must differ");
  if (target.head.commit !== change.expectedCommit) return retryReceipt(ports.journal, change, target);
  if (!await candidateDescendsFrom(ports.runtime, change, change.expectedCommit, change.candidateCommit)) {
    throw new GitRepositoryError("protected ref candidate does not descend from the current head");
  }
  await assertGitExecutableIdentity(ports.runtime.gitExecutable, ports.gitIdentity);
  const tree = await readCommitTree(ports.runtime.gitExecutable, target.repositoryPath, change.candidateCommit);
  if (tree !== change.candidateTree) throw new GitRepositoryError("protected ref candidate tree conflicts");
  const proof = await ports.policy.authorize({ change, target });
  if (proof.refPolicyRevision !== target.refPolicyRevision) {
    throw new GitRepositoryError("protected ref update policy changed during authorization");
  }
  await ports.targets.assertCurrent(target);
  await assertGitExecutableIdentity(ports.runtime.gitExecutable, ports.gitIdentity);
  const intent: ProtectedRefIntent = {
    namespaceId: change.namespaceId,
    repositoryId: change.repositoryId,
    sequence: target.head.sequence + 1,
    protectedRef: target.head.protectedRef,
    proposalRef: change.proposalRef,
    expectedCommit: change.expectedCommit,
    expectedTree: target.head.tree,
    candidateCommit: change.candidateCommit,
    candidateTree: change.candidateTree,
    authorizationId: change.authorizationId,
    evidenceDigest: change.evidenceDigest,
    incarnationId: target.incarnationId,
    authorityEpoch: target.authorityEpoch,
    policyDigest: target.policyDigest,
    ownerPrincipalId: target.ownerPrincipalId,
    refPolicyRevision: proof.refPolicyRevision,
  };
  await ports.journal.appendIntent(intent);
  if (!await atomicPromote(ports.runtime, intent, change.expectedCommit, change.candidateCommit)) {
    throw new GitRepositoryError("protected ref compare-and-swap failed; recovery is required");
  }
  await ports.journal.finalize(intent);
  return { outcome: "promoted", sequence: intent.sequence };
}

async function retryReceipt(
  journal: JournalPort,
  change: ProtectedRefChange,
  target: ProtectedRefTarget,
): Promise<ProtectedRefReceipt> {
  const previous = await journal.findFinalized(change, target.head.protectedRef);
  if (previous !== undefined) assertProtectedRefIntent(previous.intent);
  if (previous !== undefined
    && previous.intent.namespaceId === change.namespaceId
    && previous.intent.repositoryId === change.repositoryId
    && previous.intent.protectedRef === target.head.protectedRef
    && previous.intent.proposalRef === change.proposalRef
    && previous.intent.expectedCommit === change.expectedCommit
    && previous.intent.candidateCommit === change.candidateCommit
    && previous.intent.candidateTree === change.candidateTree
    && previous.intent.authorizationId === change.authorizationId
    && previous.intent.evidenceDigest === change.evidenceDigest
    && target.head.commit === change.candidateCommit) {
    return { outcome: "already-current", sequence: previous.receipt.sequence };
  }
  throw new GitRepositoryError("protected ref compare-and-swap head conflicts");
}

async function runExclusive<Result>(serialization: SerializationPort, operation: () => Promise<Result>): Promise<Result> {
  switch (serialization.kind) {
    case "exclusive": return serialization.runExclusive(operation);
    case "already-exclusive": return operation();
  }
}

async function readCommitTree(gitExecutable: string, repositoryPath: string, commit: string): Promise<string> {
  const result = await execute(gitExecutable, ["--no-replace-objects", "--git-dir", repositoryPath, "rev-parse", "--verify", `${commit}^{tree}`], gitOptions());
  return result.stdout.trim();
}

async function readProtectedRef(gitExecutable: string, repositoryPath: string, protectedRef: string): Promise<string> {
  const result = await execute(gitExecutable, ["--no-replace-objects", "--git-dir", repositoryPath, "rev-parse", "--verify", protectedRef], gitOptions());
  return result.stdout.trim();
}

function gitOptions(): { readonly env: NodeJS.ProcessEnv; readonly maxBuffer: number; readonly timeout: number } {
  return {
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", HOME: "/dev/null", LC_ALL: "C" },
    maxBuffer: 1024,
    timeout: 30_000,
  };
}
