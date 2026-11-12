#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, unlink, link } from "node:fs/promises";
const help = "Usage: dim-ci request --request-id UUID [--ref REF] [--commit OID] [--tree OID] [--protected-ref REF]\n       dim-ci status|jobs --request-id UUID\n       dim-ci logs|artifacts --request-id UUID --job UUID\n       dim-ci download --request-id UUID --job UUID --artifact SHA256_ID --output FILE\nRun from the selected repository checkout. Logs show verified retained tails (64KiB default), or clearly labelled diagnostic prefixes. Use logs --stream stdout|stderr [--tail-bytes N] [--output NEW_FILE] for a full retained stream. Downloads require a new explicit destination and verify size and SHA-256 before writing.\nRetry the exact request with the same ID; changed candidates or stale policy require a new ID.\n";

try { await main(process.argv.slice(2)); }
catch (error) { console.error(`dim-ci: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }

/** @param {string[]} args */
async function main(args) {
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0] ?? "")) { process.stdout.write(help); return; }
  const [command, ...rest] = args;
  if (!["request", "status", "jobs", "logs", "artifacts", "download"].includes(command ?? "")) usage();
  /** @type {Map<string, string>} */ const flags = new Map();
  const allowed = command === "request" ? ["--request-id", "--ref", "--commit", "--tree", "--protected-ref"]
    : ["--request-id", ...(["logs", "artifacts", "download"].includes(command ?? "") ? ["--job"] : []), ...(command === "download" ? ["--artifact", "--output"] : []), ...(command === "logs" ? ["--stream", "--tail-bytes", "--output"] : [])];
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index], value = rest[index + 1];
    if (!name || !allowed.includes(name) || value === undefined || value.startsWith("--") || flags.has(name)) usage();
    flags.set(name, value);
  }
  const requestId = flags.get("--request-id");
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId)) usage();
  const job = flags.get("--job"), artifactId = flags.get("--artifact"), output = flags.get("--output");
  if (["logs", "artifacts", "download"].includes(command ?? "") && (typeof job !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(job))) usage();
  if (command === "download" && (typeof artifactId !== "string" || !/^[0-9a-f]{64}$/.test(artifactId) || typeof output !== "string" || !output || output.endsWith("/"))) usage();
  const stream = flags.get("--stream"), tailBytes = Number(flags.get("--tail-bytes") ?? 65536);
  if (command === "logs" && (stream !== undefined && !["stdout", "stderr"].includes(stream) || !Number.isSafeInteger(tailBytes) || tailBytes < 1 || tailBytes > 1024 * 1024 || output !== undefined && stream === undefined)) usage();
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
  const requestEndpoint = `${endpoint}/${requestId}`;
  if (command === "jobs" || command === "artifacts") {
    const suffix = command === "jobs" ? "/jobs" : `/jobs/${job}/${command}`;
    console.log(JSON.stringify(await requestJson({ method: "GET", url: `${requestEndpoint}${suffix}`, authorization: credential })));
    return;
  }
  if (command === "logs") {
    const base = `${requestEndpoint}/jobs/${job}`;
    /** @type {unknown} */ let manifest;
    try { manifest = await requestJson({ method: "GET", url: `${base}/artifacts`, authorization: credential }); }
    catch { manifest = undefined; }
    const retained = manifest && typeof manifest === "object" && "executionId" in manifest && manifest.executionId === job
      && "availability" in manifest && ["complete", "unavailable"].includes(String(manifest.availability)) && "artifacts" in manifest && Array.isArray(manifest.artifacts)
      ? /** @type {unknown[]} */ (manifest.artifacts) : undefined;
    const streams = stream === undefined ? ["stdout", "stderr"] : [stream];
    for (const channel of streams) {
      const raw = retained?.find((value) => value && typeof value === "object" && "name" in value && value.name === `logs/${channel}.log`);
      if (raw !== undefined) {
        const item = logArtifact(raw);
        if (item.bytes === 0) {
          await readArtifact(`${base}/artifacts/${item.id}`, credential, item, () => {});
          const diagnostic = await readDiagnosticLog(base, credential, channel);
          if (diagnostic.bytes.length > 0) {
            if (output !== undefined) throw new Error("empty retained log conflicts with nonempty diagnostics; run logs without --output to inspect the labelled diagnostic prefix");
            writeDiagnosticLog(channel, diagnostic, "empty");
            continue;
          }
        }
        if (output !== undefined) { await saveArtifact(`${base}/artifacts/${item.id}`, credential, item, output); console.log(JSON.stringify({ output, stream: channel, bytes: item.bytes, source: "retained-log", sha256: item.sha256 })); continue; }
        let tail = Buffer.alloc(0);
        await readArtifact(`${base}/artifacts/${item.id}`, credential, item, (chunk) => { tail = Buffer.concat([tail, chunk]).subarray(-tailBytes); });
        const destination = channel === "stderr" ? process.stderr : process.stdout;
        destination.write(`[DIM CI ${channel}: retained-log tail; collection=${manifest && typeof manifest === "object" && "availability" in manifest ? String(manifest.availability) : "unknown"}; ${tail.length}/${item.bytes} bytes; truncated=${item.bytes > tail.length}]\n`);
        destination.write(tail); if (tail.at(-1) !== 10) destination.write("\n");
      } else {
        if (output !== undefined) throw new Error("full retained log is unavailable; no output file was created");
        writeDiagnosticLog(channel, await readDiagnosticLog(base, credential, channel), "unavailable");
      }
    }
    return;
  }
  if (command === "download" && typeof artifactId === "string" && typeof output === "string") {
    const base = `${requestEndpoint}/jobs/${job}/artifacts`;
    const manifest = await requestJson({ method: "GET", url: base, authorization: credential });
    if (!manifest || typeof manifest !== "object" || !("executionId" in manifest) || manifest.executionId !== job
      || !("availability" in manifest) || !["complete", "unavailable"].includes(String(manifest.availability)) || !("artifacts" in manifest) || !Array.isArray(manifest.artifacts)) throw new Error("artifact manifest is unavailable");
    /** @type {unknown} */ const item = manifest.artifacts.find((entry) => entry && typeof entry === "object" && "id" in entry && entry.id === artifactId);
    if (!item || typeof item !== "object" || !("bytes" in item) || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 128 * 1024 * 1024
      || !("sha256" in item) || typeof item.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.sha256)) throw new Error("artifact metadata is invalid or exceeds the download limit");
    await saveArtifact(`${base}/${artifactId}`, credential, { bytes: item.bytes, sha256: item.sha256 }, output);
    console.log(JSON.stringify({ artifactId, bytes: item.bytes, sha256: item.sha256, output }));
    return;
  }
  usage();
}

/** @param {string} base @param {string} credential @param {string} channel */
async function readDiagnosticLog(base, credential, channel) {
  const value = await requestJson({ method: "GET", url: `${base}/logs`, authorization: credential });
  if (!value || typeof value !== "object" || !("result" in value) || !value.result || typeof value.result !== "object" || !("logs" in value.result)
    || !value.result.logs || typeof value.result.logs !== "object") throw new Error("no retained or diagnostic logs are available yet");
  /** @type {unknown} */ const log = Reflect.get(value.result.logs, channel);
  if (!log || typeof log !== "object" || !("base64" in log) || typeof log.base64 !== "string" || !("truncated" in log) || typeof log.truncated !== "boolean") throw new Error("diagnostic log response is invalid");
  const bytes = Buffer.from(log.base64, "base64");
  if (bytes.length > 64 * 1024 || bytes.toString("base64") !== log.base64) throw new Error("diagnostic log response exceeds its bound");
  /** @type {unknown} */ const completion = Reflect.get(value.result, "completion");
  const reason = completion && typeof completion === "object" && "code" in completion && typeof completion.code === "string"
    && /^[a-z0-9-]{1,128}$/.test(completion.code) ? `; reason=${completion.code}` : "";
  return { bytes, truncated: log.truncated, reason };
}

/** @param {string} channel @param {{bytes:Buffer,truncated:boolean,reason:string}} log @param {"empty"|"unavailable"} retained */
function writeDiagnosticLog(channel, log, retained) {
  const destination = channel === "stderr" ? process.stderr : process.stdout;
  destination.write(`[DIM CI ${channel}: diagnostic-prefix; retained log ${retained}; truncated=${log.truncated}${log.reason}]\n`);
  destination.write(log.bytes); if (log.bytes.at(-1) !== 10) destination.write("\n");
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

/** @param {unknown} value @returns {{id:string,bytes:number,sha256:string}} */
function logArtifact(value) {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id)
    || !("bytes" in value) || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 128 * 1024 * 1024
    || !("sha256" in value) || typeof value.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.sha256)) throw new Error("retained log metadata is invalid");
  return { id: value.id, bytes: value.bytes, sha256: value.sha256 };
}

/** @param {string} url @param {string} authorization @param {{bytes:number,sha256:string}} item @param {(chunk:Uint8Array)=>Promise<void>|void} consume */
async function readArtifact(url, authorization, item, consume) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(155_000), headers: { authorization } });
  if (!response.ok || !response.body || response.headers.get("content-type") !== "application/octet-stream") throw new Error(`artifact download failed (HTTP ${response.status})`);
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of response.body) { size += chunk.byteLength; if (size > item.bytes) throw new Error("artifact exceeds its declared size"); hash.update(chunk); await consume(chunk); }
  if (size !== item.bytes || `sha256:${hash.digest("hex")}` !== item.sha256) throw new Error("artifact integrity verification failed");
}

/** @param {string} url @param {string} authorization @param {{bytes:number,sha256:string}} item @param {string} output */
async function saveArtifact(url, authorization, item, output) {
  const stage = `${output}.dim-ci-${randomUUID()}`;
  const file = await open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const owned = await file.stat();
  try {
    await readArtifact(url, authorization, item, (chunk) => file.writeFile(chunk)); await file.sync();
    const current = await lstat(stage);
    if (current.dev !== owned.dev || current.ino !== owned.ino || current.nlink !== 1) throw new Error("artifact staging ownership changed");
    await link(stage, output);
  } finally {
    await file.close(); const current = await lstat(stage).catch(() => undefined);
    if (current?.dev === owned.dev && current.ino === owned.ino) await unlink(stage);
  }
}
