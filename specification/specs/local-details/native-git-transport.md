# Managed Git transport and review

`@slop-lab/dim-native-git` owns registered bare repositories, scoped smart-HTTP
reads/proposals, exact candidate evidence, human decisions and atomic protected
promotion. It does not implement issue tracking, runtime orchestration, worker
capacity or workflow language interpretation.

The optional installed service has its own private data volume and generation
configuration. Startup validates repository identity, storage permissions and
current state before serving. The installer probes the actual image's config,
state and compatibility commands and activates the exact installed generation.
Idle service startup does not register a Project or create workload capacity.

## Source authority

Registrar, importer, protected-source reader, workspace writer, reviewer,
promoter and execution roles use distinct credentials. Registration prepares an
owned repository identity. The importer can publish a verified initial root to
an unborn protected ref through a checked operation; it cannot replace a later
protected head. Root-read and workspace-write issuers mint short-lived scoped
transport leases. Workspace writes only create or fast-forward that workspace's
proposal namespace. Protected writes, tags, deletion, force and foreign access
are denied at the Git boundary.

Managed workspace acquisition is an optional source adapter for the core
workspace application. A private host broker holds operator role material and
checks the live core UUID/state for every Git request. Only its scoped grant
enters the agent. Recreation retains source data and identity; discard/name
reuse cannot retain transport authority. Protected-ref advancement leaves an
existing checkout under its developer's control.

## Candidate compilation and execution

Successful proposal updates reconcile immutable candidate evidence from exact
Git objects. A selected workflow compiler maps candidate configuration into a
normalized plan. The compiler owns its config path and language; Git verifies
object identity and publishes jobs without embedding YAML rules.

The execution service requests a grant for an exact event, trusted profile and
worker slot. Git binds it to a current attempt and derives the descriptor from
that candidate. A separate short-lived read lease permits candidate acquisition;
it grants no push or general host credential. Workers verify configuration and
script object identities/digests before executing them.

Terminal evidence binds execution ID, descriptor digest, completion and cleanup.
Git persists evidence for the current attempt. An old or superseded attempt
cannot satisfy promotion. The execution service durably accepts cleaned results
and retries Git publication independently; there is no reciprocal live-proof
chain holding a finished worker slot open.

The common wire types live in the native Git execution subpath. Queue/service
configuration and worker slot policy belong to the execution implementation.
There is no ordinary authority, separate QEMU authority or current-attempt
verification service to query in a loop.

## Human review and promotion

Reviewer APIs discover immutable candidate evidence and diffs, then record or
revoke a decision bound to the exact reviewed tuple and policy. Reviewer web
uses those installed APIs and pins the serving generation. Credentials remain
server-side; browser sessions do not become host operator roles.

Promotion rechecks current policy, candidate identity, selected latest successful
execution evidence and required human decisions, then performs one checked Git
ref update against the expected protected head. A changed head requires a new
current operation. Readiness, CI success and installer activation confer no
human decision or promotion authority.

Internal formats evolve with the implementation. Preserve required user data
before replacing incompatible state; do not migrate old role or runtime
identities implicitly. See [shared execution](../../docs/ci-runners.md) and the
[installer facade](../14-installer-facade.md) for their separate responsibilities.
