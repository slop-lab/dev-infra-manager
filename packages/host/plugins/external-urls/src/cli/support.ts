import { UserError } from "@slop-lab/dim-host-core";
export { restartManagedController } from "@slop-lab/dim-host-core/controller/cli";
export * from "./controller-client.js";
export interface JsonFlags { json?: boolean }
export interface DnsProviderAddFlags {
  name: string;
}

export interface IngressAddFlags {
  name: string;
  description: string;
  scheme: "http" | "https" | "tcp";
  requireApproval?: boolean;
}

export interface ExternalUrlCreateFlags extends JsonFlags {
  ingress: string;
  subdomain?: string;
  container: string[];
  port: string;
  protocol: "http" | "https" | "tcp";
  path?: string;
  workspace?: string;
}

export interface WorkspaceControllerFlags extends JsonFlags {
  workspace?: string;
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function print(value: unknown, flags: JsonFlags = {}): void {
  if (flags.json || typeof value !== "object" || value === null || Array.isArray(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    console.log(`${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
  }
}

export function printActionResult(value: unknown, flags: JsonFlags, message: string): void {
  if (flags.json) print(value, flags);
  else console.log(message);
}

export function printList<T extends object>(records: T[], fields: string[], flags: JsonFlags = {}): void {
  if (flags.json) {
    print(records, flags);
    return;
  }
  if (records.length === 0) return;
  console.table(records.map((record) => {
    const values = record as Record<string, unknown>;
    return Object.fromEntries(fields.map((field) => [field, values[field] ?? ""]));
  }));
}

export function cliPort(value: string, flag: string, zero: boolean): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < (zero ? 0 : 1) || port > 65_535) {
    throw new UserError(`${flag} must be between ${zero ? 0 : 1} and 65535`);
  }
  return port;
}
