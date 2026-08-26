# Resource Isolation

DIM applies CPU, memory, and PID limits to the trusted workspace. Project-owned
services, including an optional development agent, share that aggregate cgroup
boundary unless the Project's Compose definition adds stricter child limits.
An operator may change this aggregate boundary after creation with
`dim workspace resources WORKSPACE` and any combination of `--cpus`, `--memory`, and
`--pids`; omitted limits remain unchanged.

After the nested engine starts, DIM records its cgroup driver and the writable
cgroup v2 boundary in the read-only Project manifest. DIM exposes safe
delegation automatically; reviewed setup may use `dim-project-cgroup` to
allocate descendants below that boundary. systemd and
cgroupfs are explicit providers of the same Project contract; driver `none`
and incomplete boundaries are reported as unavailable without blocking a
Project that did not explicitly require resource enforcement.

The workspace backend is Sysbox. Docker's ordinary runc runtime remains the
internal execution mechanism for trusted infrastructure and is not exposed as
a workspace isolation choice.

DIM does not currently impose a per-workspace disk quota. Project checkout
data lives in workspace storage and nested-engine data lives in labeled Docker
volumes. `discard --yes` removes them unless `--keep-volume` is selected.
Operators should monitor host
filesystem and Docker storage usage.

Neither workspace nor a correctly configured Project agent receives the host
Docker socket or a host source checkout. Secret-bearing runtimes must use a
separate `secure-dind` boundary rather than the agent's `agent-dind`; this is
still not a strong
security boundary, so raw secrets must still be withheld from the agent and
exposed only through reviewed constrained interfaces.

Nested Project containers do not inherit the trusted workspace container's
Docker-managed host aliases. DIM therefore records approved workspace-local
names and resolved addresses in the read-only Project manifest. Reviewed
Project setup may copy that static mapping into selected child containers;
it must not treat the workspace's complete `/etc/hosts` as an authorization
source.
