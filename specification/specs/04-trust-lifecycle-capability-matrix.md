# Trust and Lifecycle Capability Matrix

**Kind: Contract**

## Scope

This contract fixes the authority and state transitions shared by protected Git
promotion, workspace backends, Project lifecycle hooks, retained workspace
data, and External URL approval. Backend and plugin implementations MAY choose
different mechanisms only when they preserve every allowed and denied case
below.

A **workspace instance** is identified by the persistent Project ID and a
fresh, unguessable workspace ID created with the workspace record. A display
name is not an authority identity. The ID remains stable across stop, start,
restart, setup, and update. After discard, creating the same display name MUST
create a new workspace ID.

A **runtime generation** identifies one realization of that workspace
instance. Replacing a container, VM, or nested target changes its runtime
generation without changing the workspace ID.

## Protected source promotion

**TRUST-PROMOTION-001:** Every proposal for a protected ref MUST bind the
repository ID, protected ref, expected protected-ref head, candidate commit,
candidate tree, protection-policy revision, required-review revision, and
required-job-set revision. Commit and tree identities MUST be complete object
IDs. The review surface MUST show the complete base-to-candidate change set,
including additions, modifications, deletions, renames, file modes, and
symbolic links. Path-owner rules MAY add reviewers, but MUST NOT exempt any
path or turn a path-filter result into approval of only part of the candidate
tree.

A designated human reviewer MAY approve only that immutable proposal tuple.
The author, workspace writer, CI identity, and an identity controlled by the
candidate workload MUST NOT satisfy human review. Changing any bound identity
or policy revision makes the approval stale. Approval is review evidence, not
Git write authority.

CI results MUST bind the same repository, protected ref, candidate commit,
candidate tree, policy revision, required-job-set revision, job name, attempt,
and terminal result. CI MUST NOT update a protected ref, approve its own
candidate, or convert unavailable capacity into success.

**TRUST-PROMOTION-CAS-001:** Protected promotion MUST execute as one
serialized compare-and-swap operation. While holding the repository/ref
serialization boundary, the promoter MUST reread the protected ref and current
policy, verify that:

1. the live ref equals the proposal's expected head;
2. the candidate descends from that head under the selected merge policy;
3. the candidate commit and tree still match the reviewed proposal;
4. every required current human approval is present and not revoked;
5. every required current CI job has a successful terminal result for the
   exact promotion tuple; and
6. the provider can atomically update that exact old object ID to the exact
   candidate object ID.

Any mismatch MUST leave the protected ref unchanged. Concurrent promotions
from one expected head MUST permit at most one success. A retry after an
uncertain result MUST reread the ref and return the already-applied result only
when the exact candidate is current; it MUST NOT replay an update against a new
head. Protected-ref deletion and forced update are denied.

The host maintainer credential MAY perform this operation, provider repair,
and credential recovery. DIM MUST NOT expose a direct protected-write or
review-bypass operation to that credential. An operator action outside DIM's
promotion operation is break-glass host administration, not a successful DIM
review or promotion, and MUST NOT be reported as one.

| Actor or evidence | Allowed | Denied |
| --- | --- | --- |
| Workspace writer | Create and update proposal refs | Update, delete, or force a protected ref |
| Human reviewer | Approve or reject one immutable complete-tree proposal | Self-approve, approve only selected paths, or reuse approval after tuple drift |
| CI identity | Report one job attempt for the exact candidate tuple | Approve, merge, deploy, or report a different head/tree as the candidate |
| Host promoter | Perform the checked atomic old-ID to candidate-ID update | Bypass review/jobs, ignore policy drift, or overwrite a concurrently moved ref |
| Repository owner or provider administrator | Configure policy through host administration | Routine direct push or provider review bypass |

## Backend and guest authority

**TRUST-RUNTIME-001:** Backend mechanism is not a security conclusion. Every
backend MUST enforce the same capability decisions at its untrusted execution
boundary. The target backend identities are `container` for the Sysbox-based
workspace shape and `vm` for a persistent virtual-machine workspace. An
implementation MUST NOT represent a disposable CI VM or a Project-launched
QEMU process as the `vm` workspace backend.

