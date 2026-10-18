import type { HostMirrorProvider } from "./hostMirrorProvider.js";
import type { NativeProjectReadyRecord } from "./nativeProjectPendingCodec.js";

/** Configuration for optional host services, separate from core workspace lifetime. */
export interface LifecycleOptions {
  stateRoot: string;
  controllerRuntimeDirectory: string;
  controllerSocketPath: string;
  adminControllerSocketPath: string;
  hostMirrorProvider?: HostMirrorProvider;
}
export type WorkspaceRuntimeBackendKind = "sysbox";
export type ProjectRecord = NativeProjectReadyRecord;
