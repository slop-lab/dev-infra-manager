import type { Server } from "node:http";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import type { NativeProjectRootReadHooks } from "./native-project-root-read-http.js";
import type { NativeProjectWorkspaceWriteHooks } from "./native-project-workspace-write-http.js";
import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
export type NativeGitBundleServerOptions = {
  readonly config: NativeGitBundleConfig; readonly stateDirectory: string;
  readonly readinessToken: string; readonly activationToken: string; readonly expectedGenerationId: string;
  readonly extensions?: readonly ControlPlaneExtension[]; readonly signal?: AbortSignal;
  readonly rootReadLeaseClock?: () => number; readonly rootReadLeaseHooks?: NativeProjectRootReadHooks;
  readonly workspaceWriteLeaseClock?: () => number; readonly workspaceWriteLeaseHooks?: NativeProjectWorkspaceWriteHooks;
};
export type NativeGitPreparedProject = { readonly serviceId: "native-main"; readonly projectId: string; readonly repositoryId: string; readonly state: "repository-prepared" };
export type NativeGitBundleServer = { readonly context: import("./plugin-api.js").RepositoryExtensionContext; readonly server: Server; listen(host?: string, port?: number): Promise<string>; prepareProject(generationId: string, ownerHostId: string, input: unknown): Promise<NativeGitPreparedProject>; close(): Promise<void> };
export class NativeGitBundleServerError extends Error { readonly name = "NativeGitBundleServerError"; }
