# Git pull requests and reusable presentation

A pull request is an editable repository conversation. It is separate from an
immutable review, an approval and a protected-ref promotion. Editing a title,
closing a request or posting a comment never grants approval or writes a ref.

## Portable packages

`packages/gs` contains these model/presentation packages usable without DIM:

| Package | Owns |
| --- | --- |
| `@slop-lab/gs-diff` | Bounded Git patch parsing, structured snapshots and exact line anchors |
| `@slop-lab/gs-discussions` | Discussion/anchor schemas, immutable revision association and list primitives |
| `@slop-lab/gs-pull-requests` | PR/revision lifecycle, optimistic versions and PR-specific pure transitions |
| `@slop-lab/gs-blame` | Bounded line-porcelain parsing and attribution models |
| `@slop-lab/gs-react-diff` | Controlled diff rendering and explicit file, gutter and below-line slots |
| `@slop-lab/gs-react-pull-requests` | Controlled PR forms, revision discussions and optional review/blame callbacks |

These packages have no DIM, filesystem, account or HTTP dependencies. IDs are
opaque strings; an adapter may use UUIDs or IDs from another Git service. React
components receive data and callbacks rather than importing a service client.
Applications own loading, permissions and mutation outcomes. DOM mount helpers
permit use in a shell that does not use React. Optional external CSS preserves
strict content security policies. Package READMEs document the component APIs.

## Service ownership and DIM composition

`@slop-lab/gs-repository-service` owns scoped repository read/mutation authority
and the generic Git reader. `@slop-lab/gs-pull-request-service` owns durable PR
records, exact revision pins and lifecycle algorithms; review is an optional
typed `ReviewRequest` capability. `@slop-lab/gs-diff-service` and
`@slop-lab/gs-blame-service` work without PR or review. Discussions explicitly
compose PR plus diff through `@slop-lab/gs-discussions-service`.

The managed deployment installs these separately composable control-plane
plugins:

- `git-diff` authenticates and maps immutable comparison requests to GS.
- `git-pull-requests` maps principals/routes and owner activation to GS PR state.
- `git-discussions` authenticates general and line-comment requests.
- `git-blame` authenticates exact file-line attribution requests.

The repository SDK owns scoped access and immutable Git reads. Its access
provider is supplied by Git review in the current composition: a configured
human-reviewer identity must be named in the repository policy. Workspace and
promoter credentials do not implicitly gain conversation access. Feature
advertisements allow callers to omit actions for plugins that are not installed.

The Native Git host plugin contributes `dim project pull-request` (`pr`), and
the Native Git Web adapter connects the portable panel to validated operations.
The CLI transport and Web core do not own PR semantics. See the
[host commands](../../packages/host/plugins/native-git/README.md) and
[service routes](../../packages/control-plane/plugins/git-pull-requests/README.md).

## Revisions, comments and approval

A PR selects an existing ordinary branch/tag or legacy workspace proposal source
and a managed protected target. Both lightweight and annotated tags must peel
to a commit; other Git object tags are not review candidates. Each revision
records both exact commits. Refresh after a push appends
a revision when either commit changes. Comments bind to their revision; a line
comment additionally binds path, base/head side and line number. The server
accepts only lines present in that revision's structured diff. Older comments
remain visible and are marked outdated, never silently moved to new code.

GS PR writes share the repository mutation gate and require `expectedVersion`.
The GS PR service stores synced records with atomic replacement. Creation of an
identical open source/target request returns that request; conflicting metadata
requires reading and editing it. A response lost after another write requires
authoritative reconciliation before retrying. Listings return the latest 100
requests; older requests can be read by exact ID.

Neutral GS review contracts use namespace/principal identities. Explicit legacy
storage/wire codecs retain the persisted `proposalRef` field as the candidate
source ref, not as a requirement to use a proposal namespace. Legacy `workspaceId`
is present and verified only for canonical workspace proposals; ordinary source
refs carry no invented workspace provenance. Existing stored review, CI envelope
and ref-transition identities retain their versions and digest domains.

Preparing review evidence resolves the PR's exact stored target branch and
requires the live refs and returned provider evidence to match the entire
pinned namespace/repository/source/target commit and tree identity. The
Web adapter approves that exact evidence through the existing review API.
Promotion still requires separate promoter authority, current review and all
protected-ref policies. A new source push invalidates old evidence. After
promotion, refresh marks the PR merged only when the target equals the exact
revision source commit. It cannot infer merge from a title or conversation state.
Annotated-tag promotion verifies the raw source ref object atomically as well
as the approved peeled commit; moving a source during compare-and-swap fails.

CLI and Web share portable exact-version/revision choreography in `gs-client`
through the DIM Native Git HTTP/identity adapter. Preparation, human
approval/revocation and operator merge remain
distinct actions. Operator merge can prepare evidence for a zero-human-policy
change but never records approval; protected promotion still validates current
human decisions and required DIM execution evidence with separate credentials.
Review inspection shows explicit CI absence, no-required-jobs, pending, failed,
stale/unavailable or successful evidence. An approved review or GitHub status is
not a successful DIM CI check. An accepted promotion followed by failed PR
refresh returns an accepted receipt with refresh pending, not a failed merge.

## Retained Git objects

PR history retains `refs/dim/extensions/git-pull-requests/` as its persisted ref
namespace. The GS PR service durably records each exact ref and commit before
creating it. DIM owner activation repairs missing known pins before business
readiness; empty/unprepared registrations need no PR repair. Startup
and live repository proofs validate that ownership; unknown names or wrong
commits fail closed. Missing pins after interruption are repaired. Owner
validation includes all records, even those outside the latest-100 listing.

Workspace receive credentials cannot write extension refs. These refs grant no
promotion authority and are never treated as protected branches. Immutable read
providers expose only explicitly registered revision history, not arbitrary
unreachable Git objects. This retains old diffs after source rewrites without
turning the extension namespace into a general proof bypass.

## Verification

`pnpm --dir tests run test:web-journeys pull-requests` uses disposable services
and Chromium. It creates a PR, checks diff, general and line comments and blame,
approves, pushes a new revision, verifies outdated comments and stale approval,
then approves and merges the new revision. The final assertion reads the actual
Git target ref. UI selectors live in a replaceable adapter, separate from these
workflow outcomes; a UI redesign need not preserve today's markup.
