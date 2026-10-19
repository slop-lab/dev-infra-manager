# Trust boundaries

The development workspace is untrusted. Host-side DIM owns runtime creation,
resource limits, persistent storage and narrowly scoped transport. The base
runtime is one unprivileged Sysbox container with private nested Docker and
three named volumes. It receives no host Docker socket, host source bind,
operator Git credential or administration socket. Container-local root and
nested containers remain inside that boundary; Sysbox is practical isolation,
not a claim that arbitrary hostile code cannot exploit the host kernel.

Ordinary Git acquisition runs on the selected host and copies an independent
checkout into workspace storage. Repository hooks and Project `.dim` lifecycle
files are not automatically executed with host authority. Development tasks
run explicitly through `dim exec`. A future runtime can implement the same
workspace operations without taking over source or Project policy ownership.

Managed Git is optional. Its host-side attachment binds one core UUID to one
native Project and proposal identity. A broker on the owned private bridge
accepts a workspace-scoped credential, checks the current core record and
running/initialized state, and forwards only exact Git smart-HTTP operations.
It obtains short-lived upstream leases from a private operator connection;
it never returns those credentials to the agent. Native Git independently
checks Project/ref scope and denies protected writes, foreign proposal refs,
force and deletion. Removing a workspace or reusing its name cannot transfer
its old grant to the new UUID.

The optional controller serves configured plugin routes for current core
workspaces. Administrative access stays host-side. Workspace requests travel
through a constrained authenticated relay with explicit route and audience
selection; the agent does not receive the controller's administrative socket
or operator grants. Plugins own their policy and persistence. They do not own
workspace lifecycle. Neither controller availability nor a mirror provider is
a prerequisite for ordinary remote development or native proposal Git.

Optional CI is a separate untrusted execution boundary. Candidate-controlled
test scripts and results do not establish independent verification. Operators
choose pinned runner/job images, worker capacity and resource bounds. Workers
must not pass host runtime sockets, operator credentials, raw product secrets
or review/promotion authority into candidate execution. Service-side review
policy decides which matching evidence and human approvals permit promotion.

Secret-bearing deployments belong to reviewed infrastructure outside the
agent's nested engine and writable checkout. DIM does not automatically
provision a parallel trusted Project runtime. Any deployment interface must
constrain the requested action and use reviewed protected source; raw secrets
remain outside the development workspace. KVM/QEMU execution is an optional
worker concern and is not implicitly forwarded to the development agent.

SSH selects the host on which the same application and runtime operations run.
The client streams framed commands and bytes; it does not forward its Docker
socket or change the remote workspace's authority. Local forwarding binds a
specific workspace UUID so a reused display name cannot redirect an existing
connection to another workspace.
