import { UserError } from "./errors.js";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { materializeNativeProjectReadinessRoot } from "./nativeProjectRootSelection.js";
import type { LifecycleOptions, NativeWorkspaceRecord } from "./lifecycleTypes.js";

export async function selectCurrentNativeWorkspaceRoot(
  options: LifecycleOptions,
  record: NativeWorkspaceRecord
): Promise<NativeWorkspaceRecord> {
  const selected = options.nativeControlPlaneConnection;
  if (selected === undefined) throw new UserError("native control-plane selection is required");
  const connection = await loadNativeControlPlaneConnection(selected.file);
  const project = await new NativeProjectPendingStore(options.stateRoot)
    .read(record.projectName, connection.hostId);
  if (project?.phase !== "ready") throw new UserError(`native project '${record.projectName}' is not ready`);
  if (project.projectId !== record.projectId || project.serviceId !== record.source.serviceId
    || project.rootRepositoryId !== record.source.snapshot.repositoryId
    || project.protectedRef !== record.source.snapshot.protectedRef
    || project.reviewPolicy.policyRevision !== record.source.policyRevision
    || project.reviewPolicy.requiredReviewRevision !== record.source.requiredReviewRevision
    || project.reviewPolicy.requiredJobSetRevision !== record.source.requiredJobSetRevision) {
    throw new UserError(`native project '${record.projectName}' identity changed`);
  }
  const signal = AbortSignal.timeout(10_000);
  const proof = await proveNativeProjectReadiness(connection, project, signal, {
    commit: record.source.snapshot.commit,
    tree: record.source.snapshot.tree,
    allowFastForward: true
  });
  await materializeNativeProjectReadinessRoot({
    stateRoot: options.stateRoot, connection, project, proof, signal
  });
  return { ...record, rootRepositoryAlias: project.rootAlias, rootRef: proof.protectedRef,
    rootCommit: proof.commit, source: { ...record.source, snapshot: {
      ...record.source.snapshot, protectedRef: proof.protectedRef, commit: proof.commit, tree: proof.tree
    } } };
}
