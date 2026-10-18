import { UserError } from "@slop-lab/dim-core";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
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
import { streamWorkspaceAgentCommand } from "./workspaceAgentLifecycle.js";
import { workspaceRootSnapshotPath } from "./workspaceLifecycleTypes.js";

export async function runWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: WorkspaceCommandInput
): Promise<number> {
  const record = await runnableWorkspace(runner, options, input.name);
  if (input.command.length === 0) throw new UserError("dim workspace run requires a task");
  await assertRootSnapshot(options.stateRoot, record);
  const environment = record.environment ?? "custom";
  if (environment === "recommended") {
    const [operation, ...command] = input.command;
    if (operation === "shell") {
      if (command.length > 0) throw new UserError("recommended workspace shell does not accept a command");
      return streamWorkspaceAgentCommand(runner, record, ["bash"], input.interactive);
    }
    if (operation === "exec") {
      if (command.length === 0) throw new UserError("recommended workspace exec requires a command");
      return streamWorkspaceAgentCommand(runner, record, command, input.interactive);
    }
    if (operation !== "custom") {
      throw new UserError("recommended workspace run requires shell, exec, or custom");
    }
    if (command.length === 0) throw new UserError("recommended workspace custom requires a command");
    return streamWorkspaceAgentCommand(runner, record, command, input.interactive);
  }
  return runCustomWorkspace(runner, record, input.command, input.interactive);
}

async function runCustomWorkspace(
  runner: StreamingCommandRunner,
  record: Awaited<ReturnType<typeof runnableWorkspace>>,
  command: string[],
  interactive: boolean
): Promise<number> {
  const hasEntrypoint = await lifecycleFileExists(runner, record, ".dim/entrypoint.sh");
  if (!hasEntrypoint) throw new UserError("reviewed Project root does not define .dim/entrypoint.sh");
  return streamLifecycleCommand(
    runner,
    record,
    ["sh", `${lifecycleRoot(record)}/.dim/entrypoint.sh`, ...command],
    interactive,
    true
  );
}

export async function execWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: WorkspaceCommandInput
): Promise<number> {
  const persistedRecord = await showWorkspace(runner, options, input.name);
  const containerId = await assertContainerRunning(runner, options.stateRoot, persistedRecord);
  const record = { ...persistedRecord, containerName: containerId };
  if (input.command.length === 0) throw new UserError("dim workspace exec requires a command");
  const environment = record.environment ?? "custom";
  if (environment === "recommended") {
    return streamWorkspaceAgentCommand(runner, record, input.command, input.interactive);
  }
  return streamProjectCommand(runner, record, input.command, input.interactive, true);
}
