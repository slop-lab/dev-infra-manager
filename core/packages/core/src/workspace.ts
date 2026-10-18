/** Lightweight base workspace API. No native Git, review or CI services. */
export { UserError, MissingRecordError } from "./errors.js";
export { ProcessRunner } from "./runner.js";
export type { RunOptions, CommandRunner, StreamingCommandRunner } from "./types.js";
export type { WorkspaceRecord, WorkspaceView, WorkspaceSource, WorkspaceResources, AcquiredWorkspaceSource } from "./workspace/models.js";
export { WorkspaceStore, parseWorkspaceRecord, validateResources } from "./workspace/store.js";
export { WorkspaceService } from "./workspace/service.js";
export type { CreateWorkspaceInput, AcquireSource, WorkspaceRuntime, WorkspaceConnectOptions } from "./workspace/service.js";
export { acquireWorkspaceSource } from "./workspace/source.js";
export { buildWorkspaceImage } from "./workspaceImage.js";
export { ContainerWorkspaceRuntime } from "./workspace/runtime.js";

export { checkWorkspaceHost } from "./workspace/doctor.js";
export type { HostCheck } from "./workspace/doctor.js";
