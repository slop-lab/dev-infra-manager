import { mkdir } from "node:fs/promises";
import path from "node:path";
import { bootstrapNativeProjectRepository, managedStateRoot, UserError } from "@slop-lab/dim-managed";
import type { Command } from "commander";
import { selectedControlPlaneImporterFile } from "../controlPlaneSelection.js";
import { print, type JsonFlags } from "./cli-support.js";
import { readNativeReviewPolicyFile } from "./native-review-policy-file.js";
import { nativeProjectImporter, selectNativeProject } from "./native-project-selector.js";

type ImportFlags = JsonFlags & { source: string; ref: string; reviewPolicy: string; registrarConnection?: string; importerConnection?: string; gitExecutable: string };
export function registerNativeProjectBootstrapCommand(repository: Command): void {
  repository.command("import")
    .description("Import an independently reviewed repository into a native Project")
    .argument("<project>").argument("<repository>")
    .requiredOption("--source <absolute-path>", "already-local reviewed Git repository")
    .requiredOption("--ref <full-branch-ref>", "protected ref such as refs/heads/main")
    .requiredOption("--review-policy <absolute-file>", "trusted repository review and CI input policy")
    .option("--registrar-connection <absolute-path>", "override the selected host's registrar connection")
    .option("--importer-connection <absolute-path>", "override the selected host's importer connection")
    .option("--git-executable <absolute-path>", "trusted host Git executable", "/usr/bin/git")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, repositoryId: string, flags: ImportFlags) => {
      const native = await selectNativeProject();
      const project = await native.store.read(name, native.connection.hostId);
      if (!project) throw new UserError(`Project '${name}' does not exist; create it before importing repositories`);
      const importerConnectionFile = flags.importerConnection ?? await selectedControlPlaneImporterFile();
      const registrarConnectionFile = flags.registrarConnection ?? path.join(path.dirname(importerConnectionFile), "registrar.json");
      for (const file of [flags.source, flags.reviewPolicy, flags.gitExecutable, importerConnectionFile, registrarConnectionFile]) {
        if (!path.isAbsolute(file)) throw new UserError("repository import paths must be absolute on the selected host");
      }
      const policy = await readNativeReviewPolicyFile(flags.reviewPolicy);
      if (policy.repositoryId !== repositoryId) throw new UserError("review policy belongs to another repository");
      const importer = await nativeProjectImporter({ ...native, environment: { ...native.environment,
        DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: importerConnectionFile } });
      const stateRoot = managedStateRoot(process.env);
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });
      await bootstrapNativeProjectRepository({ name, projectId: project.projectId, repositoryId,
        stateRoot, scratchRoot: stateRoot, sourceRepository: flags.source, selectedRef: flags.ref,
        registrarConnectionFile, importerConnectionFile, gitExecutable: flags.gitExecutable,
        policySource: { kind: "manifest-free", review: policy.review }, signal: AbortSignal.timeout(120_000) });
      const record = await native.store.admitRepository(name, repositoryId, importer, native.connection, AbortSignal.timeout(30_000));
      print(record.repositories[repositoryId], flags);
    });
}
