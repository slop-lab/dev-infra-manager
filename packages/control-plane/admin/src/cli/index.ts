import { Command } from "commander";
import { registerControlPlaneCommands } from "./control-plane-commands.js";

export { registerControlPlaneCommands };

export async function runControlPlaneAdminCli(args: string[]): Promise<void> {
  const program = new Command().name("dim").showSuggestionAfterError().exitOverride();
  registerControlPlaneCommands(program);
  await program.parseAsync(args, { from: "user" });
}