The `container` profile MAY place trusted Project lifecycle execution in the
separate trusted outer workspace container. The `vm` profile MUST place
reviewed Project lifecycle execution and every secret-bearing service outside
the guest. The VM guest contains the untrusted agent and ordinary development
workloads. Host lifecycle code MAY control VM power, attach owned storage and
network interfaces, and dispatch through a bounded backend adapter. It MUST
execute authority-bearing Project hooks from the immutable approved root, not
from guest-writable data, and MUST NOT treat guest output as trusted executable
configuration.

| Capability or resource | Untrusted container or VM guest | Trusted Project lifecycle area | DIM host authority |
| --- | --- | --- | --- |
| Mutable workspace data and user home | Allowed for its own workspace | May attach or archive only owned data | May ownership-check and attach or remove it |
| Private nested container runtime | Allowed only for its own runtime | May own a separate Project runtime | Must not expose the host runtime socket |
| Proposal Git credential | Allowed, scoped to proposal refs | May receive only the credential its operation needs | Owns credential issuance and revocation |
| Agent controller or development-service capability | Allowed only for its workspace ID and declared audience | May construct a narrower reviewed proxy | Owns the authenticated endpoint and policy |
| Host-admin or workspace-controller socket/grant | Denied | Allowed only where the lifecycle operation requires it | Owns and scopes it |
| Host Docker, hypervisor, or generic controller socket | Denied | Denied as an unbounded pass-through | Allowed only to the responsible host service |
| Raw product/runtime secret or secret volume | Denied | Allowed only to the separate reviewed secret-bearing service | May inject it through the reviewed operation |
| Secret-bearing service control plane | Denied; only a fixed reviewed application protocol may cross | Owns deployment from the approved immutable root | May provide the narrow deployment capability |
| Host `/dev/kvm`, VM manager API, or privileged device control | Denied, including inside the `vm` guest | Container profile may receive only a separately recorded capability; VM profile uses no guest grant | May use KVM for the selected VM mechanism |
| Protected-ref maintainer, reviewer, or promotion credential | Denied | Denied | Allowed only to the corresponding host operation |

The guest network MAY reach explicitly configured workspace services and
ordinary network destinations allowed by the installation. It MUST NOT join a
host control network or gain a route that bypasses the scoped interfaces above.
Stopping or rebooting a VM MUST preserve its owned persistent data, but MUST
not move trusted lifecycle or secret-bearing execution into the guest.

The first VM implementation candidate is an implementation choice, not an
owner-trust decision. Incus VM with KVM is evaluated first. If it cannot pass
the same persistence, guest Docker, lifecycle, network, resource, recovery, and
memory-reclamation gates, another mechanism MAY be evaluated against unchanged
gates. No mechanism is supported until its live capable-host gate passes.

## Backend state compatibility

**STATE-BACKEND-001:** Backend identity is immutable for one workspace
instance. A workspace MUST NOT be changed in place between `container` and
`vm`, and data from one backend MUST NOT be mounted into another by name-based
adoption. The supported transition is export with the old backend, discard,
create a fresh workspace instance with the new backend, and explicit restore
of Project-owned data.

The historical `sysbox` value and target `container` value MUST NOT be accepted
as aliases. A release that still implements the historical profile continues
to accept exactly `sysbox` and MUST NOT write `container`. A release that
adopts this contract for new `container` state MUST reject existing `sysbox`
configuration, records, and labeled resources unchanged, with guidance to keep
the prior pinned release long enough to export data and recreate. It MUST NOT
silently rewrite records, relabel or adopt resources, or infer compatibility
from an equivalent runtime mechanism.

