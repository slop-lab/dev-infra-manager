#!/usr/bin/env node
// @ts-check
import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat, lstat, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    const runtime = path.join(home, ".local/share/dim-agent-tools/opencode-runtime.bash");
    const environment = JSON.parse(execFileSync("bash", [runtime], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
    if (!environment || typeof environment !== "object" || Array.isArray(environment) || Object.entries(environment).some(([key, value]) => key !== "LD_PRELOAD" || typeof value !== "string")) throw new Error("invalid OpenCode runtime environment");
    Object.assign(process.env, environment);
    const root = process.env.DIM_WORKSPACE_TMPDIR ?? path.join(home, ".local/tmp");
    if (!path.isAbsolute(root)) throw new Error("DIM_WORKSPACE_TMPDIR must be absolute");
    const temporary = path.join(root, "opencode");
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    process.env.TMPDIR = temporary;
    const npmCache = process.env.NPM_CONFIG_CACHE ?? process.env.npm_config_cache
      ?? path.join(home, ".local/share/workspace-user-setup/cache");
    if (!path.isAbsolute(npmCache)) throw new Error("npm cache must be an absolute user-owned directory");
    await mkdir(npmCache, { recursive: true, mode: 0o700 });
    const cacheInfo = await lstat(npmCache);
    if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink() || cacheInfo.uid !== process.getuid?.()) {
      throw new Error("npm cache must be an absolute user-owned directory without a symlink");
    }
    await chmod(npmCache, 0o700);
    process.env.NPM_CONFIG_CACHE = npmCache;
    process.env.npm_config_cache = npmCache;
    const hookFile = path.join(home, ".config/dim/opencode-launch.js");
    let hookInfo;
    try { hookInfo = await lstat(hookFile); }
    catch (error) { if (!(record(error) && error.code === "ENOENT")) throw error; }
    if (hookInfo !== undefined) {
      if (!hookInfo.isFile() || hookInfo.isSymbolicLink() || hookInfo.uid !== process.getuid?.()) throw new Error("OpenCode launch hook must be an owned regular file");
      /** @type {unknown} */
      const module = await import(pathToFileURL(hookFile).href);
      if (!record(module) || typeof module.prepareOpenCode !== "function") throw new Error("invalid OpenCode launch hook");
      /** @type {unknown} */
      const overrides = await module.prepareOpenCode();
      if (!record(overrides)) throw new Error("invalid OpenCode launch environment");
      for (const [key, value] of Object.entries(overrides)) {
        if (!["OPENCODE_CONFIG_CONTENT", "OMO_PROFILE"].includes(key) || typeof value !== "string") throw new Error("unsupported OpenCode launch environment");
        process.env[key] = value;
      }
    }
  }
  if (tool === "opencode" && !args.includes("--version") && !args.includes("--help")) {
    execFileSync(process.execPath, [path.join(home, ".local/share/dim-agent-tools/omo-model-availability.mjs"), "--refresh", executable], { stdio: ["ignore", "ignore", "inherit"] });
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
