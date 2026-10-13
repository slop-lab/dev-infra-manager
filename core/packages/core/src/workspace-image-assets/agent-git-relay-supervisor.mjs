import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

const START_TIMEOUT_MS = 5_000;
const stateDirectory = process.env.DIM_AGENT_GIT_STATE_DIR ?? "/run/dim/agent-git-relay";
const ownerPath = join(stateDirectory, "owner.json");
export const phasePath = join(stateDirectory, "phase");
const lockPath = join(stateDirectory, "ensure.lock");
const lockGuardPath = join(stateDirectory, "ensure.guard");
const phases = ["creating", "setting-up", "ready", "stopped", "setup-error", "error", "discarding"];

export async function prepareStateDirectory() {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
}

export async function ensureRelay(config, scriptPath) {
  await prepareStateDirectory();
  const releaseLock = await acquireLock(config.hash);
  try {
    const existing = await readOwner();
    if (existing && await ownedProcess(existing, scriptPath)) {
      if (existing.configHash === config.hash && existing.host === config.host && existing.port === config.port
        && await healthy(existing)) {
        await writePhase(initialPhase());
        process.stdout.write(`${JSON.stringify(attestation(existing))}\n`);
        return;
      }
      await terminate(existing, scriptPath);
    }
    await rm(ownerPath, { force: true });
    await writePhase(initialPhase());
    const ownerId = randomBytes(32).toString("base64url");
    const child = spawn(process.execPath, [scriptPath, "serve"], {
      detached: true,
      env: { ...process.env, DIM_AGENT_GIT_OWNER_ID: ownerId, DIM_AGENT_GIT_CONFIG_HASH: config.hash },
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    await childReady(child);
    child.unref();
    const owner = await readOwner();
    if (owner?.ownerId !== ownerId || !await healthy(owner)) throw new RelayError("agent Git relay did not become ready");
    if (!await ownedProcess(owner, scriptPath)) throw new RelayError("agent Git relay process ownership is invalid");
    process.stdout.write(`${JSON.stringify(attestation(owner))}\n`);
  } finally {
    await releaseLock();
  }
}

export async function publishOwner(input) {
  const owner = { schemaVersion: 1, ...input, pid: process.pid, processStart: await processStart(process.pid) };
  await atomicWrite(ownerPath, `${JSON.stringify(owner)}\n`);
  return attestation(owner);
}

export async function setRelayPhase(value, scriptPath) {
  if (!phases.includes(value)) throw new RelayError("invalid workspace phase");
  const owner = await readOwner();
  if (!owner || !await ownedProcess(owner, scriptPath)) throw new RelayError("owned agent Git relay is unavailable");
  await writePhase(value);
}

export async function stopRelay(scriptPath) {
  const owner = await readOwner();
  if (!owner || !await ownedProcess(owner, scriptPath)) return;
  await terminate(owner, scriptPath);
  await rm(ownerPath, { force: true });
}

export function initialPhase() {
  const phase = process.env.DIM_AGENT_GIT_INITIAL_PHASE ?? "setting-up";
  if (!phases.includes(phase)) throw new RelayError("invalid initial workspace phase");
  return phase;
}

export async function writePhase(phase) { await atomicWrite(phasePath, `${phase}\n`); }

async function acquireLock(configHash) {
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    processStart: await processStart(process.pid),
    nonce: randomBytes(32).toString("base64url"),
    configHash
  };
  let diagnostic = "agent Git relay ownership lock is busy";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const guard = await tryKernelGuard();
    if (guard) {
      let acquired = false;
      try {
        const existing = await readLockOwner();
        const status = existing.kind === "valid" ? await probeProcess(existing.owner) : existing.kind;
        if (status === "missing" || status === "dead" || status === "reused") {
          await rm(lockPath, { recursive: true, force: true });
          await mkdir(lockPath, { mode: 0o700 });
          await atomicWrite(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
          acquired = true;
          return releaseLock(owner, guard);
        }
        diagnostic = status === "live"
          ? `agent Git relay ownership lock is held by live process instance ${existing.owner.pid}`
          : "agent Git relay ownership lock cannot be safely verified";
      } finally {
        if (!acquired) await guard.release();
      }
    }
    await delay(25);
  }
  throw new RelayError(diagnostic);
}

async function tryKernelGuard() {
  const child = spawn("flock", ["-n", lockGuardPath, "sh", "-c", "printf ready; exec cat >/dev/null"], {
    stdio: ["pipe", "pipe", "ignore"]
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    child.stdout.once("data", () => {
      settled = true;
      resolve({ child, release: () => releaseKernelGuard(child) });
    });
    child.once("error", reject);
    child.once("exit", () => {
      if (!settled) resolve(undefined);
    });
  });
}

async function releaseKernelGuard(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
}

async function releaseLock(owner, guard) {
  let active = true;
  return async () => {
    if (!active) return;
    active = false;
    try {
      const current = await readLockOwner();
      if (current.kind !== "valid" || current.owner.nonce !== owner.nonce) {
        throw new RelayError("agent Git relay ownership lock changed before release");
      }
      await rm(lockPath, { recursive: true });
    } finally {
      await guard.release();
    }
  };
}

async function readLockOwner() {
  try {
    const metadata = await lstat(lockPath);
    if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) {
      return { kind: "foreign" };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    return { kind: "unknown" };
  }
  try {
    const value = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.processStart !== "string" || !/^\d+$/.test(value.processStart)
      || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce)
      || typeof value.configHash !== "string" || !/^[0-9a-f]{64}$/.test(value.configHash)) {
      return await readLegacyLockOwner();
    }
    return { kind: "valid", owner: value };
  } catch {
    return readLegacyLockOwner();
  }
}

