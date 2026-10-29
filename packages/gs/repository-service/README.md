# @slop-lab/gs-repository-service

Standalone durable repository catalog, policy, branch baseline and protected-ref
journal ownership. The service depends only on GS repository contracts and the
GS real-Git CAS implementation. It has no DIM activation, Project, workspace,
scheduler, transport or runtime dependency.

`openRepositoryAuthority` acquires a process-lifetime SQLite exclusive owner
transaction before validating or recovering state. A second live process cannot
recover or cancel the first owner's pending intent. Startup fails closed for
missing or corrupt previously owned storage.

Registration records an immutable repository incarnation, owner principal,
trusted branch baselines and initial policy. Every process start creates a new
authority epoch. Promotion durably appends an exact incarnation/epoch/policy
intent before the real Git compare-and-swap, then finalizes it. Recovery only
cancels an unapplied intent or finalizes an already-applied CAS; it never calls
the selected ref-update policy or replays Git CAS.

Optional features compose through explicit neutral ports exported by this
package. Constructors receive selected capabilities directly; there is no fixed
feature bundle or catch-all extension factory.

The neutral SDK surface is intentionally narrow: `RepositoryAuthority`
(`resolve`, `assertCurrent`, `list`, `listSelectors`, `availability`), `RepositoryReadGate`,
`RepositoryMutationGate`, `RepositoryExclusiveGate`, `PolicySectionOwner`,
`RefUpdatePolicy`, `ProposalConsumer`, `OwnedRefProvider`, `RepositoryAccess`,
and `RepositoryReadService`. The read service exposes bounded immutable Git
bytes, advertised-history checks, tree-file metadata and exact ref/tree reads.
The durable authority constructor selects only explicit `RefUpdatePolicy`
providers; other capabilities remain independently composed by the service that
needs them. Every provider declares a unique name and a stable SHA-256 revision
covering its implementation and authorization settings. The sorted provider-set
revision is bound into targets, authority epochs and journal proofs. Provider
drift therefore fails currentness and authorization before intent persistence;
restart recovery validates the revision recorded by the original authority epoch
without reauthorizing.

`policySectionOwners` selects typed owners for declared policy extension
namespaces. Each owner parses its section and declares `configuration` or
`authorization` enforcement. Configuration-only sections may operate without a
ref-update provider. Authorization sections require a selected provider with the
same name, and any declared section with neither owner nor provider is rejected
at startup, registration and policy replacement. An empty `extensions` policy
remains valid; protected promotion still requires at least one explicitly
selected repository-wide authorizer.

Every `RefUpdatePolicy.authorize` call receives a scoped
`BorrowedRepositoryReadAuthority`. Providers can safely resolve same- or
cross-repository targets, assert currentness and inspect finalized history while
the mutation lane is already held. The capability has no promotion method and
expires when provider checks finish.

`authorityEpoch` is a readonly fact on both the normal and borrowed authority.
`listSelectors()` reads only registered namespace/repository IDs from SQLite and
does not resolve Git, policy targets or hooks; an optional namespace limits the
result. Features use it for cheap catalog discovery, then resolve only the
repositories they actually need.

The service-level `RepositoryTarget` extends the core protected-ref target with
the verified effective `RepositoryPolicy`. Each resolve/list result receives a
deeply frozen copy whose `policyDigest` matches the protected-head snapshot.
Policy replacement creates new targets; older targets retain their immutable
policy evidence and fail `assertCurrent`.

`findFinalized` accepts the exact historical protected-ref query: repository and
ref, proposal, expected commit/tree, candidate commit/tree, authorization and
evidence identities, incarnation, authority epoch, policy digest, owner and ref
policy revision. It returns the authoritative finalized intent plus its original
`promoted` receipt. Normal, borrowed-read and borrowed-mutation authorities expose
the same journal-backed lookup across restart; it never infers acceptance from
the current Git head or replays authorization.

## Feature integration under mutation ordering

Top-level `resolve`, `assertCurrent`, `promote`, `mutate` and `exclusive` calls
acquire the authority's global serialization barrier. Code already running
inside `mutate` or `exclusive` must use the revocable
`BorrowedRepositoryMutationAuthority` passed to its callback rather than calling
the outer authority again:

```ts
await authority.mutate(selector, async ({ authority: borrowed, target }) => {
  const dependency = await borrowed.resolve(dependencySelector);
  await borrowed.assertCurrent(dependency);
  await borrowed.assertCurrent(target);
  return borrowed.promote(change);
});
```

The mutation authority is the typed already-exclusive capability. It exposes
repository authority reads plus protected promotion, drains operations started
through it before releasing the barrier, and expires when the callback finishes.
It is not a caller-asserted flag or untyped context object. Existing DIM
extensions continue to use their repository mutation queue and the inward
adapter's equivalent already-exclusive binding.

`read` uses a separate admitted read surface and does not wait for or acquire the
global mutation barrier. Its callback receives a distinct runtime object,
`BorrowedRepositoryReadAuthority`, with resolve/assert/list/catalog operations
and no `promote` property. Reads that need a stable final snapshot call
`assertCurrent` before returning. Close drains already admitted reads, but reads
submitted after close begins reject.

`close()` stops admission synchronously, then drains operations already queued
on the global barrier, including borrowed operations, before closing SQLite and
releasing the live-owner lock. Operations submitted after close begins reject
without touching closed resources.
