# Workspace Runtime Backend

**Kind: Implementation profile**

## Scope

The currently implemented workspace backend is `sysbox`. Backend selection is
therefore not a Project extension point in this implementation profile. The
target multi-backend contract reserves `container` for this Sysbox-based shape
and `vm` for a persistent VM shape, but this profile makes no claim that either
target identity is implemented. `TRUST-RUNTIME-001` and `STATE-BACKEND-001` in
[Trust and Lifecycle Capability Matrix](04-trust-lifecycle-capability-matrix.md)
define the gate and incompatible-state transition for a release that adopts
them.

The trusted workspace infrastructure container is a privileged Docker
container using the host's ordinary `runc` runtime. It owns the Project engine,
reviewed setup process, controller grant, and any secret-bearing services. The
untrusted agent runs separately in a host-side, unprivileged `sysbox-runc`
container with private rootless Docker. Running trusted infrastructure with
`runc` is an internal implementation dependency, not a selectable workspace
isolation backend.

Workspace metadata and managed-container labels MUST record `sysbox`.
Configuration or existing state naming any other backend MUST be rejected;
DIM does not provide compatibility aliases or state migration for removed
pre-stable backends. In particular, a later `container` release MUST reject
this historical `sysbox` state unchanged rather than treating the two names as
aliases. Operators preserve needed data through the old pinned release's
export path, discard, fresh creation, and explicit restore.

DIM persists the trusted Project Docker engine at `/var/lib/docker`. The daemon
MUST disable Docker's containerd snapshotter because Docker 29 otherwise keeps
image data outside that managed volume.

When host `/dev/kvm` exists as a character device, a workspace may receive it
and its numeric host group according to the creation-time KVM policy. KVM is an
optional workspace capability and MUST NOT be required by Sysbox installation
or backend doctor checks.
Disabling KVM requires DIM to omit its explicit device and group grant; it does
not promise that a privileged trusted runc container lacks the device path.
Device isolation is mandatory at the untrusted agent boundary and is verified
after that Project-owned container exists, outside workspace lifecycle and
setup operations.

Agent containers are Project-owned workloads, not core lifecycle resources.
Reviewed `.dim/setup.sh` code may build and start one through the nested Project
engine, while `.dim/entrypoint.sh` maps `dim workspace run` tasks into it. DIM
does not define an agent manifest, image schema, container name, or separate
resource record.

Projects receive `DIM_WORKSPACE_BACKEND=sysbox` and
`DIM_NESTED_ENGINE=docker`. Project-owned containers remain within the
workspace resource boundary.

## Target multi-backend profile

**Status: design target, not implemented or supported.** The target profile
below makes `TRUST-RUNTIME-001`, `STATE-BACKEND-001`,
`WORKSPACE-AUTHORITY-001`, and `PROJECT-HOOK-DEFAULTS-001` implementation-ready.
It does not authorize this release to accept `container` or `vm`, write target
state, install Incus, or report a VM gate as passed. The current `sysbox` rules
above remain authoritative until a release implements a target profile and its
live capable-host gate passes.

The target backends have these capability decisions:

