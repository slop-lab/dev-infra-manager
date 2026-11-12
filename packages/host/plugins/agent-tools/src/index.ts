import { deployToolHelpers, inspectTools, prepareToolWorkspace } from "./integration.js";
import { UserError } from "@slop-lab/dim-host-core/workspace";
import { type WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";
import { runToolsConsole } from "./console.js";
import { executionCapabilities, executionStatus } from "./executionHost.js";
import { taskWorkspaceOperation } from "./taskHost.js";
export type { TaskRequest, TaskTarget, TaskLookup, TaskReceipt } from "./execution/taskContract.ts";

export const hostPlugin: WorkspaceHostPlugin = {
  name: "agent-tools",
  workspaceCapabilities: executionCapabilities,
  workspaceReady: prepareToolWorkspace,
  guest: {
    description: "Coding-agent helper commands; installing this host plugin prepares small helpers automatically, while pinned npm tools require explicit setup",
    commands: [
      { name: "dim-tools-setup", description: "Install opencode or codex explicitly; this may download pinned npm packages" },
      { name: "dim-agent", description: "Run opencode or codex when configured, with persistent continuation support" },
      { name: "dim-opencode-server", description: "Run the configured OpenCode Web backend" },
      { name: "dim-agent-execution", description: "Read coding-agent task/subagent status or wait for a bounded semantic change" },
      { name: "dim-agent-task", description: "Submit explicit task content or inspect its durable request receipt without blind retries" }
    ],
    inspect: inspectTools,
    operations: [
      { name: "execution-status", description: "Inspect an existing OpenCode task and subagents without starting or changing them", handle: executionStatus },
      { name: "task-identity", description: "Read the exact owned OpenCode server identity before task submission", handle: (input, workspace, context) => taskWorkspaceOperation("task.identity", input, workspace, context) },
      { name: "task-submit", description: "Create or message a session with an explicit guarded request ID and task text", handle: (input, workspace, context) => taskWorkspaceOperation("task.submit", input, workspace, context) },
      { name: "task-request", description: "Read a durable task request receipt without redelivering content", handle: (input, workspace, context) => taskWorkspaceOperation("task.request", input, workspace, context) }
    ]
  },
  commands: [{ name: "tools", description: "Set up and run user-owned coding-agent tools without repository bootstrap files" }],
  async run(args, context) {
    if (args[0] === "tools" && args[1] === "console") {
      await runToolsConsole(args.slice(2), context);
      return;
    }
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
