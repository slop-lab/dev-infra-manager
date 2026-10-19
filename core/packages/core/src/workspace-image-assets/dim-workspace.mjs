#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const configuration = path.join(homedir(), ".config/dim/workspace.json");
const servicesRoot = path.join(homedir(), ".local/state/dim/services");
const sessionFile = path.join(homedir(), ".local/state/dim/session.json");

try { await main(process.argv.slice(2)); }
catch (error) { console.error(`dim-workspace: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }

/** @param {string[]} args */
async function main(args) {
  const [command, ...rest] = args;
  if (command === "service") { await services(rest); return; }
  if (command === "session") { await session(rest); return; }
  if (command === "resources" || command === "nproc") {
    if (rest.some((arg) => arg !== "--json") || rest.length > 1) throw new Error("usage: dim-workspace resources [--json]");
    const value = await request("GET", "/v1/resources");
    if (!record(value) || typeof value.cpuCount !== "string" || typeof value.memory !== "string" || typeof value.pidsLimit !== "string") {
      throw new Error("workspace API returned invalid resources");
    }
    if (command === "nproc") {
      const cpu = Number(value.cpuCount);
      if (value.cpuCount !== "unlimited" && (!Number.isFinite(cpu) || cpu <= 0)) throw new Error("invalid CPU allocation");
      console.log(value.cpuCount === "unlimited" ? await localCpuCount() : Math.max(1, Math.floor(cpu)));
    } else console.log(JSON.stringify(value));
    return;
  }
  if (command === "restart" || command === "recreate") {
    if (rest.length) throw new Error(`usage: dim-workspace ${command}`);
    console.log(JSON.stringify(await request("POST", `/v1/${command}`, {})));
    return;
  }
  if (command === "urls") {
    if (rest.length && (rest.length !== 1 || rest[0] !== "--json")) throw new Error("usage: dim-workspace urls [--json]");
    console.log(JSON.stringify(await request("GET", "/v1/urls"))); return;
  }
  if (command === "expose") {
    const flags = options(rest, ["--name", "--port", "--ingress"]);
    const port = Number(flags["--port"]);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !flags["--name"] || !flags["--ingress"]) {
      throw new Error("usage: dim-workspace expose --name NAME --port PORT --ingress NAME");
    }
    console.log(JSON.stringify(await request("POST", "/v1/expose", { name: flags["--name"], port, ingress: flags["--ingress"] })));
    return;
  }
  throw new Error("usage: dim-workspace resources|nproc|restart|recreate|expose|urls|session|service");
}

/** @param {string[]} args @param {readonly string[]} allowed */
function options(args, allowed) {
  /** @type {Record<string, string>} */
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (key === undefined || !allowed.includes(key) || value === undefined || result[key] !== undefined) throw new Error("invalid or repeated option");
    result[key] = value;
  }
  return result;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** @param {string} file */
async function privateJson(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1 || metadata.size > 64 * 1024) {
      throw new Error(`expected a private user-owned regular file: ${file}`);
    }
    /** @type {unknown} */
    const value = JSON.parse(await handle.readFile("utf8"));
    return value;
  } finally { await handle.close(); }
}

/** @param {"GET" | "POST"} method @param {string} pathname @param {Record<string, unknown>} [body] */
async function request(method, pathname, body) {
  const config = await privateJson(configuration);
  if (!record(config) || typeof config.endpoint !== "string" || typeof config.token !== "string" || !config.token
    || typeof config.workspaceId !== "string" || !config.workspaceId) throw new Error("invalid workspace connection");
  const endpoint = new URL(config.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("workspace endpoint must be an HTTP(S) origin");
  }
  const response = await fetch(new URL(pathname, endpoint), {
    method, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000), redirect: "error"
  });
  const chunks = []; let length = 0;
  if (response.body) for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error("workspace API response is too large");
    chunks.push(chunk);
  }
  /** @type {unknown} */
  const result = response.status === 204 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) {
    const detail = record(result) && typeof result.error === "string" ? `: ${result.error}` : "";
    throw new Error(`workspace API request failed (${response.status})${detail}`);
  }
  return result;
}

async function localCpuCount() {
  const affinity = Math.max(1, availableParallelism());
  try {
    const [quota, period] = (await readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim().split(/\s+/);
    const count = Number(quota) / Number(period);
    if (Number.isFinite(count) && count > 0) return Math.max(1, Math.floor(Math.min(affinity, count)));
  } catch { /* Hosts without cgroup v2 retain the process affinity limit. */ }
  return affinity;
}

/** @param {string[]} args */
async function session(args) {
  const [command, ...rest] = args;
  if (command === "clear") {
    if (rest.length) throw new Error("usage: dim-workspace session clear");
    await rm(sessionFile, { force: true }); return;
  }
  if (command === "register") {
    const argv = rest[0] === "--" ? rest.slice(1) : rest;
    if (!argv.length || argv.length > 256 || argv.some((arg) => arg.includes("\0")) || !argv[0]) throw new Error("register requires an executable and arguments after --");
    const saved = { schemaVersion: 1, argv, cwd: process.cwd() };
    const data = JSON.stringify(saved);
    if (Buffer.byteLength(data) > 64 * 1024) throw new Error("session command is too large");
    await mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
    const temporary = `${sessionFile}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${data}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, sessionFile); }
    finally { await rm(temporary, { force: true }); }
    console.log(JSON.stringify({ registered: true })); return;
  }
  if (command !== "resume" || rest.length) throw new Error("usage: dim-workspace session register -- COMMAND... | resume | clear");
  let saved;
  try { saved = await privateJson(sessionFile); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  if (!record(saved) || saved.schemaVersion !== 1 || !Array.isArray(saved.argv) || !saved.argv.length
    || !saved.argv.every((arg) => typeof arg === "string" && !arg.includes("\0")) || !saved.argv[0]
    || typeof saved.cwd !== "string" || !path.isAbsolute(saved.cwd)) throw new Error("invalid saved session");
  const child = spawn(saved.argv[0], saved.argv.slice(1), { cwd: saved.cwd, stdio: "inherit" });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

/** @param {string[]} args */
async function services(args) {
  const [command, ...rest] = args;
  if (command === "register") {
    if (rest[0] !== "--name" || !serviceName(rest[1]) || rest[2] !== "--" || !rest[3]) throw new Error("usage: dim-workspace service register --name NAME -- COMMAND...");
    const name = rest[1], argv = rest.slice(3);
    if (argv.length > 256 || argv.some((arg) => arg.includes("\0"))) throw new Error("invalid service command");
    const saved = { schemaVersion: 1, argv, cwd: process.cwd() }, data = JSON.stringify(saved);
    if (Buffer.byteLength(data) > 64 * 1024) throw new Error("service command is too large");
    await mkdir(servicesRoot, { recursive: true, mode: 0o700 });
    const file = serviceFile(name), temporary = `${file}.${randomUUID()}.tmp`;
    const previous = await readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    if (previous.trim() !== data) await stopService(name);
    try { await writeFile(temporary, `${data}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    console.log(JSON.stringify({ name, registered: true })); return;
  }
  if (command === "remove") {
    if (rest.length !== 1 || !serviceName(rest[0])) throw new Error("usage: dim-workspace service remove NAME");
    await rm(serviceFile(rest[0]), { force: true }); await stopService(rest[0]); return;
  }
  if (command === "__run") {
    if (rest.length !== 1 || !serviceName(rest[0])) throw new Error("invalid service supervisor name");
    await superviseService(rest[0]); return;
  }
  if ((command !== "resume" && command !== "list") || rest.length) throw new Error("usage: dim-workspace service register|resume|list|remove");
  const names = await readdir(servicesRoot).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const entries = names.filter((name) => name.endsWith(".json") && serviceName(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort();
  if (command === "list") {
    const result = [];
    for (const name of entries) result.push({ name, running: await serviceAlive(name) });
    console.log(JSON.stringify(result)); return;
  }
  for (const name of entries) {
    if (await serviceAlive(name)) continue;
    const log = await open(path.join(servicesRoot, `${name}.log`), "a", 0o600);
    try {
      const child = spawn(process.execPath, [process.argv[1] ?? "", "service", "__run", name], { detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"] });
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("message", () => { child.disconnect(); child.unref(); resolve(undefined); });
        child.once("exit", (code) => { if (code) reject(new Error(`service '${name}' failed; inspect ${name}.log`)); else resolve(undefined); });
      });
    } finally { await log.close(); }
  }
}

/** @param {unknown} value @returns {value is string} */
function serviceName(value) { return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value); }
/** @param {string} name */
function serviceFile(name) { return path.join(servicesRoot, `${name}.json`); }
/** @param {string} name */
function serviceLock(name) { return path.join(servicesRoot, `${name}.lock`); }
/** @param {number} pid */
async function processIdentity(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8"), fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[0] === "Z" ? undefined : fields[19];
  } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
/** @param {string} name */
async function serviceOwner(name) {
  try {
    const value = await privateJson(path.join(serviceLock(name), "owner.json"));
    if (!record(value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid < 1
      || typeof value.ticks !== "string" || typeof value.boot !== "string" || typeof value.nonce !== "string"
      || typeof value.child !== "number" || typeof value.childTicks !== "string") throw new Error("invalid service owner");
    return { pid: value.pid, ticks: value.ticks, boot: value.boot, nonce: value.nonce, child: value.child, childTicks: value.childTicks };
  } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
/** @param {string} name */
async function serviceAlive(name) {
  const owner = await serviceOwner(name);
  return owner !== undefined && owner.boot === (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
    && owner.ticks === await processIdentity(owner.pid);
}
/** @param {string} name */
async function stopService(name) {
  const owner = await serviceOwner(name);
  if (!owner || !await serviceAlive(name)) return;
  process.kill(owner.pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (await serviceAlive(name) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
  if (await serviceAlive(name)) {
    if (owner.childTicks === await processIdentity(owner.child)) process.kill(owner.child, "SIGKILL");
    if (owner.ticks === await processIdentity(owner.pid)) process.kill(owner.pid, "SIGKILL");
  }
}
/** @param {string} name */
async function superviseService(name) {
  const lock = serviceLock(name), nonce = randomUUID();
  const deadline = Date.now() + 5000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    if (await serviceAlive(name)) { process.send?.({ ready: true }); return; }
    const owner = await serviceOwner(name);
    // A fresh lock without an owner may still be publishing its identity.
    const info = await stat(lock).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (owner || (info && Date.now() - info.mtimeMs > 30_000)) {
      await rm(lock, { recursive: true, force: true }); continue;
    }
    if (Date.now() > deadline) throw new Error(`service '${name}' startup is still in progress`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const ownerFile = path.join(lock, "owner.json");
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const ticks = await processIdentity(process.pid);
  if (!ticks) throw new Error("cannot identify service supervisor");
  const identity = { pid: process.pid, ticks, boot, nonce, child: 0, childTicks: "" };
  try {
    const firstOwner = `${ownerFile}.${nonce}.tmp`;
    await writeFile(firstOwner, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
    await rename(firstOwner, ownerFile);
    const saved = await privateJson(serviceFile(name));
    if (!record(saved) || saved.schemaVersion !== 1 || !Array.isArray(saved.argv) || !saved.argv.length
      || !saved.argv.every((arg) => typeof arg === "string" && !arg.includes("\0")) || !saved.argv[0]
      || typeof saved.cwd !== "string" || !path.isAbsolute(saved.cwd)) throw new Error("invalid registered service");
    const child = spawn(saved.argv[0], saved.argv.slice(1), { cwd: saved.cwd, stdio: ["ignore", "inherit", "inherit"] });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 143)); });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    try {
      await new Promise((resolve, reject) => { child.once("spawn", () => resolve(undefined)); child.once("error", reject); });
      identity.child = child.pid ?? 0;
      identity.childTicks = identity.child ? await processIdentity(identity.child) ?? "" : "";
      const temporary = `${ownerFile}.${nonce}.tmp`;
      await writeFile(temporary, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
      await rename(temporary, ownerFile);
      process.send?.({ ready: true });
      const code = await closed;
      if (typeof code !== "number") throw new Error("invalid service exit code");
      process.exitCode = code;
    } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
  } finally {
    const owner = await serviceOwner(name);
    if (owner?.nonce === nonce) await rm(lock, { recursive: true, force: true });
  }
}