| Capability | `container` profile | `vm` profile |
| --- | --- | --- |
| Implementation profile | `sysbox-container` version `1` | `incus-vm` version `1` is the first candidate |
| Untrusted execution boundary | Unprivileged `sysbox-runc` agent container | Incus instance whose type is exactly `virtual-machine` |
| Trusted Project lifecycle | Separate trusted outer `runc` container | Host-side lifecycle service outside the guest |
| Approved root and hooks | Read-only in the trusted outer container; never writable by the agent | Kept outside the guest; host-side lifecycle reads the immutable root and uses only the bounded guest adapter for untrusted work |
| Secret-bearing services | Separate from the agent and its private runtime | Outside the guest and deployed by the host-side trusted lifecycle area |
| Nested container use | Private rootless Docker inside the agent boundary | Private rootless Docker inside the guest; Docker-outside-of-Docker consumers receive only the same backend-neutral bounded interface |
| Host control | No host Docker, host-admin, generic controller, or hypervisor socket in the agent | No host Docker, Incus, libvirt, host-admin, generic controller, or Project-runtime socket in the guest |
| KVM and devices | Optional recorded KVM grant exists only in the trusted outer area; never in the untrusted agent | Host Incus may use `/dev/kvm`; the guest receives neither `/dev/kvm` nor nested virtualization, PCI, USB, GPU, Unix-device, or arbitrary proxy grants |
| Network | Project services and ordinary installation-permitted destinations through scoped interfaces | One owned managed NIC; no physical host bridge, host control network, or route around scoped service interfaces |
| Persistent data | DIM-managed workspace data and Project-owned nested data | Separate owned data volume for Project data, agent home, and private nested-runtime data; no host-path or secret-bearing disk |
| Resource boundary | Host cgroup enforces CPU, memory, and PID limits | Incus enforces vCPU and memory; the release-owned guest workload service enforces the recorded PID limit around all agent and development workloads |
| Stop and start | Preserve the workspace ID and owned data; runtime generation may change | Stop/reboot preserve boot and data disks; host restart reconciles the exact owned instance before a new runtime generation becomes ready |
| Discard | Revoke authority, remove runtime, and remove or explicitly retain eligible data | Revoke authority first, remove instance/root disk/network, and remove or explicitly retain only the owned data volume |

A backend-neutral interface MUST expose only declared workspace operations and
capabilities. It MUST NOT return a Docker, Incus, libvirt, QEMU, or controller
endpoint. An implementation MUST NOT satisfy the `vm` profile by wrapping a
disposable CI VM or a Project-launched QEMU process.

## Incus VM candidate version 1

`incus-vm` version `1` is an evaluation profile. The implementing release MUST
pin the Incus client and daemon compatibility range, QEMU package, guest image
fingerprint and digest, guest-agent input, cloud-init template, storage driver,
and network policy. Moving image aliases such as `latest` are invalid inputs.
The host Incus API is available only to the responsible trusted host service.

### Host project and resource ownership

DIM MUST create one restricted Incus project for each DIM Project. It MUST NOT
adopt a pre-existing project by name. Before creation, exact not-found is the
only result that establishes absence; any existing same-name project without
the exact provider binding described below is a foreign collision.

The target host state owns a separate runtime-provider binding record at
schema version `1` for `incus-vm` version `1`. It contains exactly the DIM
Project ID, generated provider Project ID, provider Project name, backend
profile and version, ownership digest, allowed network-policy and storage-pool
IDs, phase (`creating` or `ready`), nullable creation-attempt ID, and creation
and update timestamps. `creating` requires the matching attempt ID; `ready`
requires `null`.

Only a first-time preflight that observes both no binding record and exact
Incus-project not-found may write a `creating` binding and issue the provider
create with the same identity in its initial metadata. A retry of `creating`
may create after exact not-found or continue after every provider field matches;
an uncertain, partial, or mismatched result is quarantined. Successful provider
inspection atomically changes the binding to `ready` and clears the attempt ID.
For a `ready` binding, reconciliation requires the project and every field to
match. A missing record paired with an existing project, a missing project for
a ready record, partial or changed metadata, unknown field, or name collision
MUST fail closed rather than recreate, adopt, relabel, or delete the project.
The binding is shared by the Project's workspaces and may be removed only by
explicit Project removal after no workspace references it and an exact
ownership reinspection succeeds.

The Incus project MUST set `restricted=true` and
`restricted.backups=allow`, enable project-owned profiles and storage volumes,
restrict NICs and disks to managed resources, restrict accessible networks and
storage pools to the recorded allowlist, and block PCI, proxy, Unix-device,
low-level VM, and nested-virtualization configuration. Restricted Incus
projects otherwise default `restricted.backups` to `block`; version `1` pins
`allow` because its required instance and custom-volume export gate uses the
backup API. This permission does not grant backup authority to the guest: only
the trusted host service receives the Incus API socket and credential, and it
MUST ownership-check the stopped instance or volume before export. Project
aggregate CPU, memory, disk, and VM-count limits MUST be finite host policy even
when a workspace requests an unlimited per-workspace value in a later contract.

