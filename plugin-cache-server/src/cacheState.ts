import path from "node:path";
import { MissingRecordError, acquireLifecycleLock, atomicWrite, readJson } from "@slop-lab/dim-core";
import { parseHostMirrorOwnership, type HostMirrorOwnership } from "./hostMirrorOwnership.js";
/** The optional mirror service owns cache identity and reconciliation locks. */
export class MirrorState {
  constructor(readonly root: string, readonly namespace = "dim-cache") {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(namespace)) throw new Error("invalid host cache namespace");
  }
  hostMirrorOwnershipPath(): string { return path.join(this.root, "services", `cache-${this.namespace}.json`); }
  async readHostMirrorOwnership(): Promise<HostMirrorOwnership | undefined> {
    try { return parseHostMirrorOwnership(await readJson<unknown>(this.hostMirrorOwnershipPath(), "host mirror ownership state not found")); }
    catch (error) { if (error instanceof MissingRecordError) return undefined; throw error; }
  }
  async writeHostMirrorOwnership(record: HostMirrorOwnership): Promise<void> { await atomicWrite(this.hostMirrorOwnershipPath(), record); }
  acquireCacheLock(): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: `host-cache-${this.namespace}`, description: "host mirror reconciliation" });
  }
}
