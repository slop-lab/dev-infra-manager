import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { buildAgentDockerArgs, buildAgentTimeoutCommand } from "../src/docker.js";
import type { JobMetadata } from "../src/types.js";

describe("docker command builder", () => {
  it("builds sysbox docker run args with aggregate job mounts", () => {
    const config = normalizeConfig(DEFAULT_CONFIG);
    const profile = config.resourceProfiles.default!;
    const metadata: JobMetadata = {
      jobId: "job-1",
      profileName: "default",
      resourceProfile: profile,
      paths: {
        jobRoot: "/state/jobs/job-1",
        diskImage: "/state/jobs/job-1/disk.img",
        mountPoint: "/mounts/job-1",
        workspace: "/mounts/job-1/workspace",
        runtimeData: "/mounts/job-1/runtime-data",
        metadata: "/state/jobs/job-1/metadata.json"
      },
      createdAt: "2026-07-03T00:00:00.000Z",
      mounted: true
    };

    const args = buildAgentDockerArgs(config, metadata, { command: ["bash"] });
    expect(args).toContain("sysbox-runc");
    expect(args).toContain("type=bind,source=/mounts/job-1/workspace,target=/workspace");
    expect(args).toContain("type=bind,source=/mounts/job-1/runtime-data,target=/var/lib/docker");
    expect(buildAgentTimeoutCommand(config, metadata, { command: ["bash"] })).toMatch(/^timeout 3600s docker run/);
  });
});
