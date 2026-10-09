import type { NativeGitBundleState } from "./native-bundle-state.js";
import { verifyLiveImportedRoot } from "./native-imported-root-verifier.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import type { WorkspaceWriteLeaseScope } from "./native-workspace-write-lifecycle.js";
import type { GitExecutableIdentity } from "./repository.js";
import type { NativeGitRoute } from "./routing.js";

export type WorkspaceWriteVerificationInput = {
  readonly activated: () => boolean;
  readonly activationTokenDigest: string;
  readonly expectedGenerationId: string;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
};

export type WorkspaceWriteLeaseRequest = {
  readonly generationId: string;
  readonly repositoryId: "root";
  readonly workspaceId: string;
};

export function parseWorkspaceWriteLeaseRequest(value: unknown): WorkspaceWriteLeaseRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 4
    || Reflect.get(value, "schemaVersion") !== 1
    || typeof Reflect.get(value, "generationId") !== "string"
    || !/^[0-9a-f]{64}$/.test(Reflect.get(value, "generationId"))
    || Reflect.get(value, "repositoryId") !== "root"
    || typeof Reflect.get(value, "workspaceId") !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(Reflect.get(value, "workspaceId"))) {
    throw new NativeProjectRootImportStateError("native Project workspace write lease request is invalid");
  }
  const workspaceId = Reflect.get(value, "workspaceId");
  if (Buffer.from(workspaceId, "base64url").length !== 32
    || Buffer.from(workspaceId, "base64url").toString("base64url") !== workspaceId) {
    throw new NativeProjectRootImportStateError("native Project workspace write lease request is invalid");
  }
  return {
    generationId: Reflect.get(value, "generationId"),
    repositoryId: "root",
    workspaceId
  };
}

export function workspaceWriteLeaseMatchesRoute(
  lease: WorkspaceWriteLeaseScope,
  route: NativeGitRoute,
  generationId: string
): boolean {
  return lease.generationId === generationId && lease.projectId === route.projectId
    && lease.repositoryId === route.repositoryId;
}

export async function verifyAuthoritativeWorkspaceRoot(
  input: WorkspaceWriteVerificationInput,
  projectId: string,
  ownerHostId: string
): Promise<void> {
  const live = await verifyLiveImportedRoot({
    activated: input.activated(),
    activationTokenDigest: input.activationTokenDigest,
    expectedGenerationId: input.expectedGenerationId,
    gitExecutable: input.gitExecutable,
    gitIdentity: input.gitIdentity,
    ownerHostId,
    projectId,
    state: input.state,
    stateDirectory: input.stateDirectory
  });
  if (live.imported.policyFormat !== "authoritative-v1") {
    throw new NativeProjectRootImportStateError("legacy imported-root policy cannot authorize workspace writes");
  }
}
