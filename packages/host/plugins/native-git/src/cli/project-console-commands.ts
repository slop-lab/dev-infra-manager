import type { Command } from "commander";
import { UserError } from "@slop-lab/dim-host-core";
import { print, type JsonFlags } from "@slop-lab/dim-host-core/controller/cli";
import { describeNativeProjectConsole, invokeNativeProjectConsole } from "../projectConsole.js";
export function registerProjectConsoleCommands(project: Command): void {
  const console = project.command("console").description("Discover and invoke controller-scoped Git review and sync operations");
  console.command("describe").option("--expected-generation <hash>", "require the previously attested control-plane generation").option("--json", "print machine-readable JSON").action(async (flags: JsonFlags & { expectedGeneration?: string }) => print(await describeNativeProjectConsole(process.env, flags.expectedGeneration), flags));
  console.command("invoke").argument("<operation>").requiredOption("--input <json>", "validated operation input as JSON").requiredOption("--expected-generation <hash>", "require the previously attested control-plane generation")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, flags: JsonFlags & { input: string; expectedGeneration: string }) => {
      if (Buffer.byteLength(flags.input, "utf8") > 64 * 1024) throw new UserError("Native Git console input exceeds its bound");
      let input: unknown;
      try { input = JSON.parse(flags.input) as unknown; } catch { throw new UserError("Native Git console input must be valid JSON"); }
      print(await invokeNativeProjectConsole(name, input, flags.expectedGeneration), flags);
    });
}
