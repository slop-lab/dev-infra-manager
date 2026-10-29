# Git CI integration

`@slop-lab/dim-control-plane-plugin-git-ci` adapts `@slop-lab/gs-ci` to DIM's
control-plane registration and independently deployed execution coordinator.
GS owns workflow planning, immutable multi-repository execution inputs,
required-job evidence semantics, plan storage and the durable CI outbox. This
package retains DIM Project/generation mapping, `.dim` compiler selection,
candidate read HTTP leases, execution grant/profile codecs, credentials and
scheduler transport. It does not own Git repository registration, human
approvals, protected-ref compare-and-swap or worker runtimes.

The DIM adapter registers a `git-ci` ref-update provider and maps its check to
the GS provider with the repository adapter's borrowed-read authority. Thus a
policy declaring `git-ci` cannot load without its authorization provider, and
final promotion rechecks GS evidence without reacquiring the DIM mutation lane.

Install it as a control-plane plugin alongside `git-repositories`, `code-review`
and a workflow compiler such as `ci-workflows`. Add `merge-policy` when protected
ref promotion must require these results; run the separate `execution-scheduler` coordinator and
host `execution-worker` plugin for execution. A repository service and human review can
run without Git CI or any workflow compiler. In that composition candidate
workflow files are never interpreted.

The plugin attaches to the repository service's existing HTTP listener and
repository-scoped mutation lanes, exclusive lifecycle/sweep fence and bounded
read admission. Candidate Git/status reads bypass mutation queues and retain
fresh authority checks; grants/evidence and promotion share their repository's
mutation lane. Configure distinct private `grantIssuer`, `candidateReader`,
`resultReporter` and `webhook` credentials; `webhook` additionally has the CI
intake `endpoint` URL. `compiler` selects an installed compiler by extension name
and defaults to `dim`. The core control-plane runtime only resolves declared
extensions; it contains no workflow-specific configuration fields.

## Reviewed repository policy

The repository policy's `extensions["git-ci"]` contains `ciRepositoryIds` and
`requiredJobs`. The allowlist must include the repository itself. Each required
job specifies its name, execution kind (`ordinary-sysbox` or `qemu`) and
`candidate-controlled` evidence class. Job revision digests are derived from the
normalized list rather than supplied in policy. Without an explicit `git-ci` policy namespace, this plugin does not read the
repository workflow, attach a CI plan or require execution evidence. An enabled
namespace with an empty `requiredJobs` list still plans and runs candidate jobs. A policy requiring a disabled extension is rejected;
removing a plugin never silently skips a required quality check.

A candidate workflow may select a subset of the trusted repository allowlist.
Planning captures exact commit/tree tuples once, binds them into the review
identity and independently stores the immutable CI plan. Review envelopes contain
a generic attachment reference, not compiler-specific job data. Only Git CI
interprets that attachment and derives execution events. A changed dependency
head invalidates stale authority; retrying execution never changes the captured
inputs. A new explicitly resolved review captures a new snapshot and needs its
own approval. The full reviewed policy digest is bound to the review, so policy
changes also require approval again.

## Evidence and isolation

The existing execution endpoints issue grants, short-lived read leases and
accept bounded result evidence. A read lease is restricted to its Project and
exact selected repositories. Every Git request revalidates the current reviewed
snapshot and attempt. The merge quality guard checks the current plan and each
required successful result while the repository authority gate is held. It
returns evidence references to merge-policy, which retains final protected-ref
CAS authority.

Plans, grants, results and delivery markers are private control-plane records
inside the owned repository directories; CI result logs stay in the CI service.
No host workspace store, host runtime backend or account credentials are loaded
by this plugin. Public-only jobs never receive unselected private repositories
or reusable repository credentials. A recorded delivery remains completed across
repository-service generation or worker-image replacement during automatic
startup. A current, fully revalidated workspace request or human review action
records a generation-scoped delivery intent and may run the same immutable event
once in the new generation. Duplicate explicit requests share that intent. The
configured service and destination remain part of both completion and intent
identity; an intent for another destination cannot override them.
Every delivery, including an event without a completion marker, requires that
matching current-generation intent. Old unacknowledged envelopes alone cannot
authorize work at startup or after a destination change. Explicit ordinary-branch
merge preparation uses the same accepted-review path to publish its CI intent.
Legacy proposal pushes wait only for a durable raw-job handoff. Review matching,
workflow planning and delivery acceptance happen asynchronously, with per-job
pending/failed/stale/ready inspection. Live proposal acceptance is journaled before review publication; a same-generation
restart can finish an interrupted intent publication after rechecking the exact
review, policy, refs and inputs. Another generation cannot resume that action,
and an unresolved envelope remains approval/promotion-blocked until a fresh
explicit acceptance succeeds. Preparation readiness is not successful CI evidence.

