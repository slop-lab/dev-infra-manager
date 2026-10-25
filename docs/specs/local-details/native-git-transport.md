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

### Existing Project discovery and host attachment

The repository plugin owns the authenticated catalog. `GET /v1/projects` and
`GET /v1/projects/:project/attachment` require an existing protected-source read
issuer and exact active `X-Dim-Generation-Id`. Scope comes only from the
credential's configured host-authority ID. Other known roles are forbidden;
foreign Projects are not found. A catalog summary advertises completed imports,
not an entitlement to register or change repositories. An attachment descriptor
contains live-proven completed repositories, their original immutable import
receipts and policies, effective policies and current heads. It fails as a whole
on unavailable evidence or response limits, without truncating a Project.

Native Git's host plugin explicitly attaches a discovered Project by choosing a
local name, configuration repository and default working repository. It fetches
evidence itself; CLI/Web input cannot supply policies, receipts, ownership or
service addresses. Every repository must also pass workspace-readiness with the
host's existing writer authority before atomic local publication. Selected
snapshots retain the original receipt commit/tree and generation; current
fast-forward heads do not replace immutable import evidence. Effective policy
updates retain the original imported policy. Defaults stay host-local.

Attachment never replaces local identity or selections. An unchanged retry
preserves the existing record; name, alias, repository-set, defaults or
immutable-evidence conflicts fail without replacing data. On an explicit repeat
attachment with matching identity and selections, a changed authoritative
effective policy is reconciled locally, preserving the original import evidence,
snapshots and timestamps. Configuring drafts are not silently adopted. Changes
to existing defaults use explicit local configuration. Discovery and attachment
never register/import repositories, update service policies or refs, mint broader
grants, or alter existing workspaces. Importer/registrar roles are not prerequisites.

The configured `hostId` denotes an authority, not a unique physical host. Existing
connection export can share one authority across machines; local selections
remain independent. Distinct authorities remain isolated. This flow creates no
cross-authority grants or per-machine revocation boundary.

Workspace leases permit only reads and create/fast-forward operations in that
immutable workspace's proposal namespace. Protected writes, tags, deletion,
force and foreign access are denied by Git transport. Without a review plugin,
a successful proposal push performs no review publication or workflow read.

Repository read and workspace-write leases carry issuer timestamps for a
positive lifetime of at most 30 seconds. The host validates that interval and
subtracts the complete request round-trip time before caching credentials against
its own local deadline. It does not compare absolute clocks across hosts. The
repository server independently enforces expiry and generation on every use;
expired or delayed responses cannot extend authority.

Host source acquisition is a host-plugin capability over the core workspace
lifecycle. Its private broker retains host role credentials and checks the live
workspace UUID/state for every request. Guests receive scoped grants.
Recreation preserves the UUID and checkout; discard/name reuse cannot retain the
old authority. Advancement of a protected ref does not overwrite local work.

## Trusted policy and extension composition

The neutral policy envelope contains `schemaVersion`, `protectedRef`,
`defaultRef`, `branches`, `policyRevision` and `extensions`. The revision hashes
the import-anchor protected ref, default branch, all branch declarations and the
complete canonical extensions object. An empty extensions object is valid.
Selected feature owners strictly validate their sections:

- `code-review`: baseline reviewers, mandatory path rules and content-change
  rules supplied by named review matchers.
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

For a branch with `review: true`, required reviewers are the union of baseline,
matching path rules and matching content rules in the operator-imported policy.
A branch with `review: false` still uses a review envelope and mandatory
fast-forward promotion, but has no human rule requirements. New manifests enable
review on `main` and disable it on `development`; both forbid force updates.
Review identity and freshness checks bind the selected target branch. A branch
merge creates a service-owned proposal and follows this same review path. A rule may never remove another
rule's requirement. An empty baseline permits conditional review; matched rules
still require all selected human approvals. Content matchers read bounded blobs
and candidate files by immutable Git identity, never from a mutable checkout.
The matcher implementation/configuration revision participates in the review ID.
Missing providers, invalid options and failed evaluations fail closed. Creation,
approval and protected-ref promotion all recompute the same requirements.

Project repositories may contain their own matchers. Changes to their code,
settings and dependency closure must independently require review through the
trusted imported policy; their return value cannot waive that requirement.
Candidate matchers need not be replaced with an older protected version, but
must execute without control-plane credentials or authority. Changing a candidate
commit after approval invalidates that approval. The imported policy is an
operator trust anchor and cannot be replaced by candidate configuration.

