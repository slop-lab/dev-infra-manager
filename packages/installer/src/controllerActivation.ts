import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
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
  const entrypoint = path.join(path.resolve(runtimeDirectory), "node_modules/.bin/dim-host");
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    if (Number.isSafeInteger(pid) && pid > 1) {
      const [metadata, command, snapshot, environment] = await Promise.all([
        stat(`/proc/${pid}`), readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/environ`, "utf8")
      ]);
      const args = command.split("\0");
      const processState = snapshot.slice(snapshot.lastIndexOf(")") + 2).split(" ")[0];
      if (metadata.uid === uid && processState !== "Z" && !nodeOptionsEnvironment(environment)
        && managedControllerCommand(args, entrypoint, pidPath)) return true;
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
    const metadata = await lstat(unit);
    const unitText = await readFile(unit, "utf8");
    const args = systemdExecArguments(unitText);
    if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o022) !== 0
      || !unitText.split("\n").includes("UnsetEnvironment=NODE_OPTIONS")
      || !args || !managedControllerCommand(args, entrypoint, pidPath)) return false;
  } catch (error) {
    if (missingProcess(error)) return false;
    throw error;
  }
  return new Promise<boolean>((resolve) => {
    execFile("systemctl", ["--user", "is-active", "--quiet", "dim-controller.service"],
      { env, timeout: 5_000 }, (error) => resolve(error === null));
  });
}

function nodeOptionsEnvironment(environment: string): boolean {
  return environment.split("\0").some((entry) => entry.startsWith("NODE_OPTIONS=") && entry.length > "NODE_OPTIONS=".length);
}

function managedControllerCommand(args: readonly string[], entrypoint: string, pidPath: string): boolean {
  let script = 1;
  while (script < args.length && args[script] !== entrypoint) {
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
  if (args[script] !== entrypoint) return false;
  const marker = args.indexOf("--pid-file", script + 3);
  return args[script + 1] === "controller" && args[script + 2] === "serve"
    && marker > script + 2 && args[marker + 1] === pidPath;
}

function systemdExecArguments(unit: string): string[] | undefined {
  const line = unit.split("\n").find((candidate) => candidate.startsWith("ExecStart="));
  if (!line) return undefined;
  const encoded = line.slice("ExecStart=".length);
  const quoted = /"((?:\\.|[^"])*)"/g;
  const matches = [...encoded.matchAll(quoted)];
  if (!matches.length || encoded.replace(quoted, "").trim()) return undefined;
  return matches.map((match) => (match[1] ?? "").replaceAll("%%", "%").replace(/\\([\\"])/g, "$1"));
}

function missingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}
