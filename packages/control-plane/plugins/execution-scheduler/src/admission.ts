import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionAssignment } from "@slop-lab/dim-contracts-ci/aggregate";
import type { ExecutionStore } from "./store.js";
import type { ServerResponse } from "node:http";
import { GitExecutionAuthorityError, StaleExecutionSourceError, type ExecutionSource } from "./ci-source.js";

export const schedulerAdmissionTimeoutMilliseconds = 40_000;

export async function runAdmission<T>(input: {
  readonly store: ExecutionStore; readonly assignment: ExecutionAssignment; readonly granted: boolean;
  readonly signal: AbortSignal; readonly operation: (signal: AbortSignal) => Promise<T>;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  const stopped = new AbortController();
  const signal = AbortSignal.any([input.signal, stopped.signal, AbortSignal.timeout(schedulerAdmissionTimeoutMilliseconds)]);
  const renew = () => input.granted
    ? input.store.renew(input.assignment.id, input.assignment.workerId, input.assignment.slotId, input.assignment.leaseToken)
    : input.store.renewAdmission(input.assignment.id, input.assignment.workerId, input.assignment.slotId, input.assignment.leaseToken);
  renew();
  const renewals = (async () => {
    while (!stopped.signal.aborted) {
      try {
        const milliseconds = Math.max(10, Math.floor(input.store.leaseMilliseconds / 3));
        if (input.wait === undefined) await delay(milliseconds, undefined, { signal: stopped.signal });
        else await input.wait(milliseconds, stopped.signal);
        renew();
      }
      catch (error) { if (!stopped.signal.aborted) stopped.abort(error); return; }
    }
  })();
  try { const result = await input.operation(signal); signal.throwIfAborted(); renew(); return result; }
  finally { stopped.abort(); await renewals; }
}
export function admissionSignal(response: ServerResponse, shutdown: AbortSignal, cancellation: AbortSignal): AbortSignal {
  const disconnected = new AbortController();
  response.once("close", () => { if (!response.writableEnded) disconnected.abort(); });
  return AbortSignal.any([shutdown, cancellation, disconnected.signal]);
}
export function sendAdmissionFailure(response: ServerResponse, error: unknown): boolean {
  if (!(error instanceof GitExecutionAuthorityError)) return false;
  response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error: "execution admission failed", admission: { phase: error.phase, code: error.code } }));
  return true;
}

export function createAdmissionController(store: ExecutionStore, shutdown: AbortSignal) {
  const active = new Map<string, AbortController>();
  const authorizations = new Map<string, Promise<ExecutionAssignment>>();
  return {
    cancel(id: string): void { active.get(id)?.abort(); },
    async authorize(assignment: ExecutionAssignment, source: ExecutionSource, response: ServerResponse): Promise<ExecutionAssignment> {
      const existing = authorizations.get(assignment.id);
      if (existing !== undefined) return existing;
      const cancellation = new AbortController(); active.set(assignment.id, cancellation);
      const authorization = (async () => {
        const grant = await runAdmission({ store, assignment, granted: false,
          signal: admissionSignal(response, shutdown, cancellation.signal), operation: (signal) => source.authorize(assignment, signal) });
        return store.attachGrant(assignment.id, grant);
      })().catch((error: unknown) => {
        if (error instanceof StaleExecutionSourceError) {
          store.recordAdmission(assignment.id, { phase: "authorize", code: "stale" }); store.reject(assignment.id);
        } else if (error instanceof GitExecutionAuthorityError && store.find(assignment.id)?.phase === "assigned") {
          store.releaseAdmission(assignment.id, { phase: "authorize", code: error.code });
        }
        throw error;
      });
      authorizations.set(assignment.id, authorization);
      try { return await authorization; }
      finally { authorizations.delete(assignment.id); active.delete(assignment.id); }
    },
    async candidate(assignment: ExecutionAssignment, source: ExecutionSource, response: ServerResponse) {
      const grant = assignment.grant;
      if (grant === undefined) throw new Error("execution has no grant");
      const cancellation = new AbortController(); active.set(assignment.id, cancellation);
      try {
        return await runAdmission({ store, assignment, granted: true,
          signal: admissionSignal(response, shutdown, cancellation.signal), operation: (signal) => source.candidate(grant, signal) });
      } catch (error) {
        if (error instanceof StaleExecutionSourceError) store.recordAdmission(assignment.id, { phase: "candidate-read", code: "stale" });
        else if (error instanceof GitExecutionAuthorityError) store.recordAdmission(assignment.id, { phase: "candidate-read", code: error.code });
        throw error;
      } finally { active.delete(assignment.id); }
    }
  };
}
