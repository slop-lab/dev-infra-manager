import { WorkspaceStore, type WorkspaceRecord } from "@slop-lab/dim-core/workspace";
import { vi } from "vitest";
import { workspaceRecord } from "../../../../support/workspaceFixture.js";
export { workspaceRecord } from "../../../../support/workspaceFixture.js";
export async function storeWorkspace(root: string, record: WorkspaceRecord): Promise<void> {
  vi.stubEnv("DIM_STATE_ROOT", root);
  await new WorkspaceStore(root).write(record);
}
