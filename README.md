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

The root lifecycle clones missing registered managed repositories into
`/workspace` using the runtime catalog. It never runs Git against an
existing agent-controlled checkout; agents fetch, switch, and update those
repositories from inside their private development runtime. Run local source
checks from the assembled development workspace:

```bash
pnpm install --frozen-lockfile
just check-source
```

## Install an unreleased workspace build on the host

From a host checkout of this root repository, build only the production source
repositories in an existing self-development workspace, stream the package
bundle back through `dim run`, install it, and restart the controller:

```bash
just install-workspace-build dim-dev
```

This deliberately installs the workspace's current source, including
uncommitted changes. Review its state before running the recipe. The transfer
uses the Project task stream and does not depend on DIM's internal Docker
container name or require a host checkout of the `*-development` repositories.
