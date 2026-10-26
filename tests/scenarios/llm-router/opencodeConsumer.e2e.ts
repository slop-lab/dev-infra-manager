import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import DimLlmRouter from "../../../packages/host/plugins/llm-router/src/opencode.js";

// Explicit real-consumer gate, not part of the binary-independent unit suite.
// The catalogue is synthetic. This does not establish provider inference.
const binary = process.argv[2];
if (!binary || process.argv.length !== 3) throw new Error("usage: tsx scenarios/llm-router/opencodeConsumer.e2e.ts /absolute/opencode-1.18.31");
const executable = resolve(binary);
const root = await mkdtemp(join(tmpdir(), "dim-opencode-consumer-"));
const token = randomBytes(32).toString("base64url");
const password = randomBytes(24).toString("base64url");
const catalogue = createServer((request, response) => {
  if (request.url !== "/v1/capabilities" || request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(403).end(); return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ models: [
    { id: "fixture-responses", name: "Fixture Responses", api: "responses", context: 32000, output: 4096 },
    { id: "fixture-chat", name: "Fixture Chat", api: "chat", context: 32000, output: 4096 },
  ] }));
});
let stop: (() => Promise<void>) | undefined;
const previousConnection = process.env.DIM_LLM_ROUTER_CONNECTION_FILE;
const previousMode = process.env.DIM_LLM_ROUTER_OPENCODE_MODE;
try {
  await new Promise<void>((done) => catalogue.listen(0, "127.0.0.1", done));
  const address = catalogue.address();
  if (!address || typeof address === "string") throw new Error("catalogue listener missing");
  const connection = join(root, "connection.json");
  await writeFile(connection, JSON.stringify({ schemaVersion: 1, endpoint: `http://127.0.0.1:${address.port}`, token }), { mode: 0o600 });
  process.env.DIM_LLM_ROUTER_CONNECTION_FILE = connection;
  process.env.DIM_LLM_ROUTER_OPENCODE_MODE = "router";
  const hooks = await DimLlmRouter();
  const config: Record<string, unknown> = {};
  await hooks.config(config);
  const directories = ["config", "data", "state", "cache", "tmp"] as const;
  await Promise.all(directories.map((directory) => mkdir(join(root, directory), { mode: 0o700 })));
  // An allowlist deliberately excludes live auth, OMO and inherited OpenCode configuration.
  const environment = {
    HOME: root, PATH: process.env.PATH ?? "",
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), TMPDIR: join(root, "tmp"),
    OPENCODE_SERVER_USERNAME: "fixture", OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
  const version = spawnSync(executable, ["--version"], { env: environment, cwd: root, encoding: "utf8", timeout: 5000 });
  assert.equal(version.status, 0, "isolated OpenCode version command failed");
  assert.equal(version.stdout.trim(), "1.18.31", "OpenCode must match the reviewed consumer pin");
  const child = spawn(executable, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"], {
    env: environment, cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.kill("SIGTERM");
    try { await exited; } finally { clearTimeout(force); }
  };
  let outputBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => { outputBytes += chunk.length; });
  const endpoint = await new Promise<string>((done, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`isolated OpenCode startup timed out; outputBytes=${outputBytes}`)), 15_000);
    const finish = () => clearTimeout(timeout);
    child.once("error", (error) => { finish(); reject(error); });
    child.once("exit", (code) => { finish(); reject(new Error(`isolated OpenCode exited before readiness; status=${code}; outputBytes=${outputBytes}`)); });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      output = (output + chunk.toString("utf8")).slice(-4096);
      const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match?.[1]) { finish(); done(match[1]); }
    });
  });
  const authorization = `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`;
  async function request(path: string, method = "GET"): Promise<unknown> {
    const response = await fetch(`${endpoint}${path}`, {
      method, headers: { authorization, "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}), signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, `real OpenCode ${path} rejected adapter configuration (HTTP ${response.status})`);
    return response.json();
  }
  // Exercise the actual response schema that rejected chunkTimeout:0 in use.
  const accepted = await request("/config");
  assert.ok(accepted && typeof accepted === "object" && "provider" in accepted);
  const providers = accepted.provider;
  assert.ok(providers && typeof providers === "object");
  for (const id of ["openai", "dim-responses", "dim-chat"]) {
    assert.ok(id in providers, `real consumer omitted ${id}`);
    const provider: unknown = Reflect.get(providers, id);
    assert.ok(provider && typeof provider === "object" && "options" in provider);
    const options = provider.options;
    assert.ok(options && typeof options === "object" && "chunkTimeout" in options);
    assert.equal(options.chunkTimeout, false);
  }
  const session = await request("/session", "POST");
  assert.ok(session && typeof session === "object" && "id" in session && typeof session.id === "string");
  const unauthenticated = await fetch(`${endpoint}/config`, { signal: AbortSignal.timeout(5000) });
  await unauthenticated.body?.cancel();
  assert.equal(unauthenticated.status, 401, "private consumer must reject unauthenticated access");
  process.stdout.write("PASS: OpenCode 1.18.31 accepted all generated provider timeouts and created an isolated session; authentication enforced. No inference requested.\n");
} finally {
  if (previousConnection === undefined) delete process.env.DIM_LLM_ROUTER_CONNECTION_FILE;
  else process.env.DIM_LLM_ROUTER_CONNECTION_FILE = previousConnection;
  if (previousMode === undefined) delete process.env.DIM_LLM_ROUTER_OPENCODE_MODE;
  else process.env.DIM_LLM_ROUTER_OPENCODE_MODE = previousMode;
  try { await stop?.(); }
  finally {
    catalogue.closeAllConnections();
    await new Promise<void>((done, reject) => catalogue.close((error) => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
}
