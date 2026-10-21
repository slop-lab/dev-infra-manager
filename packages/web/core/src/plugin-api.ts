/** Web feature packages own their operations, server connections and browser UI. */
import type { Operation } from "@slop-lab/dim-contracts-operations";
export type { Operation, OperationAccess, OperationDescriptor } from "@slop-lab/dim-contracts-operations";
export { loadPrivateJson } from "./config.js";

/** Trusted controller selections come only from private server configuration. */
export interface WebPluginController {
  readonly id: string;
  /** Up to 128 arguments, 96 KiB UTF-8 each and 128 KiB combined; no host/JSON overrides. */
  run(args: readonly string[], options?: { readonly timeoutMilliseconds: number }): Promise<unknown>;
}
export interface WebPluginContext {
  readonly controllers: readonly WebPluginController[];
}
/** Optional browser invoke deadline; the generic transport caps this at 185 seconds. */
export interface WebPluginInvokeOptions { readonly timeoutMilliseconds: number }
export interface WebPluginRuntime {
  /** A configured connection may expose a subset, e.g. without a promoter. */
  readonly operations?: readonly Operation[];
  invoke(name: string, input: unknown): Promise<unknown>;
}
export interface WebPlugin {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly operations: readonly Operation[];
  readonly assets: Readonly<Record<string, URL>>;
  readonly browserEntry: string;
  /** Omitted surfaces place the feature in navigation. Workspace features receive an exact workspace identity. */
  readonly surfaces?: readonly ("navigation" | "workspace")[];
  create(config: unknown): Promise<WebPluginRuntime>;
  /** Discover feature-owned connections through the selected trusted controllers. */
  autoConnect?(context: WebPluginContext): Promise<WebPluginRuntime>;
}

/** Browser scope is provided by the workspace manager, never by a second target picker. */
export interface WebPluginWorkspace {
  readonly hostId: string;
  readonly name: string;
  readonly id: string;
  readonly phase: string;
}
export interface WebPluginBrowserContext {
  readonly operations: readonly import("@slop-lab/dim-contracts-operations").OperationDescriptor[];
  isCurrent(): boolean;
  invoke(name: string, input?: unknown, options?: WebPluginInvokeOptions): Promise<unknown>;
}
export interface WebPluginWorkspaceBrowserContext extends WebPluginBrowserContext {
  readonly workspace: WebPluginWorkspace;
  refreshWorkspace(): Promise<boolean>;
}
