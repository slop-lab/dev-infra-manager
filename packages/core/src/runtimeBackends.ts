import type { LifecycleOptions, WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";

export interface WorkspaceRuntimePlan {
  dockerRuntime: string;
  image: string;
  privileged: boolean;
  capabilities: string[];
  securityOptions: string[];
  devices: string[];
  runtimeDataPath: string;
  engine: "docker";
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
  if (backend !== "sysbox") throw new Error(`unsupported workspace backend '${backend}'`);
  return {
    ...shared,
    // The workspace is trusted lifecycle infrastructure. The untrusted agent
    // runs in a host-side Sysbox container, so the trusted outer container
    // continues to use Docker's ordinary runc runtime.
    dockerRuntime: options.workspaceRuntime ?? "runc",
    image: options.workspaceImage ?? "dev-infra-project-workspace:latest",
    privileged: options.workspacePrivileged ?? true,
    runtimeDataPath: "/var/lib/docker",
    engine: "docker",
    env: { DIM_DOCKERD_FLAGS: nestedDockerFlags }
  };
}
