# DIM self-development root

This checkout is being shaped into DIM's minimal self-development `root`
repository. The reviewed [`.dim`](.dim) lifecycle bootstraps a private runtime;
ordinary development source and tooling live under [`workbench`](workbench).

The workbench is a transitional integrated tree whose subdirectories are the
future repository boundaries:

- `workbench/core`: DIM core packages and runtime images
- `workbench/specification`: user documentation and normative specifications
- `workbench/plugins/*`: independently selected plugin implementations
- all other `workbench` files: the future development monorepo

`.gitea`, `.github`, `.agents`, and `AGENTS.md` are explicitly classified as
transition-only coordination files rather than silently assigned to `root`.
[`repository-boundaries.json`](repository-boundaries.json) is the complete
ownership contract, and `.dim/verify-repository-boundaries.mjs` rejects any
tracked path without exactly one most-specific owner.

For the current integrated development workflow, enter the workbench first:

```bash
cd workbench
pnpm install --frozen-lockfile
just check-source
```
