import type { CommandResult, CommandRunner, RunOptions } from "../../../../core/packages/core/src/types.js";

export const GITEA_CREDENTIALS = {
  adminUsername: "admin",
  adminPassword: "admin-secret",
  writerUsername: "writer",
  writerPassword: "writer-secret",
  maintainerUsername: "maintainer",
  maintainerPassword: "maintainer-secret"
};

type Container = {
  readonly id: string;
  readonly managed: boolean;
  running: boolean;
  policyEntries: boolean[];
};

type Failure = "start" | "policy-check" | "policy-output" | "policy-edit" | "restart" | "policy-revert";

export class GiteaPolicyRunner implements CommandRunner {
  readonly calls: string[][] = [];
  private readonly containers = new Map<string, Container>();
  private containerAtName: string | undefined;
  private replacementAfterInspect: Container | undefined;

  constructor(container?: Container, private readonly failure?: Failure) {
    if (container !== undefined) this.add(container);
  }

  replaceNameAfterInspect(container: Container): void {
    this.replacementAfterInspect = container;
  }

  async run(command: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === "network" || args[0] === "volume") return result(command, args, 0, "true\n");
    if (args[0] === "container" && args[1] === "inspect") return this.inspect(command, args);
    if (args[0] === "run") {
      const created = { id: "created-gitea-id", managed: true, running: true, policyEntries: [true] };
      this.add(created);
      return result(command, args, 0, `${created.id}\n`);
    }
    if (args[0] === "start") return this.changeRunning(command, args, true, "start");
    if (args[0] === "restart") return this.changeRunning(command, args, true, "restart");
    if (args[0] === "exec") return this.exec(command, args);
    return result(command, args, 1, "", "unexpected command");
  }

  private add(container: Container): void {
    this.containers.set(container.id, container);
    this.containerAtName = container.id;
  }

  private inspect(command: string, args: string[]): CommandResult {
    const container = this.resolve(args[2] ?? "");
    if (container === undefined) return result(command, args, 1, "", "Error: No such container: dim-gitea");
    const format = args.at(-1) ?? "";
    const stdout = format.includes("{{.Id}}")
      ? `${container.id}|${String(container.managed)}|${String(container.running)}\n`
      : `${String(container.managed)}|${String(container.running)}\n`;
    if (this.replacementAfterInspect !== undefined) {
      this.add(this.replacementAfterInspect);
      this.replacementAfterInspect = undefined;
    }
    return result(command, args, 0, stdout);
  }

  private changeRunning(
    command: string,
    args: string[],
    running: boolean,
    action: Extract<Failure, "start" | "restart">
  ): CommandResult {
    if (this.failure === action) return result(command, args, 1, "", `${action} failed`);
    const container = this.resolve(args[1] ?? "");
    if (container === undefined) return result(command, args, 1, "", "container not found");
    container.running = running;
    if (action === "restart" && this.failure === "policy-revert") container.policyEntries = [false];
    return result(command, args);
  }

  private exec(command: string, args: string[]): CommandResult {
    const target = execTarget(args);
    const container = this.resolve(target);
    if (container === undefined) return result(command, args, 1, "", "container not found");
    if (args.includes("edit-ini")) {
      if (this.failure === "policy-edit") return result(command, args, 1, "", "policy edit failed");
      container.policyEntries = [true];
      return result(command, args);
    }
    if (args.some((argument) => argument.includes("/data/dim/credentials.json"))) {
      return result(command, args, 0, JSON.stringify(GITEA_CREDENTIALS));
    }
    if (args.includes("sh") && args.includes("-c")) {
      if (this.failure === "policy-check") return result(command, args, 1, "", "policy check failed");
      if (this.failure === "policy-output") return result(command, args, 0, "unexpected\n");
      const canonical = container.policyEntries.length === 1 && container.policyEntries[0] === true;
      return result(command, args, 0, `${String(canonical)}\n`);
    }
    return result(command, args);
  }

  private resolve(target: string): Container | undefined {
    const id = this.containers.has(target) ? target : target === "dim-gitea" ? this.containerAtName : undefined;
    return id === undefined ? undefined : this.containers.get(id);
  }
}

export function giteaContainer(
  input: {
    readonly id: string;
    readonly running: boolean;
    readonly policyEntries: readonly boolean[];
    readonly managed?: boolean;
  }
): Container {
  return { ...input, policyEntries: [...input.policyEntries], managed: input.managed ?? true };
}

function result(command: string, args: string[], exitCode = 0, stdout = "", stderr = ""): CommandResult {
  return { command, args, exitCode, stdout, stderr };
}

function execTarget(args: readonly string[]): string {
  let index = 1;
  while (args[index] === "--user" || args[index] === "--env") index += 2;
  return args[index] ?? "";
}
