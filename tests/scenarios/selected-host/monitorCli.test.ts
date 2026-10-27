import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { authenticatedMonitorClient } from "./monitorClient.js";

const script = new URL("../../../scripts/checks/opencode-task-monitor.ts", import.meta.url).pathname;
const password = "fixture-private-server-password";
const bounds = { parentSessionId: "ses_parent", directory: "/workspace/main", maxSessions: 8, maxDepth: 4,
  maxRequests: 32, recentMessages: 4, staleMinutes: 15, deadlineSeconds: 2, requestTimeoutSeconds: 1 };

async function run(args: readonly string[], root: string, input?: unknown) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { PATH: "", HOME: root }, stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}

it("inspects an existing parent and child through real read-only HTTP without DIM, tools setup or credential disclosure", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-monitor-cli-")), paths: string[] = [];
  const server = createServer((request, response) => {
    expect(request.method).toBe("GET");
    if (request.headers.authorization !== `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`) { response.writeHead(401).end("PRIVATE_AUTH_DIAGNOSTIC"); return; }
    const url = new URL(request.url ?? "/", "http://fixture"); paths.push(url.pathname);
    const data: Record<string, unknown> = {
      "/experimental/tool/ids": [], "/session/status": { ses_child: { type: "busy" } },
      "/session": [{ id: "ses_parent" }, { id: "ses_child", parentID: "ses_parent" }], "/session/ses_parent": { id: "ses_parent" },
      "/session/ses_parent/message": [], "/session/ses_parent/children": [{ id: "ses_child", parentID: "ses_parent" }],
      "/session/ses_child/children": [], "/session/ses_child/message": [{ info: { role: "assistant", time: { created: Date.now() } }, parts: [
        { type: "text", text: "PRIVATE_PROMPT" }, { type: "reasoning", text: "PRIVATE_THINKING" },
        { type: "tool", tool: "bash", state: { status: "running", input: password, output: "PRIVATE_OUTPUT" } },
      ] }],
    };
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(data[url.pathname]));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listener missing");
  const origin = `http://127.0.0.1:${address.port}`, config = join(root, "targets.json");
  try {
    const metadata = join(root, "omo.json");
    await writeFile(metadata, JSON.stringify({ source: "optional-omo-adapter", enabled: true, truncated: false, unreadable: false, teams: [
      { leadSessionId: "ses_parent", status: "active", modifiedAt: new Date().toISOString(), members: [{ sessionId: "ses_child", status: "idle" }] },
      { leadSessionId: "ses_unrelated", status: "active", modifiedAt: new Date().toISOString(), members: [{ sessionId: "ses_unrelatedMember", status: "running" }] },
    ] }), { mode: 0o600 });
    await writeFile(config, JSON.stringify({ schemaVersion: 1, targets: [{ name: "fixture", serverOrigin: origin, monitor: bounds, omoMetadataFile: metadata }] }), { mode: 0o600 });
    const args = ["--targets", config, "--target", "fixture", "--credentials-stdin", "--json"];
    const input = { schemaVersion: 1, credentials: { fixture: { username: "fixture", password } } };
    const result = await run(args, root, input);
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "inspected", completion: "not-assessed",
      results: [{ target: "fixture", inspection: "inspected", evidence: { state: "active", parent: "idle", activeChildren: 1, completion: "not-assessed" } }] });
    for (const secret of [password, "PRIVATE_PROMPT", "PRIVATE_THINKING", "PRIVATE_OUTPUT"]) expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain("ses_unrelated");
    expect(JSON.parse(result.stdout)).toMatchObject({ results: [{ evidence: { sessions: expect.arrayContaining([
      expect.objectContaining({ sessionId: "ses_child", omoStatus: "idle", sourceDisagreement: true }),
    ]) } }] });
    expect(paths).toContain("/session/ses_parent/children"); expect(paths).toContain("/session/ses_child/message");
    const limited = join(root, "limited.json");
    await writeFile(limited, JSON.stringify({ schemaVersion: 1, targets: [{ name: "fixture", serverOrigin: origin, monitor: { ...bounds, maxRequests: 1 } }] }), { mode: 0o600 });
    const incomplete = await run(["--targets", limited, "--target", "fixture", "--credentials-stdin", "--json"], root, input);
    expect(incomplete.code).toBe(2); expect(JSON.parse(incomplete.stdout)).toMatchObject({ outcome: "incomplete", results: [{ evidence: { state: "unknown", discovery: "bounded-truncated" } }] });
    const denied = await run(args, root, { schemaVersion: 1, credentials: { fixture: { username: "fixture", password: "wrong-fixture-password" } } });
    expect(denied.code).toBe(2); expect(JSON.parse(denied.stdout)).toMatchObject({ outcome: "unavailable", results: [{ evidence: { state: "unreachable" } }] });
    expect(denied.stdout).not.toContain("PRIVATE_AUTH_DIAGNOSTIC");
    const client = authenticatedMonitorClient(origin, { username: "fixture", password }, bounds.directory), before = paths.length;
    await expect(client.get("/config", 500)).rejects.toThrow(); await expect(client.get("http://unselected.invalid/session", 500)).rejects.toThrow();
    expect(paths).toHaveLength(before);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
});

it("provides immediate offline help and rejects credential flags without echoing their values", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-monitor-help-"));
  try {
    await mkdir(join(root, "empty"));
    const help = await run(["--help"], root); expect(help.code).toBe(0); expect(help.stdout).toContain("--credentials-stdin");
    const invalid = await run(["--password", password, "--json"], root);
    expect(invalid.code).toBe(2); expect(invalid.stdout).not.toContain(password); expect(invalid.stderr).not.toContain(password);
  } finally { await rm(root, { recursive: true, force: true }); }
});
