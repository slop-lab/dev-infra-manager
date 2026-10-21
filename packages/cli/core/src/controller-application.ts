import os from "node:os";
import path from "node:path";
import { ProcessRunner } from "@slop-lab/dim-host-core/workspace";
import { runControllerCli } from "@slop-lab/dim-host-core/controller/cli";
import { resolveWorkspaceMetadata } from "./workspace-composition.js";

export async function runControllerApplication(args: string[]): Promise<void> {
  const runner = new ProcessRunner();
  const context = { runner, cleanupRunner: runner,
    stateRoot: path.resolve(process.env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim")) };
  await runControllerCli(args, (workspace) => resolveWorkspaceMetadata(workspace, context));
}
