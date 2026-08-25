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

Create the split self-development Project from the root branch:

```bash
dim project create dim \
  --bootstrap-git-url https://github.com/slop-lab/dev-infra-manager.git \
  --bootstrap-git-ref dev/root
dim workspace create dim dim-dev
dim workspace run dim-dev codex
```

The canonical Project runs the non-root development agent at the workspace
checkout's UID/GID inside a private rootful `agent-dind`; passwordless sudo and
Docker authority are confined to that inner boundary. Selecting
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
