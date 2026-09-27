import type {
  CommandResult,
  StreamingCommandRunner
} from "../../../../core/packages/core/src/types.js";

export const CONTAINER_LABEL_KEYS = [
  "dim.managed", "dim.owner", "dim.project", "dim.project-id", "dim.capacity",
  "dim.executor", "dim.resource", "dim.kind", "dim.digest"
] as const;

export type ContainerFixture = {
  readonly id: string;
  readonly name: string;
  readonly labels: readonly string[];
  running: boolean;
};

export class StatefulContainerRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  private readonly names = new Map<string, string>();
  private readonly containers = new Map<string, ContainerFixture>();
  private replacement: ContainerFixture | undefined;
  private inspectFailure: string | undefined;
  private inspectOutput: string | undefined;
  private disappearAfterInspect = false;
  private stopFailure: string | undefined;
  private removeFailure: string | undefined;

  add(container: ContainerFixture): void {
    this.names.set(container.name, container.id);
    this.containers.set(container.id, container);
  }

  current(name: string): ContainerFixture | undefined {
    return this.resolve(name);
  }

  replaceAfterNextInspect(container: ContainerFixture): void {
    this.replacement = container;
  }

  failNextInspect(stderr: string): void {
    this.inspectFailure = stderr;
  }

  returnNextInspect(stdout: string): void {
    this.inspectOutput = stdout;
  }

  disappearAfterNextInspect(): void {
    this.disappearAfterInspect = true;
  }

  failNextStop(stderr: string): void {
    this.stopFailure = stderr;
  }

  failNextRemove(stderr: string): void {
    this.removeFailure = stderr;
  }

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === "container" && args[1] === "inspect") return this.inspect(command, args);
    if (args[0] === "container" && args[1] === "rm") return this.remove(command, args);
    if (args[0] === "start" || args[0] === "stop") return this.setRunning(command, args);
    if (args[0] === "volume" && args[1] === "inspect") {
      return result(command, args, 1, "", "No such volume");
    }
    return result(command, args);
  }

  async runStreaming(): Promise<number> {
    return 0;
  }

  private inspect(command: string, args: string[]): CommandResult {
    const target = args[2] ?? "";
    if (this.inspectFailure !== undefined) {
      const stderr = this.inspectFailure;
      this.inspectFailure = undefined;
      return result(command, args, 1, "", stderr);
    }
    if (this.inspectOutput !== undefined) {
      const stdout = this.inspectOutput;
      this.inspectOutput = undefined;
      return result(command, args, 0, `${stdout}\n`);
    }
    const container = this.resolve(target);
    if (container === undefined) return result(command, args, 1, "", `Error: No such object: ${target}`);
    const format = args.at(-1) ?? "";
    const stdout = format === "{{.State.Running}}"
      ? String(container.running)
      : [container.id, ...CONTAINER_LABEL_KEYS.map((key) => labelValue(container.labels, key))].join("|");
    if (this.replacement !== undefined) {
      this.add(this.replacement);
      this.replacement = undefined;
    }
    if (this.disappearAfterInspect) {
      this.containers.delete(container.id);
      if (this.names.get(container.name) === container.id) this.names.delete(container.name);
      this.disappearAfterInspect = false;
    }
    return result(command, args, 0, `${stdout}\n`);
  }

  private remove(command: string, args: string[]): CommandResult {
    const target = args.at(-1) ?? "";
    if (this.removeFailure !== undefined) {
      const stderr = this.removeFailure;
      this.removeFailure = undefined;
      return result(command, args, 1, "", stderr);
    }
    const container = this.resolve(target);
    if (container === undefined) return result(command, args, 1, "", `Error: No such container: ${target}`);
    this.containers.delete(container.id);
    if (this.names.get(container.name) === container.id) this.names.delete(container.name);
    return result(command, args);
  }

  private setRunning(command: string, args: string[]): CommandResult {
    const target = args[1] ?? "";
    if (args[0] === "stop" && this.stopFailure !== undefined) {
      const stderr = this.stopFailure;
      this.stopFailure = undefined;
      return result(command, args, 1, "", stderr);
    }
    const container = this.resolve(target);
    if (container === undefined) return result(command, args, 1, "", `Error: No such container: ${target}`);
    container.running = args[0] === "start";
    return result(command, args, 0, `${container.id}\n`);
  }

  private resolve(target: string): ContainerFixture | undefined {
    const id = this.containers.has(target) ? target : this.names.get(target);
    return id === undefined ? undefined : this.containers.get(id);
  }
}

function labelValue(labels: readonly string[], key: string): string {
  return labels.find((label) => label.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
}

function result(command: string, args: string[], exitCode = 0, stdout = "", stderr = ""): CommandResult {
  return { command, args, exitCode, stdout, stderr };
}
