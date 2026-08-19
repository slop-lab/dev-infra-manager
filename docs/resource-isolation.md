# Resource Isolation

DIM applies CPU, memory, and PID limits to the trusted workspace. Project-owned
services, including an optional development agent, share that aggregate cgroup
boundary unless the Project's Compose definition adds stricter child limits.
An operator may change this aggregate boundary after creation with
`dim workspace resources WORKSPACE` and any combination of `--cpus`, `--memory`, and
`--pids-limit`; omitted limits remain unchanged.

A reviewed Project may create threaded cgroup v2 children below that workspace
boundary and delegate selected CPU/PID controls to an unprivileged agent. This
can keep a lightweight command or runtime-server path in the agent container's
default group while moving expensive tool processes into a lower-weight child.
The canonical self-Project does this for Codex: `dim workspace run WORKSPACE bash` stays
in the default agent group, while `dim workspace run WORKSPACE codex` and its descendants
run in `tools-0`. The workspace parent still bounds the aggregate. Memory and
I/O remain workspace-wide because threaded children cannot receive those
domain controllers.

The default nested-container backend is Sysbox. gVisor provides a Docker-compatible
no-KVM alternative, rootless Podman supports compatible lower-privilege
workloads, and privileged runc is reserved for CI or nested development
containers.

DIM does not currently impose a per-workspace disk quota. Project checkout
data lives in workspace storage and nested-engine data lives in labeled Docker
volumes. `discard --yes` removes them. Operators should monitor host
filesystem and Docker storage usage.

Neither workspace nor a correctly configured Project agent receives the host
Docker socket or a host source checkout. Secret-bearing runtimes may live
beside an agent inside the current privileged workspace; this is not a strong
security boundary, so raw secrets must still be withheld from the agent and
exposed only through reviewed constrained interfaces.

Nested Project containers do not inherit the trusted workspace container's
Docker-managed host aliases. DIM therefore records approved workspace-local
names and resolved addresses in the read-only Project manifest. Reviewed
Project setup may copy that static mapping into selected child containers;
it must not treat the workspace's complete `/etc/hosts` as an authorization
source.
