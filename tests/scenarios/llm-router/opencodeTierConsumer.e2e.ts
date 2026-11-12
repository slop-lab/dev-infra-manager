import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Explicit pinned-consumer gate. Only a loopback synthetic chat backend is used;
// no live account, provider model or existing workspace/server is contacted.
const binary = process.argv[2];
if (!binary || process.argv.length !== 3) throw new Error("usage: opencodeTierConsumer.e2e.ts /absolute/opencode-1.18.31");
const root = await mkdtemp(join(tmpdir(), "dim-tier-consumer-"));
const token = randomBytes(32).toString("base64url"), password = randomBytes(24).toString("base64url");
const seen: { model: string; sessionId: string | undefined }[] = [];
let backendFailure: string | undefined;
const backend = createServer((request, response) => {
  void (async () => {
    if (request.headers.authorization !== `Bearer ${token}`) throw new Error("synthetic backend authentication mismatch");
    if (request.url === "/v1/capabilities" && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: ["fast", "balanced", "smart"].map((name) => ({
        id: `auto:${name}`, name, api: "chat", context: 32000, output: 4096,
      })) })); return;
    }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST" || seen.length >= 8) throw new Error("unexpected synthetic backend request");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const value of request) {
      const chunk = Buffer.from(value); bytes += chunk.length;
      if (bytes > 256 * 1024) throw new Error("synthetic request size bound");
      chunks.push(chunk);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.ok(body && typeof body === "object" && "model" in body && typeof body.model === "string");
    const sessionId = request.headers["x-dim-session-id"];
    assert.equal(typeof sessionId, "string", "actual chat.headers hook did not supply session identity");
    seen.push({ model: body.model, sessionId: sessionId as string });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish] of [[{ role: "assistant", content: "fixture-ok" }, null], [{}, "stop"]] as const) {
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  })().catch((error: unknown) => {
    backendFailure = error instanceof Error ? error.message : "synthetic backend contract failed";
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
let stop: (() => Promise<void>) | undefined;
try {
  await new Promise<void>((done) => backend.listen(0, "127.0.0.1", done));
  const address = backend.address(); assert.ok(address && typeof address !== "string");
  const connection = join(root, "connection.json"), adapter = join(root, "adapter.mjs");
  await writeFile(connection, JSON.stringify({ schemaVersion: 1, endpoint: `http://127.0.0.1:${address.port}`, token,
    tiers: { quick: "auto:fast", standard: "auto:balanced", deep: "auto:smart" } }), { mode: 0o600 });
  await writeFile(adapter, await readFile(new URL("../../../packages/host/plugins/llm-router/dist/opencode.js", import.meta.url)), { mode: 0o600 });
  for (const name of ["config", "data", "state", "cache", "tmp"]) await mkdir(join(root, name), { mode: 0o700 });
  const environment = { HOME: root, PATH: process.env.PATH ?? "", TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_SERVER_USERNAME: "fixture", OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", DIM_LLM_ROUTER_CONNECTION_FILE: connection,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pathToFileURL(adapter).href], permission: { "*": "deny" } }) };
  const version = spawnSync(resolve(binary), ["--version"], { cwd: root, env: environment, encoding: "utf8", timeout: 5000 });
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), "1.18.31");
  const child = spawn(resolve(binary), ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit"); let outputBytes = 0;
  stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const force = setTimeout(() => child.kill("SIGKILL"), 2000); child.kill("SIGTERM");
    try { await exited; } finally { clearTimeout(force); }
  };
  child.stderr.on("data", (b: Buffer) => { outputBytes += b.length; });
  const endpoint = await new Promise<string>((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`isolated consumer startup deadline; outputBytes=${outputBytes}`)), 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`isolated consumer exit ${code}; outputBytes=${outputBytes}`)); });
    child.stdout.on("data", (b: Buffer) => {
      outputBytes += b.length; output = (output + b.toString("utf8")).slice(-4096);
      const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match?.[1]) { clearTimeout(timer); done(match[1]); }
    });
  });
  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(endpoint + path, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { authorization: `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, `isolated consumer rejected ${path}: HTTP ${response.status}`);
    return response.json();
  }
  const session = await post("/session", { title: "Synthetic tier wire contract" });
  assert.ok(session && typeof session === "object" && "id" in session && typeof session.id === "string");
  const result = await post(`/session/${session.id}/message`, { model: { providerID: "dim-chat", modelID: "standard" },
    parts: [{ type: "text", text: "Reply fixture-ok without tools." }] });
  assert.equal(backendFailure, undefined);
  assert.ok(seen.some((request) => request.model === "auto:balanced" && request.sessionId === session.id), "actual wire model/session identity differ from configured tier");
  assert.ok(result && typeof result === "object" && "info" in result && result.info && typeof result.info === "object" && !("error" in result.info), "synthetic completion failed");
  process.stdout.write(JSON.stringify({ result: "PASS", consumer: "OpenCode 1.18.31", actualPluginLoaded: true,
    requestedModel: "dim-chat/standard", wireModel: "auto:balanced", sessionHeaderMatched: true, syntheticOnly: true, requests: seen.length }) + "\n");
} finally {
  try { await stop?.(); } finally {
    backend.closeAllConnections(); await new Promise<void>((done) => backend.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}
