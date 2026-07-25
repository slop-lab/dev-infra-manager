# Resource Isolation

DIM applies CPU, memory, and PID limits to the workspace root container.
Controller-managed and agent-managed nested workloads therefore share its
aggregate cgroup boundary while remaining separated by their container
runtimes.

The production default is Sysbox. gVisor provides a Docker-compatible
no-KVM alternative, rootless Podman supports compatible lower-privilege
workloads, and privileged runc is reserved for CI or nested development
containers.

DIM does not currently impose a per-workspace disk quota. Project checkout
data lives in the workspace container and nested-engine data lives in a
labeled Docker volume. `discard --yes` removes both. Operators
should monitor host filesystem and Docker storage usage.

No workspace root receives the host Docker socket or a host source checkout.
Secret-bearing runtimes live inside the workspace root boundary but outside
the untrusted agent container and its nested runtime.
