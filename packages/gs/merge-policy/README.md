# @slop-lab/gs-merge-policy

Standalone merge authorization, quality evidence and protected-ref promotion for
`@slop-lab/gs-review`. It composes neutral repository authority/mutation ports
and has no DIM runtime, activation, credential, HTTP or control-plane extension
dependency.

The public authorization uses `namespaceId` and `authorityEpoch`.
`./dim-legacy-codec` preserves the exact `projectId`/`generationId` stored bytes
and `dim-merge-policy-*` digest domains. The selected merge provider revision binds the reviewed
implementation, quality-provider revisions and integration/ref-policy settings.
Missing quality providers and stale review/approval evidence fail closed.

An unfinished authorization is never inferred from Git state after restart.
Crash reconciliation queries the authority's complete historical journal identity
and finalizes only an exact authorization/evidence receipt. Unsent authorization
records remain pending and never trigger Git replay or Git-state inference.

## Public API and source provenance

- `openMergePolicyFeature` selects quality/ref-policy revisions and exposes the
  `merge-policy` ref-update policy.
- `MergePolicyService.promote` owns mutation admission and
  `promoteInTransaction` accepts an already-borrowed mutation capability.
- `prepareBranchMerge` performs the existing real-Git merge-tree/commit/ref
  preparation and calls the GS review service without reacquiring mutation.
- `MergeAuthorizationStore`, quality guard contracts and exact persisted digest
  identities are exported for trusted embeddings.
- `mergePolicySectionOwner` declares authorization enforcement for the trusted
  `merge-policy` policy section.

Merge authorization storage, quality-provider selection, protected promotion
and branch preparation moved from DIM's `git-merge-policy` package. DIM retains
promoter credentials, HTTP/CLI transport, webhook registration, activation and
format-12 journal receipt reconciliation.
