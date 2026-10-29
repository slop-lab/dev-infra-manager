# GS source export

`scripts/packages/export-gs-source.ts` creates an offline, source-only export of
the committed `packages/gs` tree. Run it with Node 24 or 26 from a full,
non-shallow checkout:

```sh
node scripts/packages/export-gs-source.ts \
  --source /absolute/path/to/dim-checkout \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --output /absolute/private/path/new-gs-export
```

The commit must be a full SHA-1 or SHA-256 object ID matching the repository's
object format. The output must be an absent absolute path outside the source
checkout. The tool does not fetch from a forge, contact a registry, install
packages, publish artifacts, build images, or modify source refs, configuration,
the index, or the worktree.

The new output contains:

- `source/`: exact committed blobs from `packages/gs`, with that prefix removed;
  regular and executable modes are retained, and only relative symlinks that
  remain inside `source/` after expansion through the complete selected symlink
  graph are accepted.
- `source-history.bundle`: the selected original commit and all of its original
  ancestry under `refs/heads/source-commit`. It is not filtered or rewritten.
- `export-manifest.json`: the source commit and trees, bundle digest/ref,
  optional root `pnpm-lock.yaml` provenance, every exported source/export path,
  Git blob ID, mode and SHA-256 content digest, plus the committed GS package
  manifests and their declared dependency edges.

Workspace dependencies must close over package names present in the selected GS
tree. Declared DIM package dependencies and missing GS workspace packages stop
the export. The root monorepo lock digest is provenance only; it is not copied
into `source/` or required by a later standalone GS build. A committed lockfile
inside `packages/gs` is ordinary source and is exported.

Verify and recover history without a forge:

```sh
GIT_MASTER=1 git clone --branch source-commit \
  /absolute/private/path/new-gs-export/source-history.bundle recovered-gs-history
GIT_MASTER=1 git -C recovered-gs-history show \
  OLD_COMMIT:packages/gs/path/at-that-commit
```

The export contains no monorepo tests because tests remain in the central
`tests/` workspace. Standalone installation, lockfile generation, compilation,
and composition checks are separate explicit downstream steps.
