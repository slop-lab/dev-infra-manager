import type { DevInfraConfig, JobMetadata } from "./types.js";

export interface RuntimeMount {
  source: string;
  target: string;
}

export interface RuntimePlan {
  dockerRuntime?: string;
  capabilities: string[];
  mounts: RuntimeMount[];
  env: Record<string, string>;
  image: string;
}

export function getRuntimePlan(config: DevInfraConfig, metadata: JobMetadata): RuntimePlan {
  switch (config.agent.runtimeBackend.kind) {
    case "sysbox":
      return {
        dockerRuntime: config.agent.runtimeBackend.dockerRuntime ?? config.agent.runtime,
        capabilities: [],
        mounts: [
          { source: metadata.paths.workspace, target: config.agent.workspacePath },
          { source: metadata.paths.runtimeData, target: config.agent.runtimeDataPath }
        ],
        env: {
          DEV_INFRA_NESTED_ENGINE: "docker",
          DEV_INFRA_START_DOCKERD: "1"
        },
        image: config.agent.image
      };
    case "gvisor":
      return {
        dockerRuntime: config.agent.runtimeBackend.dockerRuntime ?? "runsc",
        capabilities: ["AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "MKNOD", "NET_BIND_SERVICE", "NET_ADMIN", "NET_RAW", "SETFCAP", "SETGID", "SETPCAP", "SETUID", "SYS_ADMIN", "SYS_CHROOT", "SYS_PTRACE"],
        mounts: [
          { source: metadata.paths.workspace, target: config.agent.workspacePath },
          { source: metadata.paths.runtimeData, target: config.agent.runtimeDataPath }
        ],
        env: {
          DEV_INFRA_NESTED_ENGINE: "docker",
          DEV_INFRA_START_DOCKERD: "1",
          DEV_INFRA_DOCKERD_FLAGS: "--feature containerd-snapshotter=false"
        },
        image: config.agent.image
      };
    case "rootless-podman":
      return {
        dockerRuntime: config.agent.runtimeBackend.dockerRuntime ?? "runc",
        capabilities: [],
        mounts: [
          { source: metadata.paths.workspace, target: config.agent.workspacePath },
          { source: metadata.paths.runtimeData, target: "/home/agent/.local/share/containers" }
        ],
        env: {
          DEV_INFRA_NESTED_ENGINE: "podman",
          DEV_INFRA_START_DOCKERD: "0",
          XDG_RUNTIME_DIR: "/tmp/agent-runtime"
        },
        image: config.agent.image
      };
  }
}