| Persisted input | Result |
| --- | --- |
| Missing state for a new workspace | Create state with the selected supported backend identity |
| Exact current schema and backend identity | Load only after ownership and schema validation |
| Historical `sysbox` read by a `container`/`vm` release | Reject unchanged with export/recreate guidance |
| Existing `container` workspace requested as `vm`, or the reverse | Reject unchanged; require export/discard/create/restore |
| Unknown backend, schema, field, label, or mixed identity | Reject before runtime, plugin, hook, or state mutation |
| Explicit migration not defined by a release contract | No migration authority exists |

The exact host lifecycle schema-1 to schema-2 migration remains the sole
existing automatic state migration and grants no precedent for backend,
workspace, Project, runner, or plugin state conversion.

Workspace schema `8` is the first schema implementing the workspace instance
identity in this contract. Schema-`7` workspace records MUST be rejected
unchanged with instructions to use the prior pinned release to export needed
Project/user data before discard and recreation. Implementations MUST NOT infer
an instance ID from the Project ID, display name, runtime resource, retained
volume, grant file, or plugin state.

## Workspace lifecycle and retained data

**WORKSPACE-AUTHORITY-001:** Grants, sockets, route approvals, device grants,
and protected credentials MUST bind to the workspace ID, not its display name,
volume name, container name, VM name, or runtime generation. Retained data is
not retained authority.

| Operation | Workspace identity and data | Hooks and root | Grants and External URLs |
| --- | --- | --- | --- |
| `create` | Creates a fresh workspace ID; may attach only an ownership-validated retained volume for the same Project, name, and backend | Selects one approved immutable root and runs the applicable setup default | Issues fresh grants; no prior route or approval is imported |
| `stop` | Keeps the workspace ID and persistent data; makes its runtime unavailable | Runs no setup or teardown | Terminates live flows/sessions; route records may remain but cannot forward |
| `start` | Keeps the workspace ID; creates or resumes an owned runtime generation | Selects an approved root and runs setup | Revalidates grants; preserves approval state only for the same route tuple and workspace ID |
| `restart` or `update` | Keeps the workspace ID and data; runtime generation may change | Selects and stages one approved root before lifecycle mutation, then runs setup; MUST NOT reuse the recorded root as a recovery fallback | Cannot broaden a grant; a changed route tuple requires a new pending request |
| `setup` recovery | Keeps identity and data unchanged | Replays only the recorded immutable root | Cannot mint unrelated authority or follow a moved ref |
| ordinary `discard` | Removes runtime, record, and DIM-owned data after ownership checks | Runs teardown with keep-volume false | Revokes routes and all server-side grants before removing state |
| `discard --keep-volume` | Removes runtime and record but retains only owned Project/user data | Runs teardown with keep-volume true | Revokes exactly as ordinary discard; retained bytes confer no authority |
| same-name recreation | Creates a new workspace ID and fresh runtime generation; may reuse validated retained data | Selects a currently approved immutable root | Issues fresh grants; old tokens, sockets, route IDs, approvals, slugs, and permalinks remain invalid |

Retained data MAY include agent home, installed user tools, authorized agent SSH
keys, and Project-owned nested storage. Those bytes carry agent-level authority
inside the new workspace only. Any retained copy of an old DIM token, grant,
socket path, URL credential, or approval ID MUST fail server-side
authentication because it names the discarded workspace ID. Creation MUST
recompute backend/device capabilities and MUST NOT infer them from retained
data.

Discard MUST atomically publish the non-ready `discarding` phase and revoke
controller grants before invoking route or Project cleanup. Authenticated
controller dispatch and startup route restoration MUST revalidate the workspace
ID and active phase under the same lifecycle serialization boundary. If cleanup
fails, the workspace MUST remain non-ready and all old grants and routes MUST be
denied while an ownership-safe retry completes.

## External URL approval

**URL-APPROVAL-001:** Each ingress declares whether host approval is required.
The externally observable approval value MUST distinguish `not-required`,
`pending`, `approved`, and `revoked`. For an approval-required ingress, a valid
workspace request reserves a route ID and its authorities in `pending`, but the
gateway MUST deny traffic until a host administrator approves it.

