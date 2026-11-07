import { timingSafeEqual } from "node:crypto";
import { executionCapacityPlanSchema, executionCapacityRequestSchema, ExecutionConflictError,
  type ExecutionCapacityProvider } from "@slop-lab/dim-contracts-execution";
import { z } from "zod";
import type { ExecutionServiceConfig } from "./config.js";
import type { ExecutionStore, ScheduledExecution } from "./store.js";
import type { WorkerRegistry } from "./worker-registry.js";

const stateSchema = z.object({ revision: z.number().int().nonnegative(), state: z.enum(["stopped", "starting", "running", "draining"]),
  since: z.number().int().nonnegative(), idleSince: z.number().int().nonnegative().optional(), retryAt: z.number().int().nonnegative().optional() }).strict();
type State = z.infer<typeof stateSchema>;
type Slot = ReturnType<WorkerRegistry["workers"]>[number]["slots"][number];
/** Scheduling only: fixed identities/profiles and reservation costs are trusted operator inputs. */
export class ExecutionCapacity {
  constructor(private readonly store: ExecutionStore, private readonly registry: WorkerRegistry,
    private readonly config: ExecutionServiceConfig, private readonly generation: string) {
    for (const provider of config.capacityProviders ?? []) for (const member of provider.members) {
      const key = this.ownerKey(member.workerId), previous = store.database.prepare("SELECT value FROM metadata WHERE key=?").get(key);
      if (previous && previous.value !== provider.id) throw new Error("capacity worker belongs to another provider in this generation");
      store.database.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)").run(key, provider.id);
    }
  }
  provider(header: string | undefined): ExecutionCapacityProvider | undefined {
    if (!header?.startsWith("Basic ")) return;
    const value = Buffer.from(header.slice(6), "base64").toString("utf8"), at = value.indexOf(":");
    if (at < 1) return;
    return (this.config.capacityProviders ?? []).find(p => p.id === value.slice(0, at) && equal(p.token, value.slice(at + 1)));
  }
  allowsClaim(workerId: string, slotId: string, requestId: string): boolean {
    const provider = (this.config.capacityProviders ?? []).find(p => p.members.some(m => m.workerId === workerId));
    if (!provider) return !this.hasOwner(workerId) || this.store.occupiedSlots().some(job =>
      job.workerId === workerId && job.slotId === slotId && job.requestId === requestId);
    const state = this.load(provider, workerId);
    // A draining worker may recover its exact journal, but cannot reserve new queued work.
    return this.fresh(provider) && (state.state === "starting" || state.state === "running") || this.store.occupiedSlots().some(job =>
      job.workerId === workerId && job.slotId === slotId && job.requestId === requestId);
  }
  available(workerId: string): boolean {
    const provider = (this.config.capacityProviders ?? []).find(p => p.members.some(m => m.workerId === workerId));
    return provider ? this.fresh(provider) && ["starting", "running"].includes(this.load(provider, workerId).state) : !this.hasOwner(workerId);
  }
  reconcile(provider: ExecutionCapacityProvider, raw: unknown) {
    const request = executionCapacityRequestSchema.parse(raw), observations = new Map(request.observations.map(o => [o.workerId, o]));
    if (observations.size !== request.observations.length || observations.size !== provider.members.length
      || provider.members.some(m => !observations.has(m.workerId))) throw new ExecutionConflictError("capacity observations must cover only this provider's exact pool");
    const workers = this.registry.workers();
    const selected = provider.members.map(member => {
      const worker = workers.find(w => w.workerId === member.workerId);
      if (!worker) throw new ExecutionConflictError("capacity pool worker is not pre-enrolled");
      // Every CI slot must fit its operator reservation; tasks use explicit operator costs.
      for (const dimension of ["cpu", "memoryBytes", "pids"] as const) {
        const cost = worker.slots.reduce((sum, slot) => sum + ("runtime" in slot ? BigInt(slot.profile.bounds[dimension]) : 0n), 0n);
        if (cost > BigInt(member.cost[dimension])) throw new ExecutionConflictError("capacity worker profile exceeds its fixed reservation cost");
      }
      return worker;
    });
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      this.store.database.prepare("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(this.heartbeatKey(provider), String(this.store.now()));
      const now = this.store.now(), occupied = this.store.occupiedSlots();
      // Retain at most one queued representative per configured slot, not the whole queue.
      const demandSlots = workers.flatMap(worker => [...worker.slots]), queued: ScheduledExecution[] = [];
      for (const row of this.store.database.prepare("SELECT id FROM executions WHERE phase='queued' AND generation_id=? ORDER BY created_at,rowid").iterate(this.generation)) {
        const job = this.store.get(String(row.id)), index = demandSlots.findIndex(slot => matches(job, slot, this.store));
        if (index >= 0) { queued.push(job); demandSlots.splice(index, 1); }
        if (demandSlots.length === 0) break;
      }
      const states = new Map(selected.map(w => [w.workerId, this.load(provider, w.workerId)]));
      for (const worker of selected) {
        const observation = observations.get(worker.workerId)!, state = states.get(worker.workerId)!;
        const busy = occupied.some(job => job.workerId === worker.workerId);
        if ((observation.state === "failed" || observation.state === "stopped" && observation.clean && !busy && state.state !== "starting") && state.state !== "stopped") {
          states.set(worker.workerId, transition(state, "stopped", now, { retryAt: now + provider.failureBackoffMilliseconds }));
        } else if (state.state === "starting" && observation.state === "running" && this.registry.observed(worker.workerId)) {
          states.set(worker.workerId, transition(state, "running", now));
        } else if (state.state === "starting" && now - state.since >= provider.startMilliseconds) {
          states.set(worker.workerId, transition(state, "draining", now));
        }
      }
      if (request.drain) for (const [id, state] of states) {
        if (state.state === "starting" || state.state === "running") states.set(id, transition(state, "draining", now));
      }
      // Account for compatible free slots in other pools/static workers before requesting capacity.
      for (const worker of workers) {
        if (states.has(worker.workerId)) continue;
        const otherPool = (this.config.capacityProviders ?? []).find(p => p.members.some(m => m.workerId === worker.workerId));
        const planned = otherPool && this.fresh(otherPool) && ["starting", "running"].includes(this.load(otherPool, worker.workerId).state);
        if (!planned && !(this.registry.observed(worker.workerId) && this.available(worker.workerId))) continue;
        for (const slot of worker.slots) if (!occupied.some(job => job.workerId === worker.workerId && job.slotId === slot.id)) take(queued, slot, this.store);
      }
      // Keep already-started capacity first; idle hysteresis prevents queue churn from respawning it.
      for (const worker of selected) {
        let state = states.get(worker.workerId)!;
        const observation = observations.get(worker.workerId)!, busy = occupied.some(job => job.workerId === worker.workerId);
        if (!["starting", "running"].includes(state.state)) continue;
        let needed = busy;
        for (const slot of worker.slots) if (!occupied.some(job => job.workerId === worker.workerId && job.slotId === slot.id)) needed = take(queued, slot, this.store) || needed;
        if (needed) { delete state.idleSince; }
        else {
          state.idleSince ??= now;
          if (now - state.idleSince >= provider.idleMilliseconds) state = transition(state, "draining", now);
        }
        states.set(worker.workerId, state);
      }
      let starting = [...states.values()].filter(s => s.state === "starting").length;
      for (const worker of selected) {
        const state = states.get(worker.workerId)!, observation = observations.get(worker.workerId)!;
        if (request.drain || state.state !== "stopped" || observation.state === "running" || starting >= provider.maximumStarting || (state.retryAt ?? 0) > now) continue;
        const recovery = !observation.clean || occupied.some(job => job.workerId === worker.workerId);
        const compatible = worker.slots.some(slot => queued.some(job => matches(job, slot, this.store)));
        if (recovery || compatible) {
          states.set(worker.workerId, transition(state, "starting", now)); starting++;
          for (const slot of worker.slots) take(queued, slot, this.store);
        }
      }
      const plan = executionCapacityPlanSchema.parse({ schemaVersion: 1, generationId: this.generation, providerId: provider.id,
        workers: selected.map(worker => {
          const state = states.get(worker.workerId)!, observation = observations.get(worker.workerId)!;
          this.save(provider, worker.workerId, state);
          const busy = occupied.some(job => job.workerId === worker.workerId);
          return { workerId: worker.workerId, revision: state.revision, state: state.state,
            action: state.state === "starting" && observation.state !== "running" ? "start"
              : (state.state === "draining" || state.state === "stopped") && observation.state === "running" && !busy && observation.clean ? "stop" : "keep" };
        }) });
      this.store.database.exec("COMMIT"); return plan;
    } catch (error) { this.store.database.exec("ROLLBACK"); throw error; }
  }
  authorizeStop(provider: ExecutionCapacityProvider, raw: unknown): { allowed: true } {
    const input = z.object({ workerId: z.string(), revision: z.number().int().nonnegative() }).strict().parse(raw);
    if (!provider.members.some(member => member.workerId === input.workerId)) throw new ExecutionConflictError("worker is outside capacity pool");
    const state = this.load(provider, input.workerId);
    if (state.revision !== input.revision || !["stopped", "draining"].includes(state.state)
      || this.store.occupiedSlots().some(job => job.workerId === input.workerId)) throw new ExecutionConflictError("capacity stop plan is stale or worker is occupied");
    return { allowed: true };
  }
  private ownerKey(workerId: string): string { return `execution-scheduler/capacity-owner/${this.generation}/${workerId}`; }
  private hasOwner(workerId: string): boolean { return this.store.database.prepare("SELECT 1 FROM metadata WHERE key=?").get(this.ownerKey(workerId)) !== undefined; }
  private heartbeatKey(provider: ExecutionCapacityProvider): string { return `execution-scheduler/capacity-heartbeat/${this.generation}/${provider.id}`; }
  private fresh(provider: ExecutionCapacityProvider): boolean {
    const row = this.store.database.prepare("SELECT value FROM metadata WHERE key=?").get(this.heartbeatKey(provider));
    return row !== undefined && Number.isSafeInteger(Number(row.value)) && this.store.now() - Number(row.value) < provider.startMilliseconds;
  }
  private key(provider: ExecutionCapacityProvider, workerId: string): string { return `execution-scheduler/capacity/${this.generation}/${provider.id}/${workerId}`; }
  private load(provider: ExecutionCapacityProvider, workerId: string): State {
    const row = this.store.database.prepare("SELECT value FROM metadata WHERE key=?").get(this.key(provider, workerId));
    return row === undefined ? { revision: 0, state: "stopped", since: this.store.now() } : stateSchema.parse(JSON.parse(String(row.value)));
  }
  private save(provider: ExecutionCapacityProvider, workerId: string, state: State): void {
    this.store.database.prepare("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(this.key(provider, workerId), JSON.stringify(stateSchema.parse(state)));
  }
}
function transition(state: State, next: State["state"], now: number, extra: Partial<State> = {}): State { return { revision: state.revision + 1, state: next, since: now, ...extra }; }
function equal(a: string, b: string): boolean { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function matches(job: ScheduledExecution, slot: Slot, store: ExecutionStore): boolean {
  const kind = "taskType" in slot ? `task/${slot.taskType}` : slot.runtime === "container" ? "ordinary-sysbox" : "qemu";
  const profile = "taskType" in slot ? { taskType: slot.taskType, handlerRevision: slot.handlerRevision } : slot.profile;
  return job.event.executionKind === kind && store.codec.matchesProfile?.(job.event, profile) !== false;
}
function take(jobs: ScheduledExecution[], slot: Slot, store: ExecutionStore): boolean { const index = jobs.findIndex(job => matches(job, slot, store)); if (index < 0) return false; jobs.splice(index, 1); return true; }
