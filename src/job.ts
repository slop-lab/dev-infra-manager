import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertCondition, UserError } from "./errors.js";
import { runPlannedCommand } from "./commands.js";
import { getStorageBackend } from "./storageBackends.js";
import type { CommandRunner, DevInfraConfig, JobMetadata, JobPaths, PlannedCommand } from "./types.js";

export function validateJobId(jobId: string): string {
  assertCondition(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(jobId), "job id must be 1-128 chars of letters, numbers, dot, dash, or underscore");
  assertCondition(!jobId.includes(".."), "job id must not contain '..'");
  return jobId;
}

export function getJobPaths(config: DevInfraConfig, jobId: string): JobPaths {
  const safeJobId = validateJobId(jobId);
  const jobRoot = join(config.stateRoot, "jobs", safeJobId);
  const mountPoint = join(config.jobMountRoot, safeJobId);
  return {
    jobRoot,
    diskImage: join(jobRoot, "disk.img"),
    mountPoint,
    workspace: join(mountPoint, "workspace"),
    runtimeData: join(mountPoint, "runtime-data"),
    metadata: join(jobRoot, "metadata.json")
  };
}

export function planPrepareJob(config: DevInfraConfig, jobId: string, profileName: string): PlannedCommand[] {
  const profile = config.resourceProfiles[profileName];
  if (!profile) {
    throw new UserError(`Unknown resource profile: ${profileName}`);
  }

  const paths = getJobPaths(config, jobId);
  return getStorageBackend(config).planPrepare(paths, profile);
}

export function planCleanupJob(config: DevInfraConfig, jobId: string, removeDisk: boolean): PlannedCommand[] {
  const paths = getJobPaths(config, jobId);
  return getStorageBackend(config).planCleanup(paths, removeDisk);
}

export async function prepareJob(
  config: DevInfraConfig,
  runner: CommandRunner,
  jobId: string,
  profileName: string,
  dryRun: boolean
): Promise<JobMetadata> {
  const profile = config.resourceProfiles[profileName];
  if (!profile) {
    throw new UserError(`Unknown resource profile: ${profileName}`);
  }

  const paths = getJobPaths(config, jobId);
  const storageBackend = getStorageBackend(config);
  if (!dryRun) {
    await claimJobPaths(paths);
  }

  for (const command of planPrepareJob(config, jobId, profileName)) {
    await runPlannedCommand(runner, command, dryRun);
  }

  const metadata: JobMetadata = {
    jobId,
    profileName,
    resourceProfile: profile,
    storageBackend: storageBackend.kind,
    paths,
    createdAt: new Date().toISOString(),
    mounted: !dryRun && storageBackend.mounted
  };
  if (!dryRun) {
    await writeFile(paths.metadata, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }
  return metadata;
}

async function claimJobPaths(paths: JobPaths): Promise<void> {
  await mkdir(dirname(paths.jobRoot), { recursive: true });
  await mkdir(dirname(paths.mountPoint), { recursive: true });
  try {
    await mkdir(paths.jobRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new UserError(`Job state already exists for this job id. Run cleanup first: ${paths.jobRoot}`);
    }
    throw error;
  }

  try {
    await mkdir(paths.mountPoint);
  } catch (error) {
    await rm(paths.jobRoot, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new UserError(`Job mount path already exists for this job id. Run cleanup first: ${paths.mountPoint}`);
    }
    throw error;
  }
}

export async function cleanupJob(
  config: DevInfraConfig,
  runner: CommandRunner,
  jobId: string,
  dryRun: boolean,
  removeDisk: boolean
): Promise<void> {
  if (!dryRun) {
    const paths = getJobPaths(config, jobId);
    const storageBackend = getStorageBackend(config);
    if (storageBackend.mounted) {
      const mountpoint = await runner.run("mountpoint", ["-q", paths.mountPoint]);
      if (mountpoint.exitCode === 0) {
        await runPlannedCommand(runner, { command: "umount", args: [paths.mountPoint], sudo: true }, false);
      }
    }
    if (removeDisk) {
      await runPlannedCommand(runner, { command: "rm", args: ["-rf", paths.jobRoot, paths.mountPoint], sudo: true }, false);
      await rm(paths.jobRoot, { recursive: true, force: true });
      await rm(paths.mountPoint, { recursive: true, force: true });
    }
    return;
  }

  for (const command of planCleanupJob(config, jobId, removeDisk)) {
    await runPlannedCommand(runner, command, dryRun);
  }
}

export async function readJobMetadata(config: DevInfraConfig, jobId: string): Promise<JobMetadata> {
  try {
    return JSON.parse(await readFile(getJobPaths(config, jobId).metadata, "utf8")) as JobMetadata;
  } catch (error) {
    throw new UserError(`No metadata found for job '${jobId}': ${(error as Error).message}`);
  }
}
