import { loadPrivateJson, reviewerConnectionSchema } from "@slop-lab/dim-service-client-native-git";
import { importNativeProjectPublicRepository } from "../publicRepositoryImport.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { bootstrapNativeProjectRepository } from "../nativeProjectBootstrap.js";
import { UserError } from "@slop-lab/dim-host-core";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import type { Command } from "commander";
import { selectedControlPlaneHostFile, selectedControlPlaneImporterFile } from "../controlPlaneSelection.js";
import { print, type JsonFlags } from "@slop-lab/dim-host-core/controller/cli";
import { readNativeRepositoryPolicyFile } from "./repository-policy-file.js";
import { nativeProjectImporter, selectNativeProject } from "./native-project-selector.js";

type ImportFlags = JsonFlags & { source: string; ref?: string; branch?: string; policy?: string; repositoryPolicy?: boolean; registrarConnection?: string; importerConnection?: string; gitExecutable: string };
export function registerNativeProjectBootstrapCommand(repository: Command): void {
  repository.command("import")
    .description("Import an independently reviewed repository into a native Project")
    .argument("<project>").argument("<repository>")
    .requiredOption("--source <path-or-https-url>", "reviewed local Git repository or public HTTPS repository URL")
    .option("--ref <full-branch-ref>", "protected ref such as refs/heads/main; required for local sources")
    .option("--branch <name>", "public HTTPS source branch; defaults to the remote default branch")
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
      const remote = /^[a-z][a-z0-9+.-]*:/i.test(flags.source);
      for (const file of [...(remote ? [] : [flags.source]), ...(flags.policy === undefined ? [] : [flags.policy]), flags.gitExecutable, importerConnectionFile, registrarConnectionFile]) {
        if (!path.isAbsolute(file)) throw new UserError("repository import paths must be absolute on the selected host");
      }
      if (remote && flags.repositoryPolicy) throw new UserError("Public URL import cannot trust an unreviewed repository policy; use an explicit host --policy file");
      if (!remote && (!flags.ref || flags.branch !== undefined)) throw new UserError("Local repository import requires --ref and does not accept --branch");
      if (remote && flags.branch !== undefined && flags.ref !== undefined) throw new UserError("Choose --branch or --ref for a public URL import");
      if (remote && flags.ref !== undefined && !flags.ref.startsWith("refs/heads/")) throw new UserError("Public URL import --ref must name a branch under refs/heads/");
      const policy = flags.policy === undefined ? { repositoryId, extensions: {} } : await readNativeRepositoryPolicyFile(flags.policy);
      if (policy.repositoryId !== repositoryId) throw new UserError("repository policy belongs to another repository");
      const importer = await nativeProjectImporter({ ...native, environment: { ...native.environment,
        DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: importerConnectionFile } });
      const stateRoot = managedStateRoot(process.env);
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });
      if (remote) {
        let reviewerId = "owner";
        if (flags.policy === undefined) {
          const reviewer = reviewerConnectionSchema.parse(await loadPrivateJson(path.join(path.dirname(await selectedControlPlaneHostFile()), "reviewer.json")));
          if (reviewer.baseUrl !== native.connection.nativeGit.endpoint || reviewer.generationId !== native.connection.nativeGit.generationId) throw new UserError("Reviewer connection conflicts with selected control plane");
          reviewerId = reviewer.reviewerId;
        }
        const branch = flags.branch ?? flags.ref?.slice("refs/heads/".length);
        print(await importNativeProjectPublicRepository({ name, projectId: project.projectId, repositoryId, url: flags.source, ...(branch === undefined ? {} : { branch }),
          stateRoot, selected: native.connection, registrarConnectionFile, importerConnectionFile, gitExecutable: flags.gitExecutable, reviewerId,
          ...(flags.policy === undefined ? {} : policy), signal: AbortSignal.timeout(150_000) }), flags);
        return;
      }
      await bootstrapNativeProjectRepository({ name, projectId: project.projectId, repositoryId,
        stateRoot, scratchRoot: stateRoot, sourceRepository: flags.source, selectedRef: flags.ref!,
        registrarConnectionFile, importerConnectionFile, gitExecutable: flags.gitExecutable,
        selectedControlPlane: { endpoint: native.connection.nativeGit.endpoint, hostId: native.connection.hostId, generationId: native.connection.nativeGit.generationId },
        policySource: flags.repositoryPolicy ? { kind: "reviewed-manifest" } : { kind: "manifest-free", ...policy }, signal: AbortSignal.timeout(120_000) });
      const record = await native.store.admitRepository(name, repositoryId, importer, native.connection, AbortSignal.timeout(30_000));
      print(record.repositories[repositoryId], flags);
    });
}
