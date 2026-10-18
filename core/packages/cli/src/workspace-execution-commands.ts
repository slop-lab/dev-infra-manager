import { type Command } from "commander";
import { interactive } from "./cli-runtime.js";
import { adminStreamCall } from "./controller-session.js";

export function registerWorkspaceExecutionCommands(workspace: Command): void {
  registerExecutionCommand(workspace, "exec", "command",
    "Execute in the recommended agent, or trusted outer workspace for custom Project environments");
  registerExecutionCommand(workspace, "run", "task",
    "Run recommended shell/exec/custom commands or a custom Project task");
}

function registerExecutionCommand(
  parent: Command,
  operation: "exec" | "run",
  argument: string,
  description: string
): void {
  parent.command(operation)
    .description(description)
    .argument("<workspace>")
    .argument(`<${argument}...>`)
    .allowUnknownOption(true)
    .action(async (name: string, command: string[]) => {
      const terminal = interactive();
      const result = await adminStreamCall<{ exitCode: number }>(`workspace.${operation}`, {
        name, command, interactive: terminal
      }, { stdin: true, terminal });
      process.exitCode = result.exitCode;
    });
}
