import { isRecord } from "./qemu-values.mts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const OWNER_KEYS = ["argv", "cwd", "executable", "pid", "pidNamespace", "schema", "socket", "startTicks"];
const FILE_KEYS = ["device", "inode", "path"];
const SOCKET_KEYS = ["device", "inode"];
const FINGERPRINT_KEYS = ["owner", "pid", "socket", "startTicks", "state"];
const MAX_SAFE_PID = BigInt(Number.MAX_SAFE_INTEGER);
const PID_MAX = BigInt(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());

function exactKeys(value: unknown, keys: string[]): value is Record<string,unknown> {
  return isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function decimal(value: unknown, positive: boolean = false): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    && (!positive || value !== "0");
}

function parseFileIdentity(value: unknown): import("./qemu-types.js").FileIdentity {
  if (!exactKeys(value, FILE_KEYS) || typeof value.path !== "string" || value.path.length === 0
    || value.path !== resolve(value.path) || !decimal(value.device) || !decimal(value.inode, true)) {
    throw new Error("invalid owner file identity");
  }
  return { path: value.path, device: value.device, inode: value.inode };
}

function parseArtifactIdentity(value: unknown): import("./qemu-types.js").ArtifactIdentity {
  if (!exactKeys(value, SOCKET_KEYS) || !decimal(value.device) || !decimal(value.inode, true)) {
    throw new Error("invalid owner fingerprint identity");
  }
  return { device: value.device, inode: value.inode };
}

export function parseOwnerFingerprint(value: unknown): import("./qemu-types.js").OwnedFingerprint {
  if (!exactKeys(value, FINGERPRINT_KEYS) || (value.state !== "live" && value.state !== "dead")
    || !decimal(value.pid, true) || BigInt(value.pid) > MAX_SAFE_PID || BigInt(value.pid) > PID_MAX
    || !decimal(value.startTicks, true)) {
    throw new Error("invalid owner fingerprint");
  }
  return { state: value.state, pid: value.pid, startTicks: value.startTicks,
    owner: parseArtifactIdentity(value.owner), socket: parseArtifactIdentity(value.socket) };
}

export function parseOwnerRecord(value: unknown): import("./qemu-types.js").OwnerRecord {
  if (!exactKeys(value, OWNER_KEYS) || value.schema !== 2
    || !decimal(value.pid, true) || BigInt(value.pid) > MAX_SAFE_PID || BigInt(value.pid) > PID_MAX
    || !decimal(value.startTicks, true) || !stringArray(value.argv) || value.argv.length === 0 || !exactKeys(value.socket, SOCKET_KEYS)
    || !decimal(value.socket.device) || !decimal(value.socket.inode, true)) {
    throw new Error("invalid service owner record");
  }
  return { schema: value.schema, argv: value.argv, pid: value.pid, startTicks: value.startTicks,
    executable: parseFileIdentity(value.executable), cwd: parseFileIdentity(value.cwd),
    pidNamespace: parseArtifactIdentity(value.pidNamespace), socket: parseArtifactIdentity(value.socket) };
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === "string"); }