async function readLegacyLockOwner() {
  try {
    const raw = (await readFile(join(lockPath, "pid"), "utf8")).trim();
    if (!/^[1-9]\d*$/.test(raw)) return { kind: "malformed" };
    const pid = Number(raw);
    try {
      await readFile(`/proc/${pid}/stat`, "utf8");
      return { kind: "unknown" };
    } catch (error) {
      return error?.code === "ENOENT" ? { kind: "dead" } : { kind: "unknown" };
    }
  } catch {
    return { kind: "malformed" };
  }
}

async function probeProcess(owner) {
  try {
    return await processStart(owner.pid) === owner.processStart ? "live" : "reused";
  } catch (error) {
    return error?.code === "ENOENT" ? "dead" : "unknown";
  }
}

async function childReady(child) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new RelayError("agent Git relay did not become ready")), START_TIMEOUT_MS);
    child.once("message", () => { clearTimeout(timeout); resolve(); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new RelayError(`agent Git relay exited before readiness (${String(code)})`));
    });
  });
}

async function readOwner() {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8"));
    if (value?.schemaVersion !== 1 || typeof value.ownerId !== "string" || typeof value.configHash !== "string"
      || !Number.isSafeInteger(value.pid) || typeof value.processStart !== "string" || typeof value.host !== "string"
      || !Number.isSafeInteger(value.port)) return undefined;
    return value;
  } catch { return undefined; }
}

async function ownedProcess(owner, scriptPath) {
  try {
    if (await processStart(owner.pid) !== owner.processStart) return false;
    const argv = await readFile(`/proc/${owner.pid}/cmdline`, "utf8");
    return argv.includes(scriptPath) && argv.includes("serve");
  } catch { return false; }
}

async function processStart(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

async function healthy(owner) {
  return new Promise((resolve) => {
    const request = http.request({ host: owner.host, port: owner.port, path: "/.dim/health",
      headers: { "x-dim-relay-owner": owner.ownerId }, signal: AbortSignal.timeout(500) },
    (response) => { response.resume(); response.once("end", () => resolve(response.statusCode === 200)); });
    request.once("error", () => resolve(false));
    request.end();
  });
}

async function terminate(owner, scriptPath) {
  process.kill(owner.pid, "SIGTERM");
  for (let attempt = 0; attempt < 100 && await ownedProcess(owner, scriptPath); attempt += 1) await delay(20);
  if (await ownedProcess(owner, scriptPath)) throw new RelayError("owned agent Git relay did not stop");
}

function attestation(owner) {
  return { schemaVersion: 1, status: "ready", pid: owner.pid, processStart: owner.processStart,
    configHash: owner.configHash, host: owner.host, port: owner.port };
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  await handle.writeFile(contents);
  await handle.close();
  await rename(temporary, path);
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
export class RelayError extends Error { name = "RelayError"; }
