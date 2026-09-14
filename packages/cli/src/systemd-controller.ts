import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { UserError, type LifecycleOptions } from "@slop-lab/dim-core";
import { runner } from "./cli-runtime.js";
import { managedControllerReady } from "./controller-health.js";

const managedControllerStartAttempts = 2400;

export function usesSystemdManagedController(options: LifecycleOptions): boolean {
  if (process.platform !== "linux") return false;
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const systemdRuntimeRoot = `/run/user/${uid}`;
  if ((process.env.XDG_RUNTIME_DIR ?? systemdRuntimeRoot) !== systemdRuntimeRoot) return false;
  const defaultStateRoot = path.resolve(path.join(homedir(), ".local/state/dim"));
  const runtimeDirectory = path.join(systemdRuntimeRoot, "dim");
  return options.stateRoot === defaultStateRoot
    && options.controllerRuntimeDirectory === runtimeDirectory
    && options.controllerSocketPath === path.join(runtimeDirectory, "workspace", "controller.sock")
    && options.agentControllerSocketPath === path.join(runtimeDirectory, "agent", "controller.sock")
    && options.adminControllerSocketPath === path.join(runtimeDirectory, "admin", "controller.sock");
}

export async function startSystemdManagedController(options: LifecycleOptions): Promise<void> {
  const script = process.argv[1];
  if (!script) throw new UserError("cannot locate the DIM CLI entrypoint");
  const unitDirectory = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
    "systemd",
    "user"
  );
  const unitPath = path.join(unitDirectory, "dim-controller.service");
  const environment = [
    "DIM_CONFIG_PATH",
    "DIM_DATA_HOME",
    "DIM_INSTALL_PREFIX",
    "DIM_PLUGIN_HOME",
    "DIM_EXTERNAL_URL_CONFIG",
    "DIM_CONTROLLER_SOCKET",
    "DIM_AGENT_CONTROLLER_SOCKET",
    "DIM_ADMIN_CONTROLLER_SOCKET",
    "DOCKER_HOST",
    "PATH",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME"
  ].flatMap((name) => process.env[name] === undefined
    ? []
    : [`Environment=${systemdQuote(`${name}=${process.env[name]}`)}`]);
  const command = [
    process.execPath,
    ...process.execArgv,
    script,
    "controller",
    "serve",
    "--socket",
    options.controllerSocketPath,
    "--agent-socket",
    options.agentControllerSocketPath,
    "--admin-socket",
    options.adminControllerSocketPath,
    "--pid-file",
    path.join(options.controllerRuntimeDirectory, "controller.pid")
  ].map(systemdQuote).join(" ");
  const unit = `[Unit]
Description=DIM managed controller

[Service]
Type=simple
ExecStart=${command}
Restart=on-failure
RestartSec=1s
KillMode=control-group
RuntimeDirectory=dim
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=restart
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dim-controller
${environment.join("\n")}

[Install]
WantedBy=default.target
`;
  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${unitPath}.tmp-${process.pid}`;
  await writeFile(temporary, unit, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, unitPath);
  for (const args of [
    ["--user", "daemon-reload"],
    ["--user", "enable", "dim-controller.service"],
    ["--user", "restart", "dim-controller.service"]
  ]) {
    const result = await runner.run("systemctl", args);
    if (result.exitCode !== 0) {
      throw new UserError(
        `could not start DIM controller with systemd: ${result.stderr.trim() || result.stdout.trim()}`
      );
    }
  }
  for (let attempt = 0; attempt < managedControllerStartAttempts; attempt += 1) {
    if (await managedControllerReady(options)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new UserError(
    "managed controller failed to start; run "
      + "'journalctl --user --unit dim-controller.service --lines 100' for details"
  );
}

export function systemdQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new UserError("systemd controller arguments must not contain newlines");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
