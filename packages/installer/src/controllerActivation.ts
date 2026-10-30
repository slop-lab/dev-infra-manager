import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const nodeOptionsWithoutValues = new Set([
  "--enable-source-maps", "--no-warnings", "--trace-warnings", "--inspect", "--inspect-brk",
  "--preserve-symlinks", "--preserve-symlinks-main", "--experimental-strip-types",
  "--experimental-transform-types", "--experimental-detect-module"
]);
const nodeOptionsWithValues = new Set([
  "--conditions", "--inspect-port", "--disable-warning"
]);
const nodeOptionsWithAttachedValues = [
  "--conditions=", "--inspect=", "--inspect-brk=", "--inspect-port=", "--disable-warning="
] as const;
const codeSelectionEnvironment = ["NODE_OPTIONS", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH"] as const;

type ManagedControllerIdentity = {
  readonly uid: number;
  readonly nodeExecutable: string;
  readonly entrypoint: string;
  readonly socketPath: string;
  readonly adminSocketPath: string;
  readonly pidPath: string;
};

/** Inspect existing activation only; installing packages must not create a service. */
export async function managedControllerIsActive(runtimeDirectory: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) return false;
  const home = env.HOME ?? os.homedir();
  const defaultState = path.resolve(home, ".local/state/dim/managed");
  const state = path.resolve(env.DIM_MANAGED_STATE_ROOT ?? env.DIM_STATE_ROOT ?? defaultState);
  const runtime = path.join(env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `dim-${uid}`), "dim", "managed");
  const directory = state === defaultState ? runtime
    : path.join(runtime, createHash("sha256").update(state).digest("hex").slice(0, 16));
  const pidPath = path.join(directory, "controller.pid");
  const identity: ManagedControllerIdentity = { uid, nodeExecutable: await realpath(process.execPath),
    entrypoint: path.join(path.resolve(runtimeDirectory), "node_modules/.bin/dim-host"),
    socketPath: path.join(directory, "workspace/controller.sock"), adminSocketPath: path.join(directory, "admin/controller.sock"), pidPath };
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    if (Number.isSafeInteger(pid) && pid > 1 && await managedControllerProcess(pid, identity)) return true;
  } catch (error) {
    if (!missingProcess(error)) throw error;
  }
  // A systemd service can be active before it publishes its PID marker. Limit
  // this probe to the default host context and an already installed user unit.
  const systemdRuntime = `/run/user/${uid}`;
  if (state !== defaultState || (env.XDG_RUNTIME_DIR ?? systemdRuntime) !== systemdRuntime) return false;
  const unit = path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "systemd/user/dim-controller.service");
  try {
    const metadata = await lstat(unit);
    if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o022) !== 0) return false;
  } catch (error) {
    if (missingProcess(error)) return false;
    throw error;
  }
  const mainPid = await systemdMainPid(env);
  if (mainPid === undefined) return false;
  try { if (!await managedControllerProcess(mainPid, identity)) return false; }
  catch (error) { if (missingProcess(error)) return false; throw error; }
  return new Promise<boolean>((resolve) => {
    execFile("systemctl", ["--user", "is-active", "--quiet", "dim-controller.service"],
      { env, timeout: 5_000 }, (error) => resolve(error === null));
  });
}

async function managedControllerProcess(pid: number, identity: ManagedControllerIdentity): Promise<boolean> {
  const [metadata, command, snapshot, environment, executable] = await Promise.all([
    stat(`/proc/${pid}`), readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/environ`, "utf8"), readlink(`/proc/${pid}/exe`)
  ]);
  const processState = snapshot.slice(snapshot.lastIndexOf(")") + 2).split(" ")[0];
  const args = command.split("\0");
  if (args.at(-1) === "") args.pop();
  return metadata.uid === identity.uid && executable === identity.nodeExecutable && processState !== "Z"
    && !codeSelectionEnvironment.some((name) => environment.split("\0").some((entry) => entry.startsWith(`${name}=`) && entry.length > name.length + 1))
    && managedControllerCommand(args, identity);
}

function managedControllerCommand(args: readonly string[], identity: ManagedControllerIdentity): boolean {
  let script = 1;
  while (script < args.length && args[script] !== identity.entrypoint) {
    const option = args[script];
    if (!option) return false;
    if (nodeOptionsWithoutValues.has(option) || nodeOptionsWithAttachedValues.some((prefix) => option.startsWith(prefix))) {
      script += 1;
      continue;
    }
    if (nodeOptionsWithValues.has(option) && args[script + 1] !== undefined) {
      script += 2;
      continue;
    }
    return false;
  }
  if (args[script] !== identity.entrypoint) return false;
  const expected = ["controller", "serve", "--socket", identity.socketPath, "--admin-socket", identity.adminSocketPath,
    "--pid-file", identity.pidPath];
  return args.length === script + expected.length + 1
    && expected.every((argument, index) => args[script + index + 1] === argument);
}

function systemdMainPid(env: NodeJS.ProcessEnv): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", "show", "dim-controller.service", "--property=MainPID", "--value", "--no-pager"],
      { env, timeout: 5_000 }, (error, stdout) => {
        const pid = Number(stdout.trim());
        resolve(error === null && Number.isSafeInteger(pid) && pid > 1 ? pid : undefined);
      });
  });
}

function missingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}
