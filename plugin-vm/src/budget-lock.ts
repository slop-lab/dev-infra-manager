import { spawn } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";

/** Kernel flock spans independent CLI, helper and QEMU-launch processes; no stale lock stealing. */
export async function withVmBudgetLock<T>(instance: string, action: () => Promise<T>): Promise<T> {
  if (!/^dim-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instance)) throw new Error("invalid VM lock identity");
  const directory = "/run/lock/dim-vm-budget";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o077) !== 0) throw new Error("untrusted VM budget lock directory");
  const file = `${directory}/${instance}.lock`;
  try { await writeFile(file, "", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o077) !== 0) throw new Error("untrusted VM budget lock file");
  const child = spawn("/usr/bin/flock", ["--exclusive", "--timeout", "15", file, "/bin/sh", "-c", "printf 'locked\\n'; cat >/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" }
  });
  child.stdin.on("error", () => {}); // A lock process that already exited may have closed this pipe.
  child.stderr.resume();
  const exited = once(child, "exit");
  // Attach rejection handling immediately, including failures before the ready marker.
  void exited.catch(() => {});
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (input: Buffer) => input.toString() === "locked\n" ? resolve() : reject(new Error("invalid VM lock response")));
      child.once("exit", () => reject(new Error("could not acquire VM budget lock")));
    });
    return await action();
  } finally {
    child.stdin.end();
    await exited;
  }
}
