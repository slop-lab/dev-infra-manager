# Managed Git Host

## Scope

This specification defines local managed Git hosting primitives:

- Bare repository storage.
- Protected ref hooks.
- Pull request metadata.
- Approval and merge behavior.

It is not a full GitHub-compatible implementation.

## Repository Names

Repository names must:

- Match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`.
- Not contain `..`.

Invalid names must fail before filesystem mutation.

## Paths

For normalized config:

- Git host root: `<stateRoot>/git-host`
- Bare repositories: `<stateRoot>/git-host/repos/<repo>.git`
- Pull request metadata: `<stateRoot>/git-host/prs/<repo>/<id>.json`

## Initialization

`git-host init` must create:

- `<gitHostRoot>/repos`
- `<gitHostRoot>/prs`

## Repository Creation

`git-host create-repo --repo <name>` must:

1. Validate repo name.
2. Create the parent repository directory.
3. Run `git init --bare <repoPath>`.
4. Create the PR metadata directory.
5. Install managed repository hooks.
6. Return the bare repository path.

## Protected Refs

Managed repositories must install a `pre-receive` hook that rejects updates to every configured protected ref.

The hook must:

- Read `oldrev newrev refname` lines from stdin.
- Compare `refname` to configured protected refs.
- Print a clear error when a protected ref is pushed directly.
- Exit non-zero on direct protected ref push.
- Exit zero for non-protected refs.

`git-host install-hooks --repo <name>` must reinstall the hook for an existing repository.

## Pull Request Record

Pull request records contain:

- `id`
- `repo`
- `title`
- `body`
- `sourceRef`
- `targetRef`
- `sourceSha`
- `targetSha`
- `status`
- `approvals`
- `createdAt`
- `updatedAt`
- Optional `mergedAt`
- Optional `mergedSha`

Allowed statuses:

- `open`
- `merged`
- `closed`

The current implementation creates and merges pull requests but does not expose a close command.

## Pull Request Creation

`pr create` must:

1. Validate repo name.
2. Resolve source ref with `git rev-parse --verify`.
3. Resolve target ref with `git rev-parse --verify`.
4. Allocate the next numeric ID by listing existing PR JSON files.
5. Store source and target SHAs at creation time.
6. Write the PR record as JSON.
7. Return the record.

Creation must fail if either ref cannot be resolved.

## Listing And Reading

`pr list` must:

- Return all JSON records for the repo.
- Sort records by ascending `id`.
- Return an empty list if the PR directory does not exist.

`pr show` must return one record or fail with a user-facing error.

## Approval

`pr approve` must:

- Require the PR to be open.
- Add the reviewer only once.
- Update `updatedAt`.
- Persist and return the record.

## Merge

`pr merge` must:

1. Require the PR to be open.
2. Require at least one approval.
3. Re-resolve source and target refs.
4. Fail if the source ref changed after PR creation.
5. Fail if the target ref changed after PR creation.
6. Require `targetSha` to be an ancestor of `sourceSha`.
7. Update the target ref with `git update-ref <targetRef> <sourceSha> <targetSha>`.
8. Set status to `merged`.
9. Set `mergedAt`, `mergedSha`, and `updatedAt`.
10. Persist and return the record.

Merge is fast-forward only.

## Invariants

- Agents may push non-protected proposal refs.
- Agents must not directly push protected refs through managed repositories.
- Protected refs are updated by trusted merge logic or trusted administrative operations.
- Merges must not silently accept source or target ref movement after PR creation.

## Verification

Required verification:

- Unit/integration test for direct protected ref push rejection.
- Unit/integration test for PR create, approve, and merge.
- Unit/integration test that merge without approval fails.
- Smoke test using PR approval and merge before secret deployment.
