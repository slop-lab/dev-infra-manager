import { Command } from "commander";
import { registerProjectCommands } from "./project-commands.js";
export { registerProjectCommands } from "./project-commands.js";
export { registerNativeProjectBootstrapCommand } from "./native-project-bootstrap-command.js";
export { readNativeReviewPolicyFile } from "./native-review-policy-file.js";
export * from "./native-project-selector.js";

export async function runNativeGitCli(args: readonly string[]): Promise<void> {
  const program = new Command().name("dim");
  registerProjectCommands(program);
  await program.parseAsync([...args], { from: "user" });
}
