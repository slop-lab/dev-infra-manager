import { afterEach, expect, it } from "vitest";
import {
  openRepositoryAuthority,
  type RefUpdatePolicy,
} from "../../../packages/gs/repository-service/src/index.js";
import { authorityFixture, cleanupAuthorityFixtures, ref } from "./fixture.js";

afterEach(cleanupAuthorityFixtures);

it("rejects stale targets and promotion when a selected provider revision changes", async () => {
  const fixture = await authorityFixture();
  let revision = "c".repeat(64);
  let changeDuringAuthorization = false;
  const provider: RefUpdatePolicy = {
    name: "review",
    get revision() { return revision; },
    async authorize() {
      if (changeDuringAuthorization) revision = "e".repeat(64);
    },
  };
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: [provider],
  });
  try {
    await authority.registerRepository({
      selector: fixture.selector,
      ownerPrincipalId: "repository-owner",
      policy: fixture.policy,
      branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
    });
    const stale = await authority.resolve(fixture.selector);
    revision = "d".repeat(64);
    await expect(authority.assertCurrent(stale)).rejects.toThrow(/ref-update polic/i);
    revision = "c".repeat(64);
    changeDuringAuthorization = true;
    await expect(authority.promote(fixture.change)).rejects.toThrow(/changed during authorization/i);
    expect(await ref(fixture.repository, "refs/heads/main")).toBe(fixture.change.expectedCommit);
    revision = "c".repeat(64);
    expect(await authority.availability(fixture.selector)).toMatchObject({ kind: "available" });
  } finally {
    await authority.close();
  }
});

it("stops new admissions before draining queued and borrowed work during close", async () => {
  const fixture = await authorityFixture();
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: [allowAllPolicy()],
  });
  await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  const running = authority.exclusive(async (borrowed) => {
    entered.resolve(undefined);
    await release.promise;
    return borrowed.resolve(fixture.selector);
  });
  await entered.promise;
  const queued = authority.resolve(fixture.selector);
  const closing = authority.close();
  await expect(authority.resolve(fixture.selector)).rejects.toThrow(/closing|closed/i);
  release.resolve(undefined);
  await expect(running).resolves.toMatchObject({ ownerPrincipalId: "repository-owner" });
  await expect(queued).resolves.toMatchObject({ ownerPrincipalId: "repository-owner" });
  await expect(closing).resolves.toBeUndefined();
  await expect(authority.promote(fixture.change)).rejects.toThrow(/closing|closed/i);
});

function allowAllPolicy(): RefUpdatePolicy {
  return { name: "allow-all", revision: "f".repeat(64), async authorize() {} };
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
