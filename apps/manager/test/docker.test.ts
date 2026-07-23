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
      storageBackend: "loopback",
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
    expect(args).toEqual(expect.arrayContaining(["--cpus", "2", "--memory", "4294967296", "--pids-limit", "2048"]));
    expect(args.join(" ")).not.toContain("source=/var/lib/docker");
    expect(args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(buildAgentTimeoutCommand(config, metadata, { command: ["bash"] })).toMatch(/^timeout 3600s docker run/);
  });

  it("builds gVisor docker args with runsc and dockerd flags", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      agent: {
        ...DEFAULT_CONFIG.agent,
        runtime: "runsc",
        runtimeBackend: { kind: "gvisor", dockerRuntime: "runsc" }
      }
    });
    const profile = config.resourceProfiles.default!;
    const metadata: JobMetadata = {
      jobId: "job-1",
      profileName: "default",
      resourceProfile: profile,
      storageBackend: "directory",
      paths: {
        jobRoot: "/state/jobs/job-1",
        diskImage: "/state/jobs/job-1/disk.img",
        mountPoint: "/mounts/job-1",
        workspace: "/mounts/job-1/workspace",
        runtimeData: "/mounts/job-1/runtime-data",
        metadata: "/state/jobs/job-1/metadata.json"
      },
      createdAt: "2026-07-03T00:00:00.000Z",
      mounted: false
    };

    const args = buildAgentDockerArgs(config, metadata, { command: ["bash"] });
    expect(args).toContain("runsc");
    expect(args).toContain("SYS_ADMIN");
    expect(args).toContain("DEV_INFRA_DOCKERD_FLAGS=--iptables=false --ip6tables=false --feature containerd-snapshotter=false");
  });

  it("builds rootless Podman args without a Docker daemon", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      agent: {
        ...DEFAULT_CONFIG.agent,
        image: "dev-infra-agent-workspace-podman:latest",
        runtime: "runc",
        runtimeBackend: { kind: "rootless-podman", dockerRuntime: "runc" }
      }
    });
    const profile = config.resourceProfiles.default!;
    const metadata: JobMetadata = {
      jobId: "job-1",
      profileName: "default",
      resourceProfile: profile,
      storageBackend: "directory",
      paths: {
        jobRoot: "/state/jobs/job-1",
        diskImage: "/state/jobs/job-1/disk.img",
        mountPoint: "/mounts/job-1",
        workspace: "/mounts/job-1/workspace",
        runtimeData: "/mounts/job-1/runtime-data",
        metadata: "/state/jobs/job-1/metadata.json"
      },
      createdAt: "2026-07-03T00:00:00.000Z",
      mounted: false
    };

    const args = buildAgentDockerArgs(config, metadata, { command: ["podman", "info"] });
    expect(args).toContain("DEV_INFRA_NESTED_ENGINE=podman");
    expect(args).toContain("DEV_INFRA_START_DOCKERD=0");
    expect(args).toContain("type=bind,source=/mounts/job-1/runtime-data,target=/home/agent/.local/share/containers");
  });
});