Every instance, custom volume, and network MUST carry provider metadata for the
DIM Project ID, workspace ID, backend identity, backend profile and version,
resource kind, generated resource ID, and ownership digest. Provider names are
locators, not authority. A missing, partial, malformed, foreign, or mismatched
metadata set MUST be rejected without adoption, relabeling, attachment, or
deletion. An operation that cannot distinguish absence from an inspection
failure MUST fail closed.

After preflight and before the first provider create request, DIM MUST durably
write a creation-attempt record containing a fresh attempt ID and every planned
generated resource ID and provider name. Each create request MUST publish the
complete attempt ID and planned resource identity as part of initial provider
metadata, not as a later relabel. Failure cleanup may delete only a resource
whose complete metadata matches that exact live attempt record. Missing or
partial metadata, a missing attempt record, or an uncertain create result MUST
quarantine the resource for administrator reconciliation and MUST NOT delete
it. Successful creation atomically transfers the exact shared Project identity
into the runtime-provider binding and the workspace resource identities into
the workspace record before retiring the attempt record.

### Guest, devices, and boot

Creation MUST use the Incus equivalent of `init --vm`, configure the complete
stopped instance, inspect its expanded configuration, and only then start it.
The root disk MUST come from the pinned guest image in an allowed managed
storage pool. Cloud-init contains only release-owned immutable bootstrap bytes,
non-secret workspace identity, and non-secret bootstrap configuration. It MUST
NOT contain product/runtime secrets, host credentials, lifecycle grants, or
provider control endpoints.

The Incus guest agent provides bounded command, file, readiness, and metrics
operations to the host adapter. The instance configuration MUST set
`security.guestapi=false`; `/dev/incus`, a raw Incus socket, provider
credential, and every optional guest-agent feature not required by those four
operations MUST be absent. The read-only agent config device MAY refresh the
agent and its host-authenticated transport but MUST NOT expose provider API
authority to guest processes. Project hooks remain host-side; commands
dispatched into the guest and all guest output are untrusted. Agent readiness
has a 120-second timeout and is required before setup can publish the workspace
as ready.

The expanded device set MUST contain only:

1. one managed root disk;
2. one managed custom data volume;
3. one managed network interface on the owned workspace network;
4. one read-only disk whose source is exactly `agent:config` for the
   release-pinned Incus agent; and
5. one read-only generated cloud-init disk whose source is exactly
   `cloud-init:config`. Incus MUST generate it from the pinned
   `cloud-init.user-data`, `cloud-init.vendor-data`, and
   `cloud-init.network-config` instance keys plus deterministic metadata whose
   only keys are `instance-id` and `local-hostname`; both values MUST equal the
   exact recorded provider instance name. `user.meta-data` and the legacy
   `user.user-data`, `user.vendor-data`, and `user.network-config` keys MUST be
   absent, and every other legacy `user.*-data` cloud-init input MUST be
   rejected.

DIM MUST verify the expanded configuration and approved inputs before first
start. Because Incus renders the generated ISO when the disk device starts,
the first start MUST be a controlled validation boot. Using the pinned guest
image and authenticated Incus agent, DIM MUST read the mounted read-only media
and verify the exact approved payloads plus `instance-id` and `local-hostname`
equal to the recorded provider instance name. Until that validation succeeds,
DIM MUST NOT accept workspace readiness, run a Project hook, issue a grant,
enable a route, or dispatch Project or user code. An extra, missing, or changed
key is a device mismatch and MUST follow the non-ready boot-failure policy.

The profile MUST reject host-path disks, secret volumes, physical or SR-IOV
NICs, arbitrary proxy devices, host Unix devices, host `/dev/kvm`, and every
additional configured device before starting the instance. Incus-internal
emulated hardware that is not a configurable instance device MUST match the
pinned QEMU/profile inspection baseline. TPM, GPU, USB, PCI, Unix block or
character, nested-virtualization, and configurable serial/proxy devices are not
part of version `1`. The agent runs as a non-root guest user without authority
to reconfigure the VM, the workload cgroup, or the release-owned guest service.

