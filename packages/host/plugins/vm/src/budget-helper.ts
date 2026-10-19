import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { UserError, type CommandRunner, type WorkspaceResources } from "@slop-lab/dim-core/workspace";
import type { VmBudget } from "./budget.js";

/** Host-selected helper only: no shell, arbitrary executable, target path or project is sent to root. */
export class CommandVmBudget implements VmBudget {
  constructor(private readonly runner: CommandRunner, private readonly helper: string) {}
  prepare(identity: { instance: string }, resources: WorkspaceResources): Promise<void> { return this.call("prepare", { ...identity, resources }); }
  apply(identity: { instance: string; pid: number }, resources: WorkspaceResources): Promise<void> { return this.call("apply", { ...identity, resources }); }
  verify(identity: { instance: string; pid: number }, resources: WorkspaceResources): Promise<void> { return this.call("verify", { ...identity, resources }); }
  release(instance: string): Promise<void> { return this.call("release", { instance }); }
  private async call(operation: string, input: object): Promise<void> {
    if (!path.isAbsolute(this.helper) || await realpath(this.helper) !== this.helper) throw new UserError("VM budget helper must be an absolute canonical root-owned executable");
    const file = await lstat(this.helper);
    if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0 || (file.mode & 0o111) === 0) throw new UserError("VM budget helper must be root-owned and not group/world-writable");
    let directory = path.dirname(this.helper);
    for (;;) {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) throw new UserError("VM budget helper ancestors must be root-owned and not group/world-writable");
      if (directory === "/") break;
      directory = path.dirname(directory);
    }
    const root = process.getuid?.() === 0;
    const result = await this.runner.run(root ? this.helper : "sudo", root ? [operation] : ["-n", "--", this.helper, operation], { stdin: Readable.from([JSON.stringify(input)]), signal: AbortSignal.timeout(15_000) });
    if (result.exitCode !== 0) throw new UserError(`VM host budget ${operation} failed: ${result.stderr.trim()}`);
    const response: unknown = JSON.parse(result.stdout);
    if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true) throw new UserError("VM budget helper did not confirm the operation");
  }
}
