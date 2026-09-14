import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { snapshotInputs } from "./qemu-snapshot.mjs";

const sourceRoot = await realpath(process.env.DIM_QEMU_SOURCE_ROOT ?? "/workspace");
const socketPath = process.env.DIM_QEMU_SERVICE_SOCKET ?? "/tmp/dim-qemu-verification/service.sock";
const launcher = process.env.DIM_QEMU_LAUNCHER ?? "/workspace/project/.dim/qemu-verify.bash";
const serviceDirectory = path.dirname(socketPath);
const pidPath = path.join(serviceDirectory, "service.pid");
const runsRoot = path.join(serviceDirectory, "runs");
let activeRun;
let latestRun;
let serviceState = "accepting";
let shutdownPromise;

await mkdir(serviceDirectory, { recursive: true, mode: 0o755 });

const server = http.createServer((request, response) => {
  void handle(request, response).catch((error) => {
    if (!response.destroyed) sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolve);
});
await rm(runsRoot, { recursive: true, force: true });
await mkdir(runsRoot, { mode: 0o700 });
await chmod(socketPath, 0o666);
const socketIdentity = await lstat(socketPath, { bigint: true });
await writeFile(pidPath, `${process.pid}\n`);

async function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://dim-qemu");
  if (request.method === "GET" && url.pathname === "/v1/status") return sendJson(response, 200, latestRun?.state ?? { status: "idle" });
  if (request.method === "GET" && url.pathname === "/v1/events") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    const run = latestRun;
    if (!run) return response.end();
    response.write(run.output);
    if (activeRun !== run) return response.end();
    run.listeners.add(response);
    response.on("close", () => run.listeners.delete(response));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/run") {
    if (serviceState !== "accepting") return sendJson(response, 503, { error: "QEMU verification is stopping" });
    if (activeRun) return sendJson(response, 409, { error: "QEMU verification is already running" });
    const run = claimRun(request, response);
    try {
      run.work = prepareRun(run);
      const inputs = await run.work;
      run.abort.signal.throwIfAborted();
      run.work = undefined;
      start(run, inputs);
      sendJson(response, 202, run.state);
      run.request = undefined;
      run.response = undefined;
      return;
    } catch (error) {
      await requestFinalization(run, run.abort.signal.aborted ? "cancelled" : "rejected");
      if (!run.abort.signal.aborted) throw error;
      return;
    }
  }
  if (request.method === "DELETE" && url.pathname === "/v1/run") {
    const run = activeRun;
    if (!run?.child || run.state.status !== "running") return sendJson(response, 409, { error: "QEMU verification is not running" });
    run.cancelled = true;
    stopChild(run);
    return sendJson(response, 202, { ...run.state, cancelling: true });
  }
  return sendJson(response, 404, { error: "not found" });
}

function claimRun(request, response) {
  let resolveFinalization;
  const finalizationRequested = new Promise((resolve) => { resolveFinalization = resolve; });
  const run = {
    abort: new AbortController(), cancelled: false,
    child: undefined, childClosed: undefined, closeResult: undefined,
    completion: undefined, finalizationRequested: false,
    listeners: new Set(), output: "", request, response, resolveFinalization,
    snapshotRoot: undefined, work: undefined,
    state: { status: "running", startedAt: new Date().toISOString(), inputs: [], verbose: false, mode: "run" },
  };
  run.completion = (async () => finalizeRun(run, await finalizationRequested))();
  activeRun = run;
  latestRun = run;
  return run;
}

async function prepareRun(run) {
  const body = await readJson(run.request, run.abort.signal);
  const requestInputs = parseInputs(body.inputs ?? []);
  if (body.verbose !== undefined && typeof body.verbose !== "boolean") throw new Error("verbose must be a boolean");
  const mode = body.mode ?? "run";
  if (mode !== "run" && mode !== "probe") throw new Error("mode must be 'run' or 'probe'");
  if (mode === "probe" && (requestInputs.length > 0 || body.verbose === true)) throw new Error("probe does not accept inputs or verbose output");
  run.state = {
    status: "running", startedAt: run.state.startedAt, inputs: requestInputs.map(({ name }) => name),
    verbose: body.verbose === true, mode
  };
  run.snapshotRoot = await mkdtemp(path.join(runsRoot, "run-"));
  await chmod(run.snapshotRoot, 0o700);
  const inputsRoot = path.join(run.snapshotRoot, "inputs");
  await mkdir(inputsRoot, { mode: 0o700 });
  await chmod(inputsRoot, 0o700);
  return snapshotInputs({ inputs: requestInputs, inputsRoot, sourceRoot, signal: run.abort.signal });
}

