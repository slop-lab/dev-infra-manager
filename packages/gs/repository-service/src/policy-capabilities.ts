import type { DatabaseSync } from "node:sqlite";
import type { RepositoryPolicy } from "@slop-lab/gs-repository-contracts";
import { effectivePolicy, listRepositorySelectors } from "./catalog.js";
import type { PolicySectionOwner, RefUpdatePolicy } from "./ports.js";
import { RepositoryStateError } from "./state.js";

export function assertStoredPolicyCapabilities(
  database: DatabaseSync,
  owners: readonly PolicySectionOwner[],
  providers: readonly RefUpdatePolicy[],
): void {
  assertPolicyOwners(owners);
  for (const selector of listRepositorySelectors(database)) {
    assertPolicyCapabilities(effectivePolicy(database, selector).policy, owners, providers);
  }
}

export function assertPolicyCapabilities(
  policy: RepositoryPolicy,
  owners: readonly PolicySectionOwner[],
  providers: readonly RefUpdatePolicy[],
): void {
  assertPolicyOwners(owners);
  const ownerByName = new Map(owners.map((owner) => [owner.sectionName, owner]));
  const providerNames = new Set(providers.map((provider) => provider.name));
  for (const [name, value] of Object.entries(policy.extensions)) {
    const owner = ownerByName.get(name);
    const providerSelected = providerNames.has(name);
    if (owner === undefined && !providerSelected) {
      throw new RepositoryStateError(`repository policy '${name}' requires a selected owner or ref-update provider`);
    }
    owner?.parse(value);
    if (owner !== undefined) assertEnforcement(owner, providerSelected);
  }
}

function assertPolicyOwners(owners: readonly PolicySectionOwner[]): void {
  const names = new Set<string>();
  for (const owner of owners) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(owner.sectionName) || typeof owner.parse !== "function") {
      throw new RepositoryStateError("selected repository policy owner is invalid");
    }
    if (names.has(owner.sectionName)) throw new RepositoryStateError(`duplicate repository policy owner '${owner.sectionName}'`);
    names.add(owner.sectionName);
  }
}

function assertEnforcement(owner: PolicySectionOwner, providerSelected: boolean): void {
  switch (owner.enforcement) {
    case "configuration": return;
    case "authorization": {
      if (!providerSelected) throw new RepositoryStateError(`repository policy '${owner.sectionName}' requires a selected ref-update provider`);
      return;
    }
  }
}
