# Git pull requests control-plane plugin

Repository conversations, independent of immutable Git review and approval
records. Requires Git repositories, repository access, and Git review services.
The separate Git discussions plugin adds comment mutation routes.
The initial access adapter reuses configured human reviewers and permits only
repositories whose policy names that identity. Agent workspace credentials and
promoter credentials do not implicitly grant conversation access.

All routes use the selected repository service's Basic credential and
`x-dim-generation-id`. Records live in this extension's private directory under
`PROJECT/REPOSITORY/UUID.json`. Writes share the Git service mutation queue and
use synced temporary files and atomic rename. Every change requires
`expectedVersion`; stale writes return 409. Reviewer IDs are derived from trusted
authentication, never request JSON.

Routes below are relative to `/v1/projects/:project/repositories/:repository`:

- `GET /pull-requests`: list repository PRs.
- `POST /pull-requests`: `{title, body?, sourceRef, targetRef?}` creates a PR
  and pins both commits. Source may be an ordinary branch, lightweight/annotated
  commit tag or existing workspace proposal; target must be managed by policy.
- `GET /pull-requests/:id`: read history and comments, with immutable revision anchors. `commentIsOutdated` in the portable model
  compares a comment with the current revision.
- `PATCH /pull-requests/:id`: `{expectedVersion,title?,body?,state?}`;
  state may be `open` or `closed`. Merged records cannot be edited.
- `POST /pull-requests/:id/refresh`: `{expectedVersion}` pins a new revision
  after a push, or records a completed promotion when the protected target
  equals the exact current revision's source commit.
- `POST /pull-requests/:id/review`: `{expectedVersion}` creates existing Git
  review evidence only after verifying both live refs match the pinned revision.
  Returns `{pullRequestId,revisionId,review}`. This grants no approval.

Approve and promote through the existing Git review and protected ref APIs.
Promotion retains its separate credential and exact-review authority checks. A
closed PR has no review action. Changing PR state never changes a Git ref.
The Native Git client/CLI/Web adapters compose exact PR-version/revision checks
with those APIs for approve, revoke and merge; the PR service does not gain
human-decision or promoter credentials. Zero-human-policy merge never fabricates
approval and still requires successful current DIM CI when policy selects it.

The plugin declares exact immutable revision refs under
`refs/dim/extensions/git-pull-requests/`. It saves a durable owner record before
creating each pin. Git repository proofs accept only the names and commits in
that installed extension's records; unknown refs and altered pins fail closed.
A missing pin after interruption is repaired on startup or create/refresh retry.
Pins preserve older diffs after a source ref is rewritten. Workspace receive
credentials cannot write this namespace. These refs never count as approvals or
protected branches, and only explicitly advertised revision history is readable.

Creating an identical open source/target pair reuses that PR, so a lost response
can be retried safely. Different metadata for an already open pair returns 409.
Records are limited to 16 MiB when read. Public listings return the latest 100
records; older requests remain accessible by exact ID. This bounds the listing
response without imposing a lifetime PR quota. Ownership proofs retain all
records and revisions, including requests outside the current listing.
