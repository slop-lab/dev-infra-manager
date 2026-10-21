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
serialization gate. Configure distinct private `grantIssuer`, `candidateReader`,
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
or reusable repository credentials.
