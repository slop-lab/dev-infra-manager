import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/workspace";
export const hostPlugin: WorkspaceHostPlugin = {
  name: "native-git",
  commands: [{ name: "project", description: "Register Native Projects and their independent reviewed repositories" }],
  async run(args) { const { runNativeGitCli } = await import("./cli/index.js"); await runNativeGitCli(args); }
};
