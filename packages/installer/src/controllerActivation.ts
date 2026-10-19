import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Inspect existing activation only; installing packages must not create a service. */
export async function managedControllerIsActive(runtimeDirectory: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) return false;
  const home = env.HOME ?? os.homedir();
  const defaultState = path.resolve(home, ".local/state/dim");
  const state = path.resolve(env.DIM_STATE_ROOT ?? defaultState);
  const runtime = path.join(env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `dim-${uid}`), "dim");
  const directory = state === defaultState ? runtime
    : path.join(runtime, createHash("sha256").update(state).digest("hex").slice(0, 16));
  const pidPath = path.join(directory, "controller.pid");
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    if (Number.isSafeInteger(pid) && pid > 1) {
      const [metadata, command, snapshot] = await Promise.all([
        stat(`/proc/${pid}`), readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/stat`, "utf8")
      ]);
      const args = command.split("\0");
      const controller = args.indexOf("controller");
      const marker = args.indexOf("--pid-file");
      const processState = snapshot.slice(snapshot.lastIndexOf(")") + 2).split(" ")[0];
      if (metadata.uid === uid && processState !== "Z" && controller > 0 && args[controller + 1] === "serve"
        && marker > controller && args[marker + 1] === pidPath
        && args.some((arg) => arg.startsWith(`${path.resolve(runtimeDirectory)}${path.sep}`))) return true;
    }
  } catch (error) {
    if (!missingProcess(error)) throw error;
  }
  // A systemd service can be active before it publishes its PID marker. Limit
  // this probe to the default host context and an already installed user unit.
  const systemdRuntime = `/run/user/${uid}`;
  if (state !== defaultState || (env.XDG_RUNTIME_DIR ?? systemdRuntime) !== systemdRuntime) return false;
  const unit = path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "systemd/user/dim-controller.service");
  try {
    if ((await stat(unit)).uid !== uid || !(await readFile(unit, "utf8")).includes(`${path.resolve(runtimeDirectory)}${path.sep}`)) return false;
  } catch (error) {
    if (missingProcess(error)) return false;
    throw error;
  }
  return new Promise<boolean>((resolve) => {
    execFile("systemctl", ["--user", "is-active", "--quiet", "dim-controller.service"],
      { env, timeout: 5_000 }, (error) => resolve(error === null));
  });
}

function missingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}
