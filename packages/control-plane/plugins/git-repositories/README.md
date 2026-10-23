# DIM Git repositories

`@slop-lab/dim-control-plane-plugin-git-repositories` is the optional repository
service. It owns Project/repository registration, initial snapshot import,
protected-source reads, workspace proposal transport and durable protected-ref
compare-and-swap. Ordinary Git workspaces need none of these services.

The service runs under `@slop-lab/dim-control-plane-core` without host core, a
host controller, a workflow compiler or CI. Install and explicitly select it with
`dim installer install control-plane plugin PACKAGE@EXACT_VERSION`, then run the
private service configuration with the installed `dim-control-plane` executable.
Installing a package does not select additional feature implementations.

## Storage and transport authority

A Project groups independent repositories under one owner. Every registration,
import, lease and ref change binds `(projectId, repositoryId)`. Each repository
has its own bare object database, managed branches, import receipt and policy.
Registering a repository does not import source, create a workspace or start a
worker. Imports verify bounded Git bundles and can initialize an unborn
protected ref; they cannot replace an existing protected head.

Registrar, importer, protected-source reader and workspace writer credentials
are separate. The writer receives a short-lived lease for one immutable
workspace identity and its proposal-ref namespace. Git transport rejects
protected writes, tags, deletion, force and foreign repository access. A
repository-only service accepts proposal pushes without producing reviews or
reading workflow files. No workspace credential can invoke the protected-ref
CAS API.

The host native-Git plugin owns workspace source acquisition and its private
broker. Host role credentials stay outside guests. The broker checks the live
workspace UUID and lifecycle state on each request; recreation keeps that UUID,
while discard and same-name replacement revoke the old authority.

## Optional features

Features attach through the repository-owned `./plugin-api` SDK:

| Plugin | Responsibility |
| --- | --- |
| `code-review` | Immutable candidate reviews, human approvals and revocations |
| `merge-policy` | Promotion eligibility and promoter API; requests checked repository CAS |
| `git-ci` | Candidate planning, exact input snapshots, execution grants/evidence and CI delivery |
| `ci-workflows` | Workflow language compiler selected by Git-CI |
| `webhooks` | External subscriptions, signed delivery, retry and operator recovery |

These are separately installed and selected control-plane plugins. Human review
works without Git-CI or a compiler. Repository transport works without human
review. Installing review does not enable promotion. The separate CI coordinator
and host CI worker own execution capacity and runtimes.

`RepositoryExtensionFactory.attach(context)` returns only the feature's HTTP,
Git-transport, proposal notification, activation, policy validation, health and
close hooks. The context supplies the owned repository runtime, one serialization
gate, cancellation, selected extensions and private feature storage. Factories
must clean resources they create if attachment fails. The repository service
closes successfully attached features in reverse order and releases the listener
and storage owner even when cleanup fails. Repository code imports no concrete
review, merge, CI or webhook implementation.

## Trusted repository policy

`@slop-lab/dim-contracts-git` defines the shared policy envelope:

```json
{
  "schemaVersion": 1,
  "protectedRef": "refs/heads/main",
  "defaultRef": "refs/heads/main",
  "branches": {
    "refs/heads/main": {"review": true},
    "refs/heads/development": {"review": false}
  },
  "policyRevision": "CANONICAL_SHA256",
  "extensions": {}
}
```

An empty `extensions` object is valid for repository-only use. Selected features
own and strictly validate their named sections, such as `code-review` and
`git-ci`; the repository engine does not interpret their policy language.
`nativeRepositoryPolicyRevision` derives the revision from the import anchor, default branch, branch declarations
and complete canonical extensions object. Import and startup reject policy
sections without an enabled owner. Disabling a feature therefore cannot silently
remove a required check. The complete policy and exact repository inputs bind
human review; policy changes require a fresh approval.

`protectedRef` is the immutable initial import anchor. `defaultRef` selects the
default working/configuration branch; every configured `branches` entry has its
own durable head. New managed branches start at the current import-anchor head
through a recorded creation intent. Existing unrecorded Git refs are never adopted.
The bare repository HEAD follows `defaultRef`. Legacy stored policies without
branch metadata retain their original anchor and digest until explicitly updated.
All managed heads require proposal promotion and fast-forward ancestry. The
`review` switch controls the selected code-review plugin's human rule evaluation,
not transport or force-push checks. Declare `code-review` and `merge-policy` in
the repository policy to use the proposal/review/promotion workflow; a
repository-only deployment does not implicitly install those features.

