import { UserError } from "@slop-lab/dim-host-core";
import { selectedControlPlaneHostFile } from "./controlPlaneSelection.js";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { writeNativeWorkspaceAttachment, type NativeWorkspaceAttachment } from "./nativeWorkspaceAttachment.js";

/** Reconnect only the host credential reference; the workspace's Git identity and snapshot stay pinned. */
export async function refreshNativeWorkspaceConnection(attachment: NativeWorkspaceAttachment, signal: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env): Promise<NativeWorkspaceAttachment> {
  const connectionFile = await selectedControlPlaneHostFile(environment, attachment.connectionFile);
  if (connectionFile === attachment.connectionFile) return attachment;
  try {
    const previous = await loadNativeControlPlaneConnection(attachment.connectionFile);
    const selected = await loadNativeControlPlaneConnection(connectionFile);
    if (selected.hostId !== previous.hostId || selected.nativeGit.serviceId !== previous.nativeGit.serviceId
      || selected.nativeGit.transport !== previous.nativeGit.transport || selected.nativeGit.endpoint !== previous.nativeGit.endpoint) {
      // The active control plane is a default for new work, not authority to retarget existing workspaces.
      if (environment.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE === undefined) return attachment;
      throw new UserError("the selected connection belongs to another control-plane authority");
    }
    const project = await new NativeProjectPendingStore(attachment.managedStateRoot).read(attachment.projectName, selected.hostId);
    if (project?.phase !== "ready" || project.projectId !== attachment.projectId) throw new UserError("the native Project no longer matches this workspace");
    const bindings = [attachment.configuration, ...Object.values(attachment.repositories)];
    for (const binding of bindings) {
      const repositoryId = binding.repositoryId;
      const repository = project.repositories[repositoryId];
      if (!repository || repository.protectedRef !== binding.protectedRef || repository.reviewPolicy.policyRevision !== binding.policyRevision
        || repository.reviewPolicy.requiredReviewRevision !== binding.requiredReviewRevision || repository.reviewPolicy.requiredJobSetRevision !== binding.requiredJobSetRevision) {
        throw new UserError(`repository '${repositoryId}' no longer matches the workspace's pinned ref and review policy`);
      }
      const proof = await proveNativeProjectReadiness(selected, project, repositoryId, signal, {
        commit: binding.commit, tree: binding.tree, allowFastForward: true
      });
      if (proof.policyRevision !== binding.policyRevision || proof.requiredReviewRevision !== binding.requiredReviewRevision
        || proof.requiredJobSetRevision !== binding.requiredJobSetRevision) throw new UserError("workspace readiness policy changed");
    }
    const refreshed = { ...attachment, connectionFile };
    await writeNativeWorkspaceAttachment(refreshed);
    return refreshed;
  } catch (error) {
    const reason = error instanceof UserError ? error.message : "the current generation did not prove this workspace's pinned snapshot";
    throw new UserError(`cannot reconnect this native workspace: ${reason}. Run 'dim control-plane connect SETUP --output-directory NEW_DIRECTORY' for its original authority and retry; a changed Project ref or review policy requires a new workspace`, { cause: error });
  }
}
