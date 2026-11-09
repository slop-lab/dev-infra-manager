# Git capabilities and ownership

DIM hosts ordinary Git repositories and optional managed Projects. Managed Git
does not replace Git's ordinary branch/tag workflow with a proposal-only API.
Every operation still selects one authenticated Project/repository; choosing a
ref never grants another repository, host credential or protected-ref authority.

## Final package boundaries

| Owner | Responsibility | Deliberately excluded |
| --- | --- | --- |
| `@slop-lab/gs-diff` | Bounded patch parsing, immutable comparisons and line anchors | Git processes, HTTP, storage, credentials and DIM policy |
| `@slop-lab/gs-discussions` | Discussion/anchor schemas and revision-scoped comment primitives | PR lifecycle, optimistic PR versions and authorization |
| `@slop-lab/gs-pull-requests` | PR lifecycle, immutable revisions and versioned PR transitions | Repository access, review approval and Git ref changes |
| `@slop-lab/gs-blame` | Bounded line-porcelain parsing and attribution models | Git execution, repository visibility and filesystem reads |
| `@slop-lab/gs-react-diff`, `@slop-lab/gs-react-pull-requests` | Controlled presentation and caller-supplied actions | DIM clients, credentials, account roles and policy decisions |
| `@slop-lab/gs-repository`, `@slop-lab/gs-repository-service` | Git transport/integrity, durable catalog/policy, scoped reads, protected-ref CAS and exact promotion journal recovery | DIM activation, Projects, workspaces and credentials |
| GS diff/blame/PR/discussions services | Authorized immutable Git reads, durable PR records/pins and explicit revision-comment composition | DIM HTTP/account registration or implicit review grants |
| `@slop-lab/gs-review`, `@slop-lab/gs-merge-policy` | Neutral candidate evidence, reviewer decisions, quality authorization and durable protected promotion | DIM raw proposal acquisition and operator transport |
| `@slop-lab/gs-ci`, `@slop-lab/gs-ci-contracts` | Portable provider-selected checks, immutable plans/evidence and durable delivery outbox | Execution profiles, images, placement, scheduler leases and worker credentials |
| Git repositories control-plane plugin | DIM registration/import, activation, workspace grants, exact owned-ref proofs and format-12 journal adapter | Duplicating GS Git/CAS implementations |
| Git diff, discussions, PR and blame control-plane plugins | Authenticated HTTP/Project adapters and owner activation for GS services | Durable PR algorithm ownership or implicit grants |
| GS explicit legacy codec entrypoints | Byte-preserving persisted review/merge identities, separate from neutral primary SDK models | DIM activation, credentials or runtime registration |
| Git review and merge-policy control-plane plugins | DIM role credentials, activation, raw proposal capture, consumption of GS persisted codecs, storage-path and authority adapters | Duplicating review/merge algorithms |
| `@slop-lab/dim-contracts-ci` | Legacy execution descriptors, placement/status/event schemas and wire codecs | Portable GS check semantics or service execution |
| Git-CI and CI-workflows control-plane plugins | DIM compiler registration, consumption of legacy CI codecs and scheduler/worker adapters | Worker images/resources chosen by candidates |
| Execution scheduler / host worker plugins | Trusted capacity enrollment, leases, execution, cleanup and result publication | Repository policy changes and protected promotion |
| `@slop-lab/gs-sync` / DIM Git-sync plugin | GS fetch/propose/publish algorithms / DIM credential, host configuration and HTTP mapping | Force publication or bypassing protected promotion |
| `@slop-lab/gs-client` / Native Git service client | GS semantic requests and exact-PR choreography / DIM private role attestation, bounded HTTP, wire mapping and presentation DTOs | A server, workspace lifecycle or independent promotion authority |
| Native Git host / Web plugins | Selected-host CLI, repository selection, browser state and explicit operator actions | Generic host-core Git semantics or secrets in guests/browser results |

Git review tracing remains a separate optional integration. Its neutral engine
owns read tracking and dependency comparison; language runtimes own isolated
execution, and host/control-plane plugins register those runtimes. It is not a
dependency of ordinary repository transport, diff rendering or PR discussions.

The portable packages live under `packages/gs`; DIM runtime adapters live
under their explicit host, control-plane and Web plugin directories. Source
library manifests are intentionally private: their build writes independently
publishable manifests into `dist`. That is not an internal-only model contract.
No old-package forwarding wrappers or deprecated model aliases are required.

## Ordinary refs and protected refs

An authenticated workspace can create, update, force-update and delete ordinary
unprotected `refs/heads/*` and `refs/tags/*` in its granted repository. Both
lightweight and annotated tags are ordinary Git data. This does not permit:

- Any direct workspace update, deletion or force push to the import anchor,
  declared managed branches, `main` or `development`.
- Writes to reserved internal, replacement, remote-tracking or extension refs.
- Writes into another workspace's legacy proposal namespace.
- Cross-Project/repository operations or use of stale/revoked workspace grants.

Existing workspace proposal refs remain a supported, distinct convention: their
owner can create and fast-forward them, but cannot force-update or delete them.
They retain automatic proposal reconciliation. Ordinary branch/tag writes do
not automatically create reviews or run candidate workflows.

