import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { createNativeGitRootReadIssuerClient } from "./nativeGitRootReadIssuerClient.js";
import { materializeNativeProjectReadyRootSnapshot } from "./nativeProjectDraftRootSnapshot.js";
import type { NativeProjectReadyRecord } from "./nativeProjectPendingCodec.js";
import type { NativeProjectReadinessProof } from "./nativeProjectReadinessClient.js";

type NativeProjectRootSelection = {
  readonly stateRoot: string;
  readonly connection: NativeControlPlaneConnection;
  readonly project: NativeProjectReadyRecord;
  readonly proof: NativeProjectReadinessProof;
  readonly signal: AbortSignal;
};

export async function materializeNativeProjectReadinessRoot(
  input: NativeProjectRootSelection
): Promise<void> {
  const temporaryRoot = join(input.stateRoot, "native-git-tmp");
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  await chmod(temporaryRoot, 0o700);
  const issuer = createNativeGitRootReadIssuerClient({
    schemaVersion: 1,
    endpoint: input.connection.nativeGit.endpoint,
    serviceId: "native-main",
    role: "operator-root-read-issuer",
    hostId: input.connection.hostId,
    generationId: input.connection.nativeGit.generationId,
    credential: input.connection.nativeGit.rootReadIssuer
  });
  const lease = await issuer.issueRootReadLease(input.project.projectId, input.signal);
  await materializeNativeProjectReadyRootSnapshot({
    stateRoot: input.stateRoot, name: input.project.name, projectId: input.project.projectId,
    rootAlias: input.project.rootAlias, protectedRef: input.proof.protectedRef,
    rootCommit: input.proof.commit, rootTree: input.proof.tree,
    gitExecutable: "/usr/bin/git", temporaryRoot,
    serviceEndpoint: input.connection.nativeGit.endpoint,
    username: lease.username, password: lease.password,
    signal: input.signal, projectLockHeld: true
  });
}
