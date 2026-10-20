import type { CommandRunner, StreamingCommandRunner } from "../types.js";
import type { WorkspaceRuntime, WorkspaceService, CreateWorkspaceInput } from "./service.js";
import type { WorkspaceStore } from "./store.js";
import type { AcquiredWorkspaceSource, WorkspaceRecord } from "./models.js";

/** Named code contributions from explicitly enabled host plugins. */
export interface HostPluginExtension {
  readonly kind: string;
  readonly name: string;
  readonly value: object;
}
export interface WorkspaceSourceCreateInput extends CreateWorkspaceInput {
  readonly repositories?: readonly string[];
  readonly workingDirectory?: string;
}
export interface WorkspaceSourceProviderContext extends WorkspaceRuntimeFactoryContext {
  readonly store: WorkspaceStore;
  readonly signal: AbortSignal;
  readonly runtime?: WorkspaceRuntime;
  readonly validateCheckout?: (directory: string, source: AcquiredWorkspaceSource) => Promise<void>;
}

/** Host composition supplies capabilities; optional integrations own their implementations. */
export interface WorkspaceRuntimeFactoryContext {
  readonly runner: StreamingCommandRunner;
  readonly cleanupRunner: CommandRunner;
  readonly stateRoot: string;
  readonly extensions?: readonly HostPluginExtension[];
}

export interface HostExecutionRouting {
  readonly network: string;
  readonly blockedHostnames: readonly string[];
  readonly dockerDaemonConfig: string;
  readonly jobFiles?: readonly { readonly target: string; readonly contents: string }[];
  readonly jobEnvironmentDefaults?: Readonly<Record<string, string>>;
}

export interface WorkspaceHostPluginContext extends WorkspaceSourceProviderContext {
  executionRouting?(): Promise<HostExecutionRouting | undefined>;
  readonly signal: AbortSignal;
  readonly service: WorkspaceService;
  readonly store: WorkspaceStore;
  /** Disposable verification cleanup has a fresh bounded lifetime after caller cancellation. */
  cleanupWorkspace?(name: string, workspaceId?: string): Promise<void>;
  hostGateway?(workspace: WorkspaceRecord): Promise<string>;
}

/** An installed module exports `hostPlugin`. Loading and command routing belong to the host CLI. */
export interface WorkspaceHostPlugin {
  readonly name: string;
  readonly extensions?: readonly HostPluginExtension[];
  readonly source?: {
    readonly schemes: readonly string[];
    create(input: WorkspaceSourceCreateInput, context: WorkspaceSourceProviderContext): Promise<WorkspaceRecord>;
    ensure?(workspace: WorkspaceRecord, context: WorkspaceSourceProviderContext): Promise<void>;
  };
  workspaceMetadata?(workspace: WorkspaceRecord, context: WorkspaceRuntimeFactoryContext): Promise<{ projectId: string; projectName: string } | undefined>;
  readonly runtime?: {
    readonly name: string;
    readonly defaultImage?: string;
    create(context: WorkspaceRuntimeFactoryContext): WorkspaceRuntime | Promise<WorkspaceRuntime>;
  };
  /** Optional host execution routing; absent configuration must return undefined. */
  executionRouting?(context: WorkspaceRuntimeFactoryContext & { readonly signal: AbortSignal }): Promise<HostExecutionRouting | undefined>;
  readonly commands?: readonly { readonly name: string; readonly description: string }[];
  run?(args: string[], context: WorkspaceHostPluginContext): Promise<void>;
  workspaceReady?(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<void>;
  /** Guest clients belong to this plugin; transport supplies the immutable caller. */
  guest?: {
    readonly description: string;
    readonly commands?: readonly { readonly name: string; readonly description: string }[];
    readonly operations?: readonly {
      readonly name: string;
      readonly description: string;
      handle(input: unknown, workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<unknown>;
    }[];
    inspect?(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<{
      readonly state: "ready" | "unconfigured";
      readonly message?: string;
    }>;
  };
}
