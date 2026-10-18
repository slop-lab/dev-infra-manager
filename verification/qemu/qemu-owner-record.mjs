// @ts-check
import { isRecord } from "./qemu-values.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const OWNER_KEYS = ["argv", "cwd", "executable", "pid", "pidNamespace", "schema", "socket", "startTicks"];
const FILE_KEYS = ["device", "inode", "path"];
const SOCKET_KEYS = ["device", "inode"];
const FINGERPRINT_KEYS = ["owner", "pid", "socket", "startTicks", "state"];
const MAX_SAFE_PID = BigInt(Number.MAX_SAFE_INTEGER);
const PID_MAX = BigInt(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());

/** @param {unknown} value @param {string[]} keys @returns {value is Record<string,unknown>} */
function exactKeys(value, keys) {
  return isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

/** @param {unknown} value @param {boolean} positive @returns {value is string} */
function decimal(value, positive = false) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    && (!positive || value !== "0");
}

/** @param {unknown} value @returns {import("./qemu-types.js").FileIdentity} */
function parseFileIdentity(value) {
  if (!exactKeys(value, FILE_KEYS) || typeof value.path !== "string" || value.path.length === 0
    || value.path !== resolve(value.path) || !decimal(value.device) || !decimal(value.inode, true)) {
    throw new Error("invalid owner file identity");
  }
  return { path: value.path, device: value.device, inode: value.inode };
}

/** @param {unknown} value @returns {import("./qemu-types.js").ArtifactIdentity} */
function parseArtifactIdentity(value) {
  if (!exactKeys(value, SOCKET_KEYS) || !decimal(value.device) || !decimal(value.inode, true)) {
    throw new Error("invalid owner fingerprint identity");
  }
  return { device: value.device, inode: value.inode };
}

/** @param {unknown} value @returns {import("./qemu-types.js").OwnedFingerprint} */
export function parseOwnerFingerprint(value) {
  if (!exactKeys(value, FINGERPRINT_KEYS) || (value.state !== "live" && value.state !== "dead")
    || !decimal(value.pid, true) || BigInt(value.pid) > MAX_SAFE_PID || BigInt(value.pid) > PID_MAX
    || !decimal(value.startTicks, true)) {
    throw new Error("invalid owner fingerprint");
  }
  return { state: value.state, pid: value.pid, startTicks: value.startTicks,
    owner: parseArtifactIdentity(value.owner), socket: parseArtifactIdentity(value.socket) };
}

/** @param {unknown} value @returns {import("./qemu-types.js").OwnerRecord} */
export function parseOwnerRecord(value) {
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

/** @param {unknown} value @returns {value is string[]} */
function stringArray(value) { return Array.isArray(value) && value.every((entry) => typeof entry === "string"); }
