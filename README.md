# DIM self-development root

This is the minimal, security-sensitive root repository for DIM's own Project.
The reviewed [`.dim`](.dim) lifecycle bootstraps the private development
runtime and assembles the independently managed repositories under
`/workspace`. Ordinary source, tests, tooling, examples, and specifications do
not live in this repository.

[`.dim/repos.yml`](.dim/repos.yml) is the reviewed repository catalog. The
lifecycle clones the `development` repository at `/workspace` and the other
registered repositories as siblings (`core`, `core-development`, plugin
source and development pairs, `verification`, `examples`, and
`specification`). Existing agent-controlled checkouts are never modified by
the trusted outer lifecycle. New checkouts use the runtime manifest's resolved
commit SHA, so candidate refs and moving branches cannot change the materialized
repository set after DIM creates the snapshot.

The reviewed [QEMU cache hook](.dim/ci/qemu-cache.bash) seeds the pinned Ubuntu
image used by DIM's nested installer verification into the Project-scoped
runner base. It runs only while Packer builds that base; pull-request jobs see
the result through their disposable overlay and cannot modify the persistent
cache.

Create the split self-development Project from the root branch:

```bash
dim project create dim \
  --bootstrap-git-url https://github.com/slop-lab/dev-infra-manager.git \
  --bootstrap-git-ref dev/root
dim workspace create dim dim-dev
dim workspace run dim-dev codex
```

When the workspace was created with KVM, the agent can run the reviewed local
QEMU gate without receiving `/dev/kvm` or a QEMU binary itself:

```bash
node project/.dim/qemu-client.mjs run
node project/.dim/qemu-client.mjs run --input fixtures=/workspace/local-fixtures
node project/.dim/qemu-client.mjs probe
```

Additional inputs must resolve beneath `/workspace`. They are copied into the
guest under `/mnt/dim-inputs/NAME`; they are not host bind mounts and cannot
escape the agent-visible source boundary. `status`, `follow`, and `cancel`
subcommands control the single workspace-scoped run.

The canonical Project runs its development agent as UID 0 only inside a
private rootless `agent-dind`. The daemon adopts the workspace checkout's
non-root UID/GID, so inner UID 0 maps to that owner rather than to root in the
trusted workspace or host. Docker authority is confined to that inner
rootless boundary. Selecting
the `secure` workspace profile starts a separate `secure-dind` daemon with its
own storage and without agent home, source, or Git credential mounts for
Project-defined secret-bearing workloads.

The root lifecycle clones missing registered managed repositories into
`/workspace` using the runtime catalog. It never runs Git against an
existing agent-controlled checkout; agents fetch, switch, and update those
repositories from inside their private development runtime. Run local source
checks from the assembled development workspace:

```bash
pnpm install --frozen-lockfile
just check-source
```

## Install an unreleased source build on the host

From a host checkout of this root repository, clone the production source
repositories from the same Git host, build and install them, and restart the
controller:

```bash
just install-local
```

The recipe requires Git, Node.js 24 or 26, pnpm 10, and the existing DIM
installer facade. It clones only `core`, `plugin-dns-cloudflare`, and
`plugin-external-urls`; no workspace or `*-development` checkout is used. Each
resolved commit is printed before the build. A split `root.git` origin clones
`main` from sibling repositories. A canonical monorepo origin instead clones
the matching `dev/core` and `dev/plugin-*` branches from that same origin. Set
`DIM_SOURCE_ROOT_URL`, `DIM_SOURCE_REPOSITORY_BASE_URL`, or `DIM_SOURCE_REF` to
override source resolution.
Cloned sources and package tarballs remain under `.local/production-source`
and `.local/dim-packages` for inspection after the command completes; the next
run replaces their contents.