Approval MUST bind the workspace ID, route ID, ingress identity and policy
revision, exact logical target descriptor, protocol, port, and every mutable
slug or permalink authority returned for the route. The agent and workspace
grants MUST NOT approve a route. They MAY revoke their own route. Host
administration MAY approve a pending route or revoke any route after verifying
that exact tuple. Revocation is terminal; later exposure requires a new route
request and approval.

An approved route MAY follow a new runtime generation only when the workspace
ID and exact logical target descriptor are unchanged; existing flows MUST be
disconnected before rebinding. Controller restart preserves the recorded
approval value. Workspace stop makes the route unavailable without converting
`pending` to `approved`. Same-instance start may restore an `approved` route
after target resolution. Target, ingress policy, or workspace-ID change MUST
deny the old route. Mutable slug and permalink forms share one approval and
revoke together.

## Project-owned hook defaults

**PROJECT-HOOK-DEFAULTS-001:** Hook presence and hook bytes are selected only
from the immutable approved root. Mutable workspace or guest data MUST NOT add,
replace, or redirect a lifecycle hook. A backend MUST preserve these defaults:

| Root contents | Setup behavior | Task behavior | Discard behavior |
| --- | --- | --- | --- |
| `.dim/setup.sh` present | Trusted lifecycle area executes those immutable bytes | Unchanged | Unchanged |
| no setup hook, `.dim/docker-compose.yml` present | Trusted lifecycle area performs the documented Compose setup | Unchanged | Documented Compose teardown when no teardown hook exists |
| neither setup hook nor Compose file | Successful no-op | Unchanged | Successful no-op when no teardown hook exists |
| `.dim/entrypoint.sh` present | Unchanged | Dispatch through its immutable reviewed mapping | Unchanged |
| no entrypoint hook | Unchanged | Direct-command fallback in the backend's workspace execution boundary | Unchanged |
| `.dim/teardown.sh` present | Unchanged | Unchanged | Trusted lifecycle area executes it with the exact keep-volume value |

For the `vm` backend, the trusted lifecycle area in this table is outside the
guest. A hook may use the bounded backend adapter to prepare or dispatch guest
work, but the guest MUST NOT receive the lifecycle grant or execute the hook
with trusted authority.

## Verification mapping

**Kind: Verification**

| Contract | Required positive evidence | Required denial evidence |
| --- | --- | --- |
| `TRUST-PROMOTION-001`, `TRUST-PROMOTION-CAS-001` | Complete-tree proposal, current human approval, exact-head jobs, and one atomic promotion | Path-only review, stale/revoked approval, changed policy/tree/head, wrong job attempt, force/delete, and concurrent second promotion leave the ref unchanged |
| `TRUST-RUNTIME-001` | Same agent journey through each supported backend and live VM persistence/recovery on a KVM-capable host | Guest cannot read secrets, `/dev/kvm`, host/admin/runtime sockets, other-workspace data, or promotion credentials |
| `STATE-BACKEND-001` | Exact current state round-trips | Historical `sysbox`, cross-backend, mixed-label, and unknown state remain byte-for-byte unchanged with no runtime mutation |
| `WORKSPACE-AUTHORITY-001` | Stop/start preserves one instance; retained-volume recreation preserves declared data with a fresh workspace ID and grants | Old token, route, approval, permalink, device grant, foreign volume, and old runtime generation cannot authorize the recreated instance |
| `URL-APPROVAL-001` | Pending request becomes reachable only after host approval; same-instance restart preserves exact approval | Pending/revoked, cross-workspace approval, target change, replay, and same-name recreation remain unreachable |
| `PROJECT-HOOK-DEFAULTS-001` | Present and absent hook/default cases run from one immutable root on each backend | Guest mutation, symlink escape, moved root, or absent-hook inference starts no trusted hook |

Source and deterministic tests are necessary but do not prove a VM or hardware
boundary. Missing KVM or independent-host capacity MUST be reported as blocked,
not passed, and MUST NOT delay source-only enforcement of denied operations.
