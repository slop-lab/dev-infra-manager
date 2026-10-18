# Managed Projects and workspaces

Managed Git is optional. Ordinary development needs only a Git URL or a path
on the selected host; see [usage](usage.md).

Install the optional integration with `dim installer install core --with-managed`.
Use `dim managed control-plane prepare` and `connect` to configure services and
host connections. Bootstrap a reviewed repository with the generated registrar
and importer roles, then create its Project:

```bash
dim managed project bootstrap-native-root PROJECT \
  --project-id PROJECT_ID \
  --source-repository /absolute/reviewed/root \
  --source-ref refs/heads/main \
  --registrar-connection /absolute/operator/registrar.json \
  --importer-connection /absolute/operator/importer.json --json
dim managed project create PROJECT --json
dim managed project list --json
dim create dim://PROJECT dev
dim exec dev -- git status
```

The host holding the Project registration and private connection creates the
workspace. With SSH, select that host with `--host`; client-side paths and
credentials are not implicitly transferred.

Project readiness proves registered repository ownership and protected-source
access. It requires neither CI capacity nor a proposal approval. Managed source
acquisition seeds the selected protected commit once, then configures a scoped
Git broker for reads and workspace proposal pushes. The workspace receives a
scoped grant, never the host's importer, reviewer or promoter credentials.

Core owns the same single Sysbox container and persistent volumes used by
ordinary Git workspaces. `dim stop`, `start`, `restart`, `recreate`, `resources`
and `discard` apply to both. Protected-ref promotion does not reset an existing
checkout; developers fetch and reconcile their own local changes.

Managed Project registration and Git review are separate from disposable
workspace runtime identity. Old internal storage formats are not adopted or
migrated; preserve user data before replacing an incompatible installation.
