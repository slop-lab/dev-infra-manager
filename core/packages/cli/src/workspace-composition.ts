import {
  UserError, type CommandRunner, type CreateWorkspaceInput, type StreamingCommandRunner,
  type WorkspaceRecord, type WorkspaceService, type WorkspaceStore, type WorkspaceRuntime, type AcquiredWorkspaceSource
} from "@slop-lab/dim-core/workspace";

/** Optional features are composed on the selected host, outside the workspace kernel. */
export interface WorkspaceHostContext {
  readonly store: WorkspaceStore;
  readonly runner: StreamingCommandRunner;
  readonly cleanupRunner: CommandRunner;
  readonly signal: AbortSignal;
  readonly runtime?: WorkspaceRuntime;
  readonly validateCheckout?: (directory: string, source: AcquiredWorkspaceSource) => Promise<void>;
}

export async function createWorkspaceOnHost(
  input: CreateWorkspaceInput, service: WorkspaceService, context: WorkspaceHostContext
): Promise<WorkspaceRecord> {
  return managedSource(input.source.url)
    ? (await managedHost()).createManagedWorkspace(input, context)
    : service.create(input);
}

/** Start/exec can recover an optional broker after a host reboot or service failure. */
export async function ensureWorkspaceIntegration(record: WorkspaceRecord, context: WorkspaceHostContext): Promise<void> {
  if (record.initialized && record.phase === "running" && managedSource(record.source.url)) {
    await (await managedHost()).ensureManagedWorkspace(record, context);
  }
}

function managedSource(source: string): boolean { return source.startsWith("dim://"); }

async function managedHost() {
  try { import.meta.resolve("@slop-lab/dim-managed/host"); }
  catch (error) {
    if (error instanceof Error && "code" in error
      && ["ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes(String(error.code))) {
      throw new UserError("Managed Git workspace support is not installed. Install the matching package set with "
        + "'dim installer install core --with-managed' (or 'just install-local --with-managed' for source builds).");
    }
    throw error;
  }
  return import("@slop-lab/dim-managed/host");
}
