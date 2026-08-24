---
name: pull-request
description: Create, update, or monitor pull requests across GitHub and Gitea repositories. Use for PR publication or CI follow-up; resolve the forge with the bundled script before selecting provider-specific tools.
---

# Pull Request

Publish and monitor the requested change without assuming that `origin` is
GitHub. External mutations still require the user's authorization; a request
to create or update a PR provides that authorization for the named change.

## Resolve the forge

Resolve `<skill-dir>` to the directory containing this `SKILL.md`. Skill
loading does not change the shell working directory or make relative script
paths resolve against the skill automatically. From the target repository,
run `bash <skill-dir>/scripts/detect-forge.bash` before using provider-specific
PR tooling. It returns the provider and repository identity as JSON. Do not
infer the provider from installed CLIs, credential variable names, or a
familiar repository name.

- For `github`, use available GitHub tooling and preserve the requested draft
  state. Do not default to draft unless repository guidance requires it.
- For `gitea`, read [references/gitea.md](references/gitea.md), then use the
  bundled helpers. They contain the supported Gitea API workflow; do not
  search for Gitea usage or handcraft equivalent API requests.
- For `unknown`, report the remote and the helper's error without trying
  provider APIs speculatively.

## Prepare and publish

Inspect the worktree and target branch, verify the intended change, stage exact
paths, commit, and push the head branch. Never overwrite unrelated work or
force-push unless the user explicitly requested it.

Before committing, distinguish the canonical public source from a development
forge. DIM-managed Git hosts are development and review locations, currently
backed by Gitea; GitHub is DIM's canonical public source. For a development
forge, do not put its local issue numbers (for example `#123`) in commit
subjects or PR titles because those strings may later enter public history.
Use a descriptive standalone subject. A local issue reference may remain in
the PR body when useful for review inside that forge.

For Gitea, follow the referenced helper contract. Never expose credentials in
output, arguments, remote URLs, PR text, or persistent files.

## Verify CI

Report local verification separately from remote CI. For Gitea, use the
referenced helper to wait on the exact pushed SHA rather than only a branch
name.

Stop when all reported statuses succeed, any status fails, or the timeout is
reached. A timeout or unavailable required runner is not success. For GitHub,
use the provider tooling's equivalent exact-SHA checks.
