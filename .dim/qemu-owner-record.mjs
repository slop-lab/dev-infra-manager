import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const OWNER_KEYS = ["argv", "cwd", "executable", "pid", "pidNamespace", "schema", "socket", "startTicks"];
const FILE_KEYS = ["device", "inode", "path"];
const SOCKET_KEYS = ["device", "inode"];
const FINGERPRINT_KEYS = ["owner", "pid", "socket", "startTicks", "state"];
const MAX_SAFE_PID = BigInt(Number.MAX_SAFE_INTEGER);
const PID_MAX = BigInt(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function decimal(value, positive = false) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    && (!positive || value !== "0");
}

function parseFileIdentity(value) {
  if (!exactKeys(value, FILE_KEYS) || typeof value.path !== "string" || value.path.length === 0
    || value.path !== resolve(value.path) || !decimal(value.device) || !decimal(value.inode, true)) {
    throw new Error("invalid owner file identity");
  }
  return value;
}

function parseArtifactIdentity(value) {
  if (!exactKeys(value, SOCKET_KEYS) || !decimal(value.device) || !decimal(value.inode, true)) {
    throw new Error("invalid owner fingerprint identity");
  }
  return value;
}

export function parseOwnerFingerprint(value) {
  if (!exactKeys(value, FINGERPRINT_KEYS) || (value.state !== "live" && value.state !== "dead")
    || !decimal(value.pid, true) || BigInt(value.pid) > MAX_SAFE_PID || BigInt(value.pid) > PID_MAX
    || !decimal(value.startTicks, true)) {
    throw new Error("invalid owner fingerprint");
  }
  parseArtifactIdentity(value.owner);
  parseArtifactIdentity(value.socket);
  return value;
}

export function parseOwnerRecord(value) {
  if (!exactKeys(value, OWNER_KEYS) || value.schema !== 2
    || !decimal(value.pid, true) || BigInt(value.pid) > MAX_SAFE_PID || BigInt(value.pid) > PID_MAX
    || !decimal(value.startTicks, true) || !Array.isArray(value.argv) || value.argv.length === 0
    || value.argv.some((entry) => typeof entry !== "string") || !exactKeys(value.socket, SOCKET_KEYS)
    || !decimal(value.socket.device) || !decimal(value.socket.inode, true)) {
    throw new Error("invalid service owner record");
  }
  parseFileIdentity(value.executable);
  parseFileIdentity(value.cwd);
  parseArtifactIdentity(value.pidNamespace);
  return value;
}
