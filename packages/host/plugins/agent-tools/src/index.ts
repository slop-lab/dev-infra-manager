import { deployToolHelpers, inspectTools } from "./integration.js";
import { UserError, type WorkspaceHostPlugin } from "@slop-lab/dim-core/workspace";

export const hostPlugin: WorkspaceHostPlugin = {
  name: "agent-tools",
  workspaceReady: deployToolHelpers,
  guest: {
    description: "Coding-agent helper commands; installing this host plugin prepares small helpers automatically, while pinned npm tools require explicit setup",
    commands: [
      { name: "dim-tools-setup", description: "Install opencode or codex explicitly; this may download pinned npm packages" },
      { name: "dim-agent", description: "Run opencode or codex when configured, with persistent continuation support" },
      { name: "dim-opencode-server", description: "Run the configured OpenCode Web backend" }
    ],
    inspect: inspectTools
  },
  commands: [{ name: "tools", description: "Set up and run user-owned coding-agent tools without repository bootstrap files" }],
  async run(args, context) {
    const [name, operation, workspace, ...rest] = args;
    if (name !== "tools" || !workspace) throw new UserError("usage: dim tools setup|run|server WORKSPACE [TOOL] [ARGS...]");
    if (operation === "setup") {
      const tool = rest[0] ?? "opencode";
      if (!["opencode", "codex"].includes(tool) || rest.length > 1) throw new UserError("setup accepts opencode or codex");
      const record = await context.service.show(workspace);
      await deployToolHelpers(record, context);
      process.exitCode = await context.service.exec(workspace, ["bash", "-c", 'exec bash "$HOME/.local/share/dim-agent-tools/tool-setup.bash" "$1"', "dim-tools-setup", tool], {
        stdout: process.stdout, stderr: process.stderr, signal: context.signal, workspaceId: record.id
      });
      return;
    }
    const command = operation === "server" ? ["dim-opencode-server", ...rest]
      : operation === "run" ? ["dim-agent", ...rest] : undefined;
    if (!command) throw new UserError("tools supports setup, run and server");
    const record = await context.service.show(workspace);
    await deployToolHelpers(record, context);
    process.exitCode = await context.service.exec(workspace, command, {
      workspaceId: record.id,
      stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: context.signal,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY)
    });
  }
};
