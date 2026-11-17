/** Lightweight base workspace API. No native Git, review or CI services. */
export { UserError, MissingRecordError } from "./errors.js";
export { ProcessRunner } from "./runner.js";
export type { RunOptions, CommandRunner, StreamingCommandRunner } from "./types.js";
export type { WorkspaceRecord, WorkspaceView, WorkspaceSource, WorkspaceResources, AcquiredWorkspaceSource, WorkspaceCheckout } from "./workspace/models.js";
export { WorkspaceStore, parseWorkspaceRecord, validateResources } from "./workspace/store.js";
export { WorkspaceService } from "./workspace/service.js";
export type {
  CreateWorkspaceInput, AcquireSource, WorkspaceRuntime, WorkspaceConnectOptions, WorkspaceExecOptions,
  WorkspaceRuntimeTarget, ResolvedWorkspaceRuntimeTarget
} from "./workspace/service.js";
export { acquireWorkspaceSource } from "./workspace/source.js";
export { buildWorkspaceImage } from "./workspaceImage.js";
export { ContainerWorkspaceRuntime, workspaceRuntimeResources } from "./workspace/runtime.js";

export { checkWorkspaceHost, workspaceRuntimeFailureCheck } from "./workspace/doctor.js";
export type { HostCheck, WorkspaceRuntimeFailure } from "./workspace/doctor.js";
export { workspacePortBridge, workspacePortCleanup, workspacePortBridgeMarker } from "./workspace/portBridge.js";
export { workspaceCopyGuest, workspaceCopyCleanup, workspaceCopyMarker } from "./workspace/copy.js";
export { workspaceGuestAssets, workspaceEnvironmentSkillAsset } from "./workspace/guestAssets.js";
export { deployGuestIntegration, execGuestIntegrationTarget } from "./workspace/guestIntegration.js";
export type { GuestIntegrationContext, GuestIntegrationTarget, GuestIntegration } from "./workspace/guestIntegration.js";

export { resolveHostPluginModule } from "./pluginModule.js";

export type { WorkspaceRuntimeDevice, ContainerWorkspaceRuntimeOptions } from "./workspace/runtime.js";
export { workspaceServiceEndpoint, workspaceServicePort } from "./workspace/serviceEndpoint.js";

export { DIM_INTERNAL_SUFFIX, validateWorkspaceInternalName, validateWorkspaceUpstream, validateNameRegistration } from "./workspace/nameRegistration.js";
export type { WorkspaceNameRegistration } from "./workspace/nameRegistration.js";
export { reconcileNameTable, flattenNameTable, parseNameTable } from "./workspace/nameTable.js";
export type { WorkspaceNameTable } from "./workspace/nameTable.js";
export { parseDnsQuery, encodeDnsResponse, createNameResolver } from "./workspace/nameResolver.js";
export type { ParsedDnsQuery, NameResolverConfig, NameResolverHandle } from "./workspace/nameResolver.js";
export { createNameIngress } from "./workspace/nameIngress.js";
export type { NameIngressConfig, NameIngressHandle } from "./workspace/nameIngress.js";
export { runGuestNameService, startGuestNameService, DIM_NAME_SERVICE_INGRESS_PORT } from "./workspace/nameServiceGuestMain.js";
export type { GuestNameServiceOptions, GuestNameServiceHandle } from "./workspace/nameServiceGuestMain.js";
export { reconcileWorkspaceNames, bindNameServiceForOwner } from "./workspace/nameServiceAttachment.js";
export type { WorkspaceNameServiceContext } from "./workspace/nameServiceAttachment.js";
