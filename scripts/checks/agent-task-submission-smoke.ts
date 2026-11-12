import { spawn } from "node:child_process";
import { object, parseTaskReceipt, uuidPattern } from "../../packages/host/plugins/agent-tools/src/execution/taskContract.ts";

const help = "usage: node scripts/checks/agent-task-submission-smoke.ts --workspace-id UUID --request-id UUID [--server-identity SHA256] [--run]\nPreflight is read-only. --run requires --server-identity and sends exactly one explicit record-only user message through the installed DIM producer, with no inference. Missing installed capability is BLOCKED, never permission to install or use direct OpenCode.\n";
async function command(file: string, args: string[], input?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(12_000) });
    let source = "", bytes = 0; child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 65536) child.kill(); else source += chunk.toString(); }); child.stderr.resume(); child.stdin.on("error", reject);
    child.once("error", reject); child.once("close", code => { try { if (code !== 0 || bytes > 65536) throw Error("DIM task operation unavailable"); const value: unknown = JSON.parse(source); resolve(value); } catch (error) { reject(error); } });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(help); return; }
  let workspaceId = "", requestId = "", serverIdentity = "", run = false; const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]; if (key === undefined || seen.has(key)) throw Error("Invalid smoke argument"); seen.add(key);
    if (key === "--run") { run = true; continue; }
    const value = args[++index]; if (value === undefined) throw Error("Missing smoke argument");
    switch (key) { case "--workspace-id": workspaceId = value; break; case "--request-id": requestId = value; break; case "--server-identity": serverIdentity = value; break; default: throw Error("Unknown smoke argument"); }
  }
  if (!uuidPattern.test(workspaceId) || !uuidPattern.test(requestId) || (run || serverIdentity !== "") && !/^[a-f0-9]{64}$/.test(serverIdentity)) throw Error("Invalid smoke identity");
  const discovery = object(await command("dim-workspace", ["discovery"]));
  if (object(discovery.authorization).workspaceId !== workspaceId || object(discovery.workspace).id !== workspaceId) throw Error("Smoke requires this exact current workspace");
  const available = Array.isArray(discovery.capabilities) && discovery.capabilities.some(raw => { const row = object(raw); return row.owner === "agent-tools" && row.name === "coding-agent-task-submission" && row.state === "available"; });
  if (!available) { process.stdout.write(JSON.stringify({ outcome: "blocked", reason: "installed-task-producer-unavailable", workspaceId, submitted: false }) + "\n"); process.exitCode = 2; return; }
  const identity = object(await command("dim-agent-task", ["identity", "--input-stdin", "--json"], { workspaceId, runtime: "opencode" }));
  if (identity.workspaceId !== workspaceId || typeof identity.serverIdentity !== "string" || !/^[a-f0-9]{64}$/.test(identity.serverIdentity) || serverIdentity !== "" && identity.serverIdentity !== serverIdentity) throw Error("Smoke server identity changed");
  serverIdentity = identity.serverIdentity;
  if (!run) { process.stdout.write(JSON.stringify({ outcome: "ready", workspaceId, requestId, serverIdentity, submitted: false }) + "\n"); return; }
  const input = { workspaceId, requestId, runtime: "opencode", serverIdentity, target: { kind: "new" }, mode: "record-only", text: "DIM task-submission acceptance: record this explicit user message only; do not run tools or inference." };
  const receipt = parseTaskReceipt(await command("dim-agent-task", ["submit", "--input-stdin", "--json"], input));
  if (receipt.outcome !== "accepted" || receipt.workspaceId !== workspaceId || receipt.requestId !== requestId || receipt.serverIdentity !== serverIdentity) throw Error("Submission not proven; inspect this same request ID, do not resubmit");
  const stored = parseTaskReceipt(await command("dim-agent-task", ["request", "--input-stdin", "--json"], { workspaceId, requestId }));
  if (JSON.stringify(stored) !== JSON.stringify(receipt)) throw Error("Durable receipt mismatch; do not resubmit");
  process.stdout.write(JSON.stringify({ outcome: "accepted", workspaceId, requestId, serverIdentity, sessionId: receipt.sessionId, completion: "not-assessed", inference: "not-requested" }) + "\n");
}
void main(process.argv.slice(2)).catch(() => { process.stderr.write("Task submission smoke failed or acceptance is unknown; no retry or installation performed. " + help); process.exitCode = 1; });
