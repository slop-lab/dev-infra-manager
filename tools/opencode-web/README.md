# OpenCode browser client on GitHub Pages

This is a static build of OpenCode's own UI, pinned with its server to 1.18.31
and upstream commit `014614d35b397775e5d397a490fc72368c894ec2`. It has no default
backend. DIM Web's existing workspace button passes a credential-free launch link
that registers or reuses the approved server and opens the actual guest checkout.
Required sign-in uses OpenCode's existing credential form. A manually opened client
still offers **Add server**. Sessions, projects, authentication and credential
persistence remain upstream OpenCode code; DIM adds disconnected startup, hash
routing and a small pinned workspace-link adapter.

The default URL is:

`https://slop-lab.github.io/dev-infra-manager/opencode-web/`

Pinned versions also have stable URLs under `opencode-web/v/1.18.31/#/`.
OpenCode runs separately inside the workspace with `opencode serve`, not
`opencode web`. Use the [optional tools plugin](../../packages/host/plugins/agent-tools/README.md)
to configure it. HTTPS Pages requires an HTTPS/WSS backend; an HTTP-only
remote server will be blocked by browser mixed-content rules. CORS must allow
`https://slop-lab.github.io`, the origin without repository/version paths.

For a local client, `dim forward WORKSPACE 4096:4096` provides
`http://127.0.0.1:4096`. Chromium's local-network permission allowed this loopback
connection in the deployed Pages acceptance check; grant that permission when
prompted. A remote HTTP address still needs an approved HTTPS endpoint.

## Workspace launch links

The workspace panel selects a running server's approved **Service URL**, including
shared control-plane ingress URLs, not its worker relay or permanent-link address.
Only HTTPS or explicitly published loopback HTTP endpoints are usable. If none
exists, the panel retains the route/forwarding setup flow; a guest-local loopback
address alone does not prove a browser-side forward exists.

The adapter accepts `#/dim/open?server=ENCODED_ENDPOINT&directory=ENCODED_DIRECTORY`.
Endpoints cannot contain userinfo, queries, fragments or traversal. Directories
must be canonical guest paths under `/workspace`, including spaces and Unicode.
Credentials, host private paths and executable selection never belong in this
contract. Malformed or extra parameters fail before registration. No new
credential storage or authorization handoff is added. Existing normalized server
registrations retain their credentials; normal project and draft APIs deduplicate
repeated opens. The existing default-server setting retains selection on reload.
Unavailable servers expose Retry; normal authentication failures remain retryable.

## Publish with GitHub Actions

[OpenCode Web Pages](../../.github/workflows/opencode-pages.yml) builds and deploys
changes to this tool on both `main` and `development` pushes, and supports a
manual run from either branch. Both branches publish the same public URL: the
last successful deployment wins. A single concurrency group serializes the
archive and deployment; an active deployment is allowed to finish.

Configure repository **Settings → Pages → Source → GitHub Actions**, and allow
`main` and `development` in the `github-pages` environment's deployment rules.
The workflow uses only the repository's short-lived `GITHUB_TOKEN` and Pages OIDC.
No OpenCode login, router token, host configuration or user credential is needed.
It never deploys pull requests or arbitrary manual-run branches.

The build job has read-only repository access. It checks the reviewed upstream
commit, uses the exact Bun version from `upstream.json`, and installs the frozen
upstream dependencies without install scripts. All actions are pinned to commit
SHAs. Only the archive/deployment job receives `contents: write`, `pages: write`
and `id-token: write` permissions.

The `gh-pages` branch is a generated static archive. Each deployment restores
it, replaces the current `opencode-web/v/VERSION`, updates the default redirect
and versions manifest, then deploys the archived tree with Pages Actions.
Older versions and unrelated Pages content remain available. The branch is
created on the first deployment and is not itself the Pages publishing source.
Updating `tools/opencode-web/upstream.json` deliberately selects a new reviewed
OpenCode/Bun pin; the versioned URL remains tied to that upstream version.

## Local build and staging

Install Bun 1.3.14 and Node 24/26, then explicitly build the pinned source:

```sh
node tools/opencode-web/build.ts
```

The source cache lives outside this checkout and must match the exact reviewed
commit. Dependency installation uses the frozen upstream lockfile and disables
install scripts. The temporary source edits are restored even when build fails.
Only generated static assets are copied to `build/opencode-web/v/1.18.31/`.
For private local verification, pass an explicit output under `.local/` so generated
upstream bundles are outside repository source compiler scans:

```sh
node tools/opencode-web/build.ts /absolute/pinned-source "$PWD/.local/opencode-link/build"
DIM_CHROMIUM=/absolute/chromium node scripts/checks/opencode-workspace-link.ts \
  "$PWD/.local/opencode-link/build" /absolute/opencode-1.18.31
```

The real-browser check requires a disposable Linux checkout at `/workspace/main`;
the Pages workflow creates that layout with an owned runner bind mount. It starts
two isolated real backends with private HOME/XDG state and an explicit Chromium
local-network permission. Only static Pages assets are served locally; server,
authentication, registration, project and session behavior are real. It checks
eight scenarios and malformed-link boundaries without raw traces or credentials.
The build type-checks the patched upstream application and restores every modified
source even on failure; staging rejects artifacts lacking workspace-link support.
No credentials or host configuration are part of the artifact.

Generated artifacts belong to the separate `gh-pages` archive branch. To inspect
the exact output locally when that branch already exists:

```sh
git worktree add .pages-worktree gh-pages
node tools/opencode-web/stage.ts .pages-worktree
git -C .pages-worktree status
```

For a first local inspection, create a separate orphan `gh-pages` worktree.
Building or staging locally does not publish anything; the Actions workflow
owns public deployment. The staging command updates only the current
`opencode-web/v/VERSION`, its default redirect and versions manifest. Other
versions and unrelated Pages content are preserved. Fixes can replace the
current pinned version without deleting older versions.

The adapter follows the useful static/disconnected-server and versioned-branch
policy of [empty-opencode-web](https://github.com/my-trash-bin/empty-opencode-web),
without its portable server, Android, certificate-generation or Docker stack.
Upstream source and licensing remain
[OpenCode](https://github.com/anomalyco/opencode/tree/v1.18.31).
