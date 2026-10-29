# Git service extraction ownership ledger

The P2 work builds on the separate production-history latency checkpoint
`79dc2b64daf45f1ce5c6d400b1aaf5bfe3c9d460`. It completes the ownership cuts
identified by the earlier extraction preparation. It does not launch an external
repository, publish packages, deploy services or claim installed performance.

## Implemented dependency cuts

| GS owner | Existing source/behavior moved from | DIM responsibility retained |
| --- | --- | --- |
| `repository` | Git storage, executable integrity, transport and protected-ref CAS/recovery ordering | Native import/activation proofs and format-12 journal translation |
| `repository-service` | Independent SQLite catalog, policy updates, branch baselines, owner exclusion and promotion journal | Project registration and `.dim/repos.yml` interpretation |
| `repository-contracts` | Git policy, candidate refs and snapshot models in `contracts/git` | Generation-bound admission and Project attachment contracts |
| `ci-contracts` | Candidate execution descriptors, events, status and workflow semantics in `contracts/ci` | Execution protocol, scheduler and placement contracts |
| `review-contracts`, `review` | Review construction, Git evidence, immutable records/decisions, currentness, matchers and compact P1 provenance in `git-review` | Credentials, HTTP/CLI, activation and raw proposal acquisition journal |
| `merge-policy` | Merge preparation, quality authorization and promotion in `git-merge-policy` | Operator presentation and DIM activation binding |
| `diff-service`, `blame-service` | Immutable Git reads in the matching DIM plugins | HTTP authentication, scope and Project mapping |
| `pull-request-service`, `discussions-service` | PR storage, revision pins and discussion composition in the matching DIM plugins | Routes, principal authentication and owner activation lifecycle |
| `ci` | Candidate workflow reads, immutable plan store, evidence checks and indexed delivery outbox in `git-ci` | Workflow registration, scheduler/profile codecs, workers, HTTP and delivery credentials |
| `sync` | Fetch/propose/publish algorithms in `git-sync` | Remote credential selection, host configuration and route mapping |
| `client` | Typed Git views, capability checks and exact-revision PR workflow in `service-clients/native-git` | Bounded HTTP transport, private connections, generation attestation, Project mapping and operations |

Model, React and tracing packages from the earlier cut remain GS-owned. The
Node evaluator still implements the canonical `dim:review` detector API and
retains existing owned-resource identities. These names and persisted marker
strings are not DIM implementation dependencies or compatibility forwarding
modules. Scheduled tracing and installation topology remain DIM integrations.

## Composition, not a mandatory ladder

- Repository catalog/promotion has no review, PR, CI or scheduler dependency.
  Protected promotion still requires an explicitly selected authorizer.
- Diff and blame compose only repository reads and principal authorization.
- PR lifecycle works without human review. Review is an injected
  `ReviewRequest`; discussions explicitly compose PR plus immutable diff.
- Review/merge compose typed repository authority and optional preparation and
  quality providers. Authorization policy namespaces cannot silently disappear.
- CI uses selected typed workflow/execution providers and review capabilities,
  not PR or DIM worker profiles. Missing/stale required evidence denies promotion.
- Sync fetch/propose/publish does not require review or CI.
- The portable client depends on semantic contracts/models, not server feature
  implementations. DIM adds authentication and generation fencing outside it.

The independent source graph closes within `packages/gs`, its declared external
dependencies and its own compiler/build configuration. DIM adapters depend
inward; GS source, types, build scripts and configuration do not import DIM.

## Durable authority and integrity

The standalone SQLite owner uses a process-lifetime exclusive owner transaction,
not a PID-file lock. Catalog, policy and protected-ref history validate before
use. Missing known storage fails closed; another live process cannot recover
or cancel its intents. Policy replacement uses expected policy/head identity.
Targets bind incarnation, authority epoch, principal, policy digest, protected
head and selected provider revision.

Read gates issue revocable borrowed read authority. Mutation/exclusive gates
add promotion without reacquiring their already-held serialization boundary.
Selected ref-update providers receive read authority only. Exact finalized
lookup matches the complete accepted action identity and returns its durable
intent and receipt. Merge recovery can finish a missing authorization receipt
after CAS, but never guesses acceptance from the current Git head or reruns
an unapplied authorization.

DIM keeps its format-12 journal and existing digest domains through explicit
translation. Existing receive-hook bytes, review/evidence identities and P1
bounded version/provenance/outbox invariants remain intact. PR pin repair runs
inside owner activation, before business readiness, not through an inactive
external mutation gate.

## Source history and provenance

The [export tool](gs-source-export.md) exports an exact committed GS tree plus
a companion bundle containing the selected original commit and its full,
unrewritten ancestry. Its manifest records original/export paths, blob IDs,
modes, SHA-256 digests, package manifests and dependency edges. Moves in this
branch retain their original monorepo history in that ancestry; no filtered or
fabricated commit history is substituted. The monorepo lock digest is recorded
as provenance, not passed off as a standalone GS lockfile.

Tests remain central under `tests/gs` and the affected DIM test directories.
Public drivers exercise real Git hosting, independent durable promotion,
review/merge crash recovery, optional services and typed CI delivery/restart.
The export is source-only; standalone dependency resolution/build/check and
artifact composition are explicit validation steps, not publication.

## Operator delivery boundary

Normal exact-commit DIM CI, artifact deployment and installed confirmation remain
operator gates. External forge selection, standalone package publication and any
detector API/resource naming transition are not performed by this change.
Prior worktrees, user data, protected refs, installer facade and frozen CLI-host
wire-v1 fixtures are outside the modification scope.
