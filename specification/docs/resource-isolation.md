# Resource Isolation

DIM applies CPU, memory, and PID limits to the trusted workspace. Project-owned
services, including an optional development agent, share that aggregate cgroup
boundary unless the Project's Compose definition adds stricter child limits.
An operator may change this aggregate boundary after creation with
`dim workspace resources WORKSPACE` and any combination of `--cpus`, `--memory`, and
`--pids`; omitted limits remain unchanged.

Reviewed Project lifecycle code may expose the built-in, agent-audience
`GET /api/workspace/resources` route through an exact-route
`dim-controller-proxy` socket. `dim-workspace-resources show` reads that socket
and reports only the authenticated workspace's accepted CPU, memory, and PID
assignments as JSON. It accepts no workspace selector. `dim-nproc` reads the
same route and prints
`max(1, floor(assigned CPU count))`, capped by the CPUs visible to the calling
process. A missing, non-numeric, unlimited (`max`), or otherwise unavailable
CPU assignment is an error; the helper never substitutes the host CPU count as
the workspace assignment. These helpers do not inspect Docker or cgroup files
and receive neither a controller grant nor the host-admin socket.
The resource helper reads the resource-only derived socket named by
`DIM_AGENT_CONTROLLER_SOCKET`. That proxy uses the agent-audience grant in
trusted Project lifecycle code. A self-restart capability remains on a
separate workspace-audience proxy named by `DIM_CONTROLLER_SOCKET`; combining
the two audiences in one proxy is rejected.

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
