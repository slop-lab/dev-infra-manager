#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { boundedMonitorJson, inspectMonitorTargets, MonitorInputError, parseMonitorCredentials, parseMonitorTargets } from "../../tests/scenarios/selected-host/monitorCommand.ts";

const help = "Usage: node scripts/checks/opencode-task-monitor.ts --targets ABSOLUTE_METADATA_JSON --target NAME [--target NAME...] --credentials-stdin [--json]\nRead-only OpenCode/optional OMO task inspection. Target metadata contains no credentials; stdin supplies in-memory server credentials. No DIM, SSH, Docker, setup or restart command is invoked. Monitoring never establishes task acceptance.\n";
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) { process.stdout.write(help); return; }
  let metadata: string | undefined, stdin = false, json = false;
  const names: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--credentials-stdin" && !stdin) stdin = true;
    else if (arg === "--json" && !json) json = true;
    else if (arg === "--targets" && metadata === undefined) metadata = value(args[++index]);
    else if (arg === "--target") names.push(value(args[++index]));
    else throw new MonitorInputError("unknown or repeated monitor argument; use --help");
  }
  if (!metadata || !isAbsolute(metadata) || !stdin || names.length < 1 || names.length > 200 || new Set(names).size !== names.length) throw new MonitorInputError("explicit metadata, unique targets and --credentials-stdin are required");
  const available = parseMonitorTargets(await boundedMonitorJson(metadata));
  const targets = names.map((name) => {
    const target = available.find((item) => item.name === name);
    if (!target) throw new MonitorInputError("selected target has no metadata entry");
    return target;
  });
  const credentials = parseMonitorCredentials(await credentialInput(), names);
  const report = await inspectMonitorTargets(targets, credentials, json ? undefined : (name, phase) => { process.stdout.write(`${name}\t${phase}\n`); });
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else for (const row of report.results) process.stdout.write(`${row.target}\tstate=${row.evidence.state}\tdiscovery=${row.evidence.discovery}\tactiveChildren=${row.evidence.activeChildren}\tcurrentFailures=${row.evidence.currentFailures}\thistoricalFailures=${row.evidence.historicalFailures}\tcompletion=not-assessed\n`);
  if (report.outcome !== "inspected") process.exitCode = 2;
}
async function credentialInput(): Promise<unknown> {
  const timeout = setTimeout(() => process.stdin.destroy(new MonitorInputError("credential stdin deadline exceeded")), 10_000);
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of process.stdin) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 64 * 1024) throw new MonitorInputError("credential stdin limit exceeded"); chunks.push(bytes); }
    try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); return value; }
    catch { throw new MonitorInputError("invalid in-memory credential envelope"); }
  } finally { clearTimeout(timeout); }
}
function value(input: string | undefined): string {
  if (!input || input.startsWith("--")) throw new MonitorInputError("monitor argument value missing");
  return input;
}
try { await main(); }
catch {
  if (process.argv.includes("--json")) process.stdout.write('{"outcome":"unavailable","completion":"not-assessed","error":{"name":"MonitorInputError"}}\n');
  else process.stderr.write("Task inspection unavailable: check metadata and the in-memory credential producer; use --help. No private input was printed.\n");
  process.exitCode = 2;
}
