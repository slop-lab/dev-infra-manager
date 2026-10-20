/** Configuration for optional host services, separate from core workspace lifetime. */
export interface LifecycleOptions {
  stateRoot: string;
  controllerRuntimeDirectory: string;
  controllerSocketPath: string;
  adminControllerSocketPath: string;
}
