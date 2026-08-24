# DIM self-development root

This checkout is being shaped into DIM's minimal self-development `root`
repository. The reviewed [`.dim`](.dim) lifecycle bootstraps a private runtime;
ordinary development source and tooling live under [`workbench`](workbench).

The source checkout stages the independently published repositories that the
reviewed `root` catalog materializes into one integrated workbench:

- `workbench/core`: minimal, self-contained DIM production build inputs
- `workbench/core-development`: core tests, fixtures, and test-only tooling
- `workbench/plugin-*`: independently selected, self-contained plugin sources
- `workbench/plugin-*-development`: each plugin's paired development suite
- `workbench/verification`: cross-repository, container, host, and KVM gates
- `workbench/examples`: reviewed Project examples
- `workbench/specification`: user documentation and normative specifications
- all other `workbench` files: the `development` repository

`.gitea` and `.github` are explicitly classified as transition-only archive
coordination files rather than silently assigned to `root`. Agent guidance and
the repository-local skills live in `workbench`, so they are materialized with
the `development` repository.
[`repository-boundaries.json`](repository-boundaries.json) is the complete
ownership contract, and `.dim/verify-repository-boundaries.mjs` rejects any
tracked path without exactly one most-specific owner.

The same contract also defines each repository name and the prefix
removed during extraction. `.dim/materialize-repository-boundaries.mjs`
materializes migration-ready repository trees using tracked files only;
`just check-source` exercises that extraction in a temporary directory,
builds every production repository without its development repository, then
runs each paired development suite against the extracted sibling sources.

Create the split self-development Project from the root branch:

```bash
dim project create dim \
  --url https://github.com/slop-lab/dev-infra-manager.git \
  --ref dev/root --apply-repos
dim workspace create dim dim-dev
dim workspace run dim-dev codex
```

The root lifecycle clones missing registered managed repositories into
`/workspace/workbench` using the runtime catalog. It never runs Git against an
existing agent-controlled checkout; agents fetch, switch, and update those
repositories from inside their private development runtime. For local source
checks in this staging checkout, enter the workbench first:

```bash
cd workbench
pnpm install --frozen-lockfile
just check-source
```
