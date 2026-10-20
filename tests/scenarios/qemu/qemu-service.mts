import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { finalizeRun, markRunFatal, quiesceRunPreservingEvidence, requestRunFinalization } from "./qemu-run-finalization.mts";
import { parseInputs, readJson, sendJson } from "./qemu-service-http.mts";
import { closeServiceListenerPreservingSocket, initializeService, shutdownService, socketLeasePath } from "./qemu-service-startup.mts";
import { createInputHandoff } from "./qemu-input-handoff.mts";
import { createEventFollower } from "./qemu-event-followers.mts";
import { snapshotInputs } from "./qemu-snapshot.mts";

const sourceRoot = await realpath(process.env.DIM_QEMU_SOURCE_ROOT ?? "/workspace");
const socketPath = process.env.DIM_QEMU_SERVICE_SOCKET ?? "/tmp/dim-qemu-verification/service.sock";
const launcher = process.env.DIM_QEMU_LAUNCHER ?? "/workspace/tests/scenarios/qemu/qemu-verify.bash";
const serviceDirectory = path.dirname(socketPath);
const pidPath = path.join(serviceDirectory, "service.pid");
const ownerPath = path.join(serviceDirectory, "service-owner.json");
const leasePath = socketLeasePath(socketPath);
const runsRoot = path.join(serviceDirectory, "runs");
const invokingUid = numericIdentity("DIM_QEMU_INVOKING_UID", process.getuid?.());
const invokingGid = numericIdentity("DIM_QEMU_INVOKING_GID", process.getgid?.());

let activeRun: import("./qemu-types.js").Run | undefined;

let latestRun: import("./qemu-types.js").Run | undefined;
let serviceState = "starting";

let shutdownPromise: Promise<void> | undefined;

let fatalShutdownPromise: Promise<void> | undefined;

let ownerIdentity: import("./qemu-types.js").ArtifactIdentity | undefined;

let socketIdentity: import("./qemu-types.js").ArtifactIdentity | undefined;

const eventFollowers: Set<import("./qemu-types.js").EventFollower> = new Set();

const server = http.createServer((request, response) => {
  void handle(request, response).catch((error) => {
    if (!response.destroyed) sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  });
});
const startup = await initializeService({ serviceDirectory, pidPath, ownerPath, socketPath, leasePath,
  runsRoot, server, onRuntimeError: handleRuntimeServerError }).catch((error) => {
  reportFailure(error);
  return undefined;
});
ownerIdentity = startup?.ownerIdentity;
socketIdentity = startup?.socketIdentity;
if (startup) serviceState = "accepting";

async function handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
  if (serviceState === "starting") {
    return sendJson(response, 503, { error: "QEMU verification is starting" });
  }
  const url = new URL(request.url ?? "/", "http://dim-qemu");
  if (request.method === "GET" && url.pathname === "/v1/status") return sendJson(response, 200, latestRun?.state ?? { status: "idle" });
  if (request.method === "GET" && url.pathname === "/v1/events") {
    const run = latestRun;
    if (!run) return response.end();
    if (eventFollowers.size >= 16) return sendJson(response, 503, { error: "too many event followers" });
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    const follower = createEventFollower(response, () => {
      process.stderr.write("QEMU event follower disconnected: pending output exceeded 8388608 bytes\n");
    });
    eventFollowers.add(follower);
    const releaseFollower = () => {
      eventFollowers.delete(follower);
      run.listeners.delete(follower);
    };
    response.once("close", releaseFollower);
    response.once("error", releaseFollower);
    if (run.output) follower.write(run.output);
    if (activeRun !== run) return follower.end();
    run.listeners.add(follower);
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
      try {
        if (run.preserveEvidence) return;
        await requestRunFinalization(run, run.abort.signal.aborted ? "cancelled" : "rejected");
      } catch (finalizationError) {
        reportFailure(error);
        await beginFatalShutdown(finalizationError);
        return;
      }
      if (!run.abort.signal.aborted) throw error;
      return;
    }
  }
  if (request.method === "DELETE" && url.pathname === "/v1/run") {
    const run = activeRun;
    if (!run?.child || run.state.status !== "running") return sendJson(response, 409, { error: "QEMU verification is not running" });
    run.cancelled = true;
    try {
      await requestRunFinalization(run, "cancelled");
    } catch (error) {
      await beginFatalShutdown(error);
      return;
    }
    return sendJson(response, 202, { ...run.state, cancelling: true });
  }
  return sendJson(response, 404, { error: "not found" });
}

