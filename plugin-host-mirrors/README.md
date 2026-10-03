# `@slop-lab/dim-plugin-host-mirrors`

This host-installed DIM plugin owns the exact Docker Hub pull-through cache and
APT cache images used by DIM workspaces and managed CI. The selected images are
immutable digest references in reviewed plugin source. Projects and workspaces
cannot select, replace, or disable them.

Install this plugin at the same exact version as DIM:

```bash
npx '@slop-lab/dim-installer@0.9.0' installer install plugin \
  '@slop-lab/dim-plugin-host-mirrors@0.9.0'
```

Restart the managed controller after changing the enabled plugin set. Workspace
creation and managed mirror reconciliation fail closed when no provider is
enabled, when multiple providers register, or when a provider uses a mutable
image reference. The plugin starts Docker-managed cache containers only; it
does not install APT or other packages into the host operating system.
