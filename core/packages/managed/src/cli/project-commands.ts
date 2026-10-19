import type { Command } from "commander";
import { UserError } from "@slop-lab/dim-managed";
import { print, printList, type JsonFlags } from "./cli-support.js";
import { nativePendingProjectView, selectNativeProject } from "./native-project-selector.js";
import { registerNativeProjectBootstrapCommand } from "./native-project-bootstrap-command.js";

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Manage native Projects and their independent repositories");
  project.command("create").argument("<project>")
    .option("--project-id <id>", "stable native authority Project ID; defaults to its local name")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, flags: JsonFlags & { projectId?: string }) => {
      const native = await selectNativeProject();
      print(nativePendingProjectView(await native.store.create({ name, projectId: flags.projectId ?? name, ownerHostId: native.connection.hostId })), flags);
    });
  const repository = project.command("repository").description("Import and inspect independently reviewed repositories");
  registerNativeProjectBootstrapCommand(repository);
  repository.command("list").alias("ls").argument("<project>").option("--json", "print machine-readable JSON")
    .action(async (name: string, flags: JsonFlags) => {
      const native = await selectNativeProject(), record = await native.store.read(name, native.connection.hostId);
      if (!record) throw new UserError(`Project '${name}' does not exist`);
      printList(Object.values(record.repositories), ["repositoryId", "phase", "protectedRef", "commit", "tree", "readyAt"], flags);
    });
  project.command("configure").argument("<project>")
    .requiredOption("--configuration-repository <repository>", "repository supplying workspace configuration")
    .requiredOption("--default-repository <repository>", "default checkout and working directory")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, flags: JsonFlags & { configurationRepository: string; defaultRepository: string }) => {
      const native = await selectNativeProject();
      print(nativePendingProjectView(await native.store.configure(name, { configurationRepositoryId: flags.configurationRepository,
        defaultWorkingRepositoryId: flags.defaultRepository }, native.connection, AbortSignal.timeout(30_000))), flags);
    });
  project.command("list").alias("ls").option("--json", "print machine-readable JSON")
    .action(async (flags: JsonFlags) => {
      const native = await selectNativeProject();
      printList((await native.store.list(native.connection.hostId)).map(nativePendingProjectView),
        ["name", "projectId", "phase", "configurationRepositoryId", "defaultWorkingRepositoryId", "runnable"], flags);
    });
  project.command("show").argument("<project>").option("--json", "print machine-readable JSON")
    .action(async (name: string, flags: JsonFlags) => {
      const native = await selectNativeProject(), record = await native.store.read(name, native.connection.hostId);
      if (!record) throw new UserError(`Project '${name}' does not exist`);
      print(nativePendingProjectView(record), flags);
    });
}
