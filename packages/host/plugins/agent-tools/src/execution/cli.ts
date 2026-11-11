import { inspectOwnedOpenCode } from "./guest.ts";
import { executionRevision, formatExecutionStatus, waitForExecutionChange } from "./status.ts";

const help = "usage: dim-agent-execution status|wait --session ses_ID [--since SHA256] [--timeout-seconds 1..180] [--json]\nRead-only OpenCode execution status. Wait samples no more than once per minute and returns on change or deadline. Completion is not assessed.\n";
async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(help); return; }
  const [operation, ...rest] = args;
  if (operation !== "status" && operation !== "wait") throw Error("Invalid execution operation");
  let sessionId: string | undefined, since: string | undefined, timeoutSeconds = 120, json = false;
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (!flag || seen.has(flag)) throw Error("Invalid execution option");
    seen.add(flag);
    if (flag === "--json") { json = true; continue; }
    const value = rest[++index];
    if (value === undefined) throw Error("Missing execution option value");
    switch (flag) {
      case "--session": sessionId = value; break;
      case "--since": if (operation !== "wait") throw Error("since requires wait"); since = value; break;
      case "--timeout-seconds": if (operation !== "wait" || !/^[0-9]+$/.test(value)) throw Error("Invalid wait timeout"); timeoutSeconds = Number(value); break;
      default: throw Error("Unknown execution option");
    }
  }
  if (!sessionId || !/^ses_[A-Za-z0-9]{1,100}$/.test(sessionId) || since !== undefined && !/^[a-f0-9]{64}$/.test(since) || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 180) throw Error("Invalid execution selection");
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const observe = (signal: AbortSignal) => inspectOwnedOpenCode(sessionId, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    const result = operation === "wait" ? await waitForExecutionChange({ observe, signal: cancellation.signal, timeoutMs: timeoutSeconds * 1000, ...(since === undefined ? {} : { since }) })
      : await observe(cancellation.signal).then(evidence => ({ evidence, revision: executionRevision(evidence) }));
    process.stdout.write(json ? JSON.stringify(result) + "\n" : (result.evidence === null ? "unknown; no observation before deadline; completion not assessed" : formatExecutionStatus(result.evidence)) + ("outcome" in result ? `; wait ${result.outcome}` : "") + "\n");
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}
void main(process.argv.slice(2)).catch(() => { process.stderr.write("Execution inspection failed. " + help); process.exitCode = 1; });
