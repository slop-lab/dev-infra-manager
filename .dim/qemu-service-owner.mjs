import { constants, readFileSync } from "node:fs";
import { link, lstat, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const OWNER_KEYS = ["argv", "cwd", "executable", "pid", "schema", "socket", "startTicks"];
const FILE_KEYS = ["device", "inode", "path"];
const SOCKET_KEYS = ["device", "inode"];
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

function processId(value) {
  return decimal(value, true) && BigInt(value) <= MAX_SAFE_PID && BigInt(value) <= PID_MAX;
}

function parseFileIdentity(value) {
  if (!exactKeys(value, FILE_KEYS) || typeof value.path !== "string" || value.path.length === 0
    || value.path !== resolve(value.path)
    || !decimal(value.device) || !decimal(value.inode, true)) throw new Error("invalid owner file identity");
  return value;
}

export function parseOwnerRecord(value) {
  if (!exactKeys(value, OWNER_KEYS) || value.schema !== 1 || !processId(value.pid)
    || !decimal(value.startTicks, true) || !Array.isArray(value.argv) || value.argv.length === 0
    || value.argv.some((entry) => typeof entry !== "string")
    || !exactKeys(value.socket, SOCKET_KEYS) || !decimal(value.socket.device)
    || !decimal(value.socket.inode, true)) throw new Error("invalid service owner record");
  parseFileIdentity(value.executable);
  parseFileIdentity(value.cwd);
  return value;
}

function identity(stats) {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

async function syncContainingDirectory(path) {
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function fileIdentity(path) {
  const canonicalPath = await realpath(path);
  return { ...identity(await stat(canonicalPath, { bigint: true })), path: canonicalPath };
}

async function processIdentity(pid) {
  const proc = `/proc/${pid}`;
  const [statText, command, executable, cwd] = await Promise.all([
    readFile(`${proc}/stat`, "utf8"), readFile(`${proc}/cmdline`),
    fileIdentity(`${proc}/exe`), fileIdentity(`${proc}/cwd`),
  ]);
  const end = command.at(-1) === 0 ? -1 : undefined;
  const argv = command.subarray(0, end).toString().split("\0");
  const fields = statText.slice(statText.lastIndexOf(")") + 2).split(" ");
  return { argv, cwd, executable, pid: String(pid), startTicks: fields[19] };
}

function sameFile(left, right) {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

function sameProcess(record, actual) {
  return record.pid === actual.pid && record.startTicks === actual.startTicks
    && JSON.stringify(record.argv) === JSON.stringify(actual.argv)
    && sameFile(record.executable, actual.executable) && sameFile(record.cwd, actual.cwd);
}

async function pathState(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function cwdIdentity(path) {
  const canonicalPath = await realpath(path);
  return { ...identity(await stat(canonicalPath, { bigint: true })), path: canonicalPath };
}

export async function inspectOwner(ownerPath, socketPath, expectedCwd) {
  const [ownerStats, socketStats] = await Promise.all([pathState(ownerPath), pathState(socketPath)]);
  if (!ownerStats && !socketStats) return { state: "absent" };
  if (!ownerStats || !socketStats || !ownerStats.isFile() || !socketStats.isSocket()) {
    throw new Error("ambiguous service ownership artifacts");
  }
  const record = parseOwnerRecord(JSON.parse(await readFile(ownerPath, "utf8")));
  const socket = identity(socketStats);
  if (record.socket.device !== socket.device || record.socket.inode !== socket.inode
    || !sameFile(record.cwd, await cwdIdentity(expectedCwd))) throw new Error("service ownership mismatch");
  const result = { owner: identity(ownerStats), record, socket };
  try {
    const actual = await processIdentity(Number(record.pid));
    if (!sameProcess(record, actual)) throw new Error("service process identity mismatch");
    return { ...result, state: "live" };
  } catch (error) {
    if (error?.code === "ENOENT") return { ...result, state: "dead" };
    throw error;
  }
}

export async function createOwnerRecord(socketPath) {
  const current = await processIdentity(process.pid);
  const socketStats = await lstat(socketPath, { bigint: true });
  if (!socketStats.isSocket()) throw new Error("service socket is not a socket");
  return { ...current, schema: 1, socket: identity(socketStats) };
}

export async function captureSocketIdentity(socketPath) {
  const socketStats = await lstat(socketPath, { bigint: true });
  if (!socketStats.isSocket()) throw new Error("service socket is not a socket");
  return identity(socketStats);
}

export async function publishOwner(ownerPath, record) {
  parseOwnerRecord(record);
  const temporary = resolve(dirname(ownerPath), `.${basename(ownerPath)}.${process.pid}.${Date.now()}`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.chmod(0o600);
    await handle.sync();
    await link(temporary, ownerPath);
    await syncContainingDirectory(ownerPath);
    return identity(await lstat(ownerPath, { bigint: true }));
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
    await syncContainingDirectory(ownerPath);
  }
}

export async function removeIfOwned(path, expected) {
  const stats = await pathState(path);
  if (!stats) return true;
  const actual = identity(stats);
  if (actual.device !== expected.device || actual.inode !== expected.inode) return false;
  await rm(path);
  await syncContainingDirectory(path);
  return true;
}

export async function removeOwnedArtifacts(ownerPath, socketPath, owner, socket) {
  const socketRemoved = await removeIfOwned(socketPath, socket);
  const ownerRemoved = await removeIfOwned(ownerPath, owner);
  if (!socketRemoved || !ownerRemoved) throw new Error("refusing to remove replaced service artifacts");
}

export async function safeguardReplacedSocket(socketPath, expected) {
  const current = await pathState(socketPath);
  if (!current) return undefined;
  const actual = identity(current);
  if (actual.device === expected.device && actual.inode === expected.inode) return undefined;
  const protectedPath = `${socketPath}.replacement.${process.pid}`;
  try { await link(socketPath, protectedPath); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error(`refusing to safeguard replaced socket because protected path exists: ${protectedPath}`, { cause: error });
    throw error;
  }
  await syncContainingDirectory(protectedPath);
  if (!await removeIfOwned(socketPath, actual)) {
    throw new Error(`service socket changed while safeguarding replacement; preserved protected socket: ${protectedPath}`);
  }
  return protectedPath;
}

export async function restoreReplacedSocket(protectedPath, socketPath) {
  if (!protectedPath) return;
  const expected = identity(await lstat(protectedPath, { bigint: true }));
  try { await link(protectedPath, socketPath); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error(`refusing to restore replaced socket because destination exists: ${socketPath}; preserved: ${protectedPath}`, { cause: error });
    throw error;
  }
  await syncContainingDirectory(socketPath);
  if (!await removeIfOwned(protectedPath, expected)) {
    throw new Error(`protected socket changed after restoration: ${protectedPath}`);
  }
}

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

export async function retireOwner(ownerPath, socketPath, expectedCwd, timeoutMs) {
  const inspected = await inspectOwner(ownerPath, socketPath, expectedCwd);
  if (inspected.state === "absent") return;
  if (inspected.state === "live") {
    process.kill(Number(inspected.record.pid), "SIGTERM");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(50);
      const next = await inspectOwner(ownerPath, socketPath, expectedCwd);
      if (next.state === "absent") return;
      if (next.state === "dead") break;
    }
    if ((await inspectOwner(ownerPath, socketPath, expectedCwd)).state === "live") {
      throw new Error("timed out waiting for owned service to stop");
    }
  }
  await removeOwnedArtifacts(ownerPath, socketPath, inspected.owner, inspected.socket);
}

async function main() {
  const args = process.argv.slice(2);
  const [command, ownerPath, socketPath, cwd, argument] = args;
  if (command === "inspect") {
    if (args.length !== 4 && args.length !== 5) throw new Error("invalid inspect arguments");
    const result = await inspectOwner(ownerPath, socketPath, cwd);
    if (argument && (result.state !== "live" || result.record.pid !== argument)) process.exitCode = 1;
    else process.stdout.write(`${JSON.stringify({ pid: result.record?.pid, state: result.state })}\n`);
  } else if (command === "retire") {
    if (args.length !== 5 || !/^(0|[1-9][0-9]*)$/.test(argument)) throw new Error("invalid retirement timeout");
    const timeoutMs = Number(argument);
    if (!Number.isSafeInteger(timeoutMs)) throw new Error("invalid retirement timeout");
    await retireOwner(ownerPath, socketPath, cwd, timeoutMs);
  } else throw new Error("usage: qemu-service-owner.mjs inspect OWNER SOCKET CWD [PID] | retire OWNER SOCKET CWD TIMEOUT_MS");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
