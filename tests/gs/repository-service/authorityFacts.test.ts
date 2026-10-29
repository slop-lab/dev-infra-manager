import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { repositoryPolicyRevision } from "../../../packages/gs/repository-contracts/src/index.js";
import {
  openRepositoryAuthority,
  repositoryPolicyDigest,
} from "../../../packages/gs/repository-service/src/index.js";
import {
  allowAllRefUpdatePolicies,
  authorityFixture,
  cleanupAuthorityFixtures,
} from "./fixture.js";

afterEach(cleanupAuthorityFixtures);

it("exposes cheap selector and epoch facts plus immutable effective-policy targets", async () => {
  const fixture = await authorityFixture();
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: allowAllRefUpdatePolicies(),
    policySectionOwners: [{ sectionName: "review", enforcement: "configuration", parse: (value: unknown) => value }],
  });
  try {
    await authority.registerRepository({
      selector: fixture.selector,
      ownerPrincipalId: "repository-owner",
      policy: fixture.policy,
      branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
    });
    expect(await authority.listSelectors()).toEqual([fixture.selector]);
    expect(await authority.listSelectors({ namespaceId: "tenant" })).toEqual([fixture.selector]);
    expect(await authority.listSelectors({ namespaceId: "foreign" })).toEqual([]);
    const target = await authority.resolve(fixture.selector);
    expect(target.authorityEpoch).toBe(authority.authorityEpoch);
    expect(target.policy).toEqual(fixture.policy);
    expect(target.policyDigest).toBe(repositoryPolicyDigest(target.policy));
    expect(Object.isFrozen(target.policy)).toBe(true);
    expect(Object.isFrozen(target.policy.extensions)).toBe(true);
    expect(Reflect.set(target.policy.extensions, "changed", true)).toBe(false);
    await authority.exclusive(async (borrowed) => {
      expect(borrowed.authorityEpoch).toBe(authority.authorityEpoch);
      expect(await borrowed.listSelectors()).toEqual([fixture.selector]);
      expect((await borrowed.list({ namespaceId: "tenant" }))[0]?.policy).toEqual(fixture.policy);
    });

    const replacementBase = {
      schemaVersion: 1 as const,
      protectedRef: "refs/heads/main",
      extensions: { review: { required: true } },
    };
    const replacement = { ...replacementBase, policyRevision: repositoryPolicyRevision(replacementBase) };
    const current = await authority.replacePolicy({
      selector: fixture.selector,
      expectedPolicyDigest: target.policyDigest,
      expectedProtectedHead: target.head.commit,
      policy: replacement,
    });
    expect(target.policy).toEqual(fixture.policy);
    expect(current.policy).toEqual(replacement);
    await expect(authority.assertCurrent(target)).rejects.toThrow(/policy/i);

    await writeFile(join(fixture.repository, "hooks", "pre-receive"), "tampered\n");
    expect(await authority.listSelectors()).toEqual([fixture.selector]);
    await expect(authority.resolve(fixture.selector)).rejects.toThrow(/hook/i);
  } finally {
    await authority.close();
  }
});