An optional tracing integration can derive that closure from brokered reads.
A language-neutral library owns bounded read manifests and snapshot comparison;
control-plane and language-runtime plugins own policy integration and isolated
execution respectively. The evaluator receives no repository mount. Imports and
ordinary reads are dependencies; explicitly declared target reads are input data.
Reading a path as a target cannot erase its dependency classification. The
protected execution observes existing dependencies, while candidate execution
supplies the decision. Changed/deleted dependencies, a dependency no longer read,
or a dependency present only in the candidate execution require review regardless
of that decision. Missing/broken baseline code requires review; candidate failure
denies evaluation. Read evidence and runtime identity bind the review ID and are
recomputed for approval and promotion, including when reviewer sets are unchanged.

The Node runtime accepts JavaScript ESM and erasable TypeScript (`.ts`/`.mts`).
The broker hashes original bytes; the guest loader removes types before execution.
Type checking remains a separate strict project check, not an evaluator feature.
Local control-plane execution and scheduler-backed host execution share this
runtime implementation. Scheduled work uses the existing CI coordinator's queue,
lease authority and worker journal; typed handlers keep CI acquisition and detector
execution separate. Opaque task I/O requests validate the active lease before
serving bytes. The repository owner retains exact Git reads and their evidence.
Execution hosts and installed handlers are trusted to evaluate faithfully;
repository programs remain untrusted inside their isolated runtime.
No source, review or promotion credential is passed to candidate code. Lost
transient I/O sessions require a fresh evaluation, never recovery against new refs.

These are observations of the two current executions, not a persistent dependency
ledger or static analysis of all branches. A dependency reached in both executions
is compared between the two snapshots. This does not retroactively protect edits
made before a previously dormant branch became reachable in both executions.
Projects needing exhaustive protection should retain explicit path rules.

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

Protected-ref update policies are named repository extensions with a reviewed
implementation/configuration revision and provider-owned option validation.
A matching key in the imported policy selects that constraint; all selected
constraints must succeed under the repository serialization gate before an intent
is recorded or Git changes. Providers cannot disable another constraint. Unknown,
missing, duplicate, failing or changed providers fail closed. The accepted ref
transition records the complete policy digest and selected ref-policy revision.

Code-review owns the mandatory approval constraint for its policy; merge-policy
owns its authorization and quality-evidence constraint. These checks run at the
repository CAS boundary, including requests from other trusted integrations.
They are not solely checks in the merge HTTP handler. Exact expected-head CAS,
non-deletion and fast-forward history remain repository integrity requirements;
a human approval cannot authorize rewriting protected history.

Recovery finalizes an already-applied Git transition. An unapplied old-head intent
is canceled rather than replayed: a later attempt must check current policies,
reviews, revocations and evidence again.

Only trusted service extensions can request repository CAS. The repository
checks import ownership, generation, expected head, candidate commit/tree,
ancestry and proposal identity, then persists an accepted authorization/evidence
digest before atomically updating Git. It finalizes one monotonic receipt.
Promotion changes one repository; no cross-repository transaction is provided.

Repository state format **12** owns activation, registration, immutable imports,
head-bound policy-update history, managed-branch baselines and neutral
ref-transition intent/finalization. Each branch replays its own predecessor chain;
a repository-wide sequence serializes mutations without invalidating unrelated
branch reviews or execution snapshots. Startup validates the transition chain and
recovers accepted operations interrupted before or after Git CAS. Recovery
cannot invent an authorization or accept a changed base/candidate. A pending
operation fences source proofs until recovery completes.

Merge-policy stores decision evidence and receipts in its private extension
SQLite database. It reconciles an interrupted local receipt only against an
already accepted repository transition; it never executes an unsent pending
merge without fresh checks. Code-review and Git-CI own their private records in
repository storage. Webhooks owns its separate subscriber/delivery state and
backfills durable authority events without owning source decisions.

Formats 10 and 11 are upgraded additively at startup without changing repositories,
original import receipts, completed ref transitions or extension data. Read-only
inspection accepts formats 10, 11 and 12 without mutation. Other unsupported formats fail without data
erasure. Export required
user data before replacing incompatible storage. See [CI runners](../../guides/ci-runners.md)
and the [installer facade](../14-installer-facade.md) for their own boundaries.


The importer-only repository policy endpoint requires active exact generation and
owner-host scope. Replacing policy uses both expected protected head and effective
policy digest as compare-and-swap conditions. It validates every extension policy
with its enabled owner before committing; protected-ref identity cannot change.
The shared repository mutation queue prevents policy updates from racing promotion
or scoped receive operations. Effective policy digests bind subsequent reviews and
ref transitions, while original import receipts and historical transition digests
are retained. Import proofs therefore distinguish immutable `importReceipt` policy
identity from the effective `currentHead.policyDigest`.
