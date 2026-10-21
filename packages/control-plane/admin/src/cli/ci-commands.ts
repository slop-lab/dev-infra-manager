import { UserError } from "@slop-lab/dim-host-core";
import { createCiQueryClient } from "../ci/queryClient.js";
import type { Command } from "commander";
export function registerCiCommands(program: Command): void {
  const ci = program.command("ci").description("Query candidate CI jobs and diagnostics");
  ci.command("jobs").description("List the 100 most recent CI executions")
    .option("--connection <file>", "private CI query connection (defaults beside the selected host connection)")
    .option("--json", "print execution summaries as JSON")
    .action(async (flags: { connection?: string; json?: boolean }) => {
      const jobs = await (await createCiQueryClient(flags.connection)).jobs();
      if (flags.json) console.log(JSON.stringify(jobs));
      else console.log(["EXECUTION\tPROJECT\tJOB\tSTATUS\tPUBLICATION", ...jobs.map((job) =>
        [job.id, job.projectId, job.jobName, job.outcome ?? job.phase, job.publication].join("\t"))].join("\n"));
    });
  ci.command("logs").description("Read bounded diagnostics for one CI execution")
    .argument("<execution-id>")
    .option("--connection <file>", "private CI query connection")
    .option("--json", "print result metadata and base64 diagnostics as JSON")
    .action(async (id: string, flags: { connection?: string; json?: boolean }) => {
      const detail = await (await createCiQueryClient(flags.connection)).detail(id);
      if (flags.json) { console.log(JSON.stringify(detail)); return; }
      if (!detail.result) throw new UserError(`execution '${id}' has no result yet (${detail.job.phase})`);
      const bytes = { stdout: Buffer.from(detail.result.logs.stdout.base64, "base64"), stderr: Buffer.from(detail.result.logs.stderr.base64, "base64") };
      process.stdout.write(bytes.stdout); process.stderr.write(bytes.stderr);
      for (const stream of ["stdout", "stderr"] as const) if (detail.result.logs[stream].truncated) process.stderr.write(`\n[${stream} diagnostics truncated; retained ${bytes[stream].length} bytes]\n`);
    });
}
