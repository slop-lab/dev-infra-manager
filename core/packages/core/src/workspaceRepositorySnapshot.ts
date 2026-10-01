import { UserError } from "./errors.js";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import { inspectProjectRuntimeCgroups, type ProjectRuntimeCgroups } from "./projectRuntimeCgroups.js";
import type { StreamingCommandRunner } from "./types.js";
import { PROJECT_ROOT } from "./workspaceLifecycleTypes.js";

const WORKSPACE_USER = "dim";
export async function writeProjectManifest(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<void> {
  const cgroups = await inspectProjectRuntimeCgroups(runner, record.containerName, "docker");
  const encoded = Buffer.from(`${JSON.stringify(projectRuntimeManifest(record, cgroups), null, 2)}\n`).toString("base64");
  const result = await runner.run("docker", [
    "exec", "--user", "root", "--env", `DIM_PROJECT_MANIFEST_B64=${encoded}`,
    record.containerName, "sh", "-c",
    `mkdir -p /run/dim && printf %s "$DIM_PROJECT_MANIFEST_B64" | base64 -d > ${record.projectManifestPath} && chown ${WORKSPACE_USER}:${WORKSPACE_USER} ${record.projectManifestPath} && chmod 0444 ${record.projectManifestPath}`
  ]);
  if (result.exitCode !== 0) throw commandError("write project runtime manifest", result);
}

export function projectRuntimeManifest(
  record: WorkspaceRecord,
  cgroups: ProjectRuntimeCgroups
): Record<string, unknown> {
  return {
    schemaVersion: 3,
    project: { id: record.projectId, name: record.projectName },
    root: {
      repository: record.rootRepositoryAlias,
      ref: record.rootRef,
      commit: record.rootCommit,
      path: PROJECT_ROOT
    },
    data: { path: record.workspaceDataPath },
    gitBaseUrl: record.gitBaseUrl,
    hostAliases: record.hostAliases,
    runtime: {
      cgroups,
      capabilities: (record.capabilities ?? []).map(({ name, requirement, status, plugin, detail }) => ({
        name, requirement, status, ...(plugin ? { plugin } : {}), ...(detail ? { detail } : {})
      }))
    }
  };
}

function commandError(action: string, result: { readonly stderr: string; readonly stdout: string }): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