function parseInputs(value) {
  if (!Array.isArray(value) || value.length > 16) throw new Error("inputs must be an array of at most 16 entries");
  const names = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("each input must be an object");
    const { name, path: requested } = entry;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error(`invalid input name '${String(name)}'`);
    if (names.has(name)) throw new Error(`duplicate input name '${name}'`);
    if (typeof requested !== "string" || !path.isAbsolute(requested)) throw new Error(`input '${name}' path must be absolute`);
    names.add(name);
    return { name, path: requested };
  });
}

function start(run, inputs) {
  run.abort.signal.throwIfAborted();
  if (serviceState !== "accepting" || activeRun !== run || run.finalizationRequested) throw new Error("QEMU verification is stopping");
  const environment = { ...process.env };
  delete environment.DIM_QEMU_EXTRA_INPUTS_JSON;
  environment.DIM_QEMU_SOURCE_ROOT = sourceRoot;
  environment.DIM_QEMU_INPUT_SNAPSHOTS_JSON = JSON.stringify(inputs);
  const child = spawn("bash", [launcher, ...(run.state.mode === "probe" ? ["--probe"] : run.state.verbose ? ["--verbose"] : [])], {
    cwd: sourceRoot, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"]
  });
  run.child = child;
  const append = (chunk) => {
    run.output += String(chunk);
    if (run.output.length > 8 * 1024 * 1024) run.output = run.output.slice(-8 * 1024 * 1024);
    for (const listener of run.listeners) listener.write(chunk);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => append(`failed to start QEMU verification: ${error.message}\n`));
  run.childClosed = new Promise((resolve) => {
    child.once("close", (exitCode, signal) => {
      run.closeResult = { exitCode, signal };
      run.child = undefined;
      resolve();
      void requestFinalization(run, "closed").catch(reportFailure);
    });
  });
}

function requestFinalization(run, reason) {
  if (!run.finalizationRequested) {
    run.finalizationRequested = true;
    run.resolveFinalization(reason);
  }
  return run.completion;
}

async function finalizeRun(run, reason) {
  try {
    if (run.work) {
      try { await run.work; } catch (error) {
        if (reason !== "rejected" && !run.abort.signal.aborted) throw error;
      }
    }
    if (run.childClosed) await run.childClosed;
    if (reason !== "rejected") {
      run.state = {
        ...run.state,
        status: run.cancelled || reason === "cancelled" ? "cancelled" : run.closeResult?.exitCode === 0 ? "success" : "failure",
        exitCode: run.closeResult?.exitCode ?? undefined, signal: run.closeResult?.signal ?? undefined,
        completedAt: new Date().toISOString()
      };
    }
    if (run.snapshotRoot) await rm(run.snapshotRoot, { recursive: true, force: true });
  } finally {
    run.snapshotRoot = undefined;
    if (activeRun === run) activeRun = undefined;
    if (reason === "rejected" && latestRun === run) latestRun = undefined;
    for (const listener of run.listeners) listener.end();
    run.listeners.clear();
  }
}

async function readJson(request, signal) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > 65_536) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  signal.throwIfAborted();
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

function stopChild(run) {
  if (!run.child?.pid) return;
  try { process.kill(-run.child.pid, "SIGTERM"); } catch (error) {
    if (!error || error.code !== "ESRCH") throw error;
  }
}

function beginShutdown() {
  if (shutdownPromise) return shutdownPromise;
  serviceState = "stopping";
  const run = activeRun;
  if (run) {
    run.cancelled = true;
    run.abort.abort();
    run.request?.destroy();
    run.response?.destroy();
    stopChild(run);
  }
  shutdownPromise = shutdown(run);
  void shutdownPromise.catch(reportFailure);
  return shutdownPromise;
}

async function shutdown(run) {
  if (run) await requestFinalization(run, "cancelled");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(runsRoot, { recursive: true, force: true });
  await removeOwnedArtifacts();
  serviceState = "stopped";
}

async function removeOwnedArtifacts() {
  try {
    const current = await lstat(socketPath, { bigint: true });
    if (current.dev === socketIdentity.dev && current.ino === socketIdentity.ino && current.isSocket()) await rm(socketPath, { force: true });
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  try {
    if (await readFile(pidPath, "utf8") === `${process.pid}\n`) await rm(pidPath, { force: true });
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}

function reportFailure(error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, beginShutdown);
