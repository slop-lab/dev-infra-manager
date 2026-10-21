import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { metadata, object, readJson, text } from "./files.ts";
import { inside, removalDirectories } from "./paths.ts";
import type { RemovalPaths } from "./types.ts";
export interface OwnedProcess { readonly pid: number; readonly start: string; readonly command: string }
async function identity(pid: number): Promise<{ start: string; args: string[] } | undefined> {
  try {
    const root = `/proc/${pid}`, stat = await metadata(root);
    if (stat?.uid !== process.getuid?.()) return undefined;
    const info = await readFile(`${root}/stat`, "utf8");
    return { start: text(info.slice(info.lastIndexOf(")") + 2).split(" ")[19]), args: (await readFile(`${root}/cmdline`, "utf8")).split("\0").filter(Boolean) };
  } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
}
export async function planProcesses(paths: RemovalPaths): Promise<{ processes: OwnedProcess[]; workerRoots: string[] }> {
  const processes: OwnedProcess[] = [], workerRoots: string[] = [];
  const roots = removalDirectories(paths);
  for (const entry of await readdir("/proc")) {
    if (!/^[0-9]+$/.test(entry) || Number(entry) === process.pid) continue;
    const processInfo = await identity(Number(entry)); if (!processInfo) continue;
    const { args, start } = processInfo;
    // Node entrypoints in this user's private installation are authority anchors;
    // a random process merely mentioning "dim" is never selected.
    let owned = false;
    for (const arg of args.slice(1, 5)) if (arg.startsWith("/")) {
      let target: string; try { target = await realpath(arg); } catch { continue; }
      if (/\.(?:js|mjs|ts)$/.test(target)) { owned = roots.some((root) => inside(target, root)); break; }
    }
    if (!owned) continue;
    const worker = args.findIndex((arg, index) => ["execution", "ci"].includes(arg) && args[index + 1] === "worker");
    if (worker !== -1) {
      const configPath = args[worker + 2]; if (!configPath?.startsWith("/")) throw new Error("running DIM worker uses a relative configuration; stop it before uninstall-local");
      const config = object(await readJson(configPath)), directory = resolve(text(config.stateDirectory));
      if (!roots.some((root) => inside(directory, root))) throw new Error(`worker state lies outside selected DIM roots: ${directory}; stop and clean that worker separately`);
      workerRoots.push(directory);
    }
    processes.push({ pid: Number(entry), start, command: worker === -1 ? "DIM runtime" : "execution worker" });
  }
  return { processes, workerRoots };
}
export async function stopProcesses(processes: readonly OwnedProcess[]): Promise<void> {
  for (const process of processes) {
    if ((await identity(process.pid))?.start !== process.start) continue;
    try { globalThis.process.kill(process.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await Promise.all(processes.map(async ({ pid, start }) => (await identity(pid))?.start === start))).every((live) => !live)) return;
    await delay(100);
  }
  throw new Error("DIM processes did not stop; installation and ownership records retained. Stop them before retrying.");
}
