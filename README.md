# dev-infra-manager

**Persistent workspaces. Clean verification. Reviewed promotion.**

`dev-infra-manager` (DIM) is a self-hosted execution and trust layer for
coding-agent development on Linux.

DIM turns a Linux host into Project-scoped development infrastructure where
coding agents can install tools, run services, and build or run nested
containers without receiving direct control of the host container runtime.
Each Project can combine:

- Workspaces that persist across agent turns and retries and are removed only
  through an explicit discard lifecycle.
- Docker-capable workspaces backed by selectable isolation runtimes, without
  exposing the host container daemon directly to the agent.
- Managed Git and CI as the promotion boundary between mutable workspaces and
  protected Project state.
- A reviewed Project contract that defines a complete multi-repository
  workspace and its lifecycle.
- Separation between agent-controlled code and operations that receive
  secrets.
- Per-workspace CPU, memory, and process limits.

DIM sits below interactive coding agents and autonomous orchestrators. OpenCode,
Claude Code, or another agent can run in a DIM workspace. An orchestrator such
as OpenAI Symphony can map a task to a persistent DIM workspace while DIM owns
the workspace, repository, verification, and trust boundaries.

DIM does not decide what work an agent should do, replace an issue tracker, or
prescribe an agent workflow. It controls where work runs, what infrastructure
it can reach, and which reviewed path can promote its output.

## The trust path

A typical DIM Project separates mutable development from trusted promotion:

```text
agent workspace
  persistent across turns and retries
  no raw project/runtime secrets
        |
        | commit and push
        v
project-scoped Git branch
        |
        | isolated verification in a separate checkout
        v
CI result and review evidence
        |
        | explicit review gate
        v
protected ref or trusted Project runtime
        |
        | scoped secret-bearing operation
        v
artifact, signing, publishing, or deployment
```

DIM's canonical public source is this integrated root monorepo on GitHub. A
self-development Project's managed Git service and runner may provide internal
review and CI, but neither managed implementation is part of the long-term
Project contract.

Workspaces persist. Verification runs separately in disposable job containers.
Secret-bearing Project services must be built and deployed from reviewed refs.

## Typical uses

### Interactive coding-agent workspaces

Keep a workspace across multiple agent sessions, run nested Docker workloads
inside it, and explicitly discard it when the work is finished.

### Orchestrated autonomous implementation

Let an external control plane own task selection, scheduling, retries, and
agent sessions while DIM owns workspace isolation, repository state, CI
verification, and promotion gates. DIM does not yet ship a Symphony-specific
adapter or stable orchestrator API.

### Agent-authored changes with separate CI

Allow an agent to modify arbitrary code in its workspace while repeating
checks in a separate runner checkout and disposable job container that has no
host Docker socket or DIM workspace credentials.

### Reviewed secret-bearing operations

Keep signing, publication, deployment, and other privileged work outside the
agent container. Current Projects implement this with reviewed lifecycle code
and separate services; DIM does not claim that container separation alone is a
strong boundary inside a privileged workspace.

### Multi-repository projects

Use a reviewed root Project contract to provide stable repository aliases,
lifecycle hooks, protected refs, and coordinated workspaces for changes that
span multiple repositories.

## Security and release status

> [!WARNING]
> DIM has no stable release and is part of the host trust boundary. Adoption
> requires human review of the exact DIM revision, the Project contract, and
> every input that can influence a secret-bearing runtime. Pin exact versions
> and immutable source revisions.

Pre-stable `0.x` releases may change CLI, API, configuration, state, backend,
and plugin contracts without compatibility shims or implicit migration.

DIM supports Linux hosts only. macOS and Windows are not supported host
platforms, including through Docker Desktop.

Licensed under the [MIT License](LICENSE). Release history is recorded in the
[changelog](CHANGELOG.md).

Before using DIM in another project, read the mandatory [adoption and trust
requirements](specification/docs/adoption.md). They require full human review of DIM, the
project repository, and every secret-bearing environment, plus immutable
version pinning.

This page covers using DIM. Building or contributing to DIM itself —
running its own test/verification suite, publishing packages, testing host
installers — is [CONTRIBUTING.md](CONTRIBUTING.md).

## Set up a host runtime backend