function claimRun(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {

  let resolveFinalization: ((reason:import("./qemu-types.js").FinalizationReason)=>void) | undefined;

  const finalizationRequested: Promise<import("./qemu-types.js").FinalizationReason> = new Promise((resolve) => { resolveFinalization = resolve; });
  if (resolveFinalization === undefined) throw new Error("finalization resolver was not initialized");

  const run: import("./qemu-types.js").Run = {
    abort: new AbortController(), cancelled: false,
    child: undefined, childClosed: undefined, closeResult: undefined,
    completion: undefined, finalizationRequested: false,
    listeners: new Set(), output: "", request, response, resolveFinalization,
    cleanupOwner: undefined, handoffRoot: undefined, preserveEvidence: false, snapshotRoot: undefined, work: undefined,
    state: { status: "running", startedAt: new Date().toISOString(), inputs: [], verbose: false, mode: "run" },
  };
  run.completion = (async () => finalizeRun(run, await finalizationRequested, { releaseRun }))();
  activeRun = run;
  latestRun = run;
  return run;
}

async function prepareRun(run: import("./qemu-types.js").Run) {
  if (!run.request) throw new Error("run request is unavailable");
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
  const snapshots = await snapshotInputs({ inputs: requestInputs, inputsRoot, sourceRoot, signal: run.abort.signal });
  if (snapshots.length === 0) return snapshots;
  run.handoffRoot = await mkdtemp(path.join(serviceDirectory, "handoff-"));
  await chmod(run.handoffRoot, 0o700);
  return createInputHandoff({
    handoffRoot: run.handoffRoot, inputs: snapshots, snapshotRoot: run.snapshotRoot, signal: run.abort.signal,
    uid: invokingUid, gid: invokingGid
  });
}

function numericIdentity(name: string, fallback: number | undefined) {
  const value = process.env[name] ?? String(fallback);
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function start(run: import("./qemu-types.js").Run, inputs: import("./qemu-types.js").Input[]) {
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

  const append = (chunk: string | Uint8Array) => {
    run.output += String(chunk);
    if (run.output.length > 8 * 1024 * 1024) run.output = run.output.slice(-8 * 1024 * 1024);
    for (const listener of run.listeners) {
      listener.write(chunk);
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    append(`failed to start QEMU verification: ${error.message}\n`);
    if (!run.preserveEvidence) void requestRunFinalization(run, "closed").catch(beginFatalShutdown);
  });
  run.childClosed = new Promise( (resolve: (value?:void)=>void) => {
    child.once("exit", (exitCode, signal) => {
      run.closeResult = { exitCode, signal };
      if (!run.preserveEvidence) void requestRunFinalization(run, "closed").catch(beginFatalShutdown);
    });
    child.once("close", () => {
      run.child = undefined;
      resolve();
    });
  });
}

function releaseRun(run: import("./qemu-types.js").Run, reason: import("./qemu-types.js").FinalizationReason) {
  if (activeRun === run) activeRun = undefined;
  if (reason === "rejected" && latestRun === run) latestRun = undefined;
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
  void shutdownPromise.catch((error) => { void beginFatalShutdown(error); });
  return shutdownPromise;
}

function beginFatalShutdown(error: unknown): Promise<never | void> {
  reportFailure(error);
  if (fatalShutdownPromise) return fatalShutdownPromise;
  serviceState = "stopping";
  const run = activeRun;
  markRunFatal(run);
  if (shutdownPromise) {
    fatalShutdownPromise = shutdownPromise.catch(async (shutdownError) => {
      reportFailure(shutdownError);
      try { await closeServiceListenerPreservingSocket({ server, socketIdentity, socketPath }); }
      catch (closeError) { reportFailure(closeError); }
    }).finally(() => process.exit(1));
    return fatalShutdownPromise;
  }
  fatalShutdownPromise = (async () => {
    try { await quiesceRunPreservingEvidence(run); }
    catch (runError) { reportFailure(runError); }
    try { await closeServiceListenerPreservingSocket({ server, socketIdentity, socketPath }); }
    catch (closeError) { reportFailure(closeError); }
  })().finally(() => process.exit(1));
  return fatalShutdownPromise;
}

function handleRuntimeServerError(error: Error) {
  void beginFatalShutdown(error);
}

async function shutdown(run: import("./qemu-types.js").Run | undefined) {
  if (run) {
    await requestRunFinalization(run, "cancelled");
  }
  await shutdownService({ ownerIdentity, ownerPath, runsRoot, server, socketIdentity, socketPath });
  serviceState = "stopped";
}

function reportFailure(error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

if (startup) for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, beginShutdown);
