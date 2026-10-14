import { type Command } from "commander";
import { UserError } from "@slop-lab/dim-core";
import { print, printList, type JsonFlags } from "./cli-support.js";
import {
  nativePendingProjectView,
  nativeProjectImporter,
  selectNativeProject
} from "./native-project-selector.js";
import { registerNativeProjectBootstrapCommand } from "./native-project-bootstrap-command.js";

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Manage native Projects");
  registerNativeProjectBootstrapCommand(project);

  project.command("create")
    .description("Publish a bootstrapped native Project as ready")
    .argument("<project>")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, flags: JsonFlags) => {
      const native = await selectNativeProject();
      const importer = await nativeProjectImporter(native);
      await native.store.admit(name, importer, AbortSignal.timeout(10_000));
      const record = await native.store.ready(name, native.connection, AbortSignal.timeout(10_000));
      print(nativePendingProjectView(record), flags);
    });

  project.command("list")
    .alias("ls")
    .description("List native Projects")
    .option("--json", "print machine-readable JSON")
    .action(async (flags: JsonFlags) => {
      const native = await selectNativeProject();
      const records = await native.store.list(native.connection.hostId);
      printList(records.map(nativePendingProjectView), [
        "name", "projectId", "serviceId", "ownerHostId", "phase", "rootAlias", "protectedRef",
        "rootCommit", "rootTree", "policyRevision", "requiredReviewRevision",
        "requiredJobSetRevision", "runnable", "readyAt"
      ], flags);
    });

  project.command("show")
    .description("Show a native Project")
    .argument("<project>")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, flags: JsonFlags) => {
      const native = await selectNativeProject();
      const record = await native.store.read(name, native.connection.hostId);
      if (record === undefined) throw new UserError(`native Project '${name}' not found`);
      print(nativePendingProjectView(record), flags);
    });
}
