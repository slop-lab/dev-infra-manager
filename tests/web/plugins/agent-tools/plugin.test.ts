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
    if (args[0] === "external-url") throw new Error("optional plugin missing");
    if (args[2] === "describe") return description;
    return args[3]?.startsWith("tools.") ? toolStatus : serverStatus;
  } }] });
  expect(await runtime.invoke("controllers.list", {})).toMatchObject({ controllers: [{ id: "offline", status: "unavailable", workspaces: [] }, { id: "local", status: "ready", workspaces: description.workspaces }] });
  expect(await runtime.invoke("tools.setup", { ...selection, tool: "opencode" })).toEqual(toolStatus);
  expect(calls.at(-1)).toEqual({ args: ["tools", "console", "invoke", "tools.setup", "--input", JSON.stringify({ workspace: "development", workspaceId, tool: "opencode" })], timeout: 180_000 });
  expect(await runtime.invoke("server.start", selection)).toEqual({ ...serverStatus, externalUrls: [], externalUrlsAvailable: false }); expect(calls.at(-2)?.timeout).toBe(90_000);
  expect(await runtime.invoke("server.status", selection)).toEqual({ ...serverStatus, externalUrls: [], externalUrlsAvailable: false }); expect(calls.at(-2)?.timeout).toBe(30_000);
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
  expect(operations.filter(({ access }) => access === "operator").map(({ name }) => name)).toEqual(["tools.setup", "server.start", "server.stop", "server.credentials", "server.password"]);
  const status = operations.find(({ name }) => name === "server.status")!;
  expect(() => status.parseOutput({ ...serverStatus, password: "private" })).toThrow();
  expect(() => status.parseOutput({ ...serverStatus, url: "https://foreign.test" })).toThrow();
  expect(() => status.parseOutput({ ...serverStatus, url: "http://username:secret@127.0.0.1:4096" })).toThrow();
  expect(() => status.parseInput({ ...selection, connection: "/private/operator.json" })).toThrow();
});

it("sends passwords on stdin only and resolves public URLs from matching workspace routes", async () => {
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const secret = 'a secret "with quotes"';
  let returnedId = workspaceId;
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "local", async run(args, options) {
    calls.push({ args, ...(options?.input ? { input: options.input } : {}) });
    if (args[2] === "describe") return description;
    if (args[0] === "external-url") return { workspace: "development", workspaceId: returnedId,
      ingresses: [{ name: "shared", description: "Control-plane ingress", scheme: "https", driver: "control-plane" }], routes: [
      { id: "11111111-1111-4111-8111-111111111111", ingress: "shared", url: "https://public.example.test:8443/opencode", approval: "approved", port: 4096, containers: [], protocol: "http" },
      { id: "22222222-2222-4222-8222-222222222222", ingress: "shared", url: "https://public.example.test/other", approval: "approved", port: 8080, containers: [], protocol: "http" },
      { id: "33333333-3333-4333-8333-333333333333", ingress: "shared", url: "https://public.example.test/agent", approval: "approved", port: 4096, containers: ["agent"], protocol: "http" },
    ] };
    if (args[3] === "server.credentials") return { workspace: "development", workspaceId, username: "opencode", password: secret };
    return serverStatus;
  } }] });
  const status = await runtime.invoke("server.password", { ...selection, password: secret });
  const write = calls.find(({ args }) => args[3] === "server.password")!;
  expect(write.args).toEqual(["tools", "console", "invoke", "server.password", "--input-stdin"]);
  expect(JSON.parse(write.input!)).toEqual({ workspace: "development", workspaceId, password: secret });
  expect(calls.every(({ args }) => !args.join(" ").includes(secret))).toBe(true);
  expect(status).toMatchObject({ externalUrls: [{ ingress: "shared", url: "https://public.example.test:8443/opencode", approval: "approved" }], externalUrlsAvailable: true });
  expect(await runtime.invoke("server.credentials", selection)).toMatchObject({ password: secret });
  returnedId = "27094660-a627-4a17-acd2-6418c0b79967";
  expect(await runtime.invoke("server.status", selection)).toMatchObject({ state: "running", externalUrls: [], externalUrlsAvailable: false });
  for (const password of ["short", "a".repeat(129), "password-with-newline\n"]) await expect(runtime.invoke("server.password", { ...selection, password })).rejects.toThrow();
});
