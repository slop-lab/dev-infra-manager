# Workspace runtimes

The supported base runtime is `container`: one unprivileged Sysbox agent
container on the selected Linux host. It is independent of local versus SSH
transport. There is no required trusted outer container in the base path.

The runtime adapter owns resource creation, inspection, command execution,
start/stop, keep-data recreation and deletion. Workspace application logic owns
identity, source, persisted phase and serialization; it does not interpret
Docker output. Plugin runtime adapters implement these responsibilities
without making transport or repository workflow rules runtime-specific.

The container owns four named volumes: checkout, home, private Docker data,
and private temporary data. Recreate preserves them. Discard removes exact owned resources.
Initialized workspaces with a missing volume fail rather than silently acquire
an empty replacement. The runtime rejects unexpected mounts, privileged mode,
host devices and another workspace's resources. A trusted runtime plugin may
explicitly construct the container adapter with reviewed device mappings; the
adapter checks the exact source, destination and permissions on every inspection.
The base `container` provider passes none. Repository configuration and guest
requests cannot supply device mappings.

Internal guest-to-host services use one host-initiated runtime execution channel
with a guest-loopback adapter, not per-workspace bridge/IP/port firewall rules.
The host dispatches only statically registered service IDs for the immutable
workspace identity and current runtime. Plugins retain their own authentication,
capability grants and authorization; core does not interpret Git or LLM policy.
Streaming backpressure and cancellation cross the channel without buffering
whole Git packs or model responses. Channel replacement never replays requests,
does not abort the host operation performing a self-restart/recreate, and
reconnects only while the same workspace remains running. Explicit external
ingress reachability is a separate operator requirement. No host control socket,
Docker socket or operator credential is mounted into the guest.

CPU, memory and process limits apply to the agent container and its descendants.
Explicit `unlimited` values are supported. Finite live updates are checked by
read-back. Removing Docker limits uses keep-data recreation because zero-valued
Docker updates do not reliably remove existing limits. Disk quotas are not
provided. Runtime capability and resource enforcement must be described
honestly rather than inferred from a configured value.

The optional KVM host plugin supplies `container-kvm`, exposing only the reviewed
KVM device to a Sysbox workspace. The operator prepares a private device node;
the plugin does not change the host's `/dev/kvm` permissions, expose host directories,
grant privileged mode, or expose the host Docker socket. Creating a VM through
the KVM API from the actual workspace user is the functional acceptance check.

The optional VM host plugin supplies an Incus VM backend with explicit host
configuration and resource admission. Its configuration and implementation
belong to that plugin. See the [runtime guide](../guides/runtime-backends.md).
