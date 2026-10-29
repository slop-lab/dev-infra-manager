import { afterEach, expect, it } from "vitest";
import {
  openRepositoryAuthority,
  type BorrowedRepositoryReadAuthority,
} from "../../../packages/gs/repository-service/src/index.js";
import {
  allowAllRefUpdatePolicies,
  authorityFixture,
  cleanupAuthorityFixtures,
} from "./fixture.js";

afterEach(cleanupAuthorityFixtures);

it("keeps reads least-privileged and outside the global mutation barrier", async () => {
  const fixture = await authorityFixture();
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: allowAllRefUpdatePolicies(),
  });
  await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  const mutation = authority.exclusive(async () => {
    entered.resolve(undefined);
    await release.promise;
  });
  await entered.promise;
  let escaped: BorrowedRepositoryReadAuthority | undefined;
  try {
    const target = await bounded(authority.read(fixture.selector, async ({ authority: borrowed, target: initial }) => {
      escaped = borrowed;
      expect("promote" in borrowed).toBe(false);
      expect(borrowed.authorityEpoch).toBe(authority.authorityEpoch);
      expect(await borrowed.listSelectors()).toEqual([fixture.selector]);
      const resolved = await borrowed.resolve(fixture.selector);
      expect(resolved).toEqual(initial);
      await borrowed.assertCurrent(resolved);
      return resolved;
    }));
    expect(target.selector).toEqual(fixture.selector);
  } finally {
    release.resolve(undefined);
    await mutation;
  }
  try {
    if (escaped === undefined) throw new Error("borrowed read authority was not issued");
    await expect(escaped.resolve(fixture.selector)).rejects.toThrow(/expired/i);
  } catch (error) {
    await authority.close();
    throw error;
  }
  const readEntered = deferred<void>();
  const readRelease = deferred<void>();
  const activeRead = authority.read(fixture.selector, async ({ target }) => {
    readEntered.resolve(undefined);
    await readRelease.promise;
    return target;
  });
  await readEntered.promise;
  const closing = authority.close();
  let closeFinished = false;
  void closing.then(() => { closeFinished = true; });
  await expect(authority.read(fixture.selector, async ({ target }) => target)).rejects.toThrow(/closing|closed/i);
  await Promise.resolve();
  expect(closeFinished).toBe(false);
  readRelease.resolve(undefined);
  await expect(activeRead).resolves.toMatchObject({ selector: fixture.selector });
  await closing;
  expect(closeFinished).toBe(true);
});

async function bounded<Result>(operation: Promise<Result>): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("repository read waited for the mutation barrier")), 2_000);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
