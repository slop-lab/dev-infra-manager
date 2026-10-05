import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { UserError } from "./errors.js";
import { nativeDescriptorDigest, parseNativeDescriptor } from "./nativeOrdinaryAuthorityModel.js";
import type { NativeOrdinaryDescriptor } from "./nativeOrdinaryAuthorityProtocol.js";

export type NativeTerminalCompletion =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "signaled"; readonly signal: number }
  | { readonly kind: "timed-out" }
  | { readonly kind: "output-limit-exceeded" }
  | { readonly kind: "lease-lost" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "executor-failure"; readonly code: string };

type NativeOutputEvidence = {
  readonly bytes: string;
  readonly sha256: string;
  readonly truncated: boolean;
};

export type NativeTerminalEvent = {
  readonly schemaVersion: 2;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly eventType: "dim.ci.job.completed";
  readonly payload: {
    readonly reviewId: string;
    readonly attemptId: string;
    readonly attempt: number;
    readonly descriptor: NativeOrdinaryDescriptor;
    readonly descriptorDigest: string;
    readonly hostId: string;
    readonly capacity: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly result: "success" | "failure" | "cancelled";
    readonly completion: NativeTerminalCompletion;
    readonly stdout: NativeOutputEvidence;
    readonly stderr: NativeOutputEvidence;
  };
};

export type NativeHostResultRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly claimId: string;
  readonly terminalEvent: NativeTerminalEvent;
  readonly cleanupComplete: true;
};

export function parseNativeHostResultRequest(value: unknown): NativeHostResultRequest {
  const input = exactRecord(value, ["schemaVersion", "requestId", "claimId", "terminalEvent", "cleanupComplete"]);
  if (input.schemaVersion !== 1) throw new UserError("native host result schemaVersion must be 1");
  if (input.cleanupComplete !== true) throw new UserError("native host result requires completed cleanup");
  return {
    schemaVersion: 1,
    requestId: uuid(input.requestId, "request ID"),
    claimId: uuid(input.claimId, "claim ID"),
    terminalEvent: parseNativeTerminalEvent(input.terminalEvent),
    cleanupComplete: true
  };
}

export function parseNativeTerminalEvent(value: unknown): NativeTerminalEvent {
  const input = exactRecord(value, ["schemaVersion", "eventId", "occurredAt", "eventType", "payload"]);
  if (input.schemaVersion !== 2 || input.eventType !== "dim.ci.job.completed") {
    throw new UserError("native terminal event contract is invalid");
  }
  const payload = exactRecord(input.payload, [
    "reviewId", "attemptId", "attempt", "descriptor", "descriptorDigest", "hostId", "capacity",
    "startedAt", "finishedAt", "result", "completion", "stdout", "stderr"
  ]);
  const descriptor = parseNativeDescriptor(payload.descriptor);
  const descriptorDigest = digest(payload.descriptorDigest, "descriptor digest");
  if (nativeDescriptorDigest(descriptor) !== descriptorDigest) throw new UserError("native terminal descriptor digest is invalid");
  const completion = parseCompletion(payload.completion);
  if (payload.result !== "success" && payload.result !== "failure" && payload.result !== "cancelled") {
    throw new UserError("native terminal result is invalid");
  }
  const result = payload.result;
  if (result !== completionResult(completion)) throw new UserError("native terminal result is inconsistent");
  const startedAt = timestamp(payload.startedAt, "start time");
  const finishedAt = timestamp(payload.finishedAt, "finish time");
  if (Date.parse(startedAt) > Date.parse(finishedAt)) throw new UserError("native terminal completion precedes start");
  const stdout = parseOutput(payload.stdout);
  const stderr = parseOutput(payload.stderr);
  if (result === "success" && (stdout.truncated || stderr.truncated)) {
    throw new UserError("native terminal success requires complete output evidence");
  }
  if (BigInt(stdout.bytes) + BigInt(stderr.bytes) > BigInt(descriptor.bounds.outputBytes)) {
    throw new UserError("native terminal output exceeds descriptor bound");
  }
  return {
    schemaVersion: 2,
    eventId: uuid(input.eventId, "event ID"),
    occurredAt: timestamp(input.occurredAt, "occurrence time"),
    eventType: "dim.ci.job.completed",
    payload: {
      reviewId: hex(payload.reviewId, 64, "review ID"),
      attemptId: uuid(payload.attemptId, "attempt ID"),
      attempt: boundedNumber(payload.attempt, 1, Number.MAX_SAFE_INTEGER, "attempt"),
      descriptor,
      descriptorDigest,
      hostId: identifier(payload.hostId, "host ID"),
      capacity: identifier(payload.capacity, "capacity"),
      startedAt,
      finishedAt,
      result,
      completion,
      stdout,
      stderr
    }
  };
}

