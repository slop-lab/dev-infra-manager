import type { CommandRunner, StreamingCommandRunner } from "../types.js";
import type { WorkspaceRuntime, WorkspaceService } from "./service.js";
import type { WorkspaceStore } from "./store.js";
import type { WorkspaceRecord } from "./models.js";

/** Host composition supplies capabilities; optional integrations own their implementations. */
export interface WorkspaceRuntimeFactoryContext {
  readonly runner: StreamingCommandRunner;
  readonly cleanupRunner: CommandRunner;
  readonly stateRoot: string;
}

export interface WorkspaceHostPluginContext extends WorkspaceRuntimeFactoryContext {
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
  readonly runtime?: {
    readonly name: string;
    readonly defaultImage?: string;
    create(context: WorkspaceRuntimeFactoryContext): WorkspaceRuntime | Promise<WorkspaceRuntime>;
  };
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
