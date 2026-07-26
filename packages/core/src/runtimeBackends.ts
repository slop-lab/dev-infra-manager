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
        dockerRuntime: options.workspaceRuntime ?? "sysbox-runc",
        image: options.workspaceImage ?? "dev-infra-project-workspace:latest",
        privileged: options.workspacePrivileged ?? false,
        runtimeDataPath: "/var/lib/docker",
        engine: "docker"
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
        env: { DIM_DOCKERD_FLAGS: "--feature containerd-snapshotter=false" }
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
        engine: "docker"
      };
  }
}
