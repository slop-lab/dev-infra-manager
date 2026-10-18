import { type Command } from "commander";
import { buildWorkspaceImage, inspectWorkspaceImage, lifecycleOptions } from "@slop-lab/dim-managed";
import { runner, type JsonFlags } from "./cli-runtime.js";
import { withLocalProgress } from "./local-progress.js";

export function registerWorkspaceImageCommands(workspace: Command): void {
  const workspaceImage = workspace.command("image").description("Build or inspect the configured workspace image");

  workspaceImage.command("build")
    .description("Build the configured workspace image from installed trusted assets")
    .action(async () => {
      const result = await withLocalProgress("image.workspace.build", ({ signal, reportProgress }) =>
        buildWorkspaceImage(runner, process.env, { signal, reportProgress }));
      console.log(`Built workspace image ${result.image}`);
    });

  workspaceImage.command("status")
    .description("Show whether the configured workspace image is available")
    .option("--json", "print machine-readable JSON")
    .action(async (flags: JsonFlags) => {
      const options = lifecycleOptions();
      const result = await inspectWorkspaceImage(runner, options.defaultWorkspaceBackend, options);
      if (flags.json) {
        console.log(JSON.stringify(result));
        return;
      }
      switch (result.status) {
        case "ready":
          console.log(`Workspace image is ready: ${result.imageId}`);
          return;
        case "missing":
          console.log("Workspace image is missing");
          return;
        default:
          result satisfies never;
      }
    });
}
