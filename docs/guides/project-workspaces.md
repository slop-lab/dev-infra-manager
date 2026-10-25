# Managed Projects and workspaces

Managed Git is optional. Ordinary development needs only a Git URL or a path
on the selected host; see [usage](usage.md).

The [public/private example](../../examples/projects/native-multiple-repositories/README.md)
provides two independent runnable repository templates, reviewed import policies,
and linked Git/CI and workspace runtime verification for this layout.

The optional `dim installer install core --with-managed` profile installs the
native-Git host plugin, execution worker plugin and control-plane administration tools.
Control-plane service plugins are installed and selected separately. Use `dim control-plane prepare` and `connect` to configure services and
host connections. A Project groups independent repositories. Import each with
its own trusted repository policy, then select the configuration and default working
repositories:

```bash
dim project create codyssey --project-id codyssey
# Policy files name repositoryId and feature-owned extensions; omitting --policy uses repository-only policy.
dim project repository import codyssey public \
  --source /absolute/reviewed/codyssey-public --ref refs/heads/main \
  --policy /absolute/operator/public-policy.json
dim project repository import codyssey private \
  --source /absolute/reviewed/codyssey-private --ref refs/heads/main \
  --policy /absolute/operator/private-policy.json
dim project configure codyssey \
  --configuration-repository private --default-repository public
dim project repository list codyssey --json
dim create dim://codyssey dev --repository public --repository private --workdir public
dim exec dev -- git status
```

Source paths and branch names in this example must identify your reviewed local
clones. Import never publishes code to an upstream Git host. Saved control-plane
connections provide registrar/importer roles; explicit connection options can
select other private connection files.

The selected host holds its own Project selection and private connection. With
SSH, select that host with `--host`; client-side paths and credentials are not
implicitly transferred.

## Use an existing Project on another host

Connecting a new host to an existing control plane does not select Projects or
copy another host's defaults. After the host has been connected, discover the
repositories its existing authority can access, then explicitly attach one:

```bash
dim --host remote-sub-1 project discover --json
dim --host remote-sub-1 project discover codyssey --json
dim --host remote-sub-1 project attach codyssey \
  --configuration-repository private --default-repository public
dim --host remote-sub-1 create dim://codyssey dev
```

The selected Git service must provide the discovery endpoints. A successful host
connection check alone does not establish this capability or validate the
protected-source reader used by discovery; `project discover` performs that live
authenticated check. An unavailable or stale service fails explicitly rather
than falling back to imported state files.

Both repository selections are required. `--name LOCAL_NAME` chooses another
host-local Project name; use that name in `dim://LOCAL_NAME`. Configuration and
default working repositories can differ and do not change any other host's
choices. Later explicit `project configure LOCAL_NAME` changes only these local
defaults, not existing workspace checkouts.

In Web **Git review**, select the new host's controller, discover available
Projects, inspect its repositories, choose both defaults and explicitly attach.
The attached Project becomes available in the ordinary Project selector and can
open a managed workspace creation draft. Attachment itself creates no workspace.
Web attachment requires the `operator` role and a controller connection; a direct
reviewer-service connection cannot configure a workspace host.

Discovery uses the Git service's authenticated catalog, not local JSON files or
an upstream Git URL. Attachment rechecks live repository readiness and writes
one host-local selection atomically. It does not register or reimport source,
update policy, move protected refs, grant access, or copy workspace credentials.
Registrar/importer roles are unnecessary for discovery and attachment. Existing
workspace data and local choices remain intact. Repeating the same attachment
is safe; a conflicting name, alias, repository set or defaults fails instead of
overwriting local choices. If the authority's effective policy changed, an
explicit repeat attachment refreshes only that policy metadata, preserving the
original receipts, snapshots and local defaults. An unchanged retry preserves
the record bytes. Use explicit configuration to change defaults rather than
repeating attachment with different selections.

The connection's `hostId` identifies a **host authority**, not necessarily one
physical machine. Hosts connected with the same exported role bundle share its
existing Project scope and credentials. A separately credentialed authority sees
only its own Projects; connecting to the same service does not grant another
authority's Projects. Per-machine delegation and cross-authority Project grants
are not provided by this flow. Discovery and attachment require the selected
active service generation; reconnect explicitly after a generation change.

## Workspace repository selection

Each selected repository lives at `/workspace/<repositoryId>` with its own Git
origin and proposal grant. Without `--repository`, only the default working
repository is selected. `--workdir` names a selected repository. The configuration
repository is independently attested and checked for required plugins. If it is
not selected, it stays in temporary host staging and is never seeded or granted
to the guest. For example, `dim create dim://codyssey public-dev` selects only
`public` even though the configuration comes from `private`.

Repository readiness proves registered ownership and protected-source access.
It requires neither CI capacity nor a proposal approval. Acquisition seeds each
selected protected commit once. Workspaces receive scoped grants, never the
host's importer, reviewer or promoter credentials.

Core owns the same workspace lifecycle and persistent volumes used by ordinary
Git workspaces. `dim stop`, `start`, `restart`, `recreate`, `resources` and
`discard` apply to both. Protected-ref promotion does not reset existing
checkouts; developers fetch and reconcile their own local changes.

Reviews and promotion always select one repository. Imported policy explicitly
allows CI input repository IDs; jobs request a subset and default to their own
repository. Review and execution evidence binds exact commit/tree tuples.
Changing an input head makes the old review stale; explicitly resolving the
proposal captures a new review requiring fresh approval. Promotion changes one
protected ref with compare-and-swap. There is no cross-repository atomic update.

Managed Project registration and Git review are separate from disposable
workspace runtime identity. Old internal storage formats are not adopted or
migrated; preserve user data before replacing an incompatible installation.
