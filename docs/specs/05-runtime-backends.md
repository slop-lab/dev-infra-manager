# Workspace runtimes

The supported base runtime is `container`: one unprivileged Sysbox agent
container on the selected Linux host. It is independent of local versus SSH
transport. There is no required trusted outer container in the base path.

The runtime adapter owns resource creation, inspection, command execution,
start/stop, keep-data recreation and deletion. Workspace application logic owns
identity, source, persisted phase and serialization; it does not interpret
Docker output. A future VM adapter must implement these responsibilities
without making transport or repository workflow rules runtime-specific.

The container owns three persistent named volumes: checkout, home, and private
Docker data. Recreate preserves them. Discard removes exact owned resources.
Initialized workspaces with a missing volume fail rather than silently acquire
an empty replacement. The runtime rejects unexpected mounts, privileged mode,
host devices and another workspace's resources.

CPU, memory and process limits apply to the agent container and its descendants.
Explicit `unlimited` values are supported. Finite live updates are checked by
read-back. Removing Docker limits uses keep-data recreation because zero-valued
Docker updates do not reliably remove existing limits. Disk quotas are not
provided. Runtime capability and resource enforcement must be described
honestly rather than inferred from a configured value.

VM support remains future work. No Incus or libvirt profile is currently
supported by the base application, and no fictional schema or compatibility
migration is reserved for it. Earlier managed VM design material is retained as
[design notes](../guides/runtime-backends.md).
