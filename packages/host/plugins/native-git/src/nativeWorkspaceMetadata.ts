import { UserError, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import { nativeWorkspaceAttachmentFile, readNativeWorkspaceAttachment } from "./nativeWorkspaceAttachment.js";

/** Optional metadata is supplied by this integration, never imported by host core. */
export async function nativeWorkspaceMetadata(record: WorkspaceRecord, stateRoot: string, workspaceStateRoot: string): Promise<{ projectId: string; projectName: string } | undefined> {
  try {
    const attachment = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(stateRoot, record.id));
    if (attachment.workspaceId !== record.id || attachment.workspaceName !== record.name || attachment.workspaceStateRoot !== workspaceStateRoot) {
      throw new UserError("workspace native attachment conflicts with its core identity");
    }
    return { projectId: attachment.projectId, projectName: attachment.projectName };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
