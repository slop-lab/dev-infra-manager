/** Host infrastructure primitives. Workspace and controller APIs have explicit subpath exports. */
export * from "./workspace.js";
export { isUserError, assertCondition } from "./errors.js";
export type * from "./types.js";
export * from "./lifecycleRecord.js";
export * from "./lifecycleLock.js";
export * from "./lifecycleLockGuard.js";
export * from "./workspaceImageReference.js";
export * from "./stateCompatibility.js";
export * from "./stateInspection.js";
