# Native Git host integration

This host plugin owns Native Project registration and repository bootstrap,
private host connections, scoped workspace proposal brokers, and `dim://Project`
source acquisition. The host core owns workspace lifecycle and storage; the
control-plane Native Git plugin owns repository authority, review and promotion.

Install the package through the host plugin installer. `dim project` manages
Projects and their independently imported repositories. Host composition loads
`./host` only for Native Project workspaces. Ordinary local and remote Git
workspaces do not require this integration.

Repository read and proposal-write grants remain private to the host. Workspace
checkouts receive narrow local broker access. Review, registrar, importer and
promoter credentials are never mounted into workspaces. Workspace identity checks
fence name reuse and discard. Optional Project metadata is supplied to generic
host controllers through an injected resolver, rather than a host-core dependency
on Native Git.