## Intent-first delivery lookup

The durable intent is the outbox authority. Startup validates private bounded
records, filename identities and exact event provenance, then primes a
process-owned catalog ordered by verified creation/review/job/event metadata.
Owner publication and replacement update binding/state buckets under the intent
queue. Warm polling queries the current generation/service/destination bucket,
not the full retained history, and rereads each selected canonical intent before
network delivery. No current intent means no historical review or CI-plan body
materialization. Completed, foreign-generation/destination and future-suppressed
intents do not trigger work; backward wall-clock movement restores future backoff.

Every catalog reuse verifies the private directory's inode and nanosecond version.
Namespace changes trigger enumeration; replacement or disappearance of known
state fails closed. No filesystem watch is required: reconciliation checks every
known file's exact version when the directory namespace changes, and selected
intents receive stable FD/path checks. Unchanged reads do not rewrite directory
permissions and invalidate their own snapshots. Explicit audits revalidate all canonical records,
including inactive entries. Catalogs are capped at 4,096 directories, with a
process-wide 100,000-entry and 512 MiB encoded-data budget. Capacity exhaustion
fails closed without forgetting known state. Direct unprimed library use may
resolve the active set once to establish ordering; production startup and
owner-published records prime it before normal polling.

Capacity reservations span asynchronous publication. An unresolved extant write
keeps a named reservation outside selectable buckets until its exact expected
state or known old state is verified; recovery consumes or releases it once.
Failed initial catalog loads release only their uncommitted directory slot.
Missing known storage is an error, not permission to recreate an empty outbox.

Selected intents resolve only their referenced review-ID variants and the exact
CI envelope/event digest. A compact review source is process-issued after full
canonical validation; a bounded CI projection cache rechecks that source and the
exact private plan file version on every use. Existing review, plan, CI-envelope
and event digest domains remain unchanged. Matching canonical variants must
produce identical event bytes; ordering uses the earliest creation time.

Acknowledgement and rejection reread the current canonical intent and selected
provenance before mutation. A recorded marker is persisted before completing its
intent. Rejection backoff belongs to the generation-scoped intent; deployed
schema-v3 generationless rejection markers remain readable but cannot suppress a
fresh-generation explicit intent. Startup audits historical reviews, attached
plans and marker/event provenance once; inactive history is not reparsed on idle
ticks. Missing canonical provenance cannot masquerade as an empty durable outbox.
An exact current-generation recorded marker repairs an unfinished intent under
the same marker-to-intent lock order, without replaying execution. Interrupted
intent repairs use intent staging, never marker staging.

Projection reuse is limited to 1,024 entries and 8 MiB of encoded compact data;
concurrent identical cold reads share work, and a paused warm read cannot
resurrect an evicted entry. Canonical plan-path attestations survive projection
eviction and different review-source objects for the process lifetime, with
100,000-entry and 64 MiB encoded limits. Capacity exhaustion fails closed without
forgetting an immutable version. Coalesced file snapshots are rechecked against
the canonical path before publication.
There is no TTL or persisted trusted index, and byte-integrity proofs never
replace live authorization, policy/ref checks, human decisions or required CI.

## Workspace candidate requests

A current Native Git workspace lease may request CI for an exact ordinary branch
or tag candidate. The request supplies a caller-generated UUID plus the ref,
commit and tree. Git-CI verifies the live authoritative tuple before publishing
the deterministic review and plan, saves the immutable request identity first,
and reuses it on an exact retry. The same ID cannot be replayed with another
workspace, repository or candidate. Current policy, protected head and repository
proofs are rechecked for every request and status read; stale evidence requires a
new request ID. This path creates no approval and exposes no promotion operation.

Workspace status projects every job in the immutable plan, including non-required
jobs; reviewer/merge status continues to evaluate only policy-required jobs.
The workspace request is rejected before publication when Git-CI policy is
absent. It cannot select protected candidates, supply job schemas or read another
workspace's request. Completed request replay only reads its existing outcome;
new work requires a freshly proved explicit request and current-generation
delivery intent. A receipt is not a successful quality gate.
