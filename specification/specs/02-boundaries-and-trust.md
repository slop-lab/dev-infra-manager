# Ownership and trust boundaries

## Client and host

The CLI selects a local or SSH host context, presents results and transports
input/output. Lifecycle and source acquisition execute on the selected host.
A source path is a path on that host. SSH uses the user's existing authentication
and host-key verification; DIM does not disable these checks.

Each host request invokes the host application. The base implementation needs
no resident controller. Its private state root is owned by the host user.
Optional managed services have separate state and runtime namespaces.

## Host and workspace

The host creates an unprivileged `sysbox-runc` container with private home,
checkout and Docker-data volumes. Runtime resources carry the workspace's
immutable identity and DIM ownership labels. Inspection verifies ownership and
expected attachments before lifecycle mutation. Name collisions do not grant
ownership. No host directory, device or control socket is passed into the
agent.

The host acquires a committed Git snapshot in temporary host storage and copies
it into the initial checkout. Host Git hooks, global filters and repository
configuration must not become a code-execution path during snapshot preparation.
Acquisition can use the operator's Git transport, but credential material and
host-only remote paths are not installed in the workspace. Later lifecycle
operations preserve the mutable checkout rather than reimporting source.

The agent owns its development processes and private nested Docker daemon.
Repository setup is development code inside that boundary; it is not a trusted
host lifecycle hook. A user may explicitly configure additional credentials
inside a workspace, but DIM does not copy them automatically.

## Optional managed authority

Managed Git, review, CI and secret-bearing services are separate capabilities.
Installing the base CLI grants none of their roles. Their host-side credential
and approval boundaries remain outside development containers. See
[managed trust boundaries](../../core/packages/managed/docs/trust-boundaries.md).
