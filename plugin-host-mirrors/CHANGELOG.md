# Host mirrors development changelog

## Unreleased

- Let a reviewed, host-installed plugin select the exact digest-pinned Docker
  registry and APT cache images for DIM-managed workspaces and CI. Projects and
  workspaces cannot choose host packages. The host refuses missing or conflicting
  providers, validates cache ownership before adoption or replacement, and
  rejects persisted workspaces that cannot reach the selected mirror network.
  Real nested APT routing still requires verification on a host with delegated
  container cgroups before the mirror outcome can be considered complete.
