import os from "node:os";
import path from "node:path";
import { runControllerCli } from "@slop-lab/dim-host-core/controller/cli";
import { lifecycleOptions } from "@slop-lab/dim-host-core/controller";
import type { WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";

export async function runControllerApplication(args: string[]): Promise<void> {
  let installed = false;
  try { import.meta.resolve("@slop-lab/dim-host-plugin-native-git"); installed = true; }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND")) throw error; }
  const metadata = installed ? async (workspace: WorkspaceRecord) => {
    if (!workspace.source.url.startsWith("dim://")) return;
    const native = await import("@slop-lab/dim-host-plugin-native-git");
    return native.nativeWorkspaceMetadata(workspace, lifecycleOptions().stateRoot,
      path.resolve(process.env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim")));
  } : undefined;
  await runControllerCli(args, metadata);
}
