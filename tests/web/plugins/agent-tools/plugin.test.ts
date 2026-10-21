import { expect, it } from "vitest";
import { operations, webPlugin } from "../../../../packages/web/plugins/agent-tools/src/index.js";

const workspaceId = "17094660-a627-4a17-acd2-6418c0b79967";
const selection = { controllerId: "local", workspace: "development", workspaceId };
const description = { schemaVersion: 1, workspaces: [{ name: "development", id: workspaceId, phase: "running" }], tools: ["opencode", "codex"] };
const toolStatus = { workspace: "development", workspaceId, tools: [{ name: "opencode", installed: true, version: "1.18.31" }, { name: "codex", installed: false, version: "" }] };
const serverStatus = { workspace: "development", workspaceId, state: "running", port: 4096, url: "http://127.0.0.1:4096", username: "opencode", credentialsFile: "/home/agent/.local/state/dim/opencode-web/credentials", logFile: "/home/agent/.local/state/dim/opencode-web/server.log" };

it("discovers optional host tools and delegates exact workspace identities with bounded deadlines", async () => {
  const calls: Array<{args: readonly string[]; timeout?: number}> = [];
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "offline", async run() { throw new Error("host plugin missing"); } }, { id: "local", async run(args, options) {
    calls.push({ args, ...(options ? { timeout: options.timeoutMilliseconds } : {}) });
    if (args[2] === "describe") return description;
    return args[3]?.startsWith("tools.") ? toolStatus : serverStatus;
  } }] });
  expect(await runtime.invoke("controllers.list", {})).toMatchObject({ controllers: [{ id: "offline", status: "unavailable", workspaces: [] }, { id: "local", status: "ready", workspaces: description.workspaces }] });
  expect(await runtime.invoke("tools.setup", { ...selection, tool: "opencode" })).toEqual(toolStatus);
  expect(calls.at(-1)).toEqual({ args: ["tools", "console", "invoke", "tools.setup", "--input", JSON.stringify({ workspace: "development", workspaceId, tool: "opencode" })], timeout: 180_000 });
  expect(await runtime.invoke("server.start", selection)).toEqual(serverStatus); expect(calls.at(-1)?.timeout).toBe(90_000);
  expect(await runtime.invoke("server.status", selection)).toEqual(serverStatus); expect(calls.at(-1)?.timeout).toBe(30_000);
});

it("rejects browser-selected commands, paths, arbitrary tools and stale or cross-controller workspaces before transport", async () => {
  let writes = 0;
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "local", async run(args) { if (args[2] === "describe") return description; writes++; return toolStatus; } }] });
  for (const input of [{ ...selection, command: "sh" }, { ...selection, controllerId: "foreign" }, { ...selection, workspace: "foreign" }, { ...selection, workspaceId: "27094660-a627-4a17-acd2-6418c0b79967" }, { ...selection, executable: "/bin/sh" }]) {
    await expect(runtime.invoke("tools.status", input)).rejects.toThrow();
  }
  await expect(runtime.invoke("tools.setup", { ...selection, tool: "other" })).rejects.toThrow();
  await expect(runtime.invoke("server.start", { ...selection, port: 8080 })).rejects.toThrow();
  await expect(runtime.invoke("not.allowed", selection)).rejects.toThrow();
  expect(writes).toBe(0);
});

it("refreshes workspace identities without granting authority to an old browser selection", async () => {
  let id = workspaceId;
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "local", async run() { return { ...description, workspaces: [{ name: "development", id, phase: "running" }] }; } }] });
  id = "27094660-a627-4a17-acd2-6418c0b79967";
  await runtime.invoke("controllers.list", {});
  await expect(runtime.invoke("server.stop", selection)).rejects.toThrow("identity");
});

it("declares operator-only mutations and rejects private or arbitrary server output", () => {
  expect(webPlugin.surfaces).toEqual(["workspace"]);
  expect(operations.filter(({ access }) => access === "operator").map(({ name }) => name)).toEqual(["tools.setup", "server.start", "server.stop"]);
  const status = operations.find(({ name }) => name === "server.status")!;
  expect(() => status.parseOutput({ ...serverStatus, password: "private" })).toThrow();
  expect(() => status.parseOutput({ ...serverStatus, url: "https://foreign.test" })).toThrow();
  expect(() => status.parseOutput({ ...serverStatus, url: "http://username:secret@127.0.0.1:4096" })).toThrow();
  expect(() => status.parseInput({ ...selection, connection: "/private/operator.json" })).toThrow();
});
