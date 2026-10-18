# System goals

DIM provides persistent development workspaces on Linux hosts. A developer can
use the local host or select a remote host over SSH, create a workspace from an
ordinary Git URL or host-local repository, run commands and nested containers,
and resume the same checkout and home directory across sessions.

The base product does not require Project registration, a managed Git service,
a host controller daemon, a workflow definition, or a reviewed `.dim` directory.
Host transport and workspace runtime are separate responsibilities. SSH chooses
where DIM operates; the container runtime chooses where development code runs.

The host owns workspace identities, lifecycle records and runtime resources.
The client presents commands and transports requests. Repository code owns its
build, tool setup and development processes. Optional packages may provide
managed Git, review, CI, external URLs and shared services without making those
features prerequisites for ordinary development.

Isolation is practical containment for development, not a guarantee against a
kernel exploit or a compromised administrator. Agent code receives neither the
host Docker socket nor automatic access to operator credentials. Ordinary Git
credentials used by the host to acquire source are not copied into the agent.

Workspaces persist until explicitly discarded. Lifecycle failures preserve
recoverable data and report incomplete state. A runtime resource with uncertain
ownership must not be adopted or removed merely because its name matches.

Only the installer facade is a preserved public compatibility boundary. Other
pre-stable contracts may change intentionally, with source, documentation and
meaningful verification updated together.
