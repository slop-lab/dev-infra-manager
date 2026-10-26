import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ContainerWorkspaceRuntime, ProcessRunner, WorkspaceService, WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { invokeToolsConsole } from "../../../../packages/host/plugins/agent-tools/src/console.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

afterEach(() => vi.restoreAllMocks());
async function fixture(run: (context: WorkspaceHostPluginContext, workspace: ReturnType<typeof workspaceRecord>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dim-tools-console-"));
  try {
    const store = new WorkspaceStore(root), workspace = workspaceRecord(); await store.write(workspace);
    const runner = new ProcessRunner(), runtime = new ContainerWorkspaceRuntime(runner);
    const service = new WorkspaceService(store, runtime, async () => { throw Error("Unexpected acquisition"); });
    vi.spyOn(service, "show").mockResolvedValue({ ...workspace, runtimeStatus: "running" });
    await run({ service, store, runner, cleanupRunner: runner, stateRoot: root, signal: new AbortController().signal }, workspace);
  } finally { await rm(root, { recursive: true, force: true }); }
}

it("rejects replaced workspace identities and injected arguments before guest execution", async () => fixture(async (context, workspace) => {
  const execute = vi.spyOn(context.service, "exec");
  await expect(invokeToolsConsole("server.stop", { workspace: workspace.name, workspaceId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" }, context)).rejects.toThrow("replaced");
  await expect(invokeToolsConsole("tools.setup", { workspace: workspace.name, workspaceId: workspace.id, tool: "opencode;id" }, context)).rejects.toThrow("Invalid");
  await expect(invokeToolsConsole("server.start", { workspace: workspace.name, workspaceId: workspace.id, args: ["--hostname", "0.0.0.0"] }, context)).rejects.toThrow("Invalid");
  expect(execute).not.toHaveBeenCalled();
}));

it("executes fixed server commands with exact identity and suppresses private guest diagnostics", async () => fixture(async (context, workspace) => {
  vi.spyOn(context.service, "exec").mockImplementation(async (_name, command, options) => {
    expect(options?.workspaceId).toBe(workspace.id);
    // Helper deployment is a separate idempotent operation, not the server launch.
    if (command[0] === "node") return 0;
    expect(command).toEqual(["bash", "-c", 'exec bash "$HOME/.local/share/dim-agent-tools/opencode-server.bash" "$1" --json', "dim-opencode-server", "start"]);
    options?.stderr?.write("PRIVATE PASSWORD should never reach Web");
    options?.stdout?.write(JSON.stringify({ state: "running", port: 4096, url: "http://127.0.0.1:4096", username: "opencode", credentialsFile: "/home/agent/.local/state/opencode-web/credentials", logFile: "/home/agent/.local/state/opencode-web/server.log" }));
    return 0;
  });
  expect(await invokeToolsConsole("server.start", { workspace: workspace.name, workspaceId: workspace.id }, context)).toMatchObject({ state: "running", workspaceId: workspace.id, directory: "/workspace" });
  vi.mocked(context.service.exec).mockImplementation(async (_name, command, options) => {
    if (command[0] === "node") return 0;
    options?.stderr?.write("PRIVATE PASSWORD"); return 1;
  });
  await expect(invokeToolsConsole("server.start", { workspace: workspace.name, workspaceId: workspace.id }, context)).rejects.toThrow(/^Tool operation failed\./);
}));

it("requires a running initialized workspace without starting it implicitly", async () => fixture(async (context, workspace) => {
  vi.mocked(context.service.show).mockResolvedValue({ ...workspace, phase: "stopped", runtimeStatus: "stopped" });
  const execute = vi.spyOn(context.service, "exec");
  await expect(invokeToolsConsole("tools.setup", { workspace: workspace.name, workspaceId: workspace.id, tool: "codex" }, context)).rejects.toThrow("Start the workspace");
  expect(execute).not.toHaveBeenCalled();
}));

it("reads server state and credentials without materializing or updating guest helpers", async () => fixture(async (context, workspace) => {
  const execute = vi.spyOn(context.service, "exec").mockImplementation(async (_name, command, options) => {
    if (command[0] === "node") return 0;
    options?.stdout?.write(JSON.stringify(command.at(-1) === "credentials" ? { username: "opencode", password: "fixture-private-password" } : { state: "running", port: 4096 }));
    return 0;
  });
  const identity = { workspace: workspace.name, workspaceId: workspace.id };
  await invokeToolsConsole("server.status", identity, context);
  await invokeToolsConsole("server.credentials", identity, context);
  expect(execute.mock.calls.map(([, command]) => command[0])).toEqual(["bash", "bash"]);
}));

it("transports password updates only through guest stdin and returns credentials only on explicit read", async () => fixture(async (context, workspace) => {
  const password = 'private custom password "quotes"';
  vi.spyOn(context.service, "exec").mockImplementation(async (_name, command, options) => {
    if (command[0] === "node") return 0;
    expect(JSON.stringify(command)).not.toContain(password);
    if (command.at(-1) === "password") {
      let input = "";
      for await (const chunk of options!.stdin!) input += chunk.toString();
      expect(JSON.parse(input)).toEqual({ password });
      options?.stdout?.write(JSON.stringify({ state: "stopped", password }));
    } else options?.stdout?.write(JSON.stringify({ username: "opencode", password }));
    return 0;
  });
  const identity = { workspace: workspace.name, workspaceId: workspace.id };
  expect(await invokeToolsConsole("server.password", { ...identity, password }, context)).toEqual({ ...identity, directory: "/workspace", state: "stopped" });
  expect(await invokeToolsConsole("server.credentials", identity, context)).toEqual({ ...identity, username: "opencode", password });
  await expect(invokeToolsConsole("server.password", { ...identity, password: "too short" }, context)).rejects.toThrow("12–128");
}));
