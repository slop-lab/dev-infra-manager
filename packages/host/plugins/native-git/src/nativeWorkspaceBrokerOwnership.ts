import { lstat, readFile, readdir } from "node:fs/promises";
import { UserError } from "@slop-lab/dim-host-core";

type OwnedProcess = { readonly pid: number; readonly started: string };
async function identify(pid: number, executables: readonly string[], attachmentFile: string): Promise<OwnedProcess | undefined> {
  try {
    if (pid === process.pid || (await lstat(`/proc/${pid}`)).uid !== process.geteuid?.()) return undefined;
    const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    if (args[0] !== process.execPath || args.at(-1) !== attachmentFile || !executables.includes(args.at(-2) ?? "")
      || args.slice(1, -2).some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg) || arg.startsWith("--eval=") || arg.startsWith("--print="))) return undefined;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!started || !/^\d+$/.test(started)) return undefined;
    return { pid, started };
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

/** Host-only process ownership: never terminate the arbitrary owner of a busy port. */
export async function retireNativeWorkspaceBrokers(executables: readonly string[], attachmentFile: string): Promise<number> {
  const candidates = (await readdir("/proc")).filter((entry) => /^[1-9]\d*$/.test(entry));
  let retired = 0;
  for (const entry of candidates) {
    const initial = await identify(Number(entry), executables, attachmentFile);
    if (!initial) continue;
    const current = await identify(initial.pid, executables, attachmentFile);
    if (current?.started !== initial.started) continue;
    try { process.kill(initial.pid, "SIGTERM"); retired++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new UserError("could not retire the owned native Git broker", { cause: error }); }
  }
  return retired;
}
