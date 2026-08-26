import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const sourceRoot = await realpath(process.env.DIM_QEMU_SOURCE_ROOT ?? "/workspace");
const socketPath = process.env.DIM_QEMU_SERVICE_SOCKET ?? "/tmp/dim-qemu-verification/service.sock";
const launcher = process.env.DIM_QEMU_LAUNCHER ?? "/workspace/project/.dim/qemu-verify.bash";
const listeners = new Set();
let child;
let output = "";
let state = { status: "idle" };

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
await rm(socketPath, { force: true });

const server = http.createServer((request, response) => {
  void handle(request, response).catch((error) => sendJson(response, 400, {
    error: error instanceof Error ? error.message : String(error)
  }));
});
server.listen(socketPath, async () => {
  await chmod(socketPath, 0o600);
  await writeFile(path.join(path.dirname(socketPath), "service.pid"), `${process.pid}\n`);
});

async function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://dim-qemu");
  if (request.method === "GET" && url.pathname === "/v1/status") return sendJson(response, 200, state);
  if (request.method === "GET" && url.pathname === "/v1/events") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.write(output);
    if (state.status !== "running") return response.end();
    listeners.add(response);
    response.on("close", () => listeners.delete(response));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/run") {
    if (state.status === "running") return sendJson(response, 409, { error: "QEMU verification is already running" });
    const body = await readJson(request);
    const inputs = await validateInputs(body.inputs ?? []);
    start(inputs);
    return sendJson(response, 202, state);
  }
  if (request.method === "DELETE" && url.pathname === "/v1/run") {
    if (!child || state.status !== "running") return sendJson(response, 409, { error: "QEMU verification is not running" });
    stopChild();
    return sendJson(response, 202, { ...state, cancelling: true });
  }
  return sendJson(response, 404, { error: "not found" });
}

async function validateInputs(value) {
  if (!Array.isArray(value) || value.length > 16) throw new Error("inputs must be an array of at most 16 entries");
  const names = new Set();
  return await Promise.all(value.map(async (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("each input must be an object");
    const { name, path: requested } = entry;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || names.has(name)) {
      throw new Error(`invalid or duplicate input name '${String(name)}'`);
    }
    if (typeof requested !== "string" || !path.isAbsolute(requested)) throw new Error(`input '${name}' path must be absolute`);
    const resolved = await realpath(requested);
    if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}/`)) {
      throw new Error(`input '${name}' resolves outside ${sourceRoot}`);
    }
    if (!(await lstat(resolved)).isDirectory()) throw new Error(`input '${name}' must be a directory`);
    names.add(name);
    return { name, path: resolved };
  }));
}

function start(inputs) {
  output = "";
  state = { status: "running", startedAt: new Date().toISOString(), inputs: inputs.map(({ name }) => name) };
  child = spawn("bash", [launcher], {
    cwd: sourceRoot,
    env: { ...process.env, DIM_QEMU_SOURCE_ROOT: sourceRoot, DIM_QEMU_EXTRA_INPUTS_JSON: JSON.stringify(inputs) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const append = (chunk) => {
    output += String(chunk);
    if (output.length > 8 * 1024 * 1024) output = output.slice(-8 * 1024 * 1024);
    for (const listener of listeners) listener.write(chunk);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => append(`failed to start QEMU verification: ${error.message}\n`));
  child.on("close", (exitCode, signal) => {
    state = {
      ...state,
      status: exitCode === 0 ? "success" : signal ? "cancelled" : "failure",
      exitCode: exitCode ?? undefined,
      signal: signal ?? undefined,
      completedAt: new Date().toISOString()
    };
    child = undefined;
    for (const listener of listeners) listener.end();
    listeners.clear();
  });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  return value;
}

function sendJson(response, status, value) {
  if (response.headersSent) return response.end();
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void shutdown());
}

async function shutdown() {
  if (child) {
    const stopped = new Promise((resolve) => child.once("close", resolve));
    stopChild();
    await stopped;
  }
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

function stopChild() {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
}
