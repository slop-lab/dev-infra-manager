import { expect, it } from "vitest";
import {
  BorrowedRepositoryMutationAuthorityHandle,
  BorrowedRepositoryReadAuthorityHandle,
  type BorrowedReadOperations,
} from "../../../packages/gs/repository-service/src/borrowed-authority.js";
import type { RepositoryTarget } from "../../../packages/gs/repository-service/src/index.js";

const selector = { namespaceId: "tenant", repositoryId: "main" } as const;
const target: RepositoryTarget = {
  selector,
  repositoryPath: "/storage/tenant/main.git",
  head: { sequence: 0, protectedRef: "refs/heads/main", commit: "a".repeat(40), tree: "b".repeat(40) },
  incarnationId: "00000000-0000-4000-8000-000000000001",
  authorityEpoch: "c".repeat(64),
  policyDigest: "d".repeat(64),
  ownerPrincipalId: "repository-owner",
  refPolicyRevision: "e".repeat(64),
  policy: { schemaVersion: 1, protectedRef: "refs/heads/main", policyRevision: "f".repeat(64), extensions: {} },
};

it("revokes escaped read admission immediately while an already-started read drains", async () => {
  const slow = deferred<RepositoryTarget>();
  const handle = new BorrowedRepositoryReadAuthorityHandle(readOperations(() => slow.promise));
  const started = handle.resolve(selector);
  let drained = false;
  const draining = handle.drainAndRevoke().then(() => { drained = true; });
  const escaped = handle.resolve(selector);
  let rejected = false;
  void escaped.catch(() => { rejected = true; });
  await Promise.resolve();

  expect(rejected).toBe(true);
  expect(drained).toBe(false);
  slow.resolve(target);
  await expect(started).resolves.toBe(target);
  await draining;
});

it("revokes escaped promotion admission immediately while an already-started promotion drains", async () => {
  const slow = deferred<{ readonly outcome: "promoted"; readonly sequence: number }>();
  const handle = new BorrowedRepositoryMutationAuthorityHandle({
    ...readOperations(async () => target),
    promote: () => slow.promise,
  });
  const change = {
    ...selector,
    proposalRef: "refs/heads/proposals/change",
    expectedCommit: "a".repeat(40),
    candidateCommit: "b".repeat(40),
    candidateTree: "c".repeat(40),
    authorizationId: "d".repeat(64),
    evidenceDigest: "e".repeat(64),
  };
  const started = handle.promote(change);
  let drained = false;
  const draining = handle.drainAndRevoke().then(() => { drained = true; });
  const escaped = handle.promote(change);
  let rejected = false;
  void escaped.catch(() => { rejected = true; });
  await Promise.resolve();

  expect(rejected).toBe(true);
  expect(drained).toBe(false);
  slow.resolve({ outcome: "promoted", sequence: 1 });
  await expect(started).resolves.toEqual({ outcome: "promoted", sequence: 1 });
  await draining;
});

function readOperations(resolve: BorrowedReadOperations["resolve"]): BorrowedReadOperations {
  return {
    authorityEpoch: target.authorityEpoch,
    resolve,
    async assertCurrent() {},
    async list() { return [target]; },
    async listSelectors() { return [selector]; },
    async availability() { return { kind: "available", target }; },
    async findFinalized() { return undefined; },
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("deferred resolver is unavailable");
      resolvePromise(value);
    },
  };
}
