import type { LifecycleOptions, WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";

export interface WorkspaceRuntimePlan {
  dockerRuntime: string;
  image: string;
  privileged: boolean;
  capabilities: string[];
  securityOptions: string[];
  devices: string[];
  runtimeDataPath: string;
  engine: "docker" | "podman";
  env: Record<string, string>;
}

// Docker 29 enables the containerd image store for fresh daemons. DIM persists
// /var/lib/docker as the workspace engine boundary, while containerd keeps
// snapshots under /var/lib/containerd; nested overlayfs also does not reliably
// preserve security.capability xattrs on supported system-container backends.
const nestedDockerFlags = "--feature containerd-snapshotter=false";

export function workspaceRuntimePlan(
  backend: WorkspaceRuntimeBackendKind,
  options: LifecycleOptions
): WorkspaceRuntimePlan {
  const shared = {
    capabilities: [] as string[],
    securityOptions: [] as string[],
    devices: [] as string[],
    env: {} as Record<string, string>
  };
  switch (backend) {
    case "sysbox":
      return {
        ...shared,
        // The workspace is trusted lifecycle infrastructure. The untrusted
        // agent is the host-side Sysbox container; nesting the whole
        // workspace in Sysbox would put the Project daemon and secrets in the
        // same sandbox as the agent.
        dockerRuntime: options.workspaceRuntime ?? "runc",
        image: options.workspaceImage ?? "dev-infra-project-workspace:latest",
        privileged: options.workspacePrivileged ?? true,
        runtimeDataPath: "/var/lib/docker",
        engine: "docker",
        env: { DIM_DOCKERD_FLAGS: nestedDockerFlags }
      };
    case "gvisor":
      return {
        ...shared,
        dockerRuntime: options.workspaceRuntime ?? "runsc",
        image: options.workspaceImage ?? "dev-infra-project-workspace:latest",
        privileged: options.workspacePrivileged ?? false,
        capabilities: [
          "AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL",
          "MKNOD", "NET_ADMIN", "NET_BIND_SERVICE", "NET_RAW", "SETFCAP",
          "SETGID", "SETPCAP", "SETUID", "SYS_ADMIN", "SYS_CHROOT", "SYS_PTRACE"
        ],
        runtimeDataPath: "/var/lib/docker",
        engine: "docker",
        env: {
          DIM_DOCKERD_FLAGS: nestedDockerFlags,
          DOCKER_IPTABLES_LEGACY: "1"
        }
      };
    case "rootless-podman":
      return {
        ...shared,
        dockerRuntime: options.workspaceRuntime ?? "runc",
        image: options.workspaceImage ?? "dev-infra-project-workspace-podman:latest",
        privileged: options.workspacePrivileged ?? false,
        // Rootless Podman needs to create its own unprivileged user
        // namespaces (newuidmap/newgidmap-based UID/GID remapping) inside
        // this outer container. The same capability set already used for
        // gVisor's nested Docker covers that (SYS_ADMIN for the mount/ns
        // operations, SETUID/SETGID for the ID mapping, SYS_CHROOT/SYS_PTRACE
        // for crun/conmon) without granting every capability via
        // --privileged. Set DIM_WORKSPACE_PRIVILEGED=true to fall back to
        // the old always-privileged behavior if this turns out insufficient
        // on some host.
        capabilities: [
          "AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL",
          "MKNOD", "NET_ADMIN", "NET_BIND_SERVICE", "NET_RAW", "SETFCAP",
          "SETGID", "SETPCAP", "SETUID", "SYS_ADMIN", "SYS_CHROOT", "SYS_PTRACE"
        ],
        securityOptions: [
          "seccomp=unconfined",
          "apparmor=unconfined",
          "systempaths=unconfined"
        ],
        devices: ["/dev/fuse"],
        runtimeDataPath: "/home/dim/.local/share/containers",
        engine: "podman",
        env: { DIM_NESTED_ENGINE: "podman", XDG_RUNTIME_DIR: "/tmp/dim-runtime" }
      };
    case "runc":
      return {
        ...shared,
        dockerRuntime: options.workspaceRuntime ?? "runc",
        image: options.workspaceImage ?? "dev-infra-project-workspace:latest",
        privileged: options.workspacePrivileged ?? true,
        runtimeDataPath: "/var/lib/docker",
        engine: "docker",
        env: { DIM_DOCKERD_FLAGS: nestedDockerFlags }
      };
  }
}
