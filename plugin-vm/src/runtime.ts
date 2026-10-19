import { randomUUID } from "node:crypto";
import {
  workspaceGuestAssets, workspacePortBridge, workspacePortBridgeMarker, workspacePortCleanup,
  type RunOptions, type WorkspaceConnectOptions, type WorkspaceRecord, type WorkspaceResources, type WorkspaceRuntime
} from "@slop-lab/dim-core/workspace";
import { IncusMachines } from "./incus.js";

export class IncusWorkspaceRuntime implements WorkspaceRuntime {
  constructor(readonly machines: IncusMachines) {}
  private async installGuestBoot(record: WorkspaceRecord): Promise<void> {
    const boot = `[Unit]
Description=Resume explicitly registered DIM workspace services
After=docker.service network-online.target
Wants=docker.service network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
User=dim
Group=dim
WorkingDirectory=/workspace
Environment=HOME=/home/dim TMPDIR=/mnt/dim-tmp DIM_WORKSPACE_TMPDIR=/mnt/dim-tmp
ExecStart=-/usr/local/bin/dim-workspace service resume
ExecStart=-/bin/sh -c 'if test -f "$HOME/.config/dim/ssh-enabled"; then /usr/local/bin/dim-workspace-ssh start; fi'
[Install]
WantedBy=multi-user.target
`;
    const session = `[Unit]
Description=Resume the saved DIM coding agent session
After=dim-workspace-boot.service
Wants=dim-workspace-boot.service
ConditionPathExists=/home/dim/.local/state/dim/session.json
[Service]
Type=simple
User=dim
Group=dim
WorkingDirectory=/workspace
Environment=HOME=/home/dim TMPDIR=/mnt/dim-tmp DIM_WORKSPACE_TMPDIR=/mnt/dim-tmp
ExecStart=/usr/local/bin/dim-workspace session resume
[Install]
WantedBy=multi-user.target
`;
    // Only these DIM-owned units are installed. Repository code never becomes an implicit root boot hook.
    await this.machines.rootExec(record, ["node", "--input-type=commonjs", "-e",
      'const fs=require("node:fs"); for(const [name,text] of Object.entries(JSON.parse(process.argv[1]))) { const target="/etc/systemd/system/"+name; fs.writeFileSync(target+".new",text,{mode:0o644}); fs.renameSync(target+".new",target); }',
      JSON.stringify({ "dim-workspace-boot.service": boot, "dim-workspace-session.service": session })]);
    await this.machines.rootExec(record, ["systemctl", "daemon-reload"]);
    await this.machines.rootExec(record, ["systemctl", "enable", "dim-workspace-boot.service", "dim-workspace-session.service"]);
  }
  private async resumeGuestServices(record: WorkspaceRecord): Promise<void> {
    await this.machines.rootExec(record, ["systemctl", "start", "dim-workspace-boot.service", "dim-workspace-session.service"]);
  }
  inspect(record: WorkspaceRecord) { return this.machines.inspect(record); }
  create(record: WorkspaceRecord) { return this.machines.create(record); }
  async start(record: WorkspaceRecord): Promise<void> {
    await this.machines.start(record);
    await this.machines.waitForAgent(record);
    await this.machines.waitForDocker(record);
    await this.machines.rootExec(record, ["node", "-e",
      'if (![24,26].includes(Number(process.versions.node.split(".")[0]))) { console.error("DIM VM guest requires reviewed Node.js 24 or 26"); process.exit(1); }']);
    await this.machines.rootExec(record, ["install", "-d", "-m", "0755", "/usr/local/bin"]);
    await this.machines.rootExec(record, ["sh", "-eu", "-c",
      "test ! -L /mnt && test ! -L /mnt/dim-tmp; install -d -o dim -g dim -m 0700 /mnt/dim-tmp"]);
    for (const asset of workspaceGuestAssets()) await this.machines.installGuestAsset(record, asset);
    await this.installGuestBoot(record);
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