export function terminalEventJson(event: NativeTerminalEvent): string {
  return JSON.stringify(event);
}

export function terminalEventDigest(eventJson: string): string {
  return `sha256:${createHash("sha256").update(eventJson, "utf8").digest("hex")}`;
}

export function nativeStatusAcknowledged(value: unknown, event: NativeTerminalEvent, reporterUsername: string): boolean {
  const record = exactRecord(value, [
    "schemaVersion", "eventId", "occurredAt", "eventType", "payload",
    "statusId", "reviewId", "reporterUsername", "reportedAt"
  ]);
  const acknowledged = parseNativeTerminalEvent({
    schemaVersion: record.schemaVersion,
    eventId: record.eventId,
    occurredAt: record.occurredAt,
    eventType: record.eventType,
    payload: record.payload
  });
  const reviewId = hex(record.reviewId, 64, "review ID");
  const reportedAt = timestamp(record.reportedAt, "report time");
  const statusId = hex(record.statusId, 64, "status ID");
  if (record.reporterUsername !== reporterUsername || reviewId !== event.payload.reviewId
    || !isDeepStrictEqual(acknowledged, event)) return false;
  const identity = { ...event, reviewId, reporterUsername };
  return statusId === createHash("sha256").update(JSON.stringify(canonicalValue(identity)), "utf8").digest("hex")
    && reportedAt.length > 0;
}

function parseCompletion(value: unknown): NativeTerminalCompletion {
  const input = record(value);
  switch (input.kind) {
    case "exited":
      exactKeys(input, ["kind", "exitCode"]);
      return { kind: "exited", exitCode: boundedNumber(input.exitCode, 0, 255, "exit code") };
    case "signaled":
      exactKeys(input, ["kind", "signal"]);
      return { kind: "signaled", signal: boundedNumber(input.signal, 1, 64, "signal") };
    case "executor-failure":
      exactKeys(input, ["kind", "code"]);
      return { kind: "executor-failure", code: identifier(input.code, "executor failure code") };
    case "timed-out":
    case "output-limit-exceeded":
    case "lease-lost":
    case "cancelled":
      exactKeys(input, ["kind"]);
      return { kind: input.kind };
    default:
      throw new UserError("native terminal completion is invalid");
  }
}

function parseOutput(value: unknown): NativeOutputEvidence {
  const input = exactRecord(value, ["bytes", "sha256", "truncated"]);
  if (typeof input.truncated !== "boolean") throw new UserError("native terminal output truncation is invalid");
  return {
    bytes: text(input.bytes, /^(?:0|[1-9][0-9]*)$/, "output bytes"),
    sha256: digest(input.sha256, "output digest"),
    truncated: input.truncated
  };
}

function completionResult(completion: NativeTerminalCompletion): "success" | "failure" | "cancelled" {
  switch (completion.kind) {
    case "exited": return completion.exitCode === 0 ? "success" : "failure";
    case "cancelled": return "cancelled";
    case "signaled":
    case "timed-out":
    case "output-limit-exceeded":
    case "lease-lost":
    case "executor-failure": return "failure";
    default: return assertNever(completion);
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const input = record(value);
  exactKeys(input, keys);
  return input;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UserError("request body must be an object");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function exactKeys(input: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (Object.keys(input).length !== keys.length || keys.some((key) => input[key] === undefined)) {
    throw new UserError("request body has invalid fields");
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(Reflect.get(value, key))]));
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new UserError(`${label} is invalid`);
  return value;
}

const uuid = (value: unknown, label: string) => text(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, label);
const identifier = (value: unknown, label: string) => text(value, /^[a-z0-9][a-z0-9._-]{0,127}$/, label);
const digest = (value: unknown, label: string) => text(value, /^sha256:[0-9a-f]{64}$/, label);
const hex = (value: unknown, length: number, label: string) => text(value, new RegExp(`^[0-9a-f]{${length}}$`), label);
function timestamp(value: unknown, label: string): string {
  const parsed = text(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, label);
  if (!Number.isFinite(Date.parse(parsed))) throw new UserError(`${label} is invalid`);
  return parsed;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new UserError(`${label} is invalid`);
  return value;
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected terminal completion: ${JSON.stringify(value)}`);
}
