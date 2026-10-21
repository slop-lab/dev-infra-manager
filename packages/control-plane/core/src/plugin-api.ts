/** Contributions are configured, trusted plugin code; the runtime does not interpret their domains. */
export interface ControlPlaneExtension {
  readonly kind: string;
  readonly name: string;
  readonly value: object;
}
export type ControlPlaneExtensionIdentity = Pick<ControlPlaneExtension, "kind" | "name">;
export type ControlPlanePluginContext = {
  readonly signal: AbortSignal;
  readonly extensions: readonly ControlPlaneExtension[];
};
export type RunningControlPlanePlugin = { close(): Promise<void> };
export type PreparedControlPlanePlugin = {
  readonly extensions?: readonly ControlPlaneExtension[];
  readonly requiresExtensions?: readonly ControlPlaneExtensionIdentity[];
  start(context: ControlPlanePluginContext): Promise<RunningControlPlanePlugin>;
};
export type ControlPlanePlugin = {
  readonly apiVersion: 1;
  readonly name: string;
  configure(raw: unknown): PreparedControlPlanePlugin | Promise<PreparedControlPlanePlugin>;
};
