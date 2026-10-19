# Repository sources

An ordinary workspace starts from one Git URL or a repository path on the
selected host:

```bash
dim create /srv/repositories/app dev --ref main
dim --host devbox create https://example.com/team/app.git dev
```

DIM acquires committed source into private staging, resolves the selected
commit, and seeds a private checkout once. Dirty and untracked source files are
not copied. Acquisition does not mutate the original checkout or share its Git
object storage. A portable remote is retained; host-only paths and operator
credential material are not installed in the agent.

Later lifecycle operations preserve the working checkout. Fetching another
revision, installing tools or cloning more repositories is an ordinary explicit
operation inside the workspace. DIM does not need repository catalogs or
provider-specific CRUD to support this flow.

An optional managed Project uses an approved native root and proposal-scoped
Git transport. Its [lifecycle guide](project-workspaces.md) describes that
additional authority. It does not restrict ordinary source workspaces.