### Network

Each workspace MUST receive one DIM-owned managed network or isolated OVN
network and one managed NIC. MAC, IPv4, and IPv6 filtering MUST bind the
observed addresses. Default policy MUST deny traffic to other workspace
networks, the Incus host API, host Docker and controller endpoints, metadata
services not owned by this profile, and host control networks. Explicit rules
MAY allow ordinary installation-permitted egress and exact Project services.
Those rules do not turn DIM into a general Internet policy engine.

Host and Project services MUST identify the workspace through its authenticated
grant, not an IP address. Runtime-generation replacement MUST terminate old
flows before rebinding a logical service target. The guest MUST NOT receive a
second unmanaged NIC or select a parent bridge.

### Storage and data lifecycle

The VM root disk is backend runtime state. It persists across stop, start, and
reboot, but is removed on discard and is not a portable data contract. A
separate managed custom volume contains only Project/user data, agent home, and
private nested-runtime data at the documented guest data path. It MUST NOT
contain host lifecycle state, DIM grants, provider credentials, approved-root
authority, or secret-bearing service data.

Ordinary discard removes the exact owned instance, its snapshots, root disk,
network, and data volume. `discard --keep-volume` removes the instance,
snapshots, root disk, and network but changes the exact owned data-volume record
to a retained, unattached state. Same-name recreation MAY attach that volume
only through its retained record after validating Project, workspace name,
backend, profile version, generated resource ID, and absence of another active
owner. It MUST issue a fresh workspace ID and runtime generation and MUST NOT
restore grants, routes, approvals, device decisions, or credentials from its
bytes.

Incus instance snapshots and exports do not include an attached custom data
volume. Recovery evidence MUST therefore back up and restore the data volume
separately. Provider snapshots and exports are operational recovery inputs,
not cross-backend migration formats. Cross-backend transfer uses the reviewed
Project data export described below.

### Resource behavior

The profile MUST use a numeric vCPU count so CPU hotplug remains observable;
topology syntax that disables hotplug is outside version `1`. It MUST apply and
read back the effective Incus CPU and memory configuration and observe the same
values through the guest agent before persisting a resource update.

Memory increase MAY use hotplug. Memory decrease MUST use the configured
virtio balloon and wait for both host-visible allocation and guest-visible
memory to reach the requested value plus at most the greater of 64 MiB or two
percent within 120 seconds. A timeout, missing agent, balloon refusal, or
partial resource update MUST roll back to the prior effective values and leave
the persisted resource record unchanged. If rollback or read-back is uncertain,
the workspace remains non-ready and no success is reported. The candidate
profile MUST NOT become supported unless its live gate demonstrates at least
one successful decrease to a lower finite target within that bound; rollback
is failure handling for an individual update, not a substitute for working
memory reclamation.

The pinned guest image MUST contain a root-owned, non-writable
`dim-guest-workload` launcher and systemd slice. The host adapter invokes only
that fixed launcher through the authenticated guest agent; it runs the command
as the non-root agent user below `dim-workspace.slice`. The slice sets
`TasksMax` to the recorded PID limit and delegates only the child cgroup
controls required by private rootless Docker. Workspace task dispatch, the
private Docker daemon, nested containers, setup-requested guest commands, and
all supported login or service entry points MUST use that launcher. Direct
guest SSH, cron, system units, and alternate command transports are disabled
unless a later profile routes them through the same slice.

Before readiness, the host adapter MUST read back `TasksMax`, inspect every
agent-user process and private-runtime process as a descendant of the slice,
and prove that the agent cannot write the parent cgroup or root-owned launcher.
The release-owned service is a resource-enforcement mechanism inside an
untrusted guest; it is not Project lifecycle code and receives no secret or
host capability. If a host/profile combination cannot enforce any configured
CPU, memory, or PID value, it MUST reject the workspace before guest or state
mutation rather than silently weaken that limit. Storage capacity and quota
enforcement MUST be reported separately; this profile does not convert a
non-enforcing directory storage pool into an enforced disk quota.

