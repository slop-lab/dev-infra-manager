import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodeReviewConfig } from "./config.js";
import type { CodeReviewRuntime as AuthoritativeNativeCandidateRuntime } from "./plugin-api.js";
import type { RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";

export type NativeHumanReviewerHooks = {
  readonly beforeApprovalPublication?: () => void | Promise<void>;
};

export type NativeHumanReviewerService = {
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
};

export type Credential = { readonly username: string; readonly password: string };
export type HumanReviewer = CodeReviewConfig["humanReviewers"][number];

export type HumanReviewerHttpInput = {
  readonly config: CodeReviewConfig;
  readonly features?: readonly string[];
  readonly hooks?: NativeHumanReviewerHooks;
  readonly knownCredentials: readonly Credential[];
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly mutate: RepositoryExtensionContext["mutate"];
  readonly read: <Result>(operation: () => Promise<Result>) => Promise<Result>;
};

export type HumanReviewerRequestContext = {
  readonly input: HumanReviewerHttpInput;
  readonly reviewer: HumanReviewer;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
};

export type RepositoryReviewRoute = {
  readonly projectId: string;
  readonly repositoryId: string;
};

export type ExactReviewRoute = RepositoryReviewRoute & {
  readonly reviewId: string;
};
