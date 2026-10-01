import type { IncomingMessage } from "node:http";
import { UserError } from "./errors.js";
import type { CiRunnerExecutorKind, WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UserError(`${name} must be a string`);
  return value;
}

export function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new UserError(`${name} must be a string`);
  return value;
}

export function terminalSize(value: unknown): { columns: number; rows: number } {
  if (value === undefined) return { columns: 80, rows: 24 };
  const input = record(value);
  const columns = input.columns;
  const rows = input.rows;
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows)
    || Number(columns) < 1 || Number(columns) > 1_000
    || Number(rows) < 1 || Number(rows) > 1_000) {
    throw new UserError("terminal columns and rows must be integers between 1 and 1000");
  }
  return { columns: Number(columns), rows: Number(rows) };
}

export async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new UserError(`request body exceeds ${maxBytes} bytes`);
    chunks.push(value);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError("request body must be valid JSON");
    throw error;
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError("request body must be an object");
  }
  return Object.fromEntries(Object.entries(value));
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new UserError("expected an array of strings");
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new UserError("expected an array of strings");
    values.push(item);
  }
  return values;
}

export function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new UserError("expected a boolean");
  return value;
}

export function ciExecutor(value: unknown): CiRunnerExecutorKind {
  if (value !== "sysbox" && value !== "qemu") throw new UserError("CI executor must be 'sysbox' or 'qemu'");
  return value;
}

export function workspaceRuntimeBackend(value: unknown): WorkspaceRuntimeBackendKind {
  if (value !== "sysbox") throw new UserError("workspace runtime backend must be 'sysbox'");
  return value;
}

export function ciResources(value: unknown): { cpus?: string; memory?: string; pidsLimit?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError("resources must be an object");
  }
  const input = Object.fromEntries(Object.entries(value));
  const result: { cpus?: string; memory?: string; pidsLimit?: string } = {};
  for (const key of ["cpus", "memory", "pidsLimit"] as const) {
    const field = input[key];
    if (field !== undefined) {
      if (typeof field !== "string" || field.length === 0) {
        throw new UserError(`resources.${key} must be a string`);
      }
      result[key] = field;
    }
  }
  return result;
}
