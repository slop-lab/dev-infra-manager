# Resource Isolation

DIM applies CPU, memory, and PID limits to the top-level workspace container.
Nested workloads therefore share the workspace's aggregate cgroup boundary.

The production default is Sysbox. gVisor provides a Docker-compatible
no-KVM alternative, rootless Podman supports compatible lower-privilege
workloads, and privileged runc is reserved for CI or nested development
containers.

DIM does not currently impose a per-workspace disk quota. Project checkout
data lives in the workspace container and nested-engine data lives in a
labeled Docker volume. `workspace discard --yes` removes both. Operators
should monitor host filesystem and Docker storage usage.

No workspace receives the host Docker socket or a host source checkout.
Secret-bearing runtimes remain outside the untrusted workspace boundary.
