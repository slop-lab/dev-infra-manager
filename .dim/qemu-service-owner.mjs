import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { identity, pathState, sameIdentity, socketLeasePath } from "./qemu-service-artifacts.mjs";
import { parseOwnerFingerprint, parseOwnerRecord } from "./qemu-owner-record.mjs";

export { parseOwnerRecord } from "./qemu-owner-record.mjs";

async function fileIdentity(path) {
  const canonicalPath = await realpath(path);
  return { ...identity(await stat(canonicalPath, { bigint: true })), path: canonicalPath };
}

async function processIdentity(pid) {
  const proc = `/proc/${pid}`;
  const [statText, command, executable, cwd] = await Promise.all([
    readFile(`${proc}/stat`, "utf8"),
    readFile(`${proc}/cmdline`),
    fileIdentity(`${proc}/exe`),
    fileIdentity(`${proc}/cwd`),
  ]);
  const end = command.at(-1) === 0 ? -1 : undefined;
  const argv = command.subarray(0, end).toString().split("\0");
  const fields = statText.slice(statText.lastIndexOf(")") + 2).split(" ");
  return { argv, cwd, executable, pid: String(pid), startTicks: fields[19] };
}

function sameFile(left, right) {
  return left.path === right.path && sameIdentity(left, right);
}

function sameProcess(record, actual) {
  return record.pid === actual.pid && record.startTicks === actual.startTicks
    && JSON.stringify(record.argv) === JSON.stringify(actual.argv)
    && sameFile(record.executable, actual.executable) && sameFile(record.cwd, actual.cwd);
}

export async function inspectOwner(ownerPath, socketPath, expectedCwd) {
  let ownerHandle;
  try {
    ownerHandle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const [socketStats, leaseStats] = await Promise.all([
      pathState(socketPath), pathState(socketLeasePath(socketPath)),
    ]);
    if (!socketStats && !leaseStats) return { state: "absent" };
    throw new Error("ambiguous service ownership artifacts");
  }
  try {
    const [ownerStats, socketStats, leaseStats] = await Promise.all([
      ownerHandle.stat({ bigint: true }), pathState(socketPath), pathState(socketLeasePath(socketPath)),
    ]);
    if (!socketStats || !leaseStats || !ownerStats.isFile() || (ownerStats.mode & 0o7777n) !== 0o600n
      || !socketStats.isSocket() || !leaseStats.isSocket()) {
      throw new Error("ambiguous service ownership artifacts");
    }
    const record = parseOwnerRecord(JSON.parse(await ownerHandle.readFile("utf8")));
    const socket = identity(socketStats);
    if (!sameIdentity(record.socket, socket) || !sameIdentity(socket, identity(leaseStats))
      || !sameFile(record.cwd, await fileIdentity(expectedCwd))) throw new Error("service ownership mismatch");
    const result = { owner: identity(ownerStats), record, socket };
    try {
      const actual = await processIdentity(Number(record.pid));
      if (!sameProcess(record, actual)) throw new Error("service process identity mismatch");
      return { ...result, state: "live" };
    } catch (error) {
      if (error?.code === "ENOENT") return { ...result, state: "dead" };
      throw error;
    }
  } finally {
    await ownerHandle.close();
  }
}

export async function createOwnerRecord(socketPath) {
  const current = await processIdentity(process.pid);
  const [socketStats, leaseStats] = await Promise.all([
    pathState(socketPath), pathState(socketLeasePath(socketPath)),
  ]);
  if (!socketStats?.isSocket() || !leaseStats?.isSocket()
    || !sameIdentity(identity(socketStats), identity(leaseStats))) {
    throw new Error("service socket lease mismatch");
  }
  return { ...current, schema: 1, socket: identity(socketStats) };
}

export function ownerFingerprint(inspected) {
  return {
    state: inspected.state,
    pid: inspected.record?.pid ?? null,
    startTicks: inspected.record?.startTicks ?? null,
    owner: inspected.owner ?? null,
    socket: inspected.socket ?? null,
  };
}

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function retireInspected(inspected, ownerPath, socketPath, expectedCwd, timeoutMs) {
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
  const { removeOwnedArtifacts } = await import("./qemu-service-artifacts.mjs");
  await removeOwnedArtifacts({ owner: inspected.owner, ownerPath, socket: inspected.socket, socketPath });
}

export async function retireOwner(ownerPath, socketPath, expectedCwd, timeoutMs) {
  await retireInspected(await inspectOwner(ownerPath, socketPath, expectedCwd), ownerPath, socketPath, expectedCwd, timeoutMs);
}

export async function retireExact(ownerPath, socketPath, expectedCwd, timeoutMs, expected) {
  const parsedExpected = parseOwnerFingerprint(expected);
  const inspected = await inspectOwner(ownerPath, socketPath, expectedCwd);
  const actual = ownerFingerprint(inspected);
  if (actual.pid !== parsedExpected.pid || actual.startTicks !== parsedExpected.startTicks
    || !sameIdentity(actual.owner, parsedExpected.owner) || !sameIdentity(actual.socket, parsedExpected.socket)) {
    throw new Error("service owner fingerprint mismatch");
  }
  await retireInspected(inspected, ownerPath, socketPath, expectedCwd, timeoutMs);
}

async function main() {
  const [command, ownerPath, socketPath, cwd, argument, fingerprint] = process.argv.slice(2);
  if (command === "inspect" && process.argv.length === 6) {
    process.stdout.write(`${JSON.stringify(ownerFingerprint(await inspectOwner(ownerPath, socketPath, cwd)))}\n`);
    return;
  }
  if ((command === "retire" || command === "retire-exact")
    && /^(0|[1-9][0-9]*)$/.test(argument) && Number.isSafeInteger(Number(argument))) {
    if (command === "retire" && process.argv.length === 7) {
      await retireOwner(ownerPath, socketPath, cwd, Number(argument));
      return;
    }
    if (command === "retire-exact" && process.argv.length === 8) {
      await retireExact(ownerPath, socketPath, cwd, Number(argument), JSON.parse(fingerprint));
      return;
    }
  }
  throw new Error("invalid owner command arguments");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
