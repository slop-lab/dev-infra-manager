# Workspace lifecycle

A base workspace has a host-generated immutable UUID, a user-facing name,
committed source identity, image, resource budget, Git author, timestamps,
initialization result and lifecycle phase. The current record schema is 10.
The exact parser validates the complete record before resource access. Managed
Project registration has separate state; its workspaces use this same record
and lifecycle with a host-side source attachment. An acquired multi-checkout
layout records independent source identities, immediate-child checkout paths
and a selected working directory. Its top-level source identifies the
configuration snapshot, which need not be seeded into the guest.

Creation serializes mutation, acquires a committed source snapshot, records
creation intent, creates owned runtime resources, starts the agent and private
Docker, and seeds the checkout once. A successful record is initialized and
running. A failed creation retains an error record for diagnosis and explicit
discard; start/restart/recreate do not turn an uninitialized checkout into a
ready workspace.

Start, stop and restart preserve checkout, home and nested Docker data.
Recreate replaces the container while keeping the same workspace identity and
volumes. It does not reset source or overwrite local work. Resources are
validated before mutation, verified against the runtime and recorded after
success. Removing a limit can require keep-data recreation, which is reported
to the caller.

List and show observe the runtime without rewriting persisted lifecycle state.
They distinguish running, stopped, missing and unavailable observations.
Command execution requires an initialized running workspace. Transport
cancellation terminates the host command process group; it is not a promise to
terminate arbitrary detached processes inside the workspace.

Runtime `running` does not imply every optional integration is usable. Failed
agent/plugin preparation returns a command failure and retains a running
workspace with an explicit integration error, leaving its processes and data
untouched. Show exposes that error; online discovery reports the failed
preparation without exposing private configuration. A successful preparation
retry clears its recorded failure. A concurrent stop or identity replacement
must not be overwritten by a delayed preparation result.

Before source/plugin preparation, a bounded read-only guest boot-identity
probe rejects unreadable or malformed Linux `boot_id` as a runtime identity
failure rather than blaming cache URLs or LLM routing. It preserves processes,
owned volumes and credentials; no automatic restart or runtime fallback is
authorized. Exact-UUID keep-data recovery requires operator-confirmed
quiescence across main sessions, subagents, teams and independent workloads;
unknown activity is not idle. See the
[operator recovery procedure](../guides/workspace-runtime-recovery.md).

Discard records intent and deletes only exact owned runtime resources. The
record is removed after cleanup succeeds. Interrupted or failed cleanup remains
retryable. Missing data on an initialized record is an error; DIM never replaces
it with a fresh empty volume during start or recreation.

There is no implicit migration from previous workspace formats. User-data
preservation requires an explicit export/import design, not adoption of old
runtime authority or reuse of a name.
