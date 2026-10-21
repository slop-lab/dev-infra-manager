# Native Git host integration

This host plugin owns Native Project registration and repository bootstrap,
private host connections, scoped workspace proposal brokers, and `dim://Project`
source acquisition. The host core owns workspace lifecycle and storage; the
control-plane repository, code-review and merge-policy plugins own their
respective service capabilities.

Install the package through the host plugin installer. `dim project` manages
Projects and their independently imported repositories. Its `hostPlugin.source`
capability owns the `dim` URL scheme and lazily loads acquisition/broker code.
Only the enabled host-plugin manifest authorizes source acquisition, recovery
and optional Project metadata; package presence alone does not activate them.
Ordinary local and remote Git workspaces do not require this integration.

The plugin exclusively owns `.dim/repos.yml` interpretation. Its explicit
reviewed-manifest bootstrap API reads the selected commit's policy blob;
ordinary workspace creation and `project repository import` do not discover
the file. CLI import uses explicit operator `--policy` input. See
[repository configuration](../../../../docs/guides/repository-configuration.md#native-git-bootstrap-policy-reposyml)
for the format and activation rules. Repository connections and multi-repository
imports are explicit commands, separate from this policy file.

Repository read and proposal-write grants remain private to the host. Workspace
checkouts receive narrow local broker access. Review, registrar, importer and
promoter credentials are never mounted into workspaces. Workspace identity checks
fence name reuse and discard. Optional Project metadata is supplied to generic
host controllers through an injected resolver, rather than a host-core dependency
on Native Git.
