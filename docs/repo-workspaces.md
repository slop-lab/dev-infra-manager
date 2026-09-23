# Project Repositories

DIM models a development project as a managed Git namespace plus
project-scoped repository aliases. The built-in service creates a reserved
Gitea organization named `dim-<project>`. The Project root is its single issue
tracker: newly created root repositories enable Gitea issues and newly created
non-root repositories disable them. Existing repository settings are not
changed when this policy is introduced or reapplied.

Managed Gitea disables organization creation by regular users. DIM maps
Gitea's `[admin] DISABLE_REGULAR_ORG_CREATION` setting exactly as
`GITEA__admin__DISABLE_REGULAR_ORG_CREATION=true`, leaving reserved namespace
creation under DIM's administrator path.

Project state schema `4` records the reserved organization's trusted numeric
ID in required nullable `giteaOrganizationId`. The field may be null while
creation is incomplete, but a ready Project always has a positive ID. DIM
persists a newly returned ID before marking the Project ready. On retry it
accepts an existing organization only when both the stored ID and reserved
username match. If no ID was captured, a same-name collision fails closed and
requires administrator reconciliation; DIM never adopts it by name.

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
branch while sourcing it from a differently named branch. Import and publish
authority stay separate even when they intentionally use the same mapping:

```yaml
repositories:
  core:
    url: https://github.com/example/source.git
    import: {main: components/core}
    publish: {main: main}
```

This creates only managed `core/main` from external `components/core`;
unrelated source branches and tags are not copied into that managed repository.
The publish destination `main` is connection-relative, so the import mapping
projects it back to external `components/core`.

The default `repo add URL` import copies branches and tags. Use `--mirror` only
when server-private refs must also be copied. An import remains non-ready while
protection is pending. Only DIM's trusted transfer identity can write during
that interval. DIM removes that authority before applying protection, then
grants ordinary repository users only after protection succeeds. A transfer or
protection failure leaves the repository non-ready and denies ordinary writer
access.

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

The command rejects a Project that still has workspaces and rejects the target
while that repository is importing. Another repository importing in the same
Project does not block deletion of a ready target. The root repository cannot
be removed independently because every runnable Project must retain exactly
one root; remove or purge the whole Project instead.

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

DIM publishes only the configured root as an immutable lifecycle snapshot.
The root `.dim` lifecycle owns repository policy and uses the Project-specific
`DIM_GIT_BASE_URL` when it chooses to materialize managed repositories under
`DIM_WORKSPACE_DATA`. The Project owns refs, checkout paths, integrated build
layout, and nested services; DIM does not create per-repository environment
variables, publish a repository catalog, or require one container per repository.

## Workspaces

```bash
dim workspace create example dev --profile development
dim run dev bash
dim run dev bash -- -lc 'just test'
dim exec dev -- bash
```

Workspace creation records only the reviewed root identity. Reviewed Project
code selects non-root refs and materializes them into persistent workspace data.
It should stage a new checkout, disable inherited Git hooks and configuration,
and publish atomically. Existing checkout paths are agent data and must not be
silently rewritten.

`dim run` dispatches through the Project's reviewed entrypoint and is the
normal way to enter a Project-owned agent task. `dim exec` bypasses that
entrypoint and provides raw trusted-workspace access for recovery or lifecycle
administration. Neither command installs coding-agent tools automatically.

Project or remote changes never alter a running workspace automatically.
Trusted Project lifecycle code never executes from Project-owned mutable data.
DIM records an exact approved root commit and uses a controller-owned,
read-only full-tree snapshot for setup, entrypoint, teardown, Compose, and
their relative helpers and build contexts.

DIM treats only exit code `1` from an optional lifecycle-file probe as
absence. Any other probe failure stops the operation before it runs a hook,
Compose, or a direct-command fallback.

Project-owned key-only agent SSH accepts the configured client key for the
non-root `dim-agent` account. Root login stays disabled and is rejected even
when the client offers that same valid key.

```bash
dim workspace restart dev review   # each: stop, start, root fast-forward, setup
dim workspace stop dev
dim workspace start dev     # root fast-forward and setup
```

Restart selects reviewed immutable root bytes before it stops a running
workspace. Project setup decides how to reconcile mutable data and must preserve
existing agent checkouts unless its reviewed contract explicitly directs the
user otherwise. Stop/start and restart preserve workspace data and the
inner-engine volume.

`restart` accepts one or more workspace names and processes them sequentially
in command-line order. It reports each success immediately and stops on the
first failure, identifying that workspace. Earlier restarts remain complete;
later names are not attempted.

DIM ownership-checks the complete workspace container and inner-engine volume
label sets before reuse or mutation. Container lifecycle commands act on the
inspected immutable container ID rather than its reusable name. Docker volumes
have no equivalent immutable ID, so their deletion remains name-based. Discard
validates both resources before teardown and reinspects complete volume
ownership immediately before removal, so a foreign same-name replacement is
left untouched.

```bash
dim workspace list
dim workspace show dev
dim workspace discard dev --yes
```

## State compatibility

DIM does not implicitly migrate incompatible pre-stable repository/workspace
state. Push all work before upgrading, explicitly clean old resources with the
old CLI, then create the Project and workspace again. Unknown state is rejected
without mutation. The sole exception is the lossless host lifecycle schema 1
to 2 transition: managed-controller startup renames `resumeCiRunners` to
`restartCiRunners` before loading plugins or opening listeners and preserves the
original bytes permanently in mode-`0600` `host.json.schema-1.bak`.
That backup is immutable historical recovery material, not a live mirror;
after migration, valid schema `2` `host.json` is authoritative and may evolve
without matching the backup.

Host maintenance state must be a structurally valid schema `2` record with its
exact phase, workspace, CI-runner, managed-container, and timestamp fields,
plus an optional error. Invalid or unknown structure is rejected unchanged
before recovery runs. `restartCiRunners` alone records runner restart intent.
The host migration accepts only the exact historical schema 1 shape. A
malformed or extra-key record, conflicting or unsafe backup, symlink, or
non-regular canonical, backup, or recognized temporary artifact stops
controller startup without mutation. Interrupted migration is safe to retry;
an absent canonical record is recovered from a valid permanent backup.

If `dim host start` enters from `ready`, it dispatches no recovery. From
`stopped`, `starting`, or `error`, listed ready runners are left alone, stopped
runners start, and creating or errored runners are ownership-safely stopped
before start. Entry from `stopping` uses the same matrix but also stops and
starts listed ready runners because shutdown may have been interrupted.
