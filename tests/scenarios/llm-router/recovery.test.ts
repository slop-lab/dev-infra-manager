import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { workspaceServiceEndpoint } from "@slop-lab/dim-host-core/workspace";
import { fixture, runLlmCommand, hostPlugin } from "./attachmentFixture.js";

it("recovers a legacy selection only through its original gateway without rotating credentials", async () => {
  const f = await fixture(), selection = join(f.context.stateRoot, "llm-services", `${f.workspace.id}.json`);
  const ready = hostPlugin.workspaceReady, inspect = hostPlugin.guest?.inspect;
  if (!ready || !inspect) throw new Error("LLM workspace hooks unavailable");
  const before = JSON.stringify({ ...f.connection, endpoint: f.gatewayOrigin });
  await writeFile(f.connectionPath, before, { mode: 0o600 }); await unlink(selection);
  await expect(ready(f.workspace, f.context)).rejects.toThrow(`dim llm recover ${f.workspace.name} --config`);
  expect(await inspect(f.workspace, f.context)).toMatchObject({ state: "unconfigured", message: expect.stringContaining(`dim llm recover ${f.workspace.name}`) });
  expect(await readFile(f.connectionPath, "utf8")).toBe(before);
  await runLlmCommand(["llm", "recover", f.workspace.name, "--config", join(f.root, "host/gateway.json")], f.context);
  expect(JSON.parse(await readFile(f.connectionPath, "utf8"))).toEqual({ ...JSON.parse(before), endpoint: workspaceServiceEndpoint("llm-router") });
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM principals").get()?.n)).toBe(1);
  await ready(f.workspace, f.context);
  const response = await f.request(); expect(response.status).toBe(200); await response.text();
});

it("rejects recovery through a gateway without the existing current binding", async () => {
  const f = await fixture(), selection = join(f.context.stateRoot, "llm-services", `${f.workspace.id}.json`);
  const before = await readFile(f.connectionPath, "utf8"); await unlink(selection);
  const wrong = join(f.root, "wrong-gateway.json");
  await writeFile(wrong, JSON.stringify({ ...f.config, stateDirectory: join(f.root, "unrelated-gateway") }), { mode: 0o600 });
  await expect(runLlmCommand(["llm", "recover", f.workspace.name, "--config", wrong], f.context)).rejects.toThrow();
  await expect(readFile(selection)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.connectionPath, "utf8")).toBe(before);
});

it.each([false, true])("rolls back committed endpoint recovery without overwriting concurrent guest edits (edited=%s)", async (edited) => {
  const f = await fixture(), selection = join(f.context.stateRoot, "llm-services", `${f.workspace.id}.json`);
  const before = JSON.stringify({ ...f.connection, endpoint: f.gatewayOrigin });
  const changed = JSON.stringify({ ...f.connection, endpoint: f.gatewayOrigin, token: "z".repeat(43) });
  await writeFile(f.connectionPath, before, { mode: 0o600 }); await unlink(selection);
  const execute = vi.mocked(f.context.service.exec).getMockImplementation();
  if (!execute) throw new Error("missing guest executor");
  let published = false;
  vi.mocked(f.context.service.exec).mockImplementation(async (name, args, options) => {
    const code = await execute(name, args, options);
    if (args[3] === f.workspace.id && args[4] === workspaceServiceEndpoint("llm-router") && code === 0) {
      if (edited) await writeFile(f.connectionPath, changed, { mode: 0o600 });
      published = true; return 1;
    }
    return code;
  });
  await expect(runLlmCommand(["llm", "recover", f.workspace.name, "--config", join(f.root, "host/gateway.json")], f.context)).rejects.toThrow(edited ? "rollback was incomplete" : "cannot refresh");
  expect(published).toBe(true);
  expect(await readFile(f.connectionPath, "utf8")).toBe(edited ? changed : before);
  await expect(readFile(selection)).rejects.toMatchObject({ code: "ENOENT" });
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM principals").get()?.n)).toBe(1);
  const response = await fetch(`${f.gatewayOrigin}/v1/models`, { headers: { authorization: `Bearer ${f.token}` } });
  expect(response.status).toBe(200); await response.body?.cancel();
});
