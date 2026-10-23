import { UserError } from "../errors.js";
import type { AcquiredWorkspaceSource } from "../workspace/models.js";

export interface HostRequest {
  readonly operation: string;
  readonly input?: Record<string, unknown>;
}

export class HostRequestError extends UserError {}

export function encodeHostRequest(request: HostRequest): string {
  validateRequest(request);
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

export function decodeHostRequest(encoded: string): HostRequest {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid request encoding");
    const request: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    validateRequest(request);
    return request;
  } catch (error) {
    throw new HostRequestError("invalid host request", { cause: error });
  }
}


function validateRequest(value: unknown): asserts value is HostRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("operation" in value) || typeof value.operation !== "string"
    || !/^[a-z][a-zA-Z0-9.]*$/.test(value.operation)
    || ("input" in value && (value.input === null || typeof value.input !== "object" || Array.isArray(value.input)))) {
    throw new HostRequestError("invalid host request");
  }
}

export interface RequiredPlugins {
  readonly status: "requires-plugins";
  readonly source: AcquiredWorkspaceSource;
  readonly plugins: readonly string[];
}

/** Repository declarations are data: only exact registry packages, never host paths or commands. */
export function exactPluginSpec(value: unknown): { name: string; version: string; spec: string } {
  if (typeof value !== "string" || value.length > 300) throw new UserError("workspace plugins must use exact registry PACKAGE@VERSION specs");
  const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(value);
  if (!match || !match[1] || !match[2] || match[1].length > 214 || match[1].split("/").some((part) => part === "." || part === "..")) {
    throw new UserError(`workspace plugin '${value}' must use an exact registry PACKAGE@VERSION spec; paths, URLs and ranges are forbidden`);
  }
  return { name: match[1], version: match[2], spec: value };
}

export function pluginSpecs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new UserError("workspace plugins must be an array of at most 32 exact package specs");
  const names = new Set<string>();
  return value.map((item: unknown) => {
    const parsed = exactPluginSpec(item);
    if (names.has(parsed.name)) throw new UserError(`duplicate workspace plugin '${parsed.name}'`);
    names.add(parsed.name); return parsed.spec;
  });
}
