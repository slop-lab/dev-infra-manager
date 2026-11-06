import { readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
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

it.each([
  { edit: "none", timing: "repair" }, { edit: "token", timing: "repair" },
  { edit: "endpoint", timing: "repair" }, { edit: "metadata", timing: "repair" },
  { edit: "directory", timing: "repair" },
  { edit: "metadata", timing: "rollback" }
] as const)("rolls back committed endpoint recovery without overwriting guest edits ($edit/$timing)", async ({ edit, timing }) => {
  const f = await fixture(), selection = join(f.context.stateRoot, "llm-services", `${f.workspace.id}.json`);
  const before = JSON.stringify({ ...f.connection, endpoint: f.gatewayOrigin });
  const edited = edit !== "none", changed = {
    none: before,
    token: JSON.stringify({ ...f.connection, endpoint: f.gatewayOrigin, token: "z".repeat(43) }),
    endpoint: JSON.stringify({ ...f.connection, endpoint: "http://127.0.0.1:1" }),
    metadata: JSON.stringify({ ...f.connection, metadata: { owner: "concurrent-guest-edit" } }),
    directory: JSON.stringify(f.connection)
  }[edit];
  await writeFile(f.connectionPath, before, { mode: 0o600 }); await unlink(selection);
  const execute = vi.mocked(f.context.service.exec).getMockImplementation();
  if (!execute) throw new Error("missing guest executor");
  let published = false, editedAtRollback = false;
  vi.mocked(f.context.service.exec).mockImplementation(async (name, args, options) => {
    if (published && timing === "rollback" && options?.stdin && !editedAtRollback) {
      await writeFile(f.connectionPath, changed, { mode: 0o600 }); editedAtRollback = true;
    }
    const code = await execute(name, args, options);
    if (args[3] === f.workspace.id && args[4] === workspaceServiceEndpoint("llm-router") && code === 0) {
      if (edit === "directory") {
        const outside = join(f.root, "outside-guest-home");
        await rename(join(f.home, ".config/dim"), outside); await symlink(outside, join(f.home, ".config/dim"), "dir");
      }
      if (edited && timing === "repair") await writeFile(f.connectionPath, changed, { mode: 0o600 });
      published = true; return 1;
    }
    return code;
  });
  const failure = await runLlmCommand(["llm", "recover", f.workspace.name, "--config", join(f.root, "host/gateway.json")], f.context)
    .then(() => undefined, (error: unknown) => error);
  expect(published).toBe(true);
  if (timing === "rollback") expect(editedAtRollback).toBe(true);
  expect(await readFile(f.connectionPath, "utf8")).toBe(edited ? changed : before);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ message: expect.stringContaining(edited ? "rollback was incomplete" : "cannot refresh") });
  await expect(readFile(selection)).rejects.toMatchObject({ code: "ENOENT" });
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM principals").get()?.n)).toBe(1);
  const response = await fetch(`${f.gatewayOrigin}/v1/models`, { headers: { authorization: `Bearer ${f.token}` } });
  expect(response.status).toBe(200); await response.body?.cancel();
});
