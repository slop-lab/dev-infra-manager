import type { Command } from "commander";
import { UserError } from "@slop-lab/dim-host-core";
import { print, printList, type JsonFlags } from "@slop-lab/dim-host-core/controller/cli";
import { nativePendingProjectView, selectNativeProject } from "./native-project-selector.js";
import { registerNativeProjectBootstrapCommand } from "./native-project-bootstrap-command.js";
import { registerPullRequestCommands } from "./pull-request-commands.js";
import { registerRepositoryOperationCommands, registerRepositoryMergeCommand } from "./repository-operation-commands.js";
import { registerProjectConsoleCommands } from "./project-console-commands.js";
import { registerGitSyncCommands } from "./git-sync-commands.js";
import { registerNativeProjectManifestCommand } from "./native-project-manifest-command.js";
import { registerRepositoryPolicyCommands } from "./repository-policy-commands.js";
import { createNativeProjectAttachmentManagement } from "../projectAttachment.js";

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Manage native Projects and their independent repositories");
  registerProjectConsoleCommands(project);
  registerPullRequestCommands(project);
  registerRepositoryOperationCommands(project);
  project.command("discover").argument("[project]").option("--json", "print machine-readable JSON")
    .action(async (projectId: string | undefined, flags: JsonFlags) => {
      const native = await selectNativeProject();
      const management = createNativeProjectAttachmentManagement(native.connection, native.environment);
      print(await management.invoke(projectId === undefined ? "projects.discover" : "projects.inspect",
        projectId === undefined ? {} : { projectId }), flags);
    });
  project.command("attach").argument("<project>")
    .option("--name <name>", "local Project name; defaults to its authority ID")
    .requiredOption("--configuration-repository <repository>", "repository supplying workspace configuration")
    .requiredOption("--default-repository <repository>", "default checkout and working directory")
    .option("--json", "print machine-readable JSON")
    .action(async (projectId: string, flags: JsonFlags & { name?: string; configurationRepository: string; defaultRepository: string }) => {
      const native = await selectNativeProject();
      const management = createNativeProjectAttachmentManagement(native.connection, native.environment);
      print(await management.invoke("projects.attach", { projectId, ...(flags.name === undefined ? {} : { name: flags.name }),
        configurationRepositoryId: flags.configurationRepository, defaultWorkingRepositoryId: flags.defaultRepository }), flags);
    });
  project.command("create").argument("<project>")
    .option("--project-id <id>", "stable native authority Project ID; defaults to its local name")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, flags: JsonFlags & { projectId?: string }) => {
      const native = await selectNativeProject();
      print(nativePendingProjectView(await native.store.create({ name, projectId: flags.projectId ?? name, ownerHostId: native.connection.hostId })), flags);
    });
  const repository = project.command("repository").description("Import and inspect independently reviewed repositories");
  registerRepositoryMergeCommand(repository);
  registerNativeProjectBootstrapCommand(repository);
  registerNativeProjectManifestCommand(repository);
  registerGitSyncCommands(repository);
  registerRepositoryPolicyCommands(repository);
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
