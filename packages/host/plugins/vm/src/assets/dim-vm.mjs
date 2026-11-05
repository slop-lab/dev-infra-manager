#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

/** @param {string[]} args */
async function main(args) {
  const [command, name, ...rest] = args;
  if (command === "--help" || command === "-h") {
    if (name !== undefined) throw new Error("usage: dim-vm --help");
    process.stdout.write("usage: dim-vm list|status|exec|push|pull|start|stop|console\n"); return;
  }
  if (command === "list") {
    if (name !== undefined) throw new Error("usage: dim-vm list");
    const child = spawn("dim-workspace", ["plugin", "vm", "list", "{}"], { stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); }); return;
  }
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) throw new Error("select a granted VM name");
  const credential = await privateJson(path.join(homedir(), ".config/dim/vms", `${name}.json`));
  if (!record(credential) || credential.schemaVersion !== 2 || typeof credential.endpoint !== "string" || typeof credential.token !== "string"
    || typeof credential.vmId !== "string" || typeof credential.vmName !== "string" || credential.vmName !== name
    || typeof credential.workspaceId !== "string" || typeof credential.grantId !== "string" || typeof credential.generation !== "number") throw new Error("invalid VM access credential");
  const headers = { authorization: `Bearer ${credential.token}`, "x-dim-vm-id": credential.vmId, "x-dim-vm-name": credential.vmName,
    "x-dim-workspace-id": credential.workspaceId, "x-dim-grant-id": credential.grantId, "x-dim-grant-generation": String(credential.generation) };
  const target = `${credential.endpoint}/v1/vms/${credential.vmId}`;
  if (command === "status") { if (rest.length) throw new Error("usage: dim-vm status NAME"); console.log(JSON.stringify(await json(target + "/status", headers))); return; }
  if (command === "start" || command === "stop") { if (rest.length) throw new Error(`usage: dim-vm ${command} NAME`); await request(target + `/lifecycle/${command}`, { method: "POST", headers }); return; }
  if (command === "console") { if (rest.length || typeof credential.consoleUrl !== "string") throw new Error("usage: dim-vm console NAME"); console.log(credential.consoleUrl); return; }
  if (command === "exec") {
    const separator = rest.indexOf("--"), commandArgs = separator < 0 ? rest : rest.slice(separator + 1);
    if (!commandArgs.length || separator > 0) throw new Error("usage: dim-vm exec NAME -- COMMAND...");
    const abort = new AbortController(), cancel = () => abort.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel); process.once("SIGHUP", cancel);
    try {
      const response = await streamRequest(target + "/exec", { method: "POST", headers: { ...headers,
        "x-dim-command": Buffer.from(JSON.stringify(commandArgs)).toString("base64url") }, body: process.stdin, signal: abort.signal });
      const reader = new FrameReader(response); for (;;) { const frame = await reader.next(); if (!frame) break;
        if (frame.channel === 1) process.stdout.write(frame.body); else if (frame.channel === 2) process.stderr.write(frame.body);
        else if (frame.channel === 3) process.exitCode = Number(frame.body.toString("utf8")); else throw new Error("invalid VM exec frame"); }
    } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); process.off("SIGHUP", cancel); }
    return;
  }
  if (command === "push" || command === "pull") {
    const recursive = rest.includes("--recursive"), overwrite = rest.includes("--overwrite"), operands = rest.filter((value) => !value.startsWith("--"));
    if (operands.length !== 2) throw new Error(`usage: dim-vm ${command} [--recursive] [--overwrite] NAME SOURCE DESTINATION`);
    const [source, destination] = operands, helper = path.join(homedir(), ".local/share/dim-vm/copy.cjs");
    if (!source || !destination) throw new Error("copy operands are required");
    if (command === "push") {
      const child = spawn(process.execPath, [helper, "send", source, recursive ? "1" : "0", overwrite ? "1" : "0", "dim-workspace-copy", "helper", randomUUID()], { stdio: ["ignore", "pipe", "inherit"] });
      if (!child.stdout) throw new Error("copy helper has no output");
      const completion = closed(child);
      try {
        const response = await streamRequest(copyUrl(target, "push", destination, recursive, overwrite), { method: "POST", headers, body: child.stdout });
        response.resume(); await once(response, "end"); process.exitCode = await completion; return;
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await completion.then(() => undefined, () => undefined); throw error;
      }
    }
    const response = await streamRequest(copyUrl(target, "pull", source, recursive, overwrite), { method: "POST", headers });
    const child = spawn(process.execPath, [helper, "receive", destination, recursive ? "1" : "0", overwrite ? "1" : "0", "dim-workspace-copy", "helper", randomUUID()], { stdio: ["pipe", "inherit", "inherit"] });
    if (!child.stdin) throw new Error("copy helper has no input"); for await (const chunk of response) if (!child.stdin.write(chunk)) await new Promise((resolve) => child.stdin.once("drain", resolve)); child.stdin.end(); process.exitCode = await closed(child); return;
  }
  throw new Error("usage: dim-vm list|status|exec|push|pull|start|stop|console");
}

/** @param {string} endpoint @param {RequestInit & {duplex?: "half"}} init */
async function request(endpoint, init) { const response = await fetch(endpoint, init); if (!response.ok) { const text = await response.text(); throw new Error(text || `VM request failed (${response.status})`); } return response; }
/** @param {string} endpoint @param {Record<string,string>} headers */
async function json(endpoint, headers) { return (await request(endpoint, { headers })).json(); }
/** @param {string} target @param {"push"|"pull"} direction @param {string} vmPath @param {boolean} recursive @param {boolean} overwrite */
function copyUrl(target, direction, vmPath, recursive, overwrite) { const url = new URL(target + "/copy"); url.searchParams.set("direction", direction); url.searchParams.set("path", vmPath); url.searchParams.set("recursive", recursive ? "1" : "0"); url.searchParams.set("overwrite", overwrite ? "1" : "0"); return url.href; }
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** @param {string} file */
async function privateJson(file) { const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try { const info = await handle.stat(); if (!info.isFile() || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > 64 * 1024) throw new Error("VM credential must be a private user-owned file"); return JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); } }
/** @param {import("node:child_process").ChildProcess} child */
function closed(child) { return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); }); }
/** @param {string} endpoint @param {{method:string,headers:Record<string,string>,body?:import("node:stream").Readable,signal?:AbortSignal}} options */
function streamRequest(endpoint, options) { return new Promise((resolve, reject) => {
  const outgoing = httpRequest(endpoint, { method: options.method, headers: options.headers, signal: options.signal }, (incoming) => {
    if ((incoming.statusCode ?? 500) >= 200 && (incoming.statusCode ?? 500) < 300) resolve(incoming);
    else {
      /** @type {Buffer[]} */ const chunks = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.once("end", () => reject(new Error(Buffer.concat(chunks).toString("utf8") || `VM request failed (${incoming.statusCode})`)));
    }
  });
  outgoing.once("error", reject); if (options.body) options.body.pipe(outgoing); else outgoing.end();
}); }
class FrameReader {
  /** @param {AsyncIterable<Uint8Array|string>} stream */
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); }
  /** @param {number} length @returns {Promise<Buffer|undefined>} */
  async take(length) { while (this.buffer.length < length) { const next = await this.iterator.next(); if (next.done) return; this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]); } const value = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length); return value; }
  async next() { const header = await this.take(5); if (!header) return; const body = await this.take(header.readUInt32BE(1)); if (!body) throw new Error("truncated VM exec frame"); return { channel: header.readUInt8(0), body }; }
}

try { await main(process.argv.slice(2)); }
catch (error) { process.stderr.write(`dim-vm: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
