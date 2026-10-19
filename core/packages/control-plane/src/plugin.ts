/** Optional workflow language capability; no workspace or runtime backend dependency. */
export type WorkflowJob = {
  readonly name: string;
  readonly kind: "ordinary-sysbox" | "qemu";
  readonly script: string;
  readonly repositories?: readonly string[];
  readonly argv: readonly string[];
};
export interface WorkflowCompiler {
  readonly configurationPath: string;
  compile(bytes: Buffer): readonly WorkflowJob[];
}
export type ControlPlanePluginContext = {
  readonly signal: AbortSignal;
  readonly workflowCompiler?: WorkflowCompiler;
};
export type RunningControlPlanePlugin = { close(): Promise<void> };
export type PreparedControlPlanePlugin = {
  readonly workflowCompiler?: WorkflowCompiler;
  readonly requiresWorkflowCompiler?: boolean;
  start(context: ControlPlanePluginContext): Promise<RunningControlPlanePlugin>;
};
export type ControlPlanePlugin = {
  readonly apiVersion: 1;
  readonly name: string;
  configure(raw: unknown): PreparedControlPlanePlugin | Promise<PreparedControlPlanePlugin>;
};
