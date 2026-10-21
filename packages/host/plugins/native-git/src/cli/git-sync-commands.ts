import { dirname, join } from "node:path";
import type { Command } from "commander";
import { UserError } from "@slop-lab/dim-host-core";
import { print, type JsonFlags } from "@slop-lab/dim-host-core/controller/cli";
import { selectedControlPlaneImporterFile } from "../controlPlaneSelection.js";
import { loadGitSyncConnection, requestGitSync } from "../nativeGitSyncClient.js";
import { selectNativeProject } from "./native-project-selector.js";

export function registerGitSyncCommands(repository: Command): void {
  for (const [command, operation, description] of [
    ["fetch", "fetch", "Fetch the configured upstream into upstream/BRANCH without changing protected refs"],
    ["sync", "merge", "Merge configured upstream into a proposal governed by normal review and promotion"],
    ["publish", "publish", "Publish the authoritative managed protected commit to its configured upstream branch"]
  ] as const) {
    repository.command(command).description(description).argument("<project>").argument("<repository>")
      .option("--connection <absolute-file>", "private git-sync operator configuration on the selected host")
      .option("--json", "print machine-readable JSON")
      .action(async (name: string, repositoryId: string, flags: JsonFlags & { connection?: string }) => {
        const native = await selectNativeProject(), project = await native.store.read(name, native.connection.hostId);
        if (!project?.repositories[repositoryId]) throw new UserError(`Project '${name}' has no imported repository '${repositoryId}'`);
        const file = flags.connection ?? process.env.DIM_NATIVE_GIT_SYNC_CONNECTION_FILE ?? join(dirname(await selectedControlPlaneImporterFile()), "git-sync.json");
        const result = await requestGitSync({ connection: await loadGitSyncConnection(file), selected: native.connection,
          projectId: project.projectId, repositoryId, operation, signal: AbortSignal.timeout(120_000) });
        print(result, flags);
        if (result.outcome === "conflict") process.exitCode = 2;
      });
  }
}
