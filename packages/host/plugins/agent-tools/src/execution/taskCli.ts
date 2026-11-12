import { runTaskOperation } from "./taskGuest.ts";
import { parseTaskReceipt } from "./taskContract.ts";
import { readTaskInput } from "./taskInput.ts";
const help = "usage: dim-agent-task identity|submit|request --input-stdin [--json]\nTask text belongs in bounded JSON stdin, never process arguments. Reuse requestId to read the durable outcome; uncertain acceptance never authorizes blind resubmission.\n";
async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(help); return; }
  const [operation, ...flags] = args;
  if (!["identity", "submit", "request"].includes(operation ?? "") || !flags.includes("--input-stdin") || flags.some(flag => flag !== "--input-stdin" && flag !== "--json") || new Set(flags).size !== flags.length) throw Error("Invalid task arguments");
  const cancellation = new AbortController(), cancel = () => cancellation.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const timer = setTimeout(() => process.stdin.destroy(Error("Task input deadline")), 10_000);
    let input: unknown;
    try { input = await readTaskInput(process.stdin); } finally { clearTimeout(timer); }
    const result = await runTaskOperation(operation ?? "", input, process.env.HOME ?? "", AbortSignal.any([cancellation.signal, AbortSignal.timeout(10_000)]));
    if (flags.includes("--json") || operation === "identity") process.stdout.write(JSON.stringify(result) + "\n");
    else { const receipt = parseTaskReceipt(result); process.stdout.write(`${receipt.outcome}; request ${receipt.requestId}; session ${receipt.sessionId ?? "unknown"}; phase ${receipt.phase}; completion not assessed\n`); }
    if (operation !== "identity" && parseTaskReceipt(result).outcome !== "accepted") process.exitCode = 2;
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}
void main(process.argv.slice(2)).catch(() => { process.stderr.write("Task operation unavailable or invalid input. " + help); process.exitCode = 1; });
