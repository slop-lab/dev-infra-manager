import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UserError } from "./errors.js";

const MAX_BODY_BYTES = 65_536;

export async function readPoolJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new UserError("request body is too large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) throw new UserError("request body must be valid JSON"); throw error; }
}

export function authorizedPoolRequest(request: IncomingMessage, token: string): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function poolRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UserError("request body must be an object");
  return value as Readonly<Record<string, unknown>>;
}

export function exactPoolKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => value[key] === undefined)) {
    throw new UserError("request body has invalid fields");
  }
}

export function poolIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new UserError(`${label} is invalid`);
  return value;
}

export function poolPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new UserError(`${label} must be a positive integer`);
  return Number(value);
}

export function poolStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string")) {
    throw new UserError(`${label} must be a non-empty string array`);
  }
  return value;
}

export function sendPoolEmpty(response: ServerResponse, status: number): void { response.writeHead(status).end(); }

export function sendPoolJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

export function assertPoolImage(value: string): void {
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new UserError("ordinary CI pool job image must be digest-pinned without a tag");
  }
}

export function assertUniquePoolValues(values: readonly (string | number)[], label: string): void {
  if (new Set(values).size !== values.length) throw new UserError(`ordinary CI pool ${label} must be unique`);
}
