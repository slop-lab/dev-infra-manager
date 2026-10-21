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

The host holding the Project registration and private connection creates the
workspace. With SSH, select that host with `--host`; client-side paths and
credentials are not implicitly transferred.

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
