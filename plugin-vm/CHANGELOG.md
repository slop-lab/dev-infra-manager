# Changelog

## Unreleased

- Add optional persistent Incus VM workspaces and auxiliary VMs with separate
  host resource ceilings and workspace-scoped browser console access. Reviewed
  image imports share a checksum-verified, resumable host cache, with an explicit
  NAS cache directory option independent of workspace lifetime.
