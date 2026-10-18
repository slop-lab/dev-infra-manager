# OpenCode browser client on GitHub Pages

This is a static build of OpenCode's own UI, pinned with its server to 1.18.31
and upstream commit `014614d35b397775e5d397a490fc72368c894ec2`. It has no default
backend. Open it, select **Add server**, and enter an approved HTTPS OpenCode
server and its own Basic credentials. Its sessions and terminal UI remain
upstream OpenCode code; DIM adds only disconnected startup and hash routing.

The default URL is:

`https://slop-lab.github.io/dev-infra-manager/opencode-web/`

Pinned versions also have stable URLs under `opencode-web/v/1.18.31/#/`.
OpenCode runs separately inside the workspace with `opencode serve`, not
`opencode web`. Use the [optional tools plugin](../../plugin-agent-tools/README.md)
to configure it. HTTPS Pages requires an HTTPS/WSS backend; an HTTP-only
remote server will be blocked by browser mixed-content rules. CORS must allow
`https://slop-lab.github.io`, the origin without repository/version paths.

## Build and stage

Install Bun 1.3.14 and Node 24/26, then explicitly build the pinned source:

```sh
node tools/opencode-web/build.mjs
```

The source cache lives outside this checkout and must match the exact reviewed
commit. Dependency installation uses the frozen upstream lockfile and disables
install scripts. The temporary source edits are restored even when build fails.
Only generated static assets are copied to `build/opencode-web/v/1.18.31/`.
No credentials or host configuration are part of the artifact.

Generated artifacts belong to the separate `gh-pages` branch. If the branch
already exists:

```sh
git worktree add .pages-worktree gh-pages
node tools/opencode-web/stage.mjs .pages-worktree
git -C .pages-worktree status
```

For the first deployment, create a separate orphan `gh-pages` worktree. Review
and commit the staged output there, then push that branch and configure Pages
to deploy from its root. Publishing is an explicit maintainer action, not a
side effect of building DIM. The staging command updates only the current
`opencode-web/v/VERSION`, its default redirect and versions manifest. Other
versions and unrelated Pages content are preserved. Fixes can replace the
current pinned version without deleting older versions.

The adapter follows the useful static/disconnected-server and versioned-branch
policy of [empty-opencode-web](https://github.com/my-trash-bin/empty-opencode-web),
without its portable server, Android, certificate-generation or Docker stack.
Upstream source and licensing remain
[OpenCode](https://github.com/anomalyco/opencode/tree/v1.18.31).
