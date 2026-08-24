# Project Repositories

DIM models a development project as a managed Git namespace plus
project-scoped repository aliases. The built-in service creates a reserved
Gitea organization named `dim-<project>`.

For a complete, tested, end-to-end walkthrough instead of a reference, see
[Example: External URLs](../../examples/features/external-urls/README.md).

## Create and populate a project

Create Project metadata and import a root using the invoking host Git CLI:

```bash
dim project create example \
  --bootstrap-git-url https://github.com/example/product \
  --bootstrap-git-ref main \
  --apply-repos
```

The selected root ref's `.dim/repos.yml` declares the root alias, connection,
ref, and protection policy. DIM automatically applies remaining repositories
when all entries use that bootstrap origin. If another origin appears, an
interactive invocation asks first and automation uses `--apply-repos`;
`--no-apply-repos` always skips explicitly. Skipping never requires a local
clone later:

```bash
dim repo plan example
dim repo apply example --yes
```

Both commands read `.dim/repos.yml` from DIM's managed root when `--file` is
omitted.

The recorded URL remains the repository's external `origin`. Refresh its
branches without overwriting DIM branches:

```bash
dim repo fetch example root
# external main is now the managed branch upstream/main
```

Use `--prune` to remove only stale `upstream/*` tracking branches. Tags keep
their original names and conflicting tag updates are rejected.

Publishing uses reviewed branch mappings from `.dim/repos.yml` and is never
forced:

```yaml
repositories:
  root:
    url: https://github.com/example/product.git
    root: true
    publish:
      main: development
```

```bash
dim repo publish example root
dim repo publish example # every repository with a publish policy
```

An explicit import mapping can give a managed repository a conventional local
branch while sourcing it from a differently named archive branch. Import and
publish authority stay separate even when they intentionally use the same
mapping:

```yaml
repositories:
  core:
    url: https://github.com/example/archive.git
    import: {main: dev/core}
    publish: {main: main}
```

This creates only managed `core/main` from external `dev/core`; unrelated
archive branches and tags are not copied into that managed repository. The
publish destination `main` is connection-relative, so the import mapping
projects it back to external `dev/core`.

The default `repo add URL` import copies branches and tags. Use `--mirror` only
when server-private refs must also be copied.

The source may be any URL or path accepted by host Git. Repository aliases are
explicit and Project-scoped. An empty managed repository omits the URL:

```bash
dim repo add example scratch
```

## Multiple repositories

Aliases are local to a Project, so every Project may have `product`,
`development`, and `environment` without global naming conventions:

```bash
dim repo add example product
dim repo add example environment https://example.com/environment
dim repo list example
```

Permanently delete an unused non-root repository from DIM and managed Gitea:

```bash
dim repo delete example environment --yes
```

The command rejects a Project that still has workspaces. The root repository
cannot be removed independently because every runnable Project must retain
exactly one root; remove or purge the whole Project instead.

For a complete set, commit a `.dim/repos.yml` to the root repository whose
mapping keys are aliases:

```yaml
schemaVersion: 1
repositories:
  root: {url: https://example.com/product, root: true, ref: main}
  product: {url: https://example.com/product-code}
  environment: {url: https://example.com/environment}
```

```bash
dim project create example \
  --bootstrap-git-url https://example.com/product \
  --bootstrap-git-ref main \
  --apply-repos
```

`project create --repos FILE` remains available when the repository set is a
standalone local bootstrap input rather than reviewed root content.

Several managed repositories may also share one external Git repository
without rewriting commits. Assign each non-fallback repository a disjoint ref
prefix; refs not claimed by those prefixes belong to the explicit fallback:

```yaml
schemaVersion: 1
upstreams:
  product:
    url: https://example.com/product.git
repositories:
  root: {upstream: product, fallback: true, root: true, ref: main}
  api: {upstream: product, refPrefix: api/}
```

Here managed `api` branch `main` maps to external branch `api/main`, while the
root's `main` remains external `main`. The same rule applies to tags. Prefixes
must end in `/` and may not overlap; each shared upstream may have at most one
fallback. Unmatched refs are ignored when no fallback is declared. See the
[shared-upstream feature example](../../examples/features/shared-upstream/README.md).

DIM directly clones only the configured root. The root `.dim` lifecycle reads
the `repositories` catalog in `DIM_PROJECT_MANIFEST` for the actual registered
aliases, phases, and credential-free workspace URLs. The Project-specific
`DIM_GIT_BASE_URL` remains available for compatibility with simple alias-based
URL construction. The Project owns checkout selection, paths, integrated build
layout, and nested services; DIM does not create per-repository environment
variables or require one container per repository.

## Workspaces

```bash
dim workspace create example dev --profile development
dim workspace exec dev -- bash
dim workspace run dev codex
```

Project or remote changes never alter a running workspace automatically.

```bash
dim workspace restart dev   # stop, start, root fast-forward, setup
dim workspace stop dev
dim workspace start dev     # root fast-forward and setup
```

Dirty root checkouts and non-fast-forward updates are rejected. For a running
workspace, restart performs these checks before it stops anything. A rejected
restart leaves the workspace and its Project services running and prints the
explicit `dim workspace align WORKSPACE --reset --yes` recovery command when
discarding the local state is intended. Stop/start and restart preserve the
root checkout and inner-engine volume.

```bash
dim workspace list
dim workspace show dev
dim workspace discard dev --yes
```

## State compatibility

DIM does not implicitly migrate incompatible pre-stable repository/workspace
state. Push all work before upgrading, explicitly clean old resources with the
old CLI, then create the Project and workspace again. Unknown state is rejected
without mutation.
