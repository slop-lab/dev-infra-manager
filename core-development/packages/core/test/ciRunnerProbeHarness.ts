import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { boundedCiRunnerResourceName } from "../../../../core/packages/core/src/ciRunnerVolume.js";

export const IMAGE = `gitea/runner-images@sha256:${"a".repeat(64)}`;

class Barrier {
  readonly wait: Promise<void>;
  private openBarrier: () => void = () => undefined;

  constructor() {
    this.wait = new Promise((resolve) => { this.openBarrier = resolve; });
  }

  open(): void {
    this.openBarrier();
  }
}

export class ProbeRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  failToolProbe = false;
  replaceContainerDuringProbe = false;
  replaceContainerAfterCleanupInspect = false;
  replaceVolumeAfterCleanupInspect = false;
  deferContainerRemoval = false;
  volumeCreateRaceLabels: readonly string[] | undefined;
  readonly containers = new Map<string, readonly string[]>();
  readonly containerIds = new Map<string, string>();
  readonly volumes = new Map<string, readonly string[]>();
  readonly containerVolumes = new Map<string, readonly string[]>();
  readonly containerRemovalStarted = new Barrier();
  readonly containerRemovalReleased = new Barrier();
  private toolProbes = 0;
  private readonly ownedInspections = new Map<string, number>();

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    const resource = args[0] === "container" ? this.containers : args[0] === "volume" ? this.volumes : undefined;
    if (resource && args[1] === "inspect") {
      const name = args[2] ?? "";
      const labels = resource.get(name);
      const identity = args[0] === "container" ? this.containerId(name) : name;
      const inspectionKey = `${args[0]}:${name}`;
      const inspectionCount = (this.ownedInspections.get(inspectionKey) ?? 0) + 1;
      if (labels !== undefined) this.ownedInspections.set(inspectionKey, inspectionCount);
      if (labels !== undefined && inspectionCount === 2 && args[0] === "container" && this.replaceContainerAfterCleanupInspect) {
        this.containers.set(name, ["dim.managed=true", "dim.owner=foreign"]);
        this.containerIds.set(name, `foreign-id:${name}`);
        this.containerVolumes.delete(name);
      }
      if (labels !== undefined && inspectionCount === 2 && args[0] === "volume" && this.replaceVolumeAfterCleanupInspect) {
        this.volumes.set(name, ["dim.managed=true", "dim.owner=foreign"]);
      }
      return result(command, args, {
        stdout: labels ? `${identity}|${labelValues(labels)}` : "",
        exitCode: labels ? 0 : 1,
        stderr: labels ? "" : `No such ${args[0]}`
      });
    }
    if (args[0] === "container" && args[1] === "rm") {
      const target = args.at(-1) ?? "";
      const containerName = [...this.containers.keys()].find((name) => this.containerId(name) === target || name === target);
      if (this.deferContainerRemoval) {
        this.containerRemovalStarted.open();
        await this.containerRemovalReleased.wait;
      }
      if (containerName !== undefined) {
        this.containers.delete(containerName);
        this.containerIds.delete(containerName);
        this.containerVolumes.delete(containerName);
      }
      return result(command, args);
    }
    if (args[0] === "volume" && args[1] === "rm") {
      const volumeName = args.at(-1) ?? "";
      if ([...this.containerVolumes.values()].some((volumes) => volumes.includes(volumeName))) {
        return result(command, args, { exitCode: 1, stderr: `volume ${volumeName} is in use` });
      }
      this.volumes.delete(volumeName);
      return result(command, args);
    }
    if (args[0] === "volume" && args[1] === "create") {
      const volumeName = args.at(-1) ?? "";
      this.volumes.set(volumeName, this.volumeCreateRaceLabels ?? optionValues(args, "--label"));
      return result(command, args, { stdout: volumeName });
    }
    if (args[0] === "run" && args.includes("--detach")) {
      const containerName = optionValue(args, "--name");
      const socketVolume = optionValue(args, "--mount").split(",")
        .find((field) => field.startsWith("source="))?.slice("source=".length);
      this.containers.set(containerName, optionValues(args, "--label"));
      this.containerIds.set(containerName, `container-id:${containerName}`);
      if (socketVolume !== undefined) this.containerVolumes.set(containerName, [socketVolume]);
      return result(command, args);
    }
    const toolProbe = args.includes(IMAGE);
    if (toolProbe) {
      this.toolProbes += 1;
      if (this.replaceContainerDuringProbe && this.toolProbes === 2) {
        this.containerVolumes.delete(probeContainerName());
        this.containers.set(probeContainerName(), ["dim.managed=true", "dim.owner=foreign"]);
      }
    }
    return result(command, args, {
      exitCode: toolProbe && this.failToolProbe ? 127 : 0,
      stderr: toolProbe && this.failToolProbe ? "missing tool" : ""
    });
  }

  async runStreaming(): Promise<number> { return 0; }

  private containerId(name: string): string {
    return this.containerIds.get(name) ?? `container-id:${name}`;
  }
}

function result(
  command: string,
  args: string[],
  output: Partial<Pick<CommandResult, "stdout" | "stderr" | "exitCode">> = {}
): CommandResult {
  return { command, args, stdout: output.stdout ?? "", stderr: output.stderr ?? "", exitCode: output.exitCode ?? 0 };
}

function optionValues(args: readonly string[], option: string): readonly string[] {
  return args.flatMap((value, index) => {
    const optionValue = args[index + 1];
    return value === option && optionValue !== undefined ? [optionValue] : [];
  });
}

function optionValue(args: readonly string[], option: string): string {
  return optionValues(args, option)[0] ?? "";
}

function labelValues(labels: readonly string[]): string {
  return labels.map((label) => label.slice(label.indexOf("=") + 1)).join("|");
}

export function probeContainerName(): string {
  return boundedCiRunnerResourceName(["dim", "ci", "project", "primary", "sysbox", "workload-probe"]);
}

export function probeSocketVolumeName(): string {
  return boundedCiRunnerResourceName(["dim", "ci", "project", "primary", "sysbox", "workload-probe-socket"]);
}
