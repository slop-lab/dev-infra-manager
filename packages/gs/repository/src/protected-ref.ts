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
  type ProtectedRefChange,
} from "./protected-ref-validation.js";

const execute = promisify(execFile);
export type { ProtectedRefChange } from "./protected-ref-validation.js";

export type ProtectedRefHead = {
  readonly sequence: number;
  readonly protectedRef: string;
  readonly commit: string;
  readonly tree: string;
};

export type ProtectedRefTarget<Fence, Authority = unknown> = {
  readonly selector: RepositorySelector;
  readonly repositoryPath: string;
  readonly head: ProtectedRefHead;
  readonly fence: Fence;
  readonly authority: Authority;
};

export type ProtectedRefIntent<Fence, Proof> = RepositorySelector & {
  readonly sequence: number;
  readonly protectedRef: string;
  readonly proposalRef: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly authorizationId: string;
  readonly evidenceDigest: string;
  readonly fence: Fence;
  readonly proof: Proof;
};

export type ProtectedRefReceipt = {
  readonly outcome: "promoted" | "already-current";
  readonly sequence: number;
};

type Awaitable<Value> = Value | Promise<Value>;

export interface TargetPort<Fence, Proof, Authority> {
  resolve(change: ProtectedRefChange): Promise<ProtectedRefTarget<Fence, Authority>>;
  assertCurrent(target: ProtectedRefTarget<Fence, Authority>): Promise<void>;
  locateForRecovery(intent: ProtectedRefIntent<Fence, Proof>): Promise<string>;
}

export interface JournalPort<Fence, Proof> {
  findFinalized(change: ProtectedRefChange, protectedRef: string): Awaitable<ProtectedRefIntent<Fence, Proof> | undefined>;
  appendIntent(intent: ProtectedRefIntent<Fence, Proof>): Awaitable<void>;
  finalize(intent: ProtectedRefIntent<Fence, Proof>): Awaitable<void>;
  cancel(intent: ProtectedRefIntent<Fence, Proof>): Awaitable<void>;
  pending(): Awaitable<readonly ProtectedRefIntent<Fence, Proof>[]>;
}

export interface PolicyPort<Fence, Proof, Authority> {
  authorize(input: {
    readonly change: ProtectedRefChange;
    readonly target: ProtectedRefTarget<Fence, Authority>;
  }): Promise<Proof>;
}

export type SerializationPort = {
  readonly kind: "exclusive";
  runExclusive<Result>(operation: () => Promise<Result>): Promise<Result>;
} | {
  readonly kind: "already-exclusive";
};

export type ProtectedRefPorts<Fence, Proof, Authority = unknown> = {
  readonly runtime: Pick<GitRepositoryRuntime, "gitExecutable" | "storageRoot">;
  readonly gitIdentity: GitExecutableIdentity;
  readonly targets: TargetPort<Fence, Proof, Authority>;
  readonly journal: JournalPort<Fence, Proof>;
  readonly policy: PolicyPort<Fence, Proof, Authority>;
  readonly serialization: SerializationPort;
};

export async function compareAndSwapProtectedRef<Fence, Proof, Authority>(
  ports: ProtectedRefPorts<Fence, Proof, Authority>,
  input: ProtectedRefChange,
): Promise<ProtectedRefReceipt> {
  const change = parseProtectedRefChange(input);
  return runExclusive(ports.serialization, () => compareAndSwapInTransaction(ports, change));
}

export async function recoverProtectedRefChanges<Fence, Proof, Authority>(ports: ProtectedRefPorts<Fence, Proof, Authority>): Promise<void> {
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

async function compareAndSwapInTransaction<Fence, Proof, Authority>(
  ports: ProtectedRefPorts<Fence, Proof, Authority>,
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
  await ports.targets.assertCurrent(target);
  await assertGitExecutableIdentity(ports.runtime.gitExecutable, ports.gitIdentity);
  const intent: ProtectedRefIntent<Fence, Proof> = {
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
    fence: target.fence,
    proof,
  };
  await ports.journal.appendIntent(intent);
  if (!await atomicPromote(ports.runtime, intent, change.expectedCommit, change.candidateCommit)) {
    throw new GitRepositoryError("protected ref compare-and-swap failed; recovery is required");
  }
  await ports.journal.finalize(intent);
  return { outcome: "promoted", sequence: intent.sequence };
}

async function retryReceipt<Fence, Proof>(
  journal: JournalPort<Fence, Proof>,
  change: ProtectedRefChange,
  target: ProtectedRefTarget<Fence, unknown>,
): Promise<ProtectedRefReceipt> {
  const previous = await journal.findFinalized(change, target.head.protectedRef);
  if (previous !== undefined) assertProtectedRefIntent(previous);
  if (previous !== undefined
    && previous.namespaceId === change.namespaceId
    && previous.repositoryId === change.repositoryId
    && previous.protectedRef === target.head.protectedRef
    && previous.proposalRef === change.proposalRef
    && previous.expectedCommit === change.expectedCommit
    && previous.candidateCommit === change.candidateCommit
    && previous.candidateTree === change.candidateTree
    && previous.authorizationId === change.authorizationId
    && previous.evidenceDigest === change.evidenceDigest
    && target.head.commit === change.candidateCommit) {
    return { outcome: "already-current", sequence: previous.sequence };
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
