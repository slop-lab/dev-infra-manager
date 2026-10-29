import { afterEach, expect, it } from "vitest";
import type {
  ProtectedRefFinalizedQuery,
  ProtectedRefTarget,
} from "../../../packages/gs/repository/src/index.js";
import { openRepositoryAuthority } from "../../../packages/gs/repository-service/src/index.js";
import {
  allowAllRefUpdatePolicies,
  authorityFixture,
  cleanupAuthorityFixtures,
} from "./fixture.js";

afterEach(cleanupAuthorityFixtures);

it("returns an exact finalized intent and receipt through normal and borrowed read authorities across restart", async () => {
  const fixture = await authorityFixture();
  const options = {
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: allowAllRefUpdatePolicies(),
    policySectionOwners: [],
  };
  const authority = await openRepositoryAuthority(options);
  const target = await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  const query = finalizedQuery(fixture.change, target);
  expect(await authority.findFinalized(query)).toBeUndefined();
  await authority.promote(fixture.change);
  const finalized = await authority.findFinalized(query);
  expect(finalized).toEqual({
    intent: { ...query, sequence: 1 },
    receipt: { outcome: "promoted", sequence: 1 },
  });
  await authority.read(fixture.selector, async ({ authority: borrowed }) => {
    expect(await borrowed.findFinalized(query)).toEqual(finalized);
  });
  await authority.mutate(fixture.selector, async ({ authority: borrowed }) => {
    expect(await borrowed.findFinalized(query)).toEqual(finalized);
  });
  expect(await authority.findFinalized({ ...query, evidenceDigest: "d".repeat(64) })).toBeUndefined();
  await authority.close();

  const restarted = await openRepositoryAuthority(options);
  try {
    expect(await restarted.findFinalized(query)).toEqual(finalized);
  } finally {
    await restarted.close();
  }
});

it("recovers a post-CAS crash and exposes the original finalized receipt without authorization replay", async () => {
  const fixture = await authorityFixture({ wrappedGit: true });
  const options = {
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: allowAllRefUpdatePolicies(),
    policySectionOwners: [],
  };
  const authority = await openRepositoryAuthority(options);
  const target = await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  const query = finalizedQuery(fixture.change, target);
  await fixture.setGitMode("after");
  await expect(authority.promote(fixture.change)).rejects.toThrow(/recovery is required/i);
  await authority.close();
  await fixture.setGitMode("pass");

  const recovered = await openRepositoryAuthority(options);
  try {
    expect(await recovered.findFinalized(query)).toEqual({
      intent: { ...query, sequence: 1 },
      receipt: { outcome: "promoted", sequence: 1 },
    });
  } finally {
    await recovered.close();
  }
});

function finalizedQuery(
  change: Awaited<ReturnType<typeof authorityFixture>>["change"],
  target: ProtectedRefTarget,
): ProtectedRefFinalizedQuery {
  return {
    ...change,
    protectedRef: target.head.protectedRef,
    expectedTree: target.head.tree,
    incarnationId: target.incarnationId,
    authorityEpoch: target.authorityEpoch,
    policyDigest: target.policyDigest,
    ownerPrincipalId: target.ownerPrincipalId,
    refPolicyRevision: target.refPolicyRevision,
  };
}
