#!/usr/bin/env node
// @ts-check
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

try {
  const patterns = [...new Set(process.argv.slice(2))];
  if (!patterns.length || patterns.some(pattern => !pattern.trim() || /[\r\n\0]/.test(pattern))) {
    throw new Error("usage: dim-git-ignore PATTERN [PATTERN ...] (one Git ignore pattern per argument)");
  }
  const configured = spawnSync("git", ["config", "--global", "--null", "--path", "--get", "core.excludesFile"], { encoding: "utf8" });
  if (configured.error) throw configured.error;
  if (configured.status !== 0 && configured.status !== 1) throw new Error("cannot read Git global ignore configuration");
  const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  const ignore = configured.status === 0 ? configured.stdout.replace(/\0$/, "") : path.join(configHome, "git", "ignore");
  if (!path.isAbsolute(ignore)) throw new Error("select an absolute Git core.excludesFile path");

  mkdirSync(path.dirname(ignore), { recursive: true });
  const fd = openSync(ignore, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NONBLOCK, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.()) throw new Error("Git global ignore must be a regular file owned by this user");
    // The child locks this open file description, which the parent holds until close.
    execFileSync("flock", ["-x", "3"], { stdio: ["ignore", "ignore", "inherit", fd] });
    const source = readFileSync(fd, "utf8");
    const lines = new Set(source.split(/\r?\n/));
    const missing = patterns.filter(pattern => !lines.has(pattern)
      && !(/^\.[a-zA-Z0-9_-]+\/$/.test(pattern) && lines.has(pattern.slice(0, -1))));
    if (missing.length) appendFileSync(fd, `${source && !source.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  } finally { closeSync(fd); }
} catch (error) {
  console.error(`dim-git-ignore: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
