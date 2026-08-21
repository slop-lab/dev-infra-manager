# Gitea pull requests

Use these bundled commands after `detect-forge.bash` reports `gitea`. They are
the supported Gitea interface for this skill; no Gitea CLI, web search, or
provider API knowledge is required.

## Publish or update

Write the PR body to a temporary file, then run:

```bash
bash <skill-dir>/scripts/ensure-gitea-pr.bash \
  --base BASE \
  --head HEAD \
  --title TITLE \
  --body-file BODY_FILE
```

The helper creates a non-draft PR, or updates the existing open PR with the
same head and base. It discovers the forge and Git credential from `origin` by
default. Pass `--remote REMOTE` only when another Git remote is intended.
`GITEA_TOKEN` is an optional credential override. Remove the temporary body
file after the command finishes.

For DIM-managed development repositories, make `TITLE` a self-contained
description without local issue references such as `#123`. Check the branch's
commit subjects for the same constraint before pushing. Put `Refs #123` in the
PR body only when connecting the development discussion is useful.

## Wait for CI

Resolve the exact pushed commit and wait for its statuses:

```bash
head_sha="$(git rev-parse HEAD)"
bash <skill-dir>/scripts/wait-gitea-ci.bash \
  --sha "$head_sha" \
  --timeout 3600
```

The helper prints status changes and returns success only when all reported
contexts succeed. It returns failure on a failed context or timeout. A job
waiting for an unavailable executor is not success.

## Failure meanings

- `detected 'unknown'`: report the remote identity from `detect-forge.bash`;
  do not try speculative provider endpoints.
- `no Git credential`: configure the remote's Git credential or provide
  `GITEA_TOKEN`; never embed a secret in the remote URL.
- `timed out waiting`: report the contexts still pending and the exact SHA.
  Do not describe the run as passing.
