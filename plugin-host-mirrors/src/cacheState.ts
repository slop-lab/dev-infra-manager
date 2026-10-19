import path from "node:path";
import { MissingRecordError, acquireLifecycleLock, atomicWrite, readJson } from "@slop-lab/dim-core";
import { parseHostMirrorOwnership, type HostMirrorOwnership } from "./hostMirrorOwnership.js";
import type { HostMirrorImages } from "./hostMirrorProvider.js";

export interface MirrorOptions { readonly stateRoot: string; readonly hostMirrorProvider?: HostMirrorImages }
export interface MirrorRouting {
  readonly network: string;
  readonly dockerDaemonConfig: string;
  readonly blockedHostnames: readonly string[];
  readonly aptEndpoint: string;
  readonly jobFiles?: readonly { readonly target: string; readonly contents: string }[];
}

/** The optional mirror service owns cache identity and reconciliation locks. */
export class MirrorState {
  constructor(readonly root: string) {}
  hostMirrorOwnershipPath(): string { return path.join(this.root, "services", "host-mirrors.json"); }
  async readHostMirrorOwnership(): Promise<HostMirrorOwnership | undefined> {
    try { return parseHostMirrorOwnership(await readJson<unknown>(this.hostMirrorOwnershipPath(), "host mirror ownership state not found")); }
    catch (error) { if (error instanceof MissingRecordError) return undefined; throw error; }
  }
  async writeHostMirrorOwnership(record: HostMirrorOwnership): Promise<void> { await atomicWrite(this.hostMirrorOwnershipPath(), record); }
  acquireRegistryCacheLock(): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: "registry-cache", description: "host mirror reconciliation" });
  }
}
