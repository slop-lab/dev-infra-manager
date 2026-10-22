import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Command } from "commander";
import { UserError } from "@slop-lab/dim-host-core";
import { print, type JsonFlags } from "@slop-lab/dim-host-core/controller/cli";
import { selectedControlPlaneImporterFile } from "../controlPlaneSelection.js";
import { loadNativeGitRootImporterConnection } from "../nativeGitRootImporterConnection.js";
import { createNativeRepositoryPolicyClient } from "../nativeRepositoryPolicyClient.js";
import { compileNativeRepositoryBootstrapPolicy, parseNativeRootBootstrapManifestYaml } from "../nativeRootBootstrapPolicy.js";
import { readNativeRepositoryPolicyFile, readNativeReviewedPolicyText } from "./repository-policy-file.js";
import { selectNativeProject } from "./native-project-selector.js";

export function registerRepositoryPolicyCommands(repository: Command): void {
  const policy = repository.command("policy").description("Inspect or explicitly update an existing repository's protected policy");
  for (const operation of ["show", "update"] as const) {
    const command = policy.command(operation).argument("<project>").argument("<repository>")
      .option("--connection <absolute-file>", "private root importer connection on the selected host")
      .option("--json", "print machine-readable JSON");
    if (operation === "update") command
      .option("--file <path>", "reviewed YAML manifest; defaults to .dim/repos.yml in the current directory")
      .option("--policy <path>", "reviewed JSON {schemaVersion, repositoryId, extensions} instead of YAML")
      .option("--preview", "show the proposed policy and current protected head without changing server or host state");
    command.action(async (name: string, repositoryId: string, flags: JsonFlags & { connection?: string; file?: string; policy?: string; preview?: boolean }) => {
      if (flags.file !== undefined && flags.policy !== undefined) throw new UserError("Choose --file or --policy");
      const native = await selectNativeProject(), project = await native.store.read(name, native.connection.hostId);
      const local = project?.repositories[repositoryId];
      if (!project || !local) throw new UserError(`Project '${name}' has no imported repository '${repositoryId}'`);
      const connection = await loadNativeGitRootImporterConnection(flags.connection ?? await selectedControlPlaneImporterFile());
      const client = createNativeRepositoryPolicyClient(connection, native.connection), signal = AbortSignal.timeout(30_000);
      const previous = await client.read(project.projectId, repositoryId, signal);
      if (operation === "show") { print(previous, flags); return; }
      let next;
      if (flags.policy !== undefined) {
        const declared = await readNativeRepositoryPolicyFile(path.resolve(flags.policy));
        if (declared.repositoryId !== repositoryId) throw new UserError("Repository policy belongs to another repository");
        next = compileNativeRepositoryBootstrapPolicy({ ...declared, protectedRef: previous.protectedRef }).repositoryPolicy;
      } else {
        const file = path.resolve(flags.file ?? ".dim/repos.yml");
        next = parseNativeRootBootstrapManifestYaml(await readNativeReviewedPolicyText(file), previous.protectedRef, repositoryId).repositoryPolicy;
      }
      if (flags.preview) { print({ schemaVersion: 1, outcome: "preview", projectId: project.projectId, repositoryId,
        expectedPolicyDigest: previous.policyDigest, expectedProtectedHead: previous.currentHead.commit, previousPolicy: previous.policy, policy: next }, flags); return; }
      // Re-reading server state makes retries after a lost update response safe.
      // Even an unchanged policy retries reconciliation if an earlier response was lost.
      const saved = await client.update(previous, next, signal);
      try {
        await native.store.applyRepositoryPolicy(name, repositoryId, saved.policy, local.repositoryPolicy.policyRevision, native.connection, signal);
      } catch (cause) {
        throw new UserError("Server policy is applied, but the host catalog could not refresh. Repeat this same update to reconcile it; no repository data was removed", { cause });
      }
      print({ ...saved, outcome: isDeepStrictEqual(previous.policy, next) ? "unchanged" : "updated" }, flags);
    });
  }
}
