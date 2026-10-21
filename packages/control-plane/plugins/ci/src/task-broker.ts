import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ExecutionConflictError, isTaskExecution, taskEventSchema, type TaskExecution } from "@slop-lab/dim-task-scheduling";
import type { ExecutionStore } from "./store.js";

const submission = z.object({ requestId: z.string().uuid(), taskType: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  handlerRevision: z.string().regex(/^[0-9a-f]{64}$/), payload: z.unknown() }).strict();
type Exchange = { id: number; operation: string; input: unknown; reply?: unknown; answered: boolean;
  resolve(value: unknown): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> };
type Session = { readonly requests: Map<number, Exchange>; count: number; bytes: number; timer: ReturnType<typeof setTimeout> };
/** Ephemeral I/O channels are tied to durable leases, never resumed after restart. */
export function createTaskBroker(store: ExecutionStore) {
  const sessions = new Map<string, Session>();
  let retainedBytes = 0;
  function release(id: string) {
    const selected = sessions.get(id);
    if (selected === undefined) return;
    clearTimeout(selected.timer); rejectRequests(id); retainedBytes -= selected.bytes; sessions.delete(id);
  }
  function task(id: string): TaskExecution {
    const execution = store.get(id);
    if (!isTaskExecution(execution)) throw new ExecutionConflictError("execution is not a general task");
    return execution;
  }
  function session(id: string): Session {
    const value = sessions.get(id);
    if (value === undefined) throw new ExecutionConflictError("task exchange session is absent; re-evaluation required");
    return value;
  }
  function rejectRequests(id: string) {
    for (const request of sessions.get(id)?.requests.values() ?? []) {
      clearTimeout(request.timer); if (!request.answered) request.reject(new ExecutionConflictError("task exchange was cancelled"));
    }
  }
  return {
    submit(raw: unknown) {
      const value = submission.parse(raw);
      const event = taskEventSchema.parse({ eventId: value.requestId, executionKind: `task/${value.taskType}`, taskType: value.taskType,
        handlerRevision: value.handlerRevision, payload: value.payload });
      const previous = store.database.prepare("SELECT id FROM executions WHERE event_id=? AND generation_id=? AND retry_of IS NULL").get(event.eventId, store.generationId);
      const existing = previous === undefined ? undefined : store.get(String(previous.id));
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing.event, event) || !sessions.has(existing.id)) throw new ExecutionConflictError("task request cannot replace an existing session");
        return existing;
      }
      if (sessions.size >= 32) throw new ExecutionConflictError("task broker capacity is occupied");
      const job = store.enqueue(event);
      const timer = setTimeout(() => {
        try { const current = store.get(job.id); if (current.phase !== "finished") store.cancel(job.id); } catch { /* Lost authority cannot keep an I/O session alive. */ } finally { release(job.id); }
      }, 60_000);
      timer.unref();
      sessions.set(job.id, { requests: new Map(), count: 0, bytes: 0, timer }); return job;
    },
    poll(id: string) {
      const job = task(id), selected = session(id);
      const pending = [...selected.requests.values()].find((request) => !request.answered);
      return { phase: job.phase, ...(job.result === undefined || job.publication !== "accepted" ? {} : { result: job.result }),
        ...(pending === undefined ? {} : { request: { id: pending.id, operation: pending.operation, input: pending.input } }) };
    },
    reply(id: string, raw: unknown) {
      const value = z.object({ requestId: z.number().int().positive(), value: z.unknown() }).strict().parse(raw);
      const job = task(id), selected = session(id), pending = selected.requests.get(value.requestId);
      if (pending === undefined || job.phase !== "running" && job.phase !== "assigned" || job.cancelRequestedAt !== undefined || (job.leaseExpiresAt ?? 0) <= store.now()) throw new ExecutionConflictError("task exchange is no longer current");
      if (pending.answered) {
        if (!isDeepStrictEqual(pending.reply, value.value)) throw new ExecutionConflictError("task exchange reply conflicts");
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(value.value) ?? "null");
      if (bytes > 1_500_000 || selected.bytes + bytes > 24 * 1024 * 1024 || retainedBytes + bytes > 64 * 1024 * 1024) throw new ExecutionConflictError("task exchange exceeds bounds");
      selected.bytes += bytes; retainedBytes += bytes;
      pending.answered = true; pending.reply = value.value; clearTimeout(pending.timer); pending.resolve(value.value);
    },
    exchange(id: string, workerId: string, slotId: string, leaseToken: string, raw: unknown): Promise<unknown> {
      const value = z.object({ operation: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), input: z.unknown() }).strict().parse(raw);
      const job = task(id), selected = session(id);
      // Renewal checks active generation, cancellation, grant and lease expiry.
      store.renew(id, workerId, slotId, leaseToken);
      if (job.cancelRequestedAt !== undefined || selected.count >= 512 || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) throw new ExecutionConflictError("task exchange is unavailable");
      const inputBytes = Buffer.byteLength(JSON.stringify(value));
      if (selected.bytes + inputBytes > 24 * 1024 * 1024 || retainedBytes + inputBytes > 64 * 1024 * 1024) throw new ExecutionConflictError("task exchange exceeds bounds");
      selected.bytes += inputBytes; retainedBytes += inputBytes;
      const requestId = ++selected.count;
      return new Promise((resolve, reject) => {
        const pending: Exchange = { id: requestId, ...value, answered: false, resolve: (result) => {
          try { store.renew(id, workerId, slotId, leaseToken); resolve(result); } catch (reason) { reject(reason); }
        }, reject, timer: setTimeout(() => {
          pending.answered = true; reject(new ExecutionConflictError("task exchange timed out"));
        }, 10_000) };
        selected.requests.set(requestId, pending);
      });
    },
    assertCurrent(id: string) { session(id); task(id); },
    hasSession(id: string) { return sessions.has(id); },
    cancel(id: string) {
      const current = task(id);
      const result = current.phase === "finished" ? current : store.cancel(id);
      rejectRequests(id); if (result.phase === "finished") release(id); return result;
    },
    finish(id: string) { rejectRequests(id); if (task(id).cancelRequestedAt !== undefined) release(id); },
    release(id: string) {
      const job = task(id);
      if (job.phase !== "finished" || job.publication !== "accepted") throw new ExecutionConflictError("task must finish before its session is acknowledged");
      release(id);
    },
    close() { for (const id of [...sessions.keys()]) release(id); }
  };
}
