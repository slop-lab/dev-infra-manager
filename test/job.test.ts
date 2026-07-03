import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { cleanupJob, getJobPaths, prepareJob, validateJobId } from "../src/job.js";
import { RecordingRunner } from "../src/runner.js";

describe("job lifecycle planning", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects unsafe job ids", () => {
    expect(() => validateJobId("../x")).toThrow();
    expect(() => validateJobId("ok-job_1.2")).not.toThrow();
  });

  it("plans and records prepare commands", async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      stateRoot: join(root, "state"),
      jobMountRoot: join(root, "mounts")
    });
    const runner = new RecordingRunner();
    const metadata = await prepareJob(config, runner, "job-1", "default", false);
    const paths = getJobPaths(config, "job-1");

    expect(metadata.paths.diskImage).toBe(paths.diskImage);
    expect(runner.commands.map((entry) => entry.command)).toEqual(["truncate", "mkfs.ext4", "mount", "install", "chown"]);
    expect(runner.commands[2]?.sudo).toBe(true);
  });

  it("supports directory storage without loop mounts", async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      stateRoot: join(root, "state"),
      jobMountRoot: join(root, "mounts"),
      storageBackend: { kind: "directory" }
    });
    const runner = new RecordingRunner();
    const metadata = await prepareJob(config, runner, "job-directory", "default", false);

    expect(metadata.storageBackend).toBe("directory");
    expect(metadata.mounted).toBe(false);
    expect(runner.commands.map((entry) => entry.command)).toEqual(["install", "chown"]);
  });

  it("refuses to overwrite existing job state", async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      stateRoot: join(root, "state"),
      jobMountRoot: join(root, "mounts")
    });
    const runner = new RecordingRunner();
    await prepareJob(config, runner, "job-duplicate", "default", false);

    await expect(prepareJob(config, runner, "job-duplicate", "default", false)).rejects.toThrow(/Job state already exists/);
  });

  it("allows job id reuse after cleanup removes state", async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      stateRoot: join(root, "state"),
      jobMountRoot: join(root, "mounts")
    });
    const runner = new RecordingRunner();
    await prepareJob(config, runner, "job-reuse", "default", false);
    await cleanupJob(config, runner, "job-reuse", false, true);
    await prepareJob(config, runner, "job-reuse", "default", false);

    expect(runner.commands.filter((entry) => entry.command === "truncate")).toHaveLength(2);
  });

  it("does not create job files in dry-run mode", async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      stateRoot: join(root, "state"),
      jobMountRoot: join(root, "mounts")
    });
    const runner = new RecordingRunner();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await prepareJob(config, runner, "job-2", "default", true);
      await expect(stat(getJobPaths(config, "job-2").metadata)).rejects.toThrow();
    } finally {
      stdout.mockRestore();
    }
  });
});
