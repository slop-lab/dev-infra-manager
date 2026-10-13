import { type Command } from "commander";
import { adminStreamCall, interactive } from "./cli-support.js";

export function registerWorkspaceExecutionCommands(program: Command, workspace: Command): void {
  program.command("exec")
  .description("Execute in the recommended agent, or trusted outer workspace for explicit minimal/custom environments")
  .argument("<workspace>")
  .argument("<command...>")
  .allowUnknownOption(true)
  .action(async (name: string, command: string[]) => {
    const result = await adminStreamCall<{ exitCode: number }>("workspace.exec", {
      name,
      command,
      interactive: interactive()
    }, { stdin: true, terminal: interactive() });
    process.exitCode = result.exitCode;
  });

program.command("run")
  .description("Run recommended shell/exec/custom commands or a custom Project task")
  .argument("<workspace>")
  .argument("<task...>")
  .allowUnknownOption(true)
  .action(async (name: string, task: string[]) => {
    const result = await adminStreamCall<{ exitCode: number }>("workspace.run", {
      name,
      command: task,
      interactive: interactive()
    }, { stdin: true, terminal: interactive() });
    process.exitCode = result.exitCode;
  });

workspace.command("exec")
  .description("Execute in the recommended agent, or trusted outer workspace for explicit minimal/custom environments")
  .argument("<workspace>")
  .argument("<command...>")
  .allowUnknownOption(true)
  .action(async (name: string, command: string[]) => {
    const result = await adminStreamCall<{ exitCode: number }>("workspace.exec", {
      name, command, interactive: interactive()
    }, { stdin: true, terminal: interactive() });
    process.exitCode = result.exitCode;
  });

workspace.command("run")
  .description("Run recommended shell/exec/custom commands or a custom Project task")
  .argument("<workspace>")
  .argument("<task...>")
  .allowUnknownOption(true)
  .action(async (name: string, task: string[]) => {
    const result = await adminStreamCall<{ exitCode: number }>("workspace.run", {
      name, command: task, interactive: interactive()
    }, { stdin: true, terminal: interactive() });
    process.exitCode = result.exitCode;
  });
}