The host-installer scripts are development-source assets, so installing a
backend from this repository still requires a reviewed checkout. The published
`dim` CLI now ships the trusted workspace-image build inputs and does not need
this checkout when building the image:

```bash
git clone --no-checkout <this-repository>
cd dev-infra-manager
git checkout --detach <reviewed-tag-or-full-commit>
bash verification/scripts/install-host-ubuntu.bash sysbox
```

After installing the exact reviewed CLI version below, build its matching image
from any directory:

```bash
dim workspace image build
dim workspace image status
```

The build tags the trusted image as
`dev-infra-project-workspace:<release version>`, matching the default selected
by the same DIM package release. Set `DIM_WORKSPACE_IMAGE` only when an explicit
different image reference is required.

`dim workspace image build` is the installed release-image path. It uses the
current UID and GID and the trusted assets shipped with the CLI's exact core and
controller-proxy versions. An explicitly tagged `DIM_WORKSPACE_IMAGE` may
replace the default destination; IDs, digests, untagged destinations, and
`latest` are rejected. Contributors use `just prepare-local` to build a matched
package/image candidate from one reviewed root commit. The separate `just
build-local-workspace-image` recipe is an image-only convenience for the current
worktree; see [CONTRIBUTING.md](CONTRIBUTING.md).

Run `just` as your normal user, including when it is managed by mise. The
installer invokes `sudo` only for host changes, and adds the invoking user to
the `docker` group; log out and back in or run `newgrp docker` once after the
first installation.

> [!WARNING]
> Access to the host Docker daemon, including membership in the `docker` group,
> is effectively root-level host access. Use a dedicated DIM host or service
> identity if that trust assumption is not acceptable. Agent containers must
> never receive the host Docker socket.

The installer shows every package and host-level change before doing anything
and proceeds only after you enter `yes`. It is a development convenience, not
production hardening guidance. In particular, review its path-scoped AppArmor
exceptions for Sysbox FUSE mounts and rootless DinD's
`/usr/local/bin/rootlesskit` user namespace before using it outside a
development host.

Install the supported workspace backend:

```bash
bash verification/scripts/install-host-ubuntu.bash sysbox
```

See [docs/runtime-backends.md](specification/docs/runtime-backends.md) for the
trusted-runc and untrusted-Sysbox boundary, and [CONTRIBUTING.md](CONTRIBUTING.md) for testing the installer in a
disposable KVM guest instead of your own host.

## Install the `dim` CLI

Pin an exact, reviewed version — never `latest`:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.8.0'
dim install-cli
```

The mise-installed facade provisions Node.js 24 on demand when no supported
Node.js is on `PATH`; Node.js does not need to be added to the global mise
configuration. The first `dim` invocation may therefore download Node.js.

or, without mise:

```bash
npx '@slop-lab/dim-installer@0.8.0'
npx '@slop-lab/dim-installer@0.8.0' install-cli
npx '@slop-lab/dim-installer@0.8.0' install-plugin '@example/dim-plugin@1.2.3'
```

`@slop-lab/dim-installer` is a thin facade: it owns only `installer`,
`install-cli`, and `install-plugin`, and proxies every other command to a
separately installed `@slop-lab/dim-cli`. Bare `dim` opens an interactive
installer only until a CLI is configured; after that it behaves like `dim
--help`, and `dim installer` is what reopens the prompt. Installation
choices persist under `${XDG_CONFIG_HOME:-~/.config}/dim/config.json`. See
the [installer README](https://www.npmjs.com/package/@slop-lab/dim-installer)
for the full command reference.

Check the installed backend before creating a workspace:

```bash
dim doctor
```

If the CLI was installed without configuring a host backend, configure one
through the same diagnostic path:

```bash
dim doctor configure-backend
```

DIM uses an explicitly enabled, versioned plugin loader for concrete
integrations. It does not expose a generic Git-provider extension point. See
[docs/plugins.md](specification/docs/plugins.md).

## Create a Project

```bash
dim project create project \
  --bootstrap-git-url /path/to/project --bootstrap-git-ref main --apply-repos
