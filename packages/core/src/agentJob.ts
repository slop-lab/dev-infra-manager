import { buildAgentTimeoutArgs } from "./docker.js";
import { cleanupJob, prepareJob } from "./job.js";
import type { DevInfraConfig, StreamingCommandRunner } from "./types.js";

export interface RunAgentJobOptions {
  jobId: string;
  profileName: string;
  command: string[];
  sudo: boolean;
  keepDisk: boolean;
}

export async function runAgentJob(
  config: DevInfraConfig,
  runner: StreamingCommandRunner,
  options: RunAgentJobOptions
): Promise<number> {
  try {
    const metadata = await prepareJob(config, runner, options.jobId, options.profileName, false);
    const timeoutArgs = buildAgentTimeoutArgs(config, metadata, {
      name: `dim-${options.jobId}`,
      command: options.command
    });
    return await runner.runStreaming("timeout", timeoutArgs, { sudo: options.sudo });
  } finally {
    await cleanupJob(config, runner, options.jobId, false, !options.keepDisk);
  }
}
