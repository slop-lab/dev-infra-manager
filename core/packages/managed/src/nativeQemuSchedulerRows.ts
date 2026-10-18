import type { NativeQemuAttempt } from "./nativeQemuAuthorityClient.js";
import { parseNativeQemuReviewEvent, type NativeQemuReviewEvent } from "./nativeQemuReviewEvent.js";
import { parseNativeQemuTerminalEvent, type NativeQemuTerminalEvent } from "./nativeQemuTerminalEvent.js";

export type NativeQemuCompletion = { readonly claimId: string; readonly cleanupComplete: boolean;
  readonly eventId: string; readonly result: "success" | "failure" | "cancelled";
  readonly terminalEvent: NativeQemuTerminalEvent };

export function parseCompletion(serialized: string): NativeQemuCompletion {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const claimId = Reflect.get(value, "claimId");
  const cleanupComplete = Reflect.get(value, "cleanupComplete");
  const eventId = Reflect.get(value, "eventId");
  const result = Reflect.get(value, "result");
  const terminalEvent = Reflect.get(value, "terminalEvent");
  if (Object.keys(value).length !== 5 || typeof claimId !== "string" || cleanupComplete !== true
    || typeof eventId !== "string" || (result !== "success" && result !== "failure" && result !== "cancelled")
    || typeof terminalEvent !== "object" || terminalEvent === null || Array.isArray(terminalEvent)) invalid();
  return { claimId, cleanupComplete: true, eventId, result,
    terminalEvent: parseNativeQemuTerminalEvent(terminalEvent) };
}

export function parseEvent(serialized: string): NativeQemuReviewEvent {
  return parseNativeQemuReviewEvent(JSON.parse(serialized));
}

export function parseAttempt(serialized: string): NativeQemuAttempt {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== 3 || !["attemptId", "descriptorDigest", "descriptor"]
      .every((field) => Object.hasOwn(value, field))) invalid();
  const attemptId = Reflect.get(value, "attemptId");
  const descriptorDigest = Reflect.get(value, "descriptorDigest");
  const descriptor = Reflect.get(value, "descriptor");
  if (typeof attemptId !== "string" || typeof descriptorDigest !== "string"
    || typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId)
    || !/^sha256:[0-9a-f]{64}$/.test(descriptorDigest)) invalid();
  return { attemptId, descriptorDigest,
    descriptor: Object.fromEntries(Object.keys(descriptor).map((key) => [key, Reflect.get(descriptor, key)])) };
}

export function text(row: unknown, key: string): string {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, key) : undefined;
  if (typeof value !== "string") invalid();
  return value;
}
export function nullableText(row: unknown, key: string): string | undefined {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, key) : undefined;
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") invalid();
  return value;
}
export function optionalText(row: unknown, key: string, output: string): Readonly<Record<string, string>> {
  const value = nullableText(row, key);
  return value === undefined ? {} : { [output]: value };
}
export function number(row: unknown, key: string): number {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, key) : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid();
  return value;
}
export function stringArray(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) invalid();
  return parsed;
}
function invalid(): never { throw new NativeQemuSchedulerStoreError("native QEMU state is invalid"); }
export class NativeQemuSchedulerStoreError extends Error { readonly name = "NativeQemuSchedulerStoreError"; }
