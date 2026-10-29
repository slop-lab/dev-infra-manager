import { createHash } from "node:crypto";
import type { RefUpdatePolicy } from "./ports.js";
import { RepositoryStateError } from "./state.js";

export function selectedRefUpdatePolicyRevision(providers: readonly RefUpdatePolicy[]): string {
  assertRefUpdatePolicies(providers);
  const selected = [...providers]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, revision }) => ({ name, revision }));
  return createHash("sha256").update(JSON.stringify(selected)).digest("hex");
}

export function assertSelectedRefUpdatePolicyRevision(
  providers: readonly RefUpdatePolicy[],
  expectedRevision: string,
): void {
  if (selectedRefUpdatePolicyRevision(providers) !== expectedRevision) {
    throw new RepositoryStateError("selected ref-update policies changed during authority lifetime");
  }
}

export async function authorizeRefUpdatePolicies(
  providers: readonly RefUpdatePolicy[],
  expectedRevision: string,
  input: Parameters<RefUpdatePolicy["authorize"]>[0],
): Promise<string> {
  if (providers.length === 0) throw new RepositoryStateError("protected ref promotion requires a selected ref-update provider");
  assertSelectedRefUpdatePolicyRevision(providers, expectedRevision);
  for (const provider of providers) await provider.authorize(input);
  if (selectedRefUpdatePolicyRevision(providers) !== expectedRevision) {
    throw new RepositoryStateError("selected ref-update policies changed during authorization");
  }
  return expectedRevision;
}

function assertRefUpdatePolicies(providers: readonly RefUpdatePolicy[]): void {
  const names = new Set<string>();
  for (const provider of providers) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider.name) || !/^[0-9a-f]{64}$/.test(provider.revision)
      || typeof provider.authorize !== "function") {
      throw new RepositoryStateError("selected ref-update policy is invalid");
    }
    if (names.has(provider.name)) throw new RepositoryStateError(`duplicate ref-update policy '${provider.name}'`);
    names.add(provider.name);
  }
}
