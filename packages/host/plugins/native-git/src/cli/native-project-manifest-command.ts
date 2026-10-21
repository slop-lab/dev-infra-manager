import type { Command } from "commander";
import { dirname, join } from "node:path";
import { UserError } from "@slop-lab/dim-host-core";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { print, type JsonFlags } from "@slop-lab/dim-host-core/controller/cli";
import { selectedControlPlaneImporterFile } from "../controlPlaneSelection.js";
import { importNativeRepositoryManifest, previewNativeRepositoryManifest } from "../repositoryManifestImport.js";
import { selectNativeProject } from "./native-project-selector.js";
import { readNativeReviewedPolicyText } from "./repository-policy-file.js";

export function registerNativeProjectManifestCommand(repository: Command): void {
  repository.command("import-manifest").argument("<project>")
    .description("Preview or import explicitly reviewed .dim/repos.yml sources and policies")
    .requiredOption("--manifest <absolute-file>", "reviewed .dim/repos.yml on the selected host")
    .option("--preview", "show source branches, managed refs and policy without importing")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, flags: JsonFlags & { manifest: string; preview?: boolean }) => {
      const manifest = await readNativeReviewedPolicyText(flags.manifest), native = await selectNativeProject();
      const project = await native.store.read(name, native.connection.hostId);
      if (!project) throw new UserError(`Project '${name}' does not exist`);
      if (flags.preview) {
        const plan = previewNativeRepositoryManifest(project.projectId, manifest);
        print({ ...plan, configurationRepositoryId: project.configurationRepositoryId ?? plan.configurationRepositoryId, defaultWorkingRepositoryId: project.defaultWorkingRepositoryId ?? plan.defaultWorkingRepositoryId }, flags);
        return;
      }
      const importerConnectionFile = await selectedControlPlaneImporterFile(native.environment);
      print(await importNativeRepositoryManifest({ name, projectId: project.projectId, manifest,
        stateRoot: managedStateRoot(native.environment), selected: native.connection, importerConnectionFile,
        registrarConnectionFile: join(dirname(importerConnectionFile), "registrar.json"), reviewerId: "owner", signal: AbortSignal.timeout(150_000) }), flags);
    });
}