### Failure and recovery policy

| Failure point | Required result |
| --- | --- |
| KVM, Incus, image, storage, network, restriction, or resource preflight | Reject before creating state or provider resources |
| Same-name or same-ID foreign resource | Preserve it and reject; never adopt, relabel, stop, attach, or delete it |
| Failure before instance start | Remove only resources whose complete identity matches the live creation-attempt record; quarantine partial or uncertain resources and retain diagnostics |
| Boot, cloud-init, guest-agent, nested-Docker, or readiness timeout | Run no Project hook, issue no ready grant, leave no ready record, and clean only exact newly created resources |
| Incus API timeout or unknown operation result | Reinspect by recorded project and generated resource ID; converge only from exact owned state, otherwise remain non-ready without replaying a destructive action by name |
| Network, disk, or device attachment mismatch | Stop before hook execution and remove or quarantine only exact owned partial resources |
| Live CPU, memory, balloon, or PID update failure | Restore and verify prior effective values before keeping the prior record; otherwise publish non-ready error state |
| Host power loss or Incus restart | Reconcile exact metadata, disks, network, and guest readiness before preserving the workspace ID and publishing a new runtime generation |
| Discard interruption | Old grants and routes remain revoked; retry exact-owned cleanup from `discarding`; foreign and ambiguous resources remain untouched |
| Export or restore failure | Preserve source data and destination non-ready state; do not delete the source or report migration success |

Automatic provider fallback is forbidden. A failed Incus create MUST NOT retry
with another hypervisor, profile, or device set. This prevents one workspace
record from acquiring mixed identity and makes partial cleanup reviewable.

## Versioned target state and transition

The first release that adopts `container` or `vm` MUST bump workspace records
from schema `8` to schema `9`. Schema `9` retains the schema-`8` `workspaceId`,
name, Project identity, immutable root repository/ref/commit, canonical
workspace-data path, phase, profiles, capability results, Compose Project name,
resource values, routes, Git identity/base URL, host aliases, manifest path,
timestamps, setup result, and error fields with their existing meaning. It
removes the Docker-specific `containerName`, `networkName`, `dockerVolumeName`,
and ambiguous `kvm` fields. The following exact fields are added or replaced;
the JSON is an embedded fragment, not a complete workspace record:

```json
{
  "schemaVersion": 9,
  "runtimeBackend": "vm",
  "runtimeBackendProfile": {
    "name": "incus-vm",
    "version": 1
  },
  "runtimeGeneration": "fresh-256-bit-identity",
  "runtimeResources": {
    "providerProjectId": "project-owned-binding-id",
    "instance": {
      "id": "generated-provider-resource-id",
      "name": "non-authorizing-provider-locator"
    },
    "dataVolume": {
      "id": "generated-provider-resource-id",
      "name": "non-authorizing-provider-locator"
    },
    "network": {
      "id": "generated-provider-resource-id",
      "name": "non-authorizing-provider-locator"
    }
  }
}
```

For `container`, `runtimeBackendProfile` is exactly
`{"name":"sysbox-container","version":1}` and `runtimeResources` contains
exactly `container`, `dataVolume`, and `network` objects with the same exact
`id` and `name` fields. The VM `providerProjectId` is a foreign key to the
Project-owned runtime-provider binding, not a workspace-owned Incus project.
All generated IDs are immutable random identities stored both in state and
provider metadata; names are non-authorizing locators. Exact-schema parsing
MUST reject missing, extra, unknown, or mistyped schema-`9` fields. Current
schema-`8` fields not explicitly retained above MUST NOT be inferred or copied.

The transition matrix is:

