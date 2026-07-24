import { UserError } from "./errors.js";
import type { CommandResult, CommandRunner, PlannedCommand } from "./types.js";

export function shellQuote(command: string, args: string[]): string {
  return [command, ...args].map(quote).join(" ");
}

export function quote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export async function runPlannedCommand(
  runner: CommandRunner,
  planned: PlannedCommand,
  dryRun: boolean
): Promise<CommandResult | undefined> {
  const commandLine = shellQuote(planned.sudo ? "sudo" : planned.command, planned.sudo ? [planned.command, ...planned.args] : planned.args);
  if (dryRun) {
    process.stdout.write(`${commandLine}\n`);
    return undefined;
  }

  const result = await runner.run(planned.command, planned.args, planned.sudo === undefined ? {} : { sudo: planned.sudo });
  if (result.exitCode !== 0 && !planned.allowFailure) {
    throw new UserError(`Command failed (${result.exitCode}): ${commandLine}\n${result.stderr}`);
  }
  return result;
}
