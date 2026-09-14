import { UserError } from "./errors.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";
import type { WorkspaceCommandInput } from "./workspaceLifecycleTypes.js";
import {
  assertRootSnapshot,
  lifecycleFileExists,
  lifecycleRoot,
  streamLifecycleCommand,
  streamProjectCommand
} from "./workspaceProjectCommands.js";
import { assertContainerRunning } from "./workspaceContainer.js";
import { runnableWorkspace, showWorkspace } from "./workspaceState.js";

export async function runWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: WorkspaceCommandInput
): Promise<number> {
  const record = await runnableWorkspace(runner, options, input.name);
  if (input.command.length === 0) throw new UserError("dim workspace run requires a task");
  await assertRootSnapshot(record);
  const hasEntrypoint = await lifecycleFileExists(runner, record, ".dim/entrypoint.sh");
  if (hasEntrypoint) {
    return streamLifecycleCommand(
      runner,
      record,
      ["sh", `${lifecycleRoot(record)}/.dim/entrypoint.sh`, ...input.command],
      input.interactive,
      true
    );
  }
  return streamProjectCommand(runner, record, input.command, input.interactive, true);
}

export async function execWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: WorkspaceCommandInput
): Promise<number> {
  const persistedRecord = await showWorkspace(runner, options, input.name);
  const containerId = await assertContainerRunning(runner, persistedRecord);
  const record = { ...persistedRecord, containerName: containerId };
  if (input.command.length === 0) throw new UserError("dim workspace exec requires a command");
  return streamProjectCommand(runner, record, input.command, input.interactive, true);
}
