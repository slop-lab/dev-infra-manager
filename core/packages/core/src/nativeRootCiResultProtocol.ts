import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { UserError } from "./errors.js";
import {
  parseNativeTerminalEvent,
  type NativeTerminalEvent
} from "./nativeOrdinaryResultProtocol.js";

export type NativeRootCiTerminalEvent = Omit<NativeTerminalEvent, "schemaVersion" | "payload"> & {
  readonly schemaVersion: 3;
  readonly payload: NativeTerminalEvent["payload"] & {
    readonly executionKind: "ordinary-sysbox";
  };
};

export type NativeRootCiHostResultRequest = {
  readonly schemaVersion: 2;
  readonly requestId: string;
  readonly generationId: string;
  readonly claimId: string;
  readonly resourceId: string;
  readonly terminalEvent: NativeRootCiTerminalEvent;
  readonly cleanupComplete: true;
};

export type NativeRootCiStatusAcknowledgement = NativeRootCiTerminalEvent & {
  readonly statusId: string;
  readonly reviewId: string;
  readonly reporterUsername: string;
  readonly reportedAt: string;
};

export function parseNativeRootCiHostResultRequest(value: unknown): NativeRootCiHostResultRequest {
  const input = exactRecord(value, [
    "schemaVersion", "requestId", "generationId", "claimId", "resourceId", "terminalEvent", "cleanupComplete"
  ]);
  if (input.schemaVersion !== 2) throw new UserError("native root CI host result schemaVersion must be 2");
  if (input.cleanupComplete !== true) throw new UserError("native root CI host result requires completed cleanup");
  const claimId = uuid(input.claimId, "claim ID");
  const resourceId = uuid(input.resourceId, "resource ID");
  if (resourceId !== claimId) throw new UserError("native root CI cleanup resource must match the claim");
  return {
    schemaVersion: 2,
    requestId: uuid(input.requestId, "request ID"),
    generationId: generation(input.generationId),
    claimId,
    resourceId,
    terminalEvent: parseNativeRootCiTerminalEvent(input.terminalEvent),
    cleanupComplete: true
  };
}

export function parseNativeRootCiTerminalEvent(value: unknown): NativeRootCiTerminalEvent {
  const input = exactRecord(value, ["schemaVersion", "eventId", "occurredAt", "eventType", "payload"]);
  if (input.schemaVersion !== 3) throw new UserError("native root CI terminal event schemaVersion must be 3");
  const payload = exactRecord(input.payload, [
    "executionKind", "reviewId", "attemptId", "attempt", "descriptor", "descriptorDigest", "hostId", "capacity",
    "startedAt", "finishedAt", "result", "completion", "stdout", "stderr"
  ]);
  if (payload.executionKind !== "ordinary-sysbox") {
    throw new UserError("native root CI terminal event execution kind is invalid");
  }
  const parsed = parseNativeTerminalEvent({
    schemaVersion: 2,
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    eventType: input.eventType,
    payload: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "executionKind"))
  });
  return { ...parsed, schemaVersion: 3, payload: { executionKind: "ordinary-sysbox", ...parsed.payload } };
}

export function parseNativeRootCiStatusAcknowledgement(
  value: unknown,
  event: NativeRootCiTerminalEvent,
  reporterUsername: string
): NativeRootCiStatusAcknowledgement {
  const input = exactRecord(value, [
    "schemaVersion", "eventId", "occurredAt", "eventType", "payload",
    "statusId", "reviewId", "reporterUsername", "reportedAt"
  ]);
  const acknowledged = parseNativeRootCiTerminalEvent({
    schemaVersion: input.schemaVersion,
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    eventType: input.eventType,
    payload: input.payload
  });
  const reviewId = lowercaseHex(input.reviewId, 64, "review ID");
  const statusId = lowercaseHex(input.statusId, 64, "status ID");
  const reportedAt = timestamp(input.reportedAt, "report time");
  if (input.reporterUsername !== reporterUsername || reviewId !== event.payload.reviewId
    || !isDeepStrictEqual(acknowledged, event)) {
    throw new UserError("native root CI status acknowledgement does not match the terminal event");
  }
  const identity = { ...event, reviewId, reporterUsername };
  const expectedStatusId = createHash("sha256").update(JSON.stringify(canonicalValue(identity)), "utf8").digest("hex");
  if (statusId !== expectedStatusId) throw new UserError("native root CI status acknowledgement identity is invalid");
  return { ...acknowledged, statusId, reviewId, reporterUsername, reportedAt };
}

export function nativeRootCiTerminalEventDigest(event: NativeRootCiTerminalEvent): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(event)), "utf8").digest("hex")}`;
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new UserError("request body has invalid fields");
  }
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}

function generation(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new UserError("generation ID is invalid");
  }
  return value;
}

function lowercaseHex(value: unknown, length: number, label: string): string {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new UserError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new UserError(`${label} is invalid`);
  }
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(Reflect.get(value, key))]));
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new UserError(`${label} is invalid`);
  }
  return value;
}
