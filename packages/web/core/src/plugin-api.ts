/** Web feature packages own their operations, server connections and browser UI. */
import type { Operation } from "@slop-lab/dim-contracts-operations";
export type { Operation, OperationAccess, OperationDescriptor } from "@slop-lab/dim-contracts-operations";
export { loadPrivateJson } from "./config.js";

/** Trusted controller selections come only from private server configuration. */
export interface WebPluginController {
  readonly id: string;
  /** Up to 128 arguments, 96 KiB UTF-8 each and 128 KiB combined; optional stdin text up to 128 KiB. No host/JSON overrides. */
  run(args: readonly string[], options?: { readonly timeoutMilliseconds: number; readonly input?: string }): Promise<unknown>;
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
export interface WebPluginUi {
  element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text?: string, className?: string): HTMLElementTagNameMap[Tag];
  button(label: string, variant?: "primary" | "secondary" | "danger"): HTMLButtonElement;
  input(parent: HTMLElement, label: string, value?: string): HTMLInputElement;
  select(parent: HTMLElement, label: string, choices: readonly { readonly value: string; readonly label: string }[], value?: string): HTMLSelectElement;
  feedback(target: HTMLElement, text: string, tone?: "status" | "error"): void;
  table(headings: readonly string[], rows: readonly (readonly string[])[]): HTMLDivElement;
  /** Navigation is a read-only selection change, never a domain mutation. */
  navigationAction(parent: HTMLElement, options: WebPluginNavigationAction): HTMLButtonElement;
}
export type WebNavigationResult =
  | { readonly status: "opened"; readonly message: string }
  | { readonly status: "blocked"; readonly message: string }
  | { readonly status: "unavailable"; readonly code: "not-installed" | "not-ready" | "not-authorized" | "invalid-target" | "target-unavailable" | "load-failed" | "session-ended"; readonly message: string };
export type WebFeatureNavigationHandler = (target: unknown, isCurrent: () => boolean) => WebNavigationResult | Promise<WebNavigationResult>;
export interface WebManagedWorkspaceCreateTarget {
  readonly hostId: string;
  readonly projectId: string;
  readonly repositoryIds: readonly string[];
  readonly workingRepositoryId: string;
}
export interface WebPluginNavigation {
  /** Installed navigation surface only; readiness and target membership are checked on open. */
  hasFeature(featureId: string): boolean;
  readonly canCreateWorkspace: boolean;
  openFeature(featureId: string, target: unknown): Promise<WebNavigationResult>;
  openWorkspaceCreate(target: WebManagedWorkspaceCreateTarget): Promise<WebNavigationResult>;
}
export interface WebPluginNavigationAction {
  readonly label: string;
  readonly status: HTMLElement;
  readonly isCurrent: () => boolean;
  readonly open: () => Promise<WebNavigationResult>;
}
export interface WebPluginBrowserContext {
  readonly operations: readonly import("@slop-lab/dim-contracts-operations").OperationDescriptor[];
  readonly ui: WebPluginUi;
  readonly navigation: WebPluginNavigation;
  /** Register this mounted destination's strict target decoder. Disposed with its session. */
  onNavigate(handler: WebFeatureNavigationHandler): () => void;
  isCurrent(): boolean;
  invoke(name: string, input?: unknown, options?: WebPluginInvokeOptions): Promise<unknown>;
}
export interface WebPluginWorkspaceBrowserContext extends WebPluginBrowserContext {
  readonly workspace: WebPluginWorkspace;
  refreshWorkspace(): Promise<boolean>;
  openFeature(featureId: string): boolean;
}
