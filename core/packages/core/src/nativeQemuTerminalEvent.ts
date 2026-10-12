import { isDeepStrictEqual } from "node:util";
import type { NativeQemuAttempt } from "./nativeQemuAuthorityClient.js";
import type { NativeQemuClaim } from "./nativeQemuSchedulerStore.js";

type OutputEvidence = { readonly bytes: string; readonly sha256: string; readonly truncated: boolean };
type Completion = { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "signaled"; readonly signal: number }
  | { readonly kind: "timed-out" | "output-limit-exceeded" | "cancelled" };
export type NativeQemuTerminalEvent = {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly eventType: "dim.ci.job.completed";
  readonly payload: {
    readonly executionKind: "qemu";
    readonly evidenceClass: "candidate-controlled";
    readonly reviewId: string;
    readonly attemptId: string;
    readonly descriptor: Readonly<Record<string, unknown>>;
    readonly descriptorDigest: string;
    readonly hostId: string;
    readonly capacity: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly result: "success" | "failure" | "cancelled";
    readonly completion: Completion;
    readonly stdout: OutputEvidence;
    readonly stderr: OutputEvidence;
  };
};

export function parseNativeQemuTerminalEvent(value: unknown): NativeQemuTerminalEvent {
  const event = exact(value, ["schemaVersion", "eventId", "occurredAt", "eventType", "payload"]);
  const payload = exact(event.payload, ["executionKind", "evidenceClass", "reviewId", "attemptId", "descriptor",
    "descriptorDigest", "hostId", "capacity", "startedAt", "finishedAt", "result", "completion", "stdout", "stderr"]);
  if (event.schemaVersion !== 1 || event.eventType !== "dim.ci.job.completed" || payload.executionKind !== "qemu"
    || payload.evidenceClass !== "candidate-controlled") invalid();
  const result = terminalResult(payload.result);
  const completion = parseCompletion(payload.completion);
  if ((completion.kind === "exited" && completion.exitCode === 0 ? "success"
    : completion.kind === "cancelled" ? "cancelled" : "failure") !== result) invalid();
  const startedAt = timestamp(payload.startedAt);
  const finishedAt = timestamp(payload.finishedAt);
  if (Date.parse(startedAt) > Date.parse(finishedAt)) invalid();
  return { schemaVersion: 1, eventId: uuid(event.eventId), occurredAt: timestamp(event.occurredAt),
    eventType: "dim.ci.job.completed", payload: { executionKind: "qemu", evidenceClass: "candidate-controlled",
      reviewId: hex(payload.reviewId, 64), attemptId: uuid(payload.attemptId), descriptor: record(payload.descriptor),
      descriptorDigest: digest(payload.descriptorDigest), hostId: identifier(payload.hostId),
      capacity: identifier(payload.capacity), startedAt, finishedAt, result, completion,
      stdout: output(payload.stdout), stderr: output(payload.stderr) } };
}

export function terminalEventMatchesClaim(event: NativeQemuTerminalEvent, claim: NativeQemuClaim,
  attempt: NativeQemuAttempt): boolean {
  return event.payload.reviewId === claim.event.reviewId && event.payload.attemptId === attempt.attemptId
    && event.payload.descriptorDigest === attempt.descriptorDigest && event.payload.hostId === claim.hostId
    && event.payload.capacity === claim.capacity && isDeepStrictEqual(event.payload.descriptor, attempt.descriptor);
}

function parseCompletion(value: unknown): Completion {
  const completion = record(value);
  switch (completion.kind) {
    case "exited":
      exactKeys(completion, ["kind", "exitCode"]);
      return { kind: "exited", exitCode: bounded(completion.exitCode, 0, 255) };
    case "signaled":
      exactKeys(completion, ["kind", "signal"]);
      return { kind: "signaled", signal: bounded(completion.signal, 1, 64) };
    case "timed-out":
    case "output-limit-exceeded":
    case "cancelled":
      exactKeys(completion, ["kind"]);
      return { kind: completion.kind };
    default:
      return invalid();
  }
}
function output(value: unknown): OutputEvidence {
  const evidence = exact(value, ["bytes", "sha256", "truncated"]);
  if (typeof evidence.bytes !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(evidence.bytes)
    || typeof evidence.truncated !== "boolean") invalid();
  return { bytes: evidence.bytes, sha256: digest(evidence.sha256), truncated: evidence.truncated };
}
function terminalResult(value: unknown): "success" | "failure" | "cancelled" {
  if (value !== "success" && value !== "failure" && value !== "cancelled") invalid();
  return value;
}
function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const parsed = record(value); exactKeys(parsed, keys); return parsed;
}
function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
function matching(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(); return value;
}
function uuid(value: unknown): string { return matching(value,
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); }
function digest(value: unknown): string { return matching(value, /^sha256:[0-9a-f]{64}$/); }
function identifier(value: unknown): string { return matching(value, /^[a-z0-9][a-z0-9._-]{0,127}$/); }
function hex(value: unknown, length: number): string { return matching(value, new RegExp(`^[0-9a-f]{${length}}$`)); }
function timestamp(value: unknown): string {
  const parsed = matching(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  if (!Number.isFinite(Date.parse(parsed))) invalid(); return parsed;
}
function bounded(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function invalid(): never { throw new NativeQemuTerminalEventError("native QEMU terminal event is invalid"); }
export class NativeQemuTerminalEventError extends Error { readonly name = "NativeQemuTerminalEventError"; }
