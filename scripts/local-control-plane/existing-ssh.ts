import { spawn } from "node:child_process";
import { lstat, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { checked, createCommand, type Command } from "../local-uninstall/command.ts";
import { privateDirectory } from "./files.ts";
import type { ExistingConnections } from "./existing-connections.ts";

const unitName = "dim-existing-control-plane-tunnel.service";
const owner = "# Owned by DIM repository install-local existing-control-plane";
export function existingSshArguments(alias: string, bundle: Pick<ExistingConnections, "nativeEndpoint" | "executionEndpoint">): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,252}$/.test(alias)) throw new Error("--control-plane-ssh must be an SSH host alias, without options, whitespace or a command");
  const forwards = [...new Set([bundle.nativeEndpoint, bundle.executionEndpoint])].map((endpoint) => {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || endpoint !== url.origin) throw new Error("SSH connections must use explicit http://127.0.0.1:PORT endpoints; forward the same private service ports");
    return `127.0.0.1:${url.port || "80"}:127.0.0.1:${url.port || "80"}`;
  });
  return ["-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", ...forwards.flatMap((forward) => ["-L", forward]), alias];
}
function unitText(args: readonly string[]): string {
  const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
  return `${owner}\n[Unit]\nDescription=DIM existing control-plane SSH forwards\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/bin/ssh ${args.map(quoted).join(" ")}\nRestart=always\nRestartSec=3\nRuntimeDirectory=dim-existing-control-plane\nRuntimeDirectoryMode=0700\nRuntimeDirectoryPreserve=no\n\n[Install]\nWantedBy=default.target\n`;
}
async function ownedUnit(file: string): Promise<string | undefined> {
  let stat;
  try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16 * 1024) throw new Error("refusing to replace an unowned control-plane SSH unit");
  const text = await readFile(file, "utf8");
  if (!text.startsWith(`${owner}\n`)) throw new Error("refusing to replace an unowned control-plane SSH unit");
  return text;
}
async function waitForMaster(socket: string, alias: string, run: Command, exited: () => boolean, configuration: readonly string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (exited()) throw new Error("SSH forwarding exited; verify SSH alias, known-host entry, key authentication and free local ports");
    let directory;
    try { directory = await lstat(join(socket, "..")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!directory) { await delay(100); continue; }
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) throw new Error("SSH control socket directory must be private and user-owned");
    // A listening TCP port could belong to an unrelated local process. Only our
    // private ControlMaster can prove that SSH authenticated and bound forwards.
    const result = await run("/usr/bin/ssh", [...configuration, "-S", socket, "-O", "check", alias]);
    if (result.status === 0 && !exited()) return;
    await delay(100);
  }
  throw new Error("owned SSH control master did not become ready");
}
export function existingSshTransport(env: NodeJS.ProcessEnv, run: Command = createCommand(env), options: { configurationFile?: string; runtimeDirectory?: string } = {}) {
  const home = env.HOME;
  if (!home) throw new Error("HOME is required for the private SSH user service");
  const file = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd/user", unitName);
  const configuration = options.configurationFile === undefined ? [] : ["-F", options.configurationFile];
  const socketDirectory = options.runtimeDirectory ?? `/run/user/${process.getuid?.()}/dim-existing-control-plane`;
  const durableSocket = join(socketDirectory, "master");
  const masterArguments = (alias: string, bundle: ExistingConnections, socket: string) => [
    ...configuration, "-M", "-S", socket, "-o", "ControlPersist=no", "-o", "ForkAfterAuthentication=no", ...existingSshArguments(alias, bundle)
  ];
  return {
    async temporary<T>(alias: string, bundle: ExistingConnections, action: () => Promise<T>): Promise<T> {
      // Discover a missing user manager before the installer changes anything.
      await checked(run, "systemctl", ["--user", "show-environment"]);
      const expected = unitText(masterArguments(alias, bundle, durableSocket)), prior = await ownedUnit(file);
      const active = await run("systemctl", ["--user", "is-active", "--quiet", unitName]);
      if (active.status === 0) {
        if (prior !== expected) throw new Error("another DIM existing-control-plane tunnel is active; stop it explicitly before selecting a different SSH connection");
        await waitForMaster(durableSocket, alias, run, () => false, configuration);
        return action();
      }
      const temporary = await mkdtemp(join(tmpdir(), "dim-cp-check-"));
      const socket = join(temporary, "master"), args = masterArguments(alias, bundle, socket);
      const child = spawn("/usr/bin/ssh", args, { stdio: ["ignore", "ignore", "pipe"], env });
      let exited = false;
      const exit = new Promise<void>((done) => { child.once("close", () => { exited = true; done(); }); child.once("error", () => { exited = true; done(); }); });
      child.stderr.resume();
      try { await waitForMaster(socket, alias, run, () => exited, configuration); return await action(); }
      finally {
        child.kill("SIGTERM"); await Promise.race([exit, delay(2_000)]); if (!exited) child.kill("SIGKILL"); await exit;
        await rm(temporary, { recursive: true, force: true });
      }
    },
    async persist(alias: string, bundle: ExistingConnections): Promise<void> {
      const text = unitText(masterArguments(alias, bundle, durableSocket));
      // Verify user systemd exists before writing a unit. No detached background fallback.
      await checked(run, "systemctl", ["--user", "show-environment"]);
      const prior = await ownedUnit(file);
      await privateDirectory(join(file, ".."));
      await writeFile(file, text, { mode: 0o600, flag: prior === undefined ? "wx" : "w" });
      await checked(run, "systemctl", ["--user", "daemon-reload"]);
      await checked(run, "systemctl", ["--user", "enable", unitName]);
      await checked(run, "systemctl", ["--user", "restart", unitName]);
      await waitForMaster(durableSocket, alias, run, () => false, configuration);
    }
  };
}
