import type { Server } from "node:http";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import type { AdmissionVerifierHttpClient } from "./ordinary-admission-http.js";
import type { NativeProjectRootReadHooks } from "./native-project-root-read-http.js";
import type { NativeProjectWorkspaceWriteHooks } from "./native-project-workspace-write-http.js";
import type { AuthoritativeNativeReviewHooks } from "./authoritative-native-review.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";

export type NativeGitBundleServerOptions = {
  readonly config: NativeGitBundleConfig;
  readonly stateDirectory: string;
  readonly readinessToken: string;
  readonly activationToken: string;
  readonly expectedGenerationId: string;
  readonly ordinaryIdentityHttpClient?: AdmissionVerifierHttpClient;
  readonly rootReadLeaseClock?: () => number;
  readonly rootReadLeaseHooks?: NativeProjectRootReadHooks;
  readonly workspaceWriteLeaseClock?: () => number;
  readonly workspaceWriteLeaseHooks?: NativeProjectWorkspaceWriteHooks;
  readonly authoritativeReviewHooks?: AuthoritativeNativeReviewHooks;
};

export type AuthoritativeNativeReviewSelector = {
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly proposalRef: string;
};

export type NativeGitPreparedProject = {
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly rootRepositoryId: "root";
  readonly state: "root-prepared";
};

export type NativeGitBundleServer = {
  readonly server: Server;
  listen(host?: string, port?: number): Promise<string>;
  prepareProject(generationId: string, ownerHostId: string, input: unknown): Promise<NativeGitPreparedProject>;
  createReview(input: AuthoritativeNativeReviewSelector): Promise<AuthoritativeNativeReviewEnvelope>;
  close(): Promise<void>;
};

export class NativeGitBundleServerError extends Error {
  readonly name = "NativeGitBundleServerError";
}
