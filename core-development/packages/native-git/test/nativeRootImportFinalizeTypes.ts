import type { NativeGitBundleServer } from "../../../../core/packages/native-git/src/native-bundle-server.js";

export type GitBundle = { readonly bytes: Buffer; readonly commit: string; readonly tree: string };

export type ImportReceipt = {
  readonly schemaVersion: 1;
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly rootRepositoryId: "root";
  readonly generationId: string;
  readonly importNonce: string;
  readonly protectedRef: string;
  readonly expectedCommit: string;
  readonly policyDigest: string;
  readonly bundleDigest: string;
  readonly bundleSize: number;
  readonly phase: "bundle-durable";
};

export type RunningService = NativeGitBundleServer & { readonly origin: string };

export type RootReadLeaseHooks = {
  readonly beforeVerification?: () => Promise<void>;
  readonly backendStarted?: () => void;
};

export type WorkspaceWriteLeaseHooks = {
  readonly beforeVerification?: () => Promise<void>;
};

export type RuntimeGit = { readonly gitExecutable: string; readonly gitVersion: string };
