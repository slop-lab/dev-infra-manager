import type { HostMirrorProvider } from "./hostMirrorProvider.js";
import type { NativeProjectReadyRecord } from "./nativeProjectPendingCodec.js";

export interface LifecycleOptions {
  stateRoot: string;
  nativeControlPlaneConnection?: { readonly file: string };
  defaultWorkspaceBackend: WorkspaceRuntimeBackendKind;
  workspaceImage?: string;
  workspaceRuntime?: string;
  workspacePrivileged?: boolean;
  cpuCount: string;
  memory: string;
  pidsLimit: string;
  controllerRuntimeDirectory: string;
  controllerSocketPath: string;
  agentControllerSocketPath: string;
  adminControllerSocketPath: string;
  hostMirrorProvider?: HostMirrorProvider;
}

export interface HostLifecycleRecord {
  schemaVersion: 2;
  phase: "ready" | "stopping" | "stopped" | "starting" | "error";
  resumeWorkspaces: string[];
  updatedAt: string;
  error?: string;
}

export type WorkspaceRuntimeBackendKind = "sysbox";

export type ProjectRecord = NativeProjectReadyRecord;

export type WorkspacePhase = "creating" | "setting-up" | "ready" | "stopped" | "setup-error" | "error" | "discarding";

export interface WorkspaceSetupRecord {
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
}

export type WorkspaceCapabilityRequirement = "required" | "recommended";
export interface WorkspaceCapabilityRecord {
  name: string;
  requirement: WorkspaceCapabilityRequirement;
  status: "provided" | "unavailable";
  plugin?: string;
  detail?: string;
  capabilities?: string[];
  securityOptions?: string[];
  devices?: string[];
  environment?: Record<string, string>;
}

export type NativeWorkspaceSource = {
  readonly kind: "native";
  readonly serviceId: "native-main";
  readonly snapshot: {
    readonly projectId: string;
    readonly repositoryId: "root";
    readonly protectedRef: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly policyRevision: string;
  readonly requiredReviewRevision: string;
  readonly requiredJobSetRevision: string;
};

interface WorkspaceRecordBase {
  workspaceId: string;
  name: string;
  projectId: string;
  projectName: string;
  rootRepositoryAlias: string;
  rootRef: string;
  rootCommit: string;
  workspaceDataPath: string;
  environment?: "recommended" | "custom";
  phase: WorkspacePhase;
  profiles: string[];
  capabilities?: WorkspaceCapabilityRecord[];
  composeProjectName: string;
  containerName: string;
  networkName: string;
  dockerVolumeName: string;
  runtimeBackend: WorkspaceRuntimeBackendKind;
  kvm: boolean;
  cpuCount: string;
  memory: string;
  pidsLimit: string;
  routes: string[];
  gitUserName: string;
  gitUserEmail: string;
  hostAliases: Record<string, string[]>;
  projectManifestPath: string;
  createdAt: string;
  updatedAt: string;
  lastSetup?: WorkspaceSetupRecord;
  error?: string;
}

export interface NativeWorkspaceRecord extends WorkspaceRecordBase {
  schemaVersion: 9;
  source: NativeWorkspaceSource;
}

export type WorkspaceRecord = NativeWorkspaceRecord;
