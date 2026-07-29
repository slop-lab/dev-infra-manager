# Project Repositories

DIM models a development project as a managed Git namespace plus
project-scoped repository aliases. The built-in service creates a reserved
Gitea organization named `dim-<project>`.

For a complete, tested, end-to-end walkthrough instead of a reference, see
[Example: External URLs](../examples/external-urls/README.md).

## Create and populate a project

Create Project metadata and import a root using the invoking host Git CLI:

```bash
dim project create example
dim repo add example root https://github.com/example/product \
  --root --ref main --protect main
```

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

For a complete set, use a `repos.yml` whose mapping keys are aliases:

```yaml
schemaVersion: 1
repositories:
  root: {url: https://example.com/product, root: true, ref: main}
  product: {url: https://example.com/product-code}
  environment: {url: https://example.com/environment}
```

```bash
dim project create example --repos repos.yml
```

DIM directly clones only the configured root. The root `.dim` lifecycle reads
`DIM_PROJECT_MANIFEST` and the Project-specific `DIM_GIT_BASE_URL`, then
constructs stable URLs such as `$DIM_GIT_BASE_URL/product.git`. The Project
owns checkout paths and nested services; DIM does not create per-repository
environment variables or require one container per repository.

## Workspaces

```bash
dim create example dev --profile development
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

DIM does not implicitly migrate incompatible pre-stable repository/workspace
state. Push all work before upgrading, explicitly clean old resources with the
old CLI, then create the Project and workspace again. Unknown state is rejected
without mutation.
