# Git service source owner

This is the temporary, movable source root for the future Git project. It is
not a new external repository, deployment profile, published release or full Web
application. Its build configuration, compiler tool and license are contained
here. The private `@this-project/gs-workspace` package is tooling, not a product
or an installed plugin.

| Package | Ownership |
| --- | --- |
| `@slop-lab/gs-repository-contracts` | Portable repository selectors, policy declarations/digests, snapshots and candidate refs |
| `@slop-lab/gs-ci-contracts` | Portable CI workflow, repository input, descriptor, event and review-status schemas |
| `@slop-lab/gs-ci` | Standalone CI planning, required execution evidence and durable event outbox |
| `@slop-lab/gs-repository` | Git executable/storage integrity, smart-HTTP transport, repository-scoped grants and protected-ref ordering |
| `@slop-lab/gs-repository-service` | Independent durable repository catalog, policy, branch baseline, journal and live-owner authority |
| `@slop-lab/gs-review-contracts` | Portable review request, reviewed-candidate and persisted review/decision contracts |
| `@slop-lab/gs-review` | Real-Git review creation, matcher policy, immutable storage, decisions, freshness and ref authorization |
| `@slop-lab/gs-merge-policy` | Merge preparation, quality evidence, durable authorization and protected promotion |
| `@slop-lab/gs-diff` | Unified diff parsing and immutable anchors |
| `@slop-lab/gs-diff-service` | Independent authorized immutable real-Git diff reads |
| `@slop-lab/gs-blame` | Attribution models and porcelain parsing |
| `@slop-lab/gs-blame-service` | Independent authorized exact-line real-Git attribution |
| `@slop-lab/gs-discussions` | Revision/line comment models |
| `@slop-lab/gs-discussions-service` | Explicit PR plus diff composition for revision-pinned comments |
| `@slop-lab/gs-pull-requests` | PR revision/lifecycle models; depends on discussions, not human review or CI |
| `@slop-lab/gs-pull-request-service` | Durable PR lifecycle, revision pins and optional neutral review requests |
| `@slop-lab/gs-sync` | Upstream fetch, proposal creation and protected-commit publication without CI/review |
| `@slop-lab/gs-client` | Portable typed review, PR, diff, blame, Git CI view and sync client over an injected bounded JSON transport |
| `@slop-lab/gs-react-diff` | Controlled diff presentation |
| `@slop-lab/gs-react-pull-requests` | Controlled PR presentation with optional callbacks and CSS |
| `@slop-lab/gs-review-tracing` | Neutral tracker, snapshot comparison and detector runtime contracts |
| `@slop-lab/gs-review-tracing-node` | Optional isolated Node detector evaluator |

Packages are composable dependencies, not a fixed ladder or mandatory bundle.
Separate packages do not require separate processes. Repository hosting does
not import review, PR, comments, CI, a scheduler or the React packages.

## Build outside DIM

Copy this source root as a whole, install its declared development dependencies
with the pinned package manager, then run:

```sh
pnpm install
pnpm run build
pnpm run check
```

`GS_BUILD_VERSION` optionally supplies an explicit artifact version. DIM's
source-bundle scripts translate their aggregate version at the outer composition
boundary; GS code never reads DIM build configuration. Artifacts are generated
in each package's `dist`; no publication occurs during build.

## Current ownership boundary

DIM-specific registration, activation, workspace/Project mapping, admission
credentials, `.dim/repos.yml` interpretation, CLI/Web shell integration and
scheduler/worker placement stay in DIM-owned adapters. They depend inward on GS.
The DIM repository service retains its existing format-12 database and import
proofs through an inward adapter. GS owns the protected-ref algorithm and an
independent SQLite repository authority with concrete incarnation, epoch, owner,
policy and protected-head targets. A process-lifetime SQLite exclusive owner
transaction prevents another live process from recovering or canceling intent.
Selected policy namespaces require their typed owners; authorization namespaces
also require the matching ref-update provider. Providers receive revocable
borrowed read authority, never promotion authority. Exact historical finalized
intent/receipt lookup reconciles an accepted promotion after a crash without
inferring acceptance from Git or replaying authorization.

Standalone repository hosting is operational. Portable Git and CI semantic
contracts are GS-owned; DIM composes Project attachment, admission HTTP,
execution credentials, worker placement and scheduler contracts around them.
Standalone durable review and protected promotion are operational. DIM's
review and merge-policy plugins now retain only registration, activation,
credentials, HTTP/CLI transport, raw proposal acquisition and Project mapping;
their review, decision, storage, matcher, quality, merge preparation and
promotion paths call these GS implementations through the repository adapter.
The Node evaluator is implementation-independent but still implements the
canonical `dim:review` detector API and existing Docker ownership identities.
Its public naming transition is not claimed complete; no alternate alias is
introduced. Stored tracing digest domains remain unchanged.

Standalone diff and blame compose only a repository read gate, reader and typed
principal scope. Pull requests compose repository read/mutation gates, a reader,
durable state and an explicit owned-ref writer; review is an optional injected
`ReviewRequest` capability. Discussions explicitly compose PR plus diff.
Synchronization composes a mutation gate, proposal consumer and Git transport;
it fetches, proposes and publishes without CI or review and never reads DIM
repository configuration. DIM retains HTTP Basic/operator credentials,
generation activation, extension registration and Project-to-namespace mapping.

Git CI composes repository and review capabilities with explicitly selected
workflow and execution providers, without PR or DIM scheduler profiles. GS owns
immutable plans, evidence bindings and the durable indexed delivery outbox;
DIM owns scheduler grants, placement, worker credentials and delivery transport.
Required evidence remains fail-closed when missing, stale or provider-revised.

Tests and fixtures remain in the monorepo's central `tests/` workspace. The
standalone repository test copies this owner's build inputs and repository
package outside DIM and runs real Git HTTP without DIM registration or state.
The review and CI public drivers additionally exercise durable promotion,
crash/restart reconciliation and delivery without DIM implementation packages.
See [the extraction ledger](../../docs/development/gs-extraction-prep.md) and
[offline source export](../../docs/development/gs-source-export.md) for the
dependency map and unchanged-history provenance strategy.
