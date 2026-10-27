import path from "node:path";
import { UserError } from "../errors.js";
import type { CommandRunner, RunOptions, StreamingCommandRunner } from "../types.js";
import { workspaceCopyCleanup, workspaceCopyMarker } from "./copy.js";
import type { WorkspaceRecord } from "./models.js";
import type { WorkspaceRuntimeCopy } from "./service.js";

type ContainerCopyInput = {
  readonly runner: StreamingCommandRunner;
  readonly cleanupRunner: CommandRunner;
  readonly record: WorkspaceRecord;
  readonly container: string;
  readonly operation: WorkspaceRuntimeCopy;
  readonly runArguments: string[];
  readonly options: RunOptions;
};

export async function runContainerWorkspaceCopy(input: ContainerCopyInput): Promise<number> {
  let exitCode: number | undefined;
  let failure: unknown;
  try {
    exitCode = await input.runner.runStreaming("docker", input.runArguments, input.options);
    return exitCode;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (exitCode !== 0 || input.options.signal?.aborted || failure !== undefined) {
      const workdir = `/workspace${input.record.source.workingDirectory ? `/${input.record.source.workingDirectory}` : ""}`;
      const target = path.posix.resolve(workdir, input.operation.path);
      const cleanup = await input.cleanupRunner.run("docker", [
        "exec", "--user", "dim", input.container, "node", "--input-type=commonjs", "-e",
        workspaceCopyCleanup, target, workspaceCopyMarker, "cleanup", input.operation.token
      ], { signal: AbortSignal.timeout(3000) });
      if (cleanup.exitCode !== 0) {
        throw new UserError(`workspace '${input.record.name}' copy cleanup could not be confirmed: ${cleanup.stderr.trim() || cleanup.stdout.trim()}`);
      }
    }
  }
}
