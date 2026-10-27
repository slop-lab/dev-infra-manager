import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import type {
  JournalPort,
  ProtectedRefChange,
  ProtectedRefIntent,
  ProtectedRefPorts,
  ProtectedRefTarget,
} from "../../../../packages/gs/repository/src/protected-ref.js";
import { assertGitVersion } from "../../../../packages/gs/repository/src/repository.js";

const execute = promisify(execFile);
const cleanup: string[] = [];
const selector = { namespaceId: "tenant", repositoryId: "main" } as const;

export type Fence = { readonly generationId: string; readonly importNonce: string; readonly policyDigest: string };
export type Proof = { readonly refPolicyRevision: string };
type Intent = ProtectedRefIntent<Fence, Proof>;

export async function cleanupRepositories(): Promise<void> {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export async function repositoryFixture(): Promise<{
  readonly root: string;
  readonly storageRoot: string;
  readonly repository: string;
  readonly gitIdentity: Awaited<ReturnType<typeof assertGitVersion>>;
  readonly change: ProtectedRefChange;
}> {
  const root = await mkdtemp(join(tmpdir(), "gs-protected-ref-"));
  cleanup.push(root);
  const storageRoot = join(root, "storage");
  const repository = join(storageRoot, selector.namespaceId, `${selector.repositoryId}.git`);
  const source = join(root, "source");
  await mkdir(join(storageRoot, selector.namespaceId), { recursive: true });
  await git(["init", "--bare", repository]);
  await git(["init", source]);
  await git(["-C", source, "config", "user.name", "Test"]);
  await git(["-C", source, "config", "user.email", "test@example.invalid"]);
  await writeFile(join(source, "README.md"), "old\n");
  await git(["-C", source, "add", "README.md"]);
  await git(["-C", source, "commit", "-m", "initial"]);
  const expectedCommit = await revParse(source, "HEAD");
  await git(["-C", source, "remote", "add", "origin", repository]);
  await git(["-C", source, "push", "origin", "HEAD:refs/heads/main"]);
  await writeFile(join(source, "README.md"), "new\n");
  await git(["-C", source, "commit", "-am", "candidate"]);
  const candidateCommit = await revParse(source, "HEAD");
  const candidateTree = await revParse(source, "HEAD^{tree}");
  const proposalRef = "refs/heads/proposals/change";
  await git(["-C", source, "push", "origin", `HEAD:${proposalRef}`]);
  const version = (await git(["--version"])).replace(/^git version /, "");
  return {
    root,
    storageRoot,
    repository,
    gitIdentity: await assertGitVersion({ gitExecutable: "/usr/bin/git", gitVersion: version }),
    change: {
      ...selector,
      proposalRef,
      expectedCommit,
      candidateCommit,
      candidateTree,
      authorizationId: "a".repeat(64),
      evidenceDigest: "b".repeat(64),
    },
  };
}

export function portsFor(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  journal: ReturnType<typeof memoryJournal>,
  events: string[],
): ProtectedRefPorts<Fence, Proof> {
  const fence = { generationId: "c".repeat(64), importNonce: "00000000-0000-4000-8000-000000000001", policyDigest: "d".repeat(64) };
  return {
    runtime: { gitExecutable: "/usr/bin/git", storageRoot: fixture.storageRoot },
    gitIdentity: fixture.gitIdentity,
    serialization: { kind: "exclusive", async runExclusive(operation) { events.push("exclusive"); return operation(); } },
    journal,
    policy: { async authorize() { events.push("authorize"); return { refPolicyRevision: "e".repeat(64) }; } },
    targets: {
      async resolve(change) {
        const protectedRef = change.protectedRef ?? "refs/heads/main";
        return {
          selector,
          repositoryPath: fixture.repository,
          head: { sequence: journal.finalized().length, protectedRef, commit: await ref(fixture.repository, protectedRef), tree: await commitTree(fixture.repository, await ref(fixture.repository, protectedRef)) },
          fence,
          authority: undefined,
        };
      },
      async assertCurrent(target) {
        events.push("assert-current");
        expect(await ref(fixture.repository, target.head.protectedRef)).toBe(target.head.commit);
      },
      async locateForRecovery() { return fixture.repository; },
    },
  };
}

export function memoryJournal(events: string[]): JournalPort<Fence, Proof> & { finalized(): readonly Intent[] } {
  const pending: Intent[] = [];
  const finalized: Intent[] = [];
  return {
    findFinalized(change, protectedRef) {
      return finalized.find((intent) => intent.namespaceId === change.namespaceId
        && intent.repositoryId === change.repositoryId
        && intent.authorizationId === change.authorizationId
        && intent.protectedRef === protectedRef);
    },
    appendIntent(intent) { events.push("append:old"); pending.push(intent); },
    finalize(intent) { events.push("finalize:new"); pending.splice(pending.indexOf(intent), 1); finalized.push(intent); },
    cancel(intent) { events.push("cancel:old"); pending.splice(pending.indexOf(intent), 1); },
    pending: () => pending,
    finalized: () => finalized,
  };
}

export function intentFor(change: ProtectedRefChange, target: ProtectedRefTarget<Fence>): Intent {
  return {
    namespaceId: change.namespaceId,
    repositoryId: change.repositoryId,
    sequence: 1,
    protectedRef: target.head.protectedRef,
    proposalRef: change.proposalRef,
    expectedCommit: change.expectedCommit,
    expectedTree: target.head.tree,
    candidateCommit: change.candidateCommit,
    candidateTree: change.candidateTree,
    authorizationId: change.authorizationId,
    evidenceDigest: change.evidenceDigest,
    fence: target.fence,
    proof: { refPolicyRevision: "e".repeat(64) },
  };
}

export async function ref(repository: string, name: string): Promise<string> {
  return git(["--git-dir", repository, "rev-parse", "--verify", name]);
}

async function git(args: readonly string[]): Promise<string> {
  return (await execute("/usr/bin/git", args, { env: { ...process.env, LC_ALL: "C" } })).stdout.trim();
}

async function revParse(repository: string, expression: string): Promise<string> {
  return git(["-C", repository, "rev-parse", expression]);
}

async function commitTree(repository: string, commit: string): Promise<string> {
  return git(["--git-dir", repository, "rev-parse", "--verify", `${commit}^{tree}`]);
}