New workspaces use `push.default=current` without a proposal-only push mapping.
Start work on an ordinary branch; pushing `main` itself remains forbidden.
Existing checkout configuration, custom push mappings and running sessions are
not rewritten during restart, reconnect or recreation.

```bash
git switch -c feature/ref-workflow
# Edit and commit inside the workspace.
git push -u origin feature/ref-workflow
git tag candidate-v1
git push origin refs/tags/candidate-v1
# Explicit ordinary-ref rewrites/deletion are allowed, not protected rewrites.
git push --force-with-lease origin feature/ref-workflow
git push origin :refs/tags/candidate-v1
```

## Inspect, review and merge through one selected host

Project names below are host-local selections; repository IDs select independent
Git repositories and grants. Every command also supports the existing client
`--host HOST` selection.

```bash
dim project diff PROJECT REPOSITORY --base BASE_COMMIT --head CANDIDATE_COMMIT --json
dim project blame PROJECT REPOSITORY --commit CANDIDATE_COMMIT --path src/app.ts --line 12
dim project pr create PROJECT REPOSITORY --title 'Ordinary branch change' \
  --source feature/ref-workflow --target main
dim project pr show PROJECT REPOSITORY PR_ID --json
dim project pr diff PROJECT REPOSITORY PR_ID --json
dim project pr blame PROJECT REPOSITORY PR_ID --path src/app.ts --side head --line 12
dim project pr review PROJECT REPOSITORY PR_ID --json
dim project review inspect PROJECT REPOSITORY REVIEW_ID --agent
# Request full evidence only when inspecting the patch or complete history.
dim project review inspect PROJECT REPOSITORY REVIEW_ID --full --json
```

Use `--source refs/tags/TAG` for a tag source. A source must resolve to a commit;
ordinary tags pointing to a blob/tree remain valid Git data but are not review
candidates. PR revisions pin exact commits. Force-updating or deleting a source
does not retarget old discussion or preserve stale approval authority. Refresh
the PR explicitly after another push.

Review `inspect`, `resolve`, `approve` and `revoke` return summaries by default,
also with `--json`. `--agent` is compact JSON with bounded lists and explicit
omission counts, while `--full --json` returns the complete review. Human
approval, stale evidence and required CI remain separate states. Failed or
unknown CI is retained in the summary. Other commands and the service API keep
their own output; this is a presentation choice on the selected host.

Review preparation is distinct from human approval. The selected reviewer and
trusted repository policy determine whether approval is required:

```bash
dim project pr approve PROJECT REPOSITORY PR_ID
dim project pr revoke PROJECT REPOSITORY PR_ID
dim project pr merge PROJECT REPOSITORY PR_ID
dim project pr refresh PROJECT REPOSITORY PR_ID
dim project repository publish PROJECT REPOSITORY
```

PR approval/revocation/merge bind the current PR version and immutable revision.
Merge never manufactures approval. A zero-human-review change can merge only
with separate promoter authority and the current required DIM CI evidence.
Promotion accepted before a failed PR refresh remains accepted; inspect current
state rather than treating that read failure as a rejected mutation.

`project review` also exposes list, resolve, inspect, approve, revoke and promote
for exact review IDs without requiring a PR conversation. `project repository
merge --source BRANCH --target BRANCH` prepares a managed branch-to-branch merge
through the same review/CI path. Git-sync's `fetch`, `sync` and `publish` remain
separate explicit operations; publication sends the authoritative protected
commit to the reviewed mapping, never a dirty checkout or arbitrary candidate.

## Browser flow and optional capabilities

In **Git review**, select the controller, Project and repository before acting.
Inspect an immutable comparison directly or open/create a PR from an ordinary
branch/tag. Discussions and blame remain optional capabilities. Prepare review,
approve/revoke when authorized, and merge as separate actions. Switching
repositories fences old evidence, pending actions and drafts; one repository's
approval or publication result cannot authorize another repository.

Read access does not grant browser reviewer or operator authority. Promoter and
sync connections remain separate private service roles. Missing plugins/roles
produce setup guidance instead of successful-looking inert actions. The default
conversation access provider is currently supplied by Git review and permits
only explicitly named policy reviewers; installing a diff/PR package alone does
not create an identity or repository grant.

## DIM CI is the product merge gate

An approved human review is not a successful CI result. A workflow file is not
CI policy, and installed/connected capacity is not execution evidence. The review
inspection surface distinguishes absent policy, enabled-but-not-required CI,
pending required jobs, failed jobs, stale/unavailable evidence and current
successful required jobs. An absent gate is shown as absent, not green.

Enable `git-ci` explicitly in the trusted repository policy, enroll/start trusted
execution capacity, then resolve a fresh exact review. Only matching successful
DIM evidence for every required job satisfies the merge-quality guard. A failed,
superseded, unpublished or stale attempt is not success. GitHub status is neither
DIM execution evidence nor an additional product policy requirement.

See [CI runners](ci-runners.md) for private operator setup, admission diagnostics
and the enablement sequence. Source policy changes and disposable test results
do not deploy or change a live control plane.
