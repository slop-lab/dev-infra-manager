import { UserError } from "@slop-lab/dim-core";
import { createCiQueryClient } from "../ci/queryClient.js";
import type { Command } from "commander";
import { ProcessRunner } from "@slop-lab/dim-core";
import { loadInstalledPlugins, resolvePluginHome } from "../pluginLoader.js";
import { resolveHostMirrorProvider } from "../hostMirrorProvider.js";
import { lifecycleOptions } from "../lifecycleOptions.js";
import { runCiWorker } from "../ci/host.js";
import { buildNativeQemuRunnerImage } from "../nativeQemuRunnerImage.js";
export function registerCiCommands(program: Command): void {
  const ci = program.command("ci").description("Run isolated candidate jobs");
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
  ci.command("worker").description("Run configured Sysbox and QEMU slots from a private host config")
    .argument("<config>").action(async (config: string) => {
      const stop = new AbortController(), shutdown = () => stop.abort();
      process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
      const loaded = await loadInstalledPlugins(await resolvePluginHome());
      try {
        const provider = resolveHostMirrorProvider(loaded.registered.host);
        await runCiWorker(config, stop.signal, { lifecycle: { ...lifecycleOptions(),
          ...(provider === undefined ? {} : { hostMirrorProvider: provider }) } });
      }
      finally { await loaded.registered.dispose(); process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); }
    });
  ci.command("qemu-image").description("Build the trusted KVM supervisor and fixed guest launcher")
    .argument("<image>").action(async (image: string) => {
      await buildNativeQemuRunnerImage(new ProcessRunner(), image); console.log(image);
    });
}
