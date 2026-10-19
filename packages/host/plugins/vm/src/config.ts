import { readFileSync } from "node:fs";
import path from "node:path";
import { isIPv4 } from "node:net";
import { UserError } from "@slop-lab/dim-core/workspace";

/** Host-reviewed settings. Neither guest code nor image metadata can add devices. */
export interface VmHostConfig {
  schemaVersion: 1;
  project: string;
  storagePool: string;
  network: string;
  guest: { cpuCount: number; memory: string; disk: string };
  /** Writable cgroup-v2 subtree already delegated to this trusted host process. */
  cgroupRoot: string;
  incusSocket: string;
  budgetHelper?: string;
  spiceAssets?: string;
  console?: { address: string; port: number };
}

export function readVmHostConfig(stateRoot: string): VmHostConfig {
  const file = path.join(stateRoot, "plugins", "vm", "config.json");
  try { return parseVmHostConfig(JSON.parse(readFileSync(file, "utf8"))); }
  catch (error) { throw new UserError(`VM host configuration '${file}': ${error instanceof Error ? error.message : String(error)}`); }
}

export function parseVmHostConfig(value: unknown): VmHostConfig {
  const config = object(value);
  const guest = object(config.guest);
  exact(config, ["schemaVersion", "project", "storagePool", "network", "guest", "cgroupRoot", "incusSocket"], ["spiceAssets", "console", "budgetHelper"]);
  exact(guest, ["cpuCount", "memory", "disk"]);
  if (config.schemaVersion !== 1 || !Number.isSafeInteger(guest.cpuCount) || typeof guest.cpuCount !== "number" || guest.cpuCount < 1 || guest.cpuCount > 64) throw new UserError("invalid VM guest allocation");
  return {
    schemaVersion: 1, project: name(config.project), storagePool: name(config.storagePool), network: name(config.network),
    guest: { cpuCount: guest.cpuCount, memory: bytes(guest.memory), disk: bytes(guest.disk) },
    cgroupRoot: absolute(config.cgroupRoot), incusSocket: absolute(config.incusSocket),
    ...(config.budgetHelper === undefined ? {} : { budgetHelper: absolute(config.budgetHelper) }),
    ...(config.spiceAssets === undefined ? {} : { spiceAssets: absolute(config.spiceAssets) }),
    ...(config.console === undefined ? {} : { console: consoleConfig(config.console) })
  };
}
export function fingerprint(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new UserError("VM image must be an exact local Incus SHA-256 fingerprint; import a reviewed VM image first");
  return value;
}
export function uuid(value: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw new UserError("invalid VM identity");
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UserError("expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new UserError("expected a nonempty string");
  return value;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new UserError("unexpected or missing VM configuration field");
}
function name(value: unknown): string {
  const result = text(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(result)) throw new UserError("invalid Incus resource name");
  return result;
}
function absolute(value: unknown): string {
  const result = text(value);
  if (!path.isAbsolute(result) || path.normalize(result) !== result) throw new UserError("expected a normalized absolute host path");
  return result;
}
function bytes(value: unknown): string {
  const result = text(value);
  if (!/^[1-9][0-9]*(?:[KMGT]i?B)?$/.test(result)) throw new UserError("VM allocation must be bytes or an explicit KiB/MiB/GiB/TiB unit");
  return result;
}

function consoleConfig(value: unknown): { address: string; port: number } {
  const config = object(value); exact(config, ["address", "port"]);
  const address = text(config.address), octets = address.split(".").map(Number);
  if (!isIPv4(address) || !(octets[0] === 127 || octets[0] === 10 || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
    || (octets[0] === 192 && octets[1] === 168)) || typeof config.port !== "number" || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new UserError("VM console requires an explicit private/loopback IPv4 address and TCP port");
  }
  return { address, port: config.port };
}