dim workspace create project work-1
dim workspace exec work-1 -- bash
```

The selected ref's `.dim/repos.yml` supplies the stable root and non-root
repository aliases. `--apply-repos` applies the complete reviewed set without
requiring a separate local manifest.

If an interactive prompt is declined, apply the managed root file later
without a local clone using `dim repo apply project --yes`.

The keys below `repositories` are Project-scoped aliases; URLs are passed to
the host Git CLI and are never parsed to invent a name.

This repository implements the same project contract on itself through
`.dim/setup.sh` and `.dim/entrypoint.sh`.

### Set up the Project-configured agent tool

The development agent image provides Node.js and npm but does not bake in a
coding agent. From a local checkout of this repository, install the reviewed
OpenCode and Oh My OpenAgent versions into the persistent workspace user's
home:

```bash
dim workspace run dim-dev tool-setup \
  && dim workspace run dim-dev agent
```

The generic task names belong to this reviewed Project, not DIM core. The
self-Project maps `tool-setup` to its local OpenCode utility and maps `agent`
to the pinned executable through a contract-versioned launcher manifest below
canonical `$HOME`. Launch rejects a missing manifest, unsupported contract,
unknown launcher, or mismatched tool, version, or executable path. Setup is
safe to rerun. Existing homes are not upgraded automatically: rerun
`tool-setup` explicitly after adopting a reviewed Project change that selects
new tool bytes or versions. It installs under `$HOME/.local`, pins the OMO plugin
coordinate, disables supported automatic updates, enables Team Mode, and
preserves unrelated OpenCode and OMO user configuration. It does not start
OpenCode or perform provider authentication, and lifecycle setup never invokes
it.

OpenCode remains the default helper behavior. A reviewed Project may instead
stream the same checksum-verified helper with the `codex` selection to install
exactly `@openai/codex@0.156.1` and publish the same v1 launcher manifest. The
helper does not log in, start Codex, or create or modify
`$HOME/.codex/auth.json` or `$HOME/.codex/config.toml`. The paired examples
repository documents the minimal selection at `use-cases/codex`; the existing
generic SSH `ProxyCommand` is reused unchanged.

To start an authenticated OpenCode Web server explicitly and request or reuse
its workspace-scoped external URL, run the separate launcher after setup:

```bash
dim workspace run dim-dev bash -- /workspace/scripts/opencode-web.bash
```

If a Web UI hosted at another origin will connect to the returned DIM URL,
pass that UI's origin as an additional exact CORS origin:

```bash
dim workspace run dim-dev bash -- -c \
  'export OPENCODE_WEB_CORS_ORIGINS="$1"; exec bash /workspace/scripts/opencode-web.bash' \
  bash '["https://remote-web.example"]'
```

The command prints the URL, username, and restricted credential-file path; it
does not print the password. The credential, PID identity, and mode-0600 log persist under
`${XDG_STATE_HOME:-$HOME/.local/state}/opencode-web`; rerunning reuses the owned
healthy process and matching URL. It never kills an unrecorded OpenCode
process. OpenCode binds only to `127.0.0.1` on `OPENCODE_WEB_PORT` (default
`4096`). The launcher asks the generic `dim-development-service` helper to
expose the stable `opencode-web` service name and consumes only
`OPENCODE_WEB_URL_SOCKET`; it uses no container path, gateway target port, raw
controller grant, or host secret. Reviewed Project setup binds that service
name to the exact workspace-scoped `<workspace>--opencode` subdomain and the
fixed development gateway target. The proxy rejects other service names and
caller-supplied subdomains. The default `https-ts`
ingress must already be allowed by the trusted bound proxy. `OPENCODE_WEB_INGRESS` selects another
allowed HTTPS ingress, but cannot widen that proxy policy. The launcher requires
the installed helper and GNU `timeout`; it bounds the complete helper process
tree and cleans up only a newly started OpenCode process when exposure fails.
Retrieve the generated username and password explicitly from the first and
second lines of the reported mode-`0600` file, for example with
`dim workspace run dim-dev bash -- -lc 'cat "$HOME/.local/state/opencode-web/credentials"'`.
The launcher always passes `https://localhost:4096` to OpenCode and treats
`OPENCODE_WEB_CORS_ORIGINS` as a JSON array of additional origins, defaulting
to `[]`. Each value
must be an exact HTTP or HTTPS origin, with no wildcard, credentials, path,
query, or fragment. It normalizes, deduplicates, and sorts the list, and rejects
invalid input before creating launcher state. OpenCode 1.18.31 does not treat
`*` as a wildcard origin, so the launcher rejects it rather than suggesting
false broad access. OpenCode may also merge origins from its own configuration
or built-in behavior, so this setting describes the origins supplied by the
launcher rather than a universal deny list.

