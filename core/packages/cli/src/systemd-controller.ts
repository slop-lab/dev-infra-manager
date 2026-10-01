import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { UserError, type LifecycleOptions } from "@slop-lab/dim-core";
import { runner } from "./cli-runtime.js";
import { managedControllerReady } from "./controller-health.js";

const managedControllerStartAttempts = 2400;
const controllerUnit = "dim-controller.service";
const controllerJournalLines = 20;
const controllerDiagnosticLimit = 4096;

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
  const unitPath = path.join(unitDirectory, controllerUnit);
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
    ["--user", "enable", controllerUnit],
    ["--user", "restart", controllerUnit]
  ]) {
    const result = await runner.run("systemctl", args);
    if (result.exitCode !== 0) {
      const detail = boundedDiagnostic(result.stderr.trim() || result.stdout.trim());
      const summary = `could not start DIM controller with systemd: ${detail}`;
      if (args[1] === "restart") await throwControllerStartupFailure(summary);
      throw new UserError(summary);
    }
  }
  for (let attempt = 0; attempt < managedControllerStartAttempts; attempt += 1) {
    if (await managedControllerReady(options)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await throwControllerStartupFailure("managed controller failed to start");
}

async function throwControllerStartupFailure(summary: string): Promise<never> {
  const details: string[] = [];
  const state = await runner.run("systemctl", [
    "--user",
    "show",
    controllerUnit,
    "--property=ActiveState",
    "--property=SubState",
    "--property=Result",
    "--property=ExecMainStatus",
    "--no-pager"
  ]);
  if (state.exitCode === 0) {
    const serviceState = controllerServiceState(state.stdout);
    if (serviceState) details.push(`controller service state: ${serviceState}`);
  }
  const journal = await runner.run("journalctl", [
    "--user",
    "--unit",
    controllerUnit,
    "--lines",
    String(controllerJournalLines),
    "--no-pager",
    "--output",
    "cat"
  ]);
  if (journal.exitCode === 0 && journal.stdout.trim()) {
    details.push(
      `recent controller startup output (last ${controllerJournalLines} lines):\n${boundedDiagnostic(journal.stdout)}`
    );
  }
  throw new UserError([summary, ...details].join("\n"));
}

function controllerServiceState(output: string): string | undefined {
  const properties = new Map(output.split("\n").flatMap((line) => {
    const separator = line.indexOf("=");
    return separator < 1 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
  }));
  const active = properties.get("ActiveState");
  if (active === "failed") return "failed";
  if (active === "inactive") return "stopped";
  if (active === "active" || active === "activating" || active === "deactivating") return active;
  return undefined;
}

function boundedDiagnostic(value: string): string {
  const redacted = value
    .replace(
      /(\b[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY)[A-Z0-9_]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[redacted]"
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@");
  const trimmed = redacted.trim();
  return trimmed.length <= controllerDiagnosticLimit
    ? trimmed
    : `${trimmed.slice(0, controllerDiagnosticLimit)}\n[diagnostic truncated]`;
}

export function systemdQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new UserError("systemd controller arguments must not contain newlines");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