| Input to a target schema-`9` release | Result |
| --- | --- |
| New workspace with a release-supported backend/profile and successful local preflight | Create schema `9` state only after ownership-safe resource creation reaches its documented commit point |
| Exact schema `9`, backend, profile/version, resources, labels, and ownership | Reconcile only those exact resources |
| Schema `8` record with historical `runtimeBackend: "sysbox"` | Reject byte-for-byte unchanged with old-release export/discard/create/restore guidance |
| Configuration value `sysbox` read by a target release | Reject unchanged; it is not an alias for `container` |
| Existing `container` requested as `vm`, or `vm` requested as `container` | Reject unchanged before provider access |
| Unknown schema, backend, profile, profile version, resource field, label, or mixed provider identity | Reject unchanged before plugin, hook, grant, network, storage, or runtime mutation |
| Retained volume from another backend/profile or without the exact retained record | Reject without attachment or metadata change |
| A release that has not passed the VM live gate sees `vm` or `incus-vm` | Reject as unsupported before state or provider mutation |

No schema `8` to schema `9` workspace migration exists. To preserve data, the
operator MUST keep the prior exact DIM release and backend available, stop new
work in the workspace, and run the reviewed Project-owned export/backup task
from that release. The export MUST be a backend-neutral archive of declared
Project/user data written outside DIM state and provider resources, with its
integrity recorded. Raw Docker/Incus volumes, engine stores, workspace records,
grants, sockets, route state, and device decisions MUST NOT be imported.

After validating the archive, the operator discards the old workspace with the
old release, installs the target release, selects the new backend, creates a
fresh workspace instance, and invokes the reviewed restore task. A retained
`sysbox` volume is not a transfer mechanism and MUST be removed with the old
release after successful export. If old state cannot be read by the old pinned
release or export fails, the transition stops without modifying that state.

## Incus trial gate and fallback

The `incus-vm` version `1` candidate becomes supported only after one exact
implementation revision passes all of these checks on a disposable
KVM-capable host:

1. create, stop, start, reboot, restart, update, forced host power loss, and
   discard preserve or remove the exact data described above;
2. the guest runs the pinned private rootless Docker workload while Project
   lifecycle and secret-bearing services remain outside it;
3. guest attempts to access secrets, secret volumes, another workspace,
   `/dev/kvm`, host Docker, Incus, controller/admin, Project-runtime, and
   promotion credentials fail;
4. the managed NIC reaches allowed destinations but not other workspaces or
   host control networks;
5. finite CPU, memory, and PID limits are observed, a memory increase succeeds,
   and at least one balloon-based decrease to a lower finite target, with guest
   resident use below that target, converges within 120 seconds and the stated
   tolerance; a separate injected refusal or timeout preserves the prior
   effective state, and a candidate whose every decrease fails cannot pass;
6. while stopped, the root instance and custom data volume are exported
   separately, each archive receives a SHA-256 digest, and clean recovery
   recreates the restricted Project/network, restores the data volume before
   the instance, validates every identity before attachment, and reaches guest
   readiness without importing authority state;
7. injected failure at every create and discard phase leaves no foreign
   mutation, no usable old grant, and no unexplained owned residue; and
8. guest mutation of hook paths, a forged adapter request, replayed guest
   output, and attempts to invoke, replace, redirect, or replay a trusted
   Project hook execute no trusted hook; and
9. the evidence records exact DIM source, kernel, KVM, Incus, QEMU, image,
   storage, and network identities plus cleanup results.

Source checks, Docker-only tests, an Incus container, or a QEMU CI guest cannot
satisfy this gate. Missing KVM or another prerequisite is `BLOCKED`, not
`PASS`, and leaves `vm` rejected.

Only after a reproducible Incus failure against this unchanged gate may the
host-owned `libvirt-vm` version `1` profile be evaluated as the alternate
candidate. That profile MUST use persistent `qemu:///system` libvirt domains,
managed disks and isolated networks, stable domain UUIDs and metadata, and a
virtio balloon; ad-hoc `qemu-system-*` processes are not eligible. The failure
record MUST include exact versions, commands, logs, failed criterion, and
ownership-safe cleanup. The alternate receives no relaxed capability, state,
recovery, resource, or negative gate. Selecting it requires an explicit
release profile and fresh workspace creation; it is never a runtime fallback
for an `incus-vm` record.
