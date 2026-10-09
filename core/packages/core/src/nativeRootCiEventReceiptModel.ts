import { createHash } from "node:crypto";
import {
  canonicalNativeRootCiReviewEvent,
  parseNativeRootCiReviewEvent,
  type NativeRootCiReviewEvent
} from "./nativeRootCiReviewEvent.js";

const fields = ["schemaVersion", "generationId", "admissionGeneration", "event"] as const;
const generationPattern = /^[0-9a-f]{64}$/;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type NativeRootCiEventReceiptRequest = {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly admissionGeneration: string;
  readonly event: NativeRootCiReviewEvent;
  readonly canonicalEvent: string;
  readonly eventDigest: string;
};

export function parseNativeRootCiEventReceiptRequest(value: unknown): NativeRootCiEventReceiptRequest {
  const input = exactRecord(value);
  if (input.schemaVersion !== 1 || typeof input.generationId !== "string"
    || !generationPattern.test(input.generationId) || typeof input.admissionGeneration !== "string"
    || !uuidV4Pattern.test(input.admissionGeneration)) invalid();
  let event: NativeRootCiReviewEvent;
  try { event = parseNativeRootCiReviewEvent(input.event); }
  catch (error) {
    if (error instanceof Error && error.name === "NativeRootCiReviewEventError") invalid();
    throw error;
  }
  const canonicalEvent = canonicalNativeRootCiReviewEvent(event);
  return { schemaVersion: 1, generationId: input.generationId,
    admissionGeneration: input.admissionGeneration, event, canonicalEvent,
    eventDigest: `sha256:${createHash("sha256").update(canonicalEvent).digest("hex")}` };
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}

function invalid(): never { throw new NativeRootCiEventReceiptRequestError(); }

export class NativeRootCiEventReceiptRequestError extends Error {
  readonly name = "NativeRootCiEventReceiptRequestError";
  constructor() { super("native root CI event receipt request is invalid"); }
}
