#!/usr/bin/env node
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readOmoTeamMetadata } from "../../tests/scenarios/selected-host/omoMetadataReader.ts";

const help = "Usage: node scripts/checks/omo-team-metadata.ts [--base-dir ABSOLUTE_OMO_DIR] [--max-runs N] [--max-members N] [--deadline-ms N]\nRead-only optional OMO runtime membership adapter; emits sanitized metadata only, with no credential resolver or model configuration access.\n";
async function main(): Promise<void> {
  const values = process.argv.slice(2);
  if (values.length === 1 && ["--help", "-h"].includes(values[0] ?? "")) { process.stdout.write(help); return; }
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index], value = values[index + 1];
    if (!name || !["--base-dir", "--max-runs", "--max-members", "--deadline-ms"].includes(name) || value === undefined || value.startsWith("--") || options.has(name)) throw new Error("invalid metadata adapter arguments; use --help");
    options.set(name, value);
  }
  const baseDirectory = options.get("--base-dir") ?? join(homedir(), ".omo");
  if (!isAbsolute(baseDirectory)) throw new Error("--base-dir must be absolute");
  const bounded = (name: string, fallback: number, maximum: number) => {
    const value = Number(options.get(name) ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("metadata adapter bounds are invalid");
    return value;
  };
  const result = await readOmoTeamMetadata({ baseDirectory, maxRuns: bounded("--max-runs", 16, 200), maxMembers: bounded("--max-members", 100, 200), deadlineMs: bounded("--deadline-ms", 5000, 30_000) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
try { await main(); }
catch { process.stderr.write("OMO metadata inspection unavailable; no private data was printed (use --help for arguments)\n"); process.exitCode = 2; }
