import { UserError } from "./errors.js";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import { selectWorkspaceEnvironment, type WorkspaceEnvironment } from "./workspaceEnvironment.js";

export async function selectWorkspaceEnvironmentTransition(
  record: Pick<WorkspaceRecord, "name" | "environment">,
  rootSnapshotPath: string
): Promise<WorkspaceEnvironment | undefined> {
  if (record.environment === undefined) return undefined;
  const selected = await selectWorkspaceEnvironment(rootSnapshotPath);
  if (selected !== record.environment) {
    throw new UserError(
      `workspace '${record.name}' environment changed from ${record.environment} to ${selected}; `
      + "discard and recreate the workspace so persistent user data is not reinterpreted"
    );
  }
  return selected;
}
