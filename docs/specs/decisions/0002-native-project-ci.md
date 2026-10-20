# Native Projects and Isolated CI

**Kind: Decision record**

**Status: Accepted**

## Decision

A Native Project owns independently registered Git repositories under one trusted
owner. Each repository has its own protected ref, imported source, review policy,
proposal namespace and promotion sequence. Repository access is selected by the
complete `(projectId, repositoryId)` identity; registration and storage ownership
are verified before issuing scoped read or proposal-write authority.

The Git-repositories control-plane plugin owns repository transport,
registration, imports and durable protected-ref CAS. Code-review owns human
review evidence, and merge-policy authorizes promotion from current decisions.
Git-CI separately owns candidate planning, execution grants and evidence; its
selected workflow compiler interprets candidate `.dim/ci/runner.yml` files.
The shared CI service owns durable job demand, claims, leases and result
publication. Repository hosting works without any of these feature plugins;
human review works without Git-CI or a workflow compiler. Workspace hosts and CI workers are separate
consumers of these services. Native Project and workspace readiness depend on
repository ownership, source identity and runtime prerequisites; they do not
require a CI worker, a successful job or a completed promotion.

Human approval is bound to the exact candidate commit and tree. Review covers
changed requirements, implementation, tests and relevant evidence. Changes to
secret exposure, protected refs, host/runtime privilege or trusted capabilities
also require review of their authority-bearing dependency closure. Approval and
promotion remain separate authorities. Promotion rereads current approval and
required evidence, then compares the current protected head with the reviewed
expected head before updating that repository's ref. Repositories promote
independently; this design provides no cross-repository atomic transaction.

When Git-CI is selected, each accepted workspace proposal update queues its valid candidate-defined jobs.
The operator selects digest-pinned runner and job images, worker membership,
resource limits and available execution kinds. A candidate selects job names,
script bytes and permitted repository inputs inside those boundaries. Protected
`requiredJobs` policy selects the successful evidence necessary for promotion;
it does not authorize host commands or determine which valid proposal jobs run.

A canonical trusted policy envelope binds the protected ref and selected feature
sections. Import and startup reject a section without its enabled owner. The
full policy is bound to review, including quality policy; changing it requires
fresh human approval. Repository state format 10 stores neutral CAS transitions,
while review, merge authorization and CI evidence remain owned by their plugins.

The trusted Git-CI policy bounds selectable repository inputs. A job
records the complete selected repository commit/tree map, including the primary
candidate and dependency protected snapshots. Acquisition, execution grants and
reported evidence bind that same map. Dependency drift or a changed primary
review head invalidates current authority rather than silently repinning inputs.

Sysbox and QEMU are distinct isolated execution kinds. Each job executes its
candidate script with fixed argv in a disposable runtime. Neither job receives
host control sockets, Native Git transport credentials, backend account keys,
reviewer authority or promotion authority. The QEMU supervisor owns access to the
host KVM device; the candidate job runs inside its VM. QEMU requires actual KVM
support and is reported unavailable when its prerequisites are absent.

Both kinds produce **candidate-controlled** self-test evidence. Results bind the
execution descriptor, exact repository inputs, executable definition, runtime
kind, images, bounds, generation and attempt. Successful cleanup and durable
terminal evidence are required before worker capacity is reusable. Restart or
lease loss reconciles only the exact owned runtime; uncertain cleanup fences the
slot. A wrong-kind, stale, foreign or incomplete result cannot satisfy a required
job.

## Consequences

- A Project may require no CI jobs, container jobs, VM jobs, or both kinds.
  Successful CI supplements exact human approval and per-repository checked
  promotion; it grants no review or promotion capability.
- Candidate-controlled tests are useful product evidence, with their definitions
  and limitations visible to reviewers. They are not independent verification or
  blanket proof of correctness.
- Host and control-plane plugins own their respective configuration, secrets and
  runtime prerequisites. Installing a plugin does not start capacity or deploy
  a Project-specific service implicitly.
- Verification separates packaged installation, actual Git/review/CI service
  behavior, workspace isolation and physical KVM mechanics. Missing hardware is
  an unavailable verification prerequisite, not a passing VM check.

See [candidate-controlled ordinary CI](0001-candidate-controlled-native-ordinary-ci.md),
[CI runners](../../guides/ci-runners.md), [workspace configuration](../03-configuration.md),
[repository lifecycle](../13-repo-workspace-lifecycle.md), and the
[installer facade](../14-installer-facade.md).
