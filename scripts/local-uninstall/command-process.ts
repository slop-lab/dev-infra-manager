import { readFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export type CommandProcessProof = { readonly pid: number; readonly start: string };
type ProcessSnapshot = CommandProcessProof & { readonly state: string; readonly parent: number; readonly group: number };
export interface CommandCleanupLimits { readonly maximumProcesses?: number; readonly scanMilliseconds?: number }
function parse(pid: number, raw: string): ProcessSnapshot {
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const start = fields[19], state = fields[0], parent = Number(fields[1]), group = Number(fields[2]);
  if (start === undefined || state === undefined || !Number.isSafeInteger(parent) || !Number.isSafeInteger(group)) throw new Error("invalid command process identity");
  return { pid, start, state, parent, group };
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}
/** Capture before yielding to libuv: the original child cannot be reaped and its PID reused. */
export function captureCommandProcess(pid: number | undefined): CommandProcessProof | undefined {
  if (pid === undefined) return undefined;
  try { return Object.freeze({ pid, start: parse(pid, readFileSync(`/proc/${pid}/stat`, "utf8")).start }); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}
async function snapshot(pid: number, signal: AbortSignal): Promise<ProcessSnapshot | undefined> {
  try { return parse(pid, await readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal })); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}
function matches(proof: CommandProcessProof, current: ProcessSnapshot | undefined): current is ProcessSnapshot {
  return current !== undefined && current.pid === proof.pid && current.start === proof.start;
}
function active(current: ProcessSnapshot): boolean { return current.state !== "Z" && current.state !== "X"; }
function send(pid: number, value: NodeJS.Signals): void {
  try { process.kill(pid, value); }
  catch (error) { if (!missing(error)) throw error; }
}

/** Bound both discovery work and total cleanup; never adopt a replacement process. */
export async function terminateCommandTree(
  leader: CommandProcessProof | undefined, grace: number, limits: CommandCleanupLimits = {}
): Promise<void> {
  if (leader === undefined) throw new Error("command process ownership is unavailable");
  const maximum = limits.maximumProcesses ?? 1_024, scanMilliseconds = limits.scanMilliseconds ?? 1_000;
  if (![grace, scanMilliseconds].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 60_000)
    || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4_096) throw new Error("invalid command cleanup budget");
  const deadline = performance.now() + 2 * grace + scanMilliseconds;
  const overall = AbortSignal.timeout(2 * grace + scanMilliseconds);
  const current = await snapshot(leader.pid, overall);
  if (!matches(leader, current) || !active(current)) throw new Error("original command leader exited or changed; descendant cleanup is unconfirmed");
  const owned = new Map<number, CommandProcessProof>([[leader.pid, leader]]);
  let scanRemaining = scanMilliseconds, scanFailure: unknown;

  async function discover(owner: CommandProcessProof, until: number, visited: Set<number>): Promise<void> {
    if (visited.has(owner.pid)) return;
    visited.add(owner.pid);
    const check = (): void => {
      overall.throwIfAborted();
      if (performance.now() >= until) throw new Error("command descendant scan exceeded its time budget");
    };
    check();
    const before = await snapshot(owner.pid, overall);
    if (!matches(owner, before) || !active(before)) throw new Error("command process ownership changed during descendant scan");
    // Do not read an unbounded /proc children listing while an installer keeps forking.
    const file = await open(`/proc/${owner.pid}/task/${owner.pid}/children`, "r");
    const buffer = Buffer.alloc(Math.min(65_536, maximum * 24) + 1);
    let size = 0;
    try {
      while (size < buffer.length) {
        check();
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        check();
        if (bytesRead === 0) break;
        size += bytesRead;
      }
    } finally { await file.close(); }
    if (size === buffer.length) throw new Error("command descendant listing exceeded its size budget");
    const after = await snapshot(owner.pid, overall);
    if (!matches(owner, after) || !active(after)) throw new Error("command process ownership changed during descendant scan");
    for (const value of buffer.subarray(0, size).toString("utf8").trim().split(/\s+/).filter(Boolean)) {
      check();
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid command descendant identity");
      const child = await snapshot(pid, overall), parent = await snapshot(owner.pid, overall);
      if (child === undefined || child.parent !== owner.pid || !matches(owner, parent) || !active(parent)) throw new Error("command descendant ownership changed during scan");
      const prior = owned.get(pid);
      if (prior !== undefined) {
        if (!matches(prior, child)) throw new Error("command descendant PID was replaced");
        await discover(prior, until, visited);
        continue;
      }
      owned.set(pid, Object.freeze({ pid, start: child.start }));
      // Retain the one additional verified identity for cleanup, then stop discovery.
      if (owned.size > maximum) throw new Error("command descendant scan exceeded its process budget");
      await discover(child, until, visited);
    }
  }
  async function scan(): Promise<void> {
    const started = performance.now(), until = Math.min(deadline, started + scanRemaining);
    try { await discover(leader!, until, new Set()); }
    catch (error) { scanFailure ??= error; }
    finally { scanRemaining -= performance.now() - started; }
  }
  async function signalOwned(value: NodeJS.Signals): Promise<void> {
    for (const proof of owned.values()) {
      const observed = await snapshot(proof.pid, overall);
      if (matches(proof, observed) && active(observed)) {
        if (observed.group === proof.pid) send(-proof.pid, value);
        send(proof.pid, value);
      }
    }
  }
  async function exited(): Promise<boolean> {
    for (const proof of owned.values()) {
      const observed = await snapshot(proof.pid, overall);
      if (matches(proof, observed) && active(observed)) return false;
    }
    return true;
  }
  async function wait(): Promise<boolean> {
    const until = Math.min(deadline, performance.now() + grace);
    while (performance.now() < until) {
      if (await exited()) return true;
      await delay(10);
    }
    return exited();
  }
  await scan();
  await signalOwned("SIGTERM");
  if (!await wait()) {
    if (scanFailure === undefined && scanRemaining > 0) {
      // A still-owned leader may have forked during graceful termination.
      const original = await snapshot(leader.pid, overall);
      if (matches(leader, original) && active(original)) await scan();
    }
    await signalOwned("SIGKILL");
    if (!await wait()) throw new Error("command descendants remain active after SIGKILL");
  }
  if (scanFailure !== undefined) throw new Error("command descendant discovery was incomplete", { cause: scanFailure });
}
