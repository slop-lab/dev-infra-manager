import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const sourceRoot = await realpath(process.env.DIM_QEMU_SOURCE_ROOT ?? "/workspace");
const socketPath = process.env.DIM_QEMU_SERVICE_SOCKET ?? "/tmp/dim-qemu-verification/service.sock";
const launcher = process.env.DIM_QEMU_LAUNCHER ?? "/workspace/project/.dim/qemu-verify.bash";
const runsRoot = path.join(path.dirname(socketPath), "runs");
let activeRun;
let latestRun;

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o755 });
await rm(socketPath, { force: true });
await rm(runsRoot, { recursive: true, force: true });
await mkdir(runsRoot, { mode: 0o700 });

const server = http.createServer((request, response) => {
  void handle(request, response).catch((error) => sendJson(response, 400, {
    error: error instanceof Error ? error.message : String(error)
  }));
});
server.listen(socketPath, async () => {
  await chmod(socketPath, 0o666);
  await writeFile(path.join(path.dirname(socketPath), "service.pid"), `${process.pid}\n`);
});

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
    if (activeRun) return sendJson(response, 409, { error: "QEMU verification is already running" });
    const run = claimRun();
    try {
      const body = await readJson(request);
      const requestInputs = parseInputs(body.inputs ?? []);
      if (body.verbose !== undefined && typeof body.verbose !== "boolean") throw new Error("verbose must be a boolean");
      const mode = body.mode ?? "run";
      if (mode !== "run" && mode !== "probe") throw new Error("mode must be 'run' or 'probe'");
      if (mode === "probe" && (requestInputs.length > 0 || body.verbose === true)) throw new Error("probe does not accept inputs or verbose output");
      run.state = { status: "running", startedAt: run.state.startedAt, inputs: requestInputs.map(({ name }) => name), verbose: body.verbose === true, mode };
      const inputs = await snapshotInputs(run, requestInputs);
      start(run, inputs);
      return sendJson(response, 202, run.state);
    } catch (error) {
      await rejectRun(run);
      throw error;
    }
  }
  if (request.method === "DELETE" && url.pathname === "/v1/run") {
    const run = activeRun;
    if (!run?.child || run.state.status !== "running") return sendJson(response, 409, { error: "QEMU verification is not running" });
    stopChild(run);
    return sendJson(response, 202, { ...run.state, cancelling: true });
  }
  return sendJson(response, 404, { error: "not found" });
}

function claimRun() {
  const run = {
    child: undefined,
    listeners: new Set(),
    output: "",
    snapshotRoot: undefined,
    state: { status: "running", startedAt: new Date().toISOString(), inputs: [], verbose: false, mode: "run" }
  };
  activeRun = run;
  latestRun = run;
  return run;
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

async function snapshotInputs(run, inputs) {
  run.snapshotRoot = await mkdtemp(path.join(runsRoot, "run-"));
  await chmod(run.snapshotRoot, 0o700);
  const inputsRoot = path.join(run.snapshotRoot, "inputs");
  await mkdir(inputsRoot, { mode: 0o700 });
  const snapshots = [];
  for (const input of inputs) {
    const source = await open(input.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const openedPath = await realpath(`/proc/self/fd/${source.fd}`);
      if (openedPath !== sourceRoot && !openedPath.startsWith(`${sourceRoot}/`)) {
        throw new Error(`input '${input.name}' resolves outside ${sourceRoot}`);
      }
      const destination = path.join(inputsRoot, input.name);
      await mkdir(destination, { mode: 0o700 });
      await copySnapshot(source.fd, destination, input.name);
      await validateSnapshot(destination, input.name);
      snapshots.push({ name: input.name, path: destination });
    } finally {
      await source.close();
    }
  }
  return snapshots;
}

async function copySnapshot(sourceFd, destination, inputName) {
  const copier = spawn("cp", ["--recursive", "--no-dereference", "--", "/proc/self/fd/3/.", destination], {
    stdio: ["ignore", "ignore", "pipe", sourceFd]
  });
  let stderr = "";
  copier.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-65_536); });
  const result = await new Promise((resolve, reject) => {
    copier.once("error", reject);
    copier.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  if (result.exitCode !== 0) {
    throw new Error(`failed to snapshot input '${inputName}'${result.signal ? ` (${result.signal})` : ""}: ${stderr.trim()}`);
  }
}

async function validateSnapshot(directory, inputName) {
  for (const entry of await readdir(directory)) {
    const target = path.join(directory, entry);
    const metadata = await lstat(target);
    if (metadata.isDirectory()) await validateSnapshot(target, inputName);
    else if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new Error(`input '${inputName}' contains an unsupported entry type`);
  }
}

function start(run, inputs) {
  const environment = { ...process.env };
  delete environment.DIM_QEMU_EXTRA_INPUTS_JSON;
  environment.DIM_QEMU_SOURCE_ROOT = sourceRoot;
  environment.DIM_QEMU_INPUT_SNAPSHOTS_JSON = JSON.stringify(inputs);
  run.child = spawn("bash", [launcher, ...(run.state.mode === "probe" ? ["--probe"] : run.state.verbose ? ["--verbose"] : [])], {
    cwd: sourceRoot,
    env: environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const append = (chunk) => {
    run.output += String(chunk);
    if (run.output.length > 8 * 1024 * 1024) run.output = run.output.slice(-8 * 1024 * 1024);
    for (const listener of run.listeners) listener.write(chunk);
  };
  run.child.stdout.on("data", append);
  run.child.stderr.on("data", append);
  run.child.on("error", (error) => append(`failed to start QEMU verification: ${error.message}\n`));
  run.child.on("close", (exitCode, signal) => void finishRun(run, exitCode, signal));
}

async function finishRun(run, exitCode, signal) {
  run.state = {
    ...run.state,
    status: exitCode === 0 ? "success" : signal ? "cancelled" : "failure",
    exitCode: exitCode ?? undefined,
    signal: signal ?? undefined,
    completedAt: new Date().toISOString()
  };
  run.child = undefined;
  await removeSnapshots(run);
  if (activeRun === run) activeRun = undefined;
  for (const listener of run.listeners) listener.end();
  run.listeners.clear();
}

async function rejectRun(run) {
  await removeSnapshots(run);
  if (activeRun === run) activeRun = undefined;
  if (latestRun === run) latestRun = undefined;
  for (const listener of run.listeners) listener.end();
  run.listeners.clear();
}

async function removeSnapshots(run) {
  if (!run.snapshotRoot) return;
  const snapshotRoot = run.snapshotRoot;
  run.snapshotRoot = undefined;
  await rm(snapshotRoot, { recursive: true, force: true });
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
  const run = activeRun;
  if (run?.child) {
    const stopped = new Promise((resolve) => run.child.once("close", resolve));
    stopChild(run);
    await stopped;
  }
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

function stopChild(run) {
  if (!run.child?.pid) return;
  try { process.kill(-run.child.pid, "SIGTERM"); } catch {}
}
