import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface ArtifactIdentity { device: string; inode: string; }
export interface FileIdentity extends ArtifactIdentity { path: string; }
export interface OwnerRecord {
  schema: 2; argv: string[]; cwd: FileIdentity; executable: FileIdentity;
  pid: string; pidNamespace: ArtifactIdentity; socket: ArtifactIdentity; startTicks: string;
}
export interface OwnedFingerprint {
  state: 'live' | 'dead'; pid: string; startTicks: string; owner: ArtifactIdentity; socket: ArtifactIdentity;
}
export type InspectedOwner = { state: 'absent'; record?: never; owner?: never; socket?: never }
  | { state: 'live' | 'dead'; record: OwnerRecord; owner: ArtifactIdentity; socket: ArtifactIdentity };
export interface Input { name: string; path: string; }
export interface EventResponse {
  off(event: "drain", listener: () => void): unknown;
  once(event: "drain" | "close" | "error", listener: () => void): unknown;
  write(chunk: string | Uint8Array): boolean;
  end(): unknown;
  destroy(): unknown;
}
export interface EventFollower { end(): void; write(chunk: string | Uint8Array): void; }
export type FinalizationReason = 'closed' | 'rejected' | 'cancelled';
export interface Run {
  abort: AbortController; cancelled: boolean;
  child?: ChildProcess | undefined; childClosed?: Promise<void> | undefined;
  closeResult?: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  completion?: Promise<void> | undefined; finalizationRequested: boolean;
  resolveFinalization(reason: FinalizationReason): void;
  listeners: Set<EventFollower>; output: string;
  request?: IncomingMessage | undefined; response?: ServerResponse | undefined;
  cleanupOwner?: 'fatal' | 'ordinary' | undefined; handoffRoot?: string | undefined;
  preserveEvidence: boolean; snapshotRoot?: string | undefined; work?: Promise<Input[]> | undefined;
  stopPromise?: Promise<void> | undefined; groupPid?: number | undefined;
  state: { status: 'running' | 'success' | 'failure' | 'cancelled'; startedAt: string;
    inputs: string[]; verbose: boolean; mode: 'run' | 'probe';
    completedAt?: string; exitCode?: number | undefined; signal?: NodeJS.Signals | null | undefined; };
}
export interface ServicePaths {
  serviceDirectory: string; pidPath: string; ownerPath: string; socketPath: string; leasePath: string; runsRoot: string;
}
export interface ServiceConfig extends ServicePaths { server: Server; onRuntimeError(error: Error): void; }
export interface ListenerState { server: Server; socketPath: string; socketIdentity?: ArtifactIdentity | undefined; }
export interface CleanupState extends ListenerState {
  ownerPath: string; runsRoot: string; ownerIdentity?: ArtifactIdentity | undefined; removeRunsRoot?: boolean;
}
export type ProcessGroupRun = Pick<Run, 'groupPid' | 'stopPromise' | 'childClosed'>;
export type FatalRun = Pick<Run, 'preserveEvidence' | 'abort' | 'request' | 'response'>;
export interface FinalizableRun extends ProcessGroupRun, FatalRun, Pick<Run, "cancelled" | "closeResult"> {
  work?: Promise<Input[]> | undefined; cleanupOwner?: 'fatal' | 'ordinary' | undefined;
  handoffRoot?: string | undefined; snapshotRoot?: string | undefined;
  state: { status: string; exitCode?: number | undefined; signal?: NodeJS.Signals | null | undefined; completedAt?: string };
  listeners: Set<Pick<EventFollower, 'end'>>;
}
export type QuiesceRun = ProcessGroupRun & FatalRun & Pick<Run, 'work' | 'completion' | 'finalizationRequested'>;
