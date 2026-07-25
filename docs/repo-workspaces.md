# Project Repositories

DIM 0.2 models a development project as a managed Git namespace plus
project-scoped repository aliases. The built-in service creates a reserved
Gitea organization named `dim-<project>`.

For a complete, tested, end-to-end walkthrough instead of a reference, see
[Example: A Multi-repository Project](example-project.md).

## Create and populate a project

Create Project metadata and an empty root repository:

```bash
dim project create example
dim repo create example root --root
```

Populate it with ordinary Git. DIM does not require a local bare repository:

```bash
git clone https://github.com/example/product.git local-product
git -C local-product push \
  "$(dim repo url-for-host example root)" \
  main
dim repo protect example root
```

`dim x git` supplies managed Gitea credentials when the user's normal Git
credential configuration does not:

```bash
dim x git -C local-product push \
  "$(dim repo url-for-host example root)" \
  main
```

Run `dim git setup` once to install a URL-scoped credential helper when
ordinary Git commands should authenticate without the one-shot wrapper.

Import is an optional mirror convenience:

```bash
dim repo import example root https://github.com/example/product.git \
  --root --ref main
```

## Multiple repositories

Aliases are local to a Project, so every Project may have `product`,
`development`, and `environment` without global naming conventions:

```bash
dim repo create example product
dim repo create example environment
dim repo list example
```

DIM directly clones only the configured root. The root `.dim` lifecycle reads
`DIM_PROJECT_MANIFEST` and the Project-specific `DIM_GIT_BASE_URL`, then
constructs stable URLs such as `$DIM_GIT_BASE_URL/product.git`. The Project
owns checkout paths and nested services; DIM does not create per-repository
environment variables or require one container per repository.

## Workspaces

```bash
dim create example dev --backend sysbox --profile development
dim exec dev -- bash
dim run dev codex
```

Project or remote changes never alter a running workspace automatically.

```bash
dim restart dev   # stop, start, root fast-forward, setup
dim stop dev
dim start dev     # root fast-forward and setup
```

Dirty root checkouts and non-fast-forward updates are rejected. Stop/start and
restart preserve the root checkout and inner-engine volume.

```bash
dim ls
dim show dev
dim discard dev --yes
```

## State compatibility

DIM 0.2 does not migrate 0.1 repository/workspace state. Push all work before
upgrading, explicitly clean old resources with the old CLI, then create the
Project and workspace again. Unknown old state is rejected without mutation.
