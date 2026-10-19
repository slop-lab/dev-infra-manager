---
name: pull-request
description: Create, update, or monitor GitHub pull requests and exact-commit CI for DIM's canonical source. Distinguish public PRs from optional DIM native Git proposal and review operations.
---

# Pull Request

GitHub is DIM's canonical public source. `development` is the active development
branch; inspect the requested head/base and existing PR before choosing a target.
Optional DIM native Git is a separate repository, proposal, human-review and
protected-ref promotion authority. It is not a GitHub-compatible PR forge.

## Identify the publication target

From the target checkout run:

```sh
bash <skill-dir>/scripts/detect-forge.bash [--remote REMOTE]
```

Resolve `<skill-dir>` against this skill's directory, not the checkout's current
working directory. The helper defaults to `origin`, reads Git configuration
offline and returns a canonical GitHub repository identity without credentials.
Use that identity explicitly with GitHub tools (`gh --repo OWNER/REPOSITORY` or
the equivalent connector arguments).

For `unknown`/exit 3, inspect the configured remote names and task scope. Select
an existing canonical GitHub remote when public publication was requested. Do
not probe a native Git endpoint as a forge or invent a GitHub repository from
its Project ID. Native proposal/review/promotion requests use the installed
managed Git operations and their separate authority roles; do not translate
them into a PR or use retired Gitea APIs. Historical backup issue numbers are
not automatically current GitHub issue numbers.

## Publish or update

Inspect the intended diff and worktree, run checks appropriate to the change,
and stage exact paths. Preserve unrelated work. Push the requested head through
the selected canonical remote; do not force-push or merge without authorization.
Existing publication authorization covers its necessary steps; do not invent
another confirmation requirement.

Find an open PR for the same head/base before creating one. For example:

```sh
gh pr list --repo OWNER/REPOSITORY --head HEAD --base BASE --state open \
  --json number,url,isDraft
```

Create or edit that PR using a descriptive title and the final behavior,
relevant validation and material limitations. Preserve the user's requested
draft state; do not impose a draft default. Use structured tool arguments or
an actual temporary body file with `--body-file`, preserving real newlines.
Use existing GitHub authentication; never extract or print raw Git credentials
or include credentials in URLs, PR text or evidence files.

## Verify the tested commit

Record the pushed head SHA and inspect workflows for that exact commit:

```sh
gh run list --repo OWNER/REPOSITORY --commit SHA
gh run view RUN_ID --repo OWNER/REPOSITORY --json headSha,status,conclusion,jobs,url
```

Confirm each run's `headSha`. A PR workflow may test a synthetic merge commit;
distinguish that SHA from the pushed head in the result. Identify the workflows
relevant to the change: DIM's source verification has Node 24 and 26 lanes;
OpenCode Pages deploys when its tool/workflow paths change. Hardware integration
lanes are explicit manual workflows, not implied by a green source run.

Report local checks separately from remote CI and live deployment. Monitor with
a bounded deadline, giving current step and elapsed time while pending. Stop
when all relevant checks succeed, a check fails, or the deadline is reached.
On failure, read the failing job/step's safe logs and report its concrete cause
and run URL. Missing required checks, an unavailable runner, cancellation and a
timeout are pending/unsuccessful outcomes, not evidence of success. A failed
deployment does not establish a new live site. Retry only after understanding
the cause; do not hide a failure through repeated reruns.