The allowed origin is the source origin of the browser UI making the request,
such as `https://remote-web.example`, not the destination DIM external URL.
CORS headers produced by OpenCode travel through the external URL route.
Cross-origin requests still require the reported Basic Auth credential, and
the browser client must send it in the `Authorization` header. Repeating the
launcher with the same port and canonical CORS list reuses its healthy owned
process. Changing either restarts only that owned process while retaining the
credential, external URL, and shared gateway. Allow only trusted client UI
origins.

The development-service gateway
listens on its agent-container interfaces at the fixed port reported by
`gateway-port`, then forwards each exact external authority only to the
selected `127.0.0.1:OPENCODE_WEB_PORT` application. The trusted nested route,
when needed, maps that queried gateway port to the same port (`G:G`); changing
the OpenCode application port requires no `.dim` or container-port change.
The independent generic `DIM_EXTERNAL_URL_*` capability remains available to
callers that need to choose arbitrary targets; the OpenCode launcher does not
consume it.

For a workspace that does not have the development checkout, download both
files on the host from one reviewed, full 40-character development commit.
Set `DIM_DEVELOPMENT_COMMIT` to that commit in the environment; never
substitute a moving branch or tag:

Optionally set `OPENCODE_WEB_CORS_ORIGINS='["https://remote-web.example"]'` on
the host before this block to pass additional client UI origins. Unset keeps
only the launcher's default origin.

```bash
# DIM_REMOTE_BOOTSTRAP_BEGIN
(
  set -euo pipefail
  FULL_DEVELOPMENT_COMMIT="${DIM_DEVELOPMENT_COMMIT:?set DIM_DEVELOPMENT_COMMIT to a reviewed full 40-character commit}"
  [[ "$FULL_DEVELOPMENT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'FULL_DEVELOPMENT_COMMIT must be exactly 40 lowercase hex characters\n' >&2
    exit 2
  }
  setup_dir="$(mktemp -d)"
  trap 'rm -rf -- "$setup_dir"' EXIT
  base="https://raw.githubusercontent.com/slop-lab/dev-infra-manager/${FULL_DEVELOPMENT_COMMIT}/scripts"
  curl --fail --silent --show-error --location \
    --output "$setup_dir/workspace-user-setup.bash" \
    "$base/workspace-user-setup.bash"
  curl --fail --silent --show-error --location \
    --output "$setup_dir/workspace-user-setup.bash.sha256" \
    "$base/workspace-user-setup.bash.sha256"
  curl --fail --silent --show-error --location \
    --output "$setup_dir/opencode-web.bash" \
    "$base/opencode-web.bash"
  curl --fail --silent --show-error --location \
    --output "$setup_dir/opencode-web.bash.sha256" \
    "$base/opencode-web.bash.sha256"
  (cd -- "$setup_dir" && sha256sum --check \
    workspace-user-setup.bash.sha256 opencode-web.bash.sha256)
  dim workspace run dim-dev bash -- -s <"$setup_dir/workspace-user-setup.bash"
  dim workspace run dim-dev bash -- -c \
    'export OPENCODE_WEB_CORS_ORIGINS="$1"; exec bash -s' \
    bash "${OPENCODE_WEB_CORS_ORIGINS:-[]}" <"$setup_dir/opencode-web.bash"
)
# DIM_REMOTE_BOOTSTRAP_END
```

For a complete, tested walkthrough that exposes a nested development
container and a container inside it through host-configured external URL
ingresses, see [examples/features/external-urls](examples/features/external-urls/README.md).
For the smallest complete Project with one unprotected repository and no
secrets, see
[examples/projects/single-repository](examples/projects/single-repository/README.md).

See [glossary](specification/docs/README.md#glossary), [docs/repo-workspaces.md](specification/docs/repo-workspaces.md)
for lifecycle, credential, and reconciliation details, and
[docs/project-workspaces.md](specification/docs/project-workspaces.md) for the
project-facing `.dim` contract and CLI lifecycle. [docs/README.md](specification/docs/README.md)
is the full documentation index.
