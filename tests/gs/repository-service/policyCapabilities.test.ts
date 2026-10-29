import { afterEach, expect, it } from "vitest";
import { repositoryPolicyRevision, type RepositoryPolicy } from "../../../packages/gs/repository-contracts/src/index.js";
import {
  openRepositoryAuthority,
  type BorrowedRepositoryReadAuthority,
  type PolicySectionOwner,
  type RefUpdatePolicy,
} from "../../../packages/gs/repository-service/src/index.js";
import { addAuthorityRepository, authorityFixture, cleanupAuthorityFixtures } from "./fixture.js";

afterEach(cleanupAuthorityFixtures);

it("requires an explicitly selected authorizer for bare-policy promotion", async () => {
  const fixture = await authorityFixture();
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: [],
    policySectionOwners: [],
  });
  try {
    await authority.registerRepository({
      selector: fixture.selector,
      ownerPrincipalId: "repository-owner",
      policy: fixture.policy,
      branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
    });
    await expect(authority.promote(fixture.change)).rejects.toThrow(/selected ref-update provider|authorizer/i);
  } finally {
    await authority.close();
  }
});

it.each([
  ["unowned", []],
  ["authorization-owner-without-provider", [{ sectionName: "code-review", enforcement: "authorization", parse: (value: unknown) => value }]],
] as const)("rejects a declared policy section when its required capability is %s", async (_case, policySectionOwners) => {
  const fixture = await authorityFixture();
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: [],
    policySectionOwners,
  });
  try {
    await expect(authority.registerRepository({
      selector: fixture.selector,
      ownerPrincipalId: "repository-owner",
      policy: policyWith("code-review", {}),
      branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
    })).rejects.toThrow(/policy.*provider|owner.*provider/i);
  } finally {
    await authority.close();
  }
});

it("accepts a configuration-only policy owner and rejects replacement with an unowned section", async () => {
  const fixture = await authorityFixture();
  const syncOwner: PolicySectionOwner<Readonly<{ readonly upstream: string }>> = {
    sectionName: "git-sync",
    enforcement: "configuration",
    parse(value) {
      if (!isRecord(value) || typeof value.upstream !== "string") throw new Error("git-sync policy is invalid");
      return Object.freeze({ upstream: value.upstream });
    },
  };
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: [],
    policySectionOwners: [syncOwner],
  });
  try {
    const target = await authority.registerRepository({
      selector: fixture.selector,
      ownerPrincipalId: "repository-owner",
      policy: policyWith("git-sync", { upstream: "origin" }),
      branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
    });
    await expect(authority.replacePolicy({
      selector: fixture.selector,
      expectedPolicyDigest: target.policyDigest,
      expectedProtectedHead: target.head.commit,
      policy: policyWith("missing", {}),
    })).rejects.toThrow(/policy.*owner|provider/i);
  } finally {
    await authority.close();
  }
});

it("passes a scoped borrowed read authority to selected providers and rejects missing providers on restart", async () => {
  const fixture = await authorityFixture();
  const dependency = await addAuthorityRepository(fixture, "dependency");
  let borrowed: BorrowedRepositoryReadAuthority | undefined;
  const provider: RefUpdatePolicy = {
    name: "code-review",
    revision: "c".repeat(64),
    async authorize(input) {
      borrowed = input.authority;
      expect("promote" in input.authority).toBe(false);
      const target = await input.authority.resolve(dependency);
      await input.authority.assertCurrent(target);
    },
  };
  const options = {
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: [provider],
    policySectionOwners: [],
  };
  const authority = await openRepositoryAuthority(options);
  await authority.registerRepository({
    selector: dependency,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: policyWith("code-review", {}),
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  await expect(authority.promote(fixture.change)).resolves.toEqual({ outcome: "promoted", sequence: 1 });
  if (borrowed === undefined) throw new Error("provider read authority was not issued");
  await expect(borrowed.resolve(fixture.selector)).rejects.toThrow(/expired/i);
  await authority.close();
  await expect(openRepositoryAuthority({ ...options, refUpdatePolicies: [] })).rejects.toThrow(/code-review.*provider/i);
});

function policyWith(name: string, value: unknown): RepositoryPolicy {
  const base = { schemaVersion: 1 as const, protectedRef: "refs/heads/main", extensions: { [name]: value } };
  return { ...base, policyRevision: repositoryPolicyRevision(base) };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
