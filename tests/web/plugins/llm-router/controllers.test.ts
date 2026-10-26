import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { webPluginContext } from "../../../../packages/web/core/src/controllers.js";
import { expect, it } from "vitest";
import { webPlugin } from "../../../../packages/web/plugins/llm-router/src/index.js";
const selectionId = "a".repeat(64);
const capabilities = [{ name: "projects", description: "Routing projects", access: "read" }, { name: "project.state", description: "Change routing state", access: "operator" }];
it("discovers each controller's selected router and binds every operation to its private selection", async () => {
  const calls: string[][] = [], inputs: Array<{ readonly timeoutMilliseconds: number; readonly input?: string } | undefined> = [];
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "remote", async run(args, options) {
    calls.push([...args]); inputs.push(options);
    if (args[2] === "describe") return { schemaVersion: 1, selectionId, operations: capabilities };
    return [];
  } }, { id: "offline", async run() { throw new Error("private operator key/path must not escape"); } }] });
  const catalog = await runtime.invoke("controllers.list", {});
  expect(catalog).toMatchObject({ controllers: [{ id: "remote", controllerKey: "remote", status: "ready" }, { id: "offline", status: "unavailable", operations: [] }] });
  expect(JSON.stringify(catalog)).not.toMatch(/private|operator key/);
  expect(await runtime.invoke("projects", { controllerId: "remote" })).toEqual([]);
  expect(calls.at(-1)).toEqual(["llm-router", "console", "invoke", "projects", "--expected-selection", selectionId, "--input", "-"]);
  expect(inputs.at(-1)).toEqual({ input: "{}", timeoutMilliseconds: 30_000 });
  expect(calls[1]).toEqual(["llm-router", "console", "describe", "--expected-selection", selectionId]);
  await expect(runtime.invoke("projects", { controllerId: "offline" })).rejects.toThrow(/unavailable/);
  await expect(runtime.invoke("projects", { controllerId: "foreign" })).rejects.toThrow(/unavailable/);
  await expect(runtime.invoke("projects", { controllerId: "remote", connectionFile: "/tmp/untrusted" })).rejects.toThrow();
});
it("requires feature reconnection after selection changes and refuses undeclared or elevated capabilities", async () => {
  let selected = selectionId;
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "remote", async run() { return { schemaVersion: 1, selectionId: selected, operations: capabilities.slice(0, 1) }; } }] });
  await expect(runtime.invoke("project.state", { controllerId: "remote", projectId: "example", action: "pause" })).rejects.toThrow(/unavailable/);
  selected = "b".repeat(64);
  expect(await runtime.invoke("controllers.list", {})).toMatchObject({ controllers: [{ status: "unavailable" }] });
  await expect(runtime.invoke("projects", { controllerId: "remote" })).rejects.toThrow(/unavailable/);
  const invalid = await webPlugin.autoConnect!({ controllers: [{ id: "invalid", async run() { return { schemaVersion: 1, selectionId, operations: [{ name: "project.state", description: "Bad authority", access: "read" }] }; } }] });
  expect(await invalid.invoke("controllers.list", {})).toMatchObject({ controllers: [{ status: "unavailable" }] });
});

it("keeps provider credentials out of process arguments and preserves the device-login timeout budget", async () => {
  const calls: Array<{ args: readonly string[]; options?: { readonly timeoutMilliseconds: number; readonly input?: string } }> = [];
  const secret = "sk-private-test-secret";
  const available = ["account.create", "account.login.start"].map((name) => ({ name, description: name, access: "operator" }));
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "remote", async run(args, options) {
    calls.push({ args, ...(options ? { options } : {}) });
    if (args[2] === "describe") return { schemaVersion: 1, selectionId, operations: available };
    if (args[3] === "account.create") return { id: "managed", reference: "Test", provider: "openai", status: "configured" };
    return { accountId: "managed", sessionId: "session", verificationUrl: "https://auth.openai.com/codex/device", status: "pending", expiresAt: 1 };
  } }] });
  await runtime.invoke("account.create", { controllerId: "remote", provider: "openai", endpoint: "https://api.example.test", apiKey: secret });
  const write = calls.at(-1)!;
  expect(JSON.stringify(write.args)).not.toContain(secret);
  expect(JSON.parse(write.options!.input!)).toMatchObject({ apiKey: secret });
  await runtime.invoke("account.login.start", { controllerId: "remote", accountId: "managed" });
  expect(calls.at(-1)?.options?.timeoutMilliseconds).toBe(60_000);
});

it("marks malformed controller operation output as unavailable after dispatch", async () => {
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "remote", async run(args) {
    if (args[2] === "describe") return { schemaVersion: 1, selectionId, operations: capabilities };
    return { invalid: "operation output" };
  } }] });

  await expect(runtime.invoke("projects", { controllerId: "remote" })).rejects.toMatchObject({
    status: 502,
    code: "llm_controller_result_unavailable",
  });
});

it("discovers and invokes through the actual Web controller transport without overriding reserved flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-router-web-transport-"));
  try {
    const executable = join(root, "controller");
    await writeFile(executable, `#!${process.execPath}
// @ts-check
const args = process.argv.slice(2);
if (args.filter((arg) => arg === "--json").length !== 1 || args[0] !== "--host" || args[1] !== "selected-host") process.exit(2);
(async () => {
  if (args.includes("describe")) { process.stdout.write(JSON.stringify(${JSON.stringify({ schemaVersion: 1, selectionId, operations: capabilities })})); return; }
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  if (args[args.indexOf("--input") + 1] !== "-" || JSON.stringify(JSON.parse(Buffer.concat(chunks).toString("utf8"))) !== "{}") process.exit(3);
  process.stdout.write("[]");
})().catch(() => { process.exitCode = 4; });
`, { mode: 0o700 });
    const runtime = await webPlugin.autoConnect!(webPluginContext([{ id: "transport", selector: "selected-host", executable }]));
    expect(await runtime.invoke("controllers.list", {})).toMatchObject({ controllers: [{ id: "transport", status: "ready" }] });
    expect(await runtime.invoke("projects", { controllerId: "transport" })).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
