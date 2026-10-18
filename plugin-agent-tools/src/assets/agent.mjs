#!/usr/bin/env node
// @ts-check
import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

try { await main(); }
catch (error) { console.error(`dim-agent: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }

async function main() {
  const [tool, ...args] = process.argv.slice(2);
  if (tool !== "codex" && tool !== "opencode") throw new Error("usage: dim-agent codex|opencode [--resume-on-restart | --resume] [ARGS...]");
  const home = await realpath(homedir());
  const file = path.join(home, ".local/state/dim-tools", `${tool}.json`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let manifest;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024) throw new Error("installed tool manifest must be private");
    /** @type {unknown} */
    const value = JSON.parse(await handle.readFile("utf8")); manifest = value;
  } finally { await handle.close(); }
  const version = tool === "codex" ? "0.156.1" : "1.18.31";
  const executable = path.join(home, ".local/bin", tool);
  if (!record(manifest) || manifest.tool !== tool || manifest.version !== version || manifest.executable !== executable) {
    throw new Error("installed tool manifest is missing or incompatible; run dim tools setup again");
  }
  const target = await realpath(executable), relative = path.relative(home, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(target)).isFile()) {
    throw new Error("tool executable must remain inside its user's home");
  }
  const register = args[0] === "--resume-on-restart";
  if (register) {
    args.shift();
    execFileSync("dim-workspace", ["session", "register", "--", process.execPath, fileURLToPath(import.meta.url), tool, "--resume"], { stdio: ["ignore", "ignore", "inherit"] });
  }
  if (tool === "opencode") {
    const root = process.env.DIM_WORKSPACE_TMPDIR ?? path.join(home, ".local/tmp");
    if (!path.isAbsolute(root)) throw new Error("DIM_WORKSPACE_TMPDIR must be absolute");
    const temporary = path.join(root, "opencode");
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    process.env.TMPDIR = temporary;
  }
  const resume = args[0] === "--resume";
  if (resume) args.shift();
  const continuation = "Continue the interrupted task from the saved session. Re-read workspace state before changing files.";
  const command = !resume ? args : tool === "codex" ? ["exec", "resume", "--last", ...args, continuation]
    : ["run", "--continue", ...args, continuation];
  const child = spawn(executable, command, { stdio: "inherit", env: process.env });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
