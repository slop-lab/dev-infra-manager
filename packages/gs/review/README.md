# @slop-lab/gs-review

Standalone real-Git review creation, immutable evidence, conditional reviewer
matching, approvals, revocations, currentness and protected-ref authorization.
The engine composes `@slop-lab/gs-repository-service` authority, read and gate
ports. It has no DIM runtime, activation token, Project type, control-plane
extension, credential or HTTP dependency.

`createReviewFeature` freezes matcher/preparation revisions into the selected
ref-update provider revision. `ReviewService.create` owns mutation admission;
`createInTransaction` requires an already-borrowed mutation capability and never
reacquires a gate. Reads use the distinct borrowed read authority and perform a
final currentness check before returning.

Stored review, approval and revocation paths and digest domains retain their
existing `dim-*` ABI. DIM adapters map `projectId` to the neutral namespace at
the boundary; the engine itself uses namespace/repository selectors.

## Public API and source provenance

- `createReviewFeature` selects matcher/preparation providers and exposes the
  `code-review` ref-update policy.
- `codeReviewPolicySectionOwner` declares authorization enforcement for the
  trusted `code-review` policy section.
- `ReviewService` owns create/read/approve/revoke admission; its
  `createInTransaction` overload accepts only a borrowed mutation capability.
- `createGitRepositoryReadService` supplies the standalone pinned real-Git
  reader; embeddings may supply another implementation of the same port.
- Review schemas come from `@slop-lab/gs-review-contracts`; immutable stores,
  compact CI provenance, matcher policy and freshness are exported here.

The canonical implementations moved from DIM's `git-review` package:
`authoritative-native-review*`, approval/revocation/decision stores,
`review-record-*`, verified CI review sources, policy, change matchers and JSON
field matching. Those DIM paths now adapt or re-export this package. DIM keeps
HTTP/CLI credentials, activation, raw proposal capture/journals/workers and the
generation-bound proposal-acceptance integration.
