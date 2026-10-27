import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  compareAndSwapProtectedRef,
  recoverProtectedRefChanges,
  type ProtectedRefPorts,
} from "../../../../packages/gs/repository/src/protected-ref.js";
import { atomicPromote } from "../../../../packages/gs/repository/src/promotion-git.js";
import {
  cleanupRepositories,
  intentFor,
  memoryJournal,
  portsFor,
  ref,
  repositoryFixture,
  type Fence,
  type Proof,
} from "./protectedRefBoundaryFixture.js";

afterEach(cleanupRepositories);

it("persists intent before real Git CAS, revalidates the target, and returns the exact retry receipt", async () => {
  const fixture = await repositoryFixture();
  const events: string[] = [];
  const journal = memoryJournal(events);
  const ports = portsFor(fixture, journal, events);

  const first = await compareAndSwapProtectedRef(ports, fixture.change);
  const retry = await compareAndSwapProtectedRef(ports, fixture.change);

  expect(first).toEqual({ outcome: "promoted", sequence: 1 });
  expect(retry).toEqual({ outcome: "already-current", sequence: 1 });
  expect(events).toEqual([
    "exclusive", "authorize", "assert-current", "append:old", "finalize:new",
    "exclusive",
  ]);
  expect(await ref(fixture.repository, "refs/heads/main")).toBe(fixture.change.candidateCommit);
});

it.each([
  ["base", { expectedCommit: "f".repeat(40) }],
  ["proposal ref", { proposalRef: "refs/heads/proposals/other" }],
] as const)("rejects an accepted receipt as a retry when the %s differs", async (_case, altered) => {
  const fixture = await repositoryFixture();
  const events: string[] = [];
  const journal = memoryJournal(events);
  const ports = portsFor(fixture, journal, events);
  expect(await compareAndSwapProtectedRef(ports, fixture.change)).toEqual({ outcome: "promoted", sequence: 1 });
  events.length = 0;

  await expect(compareAndSwapProtectedRef(ports, { ...fixture.change, ...altered }))
    .rejects.toThrow(/head conflicts/);

  expect(events).toEqual(["exclusive"]);
  expect(journal.finalized()).toHaveLength(1);
  expect(await ref(fixture.repository, "refs/heads/main")).toBe(fixture.change.candidateCommit);
});

it.each([false, true])("recovery cancels an unapplied intent and finalizes only an already-applied real Git CAS (%s)", async (applied) => {
  const fixture = await repositoryFixture();
  const events: string[] = [];
  const journal = memoryJournal(events);
  const ports = portsFor(fixture, journal, events);
  const target = await ports.targets.resolve(fixture.change);
  const intent = intentFor(fixture.change, target);
  await journal.appendIntent(intent);
  if (applied) {
    expect(await atomicPromote(ports.runtime, intent, intent.expectedCommit, intent.candidateCommit)).toBe(true);
  }

  await recoverProtectedRefChanges(ports);

  expect(journal.pending()).toEqual([]);
  expect(events.at(-1)).toBe(applied ? "finalize:new" : "cancel:old");
  expect(await ref(fixture.repository, "refs/heads/main")).toBe(applied ? intent.candidateCommit : intent.expectedCommit);
});

it("rejects a journal's foreign repository receipt even when the candidate and authorization identifiers match", async () => {
  const fixture = await repositoryFixture(), events: string[] = [], journal = memoryJournal(events);
  const ports = portsFor(fixture, journal, events);
  await compareAndSwapProtectedRef(ports, fixture.change);
  const accepted = journal.finalized()[0];
  if (!accepted) throw new Error("accepted fixture receipt missing");
  const foreign: ProtectedRefPorts<Fence, Proof> = { ...ports,
    journal: { ...ports.journal, findFinalized: () => ({ ...accepted, namespaceId: "foreign" }) } };
  events.length = 0;
  await expect(compareAndSwapProtectedRef(foreign, fixture.change)).rejects.toThrow(/head conflicts/);
  expect(events).toEqual(["exclusive"]); expect(journal.finalized()).toHaveLength(1);
  expect(await ref(fixture.repository, "refs/heads/main")).toBe(fixture.change.candidateCommit);
});

