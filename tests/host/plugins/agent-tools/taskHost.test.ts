import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ContainerWorkspaceRuntime, ProcessRunner, WorkspaceService, WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { invokeToolsConsole, runToolsConsole } from "../../../../packages/host/plugins/agent-tools/src/console.js";
import { parseTaskRequest, taskReceipt } from "../../../../packages/host/plugins/agent-tools/src/execution/taskContract.ts";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
afterEach(() => vi.restoreAllMocks());
async function fixture(action: (context: WorkspaceHostPluginContext, workspace: ReturnType<typeof workspaceRecord>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dim-task-host-"));
  try {
    const store = new WorkspaceStore(root), workspace = workspaceRecord(); await store.write(workspace);
    const runner = new ProcessRunner(), service = new WorkspaceService(store, new ContainerWorkspaceRuntime(runner), async () => { throw Error("Unexpected acquisition"); });
    vi.spyOn(service, "show").mockResolvedValue({ ...workspace, runtimeStatus: "running" });
    await action({ service, store, runner, cleanupRunner: runner, stateRoot: root, signal: new AbortController().signal }, workspace);
  } finally { await rm(root, { recursive: true, force: true }); }
}
function request(workspaceId: string) { return parseTaskRequest({ workspaceId, requestId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", runtime: "opencode", serverIdentity: "a".repeat(64), target: { kind: "new" }, mode: "record-only", text: "Explicit task transport fixture" }); }
it("transports intended text only on stdin and strips all private diagnostic fields from typed receipts", async () => fixture(async (context, workspace) => {
  const input = request(workspace.id);
  const execute = vi.spyOn(context.service, "exec").mockImplementation(async (_name, command, options) => {
    expect(options?.workspaceId).toBe(workspace.id); expect(JSON.stringify(command)).not.toContain(input.text);
    let source = ""; if (options?.stdin) for await (const chunk of options.stdin) source += chunk.toString(); expect(JSON.parse(source)).toEqual(input);
    options?.stdout?.write(JSON.stringify({ ...taskReceipt(input, { outcome: "accepted", reason: "accepted", phase: "complete", serverIdentity: input.serverIdentity, sessionId: "ses_fixture", messageId: `msg_${input.requestId.replaceAll("-", "")}` }), token: "PRIVATE", text: input.text })); return 0;
  });
  const result = await invokeToolsConsole("task.submit", { workspace: workspace.name, ...input }, context);
  expect(result).toMatchObject({ workspaceId: workspace.id, outcome: "accepted" }); expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(JSON.stringify(result)).not.toContain(input.text); expect(execute).toHaveBeenCalledTimes(1);
}));
it("rejects stale workspace and preference injection before guest execution", async () => fixture(async (context, workspace) => {
  const execute = vi.spyOn(context.service, "exec"), input = request(workspace.id);
  await expect(invokeToolsConsole("task.submit", { workspace: workspace.name, ...input, workspaceId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" }, context)).rejects.toThrow("replaced");
  await expect(invokeToolsConsole("task.submit", { workspace: workspace.name, ...input, model: "override" }, context)).rejects.toThrow("Unknown task input field"); expect(execute).not.toHaveBeenCalled();
  await expect(runToolsConsole(["invoke", "task.submit", "--input", JSON.stringify({ workspace: workspace.name, ...input }), "--json"], context)).rejects.toThrow("--input-stdin");
}));
it.each(["transport", "workspace", "server"])("reports outcome-unknown without retry when %s evidence is uncertain", async kind => fixture(async (context, workspace) => {
  const input = request(workspace.id);
  const execute = vi.spyOn(context.service, "exec").mockImplementation(async (_name, _command, options) => {
    if (kind === "transport") throw Error("Private network diagnostics");
    if (kind === "workspace") vi.mocked(context.service.show).mockResolvedValue({ ...workspace, id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", runtimeStatus: "running" });
    options?.stdout?.write(JSON.stringify(taskReceipt(input, { outcome: "accepted", reason: "accepted", phase: "complete", serverIdentity: kind === "server" ? "b".repeat(64) : input.serverIdentity, sessionId: "ses_fixture", messageId: `msg_${input.requestId.replaceAll("-", "")}` }))); return 0;
  });
  expect(await invokeToolsConsole("task.submit", { workspace: workspace.name, ...input }, context)).toMatchObject({ outcome: "outcome-unknown", reason: "transport-unknown", requestId: input.requestId }); expect(execute).toHaveBeenCalledTimes(1);
}));
it("does not label an unsupported runtime as OpenCode when the installed producer transport is absent", async () => fixture(async (context, workspace) => {
  const execute = vi.spyOn(context.service, "exec").mockRejectedValue(Error("Unavailable transport"));
  expect(await invokeToolsConsole("task.submit", { workspace: workspace.name, ...request(workspace.id), runtime: "codex" }, context)).toMatchObject({ runtime: "codex", outcome: "unsupported", reason: "unsupported-runtime" });
  expect(execute).toHaveBeenCalledTimes(1);
}));
