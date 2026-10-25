import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodeReviewConfig } from "./config.js";
import type { CodeReviewRuntime as AuthoritativeNativeCandidateRuntime } from "./plugin-api.js";

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
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
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
