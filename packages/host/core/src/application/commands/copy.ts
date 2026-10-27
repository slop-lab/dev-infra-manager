import type { Command } from "commander";
import { UserError } from "../../workspace.js";
import { workspaceName } from "../../workspace/store.js";
import { runStreamOperation } from "./operations.js";

interface CopyFlags { readonly recursive?: boolean; readonly overwrite?: boolean; readonly expectId?: string }

export function registerWorkspaceCopyCommand(parent: Command): void {
  parent.command("cp")
    .description("Copy between the operator machine and a selected workspace")
    .argument("<source>")
    .argument("<destination>")
    .option("-r, --recursive", "copy a directory tree")
    .option("--overwrite", "replace an existing exact destination")
    .option("--expect-id <uuid>", "reject a workspace replaced since it was selected")
    .action(async (source: string, destination: string, flags: CopyFlags) => {
      const sourceWorkspace = copyOperand(source);
      const destinationWorkspace = copyOperand(destination);
      if ((source === "-") === (destination === "-") || (sourceWorkspace === undefined) === (destinationWorkspace === undefined)) {
        throw new UserError("cp requires one '-' stream operand and one WORKSPACE:PATH operand");
      }
      const selected = sourceWorkspace ?? destinationWorkspace;
      if (selected === undefined || flags.expectId === undefined) throw new UserError("workspace copy requires a pinned workspace identity");
      process.exitCode = await runStreamOperation({ operation: "copy", input: {
        name: selected.name, path: selected.path, direction: source === "-" ? "receive" : "send",
        recursive: flags.recursive === true, overwrite: flags.overwrite === true, expectedId: flags.expectId
      } });
    });
}

function copyOperand(value: string): { readonly name: string; readonly path: string } | undefined {
  const match = /^([^:]+):(.*)$/.exec(value);
  if (match === null) return undefined;
  if (!match[2] || match[2].includes("\0")) throw new UserError("workspace copy path must be nonempty");
  return { name: workspaceName(match[1] ?? ""), path: match[2] };
}
