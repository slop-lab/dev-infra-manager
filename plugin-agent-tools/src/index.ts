import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { UserError, type WorkspaceHostPlugin } from "@slop-lab/dim-core/workspace";

export const hostPlugin: WorkspaceHostPlugin = {
  name: "agent-tools",
  commands: [{ name: "tools", description: "Set up and run user-owned coding-agent tools without repository bootstrap files" }],
  async run(args, context) {
    const [name, operation, workspace, ...rest] = args;
    if (name !== "tools" || !workspace) throw new UserError("usage: dim tools setup|run|server WORKSPACE [TOOL] [ARGS...]");
    if (operation === "setup") {
      const tool = rest[0] ?? "opencode";
      if (!["opencode", "codex"].includes(tool) || rest.length > 1) throw new UserError("setup accepts opencode or codex");
      const record = await context.service.show(workspace);
      const directory = '"$HOME/.local/share/dim-agent-tools"';
      const payload = ["set -euo pipefail", `mkdir -p ${directory}`, `chmod 0700 ${directory}`];
      for (const file of ["tool-setup.bash", "agent.mjs", "opencode-server.bash"]) {
        const contents = await readFile(new URL(`./assets/${file}`, import.meta.url));
        payload.push(`printf '%s' '${contents.toString("base64")}' | base64 -d >${directory}/${file}`, `chmod 0700 ${directory}/${file}`);
      }
      payload.push(`exec bash ${directory}/tool-setup.bash ${tool}`);
      process.exitCode = await context.service.exec(workspace, ["bash", "-s"], { stdin: Readable.from([payload.join("\n")]),
        stdout: process.stdout, stderr: process.stderr, signal: context.signal, workspaceId: record.id });
      return;
    }
    const command = operation === "server" ? ["dim-opencode-server", ...rest]
      : operation === "run" ? ["dim-agent", ...rest] : undefined;
    if (!command) throw new UserError("tools supports setup, run and server");
    process.exitCode = await context.service.exec(workspace, command, {
      stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: context.signal,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY)
    });
  }
};
