#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
const help = "Usage: dim-ci request --request-id UUID [--ref REF] [--commit OID] [--tree OID] [--protected-ref REF]\n       dim-ci status --request-id UUID\nRetry the exact request with the same ID; changed candidates or stale policy require a new ID.\n";

try { await main(process.argv.slice(2)); }
catch (error) { console.error(`dim-ci: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }

/** @param {string[]} args */
async function main(args) {
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0] ?? "")) { process.stdout.write(help); return; }
  const [command, ...rest] = args;
  if (command !== "request" && command !== "status") usage();
  /** @type {Map<string, string>} */ const flags = new Map();
  const allowed = command === "status" ? ["--request-id"] : ["--request-id", "--ref", "--commit", "--tree", "--protected-ref"];
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index], value = rest[index + 1];
    if (!name || !allowed.includes(name) || value === undefined || value.startsWith("--") || flags.has(name)) usage();
    flags.set(name, value);
  }
  const requestId = flags.get("--request-id");
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId)) usage();
  const origin = await git(["remote", "get-url", "origin"]);
  const match = /^(http:\/\/127\.0\.0\.1:19420\/services\/native-git\/v1\/projects\/([a-z0-9-]+)\/repositories\/([a-z0-9][a-z0-9-]*))\.git$/.exec(origin);
  const base = match?.[1];
  if (!base) throw new Error("origin is not this workspace's scoped Native Git repository");
  const credential = await credentialFor(origin);
  const endpoint = `${base}/workspace-ci/requests`;
  if (command === "request") {
    const candidateRef = flags.get("--ref") ?? await git(["symbolic-ref", "-q", "HEAD"]);
    const candidateCommit = flags.get("--commit") ?? await git(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (typeof candidateCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidateCommit)) throw new Error("candidate commit must be an exact object ID");
    const candidateTree = flags.get("--tree") ?? await git(["rev-parse", "--verify", `${candidateCommit}^{tree}`]);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidateTree)) throw new Error("candidate tree must be an exact object ID");
    const protectedRef = flags.get("--protected-ref");
    console.log(JSON.stringify(await requestJson({ method: "POST", url: endpoint, authorization: credential, body: {
      schemaVersion: 1, requestId, candidateRef, candidateCommit, candidateTree,
      ...(protectedRef === undefined ? {} : { protectedRef }),
    } })));
    return;
  }
  if (command === "status" && flags.size === 1) {
    console.log(JSON.stringify(await requestJson({ method: "GET", url: `${endpoint}/${requestId}`, authorization: credential })));
    return;
  }
  usage();
}

/** @param {string[]} args */
async function git(args) {
  return gitOutput(args);
}

/** @param {string[]} args @param {string} [input] */
async function gitOutput(args, input) {
  const child = spawn("git", args, { detached: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, stdio: ["pipe", "pipe", "ignore"] });
  const stop = () => { if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } } };
  const timeout = setTimeout(stop, 10_000);
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  child.stdin.end(input);
  /** @type {Buffer[]} */
  const stdout = [];
  let bytes = 0;
  child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 64 * 1024) stdout.push(Buffer.from(chunk)); else stop(); });
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timeout); process.off("SIGTERM", stop); process.off("SIGINT", stop); }
  if (code !== 0 || bytes > 64 * 1024) throw new Error("bounded Git metadata lookup failed; inspect this repository and its scoped credential helper");
  return Buffer.concat(stdout).toString("utf8").trim();
}

/** @param {string} origin */
async function credentialFor(origin) {
  const source = await gitOutput(["credential", "fill"], `url=${origin}\n\n`);
  const values = new Map(source.split("\n").flatMap((line) => {
    const separator = line.indexOf("="); return separator < 1 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
  }));
  const username = values.get("username"), password = values.get("password");
  if (username !== "dim" || typeof password !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error("scoped Native Git credential is unavailable");
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** @param {{method: "GET" | "POST", url: string, authorization: string, body?: unknown}} input */
async function requestJson(input) {
  const { method, url, authorization, body } = input;
  const response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(155_000),
    headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.body) throw new Error("workspace CI response is missing");
  /** @type {Uint8Array[]} */ const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.byteLength; if (size > 512 * 1024) throw new Error("workspace CI response exceeds the size limit"); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  /** @type {unknown} */
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`workspace CI returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(`workspace CI request failed (HTTP ${response.status}); ${value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240) : "inspect the current candidate and policy"}`);
  return value;
}

/** @returns {never} */
function usage() { throw new Error(help); }
