# Git repository transport and optional authority features

`@slop-lab/dim-control-plane-plugin-git-repositories` owns registered bare
repositories, initial snapshot import, scoped smart-HTTP reads/proposals and
recoverable protected-ref compare-and-swap. Review, merge policy, Git-CI,
workflow compilation and external webhook delivery are independently selected
control-plane plugins. Repository-only operation requires none of them.

## Repository and transport ownership

The repository service owns one private storage root and its activation
generation. Startup validates repository identity, storage ownership and current
state before serving. It does not register Projects or create CI capacity.
Registrar, importer, protected-source reader and workspace writer credentials
are distinct. Selected feature factories contribute their role credentials to
the same pre-start collision check; features cannot reuse another role's username
or secret.

Registration prepares an owned `(projectId, repositoryId)` identity. Import can
publish a verified initial snapshot to an unborn protected ref; it cannot
replace a later protected head. A Project has one owner and independent
repository imports, protected heads, proposal namespaces and transition
sequences. Every transport lease selects its repository explicitly, including
when several repositories have the same owner.

Workspace leases permit only reads and create/fast-forward operations in that
immutable workspace's proposal namespace. Protected writes, tags, deletion,
force and foreign access are denied by Git transport. Without a review plugin,
a successful proposal push performs no review publication or workflow read.

Host source acquisition is a host-plugin capability over the core workspace
lifecycle. Its private broker retains host role credentials and checks the live
workspace UUID/state for every request. Guests receive scoped grants.
Recreation preserves the UUID and checkout; discard/name reuse cannot retain the
old authority. Advancement of a protected ref does not overwrite local work.

## Trusted policy and extension composition

The neutral policy envelope contains `schemaVersion`, `protectedRef`,
`policyRevision` and `extensions`. The revision hashes the protected ref and the
complete canonical extensions object. An empty extensions object is valid.
Selected feature owners strictly validate their sections:

- `code-review`: required reviewer IDs and path-specific reviewer rules.
- `git-ci`: allowed repository inputs and promotion-required jobs.
- `merge-policy`: the merge implementation's supported policy options.

Import and startup reject sections without an enabled owner. Missing optional
plugins never turn a declared requirement into success. The repository engine
stores the policy and validates its envelope; it does not interpret feature
policy or load concrete feature implementations.

Repository-owned typed extension factories attach to one service context. They
receive the owned runtime, selected extensions, cancellation, a serialization
gate, known credentials and private extension state. Features return their own
HTTP/transport handlers, proposal/activation hooks, policy checks and cleanup.
Partial attachment must clean its resources. Successful attachments close in
reverse order; failures must not prevent listener closure or storage-owner
release. Control-plane core composes generic extension identities only.

## Human review and merge policy

Code-review owns immutable complete-tree candidate evidence and human
approvals/revocations. Review identity binds the full trusted policy, primary
candidate commit/tree and exact dependency snapshots. The version-3 review
envelope contains the review, policy digest and generic immutable attachment
references. It contains no workflow plan or execution events.

Review preparation extensions may contribute pinned inputs and attachment
references. Code-review rejects conflicting snapshots and revalidates source
before publishing. Human review alone reads no workflow files. Its own startup
validates private review, approval and revocation records; repository-only
startup does not require those stores.

Merge-policy owns promoter credentials, eligibility checks, authorization
records and its HTTP operation. It rereads the current review, approvals, policy
and selected quality evidence while holding the repository serialization gate.
The entire policy is bound to approval; changing quality policy also requires
fresh human approval. CI success, readiness and installer activation grant no
promotion authority.

## Git-CI and candidate execution

Git-CI owns workflow planning and its compiler dependency, exact repository
input snapshots, execution grants/read leases, result evidence and durable CI
event delivery. A selected language plugin compiles the candidate configuration;
Git-CI verifies bounded configuration/script blobs from exact Git objects.
Code-review stores only its immutable plan reference.

`extensions["git-ci"].ciRepositoryIds` bounds job input selection and includes
the primary repository. Omitted job selection means the primary repository.
Plans and descriptors bind one exact commit/tree map. Dependency drift makes
old authority stale; execution retries cannot repin inputs. Trusted acquisition
materializes only selected trees, with no guest Git credentials.

The independent CI coordinator owns queueing, worker claims/leases, cleaned
terminal result acceptance and publication retries. The host worker owns the
isolated runtime and cleanup. Git-CI accepts current attempt-bound evidence;
merge-policy consults its quality guard. Common execution wire types belong to
`@slop-lab/dim-contracts-ci`, not the repository engine.

## Protected refs and durable state

Only trusted service extensions can request repository CAS. The repository
checks import ownership, generation, expected head, candidate commit/tree,
ancestry and proposal identity, then persists an accepted authorization/evidence
digest before atomically updating Git. It finalizes one monotonic receipt.
Promotion changes one repository; no cross-repository transaction is provided.

Repository state format **10** owns activation, registration, imports and neutral
ref-transition intent/finalization. Startup validates the transition chain and
recovers accepted operations interrupted before or after Git CAS. Recovery
cannot invent an authorization or accept a changed base/candidate. A pending
operation fences source proofs until recovery completes.

Merge-policy stores decision evidence and receipts in its private extension
SQLite database. It reconciles an interrupted local receipt only against an
already accepted repository transition; it never executes an unsent pending
merge without fresh checks. Code-review and Git-CI own their private records in
repository storage. Webhooks owns its separate subscriber/delivery state and
backfills durable authority events without owning source decisions.

Unsupported formats fail without migration or data erasure. Export required
user data before replacing incompatible storage. See [CI runners](../../guides/ci-runners.md)
and the [installer facade](../14-installer-facade.md) for their own boundaries.
