import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError, WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { readNativeWorkspaceAttachment } from "./nativeWorkspaceAttachment.js";
import { refreshNativeWorkspaceConnection } from "./nativeWorkspaceConnection.js";
import { ensureNativeWorkspaceBroker } from "./nativeWorkspaceBrokerProcess.js";

/** Reconnect private host references and replace stale host brokers without touching guests. */
export async function reconnectNativeWorkspaces(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  const selected = { ...environment };
  // An explicit connect selected the persisted authority; stale shell overrides
  // must not keep its existing workspaces on the previous generation.
  delete selected.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE;
  delete selected.DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE;
  const directory = path.join(managedStateRoot(selected), "native-workspace-attachments");
  let entries;
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.()) throw new UserError("native workspace attachment directory is not host owned");
    entries = await readdir(directory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let refreshed = 0;
  const failed: string[] = [];
  for (const entry of entries.filter((entry) => entry.endsWith(".json"))) {
    const attachment = await readNativeWorkspaceAttachment(path.join(directory, entry));
    try {
      const workspace = await new WorkspaceStore(attachment.workspaceStateRoot).read(attachment.workspaceName);
      if (workspace.id !== attachment.workspaceId || workspace.phase === "discarding") continue;
      const updated = await refreshNativeWorkspaceConnection(attachment, AbortSignal.timeout(40_000), selected);
      if (workspace.phase === "running") await ensureNativeWorkspaceBroker(updated, AbortSignal.timeout(15_000));
      if (updated.connectionFile !== attachment.connectionFile) refreshed++;
    } catch (error) {
      if (!(error instanceof MissingRecordError)) failed.push(attachment.workspaceName);
    }
  }
  if (failed.length) throw new UserError(`control plane selected, but these workspace connections could not be verified: ${failed.join(", ")}. Their prior credentials and scopes were retained; repair the original Project authority and reconnect`);
  return refreshed;
}
