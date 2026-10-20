import { createHash } from "node:crypto";
import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin";
import { repositoryExtensionFactories, type RepositoryExtensionContext } from "./extensions.js";
import type { NativeImportedRootPolicy } from "./native-imported-root-policy.js";
import type { AuthoritativeNativeRepositoryTarget } from "./authoritative-native-root-target.js";
import type { ProtectedRefChange } from "./repository-cas.js";

export interface RefUpdatePolicy {
  readonly name: string;
  /** SHA256 including implementation and all provider settings affecting authorization. */
  readonly revision: string;
  validate(options: unknown): void;
  /** Called under repository serialization. Throw to deny; every selected policy must succeed. */
  check(input: { readonly context: RepositoryExtensionContext; readonly target: AuthoritativeNativeRepositoryTarget; readonly change: ProtectedRefChange; readonly options: unknown }): Promise<void>;
}
export const refUpdatePolicyKind = "dim.git-repositories.ref-update-policy";
export function refUpdatePolicyExtension(policy: RefUpdatePolicy): ControlPlaneExtension {
  assertProviders([policy]); return { kind: refUpdatePolicyKind, name: policy.name, value: policy };
}
export function refUpdatePolicies(extensions: readonly ControlPlaneExtension[]): readonly RefUpdatePolicy[] {
  const policies = extensions.filter(({ kind }) => kind === refUpdatePolicyKind).map(({ name, value }) => {
    if (!("name" in value) || value.name !== name) throw new Error(`invalid ref update policy '${name}'`);
    return value as RefUpdatePolicy;
  });
  assertProviders(policies); return policies;
}
function assertProviders(policies: readonly RefUpdatePolicy[]): void {
  const names = new Set<string>();
  for (const policy of policies) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(policy.name) || !/^[0-9a-f]{64}$/.test(policy.revision)
      || typeof policy.validate !== "function" || typeof policy.check !== "function") throw new Error("invalid ref update policy");
    if (names.has(policy.name)) throw new Error(`duplicate ref update policy '${policy.name}'`);
    names.add(policy.name);
  }
}
export function refUpdatePolicyRevision(policy: NativeImportedRootPolicy, providers: readonly RefUpdatePolicy[]): string {
  assertProviders(providers);
  const selected = providers.filter(({ name }) => Object.hasOwn(policy.extensions, name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const provider of selected) provider.validate(policy.extensions[provider.name]);
  return createHash("sha256").update(JSON.stringify({ policyRevision: policy.policyRevision, providers: selected.map(({ name, revision }) => ({ name, revision })) })).digest("hex");
}
export function assertRefUpdatePolicyProviders(policy: NativeImportedRootPolicy, extensions: readonly ControlPlaneExtension[]): void {
  const providers = refUpdatePolicies(extensions);
  const factories = repositoryExtensionFactories(extensions);
  for (const factory of factories) for (const name of factory.requiresRefUpdatePolicies ?? []) {
    if (!providers.some((provider) => provider.name === name)) throw new Error(`repository extension '${factory.name}' requires ref update policy '${name}'`);
  }
  for (const name of Object.keys(policy.extensions)) {
    if (!providers.some((provider) => provider.name === name) && !factories.some((factory) => factory.policyName === name)) throw new Error(`repository policy requires an enabled '${name}' provider`);
  }
}
export async function checkRefUpdatePolicies(context: RepositoryExtensionContext, target: AuthoritativeNativeRepositoryTarget, change: ProtectedRefChange): Promise<string> {
  assertRefUpdatePolicyProviders(target.imported.policy, context.extensions);
  const providers = refUpdatePolicies(context.extensions);
  const revision = refUpdatePolicyRevision(target.imported.policy, providers);
  for (const provider of providers) if (Object.hasOwn(target.imported.policy.extensions, provider.name)) {
    const result: unknown = await provider.check({ context, target, change, options: target.imported.policy.extensions[provider.name] });
    if (result !== undefined) throw new Error(`ref update policy '${provider.name}' returned an invalid result`);
  }
  if (refUpdatePolicyRevision(target.imported.policy, refUpdatePolicies(context.extensions)) !== revision) throw new Error("ref update policies changed during authorization");
  return revision;
}
