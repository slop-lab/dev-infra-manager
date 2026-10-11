# DIM Development Repository

DIM has one canonical root repository. Its commit and tree identify the complete
source candidate, including production packages, plugins, centralized tests,
verification, examples, specifications, workflows, and the reviewed `.dim`
self-Project contract. Current development does not assemble sibling
repositories or publish component heads independently.

## Hosting Roles

The same root repository has two distinct hosting roles:

- DIM-managed Gitea is the internal proposal, review, and automatic-CI host.
- GitHub is the canonical public source and the authority for public tags,
  releases, and downstream source links.

Workspaces push proposals to internal Gitea. Review and CI there can approve an
exact candidate for promotion within the self-Project, but neither grants
GitHub credentials nor publishes public history. A trusted maintainer separately
publishes the approved commit to GitHub and verifies that its commit and tree are
the reviewed candidate. No workflow may infer publication authority from a green
internal result.

The current built-in review host and coordinator are Gitea and Gitea Actions.
They remain implementation backends rather than permanent contributor or
Project contracts. Tooling must inspect the active remote and resolve the forge
before using provider-specific commands. It must not assume that `origin` is
GitHub or expose Gitea administration to an agent workspace.

## Root Project Contract

The root `.dim` directory is the self-Project lifecycle contract. It defines the
reviewed environment, tasks, and constrained capabilities for this monorepo.
There is no repository catalog of component upstreams and no sibling checkout
materialization step. One workspace checkout presents the complete tree.

Issue tracking for a DIM-managed Project remains rooted in that Project's root
repository. Pull requests for this monorepo also belong to the root repository.
Managed-host issue numbers should appear in public history only when the public
context remains meaningful; descriptive commit subjects and pull-request titles
must stand on their own.

## Evidence And Publication

Every candidate, review, CI result, promotion, and release record names the full
root commit and tree. A branch name, provider run ID, package version, or partial
directory digest cannot replace that identity. Checks that read candidate-owned
workflow or test definitions remain candidate-controlled evidence even when
they execute in a separate bounded runner.

Internal and public evidence stay separate:

- Gitea records proposal review and internal automatic CI for the exact root
  commit and tree.
- GitHub records the separately published canonical commit, public CI, signed
  tag, and release.
- Publication requires equality with the reviewed root commit and tree. It is
  not an assembly of independent component SHAs.

See [Releasing](releasing.md) for the exact release checks and retained Sysbox
and QEMU gates.
