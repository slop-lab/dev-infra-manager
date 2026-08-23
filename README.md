# DIM self-development root

This checkout is being shaped into DIM's minimal self-development `root`
repository. The reviewed [`.dim`](.dim) lifecycle bootstraps a private runtime;
ordinary development source and tooling live under [`workbench`](workbench).

The workbench is a transitional integrated tree whose subdirectories are the
future repository boundaries:

- `workbench/core`: minimal, self-contained DIM production build inputs
- `workbench/core-development`: core tests, fixtures, and test-only tooling
- `workbench/plugin-*`: independently selected, self-contained plugin sources
- `workbench/plugin-*-development`: each plugin's paired development suite
- `workbench/verification`: cross-repository, container, host, and KVM gates
- `workbench/examples`: reviewed Project examples
- `workbench/specification`: user documentation and normative specifications
- all other `workbench` files: the common development environment

`.gitea`, `.github`, `.agents`, and `AGENTS.md` are explicitly classified as
transition-only coordination files rather than silently assigned to `root`.
[`repository-boundaries.json`](repository-boundaries.json) is the complete
ownership contract, and `.dim/verify-repository-boundaries.mjs` rejects any
tracked path without exactly one most-specific owner.

The same contract also defines each future repository name and the prefix
removed during extraction. `.dim/materialize-repository-boundaries.mjs`
materializes migration-ready repository trees using tracked files only;
`just check-source` exercises that extraction in a temporary directory,
builds every production repository without its development repository, then
runs each paired development suite against the extracted sibling sources.

For the current integrated development workflow, enter the workbench first:

```bash
cd workbench
pnpm install --frozen-lockfile
just check-source
```