## Protected refs and recovery

A trusted extension calls `compareAndSwapProtectedRef` under the repository's
serialization gate after checking its own authorization and evidence. The
repository revalidates the owned import, expected protected head, candidate
commit/tree, ancestry and proposal ref. It durably records the authorization and
evidence digests before Git CAS, then finalizes one monotonic repository
transition. Exact retries return the original receipt. It does not interpret
human approval or CI evidence itself.

Repository state format **12** contains activation, registration, immutable import,
policy-update history, managed-branch baselines and neutral ref-transition records. Feature state is separately owned: merge
receipts use the private `.extensions/merge-policy` directory; review and Git-CI
own their private records in repository storage. A pending accepted ref intent
is reconciled against Git at startup, including a crash after Git CAS but before
receipt finalization. Invalid chains, candidate identity or foreign ownership
fail closed. Recovery never manufactures a new merge authorization.

Stopping preserves repositories and durable feature data. Unsupported storage
formats are rejected. Formats 10 and 11 have an additive upgrade that preserves import receipts,
policies and ref history; startup records existing branch baselines and publishes
the format-12 marker. Read-only inspection accepts all three formats without
upgrading them. Export required user data
before replacing incompatible state. The separate installer Docker deployment
and activation transaction retains its own facade contract.

`./config` parses repository service settings without loading the server;
`./service` exposes the service entry points; `./plugin-api` exposes the trusted
feature ports and repository primitives. Package tests exercise real Git/HTTP
repository-only and review-only operation, scoped transport, CAS recovery,
malformed state and failure cleanup.

## Protected-ref update policies

`./plugin-api` exports `RefUpdatePolicy` and `refUpdatePolicyExtension` for
additional constraints. Each provider owns one named section of the imported
repository policy, validates its own options, and throws to deny an update.
Every selected provider must accept; there are no override/allow modes that
subtract another provider's checks. The repository records the provider revision
with each accepted transition. A missing or changed required provider fails closed.

Code-review contributes required human approvals and merge-policy contributes
its current authorization and quality evidence. Both are enforced by the actual
repository CAS, so another integration cannot skip them by avoiding the merge
HTTP API. Ordinary fast-forward history, non-deletion, exact commit/tree and
expected-head CAS checks remain mandatory even after approval.

The [security review example](../../../../examples/features/security-review/README.md)
combines conditional path/JSON/project-matcher reviews with a separate file-retention
ref policy. Recovery cancels unapplied pending intents; it never replays old
permission after restart. Already-applied transitions are finalized for recovery.

## Updating an imported repository policy

The owner host's `operator-root-importer` credential can read or replace an existing
repository policy at `GET` / `POST /v1/projects/:project/repositories/:repository/policy`.
Both operations require the exact active `X-Dim-Generation-Id`. POST accepts
`{schemaVersion:1, expectedPolicyDigest, expectedProtectedHead, policy}`. The server
validates every selected extension and rejects disabled owners, invalid options,
a stale digest/head, or a different protected ref. The response contains
`schemaVersion`, `projectId`, `repositoryId`, `protectedRef`, `currentHead`, `policy`
and `policyDigest`.

Policy changes use the same mutation queue as protected-ref promotion and scoped
workspace writes. An atomic durable history record binds each change to the current
protected head; prior import receipts and completed transitions remain unchanged.
Business operations use the effective policy, and older review envelopes with a
different policy digest cannot authorize promotion. The import proof's
`importReceipt.policyDigest` remains the original import digest, while
`currentHead.policyDigest` identifies the current effective policy. Updating policy
does not recreate repositories or revoke existing scoped workspace credentials.

Trusted repository extensions may implement `RepositoryExtensionFactory.ownedRefs`
to retain immutable Git objects. The factory reads its own private extension state
and returns exact `{ref,commit}` declarations for the selected repository before
startup recovery and every live proof. Each ref must be under
`refs/dim/extensions/<factory-name>/` with a canonical safe suffix. Existing refs
must match their declared commit; undeclared refs remain foreign and fail proof.
Missing declared refs are permitted so the installed owner can repair a write
interrupted after its durable record was saved. Extensions must save owner records
before writing refs. This capability does not modify protected branch authority,
receive permissions or read visibility. Workspace credentials remain restricted
to their own proposal namespace. Read services accept historical refs only through
explicit repository-scoped read-history providers.
