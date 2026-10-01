import type { CommandResult, CommandRunner } from "../../../../core/packages/core/src/types.js";
import { GITEA_CREDENTIALS } from "./giteaOrganizationPolicyFixture.js";

const CREDENTIAL_PATH = "/data/dim/credentials.json";

export class Barrier {
  readonly wait: Promise<void>;
  private openBarrier: () => void = () => undefined;

  constructor() {
    this.wait = new Promise((resolve) => {
      this.openBarrier = resolve;
    });
  }

  open(): void {
    this.openBarrier();
  }
}

export type GiteaRuntimeState = {
  network: boolean;
  volume: boolean;
  containerId: string | undefined;
  credentials: boolean;
};

type BlockOperation = "network-create" | "webhook-edit";

export class ConcurrentGiteaRunner implements CommandRunner {
  readonly firstMutationEntered = new Barrier();
  readonly releaseFirstMutation = new Barrier();
  readonly calls: string[][] = [];
  readonly interleavedCalls: string[][] = [];
  readonly mutations: string[] = [];
  failBlockedOperation = false;
  private gateUsed = false;
  private operationBlocked = false;

  constructor(
    private readonly state: GiteaRuntimeState,
    private readonly blockOperation: BlockOperation
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    const call = [command, ...args];
    this.calls.push(call);
    if (this.operationBlocked) {
      this.interleavedCalls.push(call);
      return result(command, args, { exitCode: 1, stderr: "interleaved command" });
    }
    if (args[0] === "container" && args[1] === "inspect") return this.inspectContainer(command, args);
    if (args[0] === "network" && args[1] === "inspect") return this.inspectResource(command, args, this.state.network);
    if (args[0] === "volume" && args[1] === "inspect") return this.inspectResource(command, args, this.state.volume);
    if (args[0] === "network" && args[1] === "create") return this.createNetwork(command, args);
    if (args[0] === "volume" && args[1] === "create") {
      this.state.volume = true;
      this.mutations.push("volume-create");
      return result(command, args, { exitCode: 0 });
    }
    if (args[0] === "run") {
      this.state.containerId = "created-gitea-id";
      this.mutations.push("container-create");
      return result(command, args, { exitCode: 0, stdout: "created-gitea-id\n" });
    }
    if (args[0] === "restart") {
      this.mutations.push(`restart:${args[1] ?? ""}`);
      return result(command, args, { exitCode: 0 });
    }
    if (args[0] === "exec") return this.exec(command, args);
    return result(command, args, { exitCode: 0 });
  }

  private inspectContainer(command: string, args: string[]): CommandResult {
    return this.state.containerId === undefined
      ? result(command, args, { exitCode: 1, stderr: "Error: No such container: dim-gitea" })
      : result(command, args, { exitCode: 0, stdout: `${this.state.containerId}|true|true\n` });
  }

  private inspectResource(command: string, args: string[], exists: boolean): CommandResult {
    return exists
      ? result(command, args, { exitCode: 0, stdout: "true\n" })
      : result(command, args, {
        exitCode: 1,
        stderr: args[0] === "network"
          ? "Error response from daemon: network dim-control not found"
          : "Error response from daemon: get dim-gitea-data: no such volume"
      });
  }

  private async createNetwork(command: string, args: string[]): Promise<CommandResult> {
    const blocked = await this.block("network-create", command, args);
    if (blocked !== undefined) return blocked;
    this.state.network = true;
    this.mutations.push("network-create");
    return result(command, args, { exitCode: 0 });
  }

  private async exec(command: string, args: string[]): Promise<CommandResult> {
    if (args.some((argument) => argument.startsWith("GITEA__webhook__ALLOWED_HOST_LIST="))) {
      const blocked = await this.block("webhook-edit", command, args);
      if (blocked !== undefined) return blocked;
      this.mutations.push("webhook-edit");
      return result(command, args, { exitCode: 0 });
    }
    if (args.some((argument) => argument.startsWith("DIM_CREDENTIALS="))) {
      this.state.credentials = true;
      this.mutations.push("credential-store");
      return result(command, args, { exitCode: 0 });
    }
    if (args.some((argument) => argument.includes(CREDENTIAL_PATH))) {
      return this.state.credentials
        ? result(command, args, { exitCode: 0, stdout: JSON.stringify(GITEA_CREDENTIALS) })
        : result(command, args, { exitCode: 42 });
    }
    if (args.some((argument) => argument.includes("awk"))) {
      return result(command, args, { exitCode: 0, stdout: "true\n" });
    }
    if (args.includes("user") && args.includes("create")) {
      this.mutations.push("user-create");
      return result(command, args, { exitCode: 0 });
    }
    return result(command, args, { exitCode: 0 });
  }

  private async block(
    operation: BlockOperation,
    command: string,
    args: string[]
  ): Promise<CommandResult | undefined> {
    if (this.blockOperation !== operation || this.gateUsed) return undefined;
    this.gateUsed = true;
    this.operationBlocked = true;
    this.firstMutationEntered.open();
    await this.releaseFirstMutation.wait;
    this.operationBlocked = false;
    return this.failBlockedOperation
      ? result(command, args, { exitCode: 1, stderr: "injected mutation failure" })
      : undefined;
  }
}

function result(
  command: string,
  args: string[],
  output: { readonly exitCode: number; readonly stderr?: string; readonly stdout?: string }
): CommandResult {
  return {
    command,
    args,
    exitCode: output.exitCode,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? ""
  };
}
