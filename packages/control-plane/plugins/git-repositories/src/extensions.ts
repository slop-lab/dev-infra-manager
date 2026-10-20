/** Repository-owned extension SDK. Features attach to one owned repository service. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import type { NativeImportedRootPolicy } from "./native-imported-root-policy.js";
import type { NativeGitRoute } from "./routing.js";

export const repositoryExtensionKind = "dim.git-repositories.extension";
export type RepositoryRuntime = AuthoritativeNativeCandidateRuntime;
export type RepositoryExtensionContext = {
  readonly runtime: RepositoryRuntime;
  readonly stateDirectory: string;
  readonly extensionStateDirectory: string;
  readonly signal: AbortSignal;
  readonly extensions: readonly ControlPlaneExtension[];
  readonly knownCredentials: readonly { readonly username: string; readonly password: string }[];
  readonly available: () => boolean;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
};
export type RepositoryAttachment = {
  readonly handle?: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
  readonly serveGit?: (request: IncomingMessage, response: ServerResponse, route: NativeGitRoute) => Promise<boolean>;
  readonly onProposals?: (projectId: string, repositoryId: string, refs: readonly string[]) => Promise<void>;
  readonly validatePolicy?: (policy: NativeImportedRootPolicy, selector: { readonly projectId: string; readonly repositoryId: string }) => void | Promise<void>;
  readonly activate?: () => Promise<void>;
  readonly healthy?: () => boolean;
  close(): Promise<void>;
};
export type RepositoryExtensionFactory = {
  readonly name: string;
  readonly policyName?: string;
  readonly requiresRefUpdatePolicies?: readonly string[];
  readonly credentials?: readonly { readonly username: string; readonly password: string }[];
  attach(context: RepositoryExtensionContext): Promise<RepositoryAttachment>;
};
export function repositoryExtension(factory: RepositoryExtensionFactory): ControlPlaneExtension {
  return { kind: repositoryExtensionKind, name: factory.name, value: factory };
}
export function repositoryExtensionFactories(extensions: readonly ControlPlaneExtension[]): readonly RepositoryExtensionFactory[] {
  return extensions.filter((entry) => entry.kind === repositoryExtensionKind).map((entry) => {
    if (!("attach" in entry.value) || typeof entry.value.attach !== "function" || !("name" in entry.value) || entry.value.name !== entry.name) throw new Error(`invalid repository extension: ${entry.name}`);
    return entry.value as RepositoryExtensionFactory;
  });
}
export * from "./authoritative-native-root-target.js";
export * from "./native-imported-root-policy.js";
export * from "./native-imported-root-verifier.js";
export * from "./native-bundle-state.js";
export * from "./native-bundle-http.js";
export * from "./native-basic-auth.js";
export * from "./repository.js";
export * from "./backend.js";
export * from "./routing.js";
export * from "./native-proposal-reconciler.js";
export * from "./native-project-registry-state.js";
export * from "./promotion-git.js";
export * from "./repository-ref-state.js";
export * from "./repository-cas.js";
export * from "./native-root-read-lifecycle.js";
export * from "./native-project-root-import-codec.js";
export * from "./native-root-import-storage.js";
export * from "./native-bundle-server-types.js";
export * from "./native-project-root-import-transitions.js";
export * from "./native-bundle-activation.js";

export * from "./ref-update-policies.js";