it("rejects a recovery port path outside the pending intent selector before Git reads", async () => {
  const fixture = await repositoryFixture();
  const events: string[] = [];
  const journal = memoryJournal(events);
  const ports = portsFor(fixture, journal, events);
  const target = await ports.targets.resolve(fixture.change);
  const intent = intentFor(fixture.change, target);
  await journal.appendIntent(intent);
  events.length = 0;
  const mismatched: ProtectedRefPorts<Fence, Proof> = {
    ...ports,
    targets: {
      ...ports.targets,
      async locateForRecovery() { return join(fixture.storageRoot, "foreign", "main.git"); },
    },
  };

  await expect(recoverProtectedRefChanges(mismatched))
    .rejects.toThrow(/target does not match its intent/);

  expect(events).toEqual(["exclusive"]);
  expect(journal.pending()).toEqual([intent]);
  expect(await ref(fixture.repository, "refs/heads/main")).toBe(fixture.change.expectedCommit);
});

it("rejects a wrong candidate tree and a changed executable identity before intent persistence", async () => {
  const fixture = await repositoryFixture();
  const events: string[] = [];
  const journal = memoryJournal(events);
  const ports = portsFor(fixture, journal, events);

  await expect(compareAndSwapProtectedRef(ports, { ...fixture.change, candidateTree: "0".repeat(40) }))
    .rejects.toThrow(/candidate tree conflicts/);
  await expect(compareAndSwapProtectedRef({
    ...ports,
    gitIdentity: { ...fixture.gitIdentity, size: fixture.gitIdentity.size + 1n },
  }, fixture.change)).rejects.toThrow(/executable changed/);

  expect(journal.pending()).toEqual([]);
  expect(journal.finalized()).toEqual([]);
  expect(await ref(fixture.repository, "refs/heads/main")).toBe(fixture.change.expectedCommit);
});

it("revalidates the target after policy authorization and before persisting intent", async () => {
  const fixture = await repositoryFixture();
  const events: string[] = [];
  const journal = memoryJournal(events);
  const ports = portsFor(fixture, journal, events);
  const raced: ProtectedRefPorts<Fence, Proof> = {
    ...ports,
    policy: {
      async authorize({ change, target }) {
        expect(await atomicPromote(ports.runtime, {
          ...target.selector,
          protectedRef: target.head.protectedRef,
          proposalRef: change.proposalRef,
        }, change.expectedCommit, change.candidateCommit)).toBe(true);
        return { refPolicyRevision: "e".repeat(64) };
      },
    },
  };

  await expect(compareAndSwapProtectedRef(raced, fixture.change)).rejects.toThrow();

  expect(journal.pending()).toEqual([]);
  expect(journal.finalized()).toEqual([]);
  expect(await ref(fixture.repository, "refs/heads/main")).toBe(fixture.change.candidateCommit);
});

it.each([
  ["unsafe namespace", { namespaceId: "Tenant" }],
  ["invalid object ID", { expectedCommit: "0" }],
  ["invalid digest", { authorizationId: "A".repeat(64) }],
  ["unsafe proposal ref", { proposalRef: "refs/heads/proposals/bad..ref" }],
] as const)("rejects %s at the neutral boundary before target resolution", async (_case, invalid) => {
  const fixture = await repositoryFixture();
  const events: string[] = [];
  const journal = memoryJournal(events);
  const ports = portsFor(fixture, journal, events);

  await expect(compareAndSwapProtectedRef(ports, { ...fixture.change, ...invalid }))
    .rejects.toThrow();

  expect(events).toEqual([]);
  expect(journal.pending()).toEqual([]);
  expect(await ref(fixture.repository, "refs/heads/main")).toBe(fixture.change.expectedCommit);
});

it.each(["selector", "repository path"] as const)("rejects a target proof with a mismatched %s", async (mismatch) => {
  const fixture = await repositoryFixture();
  const events: string[] = [];
  const journal = memoryJournal(events);
  const ports = portsFor(fixture, journal, events);
  const originalTargets = ports.targets;
  const mismatched: ProtectedRefPorts<Fence, Proof> = {
    ...ports,
    targets: {
      ...originalTargets,
      async resolve(change) {
        const target = await originalTargets.resolve(change);
        return mismatch === "selector"
          ? { ...target, selector: { ...target.selector, namespaceId: "foreign" } }
          : { ...target, repositoryPath: join(fixture.storageRoot, "foreign", "main.git") };
      },
    },
  };

  await expect(compareAndSwapProtectedRef(mismatched, fixture.change))
    .rejects.toThrow(/target proof does not match/);

  expect(events).toEqual(["exclusive"]);
  expect(journal.pending()).toEqual([]);
  expect(await ref(fixture.repository, "refs/heads/main")).toBe(fixture.change.expectedCommit);
});
