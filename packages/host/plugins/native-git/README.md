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

The plugin exclusively owns `.dim/repos.yml` interpretation. Explicit
`project repository import --repository-policy` and the reviewed-manifest bootstrap
API read the selected commit's policy blob; ordinary workspace creation does not
discover the file. CLI import can instead use operator `--policy` input; the two
options are mutually exclusive. See
[repository configuration](../../../../docs/guides/repository-configuration.md#native-git-repository-policy-reposyml)
for the format and activation rules. Repository connections and multi-repository
imports are explicit commands, separate from this policy file.

The optional control-plane `git-sync` plugin owns external fetching, merge
proposals and publication. This host plugin supplies the operator CLI:

```bash
dim project repository fetch PROJECT REPOSITORY --connection /absolute/connection.json
dim project repository sync PROJECT REPOSITORY --connection /absolute/connection.json
dim project repository publish PROJECT REPOSITORY --connection /absolute/connection.json
```

The selected repository's reviewed upstream and publish mapping determine the
remote. `sync` creates a proposal for the normal review/promotion path; `publish`
pushes the authoritative protected commit without force. Remote credentials
remain private to the control plane. New workspaces with `git-sync` policy also
fetch read-only `upstream/...` tracking refs from their scoped `origin`, allowing
ordinary `git fetch origin` and `git merge upstream/development` before submitting
a proposal. See [Git synchronization](../../../../docs/guides/git-sync.md).

Repository read and proposal-write grants remain private to the host. Workspace
checkouts receive narrow local broker access. Review, registrar, importer and
promoter credentials are never mounted into workspaces. Workspace identity checks
fence name reuse and discard. Optional Project metadata is supplied to generic
host controllers through an injected resolver, rather than a host-core dependency
on Native Git.

## Controller console operations

`dim project console describe --json` discovers the selected control-plane generation, reviewer identity, local project catalog and available review/sync operations. Only repositories with ready import receipts for that generation are advertised. The host uses private `reviewer.json`, optional `promoter.json` and optional `git-sync.json` beside the selected host connection; each role must match its selected endpoint and generation, with host-bound roles also matching the selected host identity. No operator credentials or connection paths are returned.

Clients pin the discovery result: subsequent discovery may pass `--expected-generation HASH`, and every `dim project console invoke OPERATION --expected-generation HASH --input JSON --json` must pass it. A changed selection fails before role attestation or mutation and requires reconnecting explicitly. Every invocation reloads the local project catalog and validates the requested project and repository; adding an imported repository needs no Web configuration. The shared `@slop-lab/dim-native-git-client` owns HTTP/evidence decoding and operation semantics; this plugin owns controller selection and namespace scope.
