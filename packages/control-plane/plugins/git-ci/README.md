# Git CI integration

`@slop-lab/dim-control-plane-plugin-git-ci` connects reviewed Git candidates to
an independently deployed CI coordinator. It owns workflow planning, immutable
multi-repository execution inputs, candidate read leases, execution grants,
result evidence and durable CI event delivery. It does not own Git repository
registration, human approvals, protected-ref compare-and-swap, worker runtimes
or general-purpose outgoing webhooks.

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
