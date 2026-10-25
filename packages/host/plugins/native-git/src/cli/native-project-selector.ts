import { UserError } from "@slop-lab/dim-host-core";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { selectedControlPlaneHostFile, selectedControlPlaneImporterFile } from "../controlPlaneSelection.js";
import path from "node:path";
import { invokeNativeProjectConsole } from "../projectConsole.js";
import {
  createNativeGitRootImporterClient,
  loadNativeControlPlaneConnection,
  loadNativeGitRootImporterConnection,
  NativeGitRootImporterConnectionError,
  NativeProjectPendingStore,
  type NativeControlPlaneConnection,
  type NativeGitRootImporterClient,
  type NativeProjectRecord
} from "../index.js";

export type NativeProjectSelection = {
  readonly connection: NativeControlPlaneConnection;
  readonly store: NativeProjectPendingStore;
  readonly environment: NodeJS.ProcessEnv;
};

export type NativeProjectView = NativeProjectRecord & { readonly runnable: boolean };

export async function selectNativeRepository(projectName: string, repositoryId: string) {
  const native = await selectNativeProject();
  const project = await native.store.read(projectName, native.connection.hostId);
  if (project?.repositories[repositoryId]?.phase !== "ready") {
    throw new UserError(`Project '${projectName}' has no ready repository '${repositoryId}'`);
  }
  const scope = { projectId: project.projectId, repositoryId };
  return { scope, invoke: (operation: string, input: Readonly<Record<string, unknown>>) =>
    invokeNativeProjectConsole(operation, { ...scope, ...input }, native.connection.nativeGit.generationId, native.environment) };
}

export async function selectNativeProject(
  environment: NodeJS.ProcessEnv = process.env
): Promise<NativeProjectSelection> {
  const selected = await selectedControlPlaneHostFile(environment);
  const connection = await loadNativeControlPlaneConnection(path.resolve(selected));
  const stateRoot = managedStateRoot(environment);
  return { connection, store: new NativeProjectPendingStore(stateRoot), environment };
}

export async function nativeProjectImporter(
  selection: NativeProjectSelection
): Promise<NativeGitRootImporterClient> {
  if (selection.connection.nativeGit.transport !== "loopback-http") {
    throw new UserError("native Project pending admission requires loopback-http until root import supports HTTPS");
  }
  const selected = await selectedControlPlaneImporterFile(selection.environment);
  let connection;
  try {
    connection = await loadNativeGitRootImporterConnection(path.resolve(selected));
  } catch (error) {
    if (error instanceof NativeGitRootImporterConnectionError) {
      throw new UserError("native root importer connection is invalid", { cause: error });
    }
    throw error;
  }
  if (connection.serviceId !== selection.connection.nativeGit.serviceId
    || connection.endpoint !== selection.connection.nativeGit.endpoint
    || connection.hostId !== selection.connection.hostId
    || connection.generationId !== selection.connection.nativeGit.generationId) {
    throw new UserError("native root importer connection conflicts with native control-plane selection");
  }
  return createNativeGitRootImporterClient(connection);
}

export function nativePendingProjectView(record: NativeProjectRecord): NativeProjectView {
  return { ...record, runnable: record.phase === "ready" };
}
