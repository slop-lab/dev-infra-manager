import path from "node:path";
import {
  createNativeGitRootImporterClient,
  loadNativeControlPlaneConnection,
  managedStateRoot,
  loadNativeGitRootImporterConnection,
  NativeGitRootImporterConnectionError,
  NativeProjectPendingStore,
  UserError,
  type NativeControlPlaneConnection,
  type NativeGitRootImporterClient,
  type NativeProjectRecord
} from "@slop-lab/dim-managed";

const predecessorSelectors = [
  "DIM_GITEA_CONNECTION_FILE",
  "DIM_GIT_SYNC_CONNECTION_FILE",
  "DIM_QEMU_SCHEDULER_CONNECTION_FILE",
  "DIM_ORDINARY_CI_POOL_CONNECTION_FILE"
] as const;

export type NativeProjectSelection = {
  readonly connection: NativeControlPlaneConnection;
  readonly store: NativeProjectPendingStore;
  readonly environment: NodeJS.ProcessEnv;
};

export type NativeProjectView = {
  readonly name: string;
  readonly projectId: string;
  readonly serviceId: "native-main";
  readonly ownerHostId: string;
  readonly phase: "admission-pending" | "ready";
  readonly rootAlias: string;
  readonly protectedRef: string;
  readonly rootCommit: string;
  readonly rootTree: string;
  readonly policyRevision: string;
  readonly requiredReviewRevision: string;
  readonly requiredJobSetRevision: string;
  readonly runnable: boolean;
  readonly readyAt?: string;
};

export async function selectNativeProject(
  environment: NodeJS.ProcessEnv = process.env
): Promise<NativeProjectSelection> {
  const unsupported = predecessorSelectors.find((name) => environment[name] !== undefined);
  if (unsupported !== undefined) {
    throw new UserError(`${unsupported} is unsupported by the native-only DIM CLI`);
  }
  const selected = environment.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE;
  if (selected === undefined) {
    if (environment.DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE !== undefined) {
      throw new UserError("native root importer connection requires native control-plane selection");
    }
    throw new UserError("DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE is required for native Project commands");
  }
  if (selected.length === 0) {
    throw new UserError("native control-plane connection file selector must not be empty");
  }
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
  const selected = selection.environment.DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE;
  if (selected === undefined || selected.length === 0) {
    throw new UserError("DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE is required for native project create");
  }
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
    || connection.hostId !== selection.connection.hostId) {
    throw new UserError("native root importer connection conflicts with native control-plane selection");
  }
  return createNativeGitRootImporterClient(connection);
}

export function nativePendingProjectView(record: NativeProjectRecord): NativeProjectView {
  return {
    name: record.name,
    projectId: record.projectId,
    serviceId: record.serviceId,
    ownerHostId: record.ownerHostId,
    phase: record.phase,
    rootAlias: record.rootAlias,
    protectedRef: record.protectedRef,
    rootCommit: record.rootCommit,
    rootTree: record.rootTree,
    policyRevision: record.reviewPolicy.policyRevision,
    requiredReviewRevision: record.reviewPolicy.requiredReviewRevision,
    requiredJobSetRevision: record.reviewPolicy.requiredJobSetRevision,
    runnable: record.phase === "ready",
    ...(record.phase === "ready" ? { readyAt: record.readyAt } : {})
  };
}
