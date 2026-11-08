import { writeFile } from "node:fs/promises";
import type { CommandResult } from "../../web-lifecycle/process.ts";

/** Preserve structured stdout before checking failure; never retain raw command stderr. */
export async function persistPracticalSmokeReport(target: string, output: CommandResult): Promise<unknown> {
  const report: unknown = JSON.parse(output.stdout);
  if (!report || typeof report !== "object" || !("outcome" in report) || !["passed", "failed", "incomplete", "unavailable", "preflight-passed"].includes(String(report.outcome))
    || ("results" in report && !Array.isArray(report.results))) throw new Error("practical smoke did not return a structured report");
  await writeFile(target, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  if (output.exitCode !== 0) throw new Error(`practical smoke failed (exit ${output.exitCode}); inspect selected-host-report.json`);
  return report;
}
