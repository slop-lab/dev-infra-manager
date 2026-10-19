#!/usr/bin/env node
// @ts-check
import { constants } from "node:fs";
import { open, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseGuestConfiguration } from "./guest.mjs";
try {
  const endpoint = process.argv[2], entry = process.argv[3];
  if (!endpoint || !entry || process.argv.length !== 4) throw new Error("invalid tunnel installation arguments");
  const incoming = parseGuestConfiguration({ schemaVersion: 1, endpoint, tunnels: [JSON.parse(entry)] });
  const file = path.join(homedir(), ".config/dim/tunnels.json");
  let config = incoming;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 128 * 1024) throw new Error("existing tunnel configuration must be private and user owned");
      config = parseGuestConfiguration(JSON.parse(await handle.readFile("utf8")));
    } finally { await handle.close(); }
    if (config.endpoint !== endpoint) throw new Error("all attached tunnels must use the same relay endpoint");
    config.tunnels = config.tunnels.filter((tunnel) => tunnel.name !== incoming.tunnels[0]?.name);
    config.tunnels.push(...incoming.tunnels); parseGuestConfiguration(config);
  } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(config), { mode: 0o600, flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
