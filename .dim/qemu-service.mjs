import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { stopProcessGroup } from "./qemu-process-group.mjs";
import { parseInputs, readJson, sendJson } from "./qemu-service-http.mjs";
import { closeServiceListenerPreservingSocket, initializeService, shutdownService, socketLeasePath } from "./qemu-service-startup.mjs";
import { snapshotInputs } from "./qemu-snapshot.mjs";

const sourceRoot = await realpath(process.env.DIM_QEMU_SOURCE_ROOT ?? "/workspace");
const socketPath = process.env.DIM_QEMU_SERVICE_SOCKET ?? "/tmp/dim-qemu-verification/service.sock";
const launcher = process.env.DIM_QEMU_LAUNCHER ?? "/workspace/project/.dim/qemu-verify.bash";
const serviceDirectory = path.dirname(socketPath);
const pidPath = path.join(serviceDirectory, "service.pid");
const ownerPath = path.join(serviceDirectory, "service-owner.json");
const leasePath = socketLeasePath(socketPath);
const runsRoot = path.join(serviceDirectory, "runs");
let activeRun;
let latestRun;
let serviceState = "starting";
let shutdownPromise;
let fatalShutdownPromise;

const server = http.createServer((request, response) => {
  void handle(request, response).catch((error) => {
    if (!response.destroyed) sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  });
});
const startup = await initializeService({ serviceDirectory, pidPath, ownerPath, socketPath, leasePath,
  runsRoot, server }).catch((error) => {
  reportFailure(error);
  return undefined;
});
const ownerIdentity = startup?.ownerIdentity;
const socketIdentity = startup?.socketIdentity;
if (startup) serviceState = "accepting";

async function handle(request, response) {
  if (serviceState === "starting") {
    return sendJson(response, 503, { error: "QEMU verification is starting" });
  }
  const url = new URL(request.url ?? "/", "http://dim-qemu");
  if (request.method === "GET" && url.pathname === "/v1/status") return sendJson(response, 200, latestRun?.state ?? { status: "idle" });
  if (request.method === "GET" && url.pathname === "/v1/events") {
    const run = latestRun;
    if (!run) return response.end();
    if (activeRun === run && run.listeners.size >= 16) return sendJson(response, 503, { error: "too many event followers" });
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    if (run.output && !response.write(run.output)) return response.destroy();
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
    await requestFinalization(run, "cancelled");
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
  const requestInputs = parseInputs(body.inputs ?? [], path);
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
  run.groupPid = child.pid;
  const append = (chunk) => {
    run.output += String(chunk);
    if (run.output.length > 8 * 1024 * 1024) run.output = run.output.slice(-8 * 1024 * 1024);
    for (const listener of run.listeners) {
      if (!listener.write(chunk)) {
        run.listeners.delete(listener);
        listener.destroy();
      }
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    append(`failed to start QEMU verification: ${error.message}\n`);
    void requestFinalization(run, "closed").catch(beginFatalShutdown);
  });
  run.childClosed = new Promise((resolve) => {
    child.once("exit", (exitCode, signal) => {
      run.closeResult = { exitCode, signal };
      void requestFinalization(run, "closed").catch(beginFatalShutdown);
    });
    child.once("close", () => {
      run.child = undefined;
      resolve();
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
    if (run.childClosed) {
      await stopProcessGroup(run);
      await run.childClosed;
    }
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

function beginShutdown() {
  if (fatalShutdownPromise) return fatalShutdownPromise;
  if (shutdownPromise) return shutdownPromise;
  serviceState = "stopping";
  const run = activeRun;
  if (run) {
    run.cancelled = true;
    run.abort.abort();
    run.request?.destroy();
    run.response?.destroy();
  }
  shutdownPromise = shutdown(run);
  void shutdownPromise.catch((error) => {
    if (fatalShutdownPromise) return;
    reportFailure(error);
    process.exit(1);
  });
  return shutdownPromise;
}

function beginFatalShutdown(error) {
  reportFailure(error);
  if (fatalShutdownPromise) return fatalShutdownPromise;
  serviceState = "stopping";
  activeRun?.abort.abort();
  activeRun?.request?.destroy();
  activeRun?.response?.destroy();
  fatalShutdownPromise = closeServiceListenerPreservingSocket({ server, socketIdentity, socketPath })
    .catch(reportFailure).finally(() => process.exit(1));
  return fatalShutdownPromise;
}

async function shutdown(run) {
  if (run) {
    await requestFinalization(run, "cancelled");
  }
  await shutdownService({ ownerIdentity, ownerPath, runsRoot, server, socketIdentity, socketPath });
  serviceState = "stopped";
}

function reportFailure(error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

if (startup) for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, beginShutdown);
