# Resource Isolation

DIM applies CPU, memory, and PID limits independently to the trusted workspace
and host-side Sysbox agent. Project workloads share the workspace's aggregate
cgroup boundary; private agent workloads share the agent's boundary.

The production default is Sysbox. gVisor provides a Docker-compatible
no-KVM alternative, rootless Podman supports compatible lower-privilege
workloads, and privileged runc is reserved for CI or nested development
containers.

DIM does not currently impose a per-workspace disk quota. Project checkout
data lives in separate workspace and agent storage, and nested-engine data
lives in labeled Docker volumes. `discard --yes` removes them. Operators
should monitor host filesystem and Docker storage usage.

Neither workspace nor agent receives the host Docker socket or a host source checkout.
Secret-bearing runtimes live inside the workspace root boundary but outside
the untrusted agent container and its nested runtime.
