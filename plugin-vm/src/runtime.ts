import { randomUUID } from "node:crypto";
import {
  workspaceGuestAssets, workspacePortBridge, workspacePortBridgeMarker, workspacePortCleanup,
  type RunOptions, type WorkspaceConnectOptions, type WorkspaceRecord, type WorkspaceResources, type WorkspaceRuntime
} from "@slop-lab/dim-core/workspace";
import { IncusMachines } from "./incus.js";

export class IncusWorkspaceRuntime implements WorkspaceRuntime {
  constructor(readonly machines: IncusMachines) {}
  private async resumeGuestServices(record: WorkspaceRecord): Promise<void> {
    // Only explicit guest registrations resume. Failure of one service does not prevent workspace recovery.
    await this.machines.rootExec(record, ["env", "HOME=/home/dim", "TMPDIR=/mnt/dim-tmp", "DIM_WORKSPACE_TMPDIR=/mnt/dim-tmp",
      "runuser", "--user", "dim", "--preserve-environment", "--", "sh", "-c",
      'mkdir -p "$HOME/.local/state/dim"; if test -f "$HOME/.config/dim/ssh-enabled"; then dim-workspace-ssh start >>"$HOME/.local/state/dim/ssh-start.log" 2>&1 || true; fi; dim-workspace service resume >>"$HOME/.local/state/dim/service-resume.log" 2>&1 || true']);
    await this.machines.rootExec(record, ["sh", "-c",
      'if test -f /home/dim/.local/state/dim/session.json && ! systemctl is-active --quiet dim-workspace-session.service; then systemctl reset-failed dim-workspace-session.service >/dev/null 2>&1 || true; systemd-run --unit dim-workspace-session --collect --uid dim --gid dim --working-directory /workspace --setenv HOME=/home/dim --setenv TMPDIR=/mnt/dim-tmp --setenv DIM_WORKSPACE_TMPDIR=/mnt/dim-tmp /usr/local/bin/dim-workspace session resume; fi']);
  }
  inspect(record: WorkspaceRecord) { return this.machines.inspect(record); }
  create(record: WorkspaceRecord) { return this.machines.create(record); }
  async start(record: WorkspaceRecord): Promise<void> {
    await this.machines.start(record);
    await this.machines.waitForAgent(record);
    await this.machines.waitForDocker(record);
    await this.machines.rootExec(record, ["install", "-d", "-m", "0755", "/usr/local/bin"]);
    await this.machines.rootExec(record, ["sh", "-eu", "-c",
      "test ! -L /mnt && test ! -L /mnt/dim-tmp; install -d -o dim -g dim -m 0700 /mnt/dim-tmp"]);
    for (const asset of workspaceGuestAssets()) await this.machines.installGuestAsset(record, asset);
    if (record.initialized) await this.resumeGuestServices(record);
  }
  stop(record: WorkspaceRecord) { return this.machines.stop(record); }
  remove(record: WorkspaceRecord, options: { keepData: boolean }) { return this.machines.remove(record, options); }
  updateResources(record: WorkspaceRecord, resources: WorkspaceResources) { return this.machines.updateResources(record, resources); }
  seed(record: WorkspaceRecord, directory: string) { return this.machines.seed(record, directory, record.git); }
  exec(record: WorkspaceRecord, command: string[], options?: RunOptions) { return this.machines.exec(record, command, options); }
  hostGateway(record: WorkspaceRecord) { return this.machines.hostGateway(record); }
  async connect(record: WorkspaceRecord, port: number, options: WorkspaceConnectOptions = {}): Promise<number> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid VM forwarding port");
    const token = randomUUID();
    let result: number | undefined;
    try {
      result = await this.exec(record, ["node", "--input-type=commonjs", "-e", workspacePortBridge, String(port), workspacePortBridgeMarker, token], options);
      return result;
    } finally {
      if (result !== 0 || options.signal?.aborted) {
        await this.machines.rootExec(record, ["node", "--input-type=commonjs", "-e", workspacePortCleanup, token], { signal: AbortSignal.timeout(3000) });
      }
    }
  }
}
