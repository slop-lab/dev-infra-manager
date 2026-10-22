import { isDeepStrictEqual } from "node:util";
import { nativeRepositoryBranches } from "@slop-lab/dim-contracts-git";
import { UserError } from "@slop-lab/dim-host-core";
import { selectedControlPlaneHostFile } from "./controlPlaneSelection.js";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { writeNativeWorkspaceAttachment, type NativeWorkspaceAttachment } from "./nativeWorkspaceAttachment.js";

/** Refresh trusted host policy and credentials while preserving every checkout snapshot and scoped grant. */
export async function refreshNativeWorkspaceConnection(attachment: NativeWorkspaceAttachment, signal: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env): Promise<NativeWorkspaceAttachment> {
  const connectionFile = await selectedControlPlaneHostFile(environment, attachment.connectionFile);
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
    const configuration = { ...attachment.configuration };
    const repositories = Object.fromEntries(Object.entries(attachment.repositories).map(([id, binding]) => [id, { ...binding }]));
    const bindings = [configuration, ...Object.values(repositories)];
    for (const binding of bindings) {
      const repositoryId = binding.repositoryId;
      const repository = project.repositories[repositoryId];
      if (!repository || !Object.hasOwn(nativeRepositoryBranches(repository.repositoryPolicy), binding.protectedRef)) {
        throw new UserError(`repository '${repositoryId}' no longer matches the workspace's pinned ref`);
      }
      const proof = await proveNativeProjectReadiness(selected, project, repositoryId, signal, {
        commit: binding.commit, tree: binding.tree, protectedRef: binding.protectedRef, allowFastForward: true
      });
      binding.policyRevision = proof.policyRevision;
    }
    const refreshed = { ...attachment, connectionFile, configuration, repositories };
    if (!isDeepStrictEqual(refreshed, attachment)) await writeNativeWorkspaceAttachment(refreshed);
    return refreshed;
  } catch (error) {
    const reason = error instanceof UserError ? error.message : "the current generation did not prove this workspace's pinned snapshot";
    throw new UserError(`cannot reconnect this native workspace: ${reason}. Run 'dim control-plane connect SETUP --output-directory NEW_DIRECTORY' for its original authority and retry; a changed Project identity or protected ref requires a new workspace`, { cause: error });
  }
}
