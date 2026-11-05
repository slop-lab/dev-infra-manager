import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

type ProcessIdentity = { readonly pid: number; readonly start: string; readonly state: string };
async function identity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8"), fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const start = fields[19], state = fields[0];
    if (start === undefined || state === undefined) throw new Error("invalid command process identity");
    return { pid, start, state };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return undefined;
    throw error;
  }
}
async function descendants(pid: number, found = new Map<number, ProcessIdentity>()): Promise<Map<number, ProcessIdentity>> {
  let children: string;
  try { children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return found;
    throw error;
  }
  for (const value of children.trim().split(/\s+/).filter(Boolean)) {
    const child = Number(value);
    if (!Number.isSafeInteger(child) || child <= 0) throw new Error("invalid command descendant identity");
    if (found.has(child)) continue;
    const current = await identity(child);
    if (current === undefined) continue;
    found.set(child, current);
    await descendants(child, found);
  }
  return found;
}
async function live(expected: ProcessIdentity): Promise<boolean> {
  const current = await identity(expected.pid);
  return current !== undefined && current.start === expected.start && current.state !== "Z" && current.state !== "X";
}
function signal(pid: number, value: NodeJS.Signals): void {
  try { process.kill(pid, value); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
}
/** The facade can spawn npm in its own group. Capture descendants before stopping the parent. */
export async function terminateCommandTree(pid: number | undefined, grace: number): Promise<void> {
  if (pid === undefined) return;
  const leader = await identity(pid), owned = await descendants(pid);
  if (leader !== undefined) owned.set(pid, leader);
  async function send(value: NodeJS.Signals): Promise<void> {
    // Group cancellation also covers ordinary children created after the snapshot.
    if (leader !== undefined && await live(leader)) signal(-pid!, value);
    for (const expected of owned.values()) if (await live(expected)) signal(expected.pid, value);
  }
  async function exited(): Promise<boolean> {
    return !(await Promise.all([...owned.values()].map(live))).some(Boolean);
  }
  await send("SIGTERM");
  const deadline = performance.now() + grace;
  while (performance.now() < deadline) {
    if (await exited()) return;
    await delay(10);
  }
  // Include children created during graceful shutdown, including detached npm groups.
  for (const expected of [...owned.values()]) if (await live(expected)) await descendants(expected.pid, owned);
  await send("SIGKILL");
  const killedDeadline = performance.now() + grace;
  while (performance.now() < killedDeadline) {
    if (await exited()) return;
    await delay(10);
  }
  if (!await exited()) throw new Error("command descendants remain active after SIGKILL");
}
