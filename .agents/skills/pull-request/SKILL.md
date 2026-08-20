---
name: pull-request
description: Create, update, or monitor pull requests across GitHub and Gitea repositories. Use for PR publication or CI follow-up; resolve the forge with the bundled script before selecting provider-specific tools.
---

# Pull Request

Publish and monitor the requested change without assuming that `origin` is
GitHub. External mutations still require the user's authorization; a request
to create or update a PR provides that authorization for the named change.

## Resolve the forge

Run `scripts/forge-pr.bash detect` from the target repository before using
provider-specific PR tooling. It returns the provider and repository identity
as JSON. Do not infer the provider from installed CLIs, credential variable
names, or a familiar repository name.

- For `github`, use available GitHub tooling and preserve the requested draft
  state. Do not default to draft unless repository guidance requires it.
- For `gitea`, use `ensure-gitea`. It creates a non-draft PR or updates the
  existing open PR for the same head and base.
- For `unknown`, report the remote and the helper's error without trying
  provider APIs speculatively.

## Prepare and publish

Inspect the worktree and target branch, verify the intended change, stage exact
paths, commit, and push the head branch. Never overwrite unrelated work or
force-push unless the user explicitly requested it.

For Gitea, write the PR body to a temporary file and run:

```bash
scripts/forge-pr.bash ensure-gitea \
  --base BASE --head HEAD --title TITLE --body-file BODY_FILE
```

The helper discovers the remote and credentials through Git. `GITEA_TOKEN` is
an optional standard override. Never expose credentials in output, arguments,
remote URLs, PR text, or persistent files. Remove temporary body files.

## Verify CI

Report local verification separately from remote CI. For Gitea, wait on the
exact pushed SHA rather than only a branch name:

```bash
scripts/forge-pr.bash wait-gitea --sha HEAD_SHA --timeout 3600
```

Stop when all reported statuses succeed, any status fails, or the timeout is
reached. A timeout or unavailable required runner is not success. For GitHub,
use the provider tooling's equivalent exact-SHA checks.
