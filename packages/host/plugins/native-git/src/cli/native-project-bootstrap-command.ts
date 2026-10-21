import { mkdir } from "node:fs/promises";
import path from "node:path";
import { bootstrapNativeProjectRepository } from "../nativeProjectBootstrap.js";
import { UserError } from "@slop-lab/dim-host-core";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import type { Command } from "commander";
import { selectedControlPlaneImporterFile } from "../controlPlaneSelection.js";
import { print, type JsonFlags } from "@slop-lab/dim-host-core/controller/cli";
import { readNativeRepositoryPolicyFile } from "./repository-policy-file.js";
import { nativeProjectImporter, selectNativeProject } from "./native-project-selector.js";

type ImportFlags = JsonFlags & { source: string; ref: string; policy?: string; repositoryPolicy?: boolean; registrarConnection?: string; importerConnection?: string; gitExecutable: string };
export function registerNativeProjectBootstrapCommand(repository: Command): void {
  repository.command("import")
    .description("Import an independently reviewed repository into a native Project")
    .argument("<project>").argument("<repository>")
    .requiredOption("--source <absolute-path>", "already-local reviewed Git repository")
    .requiredOption("--ref <full-branch-ref>", "protected ref such as refs/heads/main")
    .option("--policy <absolute-file>", "trusted policy declarations for selected plugins")
    .option("--repository-policy", "read reviewed .dim/repos.yml from the selected commit")
    .option("--registrar-connection <absolute-path>", "override the selected host's registrar connection")
    .option("--importer-connection <absolute-path>", "override the selected host's importer connection")
    .option("--git-executable <absolute-path>", "trusted host Git executable", "/usr/bin/git")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, repositoryId: string, flags: ImportFlags) => {
      if (flags.policy !== undefined && flags.repositoryPolicy) throw new UserError("choose --policy or --repository-policy");
      const native = await selectNativeProject();
      const project = await native.store.read(name, native.connection.hostId);
      if (!project) throw new UserError(`Project '${name}' does not exist; create it before importing repositories`);
      const importerConnectionFile = flags.importerConnection ?? await selectedControlPlaneImporterFile();
      const registrarConnectionFile = flags.registrarConnection ?? path.join(path.dirname(importerConnectionFile), "registrar.json");
      for (const file of [flags.source, ...(flags.policy === undefined ? [] : [flags.policy]), flags.gitExecutable, importerConnectionFile, registrarConnectionFile]) {
        if (!path.isAbsolute(file)) throw new UserError("repository import paths must be absolute on the selected host");
      }
      const policy = flags.policy === undefined ? { repositoryId, extensions: {} } : await readNativeRepositoryPolicyFile(flags.policy);
      if (policy.repositoryId !== repositoryId) throw new UserError("repository policy belongs to another repository");
      const importer = await nativeProjectImporter({ ...native, environment: { ...native.environment,
        DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: importerConnectionFile } });
      const stateRoot = managedStateRoot(process.env);
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });
      await bootstrapNativeProjectRepository({ name, projectId: project.projectId, repositoryId,
        stateRoot, scratchRoot: stateRoot, sourceRepository: flags.source, selectedRef: flags.ref,
        registrarConnectionFile, importerConnectionFile, gitExecutable: flags.gitExecutable,
        policySource: flags.repositoryPolicy ? { kind: "reviewed-manifest" } : { kind: "manifest-free", extensions: policy.extensions }, signal: AbortSignal.timeout(120_000) });
      const record = await native.store.admitRepository(name, repositoryId, importer, native.connection, AbortSignal.timeout(30_000));
      print(record.repositories[repositoryId], flags);
    });
}
