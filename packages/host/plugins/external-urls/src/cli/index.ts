import { Command } from "commander";
import { registerExternalUrlCommands } from "./commands.js";
export async function runExternalUrlCli(args: readonly string[]): Promise<void> {
 const program = new Command().name("dim").exitOverride();
 registerExternalUrlCommands(program);
 await program.parseAsync([...args], { from: "user" });
}
